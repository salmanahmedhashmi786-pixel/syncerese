import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type Stripe from 'stripe'
import { withTenant } from '@/db/tenant'
import { resolveContext } from '@/server/context'
import { licenceAccess, permittedWhileReadOnly, isWritePermission } from '@/billing/access'
import { applySubscription, type SubscriptionSnapshot } from '@/billing/service'
import { handleStripeEvent } from '@/billing/webhook'
import { clampSeats, PLANS } from '@/billing/plans'
import { createTestDb, roleId, seedOrg, seedUser, type TestDb } from './helpers/db'

/**
 * Billing.
 *
 * The parts worth testing are the ones that fail invisibly in production:
 * a webhook applied twice, an event that arrives out of order, a downgrade that
 * strands existing members, and read-only mode either not biting or biting so
 * hard the customer cannot pay their way out of it.
 *
 * No network. Stripe events are constructed as plain objects, which is exactly
 * what the handler receives after signature verification.
 */

const DAY = 86_400_000
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY)

function subscriptionEvent(
  type: string,
  opts: {
    id?: string
    customerId: string
    subscriptionId?: string
    status?: string
    quantity?: number
    priceId?: string
    periodEnd?: Date
    cancelAtPeriodEnd?: boolean
    createdAt?: Date
  },
): Stripe.Event {
  const periodEnd = opts.periodEnd ?? iso(30)
  return {
    id: opts.id ?? `evt_${Math.floor(periodEnd.getTime())}_${type}`,
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: Math.floor((opts.createdAt ?? new Date()).getTime() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type,
    data: {
      object: {
        id: opts.subscriptionId ?? 'sub_test_1',
        object: 'subscription',
        customer: opts.customerId,
        status: opts.status ?? 'active',
        cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
        items: {
          object: 'list',
          data: [
            {
              id: 'si_1',
              object: 'subscription_item',
              quantity: opts.quantity ?? 5,
              price: { id: opts.priceId ?? 'price_test_pro', object: 'price' },
              current_period_end: Math.floor(periodEnd.getTime() / 1000),
            },
          ],
        },
      },
    },
  } as unknown as Stripe.Event
}

describe('licence access', () => {
  it('permits everything on a healthy subscription', () => {
    const a = licenceAccess({ status: 'active', validUntil: iso(20), graceUntil: null })
    expect(a.canWrite).toBe(true)
    expect(a.warning).toBeNull()
  })

  it('warns near the end of a trial without blocking', () => {
    // The one deadline with no billing email behind it.
    const a = licenceAccess({ status: 'trial', validUntil: iso(3), graceUntil: null })
    expect(a.canWrite).toBe(true)
    expect(a.warning).toMatch(/trial ends in 3 days/i)
  })

  it('keeps a failed payment writable inside the grace window', () => {
    // Blocking here would punish a customer for an expired card before anyone
    // has had a chance to read the email about it.
    const a = licenceAccess({ status: 'past_due', validUntil: iso(-2), graceUntil: iso(12) })
    expect(a.canWrite).toBe(true)
    expect(a.warning).toMatch(/payment has failed/i)
  })

  it('goes read-only once the grace window closes', () => {
    const a = licenceAccess({ status: 'past_due', validUntil: iso(-30), graceUntil: iso(-1) })
    expect(a.canWrite).toBe(false)
    expect(a.reason).toMatch(/read-only/i)
    // The message has to say the records are safe. Someone reading it is
    // already worried they have lost their books.
    expect(a.reason).toMatch(/intact/i)
  })

  it('keeps a cancelled subscription usable until the period it paid for ends', () => {
    const still = licenceAccess({ status: 'cancelled', validUntil: iso(10), graceUntil: null })
    expect(still.canWrite).toBe(true)
    expect(still.warning).toMatch(/cancelled/i)

    const done = licenceAccess({ status: 'cancelled', validUntil: iso(-1), graceUntil: null })
    expect(done.canWrite).toBe(false)
  })

  it('blocks an expired trial that nobody converted', () => {
    const a = licenceAccess({ status: 'trial', validUntil: iso(-1), graceUntil: null })
    expect(a.canWrite).toBe(false)
    expect(a.reason).toMatch(/still here/i)
  })

  it('refuses writes when there is no licence at all', () => {
    expect(licenceAccess(null).canWrite).toBe(false)
  })
})

describe('what read-only still allows', () => {
  it('lets every read through', () => {
    expect(permittedWhileReadOnly('invoice.read')).toBe(true)
    expect(permittedWhileReadOnly('ledger.read')).toBe(true)
    expect(permittedWhileReadOnly('member.read')).toBe(true)
  })

  it('blocks ordinary writes', () => {
    expect(permittedWhileReadOnly('invoice.create')).toBe(false)
    expect(permittedWhileReadOnly('ledger.post')).toBe(false)
    expect(permittedWhileReadOnly('member.invite')).toBe(false)
  })

  it('leaves the way out of read-only open', () => {
    // Without this, read-only is a trap: paying is a write, so a customer whose
    // card failed could never fix it from inside the product.
    expect(permittedWhileReadOnly('license.manage')).toBe(true)
    // A data subject's rights do not lapse because their controller's card did.
    expect(permittedWhileReadOnly('gdpr.manage')).toBe(true)
    // Leaving must stay possible.
    expect(permittedWhileReadOnly('org.delete')).toBe(true)
    expect(permittedWhileReadOnly('member.deactivate')).toBe(true)
  })

  it('treats an unrecognised permission as a write', () => {
    // Safe direction: a new write that should have been gated is a licensing
    // hole; a new read that gets gated is a bug someone reports on day one.
    expect(isWritePermission('something.entirely.new' as never)).toBe(true)
  })
})

describe('seat clamping', () => {
  const pro = PLANS.find((p) => p.key === 'professional')!

  it('never sells fewer seats than are already occupied', () => {
    // The purchase would complete, the webhook would shrink the licence, and
    // the seat trigger would then refuse every future member — for a customer
    // who has already paid.
    expect(clampSeats(pro, 3, 12)).toBe(12)
  })

  it('respects the plan floor and ceiling', () => {
    expect(clampSeats(pro, 1, 0)).toBe(pro.minSeats)
    expect(clampSeats(pro, 9999, 0)).toBe(pro.maxSeats)
  })

  it('has no ceiling where the plan has none', () => {
    const ent = PLANS.find((p) => p.key === 'enterprise')!
    expect(clampSeats(ent, 4000, 0)).toBe(4000)
  })
})

describe('applying a Stripe subscription', () => {
  let t: TestDb
  let org: { orgId: string; ownerUserId: string }
  let other: { orgId: string; ownerUserId: string }

  beforeAll(async () => {
    t = await createTestDb()
    org = await seedOrg(t, { name: 'Billing Co', slug: 'billing-co', seats: 5 })
    other = await seedOrg(t, { name: 'Other Co', slug: 'other-co', seats: 5 })

    // Both plumbed to a Stripe customer, as checkout would have done.
    await t.sudo(`
      update licenses set stripe_customer_id = 'cus_billing'  where organization_id = '${org.orgId}';
      update licenses set stripe_customer_id = 'cus_other'    where organization_id = '${other.orgId}';
    `)
  })

  afterAll(async () => {
    await t.close()
  })

  const licence = async (orgId: string) => {
    const res = await t.client.query<{
      plan: string
      status: string
      seat_count: number
      valid_until: string | null
      grace_until: string | null
      cancel_at_period_end: boolean
      stripe_subscription_id: string | null
    }>(
      `select plan, status, seat_count, valid_until, grace_until, cancel_at_period_end,
              stripe_subscription_id
         from licenses where organization_id = $1`,
      [orgId],
    )
    return res.rows[0]!
  }

  const snapshot = (over: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
    subscriptionId: 'sub_1',
    customerId: 'cus_billing',
    status: 'active',
    priceId: null,
    quantity: 8,
    currentPeriodEnd: iso(30),
    cancelAtPeriodEnd: false,
    ...over,
  })

  it('mirrors seats, status and the period end onto the licence', async () => {
    await applySubscription(t.db, org.orgId, snapshot())
    const l = await licence(org.orgId)

    expect(l.status).toBe('active')
    expect(l.seat_count).toBe(8)
    expect(l.stripe_subscription_id).toBe('sub_1')
    expect(new Date(l.valid_until!).getTime()).toBeGreaterThan(Date.now())
    expect(l.grace_until).toBeNull()
  })

  it('will not shrink the licence below the seats in use', async () => {
    // Ten people in, a downgrade to three bought. The licence keeps ten: the
    // alternative is a seat trigger that refuses every change for a customer
    // who has just paid.
    const salesRole = await roleId(t.client, 'sales')
    await t.sudo(`update licenses set seat_count = 12 where organization_id = '${org.orgId}'`)
    for (let i = 0; i < 9; i++) {
      const userId = await seedUser(t, `member${i}@billing-co.test`)
      await t.sudo(
        `insert into memberships (id, organization_id, user_id, role_id, status)
         values (gen_random_uuid(), '${org.orgId}', '${userId}', '${salesRole}', 'active')`,
      )
    }

    await applySubscription(t.db, org.orgId, snapshot({ quantity: 3 }))
    const l = await licence(org.orgId)
    expect(l.seat_count).toBe(10) // the owner plus nine

    const events = await t.client.query<{ payload: Record<string, unknown> }>(
      `select payload from license_events
        where organization_id = $1 and event = 'subscription.synced'
        order by created_at desc limit 1`,
      [org.orgId],
    )
    // Recorded, not silently swallowed — the discrepancy is a conversation to
    // have with the customer.
    expect(events.rows[0]!.payload).toMatchObject({ seatsRequested: 3, seatsApplied: 10 })
  })

  it('opens a grace window when payment fails', async () => {
    // The paid period has ALREADY ended — that is the case the grace window
    // exists for. An override named `periodEnd` was silently ignored here at
    // first, leaving a future period end, and the assertions below passed for
    // the wrong reason.
    await applySubscription(
      t.db,
      org.orgId,
      snapshot({ status: 'past_due', currentPeriodEnd: iso(-1) }),
    )
    const l = await licence(org.orgId)

    expect(l.status).toBe('past_due')
    expect(new Date(l.valid_until!).getTime()).toBeLessThan(Date.now())
    expect(l.grace_until).not.toBeNull()
    // Roughly 13 days out: one day past the period end, plus the 14-day window.
    expect(new Date(l.grace_until!).getTime()).toBeGreaterThan(Date.now())

    // And the tenant is still writable, which is the whole point of the window.
    const ctx = await resolveContext(t.db, {
      userId: org.ownerUserId,
      organizationId: org.orgId,
    })
    expect(ctx!.licence.canWrite).toBe(true)
  })

  it('maps an incomplete first payment to past_due, not active', () => {
    // 'incomplete' means the first payment has not gone through. Treating it as
    // active hands out a workspace for a subscription nobody has paid for.
    return applySubscription(t.db, other.orgId, snapshot({
      customerId: 'cus_other',
      subscriptionId: 'sub_other',
      status: 'incomplete',
    })).then(async () => {
      expect((await licence(other.orgId)).status).toBe('past_due')
    })
  })
})

