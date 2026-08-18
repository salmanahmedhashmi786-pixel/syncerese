import '../src/lib/load-env'
import { Client } from 'pg'

/**
 * Grants or revokes platform administration.
 *
 *   npm run admin:grant  -- someone@example.com
 *   npm run admin:grant  -- someone@example.com --revoke
 *   npm run admin:grant  -- --list
 *
 * COMMAND LINE ONLY, deliberately. A platform admin can see every organization
 * on the installation and issue licences for any of them. Somebody who could
 * appoint another platform admin through a browser would put the whole
 * installation one XSS or one stolen session away from compromise.
 *
 * IT NEEDS DATABASE_ADMIN_URL, AND THAT IS THE POINT.
 *
 * `platform_admins` (drizzle/0017) has RLS with FORCE and NO POLICY AT ALL. The
 * application role has no grant on it, and `syncrese_owner` — which owns the
 * table — is subject to its own policies because of FORCE, so with no policy it
 * reads and writes nothing either. The only thing that can touch this table is
 * a role with BYPASSRLS: the administrative connection from your provider, used
 * once at provisioning and otherwise held by nothing.
 *
 * That is a stronger bar than "shell access". Appointing a platform
 * administrator takes the database's own admin credential, not merely a
 * foothold on a machine that can reach the database as the application.
 *
 * This script used to connect as the application role, which could only ever
 * work where RLS was not really being enforced — locally, where the connection
 * is a superuser that drops to the app role. Against provisioned Postgres it
 * answered `permission denied for table platform_admins`, which reads like a
 * misconfiguration and is actually the isolation model doing its job.
 */

const args = process.argv.slice(2)
const list = args.includes('--list')
const revoke = args.includes('--revoke')
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase()

async function run(c: Client): Promise<void> {
  if (list) {
    const { rows } = await c.query<{ email: string; granted_at: Date }>(
      `select u.email, a.granted_at
         from platform_admins a join users u on u.id = a.user_id
        order by u.email`,
    )
    if (rows.length === 0) {
      console.log('No platform administrators.\n')
      console.log('Nobody can reach /admin until one is granted:')
      console.log('  npm run admin:grant -- you@example.com')
      return
    }
    console.log(`${rows.length} platform administrator(s):`)
    for (const r of rows) {
      console.log(`  ${r.email}  (since ${new Date(r.granted_at).toISOString().slice(0, 10)})`)
    }
    return
  }

  if (!email) {
    console.error('Usage: npm run admin:grant -- <email> [--revoke]')
    console.error('       npm run admin:grant -- --list')
    process.exitCode = 1
    return
  }

  const found = await c.query<{ id: string; name: string | null }>(
    `select id, name from users where email = $1`,
    [email],
  )
  const user = found.rows[0]
  if (!user) {
    console.error(`No account with the address ${email}.`)
    console.error('They have to sign up or accept an invitation first.')
    process.exitCode = 1
    return
  }

  if (revoke) {
    await c.query(`delete from platform_admins where user_id = $1::uuid`, [user.id])
    console.log(`Revoked platform administration from ${email}.`)
    return
  }

  await c.query(
    `insert into platform_admins (user_id, note) values ($1::uuid, $2)
     on conflict (user_id) do nothing`,
    [user.id, `granted via CLI on ${new Date().toISOString().slice(0, 10)}`],
  )
  console.log(`${email} (${user.name ?? 'no name'}) is now a platform administrator.`)
  console.log('They can reach /admin to issue product keys.')
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL
  if (!url) {
    console.error('DATABASE_ADMIN_URL is not set.')
    console.error('')
    console.error('Platform administration lives in a table only a BYPASSRLS role can reach —')
    console.error('see the note at the top of this file. Put your provider\u2019s administrative')
    console.error('connection string in .env.vercel as DATABASE_ADMIN_URL; it is the same one')
    console.error('`npm run db:provision` used.')
    process.exitCode = 1
    return
  }

  const c = new Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true },
  })
  await c.connect()
  try {
    await run(c)
  } finally {
    await c.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
