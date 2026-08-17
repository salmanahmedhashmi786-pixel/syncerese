import { NextResponse } from 'next/server'
import { db } from '@/db'
import { withoutTenantScope, withTenant } from '@/db/tenant'
import { sweepRetention, ORGS_WITH_RETENTION } from '@/gdpr/retention-service'
import { checkCronSecret } from '../cron-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The retention sweep (GDPR Art. 5(1)(e)).
 *
 * SEPARATE FROM THE WEBHOOK DISPATCH TICK, deliberately. That one runs every
 * minute and exists to be fast; this one deletes data and should run once a
 * day. Sharing an endpoint would mean either dispatching webhooks daily or
 * running a deletion job every minute, and neither is a trade worth making to
 * save a cron entry.
 *
 * Calling it more often than daily is nonetheless harmless: each policy carries
 * `last_swept_at` and refuses to run again inside twenty hours. That matters
 * because Vercel's Hobby plan offers only daily crons and everyone else will
 * point whatever pinger they already have at it.
 *
 * Guarded by the same shared secret as the dispatch tick: this is
 * infrastructure, not a tenant-scoped operation, and it iterates every
 * organization.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = checkCronSecret(request)
  if (denied) return denied

  const handle = await db()

  // Tenants with a live policy, plus any tenant that has events at all — the
  // event outbox is the one category with a default, because it is our queue
  // rather than the customer's records. An installation where nobody has
  // configured anything and nothing has happened yet opens no transactions.
  const orgs = await withoutTenantScope(handle, async (tx) => {
    const res = await tx.execute(ORGS_WITH_RETENTION)
    return (res as unknown as { rows: { id: string }[] }).rows.map((r) => r.id)
  })

  const swept: { organizationId: string; removed: number; categories: unknown[] }[] = []

  for (const organizationId of orgs) {
    // Per-tenant transactions: one organization's policy must not roll back
    // another's sweep, and a deletion that fails should leave that tenant
    // untouched rather than half-expired.
    const results = await withTenant(handle, { organizationId }, (tx) =>
      sweepRetention(tx, organizationId),
    )
    swept.push({
      organizationId,
      removed: results.reduce((n, r) => n + r.removed, 0),
      categories: results,
    })
  }

  return NextResponse.json({ swept })
}

/** Vercel Cron invokes with a GET. Same guard either way. */
export const GET = POST
