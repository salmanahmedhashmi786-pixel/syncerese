'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import { withTenant, type TenantTx } from '@/db/tenant'
import { getSession } from '@/server/session'
import type { RequestContext } from '@/server/context'
import { AppError } from '@/lib/errors'
import {
  createIntegration,
  deleteIntegration,
  listIntegrations,
  prepareTestMessage,
  postTestMessage,
  recordTestResult,
  updateIntegration,
  type ChatIntegrationSummary,
} from '@/integrations/chat'

/**
 * Slack and Teams integration actions.
 *
 * Every one takes an integration ID, never a URL — the only place a URL enters
 * the system is `createIntegration`, and it goes through the allowlist there.
 * A "test this URL" action that accepted a URL directly would be a much more
 * convenient SSRF primitive than the stored-integration path it replaced.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[integrations]', err)
  return { ok: false, error: 'Something went wrong.' }
}

async function inTenant<T>(
  run: (tx: TenantTx, ctx: RequestContext) => Promise<T>,
): Promise<Result<T>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    const handle = await db()
    const data = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx) => run(tx, ctx),
    )
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}

export async function listIntegrationsAction(): Promise<Result<ChatIntegrationSummary[]>> {
  return inTenant((tx, ctx) => listIntegrations(tx, ctx))
}

export async function createIntegrationAction(input: {
  kind: 'slack' | 'teams'
  name: string
  url: string
  events: string[]
}): Promise<Result<{ id: string; urlHint: string }>> {
  const result = await inTenant((tx, ctx) => createIntegration(tx, ctx, input))
  if (result.ok) revalidatePath('/settings')
  return result
}

export async function updateIntegrationAction(
  id: string,
  changes: { name?: string; events?: string[]; enabled?: boolean },
): Promise<Result<null>> {
  const result = await inTenant(async (tx, ctx) => {
    await updateIntegration(tx, ctx, id, changes)
    return null
  })
  if (result.ok) revalidatePath('/settings')
  return result
}

export async function deleteIntegrationAction(id: string): Promise<Result<null>> {
  const result = await inTenant(async (tx, ctx) => {
    await deleteIntegration(tx, ctx, id)
    return null
  })
  if (result.ok) revalidatePath('/settings')
  return result
}

/**
 * Three steps, and the middle one is deliberately outside a transaction:
 * read the row, POST to the vendor, then audit what came back. Doing the POST
 * inside would hold a database transaction open for up to ten seconds while
 * waiting on Slack.
 */
export async function testIntegrationAction(
  id: string,
): Promise<Result<{ ok: boolean; status: number; error?: string }>> {
  const { ctx, organizations } = await getSession()
  const name =
    organizations.find((o) => o.organizationId === ctx?.organizationId)?.organizationName ?? ''

  const prepared = await inTenant((tx, c) => prepareTestMessage(tx, c, id, name))
  if (!prepared.ok) return prepared

  const result = await postTestMessage(prepared.data.url, prepared.data.body)

  await inTenant(async (tx, c) => {
    await recordTestResult(tx, c, id, result)
    return null
  })

  if (!result.ok) {
    return {
      ok: false,
      error: result.error
        ? `Could not reach the webhook: ${result.error}`
        : `The webhook rejected the message (HTTP ${result.status}).`,
    }
  }
  return { ok: true, data: result }
}
