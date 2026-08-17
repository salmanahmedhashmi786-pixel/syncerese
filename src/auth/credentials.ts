import { and, eq, sql } from 'drizzle-orm'
import { users } from '@/db/schema'
import type { AnyDb } from '@/db/tenant'
import { withoutTenantScope } from '@/db/tenant'
import { verifyPassword } from './password'

/**
 * Password verification, in one place.
 *
 * Shared by the next-auth `authorize` callback and by the first step of the
 * sign-in form, which needs to know whether to ask for an authentication code
 * BEFORE it can complete the sign-in.
 *
 * Sharing it is the point. Two implementations would drift, and the one that
 * drifted would be the step-up check — quietly becoming a password oracle that
 * skips the lockout the real path applies. Here there is exactly one oracle,
 * with exactly one set of protections on it.
 */

/** Failed attempts before a temporary lock, and how long the lock lasts.
 *  In the DATABASE, not in memory, so it holds across app instances and across
 *  a restart — an in-process counter is trivially reset by whoever is attacking
 *  you (MUST DO #18). */
export const MAX_FAILED_ATTEMPTS = 8
export const LOCKOUT_MINUTES = 15

export type CredentialCheck =
  | { ok: false }
  | { ok: true; userId: string; email: string; name: string | null; mfaEnabled: boolean }

export async function checkCredentials(
  db: AnyDb,
  input: { email: string; password: string },
): Promise<CredentialCheck> {
  const email = input.email.trim().toLowerCase()

  return withoutTenantScope(db, async (tx) => {
    const found = await tx
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.status, 'active')))
      .limit(1)

    const user = found[0]

    // No early return for a missing user: verifyPassword() burns comparable
    // argon2 work on a null hash, so response timing does not distinguish
    // "no such account" from "wrong password".
    const locked = Boolean(user?.lockedUntil && user.lockedUntil > new Date())
    const ok = await verifyPassword(input.password, user?.passwordHash ?? null)

    if (!user || locked || !ok) {
      if (user && !locked && !ok) {
        await tx
          .update(users)
          .set({
            failedLoginCount: sql`${users.failedLoginCount} + 1`,
            lockedUntil: sql`case
              when ${users.failedLoginCount} + 1 >= ${MAX_FAILED_ATTEMPTS}
              then now() + interval '${sql.raw(String(LOCKOUT_MINUTES))} minutes'
              else ${users.lockedUntil} end`,
          })
          .where(eq(users.id, user.id))
      }
      return { ok: false }
    }

    return {
      ok: true,
      userId: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: Boolean(user.mfaEnabledAt),
    }
  })
}

/** Records a completed sign-in. Separate from the check because the check runs
 *  twice on an MFA login and this must run once, at the end. */
export async function recordSuccessfulSignIn(db: AnyDb, userId: string): Promise<void> {
  await withoutTenantScope(db, (tx) =>
    tx
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.id, userId)),
  )
}
