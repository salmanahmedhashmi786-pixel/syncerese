import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * The migrations, applied the way PRODUCTION applies them.
 *
 * Every other test in this suite gets a PGlite connection that is a SUPERUSER,
 * and a superuser bypasses row level security unconditionally — FORCE included.
 * That makes the normal harness blind to an entire class of failure: a
 * migration that seeds rows into a policed table works perfectly in every test
 * and is rejected the moment it runs against a real database.
 *
 * That is not hypothetical. `0003_platform_seed.sql` inserts the system roles
 * with `organization_id = NULL` into `roles`, whose policy carries
 * `WITH CHECK (organization_id = current_org_id())`. NULL = NULL is NULL, which
 * a policy treats as false, so the insert is refused — and `npm run db:migrate`
 * against Neon failed at 0003 before this test existed. Nobody could deploy.
 *
 * So this mirrors the real sequence: scripts/provision-db.ts creates a
 * non-superuser `syncrese_owner` and hands it the schema, then db:migrate runs
 * as that role.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function migrationFiles(): Promise<{ name: string; sql: string }[]> {
  const dir = path.join(root, 'drizzle')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  return Promise.all(
    files.map(async (name) => ({ name, sql: await readFile(path.join(dir, name), 'utf8') })),
  )
}

describe('migrations applied as the schema owner', () => {
  let client: PGlite | undefined

  afterEach(async () => {
    await client?.close()
    client = undefined
  })

  it('every migration applies without superuser privileges', async () => {
    client = new PGlite()

    // Exactly what scripts/provision-db.ts does before db:migrate ever runs.
    // Both roles pre-exist, so 0001's guarded CREATE ROLE is skipped — the
    // owner has no CREATEROLE in production either.
    await client.exec(`
      CREATE ROLE syncrese_app     NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
      CREATE ROLE syncrese_owner   NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
      CREATE ROLE syncrese_definer NOSUPERUSER NOBYPASSRLS NOLOGIN;
      GRANT syncrese_definer TO syncrese_owner;
      ALTER SCHEMA public OWNER TO syncrese_owner;
      GRANT USAGE ON SCHEMA public TO syncrese_app;
    `)

    const files = await migrationFiles()
    const failures: string[] = []

    for (const file of files) {
      try {
        // SET ROLE and RESET wrap each file rather than the whole run, so a
        // migration that leaves the session role changed cannot mask the next.
        await client.exec(`SET ROLE syncrese_owner;\n${file.sql}\nRESET ROLE;`)
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`)
        await client.exec('RESET ROLE')
        break
      }
    }

    expect(
      failures,
      'A migration that only works as a superuser will pass every other test in this ' +
        'suite and fail on the first real deployment:\n  ' + failures.join('\n  '),
    ).toEqual([])
  })

  it('seeds the platform roles and permissions despite the RLS policy on roles', async () => {
    client = new PGlite()
    await client.exec(`
      CREATE ROLE syncrese_app     NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE syncrese_owner   NOSUPERUSER NOBYPASSRLS;
      -- Provisioning creates this and grants the owner membership of it, so the
      -- owner can hand it the SECURITY DEFINER functions.
      CREATE ROLE syncrese_definer NOSUPERUSER NOBYPASSRLS NOLOGIN;
      GRANT syncrese_definer TO syncrese_owner;
      ALTER SCHEMA public OWNER TO syncrese_owner;
      GRANT USAGE ON SCHEMA public TO syncrese_app;
    `)

    for (const file of await migrationFiles()) {
      await client.exec(`SET ROLE syncrese_owner;\n${file.sql}\nRESET ROLE;`)
    }

    // The rows are the point: a migration that "succeeds" while inserting
    // nothing leaves an installation where nobody can be given a role.
    const roles = await client.query<{ n: number }>(
      `select count(*)::int as n from roles where organization_id is null`,
    )
    expect(roles.rows[0]!.n).toBe(5)

    const grants = await client.query<{ n: number }>(
      `select count(*)::int as n from role_permissions`,
    )
    expect(grants.rows[0]!.n).toBeGreaterThan(50)

    const perms = await client.query<{ n: number }>(`select count(*)::int as n from permissions`)
    expect(perms.rows[0]!.n).toBeGreaterThan(20)
  })

  it('leaves FORCE row level security switched back on everywhere', async () => {
    // Seeding a policed table means lifting FORCE around the insert. Lifting it
    // and forgetting to restore it would silently exempt the table owner from
    // tenant isolation for good — which is the exact hole FORCE exists to
    // close, and nothing else in the suite would notice.
    client = new PGlite()
    await client.exec(`
      CREATE ROLE syncrese_app     NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE syncrese_owner   NOSUPERUSER NOBYPASSRLS;
      -- Provisioning creates this and grants the owner membership of it, so the
      -- owner can hand it the SECURITY DEFINER functions.
      CREATE ROLE syncrese_definer NOSUPERUSER NOBYPASSRLS NOLOGIN;
      GRANT syncrese_definer TO syncrese_owner;
      ALTER SCHEMA public OWNER TO syncrese_owner;
      GRANT USAGE ON SCHEMA public TO syncrese_app;
    `)

    for (const file of await migrationFiles()) {
      await client.exec(`SET ROLE syncrese_owner;\n${file.sql}\nRESET ROLE;`)
    }

    const unforced = await client.query<{ relname: string }>(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relrowsecurity
        and not c.relforcerowsecurity
      order by c.relname
    `)

    expect(unforced.rows.map((r) => r.relname)).toEqual([])
  })

  it('the SECURITY DEFINER functions still see rows as a non-superuser owner', async () => {
    /**
     * The gap that let a production-breaking bug through.
     *
     * RLS applies to whoever the CURRENT USER is, and in a SECURITY DEFINER
     * function that is the function's OWNER. FORCE ROW LEVEL SECURITY exists
     * precisely to subject the table owner to the policies. So a function owned
     * by `syncrese_owner` reading a FORCE'd table with no tenant scope set —
     * which is what EVERY pre-tenant lookup here does — returned zero rows on a
     * real deployment. Sign-in, API keys, invitations, Stripe webhooks and
     * product keys were all broken, and nothing showed it, because PGlite
     * connects as a superuser and superusers bypass RLS unconditionally.
     *
     * Applying the migrations was never the hard part. CALLING the functions
     * afterwards, as the application role, is.
     */
    client = new PGlite()
    await client.exec(`
      CREATE ROLE syncrese_app     NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE syncrese_owner   NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE syncrese_definer NOSUPERUSER NOBYPASSRLS NOLOGIN;
      GRANT syncrese_definer TO syncrese_owner;
      ALTER SCHEMA public OWNER TO syncrese_owner;
      GRANT USAGE ON SCHEMA public TO syncrese_app;
    `)

    for (const file of await migrationFiles()) {
      await client.exec(`SET ROLE syncrese_owner;\n${file.sql}\nRESET ROLE;`)
    }

    // A tenant with one member, inserted as the superuser so the fixture itself
    // is not what is under test.
    const orgId = '00000000-0000-0000-0000-0000000000b1'
    const userId = '00000000-0000-0000-0000-0000000000b2'
    await client.exec(`
      insert into organizations (id, slug, name, base_currency)
      values ('${orgId}', 'definer-test', 'Definer Test GmbH', 'EUR');

      insert into licenses (id, organization_id, plan, seat_count, status)
      values (gen_random_uuid(), '${orgId}', 'starter', 5, 'active');

      insert into users (id, email, name, status)
      values ('${userId}', 'definer@test.example', 'Definer Test', 'active');

      insert into memberships (id, organization_id, user_id, role_id, status)
      values (gen_random_uuid(), '${orgId}', '${userId}',
              (select id from roles where key = 'owner' and organization_id is null), 'active');
    `)

    // Everything below runs as the APPLICATION role with NO tenant scope — the
    // exact conditions of a sign-in, a webhook, or an invitation link.
    await client.exec('SET ROLE syncrese_app')

    const memberships = await client.query<{ organization_id: string }>(
      `select organization_id from public.user_organizations('${userId}'::uuid)`,
    )
    expect(
      memberships.rows,
      'user_organizations returned nothing — nobody can sign in',
    ).toHaveLength(1)
    expect(memberships.rows[0]!.organization_id).toBe(orgId)

    const slug = await client.query<{ taken: boolean }>(
      `select public.organization_slug_taken('definer-test') as taken`,
    )
    expect(slug.rows[0]!.taken, 'slug collisions would go undetected').toBe(true)

    const admin = await client.query<{ ok: boolean }>(
      `select public.is_platform_admin('${userId}'::uuid) as ok`,
    )
    expect(admin.rows[0]!.ok).toBe(false)

    // A write through a definer function, into a table with RLS and no policy
    // of its own.
    const claimed = await client.query<{ claimed: boolean }>(
      `select public.claim_billing_event('evt_definer', 'test', now(), '{}'::jsonb) as claimed`,
    )
    expect(claimed.rows[0]!.claimed, 'webhook idempotency is broken').toBe(true)

    const throttle = await client.query<{ allowed: boolean }>(
      `select public.consume_signin_attempt('probe', 5, '15 minutes'::interval) as allowed`,
    )
    expect(throttle.rows[0]!.allowed, 'the sign-in throttle is broken').toBe(true)

    await client.exec('RESET ROLE')
  })

  it('does not let the application role itself past the policies', async () => {
    // The other half: the exemption must be scoped to the definer role alone.
    // A permissive policy applying to everyone would "fix" the functions by
    // switching tenant isolation off.
    client = new PGlite()
    await client.exec(`
      CREATE ROLE syncrese_app     NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE syncrese_owner   NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE syncrese_definer NOSUPERUSER NOBYPASSRLS NOLOGIN;
      GRANT syncrese_definer TO syncrese_owner;
      ALTER SCHEMA public OWNER TO syncrese_owner;
      GRANT USAGE ON SCHEMA public TO syncrese_app;
    `)
    for (const file of await migrationFiles()) {
      await client.exec(`SET ROLE syncrese_owner;\n${file.sql}\nRESET ROLE;`)
    }

    await client.exec(`
      insert into organizations (id, slug, name, base_currency)
      values ('00000000-0000-0000-0000-0000000000c1', 'confined', 'Confined GmbH', 'EUR')
    `)

    await client.exec('SET ROLE syncrese_app')
    const unscoped = await client.query<{ n: number }>(
      `select count(*)::int as n from organizations`,
    )
    expect(unscoped.rows[0]!.n, 'the application role can read across tenants').toBe(0)
    await client.exec('RESET ROLE')
  })

  it('seeds document sequences for a tenant created before the migration ran', async () => {
    // The backfill case. A migration that adds a document series must give it
    // to organizations that ALREADY EXIST — `next_document_number` raises
    // SYNC_SEQUENCE_MISSING when the row is absent, so a tenant provisioned
    // last year would find its first credit note refused.
    client = new PGlite()
    await client.exec(`
      CREATE ROLE syncrese_app     NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE syncrese_owner   NOSUPERUSER NOBYPASSRLS;
      -- Provisioning creates this and grants the owner membership of it, so the
      -- owner can hand it the SECURITY DEFINER functions.
      CREATE ROLE syncrese_definer NOSUPERUSER NOBYPASSRLS NOLOGIN;
      GRANT syncrese_definer TO syncrese_owner;
      ALTER SCHEMA public OWNER TO syncrese_owner;
      GRANT USAGE ON SCHEMA public TO syncrese_app;
    `)

    const files = await migrationFiles()
    const backfilled = files.filter((f) => f.name >= '0014')
    const earlier = files.filter((f) => f.name < '0014')

    for (const file of earlier) {
      await client.exec(`SET ROLE syncrese_owner;\n${file.sql}\nRESET ROLE;`)
    }

    // A tenant that exists before 0014 is applied. Inserted as the superuser,
    // standing in for a real organization created months earlier.
    await client.exec(`
      insert into organizations (id, slug, name, base_currency)
      values ('00000000-0000-0000-0000-0000000000aa', 'legacy', 'Legacy Co', 'EUR')
    `)

    for (const file of backfilled) {
      await client.exec(`SET ROLE syncrese_owner;\n${file.sql}\nRESET ROLE;`)
    }

    const seq = await client.query<{ sequence_key: string }>(
      `select sequence_key from document_sequences
        where organization_id = '00000000-0000-0000-0000-0000000000aa'
          and sequence_key like 'credit_note%'
        order by sequence_key`,
    )
    expect(seq.rows.map((r) => r.sequence_key)).toEqual(['credit_note_ap', 'credit_note_ar'])
  })
})
