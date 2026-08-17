/**
 * The product key FORMAT — and nothing else.
 *
 * Deliberately dependency-free: no `node:crypto`, no argon2, no database. The
 * sign-in and settings screens need to check a key's shape as the user types,
 * and a client component that imports the server-side module drags a native
 * password-hashing binary into the browser bundle. (It did exactly that once;
 * the build failed on `@node-rs/argon2-wasm32-wasi`, which is the tidy version
 * of what would otherwise have been a silent layering mistake.)
 *
 * Generation and hashing live in `product-key.ts`, which is server-only because
 * hashing needs LICENSE_KEY_PEPPER.
 *
 *   SYNC-XXXXX-XXXXX-XXXXX-XXXXX
 *
 * CROCKFORD BASE32. The alphabet excludes I, L, O and U. I/1 and O/0 are the
 * pairs people confuse reading a key aloud; U is out so a random key cannot
 * spell something unfortunate. On the way in, I and L are read as 1 and O as 0,
 * which is Crockford's own rule and turns the commonest transcription mistake
 * into a non-event rather than a support call.
 */

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export const PREFIX = 'SYNC'
const GROUPS = 4
const GROUP_LEN = 5
/** 20 characters, the last of which is the check character. */
export const BODY_LEN = GROUPS * GROUP_LEN
export const PAYLOAD_LEN = BODY_LEN - 1

/**
 * The check character: a position-weighted sum, mod 32.
 *
 * The weights are ODD (2i+1), and that is the whole design.
 *
 * 32 is 2⁵, so a weight sharing a factor with it swallows errors: with weight
 * 16, changing a character by 2 moves the sum by 32 ≡ 0 and the typo passes
 * silently. Weighting by `i + 1` — the obvious choice — misses roughly one
 * single-character typo in seventeen for exactly that reason. An odd weight is
 * coprime with 32, so `delta × weight ≡ 0 (mod 32)` forces `delta ≡ 0`:
 * EVERY single mistyped character is caught, provably rather than statistically.
 *
 * Weighting at all is what catches a TRANSPOSITION — an unweighted sum gives
 * "…AB…" and "…BA…" the same check character, and swapping two characters is
 * precisely what people do when typing from paper.
 *
 * The residual: adjacent weights differ by 2, so swapping two characters whose
 * values differ by exactly 16 moves the sum by 32 ≡ 0 and slips through, about
 * one adjacent transposition in sixteen. Closing that needs a prime modulus,
 * which costs either the unambiguous alphabet or a check character outside it.
 * Not worth it: this catches mistakes, it does not authenticate anything, and
 * the server still has to be asked whether the key is real.
 */
export function checkCharacter(payload: string): string {
  let sum = 0
  for (let i = 0; i < payload.length; i++) {
    const value = ALPHABET.indexOf(payload[i]!)
    if (value === -1) throw new Error(`Invalid character in key payload: ${payload[i]}`)
    sum += value * (2 * i + 1)
  }
  return ALPHABET[sum % ALPHABET.length]!
}

/** Inserts the dashes. */
export function format(body: string): string {
  const groups: string[] = []
  for (let i = 0; i < body.length; i += GROUP_LEN) {
    groups.push(body.slice(i, i + GROUP_LEN))
  }
  return [PREFIX, ...groups].join('-')
}

/**
 * Cleans up whatever somebody typed.
 *
 * Handles lower case, missing or extra dashes, spaces, a pasted prefix, and the
 * I/L/O confusions the alphabet is designed around. Returns the bare
 * 20-character body, or null if what is left cannot be a key.
 */
export function normaliseProductKey(input: string): string | null {
  if (!input) return null

  let cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    // Crockford's decoding rule: the characters people substitute.
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')

  if (cleaned.startsWith(PREFIX)) cleaned = cleaned.slice(PREFIX.length)

  if (cleaned.length !== BODY_LEN) return null
  if (![...cleaned].every((c) => ALPHABET.includes(c))) return null

  return cleaned
}

/**
 * Does this look like a key we issued?
 *
 * Cheap, offline, and the only thing a client is ever trusted to evaluate. It
 * lets an obvious typo fail immediately instead of after a round trip. Every
 * real check — issued, not revoked, not expired, not already used — is a server
 * lookup, because a check character proves nothing about whether a key exists.
 */
export function isWellFormed(input: string): boolean {
  const body = normaliseProductKey(input)
  if (!body) return false
  return checkCharacter(body.slice(0, PAYLOAD_LEN)) === body[PAYLOAD_LEN]
}

/** The canonical `SYNC-XXXXX-…` form, from anything that normalises. */
export function formatProductKey(input: string): string | null {
  const body = normaliseProductKey(input)
  return body ? format(body) : null
}

/** The tail shown in a list so an admin can tell two keys apart. */
export function keyLast4(input: string): string | null {
  const body = normaliseProductKey(input)
  return body ? body.slice(-4) : null
}

/** The terms a key can be issued for. */
export const DURATIONS = [
  { days: 3, label: '3 days', hint: 'A trial extension or a demo.' },
  { days: 30, label: '30 days', hint: 'A monthly term, or a bridge while an invoice is paid.' },
  { days: 365, label: '1 year', hint: 'An annual licence.' },
] as const

export type DurationDays = (typeof DURATIONS)[number]['days']

export function isKnownDuration(days: number): boolean {
  return DURATIONS.some((d) => d.days === days)
}
