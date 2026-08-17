import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { globalSearch } from '@/modules/search'
import { availableDimensions, customerValue, demographics } from '@/modules/demographics'
import { createCustomField } from '@/modules/custom-fields'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { grantsFor } from '@/auth/permissions'
import type { RequestContext } from '@/server/context'
import { createOpsFixture, type OpsFixture } from './helpers/operations'
import { FULL_ACCESS } from '@/billing/access'

const ctxFor = (f: OpsFixture, role: 'owner' | 'readonly' | 'sales'): RequestContext => ({
  userId: f.actor.userId!,
  organizationId: f.orgId,
  membershipId: 'test',
  role,
  permissions: grantsFor(role),
  requestId: null,
  ip: null,
  userAgent: null,
  // These fixtures build a context by hand rather than through resolveContext.
  // A licensed, in-date tenant is the right default: nothing here is testing
  // billing, and an unlicensed default would make every unrelated write fail.
  licence: FULL_ACCESS,
})

describe('global search', () => {
  let f: OpsFixture

  beforeAll(async () => {
    f = await createOpsFixture()
    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Consulting', unitPriceMinor: 1000_00 }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))
  })

  afterAll(async () => {
    await f.t.close()
  })

  it('finds records across modules', async () => {
    const result = await f.tx((tx) => globalSearch(tx, ctxFor(f, 'owner'), 'vogel'))
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.some((h) => h.module === 'customers')).toBe(true)
    expect(result.hits.some((h) => h.module === 'invoices')).toBe(true)
  })

  it('finds a product by SKU', async () => {
    const result = await f.tx((tx) => globalSearch(tx, ctxFor(f, 'owner'), 'WIDGET-01'))
    const hit = result.hits.find((h) => h.module === 'products')
    expect(hit?.reference).toBe('WIDGET-01')
  })

  it('ranks an exact reference match first', async () => {
    const result = await f.tx((tx) => globalSearch(tx, ctxFor(f, 'owner'), 'INV-00001'))
    expect(result.hits[0]!.reference).toBe('INV-00001')
  })

  it('RESPECTS permissions — a read-only sales user sees no invoices', async () => {
    // A search box returning a record the user cannot open is a disclosure:
    // the title and amount alone leak what was meant to be hidden.
    const owner = await f.tx((tx) => globalSearch(tx, ctxFor(f, 'owner'), 'vogel'))
    expect(owner.hits.some((h) => h.module === 'invoices')).toBe(true)

    const sales = ctxFor(f, 'sales')
    expect(sales.permissions.has('invoice.read')).toBe(true)

    // Strip the permission and the source must vanish entirely.
    const restricted: RequestContext = {
      ...sales,
      permissions: new Set([...sales.permissions].filter((p) => p !== 'invoice.read')),
    }
    const result = await f.tx((tx) => globalSearch(tx, restricted, 'vogel'))
    expect(result.hits.some((h) => h.module === 'invoices')).toBe(false)
    expect(result.hits.some((h) => h.module === 'customers')).toBe(true)
  })

  it('ignores a query that is too short to be useful', async () => {
    const result = await f.tx((tx) => globalSearch(tx, ctxFor(f, 'owner'), 'a'))
    expect(result.hits).toEqual([])
  })

  it('treats wildcards as literal text', async () => {
    // '%' must not become a match-everything pattern.
    const result = await f.tx((tx) => globalSearch(tx, ctxFor(f, 'owner'), '%%'))
    expect(result.hits).toEqual([])
  })

  it('counts hits per module', async () => {
    const result = await f.tx((tx) => globalSearch(tx, ctxFor(f, 'owner'), 'vogel'))
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0)
    expect(total).toBe(result.hits.length)
  })
})

