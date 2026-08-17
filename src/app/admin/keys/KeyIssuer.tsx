'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  chipButtonStyle,
  inputStyle,
  panelStyle,
  primaryButtonStyle,
} from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import { issueKeyAction, revokeKeyAction } from '@/app/actions/admin-keys'
import { DURATIONS } from '@/licensing/key-format'
import type { PlatformKey, PlatformOrganization } from '@/licensing/platform'

/**
 * Issuing product keys.
 *
 * The vendor picks a customer, a term and optionally a seat count, and gets one
 * key. It is shown once — only a peppered hash is stored — so the panel says so
 * plainly and makes it easy to copy before it goes.
 */

const STATUS_COLOR: Record<string, string> = {
  active: '#0d9488',
  revoked: '#dc2626',
  superseded: '#6b7382',
}

export function KeyIssuer({
  organizations,
  keys,
}: {
  organizations: PlatformOrganization[]
  keys: PlatformKey[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [organizationId, setOrganizationId] = useState(organizations[0]?.organizationId ?? '')
  const [durationDays, setDurationDays] = useState<number>(30)
  const [seatCount, setSeatCount] = useState('')
  const [note, setNote] = useState('')
  const [issued, setIssued] = useState<{ key: string; expiresAt: string } | null>(null)
  const [filter, setFilter] = useState('')

  const chosen = organizations.find((o) => o.organizationId === organizationId)

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return keys
    return keys.filter(
      (k) =>
        k.organizationName.toLowerCase().includes(needle) ||
        k.keyLast4.toLowerCase().includes(needle) ||
        (k.note ?? '').toLowerCase().includes(needle),
    )
  }, [keys, filter])

  const issue = () => {
    if (!organizationId) {
      toast('Pick an organization first', 'err')
      return
    }
    startTransition(async () => {
      const result = await issueKeyAction({
        organizationId,
        durationDays,
        seatCount: seatCount ? Number(seatCount) : undefined,
        note: note || undefined,
      })
      if (result.ok && result.data) {
        setIssued({ key: result.data.key, expiresAt: result.data.expiresAt })
        setNote('')
        setSeatCount('')
        router.refresh()
      } else if (!result.ok) {
        toast(result.error, 'err')
      }
    })
  }

  const revoke = (k: PlatformKey) =>
    startTransition(async () => {
      const result = await revokeKeyAction({
        organizationId: k.organizationId,
        keyId: k.keyId,
        reason: 'Withdrawn from the licensing console',
      })
      if (result.ok) {
        toast(`Key …${k.keyLast4} withdrawn`)
        router.refresh()
      } else {
        toast(result.error, 'err')
      }
    })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* --- issue --------------------------------------------------------- */}
      <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Issue a product key</div>
        <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
          A key licenses one organization for a fixed term. It is the path that does not go
          through Stripe — for a customer paying by invoice, an offline installation, or a
          reseller. Activating extends from the later of today and their current expiry, so
          renewing early never loses time.
        </div>

        {organizations.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
            No organizations yet. One has to sign up before it can be licensed.
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 11 }}>
              <div>
                <label style={labelStyle}>ORGANIZATION</label>
                <select
                  value={organizationId}
                  onChange={(e) => setOrganizationId(e.target.value)}
                  style={inputStyle}
                >
                  {organizations.map((o) => (
                    <option key={o.organizationId} value={o.organizationId}>
                      {o.name} ({o.seatsInUse}/{o.seatCount ?? '—'} seats)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={labelStyle}>TERM</label>
                <select
                  value={String(durationDays)}
                  onChange={(e) => setDurationDays(Number(e.target.value))}
                  style={inputStyle}
                >
                  {DURATIONS.map((d) => (
                    <option key={d.days} value={d.days}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={labelStyle}>SEATS (OPTIONAL)</label>
                <input
                  type="number"
                  min={1}
                  value={seatCount}
                  onChange={(e) => setSeatCount(e.target.value)}
                  placeholder="leave blank"
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ marginTop: 11 }}>
              <label style={labelStyle}>NOTE (OPTIONAL)</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Invoice 2026-0184, annual renewal"
                style={inputStyle}
              />
            </div>

            <div style={{ color: 'var(--mut)', fontSize: 10.5, marginTop: 7, lineHeight: 1.5 }}>
              {DURATIONS.find((d) => d.days === durationDays)?.hint}
              {chosen?.validUntil && (
                <>
                  {' '}
                  Their licence currently runs to{' '}
                  {new Date(chosen.validUntil).toLocaleDateString()}.
                </>
              )}
              {seatCount && ' Seats only ever increase — a key never reduces them below those in use.'}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={issue}
                disabled={pending}
                style={{ ...primaryButtonStyle, fontFamily: 'inherit', opacity: pending ? 0.6 : 1 }}
              >
                {pending ? 'Generating…' : 'Generate key'}
              </button>
            </div>
          </>
        )}

        {issued && (
          <div
            style={{
              marginTop: 14,
              padding: '14px 16px',
              border: '1px solid var(--ac)',
              borderRadius: 8,
              background: 'var(--acs)',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>
              Send this to the customer
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 17,
                letterSpacing: '.06em',
                padding: '10px 12px',
                background: 'var(--pnl)',
                border: '1px solid var(--bd)',
                borderRadius: 6,
                userSelect: 'all',
              }}
            >
              {issued.key}
            </div>
            <div style={{ color: 'var(--mut)', fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
              Shown once — only a hash is stored, so this cannot be retrieved again. If it is
              lost, issue another and the old one stops working. Redeemable until{' '}
              {new Date(issued.expiresAt).toLocaleDateString()}.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="button"
                onClick={() =>
                  navigator.clipboard?.writeText(issued.key).then(
                    () => toast('Key copied'),
                    () => toast('Could not copy — select it and copy manually', 'err'),
                  )
                }
                style={{ ...primaryButtonStyle, fontFamily: 'inherit' }}
              >
                Copy key
              </button>
              <button
                type="button"
                onClick={() => setIssued(null)}
                style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </section>

      {/* --- issued keys ---------------------------------------------------- */}
      <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Issued keys ({keys.length})</div>
            <div style={{ color: 'var(--mut)', fontSize: 12, marginTop: 2 }}>
              Only the last four characters are stored in readable form.
            </div>
          </div>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            style={{ ...inputStyle, width: 200 }}
          />
        </div>

        {visible.length === 0 ? (
          <div style={{ color: 'var(--mut)', fontSize: 12.5 }}>
            {keys.length === 0 ? 'No keys issued yet.' : 'Nothing matches that filter.'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--mut)' }}>
                {['Organization', 'Key', 'Term', 'Status', 'Issued', 'Used', ''].map((h) => (
                  <th
                    key={h}
                    style={{
                      font: '500 9px var(--font-mono), monospace',
                      letterSpacing: '.07em',
                      padding: '0 8px 7px 0',
                      textTransform: 'uppercase',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((k) => (
                <tr key={k.keyId} style={{ borderTop: '1px solid var(--bd)' }}>
                  <td style={{ padding: '8px 8px 8px 0' }}>
                    {k.organizationName}
                    {k.note && (
                      <div style={{ color: 'var(--mut)', fontSize: 11 }}>{k.note}</div>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '8px 8px 8px 0',
                      fontFamily: 'var(--font-mono), monospace',
                    }}
                  >
                    …{k.keyLast4}
                  </td>
                  <td style={{ padding: '8px 8px 8px 0' }}>
                    {k.durationDays ? `${k.durationDays}d` : '—'}
                    {k.seatCount ? ` · ${k.seatCount} seats` : ''}
                  </td>
                  <td style={{ padding: '8px 8px 8px 0' }}>
                    <Badge color={STATUS_COLOR[k.status] ?? '#6b7382'}>
                      {k.activatedAt ? 'used' : k.status}
                    </Badge>
                  </td>
                  <td style={{ padding: '8px 8px 8px 0', color: 'var(--mut)' }}>
                    {new Date(k.issuedAt).toLocaleDateString()}
                  </td>
                  <td style={{ padding: '8px 8px 8px 0', color: 'var(--mut)' }}>
                    {k.activatedAt ? new Date(k.activatedAt).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>
                    {/* An activated key is history — withdrawing it would not
                        claw back a term already granted, so it is not offered. */}
                    {!k.activatedAt && !k.revokedAt && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => revoke(k)}
                        style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
                      >
                        Withdraw
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
  marginBottom: 5,
}
