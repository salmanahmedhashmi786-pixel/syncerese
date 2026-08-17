import { describe, expect, it } from 'vitest'
import { assertEnvironment, checkEnvironment } from '@/lib/env'

/**
 * The deployment configuration gate.
 *
 * Every rule here guards a failure that is silent at runtime, so the tests are
 * mostly "does this actually stop a deploy" rather than "does it parse".
 */

/** A configuration that should pass every production rule. */
const GOOD: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://syncrese_app:pw@db.example.com:5432/syncrese?sslmode=require',
  DATABASE_MIGRATION_URL:
    'postgresql://syncrese_owner:pw@db.example.com:5432/syncrese?sslmode=require',
  AUTH_SECRET: Buffer.alloc(32, 7).toString('base64'),
  AUTH_URL: 'https://app.syncrese.com',
  ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  LICENSE_KEY_PEPPER: 'a-real-pepper-value',
  CRON_SECRET: 'a-real-cron-secret',
  TRUST_PROXY_HEADERS: 'false',
  SIGNUP_MODE: 'open',
}

const check = (overrides: Record<string, string | undefined>) =>
  checkEnvironment({ env: { ...GOOD, ...overrides }, production: true })

const errorsFor = (overrides: Record<string, string | undefined>) =>
  check(overrides)
    .filter((f) => f.severity === 'error')
    .map((f) => f.variable)

describe('environment check', () => {
  it('passes a correctly configured production environment', () => {
    expect(check({})).toEqual([])
  })

  it('is silent in development', () => {
    // A developer with no .env.local at all runs on the embedded database.
    // Nagging them about ENCRYPTION_KEY would train everyone to ignore this.
    expect(checkEnvironment({ env: {}, production: false })).toEqual([])
  })

  it('requires the production secrets', () => {
    expect(errorsFor({ AUTH_SECRET: '' })).toContain('AUTH_SECRET')
    expect(errorsFor({ ENCRYPTION_KEY: '' })).toContain('ENCRYPTION_KEY')
    expect(errorsFor({ DATABASE_URL: '' })).toContain('DATABASE_URL')
    expect(errorsFor({ AUTH_URL: '' })).toContain('AUTH_URL')
    // Set after the first key is issued, it invalidates every one of them.
    expect(errorsFor({ LICENSE_KEY_PEPPER: '' })).toContain('LICENSE_KEY_PEPPER')
  })

  it('rejects placeholders left over from the template', () => {
    // The exact failure this whole file exists for: .env.example copied,
    // deployed, and never filled in.
    expect(errorsFor({ AUTH_SECRET: 'CHANGEME' })).toContain('AUTH_SECRET')
    expect(errorsFor({ ENCRYPTION_KEY: '  changeme  ' })).toContain('ENCRYPTION_KEY')
  })

  it('measures key length in decoded bytes, not characters', () => {
    // 32 base64 characters is 24 bytes. It looks long enough and is not.
    expect(errorsFor({ ENCRYPTION_KEY: Buffer.alloc(24, 1).toString('base64') })).toContain(
      'ENCRYPTION_KEY',
    )
    expect(errorsFor({ ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') })).not.toContain(
      'ENCRYPTION_KEY',
    )
  })

  it('refuses a superuser database connection', () => {
    // The single most expensive misconfiguration available: every RLS policy
    // in the system stops applying and nothing else in the stack notices.
    expect(
      errorsFor({ DATABASE_URL: 'postgresql://postgres:pw@db.example.com:5432/syncrese' }),
    ).toContain('DATABASE_URL')
    expect(
      errorsFor({ DATABASE_URL: 'postgresql://syncrese_owner:pw@db.example.com:5432/syncrese' }),
    ).toContain('DATABASE_URL')
  })

  it('refuses to let the app connect with the migration credentials', () => {
    expect(errorsFor({ DATABASE_MIGRATION_URL: GOOD.DATABASE_URL })).toContain(
      'DATABASE_MIGRATION_URL',
    )
  })

  it('requires plaintext database traffic to be an explicit decision', () => {
    expect(errorsFor({ DATABASE_SSL: 'false' })).toContain('DATABASE_SSL')

    const acknowledged = check({ DATABASE_SSL: 'false', ALLOW_INSECURE_DB_CONNECTION: 'true' })
    expect(acknowledged.filter((f) => f.severity === 'error')).toEqual([])
    expect(acknowledged.map((f) => f.variable)).toContain('DATABASE_SSL')
  })

  it('rejects a non-https AUTH_URL', () => {
    expect(errorsFor({ AUTH_URL: 'http://app.syncrese.com' })).toContain('AUTH_URL')
  })

  it('rejects a rotation that has not happened', () => {
    expect(errorsFor({ ENCRYPTION_KEY_PREVIOUS: GOOD.ENCRYPTION_KEY })).toContain(
      'ENCRYPTION_KEY_PREVIOUS',
    )
  })

  it('rejects a SIGNUP_MODE that silently means closed', () => {
    // "true", "yes", "1" all read as closed. Someone who typed one of those
    // meant open and would find out from a customer.
    expect(errorsFor({ SIGNUP_MODE: 'true' })).toContain('SIGNUP_MODE')
    expect(errorsFor({ SIGNUP_MODE: '' })).not.toContain('SIGNUP_MODE')
  })

  it('warns without blocking where the right answer depends on the deployment', () => {
    const findings = check({ CRON_SECRET: '', TRUST_PROXY_HEADERS: 'true', DB_APP_ROLE: 'x' })
    expect(findings.filter((f) => f.severity === 'error')).toEqual([])
    expect(findings.map((f) => f.variable).sort()).toEqual([
      'CRON_SECRET',
      'DB_APP_ROLE',
      'TRUST_PROXY_HEADERS',
    ])
  })

  it('throws at boot on an error and names every problem at once', () => {
    // One error per restart would take five deploys to find five mistakes.
    let message = ''
    try {
      assertEnvironment({ env: { ...GOOD, AUTH_SECRET: '', ENCRYPTION_KEY: '' }, production: true })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('AUTH_SECRET')
    expect(message).toContain('ENCRYPTION_KEY')

    expect(() => assertEnvironment({ env: GOOD, production: true })).not.toThrow()
  })
})
