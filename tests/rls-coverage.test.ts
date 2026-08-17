import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from './helpers/db'

/**
 * The CI guard (schema §3, layer 3).
 *
 * Layers 1 and 2 — the not-null tenant column and the RLS policy — protect
 * against bugs. This protects against FORGETTING: it walks the live catalogue
 * and fails the build if a table carrying `organization_id` was added without a
 * policy. Without it, the isolation guarantee silently degrades the first time
 * someone adds a table in a hurry.
 *
 * Adding a table to EXEMPT is a deliberate, reviewable act. That is the point.
 */

/** Tables with no `organization_id`, each exempt for a stated reason. */
const EXEMPT: Record<string, string> = {
  users: 'Global by design — one user belongs to many organizations (MUST DO #1).',
  auth_accounts: 'Auth.js OAuth links, keyed to the global user.',
  sessions: 'Auth.js sessions, keyed to the global user.',
  verification_tokens: 'Auth.js email verification, pre-tenant by nature.',
  user_preferences: 'Appearance follows the person across organizations.',
  permissions: 'Static catalogue of permission keys — identical for every tenant.',
  role_permissions: 'No tenant column; scoped transitively via its policy on roles.',
  currencies: 'ISO 4217 reference data — the same for everyone, contains no tenant data.',
  __drizzle_migrations: 'Migration bookkeeping.',
  platform_admins:
    'The VENDOR’s own administrators, not a tenant’s — deciding who may issue licences across ' +
    'every organization is not something any tenant participates in. RLS enabled with NO ' +
    'policy and granted to nobody: reachable only through is_platform_admin() and the ' +
    'platform_* functions, each of which refuses unless the caller is listed. Membership is ' +
    'granted from the command line, never from the web.',
  signin_attempts:
    'Pre-tenant abuse counters, keyed by a salted hash of the caller network — there is no ' +
    'tenant established when somebody is trying to sign in. RLS enabled with NO policy and ' +
    'granted to nobody: the application reaches it only through consume_signin_attempt() and ' +
    'clear_signin_attempts(), so it can neither read the table nor reset its own counter.',
  password_reset_tokens:
    'Keyed to the GLOBAL `users` table, so there is no tenant column to scope by — a person ' +
    'resetting a password has no organization yet. RLS enabled with NO policy and granted to ' +
    'nobody: the application reaches it only through issue_password_reset(), ' +
    'password_reset_valid(), consume_password_reset() and invalidate_password_resets(), so a ' +
    'bug or an injection in application code cannot enumerate live reset tokens.',
  reset_attempts:
    'Pre-tenant abuse counters for password reset, keyed by a salted hash of the caller ' +
    'network. Its OWN counter rather than signin_attempts, so somebody probing resets cannot ' +
    'lock out sign-in for an entire office behind one address. RLS enabled with NO policy and ' +
    'granted to nobody: reachable only through consume_reset_attempt().',
  signup_attempts:
    'Pre-tenant abuse counters, keyed by a salted hash of the caller network. There is no ' +
    'tenant yet when a row is written. It has RLS enabled with NO policy and is granted to ' +
    'nobody: the application reaches it only through consume_signup_attempt(), so it cannot ' +
    'read the table or reset its own counter.',
}

type TableRow = {
  table_name: string
  has_org_column: boolean
  rls_enabled: boolean
  rls_forced: boolean
  policy_count: number
}

describe('RLS coverage', () => {
  let t: TestDb
  let tables: TableRow[]

  beforeAll(async () => {
    t = await createTestDb()
    const res = await t.client.query<TableRow>(`
      select
        c.relname as table_name,
        exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
        ) as has_org_column,
        c.relrowsecurity      as rls_enabled,
        c.relforcerowsecurity as rls_forced,
        (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policy_count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname
    `)
    tables = res.rows
  })

  afterAll(async () => {
    await t.close()
  })

  it('found the schema', () => {
    expect(tables.length).toBeGreaterThan(15)
  })

  it('every table with organization_id has RLS enabled, forced, and a policy', () => {
    const failures = tables
      .filter((r) => r.has_org_column)
      .filter((r) => !r.rls_enabled || !r.rls_forced || r.policy_count === 0)
      .map((r) => {
        const missing = [
          !r.rls_enabled && 'ENABLE ROW LEVEL SECURITY',
          // FORCE matters independently: without it the table OWNER bypasses
          // the policy, so migrations and admin tooling would run cross-tenant.
          !r.rls_forced && 'FORCE ROW LEVEL SECURITY',
          r.policy_count === 0 && 'a tenant_isolation POLICY',
        ].filter(Boolean)
        return `  ${r.table_name} is missing ${missing.join(' and ')}`
      })

    expect(
      failures,
      `Tables carrying organization_id must be tenant-isolated. Add them to the\n` +
        `tenant_tables array in drizzle/0001_rls_and_guards.sql:\n${failures.join('\n')}`,
    ).toEqual([])
  })

  it('every table WITHOUT organization_id is either protected or explicitly exempt', () => {
    const unaccounted = tables
      .filter((r) => !r.has_org_column)
      .filter((r) => r.policy_count === 0)
      .filter((r) => !(r.table_name in EXEMPT))
      .map((r) => r.table_name)

    expect(
      unaccounted,
      `These tables have neither a tenant column nor a policy nor an exemption.\n` +
        `Either add organization_id, or add an entry to EXEMPT in this file stating why\n` +
        `it is safe for every tenant to see:\n  ${unaccounted.join('\n  ')}`,
    ).toEqual([])
  })

  it('has no stale exemptions', () => {
    // An exemption left behind after a table gained organization_id would be a
    // silent hole in the first assertion above.
    const present = new Set(tables.map((r) => r.table_name))
    const stale = Object.keys(EXEMPT).filter((name) => {
      const row = tables.find((r) => r.table_name === name)
      return present.has(name) && row?.has_org_column === true
    })
    expect(stale, `Exempt tables that now carry organization_id: ${stale.join(', ')}`).toEqual([])
  })

  it('the application role cannot bypass RLS', () => {
    // The whole isolation model rests on this one property.
    return t.client
      .query<{ rolbypassrls: boolean; rolsuper: boolean }>(
        `select rolbypassrls, rolsuper from pg_roles where rolname = 'syncrese_app'`,
      )
      .then((res) => {
        expect(res.rows[0]).toBeDefined()
        expect(res.rows[0]!.rolbypassrls).toBe(false)
        expect(res.rows[0]!.rolsuper).toBe(false)
      })
  })

  it('audit_log is append-only for the application role', async () => {
    const grants = await t.client.query<{ privilege_type: string }>(`
      select privilege_type from information_schema.role_table_grants
      where grantee = 'syncrese_app' and table_name = 'audit_log'
    `)
    const held = grants.rows.map((r) => r.privilege_type.toUpperCase())
    expect(held).toContain('SELECT')
    expect(held).toContain('INSERT')
    expect(held).not.toContain('UPDATE')
    expect(held).not.toContain('DELETE')
  })
})
