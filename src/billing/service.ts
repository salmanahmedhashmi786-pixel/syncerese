import { eq, sql } from 'drizzle-orm'
import { licenseEvents, licenses, memberships } from '@/db/schema'
import type { AnyDb, TenantTx } from '@/db/tenant'
import { withoutTenantScope, withTenant } from '@/db/tenant'
import { AppError, forbidden } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import type { RequestContext } from '@/server/context'
import { requirePermission } from '@/server/context'
import { GRACE_DAYS, type LicenceAccess } from './access'
import { billingConfigured, clampSeats, planByKey, planByPriceId, type PlanKey } from './plans'
import { stripe } from './stripe'

/**
 * Subscription billing.
 *
 * The tenant's licence is a MIRROR of the Stripe subscription, never the other
 * way round. Nothing here lets the browser say what it bought: the UI sends the
 * customer to Stripe Checkout, Stripe takes the money, and a signed webhook
 * comes back and changes the licence. A request that claimed "I upgraded to 50
 * seats" would be believed by any implementation that trusted the client, and
 * seats are the thing being sold.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type BillingState = {
  plan: string
  status: 'trial' | 'active' | 'past_due' | 'suspended' | 'cancelled'
  seats: number
  seatsInUse: number
  validUntil: string | null
  currentPeriodEnd: string | null
  graceUntil: string | null
  cancelAtPeriodEnd: boolean
  hasSubscription: boolean
  /** False when this deployment has no Stripe keys — the UI says so plainly
   *  rather than offering buttons that cannot work. */
  configured: boolean
}

export async function billingState(tx: TenantTx, ctx: RequestContext): Promise<BillingState> {
  requirePermission(ctx, 'license.read')

  const res = await tx.execute(sql`
    select l.plan, l.status, l.seat_count, l.valid_until, l.grace_until,
           l.current_period_end, l.cancel_at_period_end, l.stripe_subscription_id,
           (select count(*)::int from memberships m
             where m.organization_id = ${ctx.organizationId} and m.status = 'active') as seats_in_use
    from licenses l
    where l.organization_id = ${ctx.organizationId}
    limit 1
  `)
  const row = (
    res as unknown as {
      rows: {
        plan: string
        status: BillingState['status']
        seat_count: number
        valid_until: string | Date | null
        grace_until: string | Date | null
        current_period_end: string | Date | null
        cancel_at_period_end: boolean
        stripe_subscription_id: string | null
        seats_in_use: number
      }[]
    }
  ).rows[0]

  if (!row) {
    throw new AppError('NO_LICENSE', 'This organization has no licence record.')
  }

  const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null)

  return {
    plan: row.plan,
    status: row.status,
    seats: row.seat_count,
    seatsInUse: row.seats_in_use,
    validUntil: iso(row.valid_until),
    currentPeriodEnd: iso(row.current_period_end),
    graceUntil: iso(row.grace_until),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    hasSubscription: Boolean(row.stripe_subscription_id),
    configured: billingConfigured(),
  }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * Starts a Stripe Checkout session and returns the URL to send the buyer to.
 *
 * Deliberately returns a URL rather than taking payment: a card never touches
 * this application, which keeps the whole PCI surface at Stripe and is why the
 * desktop app can consume a licence without ever being a payment terminal.
 */
export async function createCheckoutSession(
  tx: TenantTx,
  ctx: RequestContext,
  input: { planKey: string; seats: number; returnUrl: string },
): Promise<{ url: string }> {
  requirePermission(ctx, 'license.manage')

  if (!billingConfigured()) {
    throw new AppError('INTERNAL', 'Billing is not configured on this deployment.')
  }

  const plan = planByKey(input.planKey)
  if (!plan || !plan.priceId) {
    throw new AppError('VALIDATION_FAILED', 'Unknown plan.')
  }

  const state = await billingState(tx, ctx)
  // Never sell fewer seats than are already occupied — the purchase would
  // complete, the webhook would try to shrink the licence, and the seat trigger
  // would then refuse every future member while the customer had already paid.
  const seats = clampSeats(plan, Math.floor(input.seats), state.seatsInUse)

  const org = await tx.execute(
    sql`select name, slug from organizations where id = ${ctx.organizationId} limit 1`,
  )
  const orgRow = (org as unknown as { rows: { name: string; slug: string }[] }).rows[0]

  const customerId = await ensureCustomer(tx, ctx, orgRow?.name ?? 'Syncrese customer')

  const session = await stripe().checkout.sessions.create(
    {
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: plan.priceId, quantity: seats }],
      success_url: `${input.returnUrl}?billing=success`,
      cancel_url: `${input.returnUrl}?billing=cancelled`,
      // Carried back on every event for this subscription. The webhook resolves
      // the tenant from the Stripe customer id, and this is the corroborating
      // second source — if the two ever disagree, something is badly wrong and
      // the handler refuses rather than guessing.
      subscription_data: {
        metadata: { organizationId: ctx.organizationId, planKey: plan.key },
      },
      metadata: { organizationId: ctx.organizationId, planKey: plan.key },
      allow_promotion_codes: true,
      // Stripe collects and remits the VAT/sales tax. Getting this wrong across
      // 27 member states is not a thing to hand-roll.
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
      tax_id_collection: { enabled: true },
    },
    // Idempotent on the tenant, plan and seat count: a double-clicked upgrade
    // button creates ONE checkout session, not two subscriptions.
    { idempotencyKey: `checkout:${ctx.organizationId}:${plan.key}:${seats}` },
  )

  if (!session.url) throw new AppError('INTERNAL', 'Stripe did not return a checkout URL.')

  await recordLicenceEvent(tx, ctx.organizationId, 'checkout.started', {
    plan: plan.key,
    seats,
    sessionId: session.id,
  }, ctx.userId)

  return { url: session.url }
}

