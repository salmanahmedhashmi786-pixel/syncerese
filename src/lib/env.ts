/**
 * Deployment configuration check.
 *
 * Runs once at boot (see src/instrumentation.ts) and refuses to start a
 * production process that is misconfigured in a way that would be silent.
 *
 * Every rule here exists because the failure it prevents is invisible at
 * runtime. A missing AUTH_SECRET does not throw — next-auth quietly derives a
 * per-instance one, so sessions work until you scale to two containers and
 * then log everybody out at random. An unset LICENSE_KEY_PEPPER does not
 * throw — it stores unpeppered API-key hashes that keep working right up until
 * someone steals the table. A `CHANGEME` left in place from .env.example does
 * not throw at all.
 *
 * Deliberately zero dependencies and no database access: this must be able to
 * run before anything else, including in a container health check.
 */

export type Severity = 'error' | 'warning'

export type Finding = {
  severity: Severity
  variable: string
  message: string
}

/** Values that came from the template and were never filled in. */
const PLACEHOLDERS = new Set(['changeme', 'change-me', 'todo', 'xxx', 'secret', 'password'])

const isPlaceholder = (v: string) => PLACEHOLDERS.has(v.trim().toLowerCase())

/**
 * Base64 or base64url of at least `bytes` bytes.
 *
 * Length is checked in DECODED bytes, not characters: a 32-character secret
 * looks long enough and carries 24 bytes of key material.
 */
function decodedBytes(value: string): number {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalised)) return -1
  try {
    return Buffer.from(normalised, 'base64').length
  } catch {
    return -1
  }
}

export type CheckOptions = {
  /** Deliberately looser than NodeJS.ProcessEnv so a test can pass a partial
   *  environment without having to invent a NODE_ENV. */
  env?: Record<string, string | undefined>
  /** Overrides NODE_ENV. Production rules are the strict ones. */
  production?: boolean
}

/**
 * Returns everything wrong with the configuration. Pure — it reads the
 * environment it is given and returns findings rather than throwing, so it can
 * be tested and so `env:check` can report ALL problems at once instead of one
 * per run.
 */
