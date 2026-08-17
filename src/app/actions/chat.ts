'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { AppError } from '@/lib/errors'
import {
  createChannel,
  deleteMessage,
  editMessage,
  joinChannel,
  listMessages,
  markChannelRead,
  openDirectMessage,
  postMessage,
} from '@/chat/service'

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> =>
  err instanceof AppError
    ? { ok: false, error: err.message }
    : { ok: false, error: 'Something went wrong.' }

/**
 * Chat actions.
 *
 * No permission gate beyond membership: every active member of an organization
 * can talk to their colleagues, which is the point of the feature. The
 * authorization that matters is CHANNEL membership, enforced in the service and
 * again by a database trigger.
 */
async function run<T>(fn: (tx: Parameters<typeof listMessages>[0], ctx: NonNullable<Awaited<ReturnType<typeof getSession>>['ctx']>) => Promise<T>): Promise<Result<T>> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    const handle = await db()
    const data = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId },
      (tx) => fn(tx, ctx),
    )
    return { ok: true, data }
  } catch (err) {
    return fail(err)
  }
}

export async function sendMessage(channelId: string, body: string) {
  const result = await run((tx, ctx) => postMessage(tx, ctx, { channelId, body }))
  return result
}

export async function newChannel(input: unknown) {
  const result = await run((tx, ctx) => createChannel(tx, ctx, input))
  if (result.ok) revalidatePath('/chat')
  return result
}

export async function newDirectMessage(otherUserId: string) {
  const result = await run((tx, ctx) => openDirectMessage(tx, ctx, otherUserId))
  if (result.ok) revalidatePath('/chat')
  return result
}

export async function join(channelId: string) {
  const result = await run((tx, ctx) => joinChannel(tx, ctx, channelId))
  if (result.ok) revalidatePath('/chat')
  return result
}

export async function markRead(channelId: string) {
  return run((tx, ctx) => markChannelRead(tx, ctx, channelId))
}

export async function loadMessages(channelId: string) {
  return run((tx, ctx) => listMessages(tx, ctx, channelId))
}

export async function editOwnMessage(messageId: string, body: string) {
  return run((tx, ctx) => editMessage(tx, ctx, messageId, body))
}

export async function deleteOwnMessage(messageId: string) {
  return run((tx, ctx) => deleteMessage(tx, ctx, messageId))
}
