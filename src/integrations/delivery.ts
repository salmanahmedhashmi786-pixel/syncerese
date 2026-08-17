import { sql } from 'drizzle-orm'
import type { TenantTx } from '@/db/tenant'
import { decrypt } from '@/lib/crypto'
import { checkWebhookUrl, type ChatKind } from './allowlist'
import { messageFor, type ChatEvent, type ChatContext } from './format'

/**
 * Posting events to Slack and Teams (MUST DO #14).
 *
 * CURSOR, NOT A DELIVERY QUEUE.
 *
 * A customer webhook gets a row per delivery because each one is a contractual
 * obligation with its own retry schedule. A chat notification is not: if the
 * post fails the right behaviour is to try again next tick, and to keep the
 * events in order while doing so. So each integration stores how far through
 * the event stream it has read, and a failure simply does not advance it.
 *
 * Ordered by `(occurred_at, id)`. Not `occurred_at` alone: Postgres `now()` is
 * transaction-start time, so several events emitted in one transaction share a
 * timestamp to the microsecond, and a cursor on the timestamp alone would skip
 * every one of them but the last.
 */

/** Per integration, per tick. A tenant that just imported two thousand invoices
 *  should not empty the lot into a channel in one go — the rest follow on the
 *  next tick, in order, and Slack's rate limiter stays out of it. */
const MAX_PER_TICK = 20

/** Consecutive failures before the integration is switched off. Slack and
 *  Teams both keep accepting POSTs to a URL whose channel was deleted for a
 *  while, so a handful of failures is normal; twenty is a dead URL. */
const MAX_FAILURES = 20

const TIMEOUT_MS = 10_000

export type ChatDeliveryResult = {
  integrationId: string
  kind: ChatKind
  sent: number
  failed: number
  disabled?: boolean
  error?: string
}

type Row = {
  id: string
  kind: ChatKind
  name: string
  targetUrlEncrypted: string
  events: string[]
  cursorAt: string | null
  cursorEventId: string | null
  failureCount: number
}

export type ChatSend = (url: string, body: string) => Promise<{ status: number; ok: boolean }>


/**
 * Sends everything waiting for one organization.
 *
 * `send` is injectable so the tests exercise real cursor movement, ordering,
 * failure counting and auto-disable without touching the network.
 */
export async function deliverChatMessages(
  tx: TenantTx,
  organizationId: string,
  ctx: ChatContext,
  opts: { send?: ChatSend; now?: Date; limit?: number } = {},
): Promise<ChatDeliveryResult[]> {
  const now = opts.now ?? new Date()
  const send = opts.send ?? defaultSend
  const limit = opts.limit ?? MAX_PER_TICK

  const integrations = (
    (await tx.execute(sql`
      select id, kind, name, target_url_encrypted as "targetUrlEncrypted",
             events, cursor_at as "cursorAt", cursor_event_id as "cursorEventId",
             failure_count as "failureCount"
        from chat_integrations
       where organization_id = ${organizationId}
         and enabled
       order by created_at
    `)) as unknown as { rows: Row[] }
  ).rows

  const results: ChatDeliveryResult[] = []

  for (const integration of integrations) {
    results.push(await deliverOne(tx, organizationId, integration, ctx, send, now, limit))
  }

  return results
}