describe('the Stripe webhook', () => {
  let t: TestDb
  let org: { orgId: string; ownerUserId: string }

  beforeAll(async () => {
    t = await createTestDb()
    org = await seedOrg(t, { name: 'Hook Co', slug: 'hook-co', seats: 5 })
    await t.sudo(
      `update licenses set stripe_customer_id = 'cus_hook' where organization_id = '${org.orgId}'`,
    )
  })

  afterAll(async () => {
    await t.close()
  })

  const seats = async () => {
    const res = await t.client.query<{ seat_count: number; status: string }>(
      `select seat_count, status from licenses where organization_id = $1`,
      [org.orgId],
    )
    return res.rows[0]!
  }

  it('applies a subscription update', async () => {
    const result = await handleStripeEvent(
      t.db,
      subscriptionEvent('customer.subscription.updated', {
        id: 'evt_apply',
        customerId: 'cus_hook',
        quantity: 7,
      }),
    )
    expect(result.handled).toBe(true)
    expect(result.organizationId).toBe(org.orgId)
    expect((await seats()).seat_count).toBe(7)
  })

  it('ignores a redelivery of the same event', async () => {
    // Stripe retries for days on any non-2xx and delivers at least once. An
    // event applied twice can double a seat count.
    const event = subscriptionEvent('customer.subscription.updated', {
      id: 'evt_duplicate',
      customerId: 'cus_hook',
      quantity: 9,
    })

    const first = await handleStripeEvent(t.db, event)
    expect(first.handled).toBe(true)
    expect((await seats()).seat_count).toBe(9)

    // Same id, but claiming 40 seats. A handler without idempotency would
    // cheerfully apply it.
    const replay = subscriptionEvent('customer.subscription.updated', {
      id: 'evt_duplicate',
      customerId: 'cus_hook',
      quantity: 40,
    })
    const second = await handleStripeEvent(t.db, replay)

    expect(second.handled).toBe(false)
    expect(second.note).toMatch(/already applied/i)
    expect((await seats()).seat_count).toBe(9)
  })

  it('discards an event that arrives after a newer one', async () => {
    // Stripe does not guarantee ordering. Without this, a delayed `updated` can
    // land after the `deleted` that followed it and reinstate a cancelled
    // subscription.
    const cancelledAt = new Date()
    await handleStripeEvent(
      t.db,
      subscriptionEvent('customer.subscription.deleted', {
        id: 'evt_cancel',
        customerId: 'cus_hook',
        status: 'canceled',
        createdAt: cancelledAt,
      }),
    )
    expect((await seats()).status).toBe('cancelled')

    const late = await handleStripeEvent(
      t.db,
      subscriptionEvent('customer.subscription.updated', {
        id: 'evt_late',
        customerId: 'cus_hook',
        status: 'active',
        quantity: 25,
        createdAt: new Date(cancelledAt.getTime() - 60_000),
      }),
    )

    expect(late.handled).toBe(false)
    expect(late.note).toMatch(/superseded/i)
    expect((await seats()).status).toBe('cancelled')
  })

  it('acknowledges an event for a customer it does not know', async () => {
    // Happens legitimately — an abandoned checkout, or a Stripe account shared
    // with another product. Returning an error would make Stripe retry it for
    // days and fill the customer's dashboard with red.
    const result = await handleStripeEvent(
      t.db,
      subscriptionEvent('customer.subscription.updated', {
        id: 'evt_stranger',
        customerId: 'cus_nobody',
      }),
    )
    expect(result.handled).toBe(false)
    expect(result.organizationId).toBeNull()
  })

  it('records a payment failure in the licence history', async () => {
    const event = {
      id: 'evt_failed',
      object: 'event',
      created: Math.floor(Date.now() / 1000),
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_1',
          object: 'invoice',
          customer: 'cus_hook',
          amount_due: 12_000,
          amount_paid: 0,
          currency: 'eur',
          attempt_count: 2,
        },
      },
    } as unknown as Stripe.Event

    const result = await handleStripeEvent(t.db, event)
    expect(result.handled).toBe(true)

    const rows = await t.client.query<{ event: string; payload: Record<string, unknown> }>(
      `select event, payload from license_events
        where organization_id = $1 and event = 'invoice.payment_failed'`,
      [org.orgId],
    )
    expect(rows.rows[0]!.payload).toMatchObject({ amountDueMinor: 12000, currencyCode: 'EUR' })
  })
})

