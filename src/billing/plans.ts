/**
 * The plan catalogue.
 *
 * PRICES ARE NOT HERE. They live in Stripe, and are read from it when a page
 * needs to show one. Hard-coding an amount gives you two sources of truth for
 * what a customer pays, and the one in the code is the one that goes stale —
 * silently, and in the direction of quoting a price you no longer charge.
 *
 * What IS here is the shape of each tier: what it is called, what it includes,
 * and which Stripe Price it maps to. The Price ids come from the environment
 * because they differ between a test and a live Stripe account, and putting a
 * live price id in source control is how a staging deployment ends up charging
 * real cards.
 *
 * Billing is PER SEAT. That is not an arbitrary choice: the licence carries a
 * `seat_count`, the seat limit is a database trigger, and MUST DO #16 defines a
 * seat as a person. The Stripe subscription's quantity IS the licensed seat
 * count, and the two are kept equal by the webhook handler.
 */

export type PlanKey = 'starter' | 'professional' | 'enterprise'

export type Plan = {
  key: PlanKey
  name: string
  /** One line, for the plan picker. */
  tagline: string
  /** Stripe Price id — per seat, recurring. Empty when unconfigured. */
  priceId: string
  /** Fewer seats than this cannot be bought on this plan. */
  minSeats: number
  /** Above this, the buyer talks to a human. null = no ceiling. */
  maxSeats: number | null
  features: string[]
}

/**
 * The trial every new tenant starts on. Not purchasable and not in Stripe — it
 * is granted at signup and has no payment instrument behind it.
 */
export const TRIAL = { key: 'trial' as const, seats: 5, days: 30 }

export const PLANS: Plan[] = [
  {
    key: 'starter',
    name: 'Starter',
    tagline: 'For a small team keeping its own books.',
    priceId: process.env.STRIPE_PRICE_STARTER ?? '',
    minSeats: 1,
    maxSeats: 10,
    features: [
      'Full double-entry ledger',
      'Invoicing, payments and bank import',
      'Customers, products and stock',
      'Email support',
    ],
  },
  {
    key: 'professional',
    name: 'Professional',
    tagline: 'For a business running sales and purchasing properly.',
    priceId: process.env.STRIPE_PRICE_PROFESSIONAL ?? '',
    minSeats: 3,
    maxSeats: 50,
    features: [
      'Everything in Starter',
      'Sales orders and procure-to-pay with three-way match',
      'Custom fields, saved views and automation rules',
      'Public API and webhooks',
    ],
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    tagline: 'For multi-entity operations with their own requirements.',
    priceId: process.env.STRIPE_PRICE_ENTERPRISE ?? '',
    minSeats: 25,
    maxSeats: null,
    features: [
      'Everything in Professional',
      'SSO via Google or Microsoft Entra',
      'Priority support and onboarding',
      'EU or US data residency',
    ],
  },
]

export function planByKey(key: string): Plan | undefined {
  return PLANS.find((p) => p.key === key)
}

/** The plan a Stripe Price id belongs to. How a webhook works out what was
 *  bought, since Stripe reports the price, not our plan name. */
export function planByPriceId(priceId: string): Plan | undefined {
  return priceId ? PLANS.find((p) => p.priceId === priceId) : undefined
}

/** Plans that can actually be sold on this deployment. A plan with no Price id
 *  configured is hidden rather than offered and then failing at checkout. */
export function purchasablePlans(): Plan[] {
  return PLANS.filter((p) => p.priceId !== '')
}

/**
 * Whether Stripe is wired up at all.
 *
 * Everything billing-related degrades to an honest "not configured" message
 * when it is not, exactly like the OAuth providers. A half-configured billing
 * page that throws on click is worse than one that says it is not set up.
 */
export function billingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY) && purchasablePlans().length > 0
}

/** Seats must be within the plan's band, and never below what is already in
 *  use — the caller passes that in, because this module does not touch the
 *  database. */
export function clampSeats(plan: Plan, requested: number, seatsInUse: number): number {
  const floor = Math.max(plan.minSeats, seatsInUse, 1)
  const ceiling = plan.maxSeats ?? Number.MAX_SAFE_INTEGER
  return Math.min(Math.max(requested, floor), ceiling)
}
