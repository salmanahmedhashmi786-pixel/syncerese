'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { completePasswordResetAction } from '@/app/actions/password-reset'

/** Matches the rule in src/auth/password.ts and the zod schemas used by signup
 *  and invitation acceptance. Shown up front so nobody discovers it on submit. */
const MIN_LENGTH = 12

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [pending, startTransition] = useTransition()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await completePasswordResetAction(token, password, confirm)
      if (result.ok) setDone(true)
      else setError(result.error ?? 'Something went wrong.')
    })
  }

  if (done) {
    return (
      <div style={panel}>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55 }}>
          Your password has been changed, and you have been signed out everywhere else.
        </p>
        <button
          type="button"
          onClick={() => router.push('/sign-in')}
          style={{ ...button, marginTop: 16 }}
        >
          Sign in
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} style={panel}>
      <label htmlFor="password" style={label}>
        NEW PASSWORD
      </label>
      <input
        id="password"
        type="password"
        required
        minLength={MIN_LENGTH}
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={input}
      />

      <label htmlFor="confirm" style={{ ...label, marginTop: 14 }}>
        CONFIRM
      </label>
      <input
        id="confirm"
        type="password"
        required
        minLength={MIN_LENGTH}
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        style={input}
      />

      <p style={{ margin: '8px 0 16px', fontSize: 11.5, color: 'var(--mut)', lineHeight: 1.5 }}>
        At least {MIN_LENGTH} characters. Length beats punctuation — a passphrase is fine.
      </p>

      {error && (
        <p
          style={{
            margin: '0 0 14px',
            padding: '9px 11px',
            borderRadius: 6,
            border: '1px solid var(--neg)',
            color: 'var(--neg)',
            fontSize: 11.5,
          }}
          role="alert"
        >
          {error}
        </p>
      )}

      <button type="submit" disabled={pending} style={button}>
        {pending ? 'Saving…' : 'Change my password'}
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
