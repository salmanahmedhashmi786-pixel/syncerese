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
 * CORS IS ENABLED, FOR EXACTLY TWO ORIGINS.
 *
 * This said the opposite — "called by a native HTTP client, not by a page, so
 * there is no preflight to satisfy". That was wrong about our own app. The
 * shell calls this with `fetch()` from inside the webview, which is a page, and
 * WebView2 blocked every request: no Access-Control-Allow-Origin came back, the
 * fetch threw, and the window reported "Could not reach that address". Pairing
 * could never have worked against a remote instance, and the tests did not
 * catch it because they exercise the service layer rather than a real
 * cross-origin browser request.
 *
 * The allowlist is the two origins Tauri serves its own UI from and nothing
 * else, so an ordinary web page still cannot reach this: browsers set `Origin`
 * themselves and a page cannot forge it. Credentials are never allowed — there
 * is no cookie in this exchange, the pairing code is the whole authorisation,
 * so there is no CSRF surface to protect.
 */

const NO_STORE = { 'cache-control': 'no-store' }

/** Where Tauri serves the shell from: `http://tauri.localhost` on Windows,
 *  `tauri://localhost` elsewhere. */
const DESKTOP_ORIGINS = new Set(['http://tauri.localhost', 'tauri://localhost'])

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin')
  // `Vary` regardless: the response genuinely differs by origin, and a cache
  // that missed that would serve one caller's decision to another.
  const base: Record<string, string> = { vary: 'Origin' }
  if (!origin || !DESKTOP_ORIGINS.has(origin)) return base
  return {
    ...base,
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  }
}

/** Preflight. Returns 204 either way; a disallowed origin simply gets no
 *  allow-origin header back, and the browser stops there. */
export async function OPTIONS(request: Request): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) })
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false }, { status: 400, headers: { ...NO_STORE, ...corsHeaders(request) } })
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
        { status: 400, headers: { ...NO_STORE, ...corsHeaders(request) } },
      )
    }
    return NextResponse.json(
      { ok: true, deviceId: result.deviceId, organizationId: result.organizationId },
      { headers: { ...NO_STORE, ...corsHeaders(request) } },
    )
  }

  if (action === 'heartbeat') {
    const { deviceId, appVersion } = body as { deviceId?: string; appVersion?: string }
    if (typeof deviceId !== 'string') {
      return NextResponse.json({ ok: false }, { status: 400, headers: { ...NO_STORE, ...corsHeaders(request) } })
    }
    const ok = await withoutTenantScope(handle, (tx) =>
      touchDevice(tx, deviceId, typeof appVersion === 'string' ? appVersion : null),
    )
    // `false` is the revocation signal the shell acts on. It carries no detail:
    // a revoked device and an invented id look identical from here.
    return NextResponse.json({ ok }, { headers: { ...NO_STORE, ...corsHeaders(request) } })
  }

  return NextResponse.json({ ok: false }, { status: 400, headers: { ...NO_STORE, ...corsHeaders(request) } })
}
