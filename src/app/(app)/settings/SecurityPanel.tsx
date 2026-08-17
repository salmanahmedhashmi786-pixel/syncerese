'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, chipButtonStyle, inputStyle, panelStyle, primaryButtonStyle } from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import {
  beginMfaEnrolmentAction,
  confirmMfaEnrolmentAction,
  disableMfaAction,
  setMfaPolicyAction,
} from '@/app/actions/security'

/**
 * Multi-factor authentication, for this account and as an organization policy.
 *
 * No QR image. Rendering one needs an encoder dependency sitting on the
 * authentication path, and every authenticator app accepts a typed secret —
 * so the secret and the otpauth link are both offered instead. Less slick, one
 * fewer package with access to a shared secret.
 */

export type SecurityState = {
  mfaEnabled: boolean
  recoveryCodesRemaining: number
  encryptionReady: boolean
  policyRequired: boolean
  canManagePolicy: boolean
  adminsWithoutMfa: number
}

export function SecurityPanel({ state }: { state: SecurityState }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [challenge, setChallenge] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [disabling, setDisabling] = useState(false)

  const begin = () =>
    startTransition(async () => {
      const result = await beginMfaEnrolmentAction()
      if (result.ok && result.data) {
        setChallenge(result.data)
        setRecoveryCodes(null)
      } else if (!result.ok) {
        toast(result.error, 'err')
      }
    })

  const confirm = () =>
    startTransition(async () => {
      if (!challenge) return
      const result = await confirmMfaEnrolmentAction({ secret: challenge.secret, code })
      if (result.ok && result.data) {
        setRecoveryCodes(result.data.recoveryCodes)
        setChallenge(null)
        setCode('')
        router.refresh()
      } else if (!result.ok) {
        toast(result.error, 'err')
      }
    })

  const turnOff = () =>
    startTransition(async () => {
      const result = await disableMfaAction({ code })
      if (result.ok) {
        toast('Multi-factor authentication turned off')
        setDisabling(false)
        setCode('')
        router.refresh()
      } else {
        toast(result.error, 'err')
      }
    })

  const setPolicy = (required: boolean) =>
    startTransition(async () => {
      const result = await setMfaPolicyAction(required)
      if (result.ok) {
        const affected = result.data?.affected ?? []
        toast(
          required
            ? affected.length > 0
              ? `Required. ${affected.length} administrator${affected.length === 1 ? '' : 's'} must now enrol before making changes.`
              : 'Required — every administrator is already enrolled.'
            : 'No longer required',
        )
        router.refresh()
      } else {
        toast(result.error, 'err')
      }
    })

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Security</div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16 }}>
        A second factor on your account, and whether this organization requires one of its
        administrators.
      </div>

      {/* --- this account -------------------------------------------------- */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
          border: '1px solid var(--bd)',
          borderRadius: 8,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            Two-factor authentication{' '}
            <Badge color={state.mfaEnabled ? '#0d9488' : '#b45309'}>
              {state.mfaEnabled ? 'on' : 'off'}
            </Badge>
          </div>
          <div style={{ color: 'var(--mut)', fontSize: 11.5, marginTop: 3 }}>
            {state.mfaEnabled
              ? `${state.recoveryCodesRemaining} recovery code${state.recoveryCodesRemaining === 1 ? '' : 's'} left`
              : 'A code from an authenticator app, on top of your password.'}
          </div>
        </div>

        {!state.encryptionReady ? (
          <span style={{ fontSize: 11, color: 'var(--mut)' }}>not available</span>
        ) : state.mfaEnabled ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => setDisabling(true)}
            style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
          >
            Turn off
          </button>
        ) : (
          <button
            type="button"
            disabled={pending || Boolean(challenge)}
            onClick={begin}
            style={{ ...primaryButtonStyle, fontFamily: 'inherit' }}
          >
            Set up
          </button>
        )}
      </div>

      {!state.encryptionReady && (
        <div style={{ color: '#b45309', fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
          This deployment has no <code>ENCRYPTION_KEY</code>, so a TOTP secret could not be
          stored encrypted at rest. Multi-factor authentication is unavailable until one is set.
        </div>
      )}

      {/* --- enrolment ------------------------------------------------------ */}
      {challenge && (
        <div
          style={{
            marginTop: 12,
            padding: '13px 15px',
            border: '1px solid var(--ac)',
            borderRadius: 8,
            background: 'var(--acs)',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>
            Add this to your authenticator app
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--mut)', margin: '0 0 9px', lineHeight: 1.5 }}>
            Open the app, choose “add account”, then enter this key by hand — or open the link
            below on the device that has the app.
          </p>

          <input
            readOnly
            value={challenge.secret}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              ...inputStyle,
              fontFamily: 'var(--font-mono), monospace',
              letterSpacing: '.08em',
              marginBottom: 8,
            }}
          />
          <a
            href={challenge.uri}
            style={{ fontSize: 11, color: 'var(--ac)', wordBreak: 'break-all' }}
          >
            {challenge.uri}
          </a>

          <div style={{ marginTop: 12 }}>
            <label style={{ ...labelStyle, display: 'block', marginBottom: 5 }}>
              THEN TYPE THE CODE IT SHOWS *
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                style={{ ...inputStyle, width: 140, letterSpacing: '.12em' }}
              />
              <button
                type="button"
                disabled={pending || code.trim().length < 6}
                onClick={confirm}
                style={{ ...primaryButtonStyle, fontFamily: 'inherit' }}
              >
                {pending ? 'Checking…' : 'Turn on'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setChallenge(null)
                  setCode('')
                }}
                style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
              >
                Cancel
              </button>
            </div>
            <div style={{ color: 'var(--mut)', fontSize: 10.5, marginTop: 6 }}>
              {/* Nothing is stored until this succeeds, so a mis-scanned code
                  cannot lock the account out of itself. */}
              Nothing is saved until the code checks out.
            </div>
          </div>
        </div>
      )}

      {/* --- recovery codes, shown once ------------------------------------- */}
      {recoveryCodes && (
        <div
          style={{
            marginTop: 12,
            padding: '13px 15px',
            border: '1px solid var(--bd)',
            borderRadius: 8,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 5 }}>
            Save your recovery codes now
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--mut)', margin: '0 0 10px', lineHeight: 1.5 }}>
            These are shown once and cannot be retrieved — only hashes are stored. Each works a
            single time. Without them, a lost phone means losing the account.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 6,
              fontFamily: 'var(--font-mono), monospace',
              fontSize: 12,
            }}
          >
            {recoveryCodes.map((c) => (
              <div key={c}>{c}</div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(recoveryCodes.join('\n')).then(
                () => toast('Recovery codes copied'),
                () => toast('Could not copy — select them and copy manually', 'err'),
              )
            }}
            style={{ ...chipButtonStyle, fontFamily: 'inherit', marginTop: 10 }}
          >
            Copy all
          </button>
        </div>
      )}

      {/* --- disabling ------------------------------------------------------ */}
      {disabling && (
        <div
          style={{
            marginTop: 12,
            padding: '13px 15px',
            border: '1px solid var(--bd)',
            borderRadius: 8,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 6 }}>
            Turn off two-factor authentication
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--mut)', margin: '0 0 9px', lineHeight: 1.5 }}>
            Enter a current code, or one of your recovery codes. Requiring the second factor to
            remove the second factor means a stolen session cannot quietly strip it.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              style={{ ...inputStyle, width: 180 }}
            />
            <button
              type="button"
              disabled={pending || code.trim().length < 6}
              onClick={turnOff}
              style={{ ...primaryButtonStyle, fontFamily: 'inherit', background: '#dc2626' }}
            >
              Turn off
            </button>
            <button
              type="button"
              onClick={() => {
                setDisabling(false)
                setCode('')
              }}
              style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* --- organization policy -------------------------------------------- */}
      {state.canManagePolicy && (
        <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--bd)' }}>
          <div style={{ ...labelStyle, marginBottom: 8 }}>ORGANIZATION POLICY</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5 }}>
                Require two-factor authentication for owners and administrators
              </div>
              <div style={{ color: 'var(--mut)', fontSize: 11, marginTop: 2 }}>
                {state.policyRequired
                  ? 'Required. An administrator without it can sign in and reach this page, but cannot change anything else.'
                  : state.adminsWithoutMfa > 0
                    ? `${state.adminsWithoutMfa} administrator${state.adminsWithoutMfa === 1 ? '' : 's'} would need to enrol.`
                    : 'Every administrator is already enrolled.'}
              </div>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => setPolicy(!state.policyRequired)}
              style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
            >
              {state.policyRequired ? 'Stop requiring' : 'Require'}
            </button>
          </div>
        </div>
      )}

      {/* --- what else protects the account ---------------------------------- */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--bd)' }}>
        <div style={{ ...labelStyle, marginBottom: 6 }}>ALSO IN PLACE</div>
        <ul
          style={{
            margin: 0,
            paddingLeft: 16,
            fontSize: 11.5,
            color: 'var(--mut)',
            lineHeight: 1.65,
          }}
        >
          <li>Passwords hashed with argon2id — never encrypted, never recoverable.</li>
          <li>Eight failed attempts locks an account for fifteen minutes.</li>
          <li>
            Sign-in attempts are throttled per network, which is what stops one password being
            sprayed across thousands of addresses.
          </li>
          <li>Sessions carry only a user id; every permission is re-checked from the database.</li>
        </ul>
      </div>
    </section>
  )
}

const labelStyle: React.CSSProperties = {
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
}
