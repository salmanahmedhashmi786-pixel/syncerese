import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/**
 * Encryption at rest for the few things that must be recoverable but must not
 * be readable from a database dump: TOTP secrets, and integration OAuth tokens
 * when those arrive.
 *
 * NOT for passwords. A password is verified, never recovered, so it gets argon2
 * (see auth/password.ts). Encrypting a password would mean the plaintext is one
 * key away, which is the whole thing hashing exists to avoid.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails loudly instead of
 * decrypting to plausible rubbish. A TOTP secret silently corrupted into a
 * different valid secret would lock somebody out of their account with no
 * indication why.
 *
 * FORMAT  v1.<key id>.<iv>.<ciphertext>.<auth tag>, base64url
 *
 * The version and key id are in the payload because a value encrypted today has
 * to be readable after the key is rotated and after the algorithm is changed.
 * Storing a bare ciphertext is what makes rotation a migration nobody ever runs.
 */

const VERSION = 'v1'
const IV_BYTES = 12 // 96 bits, the size GCM is specified for
const KEY_BYTES = 32 // AES-256

export class CryptoConfigError extends Error {}
export class DecryptionError extends Error {}

type LoadedKey = { id: string; key: Buffer }

/**
 * Decodes a base64 key and checks its size.
 *
 * The length check is in BYTES, not characters. 32 base64 characters is 24
 * bytes — it looks long enough and gives you AES-192 by accident, or a throw,
 * depending on how forgiving the runtime is.
 */
function loadKey(raw: string | undefined, label: string): LoadedKey | null {
  const value = raw?.trim()
  if (!value) return null

  let key: Buffer
  try {
    key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    throw new CryptoConfigError(`${label} is not valid base64.`)
  }

  if (key.length !== KEY_BYTES) {
    throw new CryptoConfigError(
      `${label} must decode to exactly ${KEY_BYTES} bytes; got ${key.length}. ` +
        'Generate one with `openssl rand -base64 32`.',
    )
  }

  // A short, stable, non-secret identifier so a payload can say which key
  // encrypted it. Derived from the key rather than configured separately, which
  // means it cannot drift out of sync with the key it names.
  const id = createHash('sha256').update(key).digest('base64url').slice(0, 8)

  return { id, key }
}

/** Current key (encrypts and decrypts) plus the previous one (decrypts only). */
function keyring(): { current: LoadedKey; all: LoadedKey[] } {
  const current = loadKey(process.env.ENCRYPTION_KEY, 'ENCRYPTION_KEY')
  if (!current) {
    throw new CryptoConfigError(
      'ENCRYPTION_KEY is not set. Values that must be encrypted at rest cannot be stored ' +
        'without it — see docs/03-deployment.md.',
    )
  }
  const previous = loadKey(process.env.ENCRYPTION_KEY_PREVIOUS, 'ENCRYPTION_KEY_PREVIOUS')
  return { current, all: previous ? [current, previous] : [current] }
}

export function encryptionConfigured(): boolean {
  try {
    keyring()
    return true
  } catch {
    return false
  }
}

export function encrypt(plaintext: string): string {
  const { current } = keyring()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', current.key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    VERSION,
    current.id,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.')
}

export function decrypt(payload: string): string {
  const parts = payload.split('.')
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new DecryptionError('Unrecognised ciphertext format.')
  }
  const [, keyId, ivPart, dataPart, tagPart] = parts

  const { all } = keyring()
  // The named key first; the rest as a fallback, so a payload written before a
  // rotation still opens even if its key id is not recognised (a key restored
  // from a backup, say).
  const candidates = [...all].sort((a, b) => (a.id === keyId ? -1 : b.id === keyId ? 1 : 0))

  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        candidate.key,
        Buffer.from(ivPart!, 'base64url'),
      )
      decipher.setAuthTag(Buffer.from(tagPart!, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(dataPart!, 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    } catch (err) {
      lastError = err
    }
  }

  // Every key failed. Either the value was encrypted with a key that is gone —
  // which is unrecoverable and worth saying plainly — or it was tampered with,
  // which GCM is what detects.
  throw new DecryptionError(
    'Could not decrypt. The value was encrypted with a key that is no longer configured, ' +
      `or it has been altered. (${lastError instanceof Error ? lastError.message : 'unknown'})`,
  )
}

/** Which key a stored payload was written with, without decrypting it. Lets a
 *  rotation job find the values that still need re-encrypting. */
export function keyIdOf(payload: string): string | null {
  const parts = payload.split('.')
  return parts.length === 5 && parts[0] === VERSION ? (parts[1] ?? null) : null
}

export function currentKeyId(): string {
  return keyring().current.id
}

/** Constant-time comparison for values a caller supplies. `===` on a secret
 *  leaks its length and prefix through timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
