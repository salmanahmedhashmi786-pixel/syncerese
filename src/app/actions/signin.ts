'use server'

import { createHash } from 'node:crypto'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { withoutTenantScope } from '@/db/tenant'
import { checkCredentials } from '@/auth/credentials'

/**
 * The first step of signing in.
 *
 * It answers one question: does this account need an authentication code? The
 * form cannot know that before the password is verified, and asking everyone
 * for a code they do not have is worse than a second step.
 *
 * This runs the SAME `checkCredentials` the next-auth callback runs, including
 * the account lockout. That matters — a separate, gentler verification here
 * would be a password oracle with none of the protections the real path has.
 *
 * It deliberately does NOT create a session. Only next-auth does that, after
 * the second factor.
 */

/** Attempts per address per window. Generous for an office behind one NAT,
 *  useless for spraying one password across thousands of addresses. */
const ATTEMPT_LIMIT = 20
const ATTEMPT_WINDOW = '15 minutes'

type Result =
  | { ok: true; mfaRequired: boolean }
  | { ok: false; error: string }

export async function beginSignInAction(input: {
  email: string
  password: string
}): Promise<Result> {
  const handle = await db()
  const fingerprint = await callerFingerprint()

  const allowed = await withoutTenantScope(handle, async (tx) => {
    const res = await tx.execute(sql`
      select public.consume_signin_attempt(
        ${fingerprint}, ${ATTEMPT_LIMIT}, ${ATTEMPT_WINDOW}::interval
      ) as allowed
    `)
    return (res as unknown as { rows: { allowed: boolean }[] }).rows[0]?.allowed ?? true
  })

  if (!allowed) {
    // Said plainly. A generic failure here would have people retrying, which is
    // exactly the behaviour the throttle is trying to stop.
    return {
      ok: false,
      error: 'Too many sign-in attempts from this network. Wait a few minutes and try again.',
    }
  }

  const check = await checkCredentials(handle, input)

  if (!check.ok) {
    // ONE message for every failure mode. "No such account", "wrong password"
    // and "temporarily locked" must be indistinguishable, or the form becomes
    // an account-enumeration oracle.
    return { ok: false, error: 'Sign-in failed. Check your email and password.' }
  }

  // The credentials were right, so this address is not the one being sprayed.
  // Without this an office of twenty people behind one NAT locks itself out on
  // an ordinary Monday morning.
  await withoutTenantScope(handle, (tx) =>
    tx.execute(sql`select public.clear_signin_attempts(${fingerprint})`),
  )

  return { ok: true, mfaRequired: check.mfaEnabled }
}

/**
 * A stable, non-reversible handle for the caller's network.
 *
 * Salted with AUTH_SECRET: an IPv4 address is 32 bits, so an unsalted hash is
 * plaintext with extra steps. Nothing reads this back — it exists only as a
 * throttle key.
 */
async function callerFingerprint(): Promise<string> {
  const h = await headers()
  const trustProxy = process.env.TRUST_PROXY_HEADERS !== 'false'
  const forwarded = trustProxy ? (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() : ''
  const ip = forwarded || h.get('x-real-ip') || 'unknown'

  return createHash('sha256')
    .update(`signin|${ip}|${process.env.AUTH_SECRET ?? 'dev'}`)
    .digest('base64url')
    .slice(0, 43)
}
