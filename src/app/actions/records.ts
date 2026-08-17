'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { AppError } from '@/lib/errors'
import type { ModuleId } from '@/modules/registry'
import { createRecord, runAction, updateField } from '@/modules/write-service'

/**
 * Record writes.
 *
 * Thin: every one of these re-resolves the session, then hands off to the write
 * service, which checks the permission and the allowlist. A server action is a
 * public HTTP endpoint — "only our UI calls this" is not access control.
 */
type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[records]', err)
  return { ok: false, error: 'Something went wrong.' }
}

export async function createRecordAction(
  module: string,
  input: Record<string, unknown>,
): Promise<Result<{ id: string; label: string }>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    const data = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => createRecord(tx, ctx, module as ModuleId, input),
    )
    revalidatePath(`/${module}`)
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}

export async function updateFieldAction(
  module: string,
  recordId: string,
  key: string,
  value: unknown,
): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => updateField(tx, ctx, module as ModuleId, recordId, key, value),
    )
    revalidatePath(`/${module}`)
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function runActionAction(
  module: string,
  recordId: string,
  actionKey: string,
  input: Record<string, unknown> = {},
): Promise<Result<{ message: string }>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    const data = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => runAction(tx, ctx, module as ModuleId, recordId, actionKey, input),
    )
    // A document action can touch several modules at once — shipping an order
    // moves stock, invoicing it posts to the ledger — so refresh broadly rather
    // than leaving another screen stale.
    revalidatePath('/', 'layout')
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}
