import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { TenantTx } from '@/db/tenant'
import { type RequestContext, requirePermission } from '@/server/context'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { hashOpaqueToken } from '@/auth/password'
import { ALPHABET } from '@/licensing/key-format'

/**
 * Desktop device pairing and registration.
 *
 * See drizzle/0022 for why this exists as a separate short-lived code rather
 * than the desktop app sending a product key. The one-line version: the webview
 * showing the customer's instance has no Tauri IPC — it cannot have, because
 * capabilities are static build-time config and the instance URL is only known
 * at runtime — so the signed-in page cannot hand the native shell anything.
 *
 * WHAT A PAIRED DEVICE CAN DO: appear in a list, and be revoked.
 *
 * It is not a credential. The user still signs in inside the webview, and every
 * request is authorised by that session and re-checked against licence state
 * server-side. A desktop build that lied about its fingerprint, or replayed
 * somebody else's device id, would gain exactly nothing — which is the point,
 * and the reason none of this is treated as an authentication mechanism.
 */

/** Ten minutes. Long enough to walk to the other machine, short enough that a
 *  code left on a screen is not a standing invitation. */
const CODE_TTL_MINUTES = 10

/** Crockford base32, in two groups of four — the same alphabet as product keys,
 *  chosen for the same reason: no I, L, O or U, so it survives being read aloud
 *  and typed by somebody who is not looking at the screen. */
const CODE_GROUPS = 2
const CODE_GROUP_LEN = 4

export function generatePairingCode(): string {
  const groups: string[] = []
  for (let g = 0; g < CODE_GROUPS; g++) {
    let out = ''
    while (out.length < CODE_GROUP_LEN) {
      // Rejection sampling: `% 32` over a byte would make the first 8 symbols
      // very slightly likelier, and a biased code is a smaller keyspace.
      for (const byte of randomBytes(CODE_GROUP_LEN * 2)) {
        if (byte < 248) {
          out += ALPHABET[byte % ALPHABET.length]
          if (out.length === CODE_GROUP_LEN) break
        }
      }
    }
    groups.push(out)
  }
  return groups.join('-')
}

/** Accepts what a person actually types: lower case, missing dash, the visually
 *  confusable characters Crockford maps back. */
export function normalisePairingCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/[^0-9A-Z]/g, '')
}

const hashCode = (code: string): string =>
  hashOpaqueToken(`devicepair:${normalisePairingCode(code)}`)

// ---------------------------------------------------------------------------
// Issuing — authenticated, inside the tenant.
// ---------------------------------------------------------------------------

export type IssuedPairingCode = { code: string; expiresAt: string }

export async function issuePairingCode(
  tx: TenantTx,
  ctx: RequestContext,
): Promise<IssuedPairingCode> {
  // The same authority as managing the licence. Pairing a machine is not a
  // security decision on its own, but it is an administrative one, and an
  // ordinary member should not be quietly adding installations.
  requirePermission(ctx, 'license.manage')

  const code = generatePairingCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000)

  await tx.execute(sql`
    insert into device_pairing_codes
      (id, organization_id, code_hash, code_prefix, issued_by, expires_at)
    values (${newId()}, ${ctx.organizationId}, ${hashCode(code)},
            ${code.slice(0, 4)}, ${ctx.userId}, ${expiresAt.toISOString()})
  `)

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'device.pairing_code_issued',
    entityType: 'device_pairing_code',
    entityId: null,
    // The prefix, never the code. An audit row holding a live credential has
    // stored it a second time in a place with different access rules.
    after: { prefix: code.slice(0, 4), expiresAt: expiresAt.toISOString() },
    requestId: ctx.requestId,
  })

  return { code, expiresAt: expiresAt.toISOString() }
}

// ---------------------------------------------------------------------------
// Redeeming — unauthenticated, pre-tenant, from the desktop shell.
// ---------------------------------------------------------------------------