/**
 * A link into Stripe's own billing portal, where the customer changes their
 * card, downloads invoices and cancels.
 *
 * Building those screens ourselves would mean handling payment methods, dunning
 * and tax documents — all of which Stripe already does correctly and none of
 * which is this product.
 */
export async function createPortalSession(
  tx: TenantTx,
  ctx: RequestContext,
  returnUrl: string,
): Promise<{ url: string }> {
  requirePermission(ctx, 'license.manage')

  if (!billingConfigured()) {
    throw new AppError('INTERNAL', 'Billing is not configured on this deployment.')
  }

  const rows = await tx
    .select({ customerId: licenses.stripeCustomerId })
    .from(licenses)
    .where(eq(licenses.organizationId, ctx.organizationId))
    .limit(1)

  const customerId = rows[0]?.customerId
  if (!customerId) {
    throw new AppError(
      'CONFLICT',
      'There is no subscription to manage yet. Choose a plan first.',
    )
  }

  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  })
  return { url: session.url }
}

/** Finds or creates the Stripe customer backing this tenant. */
async function ensureCustomer(
  tx: TenantTx,
  ctx: RequestContext,
  organizationName: string,
): Promise<string> {
  const rows = await tx
    .select({ customerId: licenses.stripeCustomerId })
    .from(licenses)
    .where(eq(licenses.organizationId, ctx.organizationId))
    .limit(1)

  const existing = rows[0]?.customerId
  if (existing) return existing

  const customer = await stripe().customers.create(
    {
      name: organizationName,
      // The tenant id, so a Stripe dashboard row can always be traced back to
      // an organization without a lookup table.
      metadata: { organizationId: ctx.organizationId },
    },
    { idempotencyKey: `customer:${ctx.organizationId}` },
  )

  await tx
    .update(licenses)
    .set({ stripeCustomerId: customer.id })
    .where(eq(licenses.organizationId, ctx.organizationId))

  return customer.id
}

// ---------------------------------------------------------------------------
// Applying what Stripe says
// ---------------------------------------------------------------------------

export type SubscriptionSnapshot = {
  subscriptionId: string
  customerId: string
  /** Stripe's own status string. */
  status: string
  priceId: string | null
  quantity: number
  currentPeriodEnd: Date | null
  cancelAtPeriodEnd: boolean
}

/** Stripe subscription status → licence status. */
function licenceStatusFor(stripeStatus: string): BillingState['status'] {
  switch (stripeStatus) {
    case 'trialing':
      return 'trial'
    case 'active':
      return 'active'
    case 'past_due':
    case 'unpaid':
      return 'past_due'
    case 'canceled':
      return 'cancelled'
    case 'incomplete_expired':
      return 'suspended'
    // `incomplete` means the first payment has not completed. Treating it as
    // active would hand out a workspace for an unpaid subscription.
    case 'incomplete':
      return 'past_due'
    case 'paused':
      return 'suspended'
    default:
      return 'past_due'
  }
}

/**
 * Writes a Stripe subscription onto the tenant's licence.
 *
 * The one place the licence changes for billing reasons. Called only from the
 * webhook handler, after signature verification.
 */
