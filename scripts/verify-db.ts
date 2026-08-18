import '../src/lib/load-env'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'

/**
 * Post-deploy database posture check.
 *
 * The test suite proves the migrations produce a safe schema. This proves the
 * DEPLOYED database actually is that schema, connected to by the role we think
 * it is — which is a different claim, and the one that matters.
 *
 * Everything checked here is invisible from inside the application. A
 * connection that turns out to be a superuser reads and writes exactly the same
 * as a correct one, right up until it returns another tenant's invoice. There
 * is no runtime symptom to notice; this script is the noticing.
 *
 *   npm run db:verify
 *
 * Run it after every migration and after any change to database credentials.
 */

type Check = { name: string; ok: boolean; detail: string }

const checks: Check[] = []
const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

/** Tables the application must never be able to rewrite. */
const APPEND_ONLY = ['audit_log', 'access_log']

async function main() {
  const appUrl = process.env.DATABASE_URL
  if (!appUrl) throw new Error('DATABASE_URL is not set — nothing to verify.')

  const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true }
  const app = new Client({ connectionString: appUrl, ssl })
  await app.connect()

  try {
    await roleChecks(app)
    await rlsChecks(app)
    await grantChecks(app)
    await migrationChecks(app)
    await liveIsolationCheck(app)
  } finally {
    await app.end()
  }

  const failed = checks.filter((c) => !c.ok)

  for (const c of checks) {
    console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}\n        ${c.detail}`)
  }

  console.log()
  if (failed.length > 0) {
    console.error(`${failed.length} of ${checks.length} checks FAILED. Do not send traffic here.`)
    process.exit(1)
  }
  console.log(`All ${checks.length} checks passed.`)
}

/** Who are we, really. */
async function roleChecks(app: Client) {
  const { rows } = await app.query<{
    role: string
    superuser: boolean
    bypassrls: boolean
    createrole: boolean
    createdb: boolean
  }>(`
    select current_user as role,
           rolsuper     as superuser,
           rolbypassrls as bypassrls,
           rolcreaterole as createrole,
           rolcreatedb  as createdb
    from pg_roles where rolname = current_user
  `)
  const me = rows[0]!

  add(
    'application role is not a superuser',
    !me.superuser,
    me.superuser
      ? `connected as "${me.role}", which is a SUPERUSER — every RLS policy is bypassed`
      : `connected as "${me.role}"`,
  )

  // The one that gets missed: BYPASSRLS is not superuser, looks harmless in a
  // role listing, and disables tenant isolation just as completely.
  add(
    'application role does not have BYPASSRLS',
    !me.bypassrls,
    me.bypassrls ? `"${me.role}" has BYPASSRLS — tenant isolation is off` : 'no BYPASSRLS',
  )

  add(
    'application role cannot create roles or databases',
    !me.createrole && !me.createdb,
    me.createrole || me.createdb
      ? `"${me.role}" can ${[me.createrole && 'CREATEROLE', me.createdb && 'CREATEDB']
          .filter(Boolean)
          .join(' and ')} — it could grant itself a way around the policies`
      : 'no CREATEROLE, no CREATEDB',
  )

  // Table owners bypass RLS unless FORCE is set. FORCE is set (checked below),
  // but the app connecting as the owner would also mean it can ALTER the
  // policies away.
  const owned = await app.query<{ n: string }>(`
    select count(*) as n from pg_tables
    where schemaname = 'public' and tableowner = current_user
  `)
  add(
    'application role does not own the tables',
    owned.rows[0]!.n === '0',
    owned.rows[0]!.n === '0'
      ? 'schema is owned by a different role'
      : `owns ${owned.rows[0]!.n} table(s) — it can drop the RLS policies protecting them`,
  )

  // The definer role, and whether the functions actually reached it.
  //
  // A SECURITY DEFINER function runs as its OWNER, and FORCE ROW LEVEL SECURITY
  // subjects the table owner to the policies — so a function still owned by
  // syncrese_owner reads NOTHING from a policed table with no tenant scope set.
  // That is every pre-tenant lookup in this system: sign-in, API keys,
  // invitations, Stripe webhooks, product keys. It fails silently and totally,
  // and no test that connects as a superuser can see it.
  const definer = await app.query<{ canlogin: boolean; bypass: boolean }>(`
    select rolcanlogin as canlogin, rolbypassrls as bypass
    from pg_roles where rolname = 'syncrese_definer'
  `)
  const definerRow = definer.rows[0]

  add(
    'the SECURITY DEFINER owner role exists and cannot log in',
    Boolean(definerRow) && !definerRow!.canlogin && !definerRow!.bypass,
    !definerRow
      ? 'syncrese_definer is missing — every pre-tenant lookup returns nothing. Run `npm run db:provision`.'
      : definerRow.canlogin
        ? 'syncrese_definer can LOG IN. Nothing should ever connect as it.'
        : definerRow.bypass
          ? 'syncrese_definer has BYPASSRLS — the exemption is meant to be a policy, not a blanket'
          : 'present, NOLOGIN, no BYPASSRLS',
  )

  const misowned = await app.query<{ name: string }>(`
    select p.proname as name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    where n.nspname = 'public' and p.prosecdef and r.rolname <> 'syncrese_definer'
    order by p.proname
  `)
  add(
    'every SECURITY DEFINER function is owned by that role',
    misowned.rows.length === 0,
    misowned.rows.length === 0
      ? 'all reassigned'
      : `still owned by another role, so these read nothing: ${misowned.rows
          .map((r) => r.name)
          .join(', ')}`,
  )

  const canCreate = await app.query<{ allowed: boolean }>(
    `select has_schema_privilege(current_user, 'public', 'CREATE') as allowed`,
  )
  add(
    'application role cannot create objects in public',
    !canCreate.rows[0]!.allowed,
    canCreate.rows[0]!.allowed
      ? 'has CREATE on schema public — it can shadow a table a SECURITY DEFINER function trusts'
      : 'no CREATE on schema public',
  )
}

/** Every tenant table protected, and protected with FORCE. */
async function rlsChecks(app: Client) {
  const { rows } = await app.query<{
    table_name: string
    enabled: boolean
    forced: boolean
    policies: number
  }>(`
    select c.relname as table_name,
           c.relrowsecurity as enabled,
           c.relforcerowsecurity as forced,
           (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and exists (
        select 1 from information_schema.columns col
        where col.table_schema = 'public'
          and col.table_name = c.relname
          and col.column_name = 'organization_id'
      )
    order by c.relname
  `)

  add(
    'tenant tables were found',
    rows.length > 0,
    `${rows.length} table(s) carry organization_id`,
  )

  const unprotected = rows.filter((r) => !r.enabled || r.policies === 0)
  add(
    'every tenant table has RLS enabled with a policy',
    unprotected.length === 0,
    unprotected.length === 0
      ? `${rows.length} table(s) protected`
      : `unprotected: ${unprotected.map((r) => r.table_name).join(', ')}`,
  )

  // ENABLE without FORCE protects everyone except the table owner — which is
  // precisely who runs migrations, back-office queries and any admin tool
  // someone points at this database later.
  const unforced = rows.filter((r) => r.enabled && !r.forced)
  add(
    'every tenant table FORCEs row level security',
    unforced.length === 0,
    unforced.length === 0
      ? 'FORCE set everywhere'
      : `enabled but not forced (the owner bypasses these): ${unforced
          .map((r) => r.table_name)
          .join(', ')}`,
  )

  // `organizations` is scoped on id rather than organization_id, so the query
  // above does not see it. It is the tenant root — missing it would be total.
  const orgs = await app.query<{ enabled: boolean; forced: boolean; policies: number }>(`
    select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
           (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'organizations'
  `)
  const o = orgs.rows[0]
  add(
    'organizations itself is protected',
    Boolean(o?.enabled && o.forced && o.policies > 0),
    o ? `enabled=${o.enabled} forced=${o.forced} policies=${o.policies}` : 'table not found',
  )
}

/** The audit trail must be append-only to the application. */
async function grantChecks(app: Client) {
  for (const table of APPEND_ONLY) {
    const { rows } = await app.query<{ upd: boolean; del: boolean; trunc: boolean; ins: boolean }>(
      `select has_table_privilege(current_user, $1, 'UPDATE')   as upd,
              has_table_privilege(current_user, $1, 'DELETE')   as del,
              has_table_privilege(current_user, $1, 'TRUNCATE') as trunc,
              has_table_privilege(current_user, $1, 'INSERT')   as ins`,
      [`public.${table}`],
    )
    const p = rows[0]!
    add(
      `${table} is append-only to the application`,
      !p.upd && !p.del && !p.trunc && p.ins,
      !p.upd && !p.del && !p.trunc
        ? 'INSERT and SELECT only'
        : `holds ${[p.upd && 'UPDATE', p.del && 'DELETE', p.trunc && 'TRUNCATE']
            .filter(Boolean)
            .join(', ')} — application code could rewrite history`,
    )
  }
}

/** The schema on disk is the schema that is deployed. */
async function migrationChecks(app: Client) {
  const dir = path.resolve(process.cwd(), 'drizzle')
  const onDisk = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  const { rows } = await app.query<{ filename: string }>(
    `select filename from __drizzle_migrations order by filename`,
  )
  const applied = new Set(rows.map((r) => r.filename))
  const missing = onDisk.filter((f) => !applied.has(f))

  add(
    'every migration on disk is applied',
    missing.length === 0,
    missing.length === 0
      ? `${applied.size} migration(s) applied`
      : `not applied: ${missing.join(', ')} — run \`npm run db:migrate\``,
  )

  // The reverse: a database ahead of the code means a rollback left the schema
  // in front of the application, which fails in far stranger ways.
  const extra = [...applied].filter((f) => !onDisk.includes(f))
  add(
    'the database is not ahead of this checkout',
    extra.length === 0,
    extra.length === 0 ? 'in step' : `applied but not present here: ${extra.join(', ')}`,
  )
}

