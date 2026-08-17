'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { AppError } from '@/lib/errors'
import { createCheckoutSession, createPortalSession } from '@/billing/service'
import { activateProductKey } from '@/licensing/keys'

/**
 * Billing actions.
 *
 * Both of these return a Stripe URL for the browser to go to. Neither takes a
 * card, a price or an amount — the price lives in Stripe and the seat count is
 * clamped server-side against the seats actually in use. A client that posted
 * `{ plan: 'enterprise', seats: 500, price: 0 }` would change nothing.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[billing]', err)
  return { ok: false, error: 'Could not reach the billing provider. Try again in a moment.' }
}

export async function startCheckoutAction(input: {
  planKey: string
  seats: number
}): Promise<Result<{ url: string }>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    // Resolved before the transaction opens — `headers()` is async, and an
    // await inside the non-async callback is a syntax error.
    const returnUrl = `${await origin()}/settings`
    const handle = await db()
    const result = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) =>
        createCheckoutSession(tx, ctx, {
          planKey: input.planKey,
          seats: Number(input.seats),
          returnUrl,
        }),
    )
    return { ok: true, data: result }
  } catch (err) {
    return fail(err)
  }
}

export async function openBillingPortalAction(): Promise<Result<{ url: string }>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const returnUrl = `${await origin()}/settings`
    const handle = await db()
    const result = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => createPortalSession(tx, ctx, returnUrl),
    )
    return { ok: true, data: result }
  } catch (err) {
    return fail(err)
  }
}

/** Where Stripe sends the customer back to. Derived from the request rather
 *  than hard-coded, so previews and self-hosted installs return to themselves. */
async function origin(): Promise<string> {
  const configured = process.env.AUTH_URL
  if (configured) return configured.replace(/\/+$/, '')
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

/**
 * Redeems a product key.
 *
 * The non-Stripe path: a customer who was sent a key types it here and their
 * licence is extended. Lives alongside the billing actions because from the
 * tenant's point of view it is the same thing — paying for access.
 */
export async function activateKeyAction(key: string): Promise<
  Result<{ validUntil: string; seats: number; durationDays: number }>
> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    const result = await activateProductKey(handle, ctx, key)
    revalidatePath('/settings')
    return {
      ok: true,
      data: {
        validUntil: result.validUntil,
        seats: result.seats,
        durationDays: result.durationDays,
      },
    }
  } catch (err) {
    return fail(err)
  }
}
