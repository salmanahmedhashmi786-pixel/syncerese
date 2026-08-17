'use server'

import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { organizations } from '@/db/schema'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { auth } from '@/auth'
import { getSession } from '@/server/session'
import { requirePermission } from '@/server/context'
import { AppError } from '@/lib/errors'
import { writeAudit } from '@/lib/audit'
import { encryptionConfigured } from '@/lib/crypto'
import {
  adminsWithoutMfa,
  beginEnrolment,
  confirmEnrolment,
  disableMfa,
  mfaStateFor,
} from '@/auth/mfa'

/**
 * Account security.
 *
 * MFA is a property of a PERSON, not of a tenant, so these act on the
 * authenticated user rather than going through the tenant context — the same
 * account is enrolled once and that enrolment follows them into every
 * organization they belong to.
 */

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[security]', err)
  return { ok: false, error: 'Something went wrong.' }
}

export async function beginMfaEnrolmentAction(): Promise<
  Result<{ secret: string; uri: string }>
> {
  const session = await auth()
  const email = session?.user?.email
  if (!session?.user?.id || !email) return { ok: false, error: 'Sign in to continue.' }

  if (!encryptionConfigured()) {
    // Said plainly rather than failing at the confirm step, which would leave
    // somebody having scanned a QR code for a secret that could not be stored.
    return {
      ok: false,
      error:
        'Multi-factor authentication needs ENCRYPTION_KEY to be configured on this deployment — ' +
        'the secret has to be encrypted at rest. See docs/03-deployment.md.',
    }
  }

  try {
    return { ok: true, data: beginEnrolment(email) }
  } catch (err) {
    return fail(err)
  }
}

export async function confirmMfaEnrolmentAction(input: {
  secret: string
  code: string
}): Promise<Result<{ recoveryCodes: string[] }>> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    const result = await confirmEnrolment(handle, {
      userId,
      secret: input.secret,
      code: input.code,
    })
    revalidatePath('/settings')
    return { ok: true, data: result }
  } catch (err) {
    return fail(err)
  }
}

export async function disableMfaAction(input: { code: string }): Promise<Result> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    // Requires a current code — a stolen session must not be able to quietly
    // strip the factor that would have stopped it.
    await disableMfa(handle, { userId, code: input.code })
    revalidatePath('/settings')
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function mfaStatusAction(): Promise<
  Result<{ enabled: boolean; recoveryCodesRemaining: number; encryptionReady: boolean }>
> {
  const session = await auth()
  const userId = session?.user?.id
  if (!userId) return { ok: false, error: 'Sign in to continue.' }

  const state = await mfaStateFor(await db(), userId)
  return {
    ok: true,
    data: {
      enabled: state.enabled,
      recoveryCodesRemaining: state.recoveryCodesRemaining,
      encryptionReady: encryptionConfigured(),
    },
  }
}

/**
 * Turns the organization-wide requirement on or off.
 *
 * Reports who would be affected rather than silently locking them out — the
 * person switching this on is usually an owner who has just enrolled and has no
 * idea whether their colleagues have.
 */
export async function setMfaPolicyAction(required: boolean): Promise<
  Result<{ affected: { email: string; role: string }[] }>
> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    const affected = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      async (tx) => {
        requirePermission(ctx, 'org.update')

        const outstanding = required ? await adminsWithoutMfa(tx, ctx.organizationId) : []

        await tx
          .update(organizations)
          .set({ requireMfaForAdmins: required })
          .where(eq(organizations.id, ctx.organizationId))

        await writeAudit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'org.mfa_policy_changed',
          entityType: 'organization',
          entityId: ctx.organizationId,
          after: { requireMfaForAdmins: required, adminsWithoutMfa: outstanding.length },
          requestId: ctx.requestId,
          ip: ctx.ip,
        })

        return outstanding
      },
    )

    revalidatePath('/settings')
    return { ok: true, data: { affected } }
  } catch (err) {
    return fail(err)
  }
}
