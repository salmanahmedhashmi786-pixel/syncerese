'use server'

import { db } from '@/db'
import { withTenant, type TenantTx } from '@/db/tenant'
import { getSession } from '@/server/session'
import { AppError } from '@/lib/errors'
import { ask, type AssistantAnswer } from '@/assistant/service'
import { catalogueFor } from '@/assistant/catalogue'
import { modelConfigured } from '@/assistant/model'
import { routableExamples } from '@/assistant/route'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export async function askAssistantAction(
  question: string,
  conversationId?: string,
): Promise<Result<AssistantAnswer>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    const handle = await db()
    const data = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      (tx: TenantTx) => ask(tx, ctx, question, conversationId),
    )
    return { ok: true, data }
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message }
    // The underlying message can quote the model provider's response or a
    // database error. Neither belongs in front of a user.
    console.error('[assistant]', err)
    return { ok: false, error: 'The assistant could not answer that.' }
  }
}

export type AssistantCapability = {
  /** Whether a model is configured. False is a supported state, not an error:
   *  an isolated self-hosted installation cannot call anybody's API. */
  hasModel: boolean
  /** What the deterministic router can answer, for the empty state. Empty when
   *  a model is configured, because then the input is open-ended. */
  examples: string[]
  /** How many lookups this user's permissions allow. Zero means the panel says
   *  so rather than inviting a question it will refuse. */
  lookups: number
}

export async function assistantCapabilityAction(): Promise<Result<AssistantCapability>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  const available = catalogueFor(ctx)
  const hasModel = modelConfigured()
  return {
    ok: true,
    data: {
      hasModel,
      examples: hasModel ? [] : routableExamples(available),
      lookups: available.length,
    },
  }
}
