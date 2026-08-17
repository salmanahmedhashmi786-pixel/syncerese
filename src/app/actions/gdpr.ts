'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { AppError } from '@/lib/errors'
import { eraseSubject, findSubjects, type DataSubject, type ErasureReport } from '@/server/gdpr'

/**
 * Privacy actions.
 *
 * Exports are NOT here — they are a file download and go through
 * /api/gdpr/export, which can set a Content-Disposition. These are the two
 * operations that return data to the page.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[gdpr]', err)
  return { ok: false, error: 'Something went wrong.' }
}

export async function findSubjectsAction(email: string): Promise<Result<DataSubject[]>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    const data = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => findSubjects(tx, ctx, email),
    )
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}

export async function eraseSubjectAction(input: {
  subjectType: string
  subjectId: string
  reason: string
}): Promise<Result<ErasureReport>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    const data = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => eraseSubject(tx, ctx, input),
    )
    // The member list may have changed — an erased colleague loses their seat.
    revalidatePath('/settings')
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}
