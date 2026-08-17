import { sql, and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { chatIntegrations } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { type RequestContext, requirePermission } from '@/server/context'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { encrypt, decrypt } from '@/lib/crypto'
import { EVENT_TYPES } from '@/api/events'
import { checkWebhookUrl } from './allowlist'
import { messageFor } from './format'
import type { ChatKind } from './allowlist'

/**
 * Managing Slack and Teams integrations.
 *
 * Gated on `integration.manage` — "Connect Slack and Microsoft Teams" — which
 * is already in the catalogue and already granted to owner and admin. Reusing
 * `webhook.manage` would have worked identically for the built-in roles and
 * quietly denied a custom role that was given exactly the permission named
 * after this feature.
 */

const MAX_INTEGRATIONS = 20

export const integrationSchema = z.object({
  kind: z.enum(['slack', 'teams']),
  name: z.string().trim().min(1, 'Give it a name').max(80),
  url: z.string().min(1),
  events: z.array(z.string()).min(1).max(64),
})

export type ChatIntegrationSummary = {
  id: string
  kind: ChatKind
  name: string
  urlHint: string
  events: string[]
  enabled: boolean
  failureCount: number
  lastError: string | null
  lastSuccessAt: string | null
  createdAt: string
}

export async function listIntegrations(
  tx: TenantTx,
  ctx: RequestContext,
): Promise<ChatIntegrationSummary[]> {
  requirePermission(ctx, 'integration.manage')
  const res = await tx.execute(sql`
    select id, kind, name, url_hint as "urlHint", events, enabled,
           failure_count as "failureCount", last_error as "lastError",
           last_success_at as "lastSuccessAt", created_at as "createdAt"
      from chat_integrations
     where organization_id = ${ctx.organizationId}
     order by created_at
  `)
  // The URL itself is never selected here. It is a credential — anyone holding
  // it can post into the customer's channel as though they were us — so it
  // leaves the database only in `delivery.ts`, on its way to the vendor.
  return (res as unknown as { rows: ChatIntegrationSummary[] }).rows
}

export async function createIntegration(
  tx: TenantTx,
  ctx: RequestContext,
  input: unknown,
): Promise<{ id: string; urlHint: string }> {
  requirePermission(ctx, 'integration.manage')

  const parsed = integrationSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid integration', parsed.error.issues)
  }
  const { kind, name, events } = parsed.data

  const unknown = events.filter((e) => e !== '*' && !(EVENT_TYPES as readonly string[]).includes(e))
  if (unknown.length > 0) {
    throw new AppError('VALIDATION_FAILED', `Unknown event type(s): ${unknown.join(', ')}`)
  }

  // Throws with a message meant for the customer if the host is not Slack's or
  // Microsoft's. See allowlist.ts — this is the SSRF boundary.
  const checked = checkWebhookUrl(kind, parsed.data.url)

  const count = (
    (await tx.execute(sql`
      select count(*)::int as n from chat_integrations
       where organization_id = ${ctx.organizationId}
    `)) as unknown as { rows: { n: number }[] }
  ).rows[0]!.n
  if (count >= MAX_INTEGRATIONS) {
    throw new AppError(
      'VALIDATION_FAILED',
      `A workspace can have at most ${MAX_INTEGRATIONS} chat integrations.`,
    )
  }

  const id = newId()

  // Start at the newest existing event, not at the beginning of time. A
  // workspace with two years of history would otherwise empty all of it into
  // the channel on the first tick. Both halves of the cursor come from the same
  // row, or both stay null on a workspace with no events yet — the
  // `chat_integrations_cursor_whole` constraint refuses anything in between.
  const newest = (
    (await tx.execute(sql`
      select occurred_at as "occurredAt", id from events
       where organization_id = ${ctx.organizationId}
       order by occurred_at desc, id desc
       limit 1
    `)) as unknown as { rows: { occurredAt: string | Date; id: string }[] }
  ).rows[0]

  await tx.insert(chatIntegrations).values({
    id,
    organizationId: ctx.organizationId,
    kind,
    name,
    targetUrlEncrypted: encrypt(checked.url),
    urlHint: checked.hint,
    events,
    cursorAt: newest ? new Date(newest.occurredAt) : null,
    cursorEventId: newest?.id ?? null,
    createdBy: ctx.userId,
  })

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'chat_integration.created',
    entityType: 'chat_integration',
    entityId: id,
    // The hint, never the URL. An audit row recording the credential it reports
    // the creation of has stored that credential in a second, unencrypted place.
    after: { kind, name, urlHint: checked.hint, events },
    requestId: ctx.requestId,
  })

  return { id, urlHint: checked.hint }
}

