import '../src/lib/load-env'
import { Client } from 'pg'

/**
 * One-time database provisioning, over a plain Postgres connection.
 *
 * The same statements as scripts/provision-db.sql, without needing `psql`
 * installed — which matters, because the machine that has the Neon dashboard
 * open is usually not the machine with Postgres client tools on it.
 *
 *   DATABASE_ADMIN_URL=… SYNCRESE_OWNER_PASSWORD=… SYNCRESE_APP_PASSWORD=… \
 *     npm run db:provision
 *
 * Safe to re-run. Every statement is idempotent, which matters more than it
 * sounds: a database restored from a dump does NOT necessarily carry role
 * attributes, schema ownership or REVOKEs, so re-running this is how a restored
 * database gets its safety properties back.
 *
 * WHAT THIS SETS UP, AND WHY IT IS NOT OPTIONAL
 *
 * Four roles. The admin role you connect with here, `syncrese_owner` which owns
 * the schema and runs migrations, `syncrese_app` which is what the application
 * connects as — owning nothing, altering nothing, and without BYPASSRLS — and
 * `syncrese_definer`, which logs in nowhere and exists only to own the SECURITY
 * DEFINER functions (see drizzle/0019 for why that separation is load-bearing).
 *
 * Collapsing those into one role disables tenant isolation completely, and
 * every test still passes, and the application behaves identically, right up
 * until a query returns another tenant's invoices.
 */

const ADMIN_URL = process.env.DATABASE_ADMIN_URL
const OWNER_PASSWORD = process.env.SYNCRESE_OWNER_PASSWORD
const APP_PASSWORD = process.env.SYNCRESE_APP_PASSWORD

/** Extensions worth having, each optional. Neon has both; some managed
 *  providers restrict pg_trgm, and the search migrations already degrade
 *  gracefully without it. */
const EXTENSIONS = ['pgcrypto', 'pg_trgm']

