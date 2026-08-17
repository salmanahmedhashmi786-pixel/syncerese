import '../lib/load-env'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'

/**
 * Migration runner.
 *
 * Deliberately NOT drizzle-kit's `migrate`: this project's migrations include
 * hand-written SQL (RLS policies, the seat trigger, grants) that drizzle-kit
 * does not generate and would drop from its journal. Applying every .sql file
 * in order, tracked in a table, keeps generated and hand-written migrations in
 * one sequence.
 *
 * Runs as the OWNER (DATABASE_MIGRATION_URL). The application role must never
 * be able to alter schema or drop a policy — if the app could, a compromised
 * app could disable tenant isolation.
 */
async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_MIGRATION_URL (or DATABASE_URL) is not set')

  const dir = path.resolve(process.cwd(), 'drizzle')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()

  const client = new Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true },
  })
  await client.connect()

  try {
    await client.query(`
      create table if not exists __drizzle_migrations (
        id          serial primary key,
        filename    text not null unique,
        applied_at  timestamptz not null default now()
      )
    `)

    const applied = await client.query<{ filename: string }>(
      `select filename from __drizzle_migrations`,
    )
    const done = new Set(applied.rows.map((r) => r.filename))

    let count = 0
    for (const file of files) {
      if (done.has(file)) continue

      const sql = await readFile(path.join(dir, file), 'utf8')

      // Each migration is atomic: a failure half-way leaves nothing behind, so
      // a botched RLS change cannot leave tables enabled but unpoliced.
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query(`insert into __drizzle_migrations (filename) values ($1)`, [file])
        await client.query('commit')
        console.log(`applied  ${file}`)
        count++
      } catch (err) {
        await client.query('rollback')
        console.error(`FAILED   ${file}`)
        throw err
      }
    }

    console.log(count === 0 ? 'up to date — nothing to apply' : `${count} migration(s) applied`)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