export async function updateIntegration(
  tx: TenantTx,
  ctx: RequestContext,
  id: string,
  changes: { name?: string; events?: string[]; enabled?: boolean },
): Promise<void> {
  requirePermission(ctx, 'integration.manage')

  if (changes.events) {
    const unknown = changes.events.filter(
      (e) => e !== '*' && !(EVENT_TYPES as readonly string[]).includes(e),
    )
    if (unknown.length > 0) {
      throw new AppError('VALIDATION_FAILED', `Unknown event type(s): ${unknown.join(', ')}`)
    }
  }

  const patch: Partial<typeof chatIntegrations.$inferInsert> = { updatedAt: new Date() }
  if (changes.name !== undefined) patch.name = changes.name
  if (changes.events !== undefined) patch.events = changes.events
  if (changes.enabled !== undefined) {
    patch.enabled = changes.enabled
    if (changes.enabled) {
      // Re-enabling is also a reset. Leaving the count at its ceiling means the
      // next single failure switches it straight back off, and the customer's
      // "try again" appears to do nothing at all.
      patch.failureCount = 0
      patch.lastError = null
      patch.lastErrorAt = null
    }
  }

  const updated = await tx
    .update(chatIntegrations)
    .set(patch)
    .where(
      and(
        eq(chatIntegrations.id, id),
        eq(chatIntegrations.organizationId, ctx.organizationId),
      ),
    )
    .returning({ id: chatIntegrations.id })

  if (updated.length === 0) throw new AppError('NOT_FOUND', 'No such integration.')

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'chat_integration.updated',
    entityType: 'chat_integration',
    entityId: id,
    after: changes,
    requestId: ctx.requestId,
  })
}

export async function deleteIntegration(
  tx: TenantTx,
  ctx: RequestContext,
  id: string,
): Promise<void> {
  requirePermission(ctx, 'integration.manage')

  const res = await tx.execute(sql`
    delete from chat_integrations
     where id = ${id} and organization_id = ${ctx.organizationId}
     returning name, kind, url_hint as "urlHint"
  `)
  const row = (res as unknown as { rows: { name: string; kind: string; urlHint: string }[] })
    .rows[0]
  if (!row) throw new AppError('NOT_FOUND', 'No such integration.')

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'chat_integration.deleted',
    entityType: 'chat_integration',
    entityId: id,
    before: row,
    requestId: ctx.requestId,
  })
}

/**
 * Prepares a test message, so the customer finds out the URL works here rather
 * than the next time an invoice is issued.
 *
 * Split in two on purpose: this half reads the row and builds the body inside
 * the tenant transaction, the caller does the POST OUTSIDE it, and
 * `recordTestResult` writes the audit row afterwards. Sending inline would hold
 * a database transaction open for up to ten seconds while waiting on Slack —
 * the same reason `drainDeliveries` runs in its own transaction and the billing
 * page talks to Stripe outside one.
 *
 * The URL is re-checked against the allowlist on the way out. This takes an id,
 * not a URL, so it cannot be used to make the server fetch something arbitrary,
 * and the stored value is validated again anyway.
 */
export async function prepareTestMessage(
  tx: TenantTx,
  ctx: RequestContext,
  id: string,
  organizationName: string,
): Promise<{ url: string; body: string }> {
  requirePermission(ctx, 'integration.manage')

  const res = await tx.execute(sql`
    select kind, target_url_encrypted as "targetUrlEncrypted"
      from chat_integrations
     where id = ${id} and organization_id = ${ctx.organizationId}
  `)
  const row = (res as unknown as { rows: { kind: ChatKind; targetUrlEncrypted: string }[] }).rows[0]
  if (!row) throw new AppError('NOT_FOUND', 'No such integration.')

  const checked = checkWebhookUrl(row.kind, decrypt(row.targetUrlEncrypted))

  const body = JSON.stringify(
    messageFor(
      row.kind,
      {
        id,
        type: 'integration.test',
        entityType: 'integration',
        entityId: null,
        payload: { name: 'Test message from Syncrese' },
        occurredAt: new Date().toISOString(),
      },
      { organizationName, appUrl: process.env.AUTH_URL ?? null },
    ),
  )

  return { url: checked.url, body }
}

/** Audits what the POST returned. Separate transaction, after the network call. */
export async function recordTestResult(
  tx: TenantTx,
  ctx: RequestContext,
  id: string,
  result: { ok: boolean; status: number },
): Promise<void> {
  requirePermission(ctx, 'integration.manage')
  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'chat_integration.tested',
    entityType: 'chat_integration',
    entityId: id,
    after: { status: result.status, ok: result.ok },
    requestId: ctx.requestId,
  })
}

/**
 * The POST itself. `redirect: 'manual'` for the same reason as delivery.ts:
 * following a redirect would take the request off the allowlisted host, which
 * is the whole thing the allowlist exists to prevent.
 */
export async function postTestMessage(
  url: string,
  body: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    const r = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'user-agent': 'Syncrese/1.0' },
      redirect: 'manual',
      signal: controller.signal,
    })
    return { status: r.status, ok: r.status >= 200 && r.status < 300 }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeout)
  }
}
