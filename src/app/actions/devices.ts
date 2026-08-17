'use server'

import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import { withTenant, type TenantTx } from '@/db/tenant'
import { getSession } from '@/server/session'
import type { RequestContext } from '@/server/context'
import { AppError } from '@/lib/errors'
import {
  issuePairingCode,
  listDevices,
  revokeDevice,
  type DeviceRow,
  type IssuedPairingCode,
} from '@/desktop/devices'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[devices]', err)
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

export async function listDevicesAction(): Promise<Result<DeviceRow[]>> {
  return inTenant((tx, ctx) => listDevices(tx, ctx))
}

/**
 * Issues a pairing code.
 *
 * Returned to the caller once and never stored in the clear — the row keeps a
 * hash and a four-character prefix. There is no "show it again": a code lasts
 * ten minutes and issuing another is free.
 */
export async function issuePairingCodeAction(): Promise<Result<IssuedPairingCode>> {
  const result = await inTenant((tx, ctx) => issuePairingCode(tx, ctx))
  if (result.ok) revalidatePath('/settings')
  return result
}

export async function revokeDeviceAction(deviceId: string): Promise<Result<null>> {
  const result = await inTenant(async (tx, ctx) => {
    await revokeDevice(tx, ctx, deviceId)
    return null
  })
  if (result.ok) revalidatePath('/settings')
  return result
}