async function deliverOne(
  tx: TenantTx,
  organizationId: string,
  integration: Row,
  ctx: ChatContext,
  send: ChatSend,
  now: Date,
  limit: number,
): Promise<ChatDeliveryResult> {
  const base = { integrationId: integration.id, kind: integration.kind }

  // Re-checked here, not just on save. The row could have been written by an
  // older build, restored from a backup taken before the allowlist existed, or
  // changed by a direct database edit — and this is the last point before the
  // server makes the request. A URL that fails now disables the integration
  // rather than being skipped quietly.
  let url: string
  try {
    url = checkWebhookUrl(integration.kind, decrypt(integration.targetUrlEncrypted)).url
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await disable(tx, integration.id, now, `URL rejected: ${message}`)
    return { ...base, sent: 0, failed: 0, disabled: true, error: message }
  }

  const pending = await pendingFor(tx, organizationId, integration, limit)
  if (pending.length === 0) return { ...base, sent: 0, failed: 0 }

  let sent = 0
  let cursor: { at: string; id: string } | null = null

  for (const event of pending) {
    if (!wants(integration.events, event.type)) {
      // Filtered out, but it has still been read. Advancing past it is the
      // point — otherwise an integration subscribed to one rare event type
      // re-reads the same thousand rows on every tick for ever.
      cursor = { at: isoOf(event.occurredAt), id: event.id }
      continue
    }

    const body = JSON.stringify(messageFor(integration.kind, event, ctx))

    let status = 0
    let ok = false
    let error: string | undefined
    try {
      const response = await send(url, body)
      status = response.status
      ok = response.ok
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    if (ok) {
      sent += 1
      cursor = { at: isoOf(event.occurredAt), id: event.id }
      continue
    }

    // Stop at the first failure and leave the cursor where the last success
    // put it. Carrying on would deliver the rest out of order and lose this one.
    await recordFailure(tx, integration, now, status, error)
    if (cursor) await advance(tx, integration.id, cursor, now)
    return {
      ...base,
      sent,
      failed: 1,
      disabled: isDead(status) || integration.failureCount + 1 >= MAX_FAILURES,
      error: error ?? `HTTP ${status}`,
    }
  }

  if (cursor) await advance(tx, integration.id, cursor, now)
  await tx.execute(sql`
    update chat_integrations
       set failure_count = 0, last_error = null, last_error_at = null,
           last_success_at = ${now.toISOString()}, updated_at = ${now.toISOString()}
     where id = ${integration.id}
  `)

  return { ...base, sent, failed: 0 }
}

/** Events after the cursor, oldest first. */
async function pendingFor(
  tx: TenantTx,
  organizationId: string,
  integration: Row,
  limit: number,
): Promise<ChatEvent[]> {
  const cursorAt = integration.cursorAt
  const cursorId = integration.cursorEventId

  const res = await tx.execute(sql`
    select id, type, entity_type as "entityType", entity_id as "entityId",
           payload, occurred_at as "occurredAt"
      from events
     where organization_id = ${organizationId}
       and (
         ${cursorAt}::timestamptz is null
         or occurred_at > ${cursorAt}::timestamptz
         or (occurred_at = ${cursorAt}::timestamptz and id > ${cursorId}::uuid)
       )
     order by occurred_at, id
     limit ${limit}
  `)
  return (res as unknown as { rows: ChatEvent[] }).rows
}

/** '*' means everything. An empty list means nothing, which is what a customer
 *  who unticked every box asked for. */
function wants(subscribed: string[], type: string): boolean {
  return subscribed.includes('*') || subscribed.includes(type)
}

async function advance(
  tx: TenantTx,
  id: string,
  cursor: { at: string; id: string },
  now: Date,
): Promise<void> {
  // Both halves together — `chat_integrations_cursor_whole` enforces it, and a
  // half-set cursor makes every subsequent comparison return NULL, which reads
  // as "nothing waiting" for ever.
  await tx.execute(sql`
    update chat_integrations
       set cursor_at = ${cursor.at}::timestamptz,
           cursor_event_id = ${cursor.id}::uuid,
           updated_at = ${now.toISOString()}
     where id = ${id}
  `)
}

/**
 * 404 and 410 mean the webhook was deleted in the customer's workspace. Slack
 * returns 404 with `no_service`; there is nothing to retry, so it is switched
 * off immediately rather than after twenty more identical failures.
 *
 * 429 is deliberately NOT counted — that is Slack asking for a slower pace, not
 * a broken integration, and disabling on it would punish the busiest tenants.
 */
const isDead = (status: number): boolean => status === 404 || status === 410

async function recordFailure(
  tx: TenantTx,
  integration: Row,
  now: Date,
  status: number,
  error: string | undefined,
): Promise<void> {
  const message = (error ?? `HTTP ${status}`).slice(0, 500)

  if (status === 429) {
    await tx.execute(sql`
      update chat_integrations
         set last_error = ${message}, last_error_at = ${now.toISOString()},
             updated_at = ${now.toISOString()}
       where id = ${integration.id}
    `)
    return
  }

  if (isDead(status)) {
    await disable(tx, integration.id, now, message)
    return
  }

  await tx.execute(sql`
    update chat_integrations
       set failure_count = failure_count + 1,
           last_error = ${message}, last_error_at = ${now.toISOString()},
           enabled = (failure_count + 1) < ${MAX_FAILURES},
           updated_at = ${now.toISOString()}
     where id = ${integration.id}
  `)
}

async function disable(tx: TenantTx, id: string, now: Date, reason: string): Promise<void> {
  await tx.execute(sql`
    update chat_integrations
       set enabled = false, last_error = ${reason.slice(0, 500)},
           last_error_at = ${now.toISOString()}, updated_at = ${now.toISOString()}
     where id = ${id}
  `)
}

const isoOf = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v)

/**
 * The real request.
 *
 * `redirect: 'manual'` is load-bearing, not tidiness. The allowlist in
 * `allowlist.ts` checks the host of the URL being requested; if a redirect were
 * followed, an allowlisted host answering `302 Location: http://169.254.169.254/…`
 * would send this server — and the event payload — somewhere the allowlist
 * exists to prevent. Neither vendor redirects, so a 3xx is treated as a failure.
 */
async function defaultSend(url: string, body: string): Promise<{ status: number; ok: boolean }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'user-agent': 'Syncrese/1.0' },
      redirect: 'manual',
      signal: controller.signal,
    })
    return {
      status: response.status,
      // Written out rather than using `response.ok`, so that a future change to
      // the fetch options cannot quietly make a 3xx count as sent.
      //
      // A `Retry-After` header is deliberately not read: the next tick is a
      // minute away, which is longer than anything Slack asks for, and the
      // cursor has not moved, so the same events are simply retried then.
      ok: response.status >= 200 && response.status < 300,
    }
  } finally {
    clearTimeout(timeout)
  }
}
