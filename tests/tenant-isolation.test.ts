import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { withTenant } from '@/db/tenant'
import { auditLog, organizations } from '@/db/schema'
import { newId } from '@/lib/ids'
import { createTestDb, seedOrg, type TestDb } from './helpers/db'

/**
 * MUST DO #10: "a test that proves tenant A can never read tenant B's data".
 *
 * This is the single most damaging failure mode in a multi-tenant ERP, so the
 * assertions here are deliberately paranoid — they check reads, aggregates,
 * writes, cross-tenant updates and deletes, and the unscoped case.
 */
describe('tenant isolation', () => {
  let t: TestDb
  let a: { orgId: string; ownerUserId: string }
  let b: { orgId: string; ownerUserId: string }

  beforeAll(async () => {
    t = await createTestDb()
    a = await seedOrg(t, { name: 'Alpha Werke', slug: 'alpha', seats: 10 })
    b = await seedOrg(t, { name: 'Beta Marine', slug: 'beta', seats: 10, currency: 'GBP' })
  })

  afterAll(async () => {
    await t.close()
  })

  it('sees only its own organization row', async () => {
    const rows = await withTenant(t.db, { organizationId: a.orgId }, (tx) =>
      tx.select().from(organizations),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(a.orgId)
    expect(rows[0]!.slug).toBe('alpha')
  })

  it('cannot read another tenant even when asking for its id explicitly', async () => {
    const rows = await withTenant(t.db, { organizationId: a.orgId }, (tx) =>
      tx.select().from(organizations).where(sql`id = ${b.orgId}`),
    )
    expect(rows).toEqual([])
  })

  it('cannot read another tenant through aggregates', async () => {
    // A COUNT that ignored RLS would return 2 organizations and 2 licences.
    const res = await withTenant(t.db, { organizationId: a.orgId }, (tx) =>
      tx.execute(sql`
        select
          (select count(*) from organizations) as orgs,
          (select count(*) from licenses)      as lics,
          (select count(*) from memberships)   as mems
      `),
    )
    const row = (res as unknown as { rows: Record<string, string>[] }).rows[0]!
    expect(Number(row.orgs)).toBe(1)
    expect(Number(row.lics)).toBe(1)
    expect(Number(row.mems)).toBe(1)
  })

  it('cannot read another tenant through a join', async () => {
    const res = await withTenant(t.db, { organizationId: a.orgId }, (tx) =>
      tx.execute(sql`
        select o.slug, l.seat_count
        from organizations o
        join licenses l on l.organization_id = o.id
      `),
    )
    const rows = (res as unknown as { rows: { slug: string }[] }).rows
    expect(rows.map((r) => r.slug)).toEqual(['alpha'])
  })

  it('returns nothing when tenant scope was never established', async () => {
    // A forgotten set_config must fail CLOSED. current_org_id() yields NULL,
    // every comparison is NULL, and the policy denies. The dangerous
    // alternative would be returning everything.
    const res = await t.client.query<{ n: string }>(`
      select count(*) as n from organizations
    `)
    // superuser bypasses RLS, so sanity-check the fixture itself first
    expect(Number(res.rows[0]!.n)).toBe(2)

    await t.client.exec('begin')
    await t.client.exec('set local role syncrese_app')
    const scoped = await t.client.query<{ n: string }>(`select count(*) as n from organizations`)
    await t.client.exec('commit')
    expect(Number(scoped.rows[0]!.n)).toBe(0)
  })

  it('cannot INSERT a row belonging to another tenant', async () => {
    await expect(
      withTenant(t.db, { organizationId: a.orgId }, (tx) =>
        tx.insert(auditLog).values({
          id: newId(),
          organizationId: b.orgId, // <- forging tenant B
          actorType: 'system',
          action: 'forged.write',
          entityType: 'test',
        }),
      ),
    ).rejects.toThrow(/row-level security|violates/i)
  })

  it('cannot UPDATE another tenant’s rows', async () => {
    await withTenant(t.db, { organizationId: a.orgId }, (tx) =>
      tx.execute(sql`update licenses set seat_count = 999`),
    )

    const bSeats = await t.client.query<{ seat_count: number }>(
      `select seat_count from licenses where organization_id = $1`,
      [b.orgId],
    )
    expect(bSeats.rows[0]!.seat_count).toBe(10) // untouched

    const aSeats = await t.client.query<{ seat_count: number }>(
      `select seat_count from licenses where organization_id = $1`,
      [a.orgId],
    )
    expect(aSeats.rows[0]!.seat_count).toBe(999) // own row did change
  })

  it('cannot DELETE another tenant’s rows', async () => {
    await withTenant(t.db, { organizationId: a.orgId }, (tx) =>
      tx.execute(sql`delete from memberships`),
    )

    const remaining = await t.client.query<{ organization_id: string }>(
      `select organization_id from memberships`,
    )
    expect(remaining.rows).toHaveLength(1)
    expect(remaining.rows[0]!.organization_id).toBe(b.orgId)
  })

  it('scopes each tenant independently within the same process', async () => {
    const bRows = await withTenant(t.db, { organizationId: b.orgId }, (tx) =>
      tx.select().from(organizations),
    )
    expect(bRows).toHaveLength(1)
    expect(bRows[0]!.slug).toBe('beta')
    expect(bRows[0]!.baseCurrency).toBe('GBP')
  })

  it('does not leak tenant scope past the end of a transaction', async () => {
    // The pooled-connection hazard: `SET` instead of `SET LOCAL` would carry
    // tenant A's id into the next request on the same connection.
    await withTenant(t.db, { organizationId: a.orgId }, async (tx) => {
      await tx.select().from(organizations)
    })

    const after = await t.client.query<{ setting: string | null }>(
      `select nullif(current_setting('app.org_id', true), '') as setting`,
    )
    expect(after.rows[0]!.setting).toBeNull()
  })
})
