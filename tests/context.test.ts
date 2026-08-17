import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveContext, can, requirePermission } from '@/server/context'
import { withTenant } from '@/db/tenant'
import { memberships } from '@/db/schema'
import { newId } from '@/lib/ids'
import { createTestDb, roleId, seedOrg, seedUser, type TestDb } from './helpers/db'

/**
 * Session context resolution.
 *
 * These exist because the original implementation queried `memberships`
 * directly through `withoutTenantScope` — which RLS correctly denies, since
 * there is no tenant scope established at sign-in time. Every sign-in silently
 * returned null and bounced the user back to the login page. Nothing caught it
 * because nothing tested the function that turns a session into permissions.
 */
describe('request context', () => {
  let t: TestDb
  let orgA: { orgId: string; ownerUserId: string }
  let orgB: { orgId: string; ownerUserId: string }

  beforeAll(async () => {
    t = await createTestDb()
    orgA = await seedOrg(t, { name: 'Alpha Werke', slug: 'alpha', seats: 10 })
    orgB = await seedOrg(t, { name: 'Beta Marine', slug: 'beta', seats: 10 })
  })

  afterAll(async () => {
    await t.close()
  })

  it('resolves an owner to their role and permissions', async () => {
    const ctx = await resolveContext(t.db, {
      userId: orgA.ownerUserId,
      organizationId: orgA.orgId,
    })

    expect(ctx).not.toBeNull()
    expect(ctx!.role).toBe('owner')
    expect(ctx!.organizationId).toBe(orgA.orgId)
    expect(ctx!.permissions.size).toBeGreaterThan(0)
    expect(can(ctx, 'org.delete')).toBe(true)
  })

  it('returns null for an organization the user does not belong to', async () => {
    // The cookie says org B; the user is only in org A. Must be refused, and
    // indistinguishably from "no such organization" — telling an outsider that
    // a tenant exists is itself a disclosure.
    const ctx = await resolveContext(t.db, {
      userId: orgA.ownerUserId,
      organizationId: orgB.orgId,
    })
    expect(ctx).toBeNull()
  })

  it('returns null for a deactivated member', async () => {
    const userId = await seedUser(t, 'leaver@alpha.test')
    const sales = await roleId(t.client, 'sales')

    await withTenant(t.db, { organizationId: orgA.orgId }, (tx) =>
      tx.insert(memberships).values({
        id: newId(),
        organizationId: orgA.orgId,
        userId,
        roleId: sales,
        status: 'active',
      }),
    )

    const before = await resolveContext(t.db, { userId, organizationId: orgA.orgId })
    expect(before?.role).toBe('sales')

    await t.sudo(
      `update memberships set status = 'deactivated'
        where organization_id = '${orgA.orgId}' and user_id = '${userId}'`,
    )

    // Offboarding must revoke access immediately, without deleting history.
    const after = await resolveContext(t.db, { userId, organizationId: orgA.orgId })
    expect(after).toBeNull()
  })

  it('returns null without a user id', async () => {
    const ctx = await resolveContext(t.db, { userId: null, organizationId: orgA.orgId })
    expect(ctx).toBeNull()
  })

  it('supports one user belonging to several organizations with different roles', async () => {
    // The consultant/accountant case from MUST DO #1.
    const userId = await seedUser(t, 'accountant@external.test')
    const finance = await roleId(t.client, 'finance')
    const readonly = await roleId(t.client, 'readonly')

    await withTenant(t.db, { organizationId: orgA.orgId }, (tx) =>
      tx.insert(memberships).values({
        id: newId(),
        organizationId: orgA.orgId,
        userId,
        roleId: finance,
        status: 'active',
      }),
    )
    await withTenant(t.db, { organizationId: orgB.orgId }, (tx) =>
      tx.insert(memberships).values({
        id: newId(),
        organizationId: orgB.orgId,
        userId,
        roleId: readonly,
        status: 'active',
      }),
    )

    const inA = await resolveContext(t.db, { userId, organizationId: orgA.orgId })
    const inB = await resolveContext(t.db, { userId, organizationId: orgB.orgId })

    expect(inA!.role).toBe('finance')
    expect(inB!.role).toBe('readonly')
    expect(can(inA, 'ledger.post')).toBe(true)
    expect(can(inB, 'ledger.post')).toBe(false)
  })

  it('enforces permissions server-side, throwing rather than returning false', async () => {
    const userId = await seedUser(t, 'viewer@alpha.test')
    const readonly = await roleId(t.client, 'readonly')
    await withTenant(t.db, { organizationId: orgA.orgId }, (tx) =>
      tx.insert(memberships).values({
        id: newId(),
        organizationId: orgA.orgId,
        userId,
        roleId: readonly,
        status: 'active',
      }),
    )

    const ctx = await resolveContext(t.db, { userId, organizationId: orgA.orgId })
    expect(() => requirePermission(ctx, 'ledger.post')).toThrow(/cannot perform this action/)
    expect(() => requirePermission(ctx, 'ledger.read')).not.toThrow()
    expect(() => requirePermission(null, 'ledger.read')).toThrow(/Sign in/)
  })
})