describe('read-only enforcement end to end', () => {
  let t: TestDb
  let org: { orgId: string; ownerUserId: string }

  beforeAll(async () => {
    t = await createTestDb()
    org = await seedOrg(t, { name: 'Lapsed Co', slug: 'lapsed-co', seats: 5 })
  })

  afterAll(async () => {
    await t.close()
  })

  it('refuses a write and allows a read once the licence has lapsed', async () => {
    await t.sudo(`
      update licenses set status = 'suspended', valid_until = now() - interval '60 days',
                          grace_until = now() - interval '30 days'
       where organization_id = '${org.orgId}'
    `)

    const ctx = await resolveContext(t.db, {
      userId: org.ownerUserId,
      organizationId: org.orgId,
    })
    expect(ctx).not.toBeNull()
    expect(ctx!.licence.canWrite).toBe(false)

    const { requirePermission } = await import('@/server/context')

    // Reads still work. The customer's books are not a hostage.
    expect(() => requirePermission(ctx, 'invoice.read')).not.toThrow()
    expect(() => requirePermission(ctx, 'ledger.read')).not.toThrow()

    // Writes do not.
    expect(() => requirePermission(ctx, 'invoice.create')).toThrow(/read-only/i)
    expect(() => requirePermission(ctx, 'ledger.post')).toThrow(/read-only/i)

    // And the escape hatch is open.
    expect(() => requirePermission(ctx, 'license.manage')).not.toThrow()
    expect(() => requirePermission(ctx, 'gdpr.manage')).not.toThrow()
  })

  it('lets everything through again once the subscription is paid', async () => {
    await applySubscription(t.db, org.orgId, {
      subscriptionId: 'sub_revived',
      customerId: 'cus_revived',
      status: 'active',
      priceId: null,
      quantity: 5,
      currentPeriodEnd: iso(30),
      cancelAtPeriodEnd: false,
    })

    const ctx = await resolveContext(t.db, {
      userId: org.ownerUserId,
      organizationId: org.orgId,
    })
    expect(ctx!.licence.canWrite).toBe(true)

    const { requirePermission } = await import('@/server/context')
    expect(() => requirePermission(ctx, 'invoice.create')).not.toThrow()
  })

  it('keeps one tenant’s billing state out of another’s', async () => {
    const neighbour = await seedOrg(t, { name: 'Fine Co', slug: 'fine-co', seats: 5 })

    const rows = await withTenant(t.db, { organizationId: neighbour.orgId }, (tx) =>
      tx.execute(sql`select organization_id from licenses`),
    )
    const visible = (rows as unknown as { rows: { organization_id: string }[] }).rows
    expect(visible).toHaveLength(1)
    expect(visible[0]!.organization_id).toBe(neighbour.orgId)
  })
})
