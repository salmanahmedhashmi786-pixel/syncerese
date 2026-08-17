import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from './schema'
import type { AnyDb } from './tenant'

/**
 * Zero-setup LOCAL DEVELOPMENT database.
 *
 * PGlite is a real PostgreSQL 16 compiled to WASM, persisted to `.syncrese-dev`
 * in the project root. It exists so `npm run dev` works without provisioning
 * anything — the same reason the test suite uses it.
 *
 * It is NOT a production story: single connection, single process, no backups,
 * no replication, no point-in-time recovery. `getDb()` refuses to reach this
 * file when NODE_ENV is production, so it cannot be switched on by accident or
 * by a missing environment variable during a deploy.
 *
 * SINGLE WRITER. Only one process may hold `.syncrese-dev` at a time. Running
 * `npm run db:seed`, a script, or a second dev server while `npm run dev` is
 * up gives two instances of the same directory whose views can silently
 * diverge — reads look stale and writes appear to vanish. Stop the dev server
 * first, or point DATABASE_URL at a real Postgres. Real Postgres has no such
 * limitation; this is purely a property of the embedded build.
 */
/**
 * Cached on globalThis, NOT in module scope.
 *
 * Next.js hot-reloading re-evaluates this module on every edit, which resets
 * module-level state — so a second PGlite would open `.syncrese-dev` while the
 * first still holds it. PGlite is single-writer, and the result is a corrupted
 * store and `RuntimeError: Aborted()` on every subsequent request. Hanging the
 * instance off globalThis is what makes it survive HMR.
 */
const cache = globalThis as unknown as {
  __syncreseLocalDb?: { client: PGlite; instance: AnyDb; ready: Promise<void> }
}

async function migrate(db: PGlite): Promise<void> {
  const dir = path.resolve(process.cwd(), 'drizzle')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  await db.exec(`
    create table if not exists __drizzle_migrations (
      id serial primary key,
      filename text not null unique,
      applied_at timestamptz not null default now()
    )
  `)
  const applied = await db.query<{ filename: string }>('select filename from __drizzle_migrations')
  const done = new Set(applied.rows.map((r) => r.filename))

  for (const file of files) {
    if (done.has(file)) continue
    const sql = await readFile(path.join(dir, file), 'utf8')
    await db.exec(sql)
    await db.query('insert into __drizzle_migrations (filename) values ($1)', [file])
    console.log(`[syncrese] applied migration ${file}`)
  }
}

export async function getLocalDb(): Promise<AnyDb> {
  if (cache.__syncreseLocalDb) {
    await cache.__syncreseLocalDb.ready
    return cache.__syncreseLocalDb.instance
  }

  const client = new PGlite(path.resolve(process.cwd(), '.syncrese-dev'))
  const instance = drizzle(client, { schema }) as unknown as AnyDb

  const ready = (async () => {
    await migrate(client)
    // The app role must be assumed per transaction here too, otherwise the
    // connecting superuser bypasses RLS and local development would behave
    // nothing like production — which is the main way tenant-scoping bugs get
    // shipped.
    process.env.DB_APP_ROLE = 'syncrese_app'
  })()

  // Published before awaiting, so a concurrent request during the first boot
  // waits on this same promise instead of opening a second instance.
  cache.__syncreseLocalDb = { client, instance, ready }

  await ready
  return instance
}

export function localDbClient(): PGlite | undefined {
  return cache.__syncreseLocalDb?.client
}