export async function applySubscription(
  db: AnyDb,
  organizationId: string,
  snapshot: SubscriptionSnapshot,
  actorUserId?: string | null,
): Promise<{ seats: number; status: string }> {
  const plan = snapshot.priceId ? planByPriceId(snapshot.priceId) : undefined
  const status = licenceStatusFor(snapshot.status)

  return withTenant(db, { organizationId }, async (tx) => {
    const current = (
      await tx.select().from(licenses).where(eq(licenses.organizationId, organizationId)).limit(1)
    )[0]
    if (!current) throw new AppError('NO_LICENSE', 'No licence to update.')

    const inUse = (
      await tx.execute(sql`
        select count(*)::int as n from memberships
        where organization_id = ${organizationId} and status = 'active'
      `)
    ) as unknown as { rows: { n: number }[] }
    const seatsInUse = inUse.rows[0]?.n ?? 0

    // A downgrade below the seats already occupied would leave the seat trigger
    // refusing every future change, and would misrepresent what the customer
    // bought. The licence keeps the larger number; reconciling the difference is
    // a conversation, not a silent lockout.
    const seats = Math.max(snapshot.quantity, seatsInUse, 1)

    // Access runs to the end of the paid period, plus a grace window if the
    // payment is in trouble.
    const periodEnd = snapshot.currentPeriodEnd
    const graceUntil =
      status === 'past_due' && periodEnd
        ? new Date(periodEnd.getTime() + GRACE_DAYS * 86_400_000)
        : null

    await tx
      .update(licenses)
      .set({
        plan: plan?.key ?? current.plan,
        seatCount: seats,
        status,
        stripeSubscriptionId: snapshot.subscriptionId,
        stripeCustomerId: snapshot.customerId,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
        validUntil: periodEnd ?? current.validUntil,
        graceUntil,
        billingRef: snapshot.subscriptionId,
        updatedAt: new Date(),
      })
      .where(eq(licenses.organizationId, organizationId))

    await recordLicenceEvent(
      tx,
      organizationId,
      'subscription.synced',
      {
        stripeStatus: snapshot.status,
        licenceStatus: status,
        plan: plan?.key ?? current.plan,
        seatsRequested: snapshot.quantity,
        seatsApplied: seats,
        seatsInUse,
        currentPeriodEnd: periodEnd?.toISOString() ?? null,
      },
      actorUserId ?? null,
    )

    await writeAudit(tx, {
      organizationId,
      actorUserId: actorUserId ?? null,
      actorType: 'system',
      action: 'license.updated',
      entityType: 'license',
      entityId: current.id,
      before: { plan: current.plan, seats: current.seatCount, status: current.status },
      after: { plan: plan?.key ?? current.plan, seats, status },
    })

    return { seats, status }
  })
}

/**
 * Resolves a Stripe customer id to a tenant.
 *
 * Pre-tenant — which organization this is IS the question — so it goes through
 * a SECURITY DEFINER function rather than a direct query that RLS would filter
 * to nothing.
 */
export async function organizationForCustomer(
  db: AnyDb,
  customerId: string,
): Promise<string | null> {
  const res = await withoutTenantScope(db, (tx) =>
    tx.execute(sql`select * from public.resolve_billing_customer(${customerId})`),
  )
  return (
    (res as unknown as { rows: { organization_id: string }[] }).rows[0]?.organization_id ?? null
  )
}

/** Append-only licensing history, including the events nobody wants — a failed
 *  payment, a downgrade that could not be applied. That is what makes a billing
 *  dispute answerable. */
export async function recordLicenceEvent(
  tx: TenantTx,
  organizationId: string,
  event: string,
  payload: Record<string, unknown>,
  actorUserId: string | null = null,
): Promise<void> {
  const rows = await tx
    .select({ id: licenses.id })
    .from(licenses)
    .where(eq(licenses.organizationId, organizationId))
    .limit(1)

  await tx.insert(licenseEvents).values({
    id: newId(),
    licenseId: rows[0]?.id ?? null,
    organizationId,
    event,
    payload,
    actorUserId,
  })
}

/** Seats currently occupied. Exported because both checkout and the webhook
 *  need it and neither should reimplement "what counts as a seat". */
export async function seatsInUse(tx: TenantTx, organizationId: string): Promise<number> {
  const res = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(sql`organization_id = ${organizationId} and status = 'active'`)
  return res[0]?.n ?? 0
}

/** Guard for the write paths that must not run on a lapsed licence. */
export function assertWritable(access: LicenceAccess): void {
  if (!access.canWrite) throw forbidden(access.reason ?? 'This workspace is read-only.')
}

export { licenceAccess, type LicenceAccess } from './access'
export type { PlanKey }
