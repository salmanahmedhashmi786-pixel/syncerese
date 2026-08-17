import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '@/db/schema'
import type { AnyDb } from '@/db/tenant'
import { newId } from '@/lib/ids'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Boots a real Postgres 16 in-process (PGlite is Postgres compiled to WASM),
 * applies the actual migrations, and seeds the system roles.
 *
 * Deliberately the real migration files rather than a hand-written test schema:
 * a test-only schema would prove the tests pass, not that the shipped RLS
 * policies and triggers work. If 0001 breaks, these tests must break with it.
 */
export type TestDb = {
  db: AnyDb
  client: PGlite
  /** Raw superuser handle. Superusers bypass RLS, so this is used ONLY to seed
   *  fixtures — never to assert isolation. */
  sudo: (sql: string) => Promise<void>
  close: () => Promise<void>
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite()

  // Every migration, in the same order the production runner applies them.
  // Naming them individually would drift the moment a migration is added — and
  // a test suite running an older schema than production is worse than no
  // suite at all.
  const dir = path.join(root, 'drizzle')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    await client.exec(await readFile(path.join(dir, file), 'utf8'))
  }

  const db = drizzle(client, { schema }) as unknown as AnyDb

  // The app role must be assumed per transaction, otherwise the connecting
  // superuser bypasses every policy and the isolation tests would pass
  // vacuously. withTenant() reads this.
  process.env.DB_APP_ROLE = 'syncrese_app'

  const sudo = async (sql: string) => {
    await client.exec(sql)
  }

  // System roles and permissions arrive with the migrations
  // (0003_platform_seed.sql), not from here — that is where production gets
  // them, so the tests must exercise the same path.

  return {
    db,
    client,
    sudo,
    close: async () => {
      delete process.env.DB_APP_ROLE
      await client.close()
    },
  }
}

const esc = (v: string) => v.replace(/'/g, "''")

export async function roleId(client: PGlite, key: string): Promise<string> {
  const res = await client.query<{ id: string }>(
    `select id from roles where key = $1 and organization_id is null limit 1`,
    [key],
  )
  const row = res.rows[0]
  if (!row) throw new Error(`system role not seeded: ${key}`)
  return row.id
}

/** Seeds a tenant with a licence and an owner. Uses the superuser handle, so it
 *  is not itself a test of the policies. */
export async function seedOrg(
  t: TestDb,
  opts: { name: string; slug: string; seats: number; currency?: string },
): Promise<{ orgId: string; ownerUserId: string; ownerRoleId: string }> {
  const orgId = newId()
  const userId = newId()
  const licenseId = newId()
  const membershipId = newId()
  const ownerRoleId = await roleId(t.client, 'owner')

  await t.sudo(`
    insert into organizations (id, slug, name, base_currency)
    values ('${orgId}', '${esc(opts.slug)}', '${esc(opts.name)}', '${opts.currency ?? 'EUR'}');

    insert into users (id, email, name, status)
    values ('${userId}', 'owner@${esc(opts.slug)}.test', 'Owner ${esc(opts.name)}', 'active');

    insert into licenses (id, organization_id, plan, seat_count, status)
    values ('${licenseId}', '${orgId}', 'starter', ${opts.seats}, 'active');

    insert into memberships (id, organization_id, user_id, role_id, status)
    values ('${membershipId}', '${orgId}', '${userId}', '${ownerRoleId}', 'active');
  `)

  return { orgId, ownerUserId: userId, ownerRoleId }
}

/** Adds a user with no membership yet — the subject of seat-limit tests. */
export async function seedUser(t: TestDb, email: string): Promise<string> {
  const id = newId()
  await t.sudo(
    `insert into users (id, email, status) values ('${id}', '${esc(email.toLowerCase())}', 'active')`,
  )
  return id
}