async function main() {
  if (!ADMIN_URL) {
    fail(
      'DATABASE_ADMIN_URL is not set.\n\n' +
        'This is the ADMINISTRATIVE connection string from your provider — for Neon, the\n' +
        'one for the default `neondb_owner` role. It is used once, here, and then never\n' +
        'again: neither the application nor the migration job ever receives it.',
    )
  }
  if (!OWNER_PASSWORD || !APP_PASSWORD) {
    fail(
      'SYNCRESE_OWNER_PASSWORD and SYNCRESE_APP_PASSWORD must both be set.\n\n' +
        'Run `npm run gen:secrets` first — it generates them along with the rest and\n' +
        'writes them to .env.vercel.',
    )
  }
  if (OWNER_PASSWORD === APP_PASSWORD) {
    fail(
      'SYNCRESE_OWNER_PASSWORD and SYNCRESE_APP_PASSWORD are identical.\n\n' +
        'The separation between the role that can alter schema and the role the\n' +
        'application runs as is the point. One password for both throws it away.',
    )
  }

  const client = new Client({
    connectionString: ADMIN_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true },
  })

  await client.connect()
  console.log(`connected to ${redact(ADMIN_URL)}\n`)

  try {
    const database = (await client.query<{ db: string }>('select current_database() as db')).rows[0]!
      .db

    // --- roles -------------------------------------------------------------
    await step('create the syncrese_owner role', async () => {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_owner') THEN
            CREATE ROLE syncrese_owner LOGIN;
          END IF;
        END $$
      `)
    })

    await step('create the syncrese_definer role', async () => {
      // Owns the SECURITY DEFINER functions. NOLOGIN — nothing connects as it.
      //
      // It exists because RLS applies to whoever the CURRENT USER is, and in a
      // SECURITY DEFINER function that is the function's OWNER. FORCE ROW LEVEL
      // SECURITY subjects the table owner to the policies, so a function owned
      // by syncrese_owner reading a policed table with no tenant scope returns
      // nothing — which broke sign-in, API keys, invitations and webhooks on a
      // real database while every test passed. Migration 0019 hands the
      // functions to this role and gives it one explicit exemption policy.
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_definer') THEN
            CREATE ROLE syncrese_definer NOLOGIN;
          END IF;
        END $$
      `)
      // The owner needs membership to hand the functions over.
      await client.query('GRANT syncrese_definer TO syncrese_owner')
    })

    await step('create the syncrese_app role', async () => {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_app') THEN
            CREATE ROLE syncrese_app LOGIN;
          END IF;
        END $$
      `)
    })

    // ALTER ROLE accepts no bind parameter for the password, and a DO block
    // accepts none either. So the statement is BUILT by the server —
    // `format(%L)` does the quoting — and then executed. A password containing
    // a quote would otherwise be an injection carrying schema-owner privilege,
    // and passwords are exactly the strings people paste in from elsewhere.
    await step('set the role passwords', async () => {
      for (const [role, password] of [
        ['syncrese_owner', OWNER_PASSWORD],
        ['syncrese_app', APP_PASSWORD],
      ] as const) {
        const built = await client.query<{ stmt: string }>(
          `select format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) as stmt`,
          [role, password],
        )
        await client.query(built.rows[0]!.stmt)
      }
    })

    // Explicit even where it is already the default. A role restored from a
    // dump, or created by an earlier version of this script, may carry either
    // attribute — and both defeat every RLS policy in the schema.
    //
    // MANAGED POSTGRES CANNOT RUN THE ALTER. On Neon the administrative role is
    // not a superuser, and `ALTER ROLE ... NOSUPERUSER` is refused outright with
    // "permission denied to alter role" — so this step used to end provisioning
    // on the provider the deployment guide recommends.
    //
    // What actually matters is the STATE, not the statement. `CREATE ROLE`
    // already defaults to all four, so on a fresh managed database the roles
    // arrive correct and the ALTER is a re-assertion. Where the re-assertion is
    // forbidden, verify instead — and fail just as loudly if the attributes are
    // genuinely wrong, because then no amount of retrying will fix it from here
    // and the database is not safe to run this application on.
    await step('strip privileges that would bypass tenant isolation', async () => {
      const ROLES = ['syncrese_app', 'syncrese_definer', 'syncrese_owner'] as const
      try {
        for (const role of ROLES) {
          await client.query(
            `ALTER ROLE ${role} NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB`,
          )
        }
      } catch (err) {
        const denied =
          err instanceof Error && /permission denied to alter role/i.test(err.message)
        if (!denied) throw err

        const { rows } = await client.query<{
          rolname: string
          rolsuper: boolean
          rolbypassrls: boolean
          rolcreaterole: boolean
          rolcreatedb: boolean
        }>(
          `select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
             from pg_roles where rolname = any($1::text[])`,
          [[...ROLES]],
        )

        const who = await client.query<{ user: string }>(`select current_user as "user"`)

        const wrong = rows.filter(
          (r) => r.rolsuper || r.rolbypassrls || r.rolcreaterole || r.rolcreatedb,
        )
        if (wrong.length > 0) {
          throw new Error(
            `This database will not let ${who.rows[0]!.user} alter roles, and these ` +
              `already carry a privilege that defeats tenant isolation: ` +
              wrong
                .map(
                  (r) =>
                    `${r.rolname}(${[
                      r.rolsuper && 'SUPERUSER',
                      r.rolbypassrls && 'BYPASSRLS',
                      r.rolcreaterole && 'CREATEROLE',
                      r.rolcreatedb && 'CREATEDB',
                    ]
                      .filter(Boolean)
                      .join(' ')})`,
                )
                .join(', ') +
              `. Drop them and re-run, or fix them from an account that can.`,
          )
        }

        const missing = ROLES.filter((r) => !rows.some((row) => row.rolname === r))
        if (missing.length > 0) {
          throw new Error(`Expected roles are missing after creation: ${missing.join(', ')}`)
        }
      }
    })

    // --- schema ------------------------------------------------------------
    await step('give schema ownership to syncrese_owner', async () => {
      // Postgres will not let you hand an object to a role you are not a member
      // of — "must be able to SET ROLE" — and on a superuser cluster that never
      // comes up, because superusers are implicitly members of everything.
      //
      // On managed Postgres the administrative role is not a superuser, so the
      // membership has to be asked for. It is granted to whoever is running
      // this script, which is the account that just created these roles and is
      // about to stop being used at all.
      const who = await client.query<{ user: string }>(`select current_user as "user"`)
      const admin = who.rows[0]!.user
      const built = await client.query<{ stmt: string }>(
        `select format('GRANT syncrese_owner TO %I', $1::text) as stmt`,
        [admin],
      )
      await client.query(built.rows[0]!.stmt)

      await client.query(`ALTER SCHEMA public OWNER TO syncrese_owner`)
    })

    await step(
      'lock down schema public',
      async () => {
        // Postgres 15+ revokes this by default; restored dumps and older
        // clusters do not. Without it the application role could create a table
        // that shadows one a SECURITY DEFINER function trusts, and inherit that
        // function's privileges.
        await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
        await client.query(`REVOKE ALL   ON SCHEMA public FROM syncrese_app`)
        await client.query(`GRANT  USAGE ON SCHEMA public TO   syncrese_app`)
      },
      // Optional because Postgres 15+ is already in this state. db:verify
      // checks the OUTCOME ("can the app role create objects in public?")
      // rather than trusting that this ran.
      true,
    )

    await step('grant CONNECT to the two roles', async () => {
      await client.query(
        `DO $$ BEGIN
           EXECUTE format('GRANT CONNECT ON DATABASE %I TO syncrese_app, syncrese_owner',
                          current_database());
         END $$`,
      )
    })

    // --- extensions --------------------------------------------------------
    for (const ext of EXTENSIONS) {
      await step(
        `enable ${ext}`,
        async () => {
          await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`)
        },
        // Both are optional. pg_trgm in particular is unavailable on some
        // providers, and the search migration already builds its index inside
        // an exception handler for exactly that reason.
        true,
      )
    }

    // --- confirm -----------------------------------------------------------
    console.log()
    const { rows } = await client.query<{
      rolname: string
      rolsuper: boolean
      rolbypassrls: boolean
      rolcreaterole: boolean
    }>(`
      SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
      FROM pg_roles
      WHERE rolname IN ('syncrese_owner', 'syncrese_app', 'syncrese_definer')
      ORDER BY rolname
    `)

    let unsafe = false
    for (const r of rows) {
      const bad = r.rolsuper || r.rolbypassrls || r.rolcreaterole
      if (bad) unsafe = true
      console.log(
        `${bad ? 'FAIL' : 'ok  '}  ${r.rolname.padEnd(15)} ` +
          `superuser=${r.rolsuper}  bypassrls=${r.rolbypassrls}  createrole=${r.rolcreaterole}`,
      )
    }

    if (rows.length !== 3 || unsafe) {
      fail(
        '\nThe roles do not have safe attributes. Your provider may be forcing them —\n' +
          'if the attributes cannot be removed, this application cannot run safely on it.',
      )
    }

    console.log(`\nProvisioned. Connection strings for ${database}:\n`)
    console.log(`  DATABASE_MIGRATION_URL = ${connectionFor(ADMIN_URL, 'syncrese_owner', OWNER_PASSWORD)}`)
    console.log(`  DATABASE_URL           = ${connectionFor(ADMIN_URL, 'syncrese_app', APP_PASSWORD)}`)
    console.log(
      '\nNext:\n' +
        '  1. npm run db:migrate      (with DATABASE_MIGRATION_URL set)\n' +
        '  2. npm run db:verify       (with DATABASE_URL set)\n',
    )
  } finally {
    await client.end()
  }
}

/** Rebuilds the provider's connection string with different credentials,
 *  preserving host, database and every query parameter (Neon puts
 *  `sslmode=require` and its endpoint id there, and dropping them breaks the
 *  connection in ways that look like a password problem). */
function connectionFor(template: string, user: string, password: string): string {
  const url = new URL(template)
  url.username = encodeURIComponent(user)
  url.password = encodeURIComponent(password)
  return url.toString()
}

function redact(url: string): string {
  try {
    const u = new URL(url)
    u.password = '***'
    return u.toString()
  } catch {
    return '(unparseable connection string)'
  }
}

/**
 * Runs one provisioning statement.
 *
 * `optional: true` means a provider that refuses it does not stop the
 * deployment — the extensions, and the hardening REVOKEs that Postgres 15+
 * already applies by default. Everything else is load-bearing: if the role
 * attributes or schema ownership cannot be set, continuing would produce a
 * database that looks provisioned and is not.
 */
async function step(label: string, fn: () => Promise<void>, optional = false) {
  try {
    await fn()
    console.log(`ok    ${label}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (optional) {
      console.log(`SKIP  ${label}\n        ${message}`)
      return
    }
    console.error(`FAIL  ${label}\n        ${message}`)
    throw err
  }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
