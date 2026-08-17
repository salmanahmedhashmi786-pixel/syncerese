import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  createCustomField,
  createSavedView,
  deleteSavedView,
  listSavedViews,
  validateCustomFields,
} from '@/modules/custom-fields'
import { compileFilter, evaluateConditions, parseFilter } from '@/modules/filters'
import { listModule } from '@/modules/queries'
import { createOpsFixture, type OpsFixture } from './helpers/operations'

describe('custom fields', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  it('defines a field and validates values against it', async () => {
    await f.tx((tx) =>
      createCustomField(tx, f.actor, {
        entityType: 'business_partner',
        key: 'industry',
        label: 'Industry',
        fieldType: 'select',
        options: ['Manufacturing', 'Logistics', 'Retail'],
      }),
    )

    const ok = await f.tx((tx) =>
      validateCustomFields(tx, f.orgId, 'business_partner', { industry: 'Logistics' }),
    )
    expect(ok).toEqual({ industry: 'Logistics' })

    await expect(
      f.tx((tx) =>
        validateCustomFields(tx, f.orgId, 'business_partner', { industry: 'Farming' }),
      ),
    ).rejects.toThrow(/must be one of/)
  })

  it('REJECTS an unknown key rather than storing it', async () => {
    // A typo'd key would otherwise write a value no form shows and no filter
    // finds — data that exists but is invisible.
    await expect(
      f.tx((tx) =>
        validateCustomFields(tx, f.orgId, 'business_partner', { industrie: 'Logistics' }),
      ),
    ).rejects.toThrow(/Unknown field/)
  })

  it('coerces by type and rejects malformed values', async () => {
    await f.tx(async (tx) => {
      await createCustomField(tx, f.actor, {
        entityType: 'business_partner',
        key: 'headcount',
        label: 'Headcount',
        fieldType: 'number',
      })
      await createCustomField(tx, f.actor, {
        entityType: 'business_partner',
        key: 'renewal',
        label: 'Renewal date',
        fieldType: 'date',
      })
      await createCustomField(tx, f.actor, {
        entityType: 'business_partner',
        key: 'portal',
        label: 'Portal',
        fieldType: 'url',
      })
    })

    const ok = await f.tx((tx) =>
      validateCustomFields(tx, f.orgId, 'business_partner', {
        headcount: '250',
        renewal: '2027-01-01',
        portal: 'https://example.test',
      }),
    )
    expect(ok).toEqual({
      headcount: 250,
      renewal: '2027-01-01',
      portal: 'https://example.test',
    })

    await expect(
      f.tx((tx) => validateCustomFields(tx, f.orgId, 'business_partner', { headcount: 'lots' })),
    ).rejects.toThrow(/must be a number/)
    await expect(
      f.tx((tx) => validateCustomFields(tx, f.orgId, 'business_partner', { renewal: 'soon' })),
    ).rejects.toThrow(/must be a date/)
    await expect(
      f.tx((tx) => validateCustomFields(tx, f.orgId, 'business_partner', { portal: 'example' })),
    ).rejects.toThrow(/must be a URL/)
  })

  it('enforces required fields', async () => {
    await f.tx((tx) =>
      createCustomField(tx, f.actor, {
        entityType: 'deal',
        key: 'approval_ref',
        label: 'Approval reference',
        fieldType: 'text',
        isRequired: true,
      }),
    )
    await expect(
      f.tx((tx) => validateCustomFields(tx, f.orgId, 'deal', {})),
    ).rejects.toThrow(/is required/)
  })

  it('rejects a key that is not a safe slug', async () => {
    // The key becomes a jsonb path in generated SQL, so it must be slug-safe.
    // The user-facing message stays generic; the specific reason is in details,
    // which is what a form binds to per-field errors.
    let caught: unknown
    try {
      await f.tx((tx) =>
        createCustomField(tx, f.actor, {
          entityType: 'deal',
          key: "x'; drop table deals; --",
          label: 'Nasty',
        }),
      )
    } catch (err) {
      caught = err
    }

    expect(caught).toBeDefined()
    const details = JSON.stringify((caught as { details?: unknown }).details ?? '')
    expect(details).toMatch(/lowercase letters, digits and underscores/)

    // And nothing was written.
    const rows = await f.tx(async (tx) => {
      const res = await tx.execute(
        sql`select count(*)::int as n from custom_field_defs where organization_id = ${f.orgId}`,
      )
      return (res as unknown as { rows: { n: number }[] }).rows[0]!.n
    })
    expect(Number(rows)).toBe(0)
  })

  it('will not let a key be renamed once values exist under it', async () => {
    const field = await f.tx((tx) =>
      createCustomField(tx, f.actor, {
        entityType: 'business_partner',
        key: 'industry',
        label: 'Industry',
        fieldType: 'text',
      }),
    )
    await expect(
      f.t.sudo(`update custom_field_defs set key = 'sector' where id = '${field.id}'`),
    ).rejects.toThrow(/SYNC_FIELD_KEY_IMMUTABLE/)

    // Relabelling is fine — only the storage key is frozen.
    await expect(
      f.t.sudo(`update custom_field_defs set label = 'Sector' where id = '${field.id}'`),
    ).resolves.not.toThrow()
  })

  it('filters a list by a custom field value', async () => {
    await f.tx((tx) =>
      createCustomField(tx, f.actor, {
        entityType: 'business_partner',
        key: 'industry',
        label: 'Industry',
        fieldType: 'text',
      }),
    )
    await f.t.sudo(`
      update business_partners
         set custom_fields = '{"industry":"Logistics"}'::jsonb
       where organization_id = '${f.orgId}' and name = 'Brauhaus Vogel GmbH'
    `)

    const hit = await f.tx((tx) =>
      listModule(
        tx,
        f.orgId,
        'customers',
        { filter: { conditions: [{ field: 'custom.industry', op: 'eq', value: 'Logistics' }] } },
        '2026-03-20',
      ),
    )
    expect(hit.rows).toHaveLength(1)
    expect(hit.rows[0]!.name).toBe('Brauhaus Vogel GmbH')

    const miss = await f.tx((tx) =>
      listModule(
        tx,
        f.orgId,
        'customers',
        { filter: { conditions: [{ field: 'custom.industry', op: 'eq', value: 'Retail' }] } },
        '2026-03-20',
      ),
    )
    expect(miss.rows).toHaveLength(0)
  })
})

