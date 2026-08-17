import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@/db/tenant'
import { memberships, organizations } from '@/db/schema'
import { newId } from '@/lib/ids'
import { createTestDb, roleId, seedOrg, seedUser, type TestDb } from './helpers/db'

/**
 * Mutation testing for the security controls.
 *
 * A passing security test proves nothing on its own — it might be passing
 * vacuously. These tests REMOVE each guard and assert that the thing it was
 * protecting immediately becomes possible. If one of these ever fails, it means
 * the corresponding test in the other files was not actually testing anything.
 *
 * Each case restores the guard afterwards; the database is rebuilt per test
 * regardless.
 */
describe('the guards actually bite', () => {
  let t: TestDb
  let bankAcct = ''
  let revAcct = ''
  let entryNo = 1

  beforeEach(async () => {
    t = await createTestDb()
    entryNo = 1
  })

  afterEach(async () => {
    await t.close()
  })

  it('the policy PREDICATE is what filters — a permissive policy exposes everything', async () => {
    const a = await seedOrg(t, { name: 'Alpha', slug: 'alpha', seats: 5 })
    await seedOrg(t, { name: 'Beta', slug: 'beta', seats: 5 })

    const scoped = await withTenant(t.db, { organizationId: a.orgId }, (tx) =>
      tx.select().from(organizations),
    )
    expect(scoped).toHaveLength(1)

    // Simulate the realistic failure: not a MISSING policy (Postgres
    // default-denies, so that fails closed and returns nothing), but a
    // WRONG one. This is the mistake that actually ships.
    await t.sudo(`
      drop policy tenant_isolation on organizations;
      create policy tenant_isolation on organizations using (true);
    `)

    const leaked = await withTenant(t.db, { organizationId: a.orgId }, (tx) =>
      tx.select().from(organizations),
    )
    // Both rows are reachable by this query and this fixture. So the single
    // row above was the PREDICATE doing the work — not luck.
    expect(leaked.length).toBe(2)
  })

  it('a dropped policy fails CLOSED, not open', async () => {
    const a = await seedOrg(t, { name: 'Alpha', slug: 'alpha', seats: 5 })
    await seedOrg(t, { name: 'Beta', slug: 'beta', seats: 5 })

    await t.sudo(`drop policy tenant_isolation on organizations`)

    const rows = await withTenant(t.db, { organizationId: a.orgId }, (tx) =>
      tx.select().from(organizations),
    )
    // RLS enabled with no policy = deny all. Worth pinning down: it means a
    // botched migration breaks the app loudly instead of leaking quietly.
    expect(rows).toEqual([])
  })

  it('a SUPERUSER connection bypasses RLS entirely — which is why DATABASE_URL must not be one', async () => {
    const a = await seedOrg(t, { name: 'Alpha', slug: 'alpha', seats: 5 })
    await seedOrg(t, { name: 'Beta', slug: 'beta', seats: 5 })

    // Same transaction-local scope, same policy, same query. The ONLY
    // difference is which role executes it.
    await t.client.exec('begin')
    await t.client.exec(`select set_config('app.org_id', '${a.orgId}', true)`)
    const asSuperuser = await t.client.query<{ n: string }>(
      `select count(*) as n from organizations`,
    )
    await t.client.exec('commit')

    await t.client.exec('begin')
    await t.client.exec(`set local role syncrese_app`)
    await t.client.exec(`select set_config('app.org_id', '${a.orgId}', true)`)
    const asAppRole = await t.client.query<{ n: string }>(`select count(*) as n from organizations`)
    await t.client.exec('commit')

    expect(Number(asSuperuser.rows[0]!.n)).toBe(2) // sees every tenant
    expect(Number(asAppRole.rows[0]!.n)).toBe(1) // sees its own

    // FORCE ROW LEVEL SECURITY cannot be mutation-tested here because PGlite
    // connects as a superuser and superusers bypass RLS unconditionally. FORCE
    // governs the non-superuser table OWNER, and rls-coverage.test.ts asserts
    // it is set on every tenant table via the catalogue instead.
  })

  it('dropping the seat trigger DOES allow overselling', async () => {
    const org = await seedOrg(t, { name: 'Vogel', slug: 'vogel', seats: 1 })
    const sales = await roleId(t.client, 'sales')
    const u1 = await seedUser(t, 'x@vogel.test')

    // Owner already holds the single seat.
    const add = (userId: string) =>
      withTenant(t.db, { organizationId: org.orgId }, (tx) =>
        tx.insert(memberships).values({
          id: newId(),
          organizationId: org.orgId,
          userId,
          roleId: sales,
          status: 'active',
        }),
      )

    await expect(add(u1)).rejects.toThrow(/SYNC_SEAT_LIMIT_REACHED/)

    await t.sudo(`drop trigger memberships_seat_limit on memberships`)

    // Proves the block came from the TRIGGER, not from a unique constraint or
    // some other incidental restriction.
    await expect(add(u1)).resolves.not.toThrow()
  })

  it('the CI guard DOES catch a new table that carries organization_id without a policy', async () => {
    await t.sudo(`
      create table sloppy_new_feature (
        id uuid primary key,
        organization_id uuid not null references organizations(id),
        payload text
      )
    `)

    const res = await t.client.query<{ table_name: string }>(`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
        )
        and (not c.relrowsecurity or not c.relforcerowsecurity
             or (select count(*) from pg_policy p where p.polrelid = c.oid) = 0)
    `)

    expect(res.rows.map((r) => r.table_name)).toContain('sloppy_new_feature')
  })

  it('dropping the balance trigger DOES allow an unbalanced ledger', async () => {
    const org = await seedOrg(t, { name: 'Alpha', slug: 'alpha', seats: 5 })
    await t.sudo(`
      insert into accounts (id, organization_id, code, name, type, is_postable)
      values ('${(bankAcct = newId())}', '${org.orgId}', '1010', 'Bank', 'asset', true),
             ('${(revAcct = newId())}', '${org.orgId}', '4100', 'Revenue', 'income', true)
    `)

    const unbalanced = (entryId: string) => `
      set local role syncrese_app;
      select set_config('app.org_id', '${org.orgId}', true);
      insert into journal_entries (id, organization_id, entry_no, entry_date, status)
      values ('${entryId}', '${org.orgId}', ${entryNo++}, '2026-03-01', 'draft');
      insert into journal_lines
        (id, organization_id, journal_entry_id, line_no, account_id,
         debit_minor, credit_minor, currency_code, base_debit_minor, base_credit_minor)
      values
        ('${newId()}', '${org.orgId}', '${entryId}', 1, '${bankAcct}', 10000, 0, 'EUR', 10000, 0),
        ('${newId()}', '${org.orgId}', '${entryId}', 2, '${revAcct}', 0, 9000, 'EUR', 0, 9000);
    `

    await expect(t.sudo(unbalanced(newId()))).rejects.toThrow(/SYNC_UNBALANCED_ENTRY/)

    await t.sudo(`drop trigger journal_lines_balanced on journal_lines`)

    // Proves the rejection came from the TRIGGER, not from a check constraint
    // or some incidental restriction.
    await expect(t.sudo(unbalanced(newId()))).resolves.not.toThrow()
  })

  it('dropping the immutability trigger DOES allow rewriting a posted entry', async () => {
    const org = await seedOrg(t, { name: 'Alpha', slug: 'alpha', seats: 5 })
    const entryId = newId()
    await t.sudo(`
      insert into accounts (id, organization_id, code, name, type, is_postable)
      values ('${(bankAcct = newId())}', '${org.orgId}', '1010', 'Bank', 'asset', true),
             ('${(revAcct = newId())}', '${org.orgId}', '4100', 'Revenue', 'income', true);
      insert into journal_entries (id, organization_id, entry_no, entry_date, status)
      values ('${entryId}', '${org.orgId}', 1, '2026-03-01', 'draft');
      insert into journal_lines
        (id, organization_id, journal_entry_id, line_no, account_id,
         debit_minor, credit_minor, currency_code, base_debit_minor, base_credit_minor)
      values
        ('${newId()}', '${org.orgId}', '${entryId}', 1, '${bankAcct}', 10000, 0, 'EUR', 10000, 0),
        ('${newId()}', '${org.orgId}', '${entryId}', 2, '${revAcct}', 0, 10000, 'EUR', 0, 10000);
      update journal_entries set status = 'posted' where id = '${entryId}';
    `)

    await expect(
      t.sudo(`update journal_entries set description = 'tampered' where id = '${entryId}'`),
    ).rejects.toThrow(/SYNC_POSTED_IMMUTABLE/)

    await t.sudo(`drop trigger journal_entries_immutable on journal_entries`)

    await expect(
      t.sudo(`update journal_entries set description = 'tampered' where id = '${entryId}'`),
    ).resolves.not.toThrow()
  })

  it('the append-only trigger DOES block rewriting audit history', async () => {
    const org = await seedOrg(t, { name: 'Alpha', slug: 'alpha', seats: 5 })
    await t.sudo(`
      insert into audit_log (id, organization_id, actor_type, action, entity_type)
      values ('${newId()}', '${org.orgId}', 'system', 'test.event', 'test')
    `)

    // Even as the OWNER — the strongest caller short of a superuser bypass.
    await expect(
      t.sudo(`update audit_log set action = 'tampered'`),
    ).rejects.toThrow(/SYNC_APPEND_ONLY/)

    await expect(t.sudo(`delete from audit_log`)).rejects.toThrow(/SYNC_APPEND_ONLY/)
  })
})
