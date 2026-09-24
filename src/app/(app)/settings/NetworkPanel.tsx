'use client'

import { useEffect, useState, useTransition } from 'react'
import { panelStyle, chipButtonStyle } from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import { exportCaCertificateAction, networkInfoAction, type NetworkInfo } from '@/app/actions/network'

/**
 * Network sharing, standalone install only — hidden entirely on the hosted
 * deployment, where there is no LAN certificate to trust in the first place.
 *
 * This panel is what makes connecting a second computer actually possible.
 * Without it, the "On another computer" screen in the desktop shell asks for
 * a pairing code, sends it, and the request fails before the code is even
 * checked — the second computer has never seen this one's certificate and
 * refuses the connection outright. There is no certificate authority to ask
 * out here, so trust has to travel by hand: export the certificate, carry it
 * to the other computer (a USB drive, a shared folder, an email — it is not a
 * secret), and install it there once.
 */
export function NetworkPanel({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [info, setInfo] = useState<NetworkInfo | null>(null)
  const [notDesktop, setNotDesktop] = useState(false)

  useEffect(() => {
    void networkInfoAction().then((r) => {
      if (r.ok) setInfo(r.data)
      else setNotDesktop(true)
    })
  }, [])

  // Nothing to show on the hosted deployment, and nothing to explain either —
  // see BackupPanel for the same reasoning.
  if (notDesktop) return null

  const download = () =>
    startTransition(async () => {
      const result = await exportCaCertificateAction()
      if (!result.ok) {
        toast(result.error, 'err')
        return
      }
      // A Blob download rather than a server route: the certificate never
      // needs its own authenticated endpoint, and this panel already checked
      // the permission that matters.
      const blob = new Blob([result.data.pem], { type: 'application/x-x509-ca-cert' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = result.data.filename
      a.click()
      URL.revokeObjectURL(url)
      toast('Certificate downloaded. Copy it to the other computer and open it there.')
    })

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Network</div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16, lineHeight: 1.55 }}>
        There is no internet involved in running Syncrèse across your office — only this network,
        and only the computers you connect to it yourself.
      </div>

      {info === null && <div style={{ color: 'var(--mut)', fontSize: 12 }}>Loading…</div>}

      {info !== null && !info.sharing && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid var(--bd)',
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          Only this computer can use this workspace. That was chosen when it was set up and
          cannot be changed here yet — reinstalling with “Let other computers on this network use
          this workspace” turned on is the way to share it.
        </div>
      )}

      {info !== null && info.sharing && (
        <>
          <div
            style={{
              padding: '10px 12px',
              marginBottom: 14,
              borderRadius: 8,
              border: '1px solid var(--bd)',
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
          >
            <div style={{ marginBottom: 6 }}>
              Other computers on this network reach this workspace at:
            </div>
            {info.addresses.map((a) => (
              <div key={a} style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 12 }}>
                https://{a}:7429
              </div>
            ))}
          </div>

          <div style={{ ...labelStyle, marginBottom: 8 }}>CONNECT A NEW COMPUTER</div>
          <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 10, lineHeight: 1.55 }}>
            The first time a computer connects here, it will not recognise this one&rsquo;s
            security certificate — there is no internet certificate authority to vouch for it out
            here, so trust has to be carried over by hand, once.
          </div>
          <ol style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
            <li>Download the certificate below and copy it to the other computer.</li>
            <li>
              Double-click it there, choose <strong>Current User</strong>, then{' '}
              <strong>Place all certificates in the following store</strong> →{' '}
              <strong>Trusted Root Certification Authorities</strong>.
            </li>
            <li>
              Open Syncrèse on that computer, choose “On another computer”, and pair as usual — it
              will connect without a warning.
            </li>
          </ol>

          {canManage ? (
            <button type="button" style={chipButtonStyle} disabled={pending} onClick={download}>
              Download certificate
            </button>
          ) : (
            <div style={{ color: 'var(--mut)', fontSize: 11.5 }}>
              Ask an owner or administrator to download the certificate.
            </div>
          )}

          <div
            style={{
              marginTop: 6,
              color: 'var(--mut)',
              fontSize: 10.5,
              fontFamily: 'var(--font-mono), monospace',
            }}
          >
            {info.fingerprint}
          </div>

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--bd)' }}>
            <div style={{ ...labelStyle, marginBottom: 8 }}>WINDOWS FIREWALL</div>
            <div style={{ color: 'var(--mut)', fontSize: 11.5, lineHeight: 1.55 }}>
              The first time another computer connects, Windows may ask whether to allow Syncrèse
              through the firewall — choose <strong>Private networks</strong>. If it never asks
              and connections still fail, add the rule yourself: Windows Defender Firewall →
              Advanced settings → Inbound Rules → New Rule → Port → TCP → <strong>7429</strong> →
              Allow the connection → Private.
            </div>
          </div>
        </>
      )}
    </section>
  )
}

const labelStyle = {
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
} as const
