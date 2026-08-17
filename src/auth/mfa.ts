import { and, eq, sql } from 'drizzle-orm'
import { memberships, organizations, users } from '@/db/schema'
import type { AnyDb, TenantTx } from '@/db/tenant'
import { withoutTenantScope } from '@/db/tenant'
import { AppError, forbidden } from '@/lib/errors'
import { decrypt, encrypt } from '@/lib/crypto'
import { hashOpaqueToken } from './password'
import {
  generateRecoveryCodes,
  generateSecret,
  normaliseRecoveryCode,
  otpauthUri,
  verifyTotp,
} from './totp'

/**
 * Multi-factor authentication.
 *
 * The secret is encrypted at rest (AES-256-GCM, see lib/crypto.ts) rather than
 * hashed, because TOTP verification needs the secret itself — there is nothing
 * to compare a hash against. That makes ENCRYPTION_KEY genuinely load-bearing:
 * lose it and every enrolled user has to re-enrol.
 *
 * Recovery codes ARE hashed, like every other opaque secret in this codebase,
 * because verifying one only needs a comparison.
 */

const ISSUER = 'Syncrèse'

export type EnrolmentChallenge = {
  /** base32, shown for manual entry when a camera is not available. */
  secret: string
  /** What the authenticator app scans. */
  uri: string
}

/**
 * Step one: generate a secret and hand back the URI.
 *
 * Deliberately NOT stored as enabled yet. Writing `mfa_enabled_at` here would
 * mean a user who scanned the code but never proved they could generate one is
 * locked out of their own account by a factor they do not have.
 */
export function beginEnrolment(email: string): EnrolmentChallenge {
  const secret = generateSecret()
  return { secret, uri: otpauthUri({ issuer: ISSUER, account: email, secret }) }
}

export type EnrolmentResult = {
  /** Shown ONCE. Only hashes are stored, so they cannot be shown again. */
  recoveryCodes: string[]
}

/**
 * Step two: they type a code from the app, proving enrolment worked.
 *
 * Only now is the secret stored and MFA switched on.
 */
export async function confirmEnrolment(
  db: AnyDb,
  input: { userId: string; secret: string; code: string },
): Promise<EnrolmentResult> {
  const counter = verifyTotp(input.secret, input.code)
  if (counter === null) {
    throw new AppError(
      'VALIDATION_FAILED',
      'That code is not right. Check your authenticator app is showing the current code, and ' +
        'that your phone’s clock is set automatically.',
    )
  }

  const codes = generateRecoveryCodes()

  await withoutTenantScope(db, async (tx) => {
    const current = (
      await tx
        .select({ enabledAt: users.mfaEnabledAt })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
    )[0]
    if (!current) throw new AppError('NOT_FOUND', 'No such account.')
    if (current.enabledAt) {
      throw new AppError(
        'CONFLICT',
        'Multi-factor authentication is already on for this account. Turn it off first if you ' +
          'want to move to a different device.',
      )
    }

    await tx
      .update(users)
      .set({
        mfaSecretEncrypted: encrypt(input.secret),
        mfaEnabledAt: new Date(),
        // The code just used cannot be reused to sign in.
        mfaLastCounter: counter,
        mfaRecoveryCodesHashed: codes.map((c) => hashOpaqueToken(normaliseRecoveryCode(c))),
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.userId))
  })

  return { recoveryCodes: codes }
}

/**
 * Turns MFA off.
 *
 * Requires a current code or a recovery code — not just the session. A session
 * can be stolen; requiring the second factor to remove the second factor means
 * a hijacked session cannot quietly strip it.
 */
export async function disableMfa(
  db: AnyDb,
  input: { userId: string; code: string },
): Promise<void> {
  const state = await mfaStateFor(db, input.userId)
  if (!state.enabled) return

  const ok = await consumeSecondFactor(db, input.userId, input.code)
  if (!ok) throw new AppError('VALIDATION_FAILED', 'That code is not right.')

  await withoutTenantScope(db, (tx) =>
    tx
      .update(users)
      .set({
        mfaSecretEncrypted: null,
        mfaEnabledAt: null,
        mfaLastCounter: null,
        mfaRecoveryCodesHashed: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, input.userId)),
  )
}

