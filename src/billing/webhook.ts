import { sql } from 'drizzle-orm'
import type Stripe from 'stripe'
import type { AnyDb } from '@/db/tenant'
import { withoutTenantScope, withTenant } from '@/db/tenant'
import {
  applySubscription,
  organizationForCustomer,
  recordLicenceEvent,
  type SubscriptionSnapshot,
} from './service'

/**
 * Stripe webhook handling, separated from the route so it can be tested
 * without an HTTP server or a real Stripe signature.
 *
 * Three properties matter, and all three are easy to get wrong in ways that
 * only show up in production:
 *
 *  1. IDEMPOTENT. Stripe delivers at least once and retries for days on any
 *     non-2xx. An event applied twice can double a seat count.
 *
 *  2. ORDER-INDEPENDENT. Stripe does not guarantee ordering. A delayed
 *     `subscription.updated` can arrive after the `subscription.deleted` that
 *     followed it and silently reinstate a cancelled subscription.
 *
 *  3. ALWAYS 2xx ONCE ACCEPTED. An event we have recorded but cannot act on
 *     must still return 200, or Stripe retries it forever and the customer's
 *     dashboard fills with failures.
 */

export type HandledEvent = {
  handled: boolean
  /** Why it was skipped, for the log — never returned to Stripe. */
  note: string
  organizationId: string | null
}

/** The events this integration acts on. Everything else is recorded and
 *  acknowledged: subscribing to fewer events in the Stripe dashboard is a
 *  configuration nobody remembers to check. */
const ACTED_ON = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
])

export async function handleStripeEvent(db: AnyDb, event: Stripe.Event): Promise<HandledEvent> {
  const created = new Date(event.created * 1000)

  // Claim it first. A duplicate delivery loses the race here and does no work.
  const claimed = await withoutTenantScope(db, async (tx) => {
    const res = await tx.execute(sql`
      select public.claim_billing_event(
        ${event.id}, ${event.type}, ${created.toISOString()}::timestamptz, ${JSON.stringify({
          type: event.type,
          object: (event.data.object as { object?: string })?.object ?? null,
        })}::jsonb
      ) as claimed
    `)
    return (res as unknown as { rows: { claimed: boolean }[] }).rows[0]?.claimed ?? false
  })

  if (!claimed) {
    return { handled: false, note: 'already applied', organizationId: null }
  }

  if (!ACTED_ON.has(event.type)) {
    return { handled: false, note: 'not acted on', organizationId: null }
  }

  const customerId = customerIdOf(event)
  if (!customerId) {
    return { handled: false, note: 'no customer on event', organizationId: null }
  }

  const organizationId = await organizationForCustomer(db, customerId)
  if (!organizationId) {
    // A customer we have never seen. Happens legitimately when a checkout is
    // abandoned before the customer id is stored, and when a Stripe account is
    // shared with another product. Acknowledged, not retried.
    return { handled: false, note: 'no tenant for customer', organizationId: null }
  }

  await withoutTenantScope(db, (tx) =>
    tx.execute(sql`select public.attribute_billing_event(${event.id}, ${organizationId}::uuid)`),
  )

  // Ordering. Anything older than an event already applied to this tenant is
  // dropped — this is what stops a late `updated` resurrecting a cancelled
  // subscription.
  const stale = await withoutTenantScope(db, async (tx) => {
    const res = await tx.execute(sql`
      select public.billing_event_is_stale(
        ${organizationId}::uuid, ${created.toISOString()}::timestamptz, ${event.id}
      ) as stale
    `)
    return (res as unknown as { rows: { stale: boolean }[] }).rows[0]?.stale ?? false
  })

  if (stale) {
    await withTenant(db, { organizationId }, (tx) =>
      recordLicenceEvent(tx, organizationId, 'webhook.out_of_order', {
        eventId: event.id,
        type: event.type,
        created: created.toISOString(),
      }),
    )
    return { handled: false, note: 'superseded by a newer event', organizationId }
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const snapshot = await snapshotFor(event, customerId)
      if (!snapshot) {
        return { handled: false, note: 'no subscription on event', organizationId }
      }
      await applySubscription(db, organizationId, snapshot)
      return { handled: true, note: 'subscription applied', organizationId }
    }

    case 'invoice.payment_failed':
    case 'invoice.payment_succeeded': {
      // The subscription events carry the authoritative status; these are
      // recorded so a billing dispute can be answered from our own history
      // rather than only from Stripe's.
      const invoice = event.data.object as Stripe.Invoice
      await withTenant(db, { organizationId }, (tx) =>
        recordLicenceEvent(tx, organizationId, event.type, {
          invoiceId: invoice.id,
          amountDueMinor: invoice.amount_due,
          amountPaidMinor: invoice.amount_paid,
          currencyCode: invoice.currency?.toUpperCase() ?? null,
          attempt: invoice.attempt_count,
        }),
      )
      return { handled: true, note: 'payment event recorded', organizationId }
    }

    default:
      return { handled: false, note: 'unhandled type', organizationId }
  }
}

/** The Stripe customer id, wherever this event happens to carry it. */
function customerIdOf(event: Stripe.Event): string | null {
  const object = event.data.object as { customer?: string | { id: string } | null }
  const customer = object?.customer
  if (!customer) return null
  return typeof customer === 'string' ? customer : customer.id
}

/**
 * Reduces an event to the handful of fields the licence actually mirrors.
 *
 * A `checkout.session.completed` carries only a subscription id, so the
 * subscription itself is fetched. Fetching rather than trusting the event body
 * also means a replayed old event picks up the CURRENT state, which is the
 * behaviour that makes out-of-order delivery survivable.
 */
async function snapshotFor(
  event: Stripe.Event,
  customerId: string,
): Promise<SubscriptionSnapshot | null> {
  let subscription: Stripe.Subscription | null = null

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    const ref = session.subscription
    if (!ref) return null
    const { stripe } = await import('./stripe')
    subscription =
      typeof ref === 'string' ? await stripe().subscriptions.retrieve(ref) : (ref as Stripe.Subscription)
  } else {
    subscription = event.data.object as Stripe.Subscription
  }

  if (!subscription) return null

  const item = subscription.items?.data?.[0]

  return {
    subscriptionId: subscription.id,
    customerId,
    // A deleted subscription arrives with status 'canceled' already, but the
    // event type is the stronger signal — Stripe has sent it precisely because
    // the subscription is gone.
    status: event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status,
    priceId: item?.price?.id ?? null,
    quantity: item?.quantity ?? 1,
    currentPeriodEnd: periodEndOf(subscription, item),
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
  }
}

/**
 * When the paid period ends.
 *
 * Stripe moved `current_period_end` from the subscription onto each
 * subscription ITEM. Reading only the old location silently yields undefined on
 * a current API version, which would null out `valid_until` and put every
 * tenant into the expired branch. Both are checked.
 */
function periodEndOf(
  subscription: Stripe.Subscription,
  item: Stripe.SubscriptionItem | undefined,
): Date | null {
  const fromItem = (item as { current_period_end?: number } | undefined)?.current_period_end
  const fromSubscription = (subscription as unknown as { current_period_end?: number })
    .current_period_end
  const seconds = fromItem ?? fromSubscription
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null
}
