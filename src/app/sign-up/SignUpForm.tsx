'use client'

import { useState } from 'react'
import Link from 'next/link'
import { signIn } from 'next-auth/react'
import { inputStyle, panelStyle, primaryButtonStyle } from '@/components/ui/primitives'
import { signUpAction } from '@/app/actions/signup'

/**
 * Create an organization.
 *
 * The country/currency pair is asked for up front rather than defaulted,
 * because both are baked into the tenant at provisioning time — the chart of
 * accounts and every posted amount are denominated in the base currency, and
 * changing it afterwards is a migration, not a setting.
 */

/** The launch markets. Not a complete list — `Other` covers the rest and the
 *  tenant sets its country in Settings. */
const COUNTRIES = [
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['NL', 'Netherlands'],
  ['BE', 'Belgium'],
  ['ES', 'Spain'],
  ['IT', 'Italy'],
  ['AT', 'Austria'],
  ['PL', 'Poland'],
  ['SE', 'Sweden'],
  ['DK', 'Denmark'],
  ['IE', 'Ireland'],
  ['GB', 'United Kingdom'],
  ['CH', 'Switzerland'],
  ['US', 'United States'],
  ['CA', 'Canada'],
] as const

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'CAD'] as const

/** Country → the currency that country almost always books in. Saves the
 *  common case a decision without taking it away. */
const DEFAULT_CURRENCY: Record<string, string> = {
  GB: 'GBP',
  CH: 'CHF',
  SE: 'SEK',
  DK: 'DKK',
  PL: 'PLN',
  US: 'USD',
  CA: 'CAD',
}

const MIN_PASSWORD = 12

export function SignUpForm() {
  const [organizationName, setOrganizationName] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [countryCode, setCountryCode] = useState('DE')
  const [baseCurrency, setBaseCurrency] = useState('EUR')
  const [currencyTouched, setCurrencyTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pickCountry = (code: string) => {
    setCountryCode(code)
    if (!currencyTouched) setBaseCurrency(DEFAULT_CURRENCY[code] ?? 'EUR')
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters. A short phrase beats a mangled word.`)
      return
    }

    setBusy(true)
    const result = await signUpAction({
      organizationName,
      name,
      email,
      password,
      countryCode: countryCode || undefined,
      baseCurrency,
    })

    if (!result.ok) {
      setError(result.error)
      setBusy(false)
      return
    }

    // Straight into the new workspace. The account was just created with these
    // exact credentials, so a failure here is a bug rather than a wrong
    // password — send them to sign-in rather than stranding them on a form
    // whose data has already been consumed.
    const signedIn = await signIn('credentials', { email, password, redirect: false })
    window.location.href = signedIn?.error ? '/sign-in' : '/dashboard'
  }

  return (
    <form onSubmit={submit} style={{ ...panelStyle, padding: '20px 22px 22px' }}>
      <label style={labelStyle} htmlFor="organizationName">
        COMPANY NAME
      </label>
      <input
        id="organizationName"
        required
        minLength={2}
        autoComplete="organization"
        value={organizationName}
        onChange={(e) => setOrganizationName(e.target.value)}
        style={{ ...inputStyle, marginBottom: 12 }}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div>
          <label style={labelStyle} htmlFor="countryCode">
            COUNTRY
          </label>
          <select
            id="countryCode"
            value={countryCode}
            onChange={(e) => pickCountry(e.target.value)}
            style={inputStyle}
          >
            {COUNTRIES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
            <option value="">Other</option>
          </select>
        </div>
        <div>
          <label style={labelStyle} htmlFor="baseCurrency">
            BASE CURRENCY
          </label>
          <select
            id="baseCurrency"
            value={baseCurrency}
            onChange={(e) => {
              setCurrencyTouched(true)
              setBaseCurrency(e.target.value)
            }}
            style={inputStyle}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ ...hintStyle, marginTop: -6, marginBottom: 14 }}>
        Your books are kept in this currency. You can invoice in any other.
      </div>

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

      <label style={labelStyle} htmlFor="email">
        WORK EMAIL
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
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
        required
        minLength={MIN_PASSWORD}
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={inputStyle}
      />
      <div style={{ ...hintStyle, marginBottom: 16 }}>
        At least {MIN_PASSWORD} characters.
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: 11.5, marginBottom: 12 }}>{error}</div>}

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
        {busy ? 'Creating your workspace…' : 'Create workspace'}
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
        Includes a 30-day trial with 5 seats. Already have an account?{' '}
        <Link href="/sign-in" style={{ color: 'var(--ac)' }}>
          Sign in
        </Link>
        .
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

const hintStyle: React.CSSProperties = {
  fontSize: 10.5,
  color: 'var(--mut)',
  marginTop: 4,
}
