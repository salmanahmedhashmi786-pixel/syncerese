import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { withTenant } from '@/db/tenant'
import { memberships } from '@/db/schema'
import { newId } from '@/lib/ids'
import { fromDatabaseError } from '@/lib/errors'
import { createTestDb, roleId, seedOrg, seedUser, type TestDb } from './helpers/db'

/**
 * MUST DO #10: "a test that proves user creation is blocked server-side once a
 * tenant is at its licensed seat count EVEN IF THE CLIENT IS BYPASSED".
 *
 * Every insert below goes straight to the database, with no service layer in
 * the way — which is precisely the attack a tampered desktop build represents.
 * If enforcement lived in application code, all of these would succeed.
 */
describe('seat limit enforcement', () => {
  let t: TestDb
  let org: { orgId: string; ownerUserId: string }
  let salesRoleId: string

  const addMember = async (userId: string, status = 'active') =>
    withTenant(t.db, { organizationId: org.orgId }, (tx) =>
      tx.insert(memberships).values({
        id: newId(),
        organizationId: org.orgId,
        userId,
        roleId: salesRoleId,
        status,
      }),
    )

  beforeAll(async () => {
    t = await createTestDb()
    // 3 seats, and seedOrg already consumes one for the owner.
    org = await seedOrg(t, { name: 'Vogel GmbH', slug: 'vogel', seats: 3 })
    salesRoleId = await roleId(t.client, 'sales')
  })

  afterAll(async () => {
    await t.close()
  })

  it('allows members up to the licensed seat count', async () => {
    await addMember(await seedUser(t, 'a@vogel.test'))
    await addMember(await seedUser(t, 'b@vogel.test'))

    const res = await t.client.query<{ n: string }>(
      `select count(*) as n from memberships where organization_id = $1 and status = 'active'`,
      [org.orgId],
    )
    expect(Number(res.rows[0]!.n)).toBe(3)
  })

  it('blocks the seat that would exceed the licence', async () => {
    const userId = await seedUser(t, 'c@vogel.test')
    await expect(addMember(userId)).rejects.toThrow(/SYNC_SEAT_LIMIT_REACHED/)
  })

  it('surfaces a typed, user-facing error rather than a raw Postgres exception', async () => {
    const userId = await seedUser(t, 'd@vogel.test')
    try {
      await addMember(userId)
      expect.unreachable('seat limit should have been enforced')
    } catch (err) {
      const appErr = fromDatabaseError(err)
      expect(appErr).not.toBeNull()
      expect(appErr!.code).toBe('SEAT_LIMIT_REACHED')
      expect(appErr!.status).toBe(409)
      expect(appErr!.message).toMatch(/3 of 3 seats are in use/)
      // Must not leak SQL, table names or stack detail to the user.
      expect(appErr!.message).not.toMatch(/insert|trigger|plpgsql|memberships/i)
    }
  })

  it('cannot be bypassed by raw SQL that skips the application entirely', async () => {
    const userId = await seedUser(t, 'e@vogel.test')
    await expect(
      t.client.exec(`
        set local role syncrese_app;
        insert into memberships (id, organization_id, user_id, role_id, status)
        values ('${newId()}', '${org.orgId}', '${userId}', '${salesRoleId}', 'active');
      `),
    ).rejects.toThrow(/SYNC_SEAT_LIMIT_REACHED/)
  })

  it('frees a seat on deactivation without deleting history', async () => {
    const victim = await t.client.query<{ id: string; user_id: string }>(
      `select id, user_id from memberships
        where organization_id = $1 and status = 'active' and user_id <> $2 limit 1`,
      [org.orgId, org.ownerUserId],
    )
    const membershipId = victim.rows[0]!.id

    await withTenant(t.db, { organizationId: org.orgId }, (tx) =>
      tx.execute(sql`
        update memberships
           set status = 'deactivated', deactivated_at = now()
         where id = ${membershipId}
      `),
    )

    // Row still exists — offboarding must not erase authorship or audit links.
    const still = await t.client.query<{ status: string }>(
      `select status from memberships where id = $1`,
      [membershipId],
    )
    expect(still.rows[0]!.status).toBe('deactivated')

    // ...and the freed seat is immediately reusable.
    await expect(addMember(await seedUser(t, 'f@vogel.test'))).resolves.not.toThrow()
  })

  it('does not re-check the limit when an existing member changes role', async () => {
    // At the cap right now. Changing a role must not be refused as if it were a
    // new seat — a false positive here would lock an admin out of their own org.
    //
    // Deliberately NOT the owner: demoting the last owner is refused by
    // `enforce_last_owner`, which would make this pass or fail for the wrong
    // reason.
    const target = await t.client.query<{ id: string }>(
      `select m.id from memberships m
         join roles r on r.id = m.role_id
        where m.organization_id = $1 and m.status = 'active' and r.key <> 'owner'
        limit 1`,
      [org.orgId],
    )
    const financeRoleId = await roleId(t.client, 'finance')

    await expect(
      withTenant(t.db, { organizationId: org.orgId }, (tx) =>
        tx.execute(sql`
          update memberships set role_id = ${financeRoleId} where id = ${target.rows[0]!.id}
        `),
      ),
    ).resolves.not.toThrow()
  })

  it('refuses membership creation for an organization with no licence', async () => {
    const orgId = newId()
    const userId = await seedUser(t, 'g@unlicensed.test')
    await t.sudo(`
      insert into organizations (id, slug, name, base_currency)
      values ('${orgId}', 'unlicensed', 'Unlicensed Co', 'USD')
    `)

    await expect(
      withTenant(t.db, { organizationId: orgId }, (tx) =>
        tx.insert(memberships).values({
          id: newId(),
          organizationId: orgId,
          userId,
          roleId: salesRoleId,
          status: 'active',
        }),
      ),
    ).rejects.toThrow(/SYNC_NO_LICENSE/)
  })

  it('counts seats per tenant, not globally', async () => {
    const other = await seedOrg(t, { name: 'Roomy AB', slug: 'roomy', seats: 5 })
    const newcomer = await seedUser(t, 'h@roomy.test')

    // The capped tenant above must not restrict an unrelated one.
    await expect(
      withTenant(t.db, { organizationId: other.orgId }, (tx) =>
        tx.insert(memberships).values({
          id: newId(),
          organizationId: other.orgId,
          userId: newcomer,
          roleId: salesRoleId,
          status: 'active',
        }),
      ),
    ).resolves.not.toThrow()
  })
})
