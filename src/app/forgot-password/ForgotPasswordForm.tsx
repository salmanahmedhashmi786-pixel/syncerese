'use client'

import { useState, useTransition } from 'react'
import { requestPasswordResetAction } from '@/app/actions/password-reset'

/**
 * The request step.
 *
 * The confirmation is the SAME sentence whatever happened — address unknown,
 * account deactivated, signs in with Google, mail server down. Anything that
 * varies with the answer turns this page into a way to test whether a given
 * person has an account here.
 */
export function ForgotPasswordForm({ mailReady }: { mailReady: boolean }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<{ message: string; devLink?: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    startTransition(async () => setState(await requestPasswordResetAction(email)))
  }

  if (state) {
    return (
      <div style={panel}>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55 }}>{state.message}</p>

        {state.devLink && (
          <div style={{ marginTop: 14 }}>
            <div style={label}>DEVELOPMENT ONLY</div>
            <p style={{ margin: '6px 0 8px', fontSize: 11.5, color: 'var(--mut)', lineHeight: 1.5 }}>
              No mail server is configured, and this is not a production build, so the link is
              shown here instead. It is never shown in production.
            </p>
            <a
              href={state.devLink}
              style={{
                color: 'var(--ac)',
                fontSize: 11,
                wordBreak: 'break-all',
                fontFamily: 'var(--font-mono), monospace',
              }}
            >
              {state.devLink}
            </a>
          </div>
        )}
      </div>
    )
  }

  return (
    <form onSubmit={submit} style={panel}>
      {!mailReady && (
        <p
          style={{
            margin: '0 0 14px',
            padding: '9px 11px',
            borderRadius: 6,
            border: '1px solid var(--warn)',
            color: 'var(--warn)',
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          This installation has no mail server configured, so no email can be sent. Ask whoever
          administers it to set one up, or to reset your password for you.
        </p>
      )}

      <label htmlFor="email" style={label}>
        EMAIL
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={input}
      />
      <p style={{ margin: '8px 0 16px', fontSize: 11.5, color: 'var(--mut)', lineHeight: 1.5 }}>
        We will send a link that works once and expires in an hour. If you use a second factor,
        you will still be asked for it when you sign in.
      </p>

      <button type="submit" disabled={pending} style={button}>
        {pending ? 'Sending…' : 'Send the link'}
      </button>
    </form>
  )
}

const panel = {
  background: 'var(--pnl)',
  border: '1px solid var(--bd)',
  borderRadius: 10,
  padding: '18px 20px 20px',
} as const

const label = {
  display: 'block',
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
  marginBottom: 6,
} as const

const input = {
  width: '100%',
  height: 34,
  padding: '0 11px',
  borderRadius: 8,
  border: '1px solid var(--bd)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 12.5,
  fontFamily: 'inherit',
  outline: 'none',
} as const

const button = {
  width: '100%',
  height: 36,
  borderRadius: 8,
  border: 'none',
  background: 'var(--ac)',
  color: '#fff',
  font: '600 13px inherit',
  cursor: 'pointer',
} as const