describe('demographics', () => {
  let f: OpsFixture
  const RANGE = { from: '2026-01-01', to: '2026-12-31' }

  beforeAll(async () => {
    f = await createOpsFixture()

    // Two customers in different countries with different revenue.
    await f.t.sudo(`
      update business_partners set is_customer = true, country_code = 'DE'
       where organization_id = '${f.orgId}' and name = 'Brauhaus Vogel GmbH';
      update business_partners set is_customer = true, country_code = 'NL'
       where organization_id = '${f.orgId}' and name = 'Steinmetz Metallwerke';
    `)

    const supplierAsCustomer = await f.tx(async (tx) => {
      const res = await tx.execute(
        sql`select id from business_partners where organization_id = ${f.orgId}
              and name = 'Steinmetz Metallwerke'`,
      )
      return (res as unknown as { rows: { id: string }[] }).rows[0]!.id
    })

    for (const [partner, amount] of [
      [f.customerId, 10_000_00],
      [f.customerId, 5_000_00],
      [supplierAsCustomer, 2_000_00],
    ] as const) {
      const inv = await f.tx((tx) =>
        createInvoice(tx, f.actor, {
          direction: 'ar',
          businessPartnerId: partner,
          issueDate: '2026-02-15',
          lines: [{ description: 'Goods', unitPriceMinor: amount }],
        }),
      )
      await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))
    }
  })

  afterAll(async () => {
    await f.t.close()
  })

  it('segments revenue by country', async () => {
    const result = await f.tx((tx) =>
      demographics(tx, f.orgId, { dimensionKey: 'country', ...RANGE }),
    )
    const de = result.segments.find((s) => s.segment === 'DE')!
    const nl = result.segments.find((s) => s.segment === 'NL')!

    expect(de.revenueMinor).toBe(1_500_000) // 15,000.00
    expect(nl.revenueMinor).toBe(200_000)
    expect(de.customerCount).toBe(1)
    expect(result.totals.revenueMinor).toBe(1_700_000)
  })

  it('computes lifetime value and average per customer', async () => {
    const result = await f.tx((tx) =>
      demographics(tx, f.orgId, { dimensionKey: 'country', ...RANGE }),
    )
    const de = result.segments.find((s) => s.segment === 'DE')!
    expect(de.lifetimeValueMinor).toBe(1_500_000)
    expect(de.averageValueMinor).toBe(1_500_000)
  })

  it('lifetime value is NOT bounded by the reporting range', async () => {
    // Lifetime value that resets each January is not lifetime value.
    const narrow = await f.tx((tx) =>
      demographics(tx, f.orgId, {
        dimensionKey: 'country',
        from: '2026-06-01',
        to: '2026-06-30',
      }),
    )
    const de = narrow.segments.find((s) => s.segment === 'DE')!
    expect(de.revenueMinor).toBe(0) // nothing invoiced in June
    expect(de.lifetimeValueMinor).toBe(1_500_000) // but the history stands
  })

  it('exposes tag categories as dimensions without a schema change', async () => {
    await f.tx(async (tx) => {
      await tx.execute(sql`
        insert into tags (id, organization_id, name, category)
        values (gen_random_uuid(), ${f.orgId}, 'Manufacturing', 'industry')
      `)
      const tagId = (
        (await tx.execute(
          sql`select id from tags where organization_id = ${f.orgId} and name = 'Manufacturing'`,
        )) as unknown as { rows: { id: string }[] }
      ).rows[0]!.id
      await tx.execute(sql`
        insert into taggings (organization_id, tag_id, entity_type, entity_id)
        values (${f.orgId}, ${tagId}, 'business_partner', ${f.customerId})
      `)
    })

    const dims = await f.tx((tx) => availableDimensions(tx, f.orgId))
    expect(dims.some((d) => d.key === 'tag:industry')).toBe(true)

    const result = await f.tx((tx) =>
      demographics(tx, f.orgId, { dimensionKey: 'tag:industry', ...RANGE }),
    )
    const manufacturing = result.segments.find((s) => s.segment === 'Manufacturing')!
    expect(manufacturing.revenueMinor).toBe(1_500_000)
    // Everything untagged still lands somewhere, so the totals reconcile.
    expect(result.segments.some((s) => s.segment === 'Unclassified')).toBe(true)
    expect(result.totals.revenueMinor).toBe(1_700_000)
  })

  it('exposes a tenant custom field as a dimension', async () => {
    await f.tx((tx) =>
      createCustomField(tx, f.actor, {
        entityType: 'business_partner',
        key: 'company_size',
        label: 'Company size',
        fieldType: 'select',
        options: ['SME', 'Enterprise'],
      }),
    )
    await f.t.sudo(`
      update business_partners
         set custom_fields = '{"company_size":"Enterprise"}'::jsonb
       where organization_id = '${f.orgId}' and name = 'Brauhaus Vogel GmbH'
    `)

    const dims = await f.tx((tx) => availableDimensions(tx, f.orgId))
    expect(dims.some((d) => d.key === 'custom:company_size')).toBe(true)

    const result = await f.tx((tx) =>
      demographics(tx, f.orgId, { dimensionKey: 'custom:company_size', ...RANGE }),
    )
    expect(result.segments.find((s) => s.segment === 'Enterprise')!.revenueMinor).toBe(1_500_000)
  })

  it('falls back to the first dimension for an unknown key', async () => {
    const result = await f.tx((tx) =>
      demographics(tx, f.orgId, { dimensionKey: 'nonsense', ...RANGE }),
    )
    expect(result.dimensionKey).toBe('country')
  })

  it('flags at-risk customers by recency, without pretending to predict churn', async () => {
    const rows = await f.tx((tx) => customerValue(tx, f.orgId, { asOf: '2026-12-31' }))
    const vogel = rows.find((r) => r.name === 'Brauhaus Vogel GmbH')!
    expect(vogel.lifetimeValueMinor).toBe(1_500_000)
    expect(vogel.invoiceCount).toBe(2)
    // Last invoiced 2026-02-15; by year end that is well over 180 days.
    expect(vogel.atRisk).toBe(true)

    const early = await f.tx((tx) => customerValue(tx, f.orgId, { asOf: '2026-03-01' }))
    expect(early.find((r) => r.name === 'Brauhaus Vogel GmbH')!.atRisk).toBe(false)
  })
})