export function checkEnvironment(options: CheckOptions = {}): Finding[] {
  const env = options.env ?? process.env
  const production = options.production ?? env.NODE_ENV === 'production'
  /**
   * Standalone desktop install: no server, no DNS, no certificate authority.
   *
   * Two checks below would otherwise refuse to start it, and both are right
   * about the hosted deployment and wrong about this one. The exemptions are
   * keyed on SYNCRESE_DESKTOP, which the desktop server entry point sets and
   * nothing else does — a hosted deployment that somehow set it would still
   * need DATABASE_URL absent to reach the embedded database, so the blast
   * radius of getting this wrong is a loud failure rather than a quiet one.
   */
  const desktop = env.SYNCRESE_DESKTOP === '1'
  const out: Finding[] = []

  const error = (variable: string, message: string) =>
    out.push({ severity: 'error', variable, message })
  const warn = (variable: string, message: string) =>
    out.push({ severity: 'warning', variable, message })

  const value = (name: string): string => (env[name] ?? '').trim()

  const required = (name: string, message: string) => {
    const v = value(name)
    if (!v) {
      error(name, message)
      return null
    }
    if (isPlaceholder(v)) {
      error(name, `still holds the placeholder from .env.example. ${message}`)
      return null
    }
    return v
  }

  // --- Database ------------------------------------------------------------

  const dbUrl =
    production && !desktop
      ? required('DATABASE_URL', 'The embedded development database is never used in production.')
      : value('DATABASE_URL')

  if (dbUrl) {
    const user = usernameOf(dbUrl)
    // Not proof — a role named anything at all can be a superuser, which is
    // why db:verify checks the server rather than the string. But connecting
    // as `postgres` is a strong enough signal to stop a deploy over.
    if (user && SUPERUSER_NAMES.has(user)) {
      error(
        'DATABASE_URL',
        `connects as "${user}". The application must connect as a role without BYPASSRLS ` +
          '(syncrese_app); a superuser connection silently defeats every tenant-isolation policy. ' +
          'Run `npm run db:verify` to confirm.',
      )
    }
    if (production && value('DATABASE_MIGRATION_URL') === dbUrl) {
      error(
        'DATABASE_MIGRATION_URL',
        'is the same connection as DATABASE_URL. The running app must not be able to alter ' +
          'schema or drop an RLS policy.',
      )
    }
  }

  if (production && value('DATABASE_SSL') === 'false') {
    if (value('ALLOW_INSECURE_DB_CONNECTION') !== 'true') {
      error(
        'DATABASE_SSL',
        'is disabled in production. Set ALLOW_INSECURE_DB_CONNECTION=true to confirm this is ' +
          'deliberate — it is only defensible when the database is on a private network the ' +
          'traffic never leaves.',
      )
    } else {
      warn('DATABASE_SSL', 'TLS to the database is disabled by explicit override.')
    }
  }

  if (production && value('DB_APP_ROLE')) {
    warn(
      'DB_APP_ROLE',
      'is set in production. The connection should already authenticate as the application ' +
        'role; SET ROLE on top of it is a second chance to get it wrong.',
    )
  }

  // --- Auth ----------------------------------------------------------------

  if (production) {
    const secret = required(
      'AUTH_SECRET',
      'Without it next-auth derives a per-instance key: sessions break the moment a second ' +
        'container starts, and every restart logs everyone out. Generate with ' +
        '`openssl rand -base64 32`.',
    )
    if (secret && decodedBytes(secret) < 32 && secret.length < 32) {
      error('AUTH_SECRET', 'is shorter than 32 bytes of key material.')
    }

    const url = required('AUTH_URL', 'OAuth callbacks and session cookies are built from it.')
    if (url && !url.startsWith('https://')) {
      // Still https on the desktop — the local server generates its own
      // certificate at first run precisely so this check does not have to be
      // weakened. A desktop install serving plain http is a bug, not a mode.
      error(
        'AUTH_URL',
        desktop
          ? 'is not https. The desktop server issues its own certificate; plain http would put ' +
            'session cookies on the office network in the clear.'
          : 'is not https. Session cookies would be sent in the clear over any plain-http hop.',
      )
    }
  }

  // --- Crypto --------------------------------------------------------------

  if (production) {
    const key = required(
      'ENCRYPTION_KEY',
      'Encrypts integration tokens and MFA secrets at rest. 32 bytes, base64.',
    )
    if (key && decodedBytes(key) !== 32) {
      error('ENCRYPTION_KEY', 'must decode to exactly 32 bytes of base64.')
    }

    const previous = value('ENCRYPTION_KEY_PREVIOUS')
    if (previous && previous === key) {
      error(
        'ENCRYPTION_KEY_PREVIOUS',
        'is identical to ENCRYPTION_KEY, so a rotation that has not happened looks like one ' +
          'that has.',
      )
    }

    required(
      'LICENSE_KEY_PEPPER',
      'Peppers API-key and webhook-secret hashes. Unset, they are stored unpeppered — and ' +
        'setting it LATER invalidates every key already issued, so it must be right before ' +
        'the first customer.',
    )
  }

  // --- Application ---------------------------------------------------------

  const mode = value('SIGNUP_MODE')
  if (mode && mode !== 'open' && mode !== 'closed') {
    error('SIGNUP_MODE', `must be "open" or "closed", not "${mode}". Anything else reads as closed.`)
  }

  if (production && !value('CRON_SECRET')) {
    warn(
      'CRON_SECRET',
      'is not set, so /api/internal/dispatch answers 503 and no webhook is ever delivered.',
    )
  }

  if (production && value('TRUST_PROXY_HEADERS') !== 'false') {
    // Not an error: the hosted deployment sits behind a proxy and this is
    // correct there. It is called out because getting it wrong is silent — the
    // throttle appears to work and stops nothing.
    warn(
      'TRUST_PROXY_HEADERS',
      'x-forwarded-for is trusted. Correct behind a proxy that overwrites it; set to "false" ' +
        'if the app is exposed directly, or the signup throttle can be bypassed per request.',
    )
  }

  return out
}

const SUPERUSER_NAMES = new Set(['postgres', 'root', 'admin', 'supabase_admin', 'syncrese_owner'])

/** Username from a postgres:// URL, without throwing on a malformed one. */
function usernameOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).username) || null
  } catch {
    return null
  }
}

export function formatFindings(findings: Finding[]): string {
  return findings
    .map((f) => `  ${f.severity === 'error' ? '✗' : '!'} ${f.variable}: ${f.message}`)
    .join('\n')
}

/**
 * Boot gate. Throws on any error-severity finding.
 *
 * Failing to start is the point: a container that crash-loops with a legible
 * message gets noticed in minutes, where one that starts with a broken
 * AUTH_SECRET is discovered by customers.
 */
export function assertEnvironment(options: CheckOptions = {}): void {
  const findings = checkEnvironment(options)
  const errors = findings.filter((f) => f.severity === 'error')
  const warnings = findings.filter((f) => f.severity === 'warning')

  if (warnings.length > 0) {
    console.warn(`[env] ${warnings.length} warning(s):\n${formatFindings(warnings)}`)
  }

  if (errors.length > 0) {
    throw new Error(
      `Refusing to start — ${errors.length} configuration problem(s):\n${formatFindings(errors)}\n` +
        'See docs/03-deployment.md.',
    )
  }
}
