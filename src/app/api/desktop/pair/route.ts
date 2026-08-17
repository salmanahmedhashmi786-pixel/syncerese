import { NextResponse } from 'next/server'
import { db } from '@/db'
import { withoutTenantScope } from '@/db/tenant'
import { redeemPairingCode, touchDevice } from '@/desktop/devices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The two calls the desktop shell makes, and the only ones it can make
 * without a signed-in session.
 *
 * Both are deliberately thin. Everything the desktop app actually does with
 * this workspace's data happens in the webview, under an ordinary session,
 * authorised the same way the browser is. These endpoints exist so that a
 * machine can appear in a list and be revoked — not to authenticate anything.
 *
 * CORS is not enabled. These are called by a native HTTP client, not by a page,
 * so there is no preflight to satisfy and no reason to let arbitrary origins
 * reach them from a browser.
 */

const NO_STORE = { 'cache-control': 'no-store' }

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400, headers: NO_STORE })
  }

  const action = (body as { action?: unknown })?.action

  const handle = await db()

  // Pre-tenant: the caller does not yet know which organization it belongs to,
  // and finding out is the entire purpose of the exchange.
  if (action === 'redeem') {
    const result = await withoutTenantScope(handle, (tx) => redeemPairingCode(tx, body))
    if (!result.ok) {
      // One response for expired, already-used and never-existed. An
      // unauthenticated caller must not be able to tell them apart, or the
      // endpoint becomes a way to test guesses.
      return NextResponse.json(
        { ok: false, error: 'That pairing code is not valid. Ask for a new one.' },
        { status: 400, headers: NO_STORE },
      )
    }
    return NextResponse.json(
      { ok: true, deviceId: result.deviceId, organizationId: result.organizationId },
      { headers: NO_STORE },
    )
  }

  if (action === 'heartbeat') {
    const { deviceId, appVersion } = body as { deviceId?: string; appVersion?: string }
    if (typeof deviceId !== 'string') {
      return NextResponse.json({ ok: false }, { status: 400, headers: NO_STORE })
    }
    const ok = await withoutTenantScope(handle, (tx) =>
      touchDevice(tx, deviceId, typeof appVersion === 'string' ? appVersion : null),
    )
    // `false` is the revocation signal the shell acts on. It carries no detail:
    // a revoked device and an invented id look identical from here.
    return NextResponse.json({ ok }, { headers: NO_STORE })
  }

  return NextResponse.json({ ok: false }, { status: 400, headers: NO_STORE })
}
