import Stripe from 'stripe'

/**
 * The Stripe client.
 *
 * Server-side only. `STRIPE_SECRET_KEY` is a live-money credential and must
 * never reach a bundle the browser can read — nothing in this file is imported
 * from a client component, and the secret is read from the environment rather
 * than passed around.
 *
 * Lazily constructed and cached, so importing this module in a test or a build
 * step does not require a key to exist.
 */

let client: Stripe | undefined

export function stripe(): Stripe {
  if (client) return client

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Billing is not configured on this deployment — ' +
        'callers should check billingConfigured() before reaching Stripe.',
    )
  }

  client = new Stripe(key, {
    // Pinned. Stripe changes response shapes between versions, and inheriting
    // whatever the account default happens to be means a dashboard setting
    // someone else changes can break parsing in production.
    apiVersion: '2026-07-29.dahlia',
    // Named so a Stripe support conversation can identify the integration.
    appInfo: { name: 'Syncrese', url: 'https://syncrese.com' },
    // Stripe's client already retries idempotently on network failure; two is
    // enough to ride out a blip without holding a request open for a minute.
    maxNetworkRetries: 2,
    timeout: 15_000,
  })
  return client
}

/** Test seam. */
export function __setStripeForTests(fake: Stripe | undefined): void {
  client = fake
}

/**
 * Money out of Stripe.
 *
 * Stripe reports amounts in the currency's minor unit, which is the same
 * convention this codebase uses everywhere (see finance/money.ts) — so this is
 * a rename rather than a conversion, and deliberately does NOT divide by 100.
 * Zero-decimal currencies like JPY would make that wrong anyway.
 */
export type StripeAmount = { amountMinor: number; currencyCode: string }

export function amountFrom(
  amount: number | null | undefined,
  currency: string | null | undefined,
): StripeAmount | null {
  if (amount === null || amount === undefined || !currency) return null
  return { amountMinor: amount, currencyCode: currency.toUpperCase() }
}
