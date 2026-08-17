'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '@/auth'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { assertPlatformAdmin } from '@/licensing/platform'
import { issueProductKey, revokeProductKey } from '@/licensing/keys'

/**
 * Platform key issuance.
 *
 * Every action here re-checks platform administration against the DATABASE.
 * These are public HTTP endpoints like any other server action — "only the
 * admin page calls this" is not access control, and what they can do is issue a
 * licence for any organization on the installation.
 */

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[admin-keys]', err)
  return { ok: false, error: 'Something went wrong.' }
}

export async function issueKeyAction(input: {
  organizationId: string
  durationDays: number
  seatCount?: number
  plan?: string
  note?: string
}): Promise<Result<{ key: string; expiresAt: string; durationDays: number }>> {
  try {
    const session = await auth()
    const userId = session?.user?.id ?? null
    const handle = await db()
    await assertPlatformAdmin(handle, userId)

    // Scoped to the TARGET tenant. A platform admin issuing for org X sets the
    // scope to X deliberately, rather than reaching across tenants with the
    // policies off — the RLS predicate still applies to every write.
    const issued = await withTenant(
      handle,
      { organizationId: input.organizationId, userId },
      (tx) =>
        issueProductKey(
          tx,
          {
            organizationId: input.organizationId,
            durationDays: Number(input.durationDays),
            seatCount: input.seatCount ? Number(input.seatCount) : undefined,
            plan: input.plan || undefined,
            note: input.note || undefined,
          },
          { userId },
        ),
    )

    revalidatePath('/admin/keys')
    return {
      ok: true,
      data: {
        key: issued.key,
        expiresAt: issued.expiresAt,
        durationDays: issued.durationDays,
      },
    }
  } catch (err) {
    return fail(err)
  }
}

export async function revokeKeyAction(input: {
  organizationId: string
  keyId: string
  reason?: string
}): Promise<Result> {
  try {
    const session = await auth()
    const userId = session?.user?.id ?? null
    const handle = await db()
    await assertPlatformAdmin(handle, userId)

    await withTenant(handle, { organizationId: input.organizationId, userId }, (tx) =>
      revokeProductKey(tx, input.organizationId, input.keyId, {
        userId,
        reason: input.reason,
      }),
    )

    revalidatePath('/admin/keys')
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}
