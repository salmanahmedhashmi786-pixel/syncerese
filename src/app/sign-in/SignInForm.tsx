'use client'

import { signIn } from 'next-auth/react'
import { useState } from 'react'
import { inputStyle, panelStyle, primaryButtonStyle } from '@/components/ui/primitives'
import { beginSignInAction } from '@/app/actions/signin'

/**
 * Where to land after a successful sign-in.
 *
 * Only same-origin PATHS are honoured. A callbackUrl is attacker-supplied — it
 * arrives in the query string — so accepting `https://evil.example` would turn
 * the sign-in page into an open redirect, and one that fires immediately after
 * the user has typed a password.
 */
function safeCallback(raw: string | undefined): string {
  if (!raw) return '/dashboard'
  // Must start with a single slash. `//evil.example` is protocol-relative and
  // leaves the origin despite looking like a path.
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dashboard'
  return raw
}

export function SignInForm({ error, callbackUrl }: { error?: string; callbackUrl?: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  /**
   * Two steps, and only when the account actually has a second factor.
   *
   * The form cannot know whether a code is needed until the password has been
   * verified, and showing a code box to everyone — most of whom have nothing to
   * type in it — is worse than asking a second time.
   */
  const [needsCode, setNeedsCode] = useState(false)
  const [message, setMessage] = useState<string | null>(
    error ? 'Sign-in failed. Check your email and password.' : null,
  )
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMessage(null)

    if (!needsCode) {
      // Step one runs the same verification and the same lockout the real
      // sign-in does, so this is not a softer path to the same oracle.
      const begin = await beginSignInAction({ email, password })
      if (!begin.ok) {
        setMessage(begin.error)
        setBusy(false)
        return
      }
      if (begin.mfaRequired) {
        setNeedsCode(true)
        setBusy(false)
        return
      }
    }

    const result = await signIn('credentials', {
      email,
      password,
      ...(needsCode ? { totp } : {}),
      redirect: false,
    })

    if (result?.error) {
      // Deliberately one message for every failure mode: "no such account" and
      // "wrong password" must be indistinguishable, or the form becomes an
      // account enumeration oracle. Once past step one the account is known to
      // exist, so a wrong CODE can be named precisely.
      setMessage(
        needsCode
          ? 'That code is not right. Try the current one, or use a recovery code.'
          : 'Sign-in failed. Check your email and password.',
      )
      setBusy(false)
      return
    }
    window.location.href = safeCallback(callbackUrl)
  }

  return (
    <form onSubmit={submit} style={{ ...panelStyle, padding: '20px 22px 22px' }}>
      <label style={labelStyle} htmlFor="email">
        EMAIL
      </label>
      <input
        id="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ ...inputStyle, marginBottom: 12 }}
      />

      <label style={labelStyle} htmlFor="password">
        PASSWORD
      </label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{ ...inputStyle, marginBottom: needsCode ? 12 : 16 }}
      />

      {needsCode && (
        <>
          <label style={labelStyle} htmlFor="totp">
            AUTHENTICATION CODE
          </label>
          <input
            id="totp"
            inputMode="numeric"
            // Lets a password manager or the OS fill the code from an SMS or
            // an authenticator that offers it.
            autoComplete="one-time-code"
            autoFocus
            required
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            placeholder="123456"
            style={{ ...inputStyle, marginBottom: 6, letterSpacing: '.12em' }}
          />
          <div style={{ color: 'var(--mut)', fontSize: 10.5, marginBottom: 16 }}>
            From your authenticator app. Lost your phone? Enter one of your recovery codes
            instead.
          </div>
        </>
      )}

      {message && (
        <div style={{ color: '#dc2626', fontSize: 11.5, marginBottom: 12 }}>{message}</div>
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
        {busy ? 'Signing in…' : needsCode ? 'Verify and sign in' : 'Sign in'}
      </button>

      <div
        style={{
          marginTop: 14,
          paddingTop: 14,
          borderTop: '1px solid var(--bd)',
          fontSize: 11.5,
          color: 'var(--mut)',
          lineHeight: 1.5,
        }}
      >
        Google and Microsoft sign-in are configured but need OAuth credentials in{' '}
        <code>.env.local</code> before they appear here.
      </div>
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
