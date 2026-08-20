import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Standalone desktop mode.
 *
 * The same application, with no internet and no hosting: one machine holds the
 * data and serves it, other machines on the same LAN connect to that one. It is
 * how SME accounting software has always worked — QuickBooks Desktop and Sage 50
 * both do exactly this — and it is a different product from the hosted service,
 * not a packaging of it.
 *
 * WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT
 *
 * The database becomes PGlite on the customer's disk instead of Postgres over
 * the network. Everything above it is untouched: the same migrations, the same
 * RLS policies, the same append-only triggers, the same 663 tests. That is the
 * whole reason this is a week of work rather than a rewrite — PGlite is real
 * PostgreSQL 16, and the schema does not know the difference.
 *
 * Tenant isolation stays on. A single-user install has exactly one tenant, so
 * RLS protects nothing it did not already protect — but leaving it enabled
 * means one code path, not two, and the LAN case genuinely has several people
 * under one organization.
 *
 * WHAT GETS WORSE, HONESTLY
 *
 * The customer's disk is now the only copy. Backups become their problem, which
 * historically means nobody's problem — hence `src/desktop/backup.ts`.
 *
 * The threat model changes too. On the hosted service, nobody but us can reach
 * the database. Here the customer's own administrator can open the data
 * directory. RLS still stops the APPLICATION from crossing tenants; it was
 * never going to stop somebody with the files.
 */

export const isDesktop = (): boolean => process.env.SYNCRESE_DESKTOP === '1'

/**
 * Where everything lives: the database, the secrets, the TLS certificate,
 * backups.
 *
 * `%LOCALAPPDATA%\Syncrese` on Windows rather than Program Files, because a
 * standard user can write to it without elevation, and rather than Roaming,
 * because a multi-gigabyte ledger has no business being copied to a domain
 * controller at every login.
 */
export function dataDir(): string {
  const explicit = env('SYNCRESE_DATA_DIR')?.trim()
  if (explicit) return path.resolve(explicit)

  const base =
    process.platform === 'win32'
      ? (env('LOCALAPPDATA') ?? path.join(os.homedir(), 'AppData', 'Local'))
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : (env('XDG_DATA_HOME') ?? path.join(os.homedir(), '.local', 'share'))

  return path.join(base, 'Syncrese')
}

/**
 * Reads an environment variable in a way the build's file tracer cannot fold.
 *
 * Written as `process.env.LOCALAPPDATA`, Next's tracer evaluates it AT BUILD
 * TIME, resolves this function to a real directory on the build machine, and
 * globs it looking for files to include. On Windows that walks into
 * `AppData\Local\Application Data` — a legacy compatibility junction that
 * points at its own parent and denies access by design — and the whole build
 * fails with `EPERM: scandir`, naming a path nothing in this project mentions.
 *
 * Indexing with a variable defeats the constant folding. The value is identical
 * at runtime; only the build-time analysis changes.
 */
function env(name: string): string | undefined {
  return process.env[name]
}

export const databaseDir = (): string => path.join(dataDir(), 'database')
export const secretsFile = (): string => path.join(dataDir(), 'secrets.json')
export const certDir = (): string => path.join(dataDir(), 'tls')
export const backupDir = (): string => path.join(dataDir(), 'backups')

export type DesktopSecrets = {
  /** Signs session tokens. Losing it signs everyone out; nothing else. */
  authSecret: string
  /**
   * Encrypts MFA secrets and integration tokens at rest.
   *
   * RECOVERABLE BY CHOICE, and the trade-off is worth stating where somebody
   * will read it. This sits in a file beside the database rather than sealed to
   * the machine with DPAPI. Sealing it would mean an attacker with the data
   * directory cannot read encrypted columns — and would also mean a backup
   * restored onto a replacement PC is permanently unreadable ciphertext.
   *
   * For software whose backup story is "the customer copies a folder", the
   * second failure is the one that actually happens. So the key travels with
   * the data, and the honest description of encryption-at-rest here is that it
   * protects the database file in isolation — a stolen backup, a discarded
   * disk — not the data directory as a whole.
   */
  encryptionKey: string
  /** Peppers product-key hashes. Must survive, or issued keys stop validating. */
  licenseKeyPepper: string
  /** Guards the scheduled endpoints, which run in-process here. */
  cronSecret: string
  /** Written the first time secrets are generated; for support and migrations. */
  createdAt: string
}

/**
 * Reads the secrets, generating them on first run.
 *
 * There is no ceremony here, and that is deliberate: a desktop customer will
 * never paste a generated key into a console. They install the software and it
 * works. The keys still have to be real — 32 bytes of CSPRNG each, the same as
 * `npm run gen:secrets` produces for the hosted deployment.
 */
export function loadOrCreateSecrets(): DesktopSecrets {
  const file = secretsFile()

  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<DesktopSecrets>
    const missing = (['authSecret', 'encryptionKey', 'licenseKeyPepper', 'cronSecret'] as const)
      .filter((k) => !parsed[k])
    if (missing.length > 0) {
      throw new Error(
        `${file} is missing ${missing.join(', ')}. Restore it from a backup rather than ` +
          `deleting it: regenerating the encryption key makes every encrypted column ` +
          `permanently unreadable.`,
      )
    }
    return parsed as DesktopSecrets
  }

  mkdirSync(path.dirname(file), { recursive: true })
  const secrets: DesktopSecrets = {
    authSecret: randomBytes(32).toString('base64'),
    encryptionKey: randomBytes(32).toString('base64'),
    licenseKeyPepper: randomBytes(32).toString('base64'),
    cronSecret: randomBytes(32).toString('base64'),
    createdAt: new Date().toISOString(),
  }
  writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 })
  try {
    // No-op on Windows, where the ACL inherited from %LOCALAPPDATA% is what
    // actually restricts this to the user. Kept for the other platforms.
    chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
  return secrets
}

/**
 * Puts the desktop secrets into `process.env` before anything reads them.
 *
 * The application already knows how to find AUTH_SECRET and the rest there;
 * this saves teaching every consumer about a second source of configuration.
 * Called once, from the desktop server entry point, before Next boots.
 */
export function applyDesktopEnv(): void {
  if (!isDesktop()) return
  const s = loadOrCreateSecrets()
  process.env.AUTH_SECRET ??= s.authSecret
  process.env.ENCRYPTION_KEY ??= s.encryptionKey
  process.env.LICENSE_KEY_PEPPER ??= s.licenseKeyPepper
  process.env.CRON_SECRET ??= s.cronSecret
  process.env.SIGNUP_MODE ??= 'closed'
}
