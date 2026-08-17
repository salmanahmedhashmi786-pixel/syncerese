import { NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { db } from '@/db'
import { stripe } from '@/billing/stripe'
import { handleStripeEvent } from '@/billing/webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Stripe webhooks.
 *
 * THE SIGNATURE IS THE ONLY AUTHENTICATION. This endpoint is public — it has to
 * be, Stripe calls it — and everything it does changes what a customer is
 * entitled to. An unverified body here would let anyone on the internet grant
 * themselves an enterprise licence with a POST.
 *
 * Verification needs the RAW body, byte for byte. `await request.text()` before
 * any parsing is not a style choice: JSON.parse followed by re-serialisation
 * produces different bytes and every signature fails.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    // 503 rather than 200: this is a misconfiguration, and Stripe's retries are
    // exactly the right behaviour while it is being fixed.
    return NextResponse.json(
      { error: { code: 'NOT_CONFIGURED', message: 'STRIPE_WEBHOOK_SECRET is not set.' } },
      { status: 503 },
    )
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Missing signature.' } },
      { status: 400 },
    )
  }

  const raw = await request.text()

  let event: Stripe.Event
  try {
    // Also enforces a timestamp tolerance, which is what stops a captured
    // request being replayed days later.
    event = stripe().webhooks.constructEvent(raw, signature, secret)
  } catch (err) {
    console.error('[stripe] signature verification failed:', err)
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Invalid signature.' } },
      { status: 400 },
    )
  }

  try {
    const result = await handleStripeEvent(await db(), event)
    console.log(
      `[stripe] ${event.type} ${event.id} — ${result.handled ? 'applied' : 'skipped'}: ${result.note}`,
    )
    // 200 whether or not it was acted on. A recorded-but-not-actionable event
    // is not a failure, and returning anything else makes Stripe retry it for
    // days and fills the customer's dashboard with red.
    return NextResponse.json({ received: true }, { status: 200 })
  } catch (err) {
    // A genuine failure — the database was unreachable, or the handler threw.
    // 500 so Stripe retries; the event was claimed, but the claim is inside the
    // same transaction that failed, so the retry will re-claim cleanly.
    console.error(`[stripe] handler failed for ${event.type} ${event.id}:`, err)
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Handler failed.' } },
      { status: 500 },
    )
  }
}