describe('structured filters', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  it('rejects a field that is not on the allowlist', () => {
    // Field names reach SQL as identifiers and can never be bind parameters,
    // so an unknown field must be refused rather than interpolated.
    expect(() =>
      compileFilter('invoices', {
        conditions: [{ field: 'i.total_minor); drop table invoices; --', op: 'eq', value: 1 }],
      }),
    ).toThrow(/Cannot filter/)
  })

  it('rejects a malformed custom field key', () => {
    expect(() =>
      compileFilter(
        'customers',
        { conditions: [{ field: "custom.x'; drop table x; --", op: 'eq', value: 1 }] },
        { customFieldsColumn: 'bp.custom_fields' },
      ),
    ).toThrow(/Invalid custom field key/)
  })

  it('validates value types before they reach SQL', () => {
    expect(() =>
      compileFilter('invoices', {
        conditions: [{ field: 'totalMinor', op: 'gt', value: 'not-a-number' }],
      }),
    ).toThrow(/is not a number/)
    expect(() =>
      compileFilter('invoices', {
        conditions: [{ field: 'issueDate', op: 'gte', value: '01/02/2026' }],
      }),
    ).toThrow(/is not a date/)
  })

  it('an empty "in" matches nothing, not everything', async () => {
    const result = await f.tx((tx) =>
      listModule(
        tx,
        f.orgId,
        'customers',
        { filter: { conditions: [{ field: 'countryCode', op: 'in', value: [] }] } },
        '2026-03-20',
      ),
    )
    expect(result.rows).toHaveLength(0)
  })

  it('"neq" still returns rows whose value is null', async () => {
    // NULL <> x is NULL, which a naive implementation silently drops.
    await f.t.sudo(`
      update business_partners set country_code = null
       where organization_id = '${f.orgId}' and name = 'Brauhaus Vogel GmbH'
    `)
    const result = await f.tx((tx) =>
      listModule(
        tx,
        f.orgId,
        'customers',
        { filter: { conditions: [{ field: 'countryCode', op: 'neq', value: 'FR' }] } },
        '2026-03-20',
      ),
    )
    expect(result.rows.some((r) => r.name === 'Brauhaus Vogel GmbH')).toBe(true)
  })

  it('treats LIKE wildcards in a filter value as literal text', async () => {
    // "%" as a filter value must match nothing, not everything. Unescaped, it
    // turns any contains-filter into a full table read.
    const all = await f.tx((tx) => listModule(tx, f.orgId, 'customers', {}, '2026-03-20'))
    expect(all.rows.length).toBeGreaterThan(0)

    const wildcard = await f.tx((tx) =>
      listModule(
        tx,
        f.orgId,
        'customers',
        { filter: { conditions: [{ field: 'name', op: 'contains', value: '%' }] } },
        '2026-03-20',
      ),
    )
    expect(wildcard.rows).toHaveLength(0)

    const underscore = await f.tx((tx) =>
      listModule(
        tx,
        f.orgId,
        'customers',
        { filter: { conditions: [{ field: 'name', op: 'contains', value: '_' }] } },
        '2026-03-20',
      ),
    )
    expect(underscore.rows).toHaveLength(0)
  })

  it('treats LIKE wildcards in the module search box as literal text', async () => {
    const wildcard = await f.tx((tx) =>
      listModule(tx, f.orgId, 'customers', { q: '%' }, '2026-03-20'),
    )
    expect(wildcard.rows).toHaveLength(0)
  })

  it('compiles every operator without error', async () => {
    const cases: { field: string; op: string; value?: unknown }[] = [
      { field: 'totalMinor', op: 'eq', value: 100 },
      { field: 'totalMinor', op: 'neq', value: 100 },
      { field: 'totalMinor', op: 'gt', value: 1 },
      { field: 'totalMinor', op: 'gte', value: 1 },
      { field: 'totalMinor', op: 'lt', value: 9_999_999 },
      { field: 'totalMinor', op: 'lte', value: 9_999_999 },
      { field: 'partnerName', op: 'contains', value: 'vogel' },
      { field: 'invoiceNo', op: 'starts_with', value: 'INV' },
      { field: 'status', op: 'in', value: ['issued', 'paid'] },
      { field: 'issueDate', op: 'between', value: ['2026-01-01', '2026-12-31'] },
      { field: 'currencyCode', op: 'is_empty' },
      { field: 'currencyCode', op: 'is_not_empty' },
    ]
    for (const c of cases) {
      const result = await f.tx((tx) =>
        listModule(
          tx,
          f.orgId,
          'invoices',
          { filter: { conditions: [c as never] } },
          '2026-03-20',
        ),
      )
      expect(result.rows).toBeInstanceOf(Array)
    }
  })

  it('evaluates the same shape in memory for the workflow engine', () => {
    const record = { totalMinor: 5000, status: 'issued', partnerName: 'Vogel GmbH' }
    expect(
      evaluateConditions([{ field: 'totalMinor', op: 'gt', value: 1000 }], record),
    ).toBe(true)
    expect(
      evaluateConditions([{ field: 'totalMinor', op: 'gt', value: 9000 }], record),
    ).toBe(false)
    expect(
      evaluateConditions([{ field: 'partnerName', op: 'contains', value: 'vogel' }], record),
    ).toBe(true)
    // Conditions are ANDed.
    expect(
      evaluateConditions(
        [
          { field: 'status', op: 'eq', value: 'issued' },
          { field: 'totalMinor', op: 'gte', value: 9000 },
        ],
        record,
      ),
    ).toBe(false)
  })

  it('parses and rejects untrusted filter payloads', () => {
    expect(parseFilter({ conditions: [{ field: 'status', op: 'eq', value: 'paid' }] })).toEqual({
      conditions: [{ field: 'status', op: 'eq', value: 'paid' }],
    })
    expect(() => parseFilter({ conditions: [{ field: 'status', op: 'sql_injection' }] })).toThrow(
      /Invalid filter/,
    )
  })
})

