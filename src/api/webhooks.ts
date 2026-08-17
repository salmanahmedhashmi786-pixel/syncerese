import { and, eq, sql } from 'drizzle-orm'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { events, webhookDeliveries, webhookEndpoints } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { hashOpaqueToken } from '@/auth/password'
import type { RequestContext } from '@/server/context'
import { requirePermission } from '@/server/context'
import { EVENT_TYPES } from './events'
import { decrypt, encrypt } from '@/lib/crypto'

/**
 * Signed webhook delivery (MUST DO #8, #18).
 *
 * Payloads are signed HMAC-SHA256 so a receiver can verify the request really
 * came from us. The signature covers `timestamp.body`, not just the body — a
 * body-only signature is replayable forever, because an attacker who captures
 * one valid request can resend it indefinitely and it stays valid.
 */

const MAX_ATTEMPTS = 6
/** Exponential backoff in seconds: ~30s, 2m, 8m, 32m, 2h, 8.5h. Roughly half a
 *  day of retries, which covers a normal deploy or outage without hammering a
 *  dead endpoint for a week. */
const backoffSeconds = (attempt: number) => 30 * 4 ** (attempt - 1)

export const SIGNATURE_HEADER = 'syncrese-signature'
export const EVENT_HEADER = 'syncrese-event'
export const DELIVERY_HEADER = 'syncrese-delivery'

