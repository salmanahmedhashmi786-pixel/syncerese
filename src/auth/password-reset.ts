import { sql } from 'drizzle-orm'
import type { AnyDb } from '@/db/tenant'
import { newId } from '@/lib/ids'
import { generateToken, hashOpaqueToken, hashPassword, passwordPolicy } from './password'
import { sendEmail } from '@/email/send'
import { passwordChangedEmail, passwordResetEmail } from '@/email/templates'

/**
 * Password reset.
 *
 * The decisions, in one place, because this is the flow most often got wrong:
 *
 * NO USER ENUMERATION. `requestReset` returns the same thing whether or not the
 * address exists, whether the account is deactivated, and whether it signs in
 * with Google instead. An endpoint that says "no such user" is a free
 * membership oracle for anybody with a list of email addresses.
 *
 * THE TOKEN IS STORED HASHED and is single use. Claiming it and marking it
 * consumed happen in one statement, so two racing requests cannot both spend it.
 *
 * A RESET REVOKES OTHER SESSIONS. Sessions are JWTs and cannot be deleted, so
 * `credentials_changed_at` is stamped and the auth callback refuses tokens
 * issued before it. Without this a reset after a compromise leaves the attacker
 * signed in for the rest of their token's life.
 *
 * A RESET DOES NOT BYPASS MFA. Nothing here touches the second factor. Somebody
 * who has taken a mailbox still has to produce a code, which is the whole point
 * of having one.
 *
 * IT DOES clear the lockout. A person who forgot their password has usually
 * just failed to guess it eight times; leaving them locked out after a
 * successful reset is a support call for no security benefit, because they have
 * proved control of the mailbox and set a new secret.
 */

/** Long enough to walk to a laptop, short enough that a link left in a mailbox
 *  is not a standing key to the account. Exported: an administrator issuing a
 *  reset directly (src/server/members.ts) uses the same lifetime. */
export const TOKEN_TTL_MINUTES = 60

/** Per network, per hour. Generous for a household or an office behind one
 *  address, mean enough that enumerating a list of addresses is slow. */
const RATE_LIMIT = 10
const RATE_WINDOW = '1 hour'

/** Exported for the same reason as `TOKEN_TTL_MINUTES`: an admin-issued reset
 *  (src/server/members.ts) writes into the same `password_reset_tokens` table
 *  and must hash its token the same way, or `completeReset` cannot find it. */
export const hashToken = (token: string): string => hashOpaqueToken(`pwreset:${token}`)

export type ResetRequest = {
  email: string
  /** Already hashed by the caller — this module never sees a raw address. */
  ipHash: string | null
  /** Absolute base URL for the link. */
  appUrl: string
}

export type RequestOutcome = {
  /**
   * Whether a message was actually sent. NOT returned to the browser — the
   * response there is identical either way — but the caller logs it, and the
   * dev-mode page uses it to explain why nothing arrived.
   */
  sent: boolean
  /** Only when SMTP is unconfigured AND the deployment is not production, so a
   *  developer can finish the flow without a mail server. Never in production. */
  devLink?: string
}

export async function requestReset(db: AnyDb, input: ResetRequest): Promise<RequestOutcome> {
  const email = input.email.trim().toLowerCase()

  // Throttled before the lookup, so a caller cannot use response timing to tell
  // an existing address from an absent one by how much work each one caused.
  if (input.ipHash) {
    const allowed = await db.execute(sql`
      select public.consume_reset_attempt(${input.ipHash}, ${RATE_LIMIT}, ${RATE_WINDOW}::interval) as ok
    `)
    const ok = (allowed as unknown as { rows: { ok: boolean }[] }).rows[0]?.ok
    if (!ok) return { sent: false }
  }

  const found = await db.execute(sql`
    select user_id as "userId", email, name from public.resolve_reset_recipient(${email})
  `)
  const user = (
    found as unknown as { rows: { userId: string; email: string; name: string | null }[] }
  ).rows[0]

  // No such account, deactivated, erased, or SSO-only. The caller is told
  // nothing — see the note above.
  if (!user) return { sent: false }

  const token = generateToken(32)

  // Through the function, not an INSERT: the application role has no privilege
  // on `password_reset_tokens` at all, so a bug or an injection here cannot
  // enumerate live tokens. The one-hour lifetime is set by the function too.
  await db.execute(sql`
    select public.issue_password_reset(
      ${newId()}::uuid, ${user.userId}::uuid, ${hashToken(token)}, ${input.ipHash}
    )
  `)

  const url = `${input.appUrl.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`
  const result = await sendEmail(passwordResetEmail(user.email, url, TOKEN_TTL_MINUTES))

  if (result.sent) return { sent: true }

  // Unconfigured SMTP outside production: hand the link back so a developer can
  // finish the flow. Guarded on NODE_ENV rather than on a flag somebody could
  // set by accident — returning a live reset link to an unauthenticated caller
  // in production would be the whole vulnerability in one line.
  if (result.reason === 'not-configured' && process.env.NODE_ENV !== 'production') {
    return { sent: false, devLink: url }
  }
  return { sent: false }
}

export type ResetOutcome =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Spends a token and sets the new password.
 *
 * Every failure returns the same message. "That link has expired" and "that
 * link was already used" are useful to a legitimate user and equally useful to
 * somebody testing tokens, and the legitimate user's next step is the same
 * either way: ask for a new one.
 */
export async function completeReset(
  db: AnyDb,
  token: string,
  newPassword: string,
): Promise<ResetOutcome> {
  const policy = passwordPolicy(newPassword)
  if (!policy.ok) return { ok: false, error: policy.reason }

  const claimed = await db.execute(sql`
    select public.consume_password_reset(${hashToken(token)}) as user_id
  `)
  const userId = (claimed as unknown as { rows: { user_id: string | null }[] }).rows[0]?.user_id
  if (!userId) {
    return { ok: false, error: 'That link is not valid any more. Ask for a new one.' }
  }

  const hash = await hashPassword(newPassword)

  await db.execute(sql`
    update users
       set password_hash = ${hash},
           -- Revokes every existing JWT session. See drizzle/0023.
           credentials_changed_at = now(),
           -- The person proved control of the mailbox and set a new secret;
           -- leaving them locked out helps nobody.
           failed_login_count = 0,
           locked_until = null,
           updated_at = now()
     where id = ${userId}::uuid
  `)

  // Any other outstanding tokens for this account die with the one just used.
  // Two resets requested in a panic should not leave a second live key behind.
  await db.execute(sql`select public.invalidate_password_resets(${userId}::uuid)`)

  const recipient = await db.execute(sql`select email from users where id = ${userId}::uuid`)
  const address = (recipient as unknown as { rows: { email: string }[] }).rows[0]?.email
  if (address) {
    // After the fact, and not a formality: this is how somebody discovers that
    // an attacker who reached their mailbox has taken the account.
    await sendEmail(passwordChangedEmail(address))
  }

  return { ok: true }
}

/** Whether a token could be spent, without spending it — so the page can say
 *  "this link has expired" before asking somebody to type a new password twice. */
export async function tokenLooksValid(db: AnyDb, token: string): Promise<boolean> {
  const res = await db.execute(sql`
    select public.password_reset_valid(${hashToken(token)}) as ok
  `)
  return Boolean((res as unknown as { rows: { ok: boolean }[] }).rows[0]?.ok)
}