describe('saved views', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  it('saves a filter and reads it back', async () => {
    await f.tx((tx) =>
      createSavedView(tx, f.actor, {
        module: 'invoices',
        name: 'Overdue over €5k',
        filters: {
          conditions: [
            { field: 'status', op: 'in', value: ['issued', 'partially_paid'] },
            { field: 'outstandingMinor', op: 'gt', value: 500000 },
          ],
        },
        sort: { key: 'dueDate', dir: 'asc' },
      }),
    )

    const views = await f.tx((tx) =>
      listSavedViews(tx, f.orgId, 'invoices', f.actor.userId!),
    )
    expect(views).toHaveLength(1)
    expect(views[0]!.name).toBe('Overdue over €5k')

    // The stored filter must still drive a real query.
    const result = await f.tx((tx) =>
      listModule(
        tx,
        f.orgId,
        'invoices',
        { filter: views[0]!.filters as never },
        '2026-03-20',
      ),
    )
    expect(result.rows).toBeInstanceOf(Array)
  })

  it('shares an organization-scoped view with everyone', async () => {
    await f.tx((tx) =>
      createSavedView(tx, f.actor, {
        module: 'invoices',
        name: 'Team: unpaid',
        scope: 'organization',
        filters: { conditions: [{ field: 'status', op: 'eq', value: 'issued' }] },
      }),
    )

    const otherUser = '00000000-0000-4000-8000-00000000beef'
    const views = await f.tx((tx) => listSavedViews(tx, f.orgId, 'invoices', otherUser))
    expect(views).toHaveLength(1)
    expect(views[0]!.shared).toBe(true)
  })

  it('keeps at most one default per user and module', async () => {
    await f.tx((tx) =>
      createSavedView(tx, f.actor, { module: 'invoices', name: 'First', isDefault: true }),
    )
    await f.tx((tx) =>
      createSavedView(tx, f.actor, { module: 'invoices', name: 'Second', isDefault: true }),
    )

    const views = await f.tx((tx) => listSavedViews(tx, f.orgId, 'invoices', f.actor.userId!))
    expect(views.filter((v) => v.isDefault)).toHaveLength(1)
    expect(views.find((v) => v.isDefault)!.name).toBe('Second')
  })

  it('deletes a view', async () => {
    const view = await f.tx((tx) =>
      createSavedView(tx, f.actor, { module: 'invoices', name: 'Temp' }),
    )
    await f.tx((tx) => deleteSavedView(tx, f.actor, view.id))
    const views = await f.tx((tx) => listSavedViews(tx, f.orgId, 'invoices', f.actor.userId!))
    expect(views).toHaveLength(0)
  })
})
