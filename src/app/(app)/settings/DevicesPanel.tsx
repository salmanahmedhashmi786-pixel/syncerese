'use client'

import { useEffect, useState, useTransition } from 'react'
import { Badge, chipButtonStyle, panelStyle, primaryButtonStyle } from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import {
  issuePairingCodeAction,
  listDevicesAction,
  revokeDeviceAction,
} from '@/app/actions/devices'
import type { DeviceRow } from '@/desktop/devices'

/**
 * Desktop installations.
 *
 * The panel exists for one question an SME actually asks — "which machines is
 * this on, and how do I cut off the laptop that walked out of the office" — and
 * it says plainly what pairing is and is not, because the natural assumption is
 * that it controls access. It does not: people sign in normally, and revoking a
 * device stops the desktop app from opening, not the person from using a
 * browser.
 */
export function DevicesPanel({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null)

  useEffect(() => {
    void listDevicesAction().then((r) => {
      if (r.ok) setDevices(r.data)
    })
  }, [])

  const reload = () =>
    listDevicesAction().then((r) => {
      if (r.ok) setDevices(r.data)
    })

  const pair = () =>
    startTransition(async () => {
      const result = await issuePairingCodeAction()
      if (result.ok) setCode(result.data)
      else toast(result.error, 'err')
    })

  const revoke = (id: string) =>
    startTransition(async () => {
      const result = await revokeDeviceAction(id)
      if (result.ok) {
        toast('Device revoked. The desktop app will stop opening on it.')
        await reload()
      } else {
        toast(result.error, 'err')
      }
    })

  const active = devices?.filter((d) => !d.revokedAt) ?? []
  const revoked = devices?.filter((d) => d.revokedAt) ?? []

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Devices</div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16, lineHeight: 1.55 }}>
        Computers running the Syncrèse desktop app. Pairing records a machine so you can see
        it here and cut it off later — it is not a login. People still sign in as themselves,
        and revoking a device stops the desktop app from opening on it, not that person from
        using a browser.
      </div>

      {code && (
        <div
          style={{
            border: '1px solid var(--acc)',
            borderRadius: 8,
            padding: '14px 16px',
            marginBottom: 16,
          }}
        >
          <div style={labelStyle}>PAIRING CODE</div>
          <div
            style={{
              font: '600 24px var(--font-mono), monospace',
              letterSpacing: '.14em',
              margin: '8px 0 6px',
              userSelect: 'all',
            }}
          >
            {code.code}
          </div>
          <div style={{ color: 'var(--mut)', fontSize: 11.5, lineHeight: 1.55 }}>
            Type it into the desktop app on the other computer, along with this workspace’s
            address. It expires at {new Date(code.expiresAt).toLocaleTimeString()} and works
            once. It is not shown again — issuing another is free.
          </div>
        </div>
      )}

      {devices === null && <div style={{ color: 'var(--mut)', fontSize: 12 }}>Loading…</div>}

      {/* All devices, not just active ones: a workspace whose only device has
          been revoked has still paired a computer, and saying otherwise while
          listing that computer directly underneath reads as a bug. */}
      {devices !== null && devices.length === 0 && !code && (
        <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 14 }}>
          No computers paired yet.
        </div>
      )}

      {[...active, ...revoked].map((d) => (
        <div
          key={d.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '11px 0',
            borderBottom: '1px solid var(--bd)',
            fontSize: 12.5,
            opacity: d.revokedAt ? 0.55 : 1,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontWeight: 600 }}>{platformLabel(d.platform)}</span>
              {d.appVersion && <Badge color="var(--mut)">v{d.appVersion}</Badge>}
              {d.revokedAt && <Badge color="var(--neg)">Revoked</Badge>}
            </div>
            <div style={{ color: 'var(--mut)', fontSize: 11, marginTop: 3 }}>
              {/* No machine name or serial: the server stores a hash, not an
                  identifier that would be personal data tied to a workspace. */}
              Paired {new Date(d.firstSeenAt).toLocaleDateString()} · last seen{' '}
              {new Date(d.lastSeenAt).toLocaleDateString()}
            </div>
          </div>

          {canManage && !d.revokedAt && (
            <button
              type="button"
              disabled={pending}
              onClick={() => revoke(d.id)}
              style={{ ...chipButtonStyle, fontFamily: 'inherit', color: 'var(--neg)' }}
            >
              Revoke
            </button>
          )}
        </div>
      ))}

      {canManage && (
        <button
          type="button"
          onClick={pair}
          disabled={pending}
          style={{ ...primaryButtonStyle, marginTop: 14, fontFamily: 'inherit' }}
        >
          {pending ? 'Working…' : 'Pair a computer'}
        </button>
      )}
    </section>
  )
}

const platformLabel = (platform: string | null): string =>
  platform === 'windows'
    ? 'Windows'
    : platform === 'macos'
      ? 'macOS'
      : platform === 'linux'
        ? 'Linux'
        : 'Unknown platform'

const labelStyle = {
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
} as const
