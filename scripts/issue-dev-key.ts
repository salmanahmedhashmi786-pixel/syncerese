import 'dotenv/config'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db'
import { organizations } from '../src/db/schema'
import { asPlatformAdmin, withTenant } from '../src/db/tenant'
import { issueApiKey } from '../src/api/keys'
import { grantsFor } from '../src/auth/permissions'
import type { RequestContext } from '../src/server/context'
import { FULL_ACCESS } from '../src/billing/access'

/**
 * Issues a development API key for the demo tenant and prints it once.
 *
 * Stop `npm run dev` first — the embedded PGlite database is single-writer.
 *
 *   npm run dev:key
 */
const handle = await db()

const org = await asPlatformAdmin(handle, async (tx) => {
  const rows = await tx
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.slug, 'demo'))
    .limit(1)
  return rows[0]
})

if (!org) {
  console.error('No demo organization. Run `npm run db:seed` first.')
  process.exit(1)
}

const owner = await asPlatformAdmin(handle, async (tx) => {
  const res = await tx.execute(
    sql`select id from users where email = 'owner@syncrese.test'`,
  )
  return (res as unknown as { rows: { id: string }[] }).rows[0]!
})

const ctx: RequestContext = {
  userId: owner.id,
  organizationId: org.id,
  membershipId: 'dev',
  role: 'owner',
  permissions: grantsFor('owner'),
  requestId: null,
  ip: null,
  userAgent: null,
  // These fixtures build a context by hand rather than through resolveContext.
  // A licensed, in-date tenant is the right default: nothing here is testing
  // billing, and an unlicensed default would make every unrelated write fail.
  licence: FULL_ACCESS,
}

const issued = await withTenant(handle, { organizationId: org.id, userId: owner.id }, (tx) =>
  issueApiKey(tx, ctx, {
    name: `Dev key ${new Date().toISOString().slice(0, 16)}`,
    scopes: [
      'invoice.read',
      'invoice.create',
      'crm.read',
      'sales.read',
      'purchase.read',
      'inventory.read',
      'ledger.read',
      'payment.record',
    ],
    rateLimitPerMinute: 600,
  }),
)

console.log('')
console.log(`  Organization : ${org.name}`)
console.log(`  Key          : ${issued.secret}`)
console.log(`  Scopes       : ${issued.scopes.join(', ')}`)
console.log('')
console.log('  This is the only time the secret is shown. Try it:')
console.log(`    curl -H "Authorization: Bearer ${issued.secret}" http://localhost:3000/api/v1/invoices?limit=3`)
console.log('')

process.exit(0)
