'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { requirePermission } from '@/server/context'
import { createSavedView, deleteSavedView, listSavedViews } from '@/modules/custom-fields'
import { AppError } from '@/lib/errors'

/**
 * Saved views.
 *
 * Server actions are public HTTP endpoints, so each one re-resolves the session
 * and checks a permission — "the client wouldn't call this" is not access
 * control. Payloads are validated by the zod schemas in the service layer.
 */

type Result = { ok: true; id?: string } | { ok: false; error: string }

function fail(err: unknown): Result {
  if (err instanceof AppError) return { ok: false, error: err.message }
  return { ok: false, error: 'Something went wrong.' }
}

export async function saveView(input: unknown): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    // Saving a view writes nothing but the user's own preferences, so the
    // module's READ permission is the right gate.
    requirePermission(ctx, 'org.read')
    const handle = await db()
    const result = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId },
      (tx) => createSavedView(tx, { organizationId: ctx.organizationId, userId: ctx.userId }, input),
    )
    revalidatePath('/', 'layout')
    return { ok: true, id: result.id }
  } catch (err) {
    return fail(err)
  }
}

export async function removeView(viewId: string): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId },
      (tx) => deleteSavedView(tx, { organizationId: ctx.organizationId, userId: ctx.userId }, viewId),
    )
    revalidatePath('/', 'layout')
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function viewsFor(module: string) {
  const { ctx } = await getSession()
  if (!ctx) return []
  const handle = await db()
  return withTenant(handle, { organizationId: ctx.organizationId, userId: ctx.userId }, (tx) =>
    listSavedViews(tx, ctx.organizationId, module, ctx.userId),
  )
}
