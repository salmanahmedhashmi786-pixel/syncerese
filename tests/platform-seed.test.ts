import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PERMISSIONS, ROLE_GRANTS, ROLE_KEYS } from '@/auth/permissions'
import { createTestDb, type TestDb } from './helpers/db'

/**
 * drizzle/0003_platform_seed.sql is GENERATED from src/auth/permissions.ts.
 *
 * These tests catch the obvious failure: someone edits the TypeScript
 * catalogue, forgets `npm run gen:platform-seed`, and ships an application that
 * checks permissions the database has never heard of. Silent, and it fails as
 * a mysterious 403 months later.
 */
describe('platform seed matches the permission catalogue', () => {
  let t: TestDb

  beforeAll(async () => {
    t = await createTestDb()
  })

  afterAll(async () => {
    await t.close()
  })

  it('seeds exactly the permissions declared in TypeScript', async () => {
    const res = await t.client.query<{ key: string }>('select key from permissions order by key')
    const inDb = res.rows.map((r) => r.key).sort()
    const inCode = Object.keys(PERMISSIONS).sort()

    expect(inDb, 'run `npm run gen:platform-seed` to regenerate the migration').toEqual(inCode)
  })

  it('seeds every system role', async () => {
    const res = await t.client.query<{ key: string }>(
      'select key from roles where organization_id is null order by key',
    )
    expect(res.rows.map((r) => r.key).sort()).toEqual([...ROLE_KEYS].sort())
  })

  it('grants each role exactly what the code says it has', async () => {
    for (const role of ROLE_KEYS) {
      const res = await t.client.query<{ permission_key: string }>(
        `select rp.permission_key
           from role_permissions rp
           join roles r on r.id = rp.role_id
          where r.key = $1 and r.organization_id is null
          order by rp.permission_key`,
        [role],
      )
      const inDb = res.rows.map((r) => r.permission_key).sort()
      const inCode = [...ROLE_GRANTS[role]].sort()
      expect(inDb, `grants drifted for role "${role}"`).toEqual(inCode)
    }
  })

  it('gives owner strictly more than admin, and admin more than readonly', async () => {
    // A regression here means the role hierarchy has been broken by an edit —
    // e.g. a new permission added to admin but not owner.
    const owner = new Set(ROLE_GRANTS.owner)
    const admin = new Set(ROLE_GRANTS.admin)
    const readonly = new Set(ROLE_GRANTS.readonly)

    for (const p of admin) expect(owner.has(p), `admin has ${p}, owner does not`).toBe(true)
    for (const p of readonly) expect(admin.has(p), `readonly has ${p}, admin does not`).toBe(true)
    expect(owner.size).toBeGreaterThan(admin.size)
    expect(admin.size).toBeGreaterThan(readonly.size)
  })

  it('only owner can delete the organization', async () => {
    expect(ROLE_GRANTS.owner).toContain('org.delete')
    for (const role of ROLE_KEYS.filter((r) => r !== 'owner')) {
      expect(ROLE_GRANTS[role], `${role} must not be able to delete the org`).not.toContain(
        'org.delete',
      )
    }
  })

  it('only owner and admin can invite members — seats cost money', async () => {
    for (const role of ROLE_KEYS) {
      const canInvite = ROLE_GRANTS[role].includes('member.invite')
      expect(canInvite, `${role} invite permission`).toBe(role === 'owner' || role === 'admin')
    }
  })
})