export const redeemSchema = z.object({
  code: z.string().trim().min(4).max(32),
  /** Hashed on the client. The server never sees raw machine identifiers —
   *  a MAC address or a disk serial is personal data under GDPR when it is
   *  tied to a named workspace, and there is no reason to hold it. */
  fingerprint: z.string().trim().min(16).max(200),
  platform: z.enum(['windows', 'macos', 'linux']),
  appVersion: z.string().trim().max(40),
})

export type RedeemResult =
  | { ok: true; deviceId: string; organizationId: string }
  | { ok: false }

/**
 * Exchanges a pairing code for a device registration.
 *
 * Runs WITHOUT tenant scope, because the whole point is that the caller does
 * not yet know which organization it belongs to. The SECURITY DEFINER function
 * does the exchange in one statement, so two racing callers cannot both consume
 * the same code.
 *
 * Returns a bare `{ ok: false }` for anything that fails — expired, already
 * used, never existed. The caller is unauthenticated and must not be able to
 * tell those apart.
 */
export async function redeemPairingCode(
  tx: TenantTx,
  input: unknown,
): Promise<RedeemResult> {
  const parsed = redeemSchema.safeParse(input)
  if (!parsed.success) return { ok: false }

  const { code, fingerprint, platform, appVersion } = parsed.data
  const deviceId = newId()

  const res = await tx.execute(sql`
    select public.redeem_device_pairing_code(
      ${hashCode(code)}, ${deviceId}::uuid, ${hashOpaqueToken(`device:${fingerprint}`)},
      ${platform}, ${appVersion}
    ) as organization_id
  `)
  const organizationId = (res as unknown as { rows: { organization_id: string | null }[] })
    .rows[0]?.organization_id

  if (!organizationId) return { ok: false }
  return { ok: true, deviceId, organizationId }
}

/**
 * Liveness, and the revocation check.
 *
 * `false` means "stop" — revoked, or a device id that never existed. The two
 * are deliberately indistinguishable to the caller.
 */
export async function touchDevice(
  tx: TenantTx,
  deviceId: string,
  appVersion: string | null,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(deviceId)) return false
  const res = await tx.execute(sql`
    select public.touch_device_activation(${deviceId}::uuid, ${appVersion}) as ok
  `)
  return Boolean((res as unknown as { rows: { ok: boolean }[] }).rows[0]?.ok)
}

// ---------------------------------------------------------------------------
// Listing and revoking — authenticated, inside the tenant.
// ---------------------------------------------------------------------------

export type DeviceRow = {
  id: string
  platform: string | null
  appVersion: string | null
  firstSeenAt: string
  lastSeenAt: string
  revokedAt: string | null
}

export async function listDevices(tx: TenantTx, ctx: RequestContext): Promise<DeviceRow[]> {
  requirePermission(ctx, 'license.read')
  const res = await tx.execute(sql`
    select id, platform, app_version as "appVersion",
           first_seen_at as "firstSeenAt", last_seen_at as "lastSeenAt",
           revoked_at as "revokedAt"
      from device_activations
     where organization_id = ${ctx.organizationId}
     order by revoked_at nulls first, last_seen_at desc
  `)
  return (res as unknown as { rows: DeviceRow[] }).rows
}

export async function revokeDevice(
  tx: TenantTx,
  ctx: RequestContext,
  deviceId: string,
): Promise<void> {
  requirePermission(ctx, 'license.manage')

  const res = await tx.execute(sql`
    update device_activations
       set revoked_at = now()
     where id = ${deviceId} and organization_id = ${ctx.organizationId}
       and revoked_at is null
     returning id
  `)
  if ((res as unknown as { rows: unknown[] }).rows.length === 0) {
    throw new AppError('NOT_FOUND', 'No such device, or it is already revoked.')
  }

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'device.revoked',
    entityType: 'device_activation',
    entityId: deviceId,
    requestId: ctx.requestId,
  })
}
