import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Implemented rather than pulled in: it is about eighty lines of well-specified
 * arithmetic, and the RFC ships test vectors so it can be proven correct
 * (tests/auth-hardening.test.ts checks against them). A dependency here would
 * be a supply-chain risk sitting directly on the authentication path.
 *
 * SHA-1 with 6 digits and a 30-second step. Not a choice — it is what every
 * authenticator app implements. SHA-256 is available in the RFC and supported
 * by almost nothing, and an MFA secret that Google Authenticator cannot read is
 * a support ticket, not a security improvement. (The HMAC construction is not
 * weakened by SHA-1's collision problems; this is not a signature.)
 */

const DIGITS = 6
const STEP_SECONDS = 30

/**
 * How many steps either side of now are accepted.
 *
 * One means a code stays valid for roughly 30–90 seconds. Phone clocks drift,
 * and people finish typing after the code has rolled over; zero tolerance
 * produces a stream of "it says my code is wrong" tickets. More than one starts
 * meaningfully widening the window for a stolen code.
 */
const SKEW_STEPS = 1

// --- base32 (RFC 4648, no padding) — what authenticator apps expect ---------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''

  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  // Humans retype these off a screen, so spaces, lower case and the padding
  // some apps add are all tolerated.
  const clean = input.toUpperCase().replace(/[\s=]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []

  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// --- the algorithm ----------------------------------------------------------

/** 20 bytes — the size RFC 4226 specifies for the shared secret. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The code for one counter value. Exported so the tests can drive the RFC
 *  vectors, which are defined in terms of the counter rather than the clock. */
export function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  // Big-endian 64-bit counter. Written as two 32-bit halves because the high
  // half is always zero until the year 10 000 and this avoids BigInt.
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)

  const digest = createHmac('sha1', secret).update(buf).digest()

  // Dynamic truncation, RFC 4226 §5.3: the low nibble of the last byte picks
  // where to read the 31-bit value from.
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

export function totp(secretBase32: string, at: Date = new Date()): string {
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS)
  return hotp(base32Decode(secretBase32), counter)
}

/**
 * Checks a code the user typed.
 *
 * Returns the counter it matched, or null. The COUNTER is returned rather than
 * a boolean so the caller can store it and refuse a replay — a code stays valid
 * for up to 90 seconds, which is ample time for someone who shoulder-surfed it
 * to use it again.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { at?: Date; lastUsedCounter?: number | null } = {},
): number | null {
  const cleaned = code.replace(/\D/g, '')
  if (cleaned.length !== DIGITS) return null

  const secret = base32Decode(secretBase32)
  const now = Math.floor((opts.at ?? new Date()).getTime() / 1000 / STEP_SECONDS)

  for (let offset = -SKEW_STEPS; offset <= SKEW_STEPS; offset++) {
    const counter = now + offset

    // Already used. Refused even though the arithmetic would accept it.
    if (opts.lastUsedCounter !== null && opts.lastUsedCounter !== undefined) {
      if (counter <= opts.lastUsedCounter) continue
    }

    const expected = hotp(secret, counter)
    // Constant time: `===` on the code leaks how many leading digits matched,
    // which turns a 1-in-a-million guess into six 1-in-ten guesses.
    if (
      expected.length === cleaned.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))
    ) {
      return counter
    }
  }
  return null
}

/**
 * The URI an authenticator app scans.
 *
 * The issuer appears twice — as a label prefix and as a parameter — because
 * older apps read one and newer ones read the other, and getting it wrong shows
 * the user an unlabelled six-digit code among a dozen others.
 */
export function otpauthUri(opts: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`)
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

// --- recovery codes ---------------------------------------------------------

/**
 * The way back in when the phone is lost.
 *
 * Without these, MFA turns every broken screen into a support request that can
 * only be resolved by someone with database access — which is itself a way past
 * MFA, and a worse one.
 *
 * Crockford-ish base32, grouped, upper case: they get printed, written down and
 * read down a phone line.
 */
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ' // no 0/O/1/I/L
const RECOVERY_COUNT = 10
const RECOVERY_GROUPS = 2
const RECOVERY_GROUP_LEN = 5

export function generateRecoveryCodes(count = RECOVERY_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const groups: string[] = []
    for (let g = 0; g < RECOVERY_GROUPS; g++) {
      const bytes = randomBytes(RECOVERY_GROUP_LEN)
      groups.push(
        Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join(''),
      )
    }
    return groups.join('-')
  })
}

/** Normalises what somebody typed: case, spaces and the dashes they may or may
 *  not have copied. */
export function normaliseRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '')
}
