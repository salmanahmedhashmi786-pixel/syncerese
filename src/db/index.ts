import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'
import type { AnyDb } from './tenant'

/**
 * Database handle.
 *
 * DATABASE_URL must point at the APPLICATION role: not the table owner, and
 * without BYPASSRLS. Tenant isolation depends on that — a superuser connection
 * silently defeats every RLS policy in the system and nothing else in the stack
 * would notice.
 *
 * Built lazily so importing the schema (in tests, in drizzle-kit, in the CI
 * guard) never opens a socket.
 */
let pool: Pool | undefined
let instance: AnyDb | undefined

export async function db(): Promise<AnyDb> {
  if (instance) return instance

  const url = process.env.DATABASE_URL

  if (!url) {
    // No connection string. In development, fall back to the embedded PGlite
    // database so the app runs with zero setup.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'DATABASE_URL is not set. The embedded development database is never used in production.',
      )
    }
    const { getLocalDb } = await import('./local')
    instance = await getLocalDb()
    return instance
  }

  pool = new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // TLS to the database, not just to the app (MUST DO #18: encrypted in
    // transit end to end).
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true },
  })
  instance = drizzle(pool, { schema }) as AnyDb
  return instance
}

/** Synchronous accessor for code paths that already know the pool is warm.
 *  Prefer `db()`. */
export function getDb(): AnyDb {
  if (!instance) throw new Error('Database not initialised — await db() first')
  return instance
}

export async function closeDb(): Promise<void> {
  await pool?.end()
  pool = undefined
  instance = undefined
}

export { schema }