/**
 * The end-to-end proof.
 *
 * Not "is the policy defined" but "does a query without tenant scope actually
 * return nothing". Every check above could pass while some grant, role
 * inheritance or search_path quirk still lets rows through.
 */
async function liveIsolationCheck(app: Client) {
  // EVERY QUERY HERE RUNS INSIDE ONE EXPLICIT TRANSACTION.
  //
  // `set_config(key, value, true)` is transaction-LOCAL, and node-postgres runs
  // each query in its own implicit transaction, so a scope set by one statement
  // is already gone by the next. This check used to set `app.org_id`, query in a
  // fresh transaction where it no longer existed, see zero rows and report that
  // isolation was broken.
  //
  // It never fired, because it only reaches that branch once an organization
  // exists — and until the first real signup it took the "skipped, no
  // organizations yet" path and reported OK. A check that passes for years and
  // then fails the first time it has something to check is worse than no check.
  //
  // The application was always right: `withTenant` opens a real transaction and
  // sets the scope inside it. This now does the same thing.
  await app.query('BEGIN')
  try {
    await app.query(`select set_config('app.org_id', '', true)`)
    const { rows } = await app.query<{ n: string }>(`select count(*) as n from organizations`)
    add(
      'an unscoped query returns nothing',
      rows[0]!.n === '0',
      rows[0]!.n === '0'
        ? 'a query with no app.org_id sees zero rows, as it must'
        : `returned ${rows[0]!.n} organization(s) with NO tenant scope set — isolation is not working`,
    )

    // Not vacuous: with a scope set to an id that exists, the row comes back. A
    // database that returned nothing for everything would pass the check above
    // while being equally broken.
    const known = await app.query<{ id: string | null }>(
      // Through the SECURITY DEFINER function, which is reachable with no scope.
      `select organization_id as id from public.user_organizations(
         (select id from users limit 1)) limit 1`,
    )
    const id = known.rows[0]?.id
    if (!id) {
      add(
        'isolation check is not vacuous',
        true,
        'skipped — the database has no organizations yet (expected before the first signup)',
      )
      return
    }

    await app.query(`select set_config('app.org_id', $1, true)`, [id])
    const scoped = await app.query<{ n: string }>(`select count(*) as n from organizations`)
    add(
      'isolation check is not vacuous',
      scoped.rows[0]!.n === '1',
      scoped.rows[0]!.n === '1'
        ? 'with a tenant scope set, exactly that tenant is visible'
        : `expected 1 organization with scope set, saw ${scoped.rows[0]!.n}`,
    )
  } finally {
    // Read-only throughout; roll back so nothing here can leave a mark.
    await app.query('ROLLBACK')
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
