import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { withoutTenantScope, withTenant } from '@/db/tenant'
import { drainDeliveries, fanOut, secretForEndpoint } from '@/api/webhooks'
import { deliverChatMessages } from '@/integrations/delivery'
import { checkCronSecret } from '../cron-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Webhook dispatch tick.
 *
 * Next.js has no daemon, so delivery runs from a scheduled call (Vercel Cron,
 * a platform scheduler, or any external pinger) rather than a background
 * worker. Pretending otherwise would mean webhooks that only fire while
 * somebody happens to have the app open.
 *
 * Guarded by a shared secret rather than an API key: this is infrastructure,
 * not a tenant-scoped operation, and it iterates every organization.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = checkCronSecret(request)
  if (denied) return denied

  const handle = await db()

  // Only organizations with an undispatched event, a due delivery, or chat
  // messages waiting — no point opening a transaction per tenant on a quiet
  // system.
  //
  // Chat has to be its own branch rather than riding on `dispatched_at`: that
  // flag belongs to the webhook fan-out, and a tenant whose events were all
  // fanned out an hour ago can still have a chat integration whose cursor is
  // behind. Sharing the flag would mean chat silently stopped for exactly the
  // tenants that also use webhooks.
  const orgs = await withoutTenantScope(handle, async (tx) => {
    const res = await tx.execute(sql`
      select distinct organization_id as id from (
        select organization_id from events where dispatched_at is null
        union all
        select organization_id from webhook_deliveries
         where status in ('pending','failed') and next_attempt_at <= now()
        union all
        select organization_id from public.organizations_with_chat_work()
      ) t
    `)
    return (res as unknown as { rows: { id: string }[] }).rows.map((r) => r.id)
  })

  const summary: {
    organizationId: string
    events: number
    deliveries: number
    sent: number
    failed: number
    abandoned: number
    chatSent: number
    chatFailed: number
  }[] = []

  for (const organizationId of orgs) {
    // Per-tenant transactions: one organization's bad endpoint must not stall
    // or roll back another's deliveries.
    const fanned = await withTenant(handle, { organizationId }, (tx) => fanOut(tx, organizationId))

    // Then send what is due. A SEPARATE transaction from the fan-out on
    // purpose: delivery makes outbound HTTP calls, and holding a database
    // transaction open across a third party's timeout is how a slow customer
    // endpoint turns into connection-pool exhaustion for everyone.
    const results = await withTenant(handle, { organizationId }, (tx) =>
      drainDeliveries(tx, organizationId, {
        secretFor: (endpointId) => secretForEndpoint(tx, organizationId, endpointId),
      }),
    )

    // Chat, in a third transaction and for the same reason: these are outbound
    // HTTP calls to Slack and Microsoft, and a slow one must not hold a
    // database transaction open for the tenants queued behind it.
    const chat = await withTenant(handle, { organizationId }, async (tx) => {
      const org = (
        (await tx.execute(sql`
          select name from organizations where id = ${organizationId}
        `)) as unknown as { rows: { name: string }[] }
      ).rows[0]

      return deliverChatMessages(
        tx,
        organizationId,
        {
          organizationName: org?.name ?? '',
          // The same public base URL everything else is built from. A relative
          // link is useless in a chat client and a link to the wrong host is
          // worse than none, so if it is unset the message carries no link.
          appUrl: process.env.AUTH_URL ?? null,
        },
      )
    })

    summary.push({
      organizationId,
      ...fanned,
      sent: results.filter((r) => r.status === 'succeeded').length,
      failed: results.filter((r) => r.status === 'failed').length,
      abandoned: results.filter((r) => r.status === 'abandoned').length,
      chatSent: chat.reduce((n, r) => n + r.sent, 0),
      chatFailed: chat.reduce((n, r) => n + r.failed, 0),
    })
  }

  return NextResponse.json({ dispatched: summary })
}

/**
 * Vercel Cron invokes jobs with a GET, and `vercel.json` declares one against
 * this path. Exporting POST only meant it answered 405 every minute and nothing
 * was ever delivered — see cron-auth.ts for why a guarded GET is safe here.
 */
export const GET = POST
