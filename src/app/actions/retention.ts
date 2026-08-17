'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { requirePermission } from '@/server/context'
import { AppError } from '@/lib/errors'
import { retentionOverview, type PolicyView } from '@/gdpr/retention'
import { setPolicy, sweepRetention, type SweepResult } from '@/gdpr/retention-service'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[retention]', err)
  return { ok: false, error: 'Something went wrong.' }
}

export async function retentionOverviewAction(): Promise<Result<PolicyView[]>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    const handle = await db()
    const data = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => retentionOverview(tx, ctx),
    )
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}

export async function setRetentionPolicyAction(input: {
  category: string
  retainDays: number | null
  legalHold?: boolean
  legalHoldNote?: string
}): Promise<Result<null>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    const handle = await db()
    await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => setPolicy(tx, ctx, input),
    )
    revalidatePath('/settings')
    return { ok: true, data: null }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Runs the sweep now, for this workspace only.
 *
 * Deliberately available: an administrator who has just configured a policy
 * should be able to see it take effect rather than wonder whether the nightly
 * job is running at all. `force` skips the once-a-day gate — the daily pacing
 * exists to keep a misconfigured cron cheap, not to stop a person who asked.
 */
export async function runRetentionNowAction(): Promise<Result<SweepResult[]>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    const handle = await db()
    const data = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => {
        // `sweepRetention` itself takes no context — the cron path has no user
        // — so the authority for a manual run is checked here.
        requirePermission(ctx, 'gdpr.manage')
        return sweepRetention(tx, ctx.organizationId, { force: true, actorUserId: ctx.userId })
      },
    )
    revalidatePath('/settings')
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}
