import '../src/lib/load-env'
import { sql } from 'drizzle-orm'
import { db, closeDb } from '../src/db'
import { asPlatformAdmin } from '../src/db/tenant'

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
 * installation one XSS or one stolen session away from compromise; requiring
 * shell access to the deployment raises that bar to something meaningful.
 *
 * Runs through `asPlatformAdmin`, which refuses to execute from a request path.
 */

const args = process.argv.slice(2)
const list = args.includes('--list')
const revoke = args.includes('--revoke')
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase()

async function main() {
  const handle = await db()

  await asPlatformAdmin(handle, async (tx) => {
    if (list) {
      const res = await tx.execute(sql`
        select u.email, a.granted_at, a.note
          from platform_admins a
          join users u on u.id = a.user_id
         order by u.email
      `)
      const rows = (res as unknown as { rows: { email: string; granted_at: string }[] }).rows
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

    const found = await tx.execute(sql`select id, name from users where email = ${email}`)
    const user = (found as unknown as { rows: { id: string; name: string | null }[] }).rows[0]

    if (!user) {
      console.error(`No account with the address ${email}.`)
      console.error('They have to sign up or accept an invitation first.')
      process.exitCode = 1
      return
    }

    if (revoke) {
      await tx.execute(sql`delete from platform_admins where user_id = ${user.id}::uuid`)
      console.log(`Revoked platform administration from ${email}.`)
      return
    }

    await tx.execute(sql`
      insert into platform_admins (user_id, note)
      values (${user.id}::uuid, ${`granted via CLI on ${new Date().toISOString().slice(0, 10)}`})
      on conflict (user_id) do nothing
    `)
    console.log(`${email} (${user.name ?? 'no name'}) is now a platform administrator.`)
    console.log('They can reach /admin to issue product keys.')
  })

  await closeDb()
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err)
  await closeDb().catch(() => {})
  process.exit(1)
})
