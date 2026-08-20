'use server'

import { callerFingerprint } from '@/server/caller'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { withoutTenantScope } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { signUp } from '@/server/onboarding'
import { effectiveSignupMode } from '@/server/signup-mode'

/**
 * Self-service signup.
 *
 * The only route by which a deployed instance acquires its first organization —
 * `db:seed` is a development convenience and never runs against production.
 *
 * A server action is a public HTTP endpoint. Everything defensive about this
 * path lives here and in `signUp`, not in the form: the form is a convenience
 * for humans, not a control.
 */

type Result = { ok: true; slug: string } | { ok: false; error: string }

/** Signups per address per window. Generous for a real business behind one
 *  office NAT, useless to someone farming tenants. */
const ATTEMPT_LIMIT = 5
const ATTEMPT_WINDOW = '1 hour'

export async function signUpAction(input: {
  organizationName: string
  name: string
  email: string
  password: string
  countryCode?: string
  baseCurrency?: string
}): Promise<Result> {
  // Desktop: open while no workspace exists, closed for ever after. See
  // effectiveSignupMode — a desktop install has no operator to open it.
  if ((await effectiveSignupMode()) !== 'open') {
    return {
      ok: false,
      error: 'This installation does not accept new organizations. Ask an administrator for an invitation.',
    }
  }

  const handle = await db()

  if (!(await consumeAttempt(handle))) {
    return {
      ok: false,
      error: 'Too many signup attempts from this network. Try again in an hour.',
    }
  }

  try {
    const result = await signUp(handle, input)
    return { ok: true, slug: result.slug }
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message }
    // The real error goes to the server log; the caller gets nothing that
    // describes the schema, the connection or another tenant.
    console.error('[signup]', err)
    return { ok: false, error: 'Could not create the account. Try again in a moment.' }
  }
}

/** Consumes one attempt for the caller's address. Returns false when spent. */
async function consumeAttempt(handle: Awaited<ReturnType<typeof db>>): Promise<boolean> {
  const ipHash = await callerFingerprint()
  const res = await withoutTenantScope(handle, (tx) =>
    tx.execute(
      sql`select public.consume_signup_attempt(
            ${ipHash}, ${ATTEMPT_LIMIT}, ${ATTEMPT_WINDOW}::interval
          ) as allowed`,
    ),
  )
  return (res as unknown as { rows: { allowed: boolean }[] }).rows[0]?.allowed ?? true
}