export type MfaState = {
  enabled: boolean
  enabledAt: string | null
  recoveryCodesRemaining: number
}

export async function mfaStateFor(db: AnyDb, userId: string): Promise<MfaState> {
  const row = await withoutTenantScope(db, async (tx) => {
    const rows = await tx
      .select({
        enabledAt: users.mfaEnabledAt,
        codes: users.mfaRecoveryCodesHashed,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    return rows[0]
  })

  const codes = (row?.codes as string[] | null) ?? []
  return {
    enabled: Boolean(row?.enabledAt),
    enabledAt: row?.enabledAt ? row.enabledAt.toISOString() : null,
    recoveryCodesRemaining: codes.length,
  }
}

/** Whether this account needs a second factor to sign in. */
export async function mfaRequiredFor(db: AnyDb, userId: string): Promise<boolean> {
  return (await mfaStateFor(db, userId)).enabled
}

/**
 * Checks a TOTP code or a recovery code, and consumes it.
 *
 * "Consumes" is the important half. A TOTP code stays valid for up to 90
 * seconds, so the counter is recorded to stop a replay; a recovery code is
 * removed from the list, because a recovery code that still works after it has
 * been used is a permanent password.
 */
export async function consumeSecondFactor(
  db: AnyDb,
  userId: string,
  code: string,
): Promise<boolean> {
  return withoutTenantScope(db, async (tx) => {
    const row = (
      await tx
        .select({
          secret: users.mfaSecretEncrypted,
          lastCounter: users.mfaLastCounter,
          codes: users.mfaRecoveryCodesHashed,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    )[0]

    if (!row?.secret) return false

    let secret: string
    try {
      secret = decrypt(row.secret)
    } catch (err) {
      // The key is gone or the value was tampered with. Refusing is the only
      // safe answer, and it must be loud in the log — every enrolled user is
      // about to be locked out and support needs to know why.
      console.error('[mfa] could not decrypt the stored secret:', err)
      return false
    }

    const counter = verifyTotp(secret, code, { lastUsedCounter: row.lastCounter })
    if (counter !== null) {
      await tx.update(users).set({ mfaLastCounter: counter }).where(eq(users.id, userId))
      return true
    }

    // Not a TOTP code — try the recovery list.
    const stored = (row.codes as string[] | null) ?? []
    if (stored.length === 0) return false

    const attempted = hashOpaqueToken(normaliseRecoveryCode(code))
    const index = stored.indexOf(attempted)
    if (index === -1) return false

    const remaining = stored.filter((_, i) => i !== index)
    await tx
      .update(users)
      .set({ mfaRecoveryCodesHashed: remaining, updatedAt: new Date() })
      .where(eq(users.id, userId))

    return true
  })
}

/**
 * Enforces an organization's "admins must use MFA" policy.
 *
 * Checked at the point of USE, not at sign-in. Blocking the sign-in of an admin
 * who has not enrolled yet would lock out the person who just turned the policy
 * on — they need to get in far enough to reach the security panel.
 */
export async function assertMfaPolicySatisfied(
  tx: TenantTx,
  input: { organizationId: string; userId: string; role: string; mfaEnabled: boolean },
): Promise<void> {
  if (input.mfaEnabled) return
  if (input.role !== 'owner' && input.role !== 'admin') return

  const rows = await tx
    .select({ required: organizations.requireMfaForAdmins })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1)

  if (!rows[0]?.required) return

  throw forbidden(
    'This organization requires owners and administrators to use multi-factor authentication. ' +
      'Set it up in Settings → Security to continue.',
  )
}

/** How many people would be locked out of admin actions if the policy were
 *  switched on right now. Shown before the switch, not after. */
export async function adminsWithoutMfa(
  tx: TenantTx,
  organizationId: string,
): Promise<{ email: string; role: string }[]> {
  const res = await tx.execute(sql`
    select u.email, r.key as role
      from memberships m
      join users u on u.id = m.user_id
      join roles r on r.id = m.role_id
     where m.organization_id = ${organizationId}
       and m.status = 'active'
       and r.key in ('owner', 'admin')
       and u.mfa_enabled_at is null
     order by u.email
  `)
  return (res as unknown as { rows: { email: string; role: string }[] }).rows
}

// Referenced by the policy query above through raw SQL.
void memberships
void and
