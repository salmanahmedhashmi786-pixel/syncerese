import { billingConfigured, purchasablePlans } from './plans'
import { stripe } from './stripe'

/**
 * The plan list with LIVE prices from Stripe.
 *
 * Prices are read rather than stored so there is one source of truth for what a
 * customer pays. The cost of that is a network call, so the result is cached in
 * the process for a few minutes — prices change perhaps twice a year, and a
 * settings page that makes a Stripe round trip on every render is a settings
 * page that is slow for no reason.
 */

export type PricedPlan = {
  key: string
  name: string
  tagline: string
  minSeats: number
  maxSeats: number | null
  features: string[]
  price: { amountMinor: number; currencyCode: string; interval: string } | null
}

const TTL_MS = 5 * 60_000
let cache: { at: number; plans: PricedPlan[] } | undefined

export async function pricedPlans(): Promise<PricedPlan[]> {
  if (!billingConfigured()) return []

  if (cache && Date.now() - cache.at < TTL_MS) return cache.plans

  const plans = purchasablePlans()

  const priced = await Promise.all(
    plans.map(async (plan): Promise<PricedPlan> => {
      const base = {
        key: plan.key,
        name: plan.name,
        tagline: plan.tagline,
        minSeats: plan.minSeats,
        maxSeats: plan.maxSeats,
        features: plan.features,
      }
      try {
        const price = await stripe().prices.retrieve(plan.priceId)
        return {
          ...base,
          price:
            price.unit_amount === null || !price.currency
              ? null
              : {
                  amountMinor: price.unit_amount,
                  currencyCode: price.currency.toUpperCase(),
                  interval: price.recurring?.interval ?? 'month',
                },
        }
      } catch (err) {
        // A price id that no longer exists, or Stripe being unreachable. The
        // plan is still listed with its price blank rather than the whole
        // settings page failing — the customer can still reach the portal, and
        // that matters more than showing an amount.
        console.error(`[billing] could not read price ${plan.priceId}:`, err)
        return { ...base, price: null }
      }
    }),
  )

  cache = { at: Date.now(), plans: priced }
  return priced
}

/** Test seam, and the escape hatch after a price change in Stripe. */
export function clearPlanCache(): void {
  cache = undefined
}
