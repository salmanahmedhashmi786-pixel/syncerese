'use server'

import { isDesktop } from '@/desktop/mode'
import { ensureCertificate, subjectNames } from '@/desktop/tls'
import { getSession } from '@/server/session'
import { requirePermission } from '@/server/context'
import { AppError } from '@/lib/errors'

/**
 * Network sharing, for the Settings panel.
 *
 * DESKTOP ONLY, checked in every action here rather than only in the UI that
 * calls them — see src/app/actions/backup.ts for why that boundary belongs on
 * the server side of it.
 *
 * This exists to unblock something that otherwise cannot work at all: a
 * second computer pairing with this one over the LAN fails its very first
 * request, because the certificate this install issued for itself
 * (src/desktop/tls.ts) is trusted by nobody else. There is no certificate
 * authority to ask out here — no internet, no domain, no Let's Encrypt — so
 * trust has to travel by hand, the same way it would for a self-hosted mail
 * server or a printer with a self-signed cert. This is that hand-off, made as
 * small as it can be: the CA certificate is not a secret — it grants nothing
 * by itself, only lets a second machine verify who it is talking to — so
 * exporting it is safe to gate on the same permission Devices already uses.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const fail = (err: unknown): Result<never> => {
  if (err instanceof AppError) return { ok: false, error: err.message }
  console.error('[network]', err)
  return { ok: false, error: 'Something went wrong.' }
}

const NOT_DESKTOP: Result<never> = {
  ok: false,
  error: 'Network sharing applies to the standalone desktop app, not this deployment.',
}

export type NetworkInfo = {
  /** Whether other computers can reach this one at all. Set once, when this
   *  workspace was created — there is no runtime toggle yet, so the panel
   *  says that honestly rather than offering a control that does not work. */
  sharing: boolean
  /** Every address another computer on this network could use — never
   *  localhost or 127.0.0.1, which mean nothing to anybody else. */
  addresses: string[]
  /** SHA-256 of the CA, colon-separated, as Windows itself displays it — for
   *  a spoken sanity check alongside the file transfer. */
  fingerprint: string
}

export async function networkInfoAction(): Promise<Result<NetworkInfo>> {
  if (!isDesktop()) return NOT_DESKTOP
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    requirePermission(ctx, 'license.read')
    const cert = ensureCertificate()
    return {
      ok: true,
      data: {
        sharing: process.env.SYNCRESE_SHARE_LAN === '1',
        addresses: subjectNames().filter((n) => n !== 'localhost' && n !== '127.0.0.1'),
        fingerprint: cert.fingerprint,
      },
    }
  } catch (err) {
    return fail(err)
  }
}

export async function exportCaCertificateAction(): Promise<
  Result<{ pem: string; filename: string }>
> {
  if (!isDesktop()) return NOT_DESKTOP
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }
  try {
    // license.manage rather than license.read: reading the panel is one
    // thing, handing somebody a file that changes what a second computer
    // trusts is closer to the Devices actions, which use the same permission.
    requirePermission(ctx, 'license.manage')
    const cert = ensureCertificate()
    return { ok: true, data: { pem: cert.caCert, filename: 'syncrese-office.crt' } }
  } catch (err) {
    return fail(err)
  }
}
