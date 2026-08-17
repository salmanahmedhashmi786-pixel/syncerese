import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withTenant } from '@/db/tenant'
import { resolveContext, type RequestContext } from '@/server/context'
import { activateProductKey, issueProductKey, revokeProductKey } from '@/licensing/keys'
import { generateProductKey, keyLast4, normaliseProductKey } from '@/licensing/product-key'
import { createTestDb, roleId, seedOrg, seedUser, type TestDb } from './helpers/db'

/**
 * Issuing and redeeming product keys.
 *
 * The licensing path that does not go through Stripe. What matters is that a
 * key grants exactly the term it was sold for, exactly once, to exactly the
 * customer it was issued for.
 */
describe('issuing and activating against a real database', () => {
  let t: TestDb
  let org: { orgId: string; ownerUserId: string }
  let other: { orgId: string; ownerUserId: string }
  let ctx: RequestContext
  let otherCtx: RequestContext
  const saved = { ...process.env }

  beforeEach(async () => {
    process.env.LICENSE_KEY_PEPPER = 'test-pepper'
    t = await createTestDb()
    org = await seedOrg(t, { name: 'Key Co', slug: 'key-co', seats: 5 })
    other = await seedOrg(t, { name: 'Other Co', slug: 'other-key-co', seats: 5 })

    ctx = (await resolveContext(t.db, {
      userId: org.ownerUserId,
      organizationId: org.orgId,
    }))!
    otherCtx = (await resolveContext(t.db, {
      userId: other.ownerUserId,
      organizationId: other.orgId,
    }))!
  })

  afterEach(async () => {
    await t.close()
    process.env = { ...saved }
  })

  const issue = (overrides: Record<string, unknown> = {}, target = org) =>
    withTenant(t.db, { organizationId: target.orgId, userId: target.ownerUserId }, (tx) =>
      issueProductKey(
        tx,
        { organizationId: target.orgId, durationDays: 30, ...overrides },
        { userId: target.ownerUserId },
      ),
    )

  const licence = async (orgId: string) => {
    const res = await t.client.query<{
      status: string
      seat_count: number
      valid_until: string | null
    }>(`select status, seat_count, valid_until from licenses where organization_id = $1`, [orgId])
    return res.rows[0]!
  }

  it('stores only a hash, never the key', async () => {
    const issued = await issue()

    const row = await t.client.query<{ key_hash: string; key_last4: string }>(
      `select key_hash, key_last4 from license_keys where id = $1`,
      [issued.keyId],
    )
    // A leaked table must not be a set of working licences.
    expect(row.rows[0]!.key_hash).not.toContain(normaliseProductKey(issued.key)!)
    expect(row.rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.rows[0]!.key_last4).toBe(keyLast4(issued.key))
  })

  it('grants the term and extends the licence', async () => {
    const issued = await issue({ durationDays: 365 })

    const result = await activateProductKey(t.db, ctx, issued.key)
    expect(result.durationDays).toBe(365)

    const after = await licence(org.orgId)
    expect(after.status).toBe('active')

    const daysOut = (new Date(after.valid_until!).getTime() - Date.now()) / 86_400_000
    expect(daysOut).toBeGreaterThan(360)
  })

  it('tops up rather than truncating when activated early', async () => {
    // Somebody renewing before their term ends should get the new term AND the
    // time they had left, not have it thrown away.
    await t.client.query(
      `update licenses set valid_until = now() + interval '100 days' where organization_id = $1`,
      [org.orgId],
    )
    const issued = await issue({ durationDays: 30 })
    await activateProductKey(t.db, ctx, issued.key)

    const after = await licence(org.orgId)
    const daysOut = (new Date(after.valid_until!).getTime() - Date.now()) / 86_400_000
    expect(daysOut).toBeGreaterThan(129)
  })

  it('accepts a key however the customer types it', async () => {
    const issued = await issue()
    // Lower case, spaces for dashes, and the letter O for zero.
    const messy = issued.key.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'O')
    await expect(activateProductKey(t.db, ctx, messy)).resolves.toBeTruthy()
  })

  it('can only be used once', async () => {
    const issued = await issue()
    await activateProductKey(t.db, ctx, issued.key)

    // Two clicks race here; the second must not grant the term again.
    await expect(activateProductKey(t.db, ctx, issued.key)).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    })
  })

  it('refuses a key issued for a different organization', async () => {
    const issued = await issue({}, org)
    await expect(activateProductKey(t.db, otherCtx, issued.key)).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    })
    // And the other tenant's licence is untouched.
    expect((await licence(other.orgId)).status).toBe('active')
  })

  it('refuses a withdrawn key', async () => {
    const issued = await issue()
    await withTenant(t.db, { organizationId: org.orgId }, (tx) =>
      revokeProductKey(tx, org.orgId, issued.keyId, { userId: null, reason: 'test' }),
    )
    await expect(activateProductKey(t.db, ctx, issued.key)).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    })
  })

  it('invalidates an earlier key when a replacement is issued', async () => {
    // "The key never arrived" — a reissue must stop the one that went astray,
    // and the schema allows only one live key per licence anyway.
    const first = await issue()
    const second = await issue()

    await expect(activateProductKey(t.db, ctx, first.key)).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    })
    await expect(activateProductKey(t.db, ctx, second.key)).resolves.toBeTruthy()
  })

  it('refuses a key past its redemption window', async () => {
    const issued = await issue()
    await t.client.query(
      `update license_keys set expires_at = now() - interval '1 day' where id = $1`,
      [issued.keyId],
    )
    await expect(activateProductKey(t.db, ctx, issued.key)).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    })
  })

  it('refuses a well-formed key that was never issued', async () => {
    // Passes the check character, so only the server lookup can refuse it —
    // which is the point of the check character not being a security control.
    await expect(activateProductKey(t.db, ctx, generateProductKey())).rejects.toMatchObject({
      code: 'LICENSE_INVALID',
    })
  })

  it('refuses gibberish before it reaches the database', async () => {
    await expect(activateProductKey(t.db, ctx, 'not-a-key')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('never lowers seats below those already in use', async () => {
    const salesRole = await roleId(t.client, 'sales')
    for (let i = 0; i < 3; i++) {
      const userId = await seedUser(t, `seat${i}@key-co.test`)
      await t.sudo(
        `insert into memberships (id, organization_id, user_id, role_id, status)
         values (gen_random_uuid(), '${org.orgId}', '${userId}', '${salesRole}', 'active')`,
      )
    }

    // A key for 2 seats against 4 people. Applying it literally would leave the
    // seat trigger refusing every future change for a paying customer.
    const issued = await issue({ seatCount: 2 })
    const result = await activateProductKey(t.db, ctx, issued.key)
    expect(result.seats).toBeGreaterThanOrEqual(4)
  })

  it('refuses a term nobody chose', async () => {
    await expect(issue({ durationDays: 7 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('records issuance and activation without recording the key', async () => {
    const issued = await issue()
    await activateProductKey(t.db, ctx, issued.key)

    const events = await t.client.query<{ event: string; payload: Record<string, unknown> }>(
      `select event, payload from license_events where organization_id = $1 and event like 'key.%'`,
      [org.orgId],
    )
    expect(events.rows.map((r) => r.event).sort()).toEqual(['key.activated', 'key.issued'])

    // An event log holding the credential is a second copy of it.
    expect(JSON.stringify(events.rows)).not.toContain(normaliseProductKey(issued.key))
  })

  it('lifts a lapsed tenant back out of read-only', async () => {
    // The whole reason a key exists: a customer whose term ran out pays by
    // invoice, gets a key, and is working again.
    await t.client.query(
      `update licenses set status = 'suspended',
                           valid_until = now() - interval '30 days',
                           grace_until = now() - interval '10 days'
        where organization_id = $1`,
      [org.orgId],
    )

    const lapsed = await resolveContext(t.db, {
      userId: org.ownerUserId,
      organizationId: org.orgId,
    })
    expect(lapsed!.licence.canWrite).toBe(false)

    // `license.manage` still works while read-only — without that, redeeming a
    // key would be impossible for exactly the customers who need to.
    const issued = await issue({ durationDays: 365 })
    await activateProductKey(t.db, lapsed!, issued.key)

    const revived = await resolveContext(t.db, {
      userId: org.ownerUserId,
      organizationId: org.orgId,
    })
    expect(revived!.licence.canWrite).toBe(true)
  })
})