export function signPayload(secret: string, body: string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${mac}`
}

/**
 * Verifies a signature. Exported so the docs can point integrators at a
 * reference implementation rather than leaving them to guess.
 *
 * `toleranceSeconds` bounds replay: a captured request stops being accepted
 * once it falls outside the window.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const [k, v] = kv.split('=')
      return [k?.trim(), v?.trim()]
    }),
  )
  const t = Number(parts.t)
  const v1 = parts.v1
  if (!Number.isFinite(t) || !v1) return false

  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false

  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(v1, 'hex')
  // Length check first: timingSafeEqual throws on a mismatch, and the throw
  // itself would leak length through timing.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ---------------------------------------------------------------------------
// Endpoint management
// ---------------------------------------------------------------------------

export const endpointSchema = z.object({
  url: z.string().url().startsWith('https://', 'Webhook URLs must use HTTPS'),
  description: z.string().max(200).optional(),
  events: z.array(z.string()).min(1).max(64),
})

export async function createEndpoint(
  tx: TenantTx,
  ctx: RequestContext,
  input: unknown,
): Promise<{ id: string; secret: string }> {
  const parsed = endpointSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid webhook endpoint', parsed.error.issues)
  }
  const { url, description, events: subscribed } = parsed.data

  const unknown = subscribed.filter(
    (e) => e !== '*' && !(EVENT_TYPES as readonly string[]).includes(e),
  )
  if (unknown.length > 0) {
    throw new AppError('VALIDATION_FAILED', `Unknown event type(s): ${unknown.join(', ')}`)
  }

  // Block obvious SSRF targets. Not a complete defence — DNS can still resolve
  // a public name to a private address — but it stops the accidental cases and
  // makes the intent explicit for whoever adds egress filtering later.
  const host = new URL(url).hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new AppError('VALIDATION_FAILED', 'Webhook URL must be publicly reachable')
  }

  const secret = `whsec_${randomBytes(32).toString('base64url')}`
  const id = newId()

  await tx.insert(webhookEndpoints).values({
    id,
    organizationId: ctx.organizationId,
    url,
    description: description ?? null,
    secretHash: hashOpaqueToken(secret),
    // ENCRYPTED, not only hashed — and this is the reason the whole delivery
    // path works. Every delivery signs `{timestamp}.{body}` with this secret,
    // so a hash alone would mean no webhook could ever be sent without first
    // re-issuing and breaking whatever the customer built against it.
    //
    // The cost is that ENCRYPTION_KEY is load-bearing for webhooks too.
    secretEncrypted: encrypt(secret),
    secretPrefix: secret.slice(0, 14),
    events: subscribed,
    createdBy: ctx.userId,
  })

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'webhook_endpoint.created',
    entityType: 'webhook_endpoint',
    entityId: id,
    after: { url, events: subscribed },
    requestId: ctx.requestId,
  })

  // Returned so the receiver can be configured with it. It is also recoverable
  // later through `revealSecret`, deliberately — a customer who has lost their
  // signing secret should not have to break a live integration to get it back.
  return { id, secret }
}

/**
 * Hands the signing secret back to somebody who can manage webhooks.
 *
 * Gated on `webhook.manage` and audited, because this is a genuine disclosure
 * of a credential — anyone holding it can forge a payload that the customer's
 * receiver will accept as ours.
 */
export async function revealSecret(
  tx: TenantTx,
  ctx: RequestContext,
  endpointId: string,
): Promise<string> {
  requirePermission(ctx, 'webhook.manage')

  const rows = await tx
    .select({ secret: webhookEndpoints.secretEncrypted, url: webhookEndpoints.url })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.organizationId, ctx.organizationId),
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) throw new AppError('NOT_FOUND', 'No such endpoint.')
  if (!row.secret) {
    throw new AppError(
      'CONFLICT',
      'This endpoint predates encrypted secret storage, so its secret cannot be recovered. ' +
        'Create a new endpoint to get a fresh one.',
    )
  }

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'webhook_endpoint.secret_revealed',
    entityType: 'webhook_endpoint',
    entityId: endpointId,
    // The URL, not the secret. An audit log that records the credential it is
    // reporting the disclosure of has disclosed it again.
    after: { url: row.url },
    requestId: ctx.requestId,
    ip: ctx.ip,
  })

  return decrypt(row.secret)
}

/**
 * The `secretFor` callback `drainDeliveries` needs.
 *
 * Kept next to the code that stores the secret so the two cannot drift apart.
 */
export async function secretForEndpoint(
  tx: TenantTx,
  organizationId: string,
  endpointId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ secret: webhookEndpoints.secretEncrypted })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.organizationId, organizationId),
      ),
    )
    .limit(1)

  const stored = rows[0]?.secret
  if (!stored) return null

  try {
    return decrypt(stored)
  } catch (err) {
    // The key is gone or the value was altered. Returning null makes
    // drainDeliveries abandon the delivery loudly rather than send something
    // signed with garbage that the receiver will silently reject for ever.
    console.error(`[webhooks] could not decrypt the secret for endpoint ${endpointId}:`, err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Fan-out and delivery
// ---------------------------------------------------------------------------

/**
 * Turns undispatched events into per-endpoint deliveries.
 *
 * Separate from sending so a fan-out failure never loses an event, and so the
 * unique index on (endpoint, event) makes the whole step idempotent — running
 * the drain twice cannot double-deliver.
 */
export async function fanOut(
  tx: TenantTx,
  organizationId: string,
  limit = 200,
): Promise<{ events: number; deliveries: number }> {
  const pending = (
    (await tx.execute(sql`
      select id, type from events
       where organization_id = ${organizationId} and dispatched_at is null
       order by occurred_at, id
       limit ${limit}
    `)) as unknown as { rows: { id: string; type: string }[] }
  ).rows

  if (pending.length === 0) return { events: 0, deliveries: 0 }

  const endpoints = await tx
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, organizationId),
        eq(webhookEndpoints.isActive, true),
      ),
    )

  let created = 0
  for (const event of pending) {
    for (const endpoint of endpoints) {
      const subscribed = (endpoint.events as string[]) ?? []
      if (!subscribed.includes('*') && !subscribed.includes(event.type)) continue

      await tx
        .insert(webhookDeliveries)
        .values({
          id: newId(),
          organizationId,
          endpointId: endpoint.id,
          eventId: event.id,
          status: 'pending',
          nextAttemptAt: new Date(),
        })
        .onConflictDoNothing()
      created++
    }

    await tx
      .update(events)
      .set({ dispatchedAt: new Date() })
      .where(eq(events.id, event.id))
  }

  return { events: pending.length, deliveries: created }
}

export type DeliveryResult = {
  deliveryId: string
  status: 'succeeded' | 'failed' | 'abandoned'
  responseCode?: number
  error?: string
}

/**
 * Attempts due deliveries.
 *
 * Called from a scheduled endpoint rather than a long-lived worker — Next.js
 * has no daemon, and pretending otherwise would mean webhooks that only fire
 * while someone has the app open.
 *
 * `send` is injectable so tests exercise real retry, backoff and signature
 * behaviour without network access.
 */
export async function drainDeliveries(
  tx: TenantTx,
  organizationId: string,
  opts: {
    secretFor: (endpointId: string) => Promise<string | null>
    send?: (url: string, body: string, headers: Record<string, string>) => Promise<Response>
    now?: Date
    limit?: number
  },
): Promise<DeliveryResult[]> {
  const now = opts.now ?? new Date()
  const send = opts.send ?? defaultSend

  const due = (
    (await tx.execute(sql`
      select d.id, d.endpoint_id as "endpointId", d.event_id as "eventId", d.attempt,
             e.url, e.id as "epId",
             ev.type as "eventType", ev.payload, ev.entity_type as "entityType",
             ev.entity_id as "entityId", ev.occurred_at as "occurredAt"
        from webhook_deliveries d
        join webhook_endpoints e on e.id = d.endpoint_id
        join events ev on ev.id = d.event_id
       where d.organization_id = ${organizationId}
         and d.status in ('pending','failed')
         and d.next_attempt_at is not null
         and d.next_attempt_at <= ${now.toISOString()}
         and e.is_active
       order by d.next_attempt_at
       limit ${opts.limit ?? 50}
    `)) as unknown as {
      rows: {
        id: string
        endpointId: string
        eventId: string
        attempt: number
        url: string
        eventType: string
        payload: Record<string, unknown>
        entityType: string
        entityId: string | null
        occurredAt: string
      }[]
    }
  ).rows

  const results: DeliveryResult[] = []

  for (const delivery of due) {
    const secret = await opts.secretFor(delivery.endpointId)
    if (!secret) {
      // Without the plaintext secret nothing can be signed. Fail loudly rather
      // than sending an unsigned payload a receiver would be right to reject.
      await tx
        .update(webhookDeliveries)
        .set({
          status: 'abandoned',
          error: 'signing secret unavailable',
          nextAttemptAt: null,
          completedAt: now,
        })
        .where(eq(webhookDeliveries.id, delivery.id))
      results.push({ deliveryId: delivery.id, status: 'abandoned', error: 'no secret' })
      continue
    }

    const attempt = delivery.attempt + 1
    const body = JSON.stringify({
      id: delivery.eventId,
      type: delivery.eventType,
      occurredAt: delivery.occurredAt,
      data: { entityType: delivery.entityType, entityId: delivery.entityId, ...delivery.payload },
    })
    const timestamp = Math.floor(now.getTime() / 1000)

    const startedAt = Date.now()
    let responseCode: number | undefined
    let error: string | undefined
    let ok = false
    let responseBody = ''

    try {
      const response = await send(delivery.url, body, {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signPayload(secret, body, timestamp),
        [EVENT_HEADER]: delivery.eventType,
        [DELIVERY_HEADER]: delivery.id,
        'user-agent': 'Syncrese-Webhooks/1.0',
      })
      responseCode = response.status
      ok = response.ok
      responseBody = (await response.text().catch(() => '')).slice(0, 500)
      if (!ok) error = `HTTP ${response.status}`
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    const durationMs = Date.now() - startedAt

    if (ok) {
      await tx
        .update(webhookDeliveries)
        .set({
          status: 'succeeded',
          attempt,
          responseCode,
          responseBody,
          durationMs,
          nextAttemptAt: null,
          completedAt: now,
          error: null,
        })
        .where(eq(webhookDeliveries.id, delivery.id))

      await tx
        .update(webhookEndpoints)
        .set({ failureCount: 0 })
        .where(eq(webhookEndpoints.id, delivery.endpointId))

      results.push({ deliveryId: delivery.id, status: 'succeeded', responseCode })
      continue
    }

    const exhausted = attempt >= MAX_ATTEMPTS
    await tx
      .update(webhookDeliveries)
      .set({
        status: exhausted ? 'abandoned' : 'failed',
        attempt,
        responseCode,
        responseBody,
        error,
        durationMs,
        nextAttemptAt: exhausted
          ? null
          : new Date(now.getTime() + backoffSeconds(attempt) * 1000),
        completedAt: exhausted ? now : null,
      })
      .where(eq(webhookDeliveries.id, delivery.id))

    await tx
      .update(webhookEndpoints)
      .set({ failureCount: sql`${webhookEndpoints.failureCount} + 1` })
      .where(eq(webhookEndpoints.id, delivery.endpointId))

    results.push({
      deliveryId: delivery.id,
      status: exhausted ? 'abandoned' : 'failed',
      responseCode,
      error,
    })
  }

  // An endpoint that has failed continuously is switched off rather than
  // retried forever — a dead URL should not generate traffic indefinitely, and
  // the owner needs to be told rather than left wondering.
  await tx
    .update(webhookEndpoints)
    .set({ isActive: false, disabledAt: now })
    .where(
      and(
        eq(webhookEndpoints.organizationId, organizationId),
        sql`${webhookEndpoints.failureCount} >= 50`,
        eq(webhookEndpoints.isActive, true),
      ),
    )

  return results
}

async function defaultSend(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    return await fetch(url, {
      method: 'POST',
      body,
      headers,
      signal: controller.signal,
      redirect: 'error',
    })
  } finally {
    clearTimeout(timeout)
  }
}
