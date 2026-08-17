import { createHash } from 'node:crypto'
import { headers } from 'next/headers'

/**
 * A throttle key for an unauthenticated caller.
 *
 * HASHED, and never stored or logged in the clear. It is a rate-limit bucket,
 * not a record of who did what — an IP address tied to an action is personal
 * data, and the throttle works exactly as well against an opaque key.
 *
 * Shared by signup, sign-in and password reset. It lived inside the signup
 * action first; a second copy in the reset flow would be a second place for the
 * proxy-header decision below to drift, and that decision is the difference
 * between a working throttle and one an attacker sidesteps per request.
 */
export async function callerFingerprint(): Promise<string> {
  const h = await headers()
  // x-forwarded-for is client-controlled unless a trusted proxy sets it. Behind
  // Vercel or a correctly configured reverse proxy the LEFT-most entry is the
  // real client; a bare origin server should not be reading it at all, which is
  // what TRUST_PROXY_HEADERS gates.
  const trustProxy = process.env.TRUST_PROXY_HEADERS !== 'false'
  const forwarded = trustProxy ? (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() : ''
  const ip = forwarded || h.get('x-real-ip') || 'unknown'

  return createHash('sha256')
    .update(`${ip}|${process.env.AUTH_SECRET ?? 'dev'}`)
    .digest('base64url')
    .slice(0, 43)
}
