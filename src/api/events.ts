import { sql } from 'drizzle-orm'
import { events } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { newId } from '@/lib/ids'
import { redact } from '@/lib/audit'

/**
 * Transactional outbox (MUST DO #8).
 *
 * Events are written in the SAME transaction as the change they describe. That
 * is the entire point: an invoice that fails to post must not emit
 * "invoice.issued", and an invoice that posts must never fail to emit it.
 * Firing an HTTP webhook inline would break both halves — HTTP cannot roll
 * back, and a network stall would hold a database transaction open.
 *
 * Delivery is a separate drain step (see `webhooks.ts`).
 */

/** The catalogue. Adding one is a constant plus an `emit` call at the point the
 *  thing actually happens — never a guess from a database trigger. */
export const EVENT_TYPES = [
  'invoice.created',
  'invoice.issued',
  'invoice.paid',
  // Separate from invoice.issued on purpose: a subscriber that treats a credit
  // note as an invoice would add the amount to revenue instead of subtracting
  // it, and the payload carries the opposite sign in every practical sense.
  'creditnote.issued',
  'payment.recorded',
  'sales_order.created',
  'sales_order.confirmed',
  'sales_order.delivered',
  'purchase_order.created',
  'purchase_order.approved',
  'goods_receipt.posted',
  'deal.won',
  'deal.lost',
  'partner.created',
  'product.low_stock',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export type EmitInput = {
  organizationId: string
  type: EventType
  entityType: string
  entityId?: string | null
  payload?: Record<string, unknown>
  actorUserId?: string | null
}

export async function emit(tx: TenantTx, input: EmitInput): Promise<string> {
  const id = newId()
  await tx.insert(events).values({
    id,
    organizationId: input.organizationId,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    // Payloads leave the building. The same redaction the audit trail uses
    // applies here, so a webhook can never carry a token or a password hash to
    // a third-party endpoint.
    payload: (redact(input.payload ?? {}) as Record<string, unknown>) ?? {},
    actorUserId: input.actorUserId ?? null,
  })
  return id
}

/** Events awaiting fan-out. Ordered so a consumer sees them in the order they
 *  happened. */
export async function pendingEvents(tx: TenantTx, organizationId: string, limit = 100) {
  const res = await tx.execute(sql`
    select id, type, entity_type as "entityType", entity_id as "entityId",
           payload, occurred_at as "occurredAt"
      from events
     where organization_id = ${organizationId}
       and dispatched_at is null
     order by occurred_at, id
     limit ${limit}
  `)
  return (
    res as unknown as {
      rows: {
        id: string
        type: string
        entityType: string
        entityId: string | null
        payload: Record<string, unknown>
        occurredAt: string
      }[]
    }
  ).rows
}
