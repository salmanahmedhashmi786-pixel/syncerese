import { randomBytes } from 'node:crypto'
import { hashOpaqueToken } from '@/auth/password'
import { ALPHABET, PAYLOAD_LEN, checkCharacter, format, normaliseProductKey } from './key-format'

/**
 * Generating and hashing product keys.
 *
 * SERVER ONLY. Hashing needs LICENSE_KEY_PEPPER, and generation needs
 * `node:crypto` — neither belongs in a browser bundle. The FORMAT rules a
 * client legitimately needs (normalise, check character, the list of terms) are
 * in `key-format.ts`, which has no dependencies at all.
 *
 * ENTROPY. Nineteen random characters at five bits each is 95 bits. Guessing a
 * key is not a threat model anybody needs to worry about.
 *
 * STORED HASHED. Only the peppered SHA-256 is persisted, exactly like an API
 * key — a database leak must not yield working licences. The plaintext exists
 * once, at issue, and is never recoverable.
 */

/** A new key. The plaintext is returned once and never stored. */
export function generateProductKey(): string {
  const payload: string[] = []

  // 256 is exactly 8 × 32, so `byte % 32` is unbiased for this alphabet. The
  // rejection branch is here because that is a property of the CONSTANT, not a
  // law — if the alphabet ever changes length, silence would become bias.
  const limit = 256 - (256 % ALPHABET.length)

  while (payload.length < PAYLOAD_LEN) {
    for (const byte of randomBytes(PAYLOAD_LEN)) {
      if (payload.length >= PAYLOAD_LEN) break
      if (256 % ALPHABET.length !== 0 && byte >= limit) continue
      payload.push(ALPHABET[byte % ALPHABET.length]!)
    }
  }

  const body = payload.join('')
  return format(body + checkCharacter(body))
}

/**
 * The lookup key.
 *
 * Hashed from the NORMALISED body, so the same key typed in lower case, with
 * the prefix, or with an O for a zero all hash identically. Hashing the raw
 * input would make "the same key" a dozen different rows, and a customer who
 * typed a letter O would be told their key is invalid.
 */
export function hashProductKey(input: string): string | null {
  const body = normaliseProductKey(input)
  return body ? hashOpaqueToken(`productkey:${body}`) : null
}

// Re-exported so server code has one import for everything about a key.
export {
  DURATIONS,
  formatProductKey,
  isKnownDuration,
  isWellFormed,
  keyLast4,
  normaliseProductKey,
  type DurationDays,
} from './key-format'
