'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { inputStyle, panelStyle, primaryButtonStyle } from '@/components/ui/primitives'
import { acceptInvitationAction } from '@/app/actions/members'

/**
 * Accepting an invitation, in the two shapes it comes in.
 *
 * NEW PERSON — the invited address has no account. They set a name and a
 * password here, and the account and the membership are created together in one
 * transaction.
 *
 * EXISTING ACCOUNT — they already have one, usually because they work with
 * another organization on the same installation. They sign in first; the server
 * refuses the acceptance unless the signed-in user IS the invited address,
 * because otherwise holding the link would be enough to join as somebody else.
 */

const MIN_PASSWORD = 12

export function AcceptInviteForm({
  token,
  organizationName,
  email,
  roleName,
  userExists,
  isSignedIn,
}: {
  token: string
  organizationName: string
  email: string
  roleName: string
  userExists: boolean
  isSignedIn: boolean
}) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // usePathname rather than window.location: this component is server-rendered
  // first, where `window` does not exist.
  const pathname = usePathname()

  const needsSignIn = userExists && !isSignedIn

  const accept = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!userExists && password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`)
      return
    }

    setBusy(true)
    const result = await acceptInvitationAction({
      token,
      ...(userExists ? {} : { name, password }),
    })

    if (!result.ok) {
      setError(result.error)
      setBusy(false)
      return
    }

    if (result.data?.created) {
      // The account was just created with these exact credentials, so signing
      // in cannot legitimately fail — a failure here is a bug, and dumping them
      // back on a form whose password has already been consumed would be worse
      // than sending them to sign in.
      const signedIn = await signIn('credentials', { email, password, redirect: false })
      window.location.href = signedIn?.error ? '/sign-in' : '/dashboard'
      return
    }

    // Already signed in as the invited user. The new membership is not in the
    // session's organization list yet, and the active-organization cookie still
    // points at the old one — a full load re-resolves both.
    window.location.href = '/dashboard'
  }

  return (
    <form onSubmit={accept} style={{ ...panelStyle, padding: '20px 22px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>
        Join {organizationName}
      </div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
        You were invited as <strong style={{ color: 'var(--fg)' }}>{email}</strong> with the{' '}
        {roleName} role.
      </div>

      {needsSignIn ? (
        <>
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--mut)',
              lineHeight: 1.55,
              marginBottom: 14,
              paddingBottom: 14,
              borderBottom: '1px solid var(--bd)',
            }}
          >
            That address already has a Syncrèse account. Sign in with it and this page will
            finish the job — you will not lose access to your other organizations.
          </div>
          <a
            href={`/sign-in?callbackUrl=${encodeURIComponent(pathname)}`}
            style={{
              ...primaryButtonStyle,
              width: '100%',
              height: 34,
              justifyContent: 'center',
              textDecoration: 'none',
              fontFamily: 'inherit',
            }}
          >
            Sign in to continue
          </a>
        </>
      ) : (
        <>
          {!userExists && (
            <>
              <label style={labelStyle} htmlFor="name">
                YOUR NAME
              </label>
              <input
                id="name"
                required
                minLength={2}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ ...inputStyle, marginBottom: 12 }}
              />

              <label style={labelStyle} htmlFor="password">
                CHOOSE A PASSWORD
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={MIN_PASSWORD}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={inputStyle}
              />
              <div style={{ color: 'var(--mut)', fontSize: 10.5, margin: '4px 0 16px' }}>
                At least {MIN_PASSWORD} characters.
              </div>
            </>
          )}

          {error && (
            <div style={{ color: '#dc2626', fontSize: 11.5, marginBottom: 12 }}>{error}</div>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{
              ...primaryButtonStyle,
              width: '100%',
              height: 34,
              justifyContent: 'center',
              opacity: busy ? 0.6 : 1,
              fontFamily: 'inherit',
            }}
          >
            {busy ? 'Joining…' : `Join ${organizationName}`}
          </button>
        </>
      )}
    </form>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
  marginBottom: 5,
}
