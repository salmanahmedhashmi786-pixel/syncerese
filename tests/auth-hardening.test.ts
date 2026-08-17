import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, seedUser, type TestDb } from './helpers/db'
import { hashPassword } from '@/auth/password'
import { checkCredentials } from '@/auth/credentials'
import {
  beginEnrolment,
  confirmEnrolment,
  consumeSecondFactor,
  disableMfa,
  mfaStateFor,
} from '@/auth/mfa'
import { randomBytes } from 'node:crypto'
import {
  CryptoConfigError,
  DecryptionError,
  currentKeyId,
  decrypt,
  encrypt,
  keyIdOf,
  safeEqual,
} from '@/lib/crypto'
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateSecret,
  hotp,
  normaliseRecoveryCode,
  otpauthUri,
  totp,
  verifyTotp,
} from '@/auth/totp'

const KEY_A = randomBytes(32).toString('base64')
const KEY_B = randomBytes(32).toString('base64')

describe('encryption at rest', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY_A
    delete process.env.ENCRYPTION_KEY_PREVIOUS
  })

  afterEach(() => {
    process.env = { ...saved }
  })

  it('round-trips a value', () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    expect(decrypt(encrypt(secret))).toBe(secret)
  })

  it('produces a different ciphertext every time', () => {
    // A deterministic ciphertext tells anyone with the database which users
    // share a value, and for a TOTP secret that is a fingerprint.
    const a = encrypt('same input')
    const b = encrypt('same input')
    expect(a).not.toBe(b)
    expect(decrypt(a)).toBe(decrypt(b))
  })

  it('detects tampering rather than returning rubbish', () => {
    // The reason for GCM. A silently corrupted TOTP secret would lock somebody
    // out of their account with no indication why.
    const payload = encrypt('JBSWY3DPEHPK3PXP')
    const parts = payload.split('.')
    const data = Buffer.from(parts[3]!, 'base64url')
    data[0] = data[0]! ^ 0xff
    parts[3] = data.toString('base64url')

    expect(() => decrypt(parts.join('.'))).toThrow(DecryptionError)
  })

  it('rejects a swapped authentication tag', () => {
    const a = encrypt('one').split('.')
    const b = encrypt('two').split('.')
    a[4] = b[4]!
    expect(() => decrypt(a.join('.'))).toThrow(DecryptionError)
  })

  it('reads values written before a key rotation', () => {
    const before = encrypt('written with the old key')

    // Rotate: yesterday's key becomes PREVIOUS, a new one becomes current.
    process.env.ENCRYPTION_KEY = KEY_B
    process.env.ENCRYPTION_KEY_PREVIOUS = KEY_A

    expect(decrypt(before)).toBe('written with the old key')
    // And new writes use the new key, so a rotation job can find the stragglers.
    expect(keyIdOf(encrypt('new'))).toBe(currentKeyId())
    expect(keyIdOf(before)).not.toBe(currentKeyId())
  })

  it('fails loudly when the key that wrote a value is gone', () => {
    const orphan = encrypt('unrecoverable')
    process.env.ENCRYPTION_KEY = KEY_B
    delete process.env.ENCRYPTION_KEY_PREVIOUS

    expect(() => decrypt(orphan)).toThrow(/no longer configured|altered/i)
  })

  it('refuses a key of the wrong size', () => {
    // 32 base64 characters is 24 bytes. It looks long enough and is not.
    process.env.ENCRYPTION_KEY = randomBytes(24).toString('base64')
    expect(() => encrypt('x')).toThrow(CryptoConfigError)
  })

  it('refuses to work with no key at all', () => {
    delete process.env.ENCRYPTION_KEY
    expect(() => encrypt('x')).toThrow(CryptoConfigError)
  })

  it('compares in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('TOTP', () => {
  /**
   * RFC 6238 Appendix B.
   *
   * The published vectors use an 8-digit code; this implementation emits 6, as
   * every authenticator app does, so the expectation is the last six digits of
   * each vector. The seed is the ASCII string "12345678901234567890".
   */
  const SEED = Buffer.from('12345678901234567890', 'ascii')
  const SECRET = base32Encode(SEED)

  const VECTORS: [number, string][] = [
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
  ]

  it('matches the RFC 6238 test vectors', () => {
    for (const [seconds, expected] of VECTORS) {
      expect(totp(SECRET, new Date(seconds * 1000)), `at t=${seconds}`).toBe(expected)
    }
  })

  it('matches the RFC 4226 counter vectors', () => {
    // HOTP is the arithmetic underneath. If this is wrong, everything above is.
    const expected = ['755224', '287082', '359152', '969429', '338314']
    expected.forEach((code, counter) => {
      expect(hotp(SEED, counter)).toBe(code)
    })
  })

  it('round-trips base32', () => {
    const raw = randomBytes(20)
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true)
  })

  it('tolerates how people retype a secret', () => {
    const secret = generateSecret()
    const messy = secret.toLowerCase().replace(/(.{4})/g, '$1 ')
    expect(base32Decode(messy).equals(base32Decode(secret))).toBe(true)
  })

  it('accepts a code from the adjacent time step', () => {
    // Phone clocks drift and people finish typing after the code rolls over.
    const secret = generateSecret()
    const now = new Date(1_700_000_000_000)
    const previous = totp(secret, new Date(now.getTime() - 30_000))
    expect(verifyTotp(secret, previous, { at: now })).not.toBeNull()
  })

  it('refuses a code from too far away', () => {
    const secret = generateSecret()
    const now = new Date(1_700_000_000_000)
    const old = totp(secret, new Date(now.getTime() - 5 * 60_000))
    expect(verifyTotp(secret, old, { at: now })).toBeNull()
  })

  it('refuses a replay of a code already used', () => {
    // A code stays valid for up to 90 seconds — ample time for somebody who
    // read it over a shoulder to use it again.
    const secret = generateSecret()
    const now = new Date(1_700_000_000_000)
    const code = totp(secret, now)

    const counter = verifyTotp(secret, code, { at: now })
    expect(counter).not.toBeNull()

    expect(verifyTotp(secret, code, { at: now, lastUsedCounter: counter })).toBeNull()
  })

  it('rejects malformed input without throwing', () => {
    const secret = generateSecret()
    expect(verifyTotp(secret, '')).toBeNull()
    expect(verifyTotp(secret, '12345')).toBeNull()
    expect(verifyTotp(secret, 'abcdef')).toBeNull()
  })

  it('builds a URI an authenticator app can read', () => {
    const uri = otpauthUri({
      issuer: 'Syncrèse',
      account: 'anke@vogel.example',
      secret: 'JBSWY3DPEHPK3PXP',
    })
    expect(uri).toMatch(/^otpauth:\/\/totp\//)
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
    // The issuer twice: older apps read the label prefix, newer ones the
    // parameter, and getting it wrong shows an unlabelled code among a dozen.
    expect(uri).toContain(encodeURIComponent('Syncrèse:anke@vogel.example'))
    expect(uri).toContain('issuer=Syncr')
  })
})

describe('the MFA flow against a real database', () => {
  let t: TestDb
  let userId: string
  const saved = { ...process.env }

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = KEY_A
    process.env.LICENSE_KEY_PEPPER = 'test-pepper'
    t = await createTestDb()
    userId = await seedUser(t, 'mfa@example.test')
    // Parameterised: an argon2 hash contains `$` and `/`, and interpolating it
    // with JSON.stringify produces double quotes, which Postgres reads as an
    // identifier rather than a string.
    await t.client.query(`update users set password_hash = $1 where id = $2`, [
      await hashPassword('correct-horse-battery'),
      userId,
    ])
  })

  afterEach(async () => {
    await t.close()
    process.env = { ...saved }
  })

  it('does not switch MFA on until a code is proved', async () => {
    const challenge = beginEnrolment('mfa@example.test')
    expect((await mfaStateFor(t.db, userId)).enabled).toBe(false)

    // A wrong code leaves the account exactly as it was. Enrolling on the first
    // step would lock somebody out with a factor they cannot produce.
    await expect(
      confirmEnrolment(t.db, { userId, secret: challenge.secret, code: '000000' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect((await mfaStateFor(t.db, userId)).enabled).toBe(false)

    const result = await confirmEnrolment(t.db, {
      userId,
      secret: challenge.secret,
      code: totp(challenge.secret),
    })
    expect(result.recoveryCodes).toHaveLength(10)
    expect((await mfaStateFor(t.db, userId)).enabled).toBe(true)
  })

  it('stores the secret encrypted, not in the clear', async () => {
    const challenge = beginEnrolment('mfa@example.test')
    await confirmEnrolment(t.db, {
      userId,
      secret: challenge.secret,
      code: totp(challenge.secret),
    })

    const row = await t.client.query<{ secret: string; codes: string[] }>(
      `select mfa_secret_encrypted as secret, mfa_recovery_codes_hashed as codes
         from users where id = $1`,
      [userId],
    )
    // A database dump must not yield working second factors.
    expect(row.rows[0]!.secret).not.toContain(challenge.secret)
    expect(row.rows[0]!.secret).toMatch(/^v1\./)
    // Recovery codes are hashed, not encrypted — verifying one only needs a
    // comparison.
    expect(JSON.stringify(row.rows[0]!.codes)).not.toMatch(/[2-9A-HJ-NP-Z]{5}-/)
  })

  it('blocks a correct password when MFA is on', async () => {
    const challenge = beginEnrolment('mfa@example.test')
    await confirmEnrolment(t.db, {
      userId,
      secret: challenge.secret,
      code: totp(challenge.secret),
    })

    // The password is right, and that is no longer enough. This is the whole
    // point of the feature.
    const check = await checkCredentials(t.db, {
      email: 'mfa@example.test',
      password: 'correct-horse-battery',
    })
    expect(check.ok).toBe(true)
    expect(check.ok && check.mfaEnabled).toBe(true)

    expect(await consumeSecondFactor(t.db, userId, '000000')).toBe(false)
  })

  it('refuses to reuse a code that already signed somebody in', async () => {
    const challenge = beginEnrolment('mfa@example.test')
    await confirmEnrolment(t.db, {
      userId,
      secret: challenge.secret,
      code: totp(challenge.secret),
    })

    // Enrolment itself consumes the counter of the code that proved it — which
    // is correct, and means the code just typed cannot also sign you in. Clear
    // it here to stand in for the time that normally passes between enrolling
    // and next signing in.
    await t.client.query(`update users set mfa_last_counter = null where id = $1`, [userId])

    // A code stays valid for up to 90 seconds. Somebody who read it over a
    // shoulder must not be able to follow you in with it.
    const code = totp(challenge.secret)
    expect(await consumeSecondFactor(t.db, userId, code)).toBe(true)
    expect(await consumeSecondFactor(t.db, userId, code)).toBe(false)
  })

  it('accepts a recovery code exactly once', async () => {
    const challenge = beginEnrolment('mfa@example.test')
    const { recoveryCodes } = await confirmEnrolment(t.db, {
      userId,
      secret: challenge.secret,
      code: totp(challenge.secret),
    })

    const code = recoveryCodes[0]!
    expect(await consumeSecondFactor(t.db, userId, code)).toBe(true)
    // A recovery code that still works after use is a permanent password.
    expect(await consumeSecondFactor(t.db, userId, code)).toBe(false)

    expect((await mfaStateFor(t.db, userId)).recoveryCodesRemaining).toBe(9)
    // The others are untouched.
    expect(await consumeSecondFactor(t.db, userId, recoveryCodes[1]!)).toBe(true)
  })

  it('tolerates how somebody retypes a recovery code', async () => {
    const challenge = beginEnrolment('mfa@example.test')
    const { recoveryCodes } = await confirmEnrolment(t.db, {
      userId,
      secret: challenge.secret,
      code: totp(challenge.secret),
    })
    // Read down a phone line, typed without the dash, in lower case.
    const messy = recoveryCodes[0]!.replace('-', '').toLowerCase()
    expect(await consumeSecondFactor(t.db, userId, messy)).toBe(true)
  })

  it('needs a second factor to remove the second factor', async () => {
    const challenge = beginEnrolment('mfa@example.test')
    await confirmEnrolment(t.db, {
      userId,
      secret: challenge.secret,
      code: totp(challenge.secret),
    })

    // A stolen session must not be able to quietly strip MFA.
    await expect(disableMfa(t.db, { userId, code: '000000' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    expect((await mfaStateFor(t.db, userId)).enabled).toBe(true)

    // As above: the enrolment code is already spent, so stand in for the time
    // that would normally have passed.
    await t.client.query(`update users set mfa_last_counter = null where id = $1`, [userId])
    await disableMfa(t.db, { userId, code: totp(challenge.secret) })
    const after = await mfaStateFor(t.db, userId)
    expect(after.enabled).toBe(false)
    expect(after.recoveryCodesRemaining).toBe(0)
  })

  it('refuses everything if the encryption key is lost', async () => {
    const challenge = beginEnrolment('mfa@example.test')
    await confirmEnrolment(t.db, {
      userId,
      secret: challenge.secret,
      code: totp(challenge.secret),
    })

    // Fails CLOSED. The alternative — treating an undecryptable secret as "no
    // MFA configured" — would turn a lost key into a way past the factor.
    process.env.ENCRYPTION_KEY = KEY_B
    delete process.env.ENCRYPTION_KEY_PREVIOUS

    expect(await consumeSecondFactor(t.db, userId, totp(challenge.secret))).toBe(false)
  })
})

describe('sign-in throttling', () => {
  let t: TestDb

  beforeEach(async () => {
    t = await createTestDb()
  })

  afterEach(async () => {
    await t.close()
  })

  const consume = async (ip: string, limit = 3) => {
    const res = await t.client.query<{ allowed: boolean }>(
      `select public.consume_signin_attempt($1, $2, '15 minutes'::interval) as allowed`,
      [ip, limit],
    )
    return res.rows[0]!.allowed
  }

  it('stops one address grinding through addresses', async () => {
    // The per-account lockout does nothing about this: one password tried
    // against thousands of addresses never gives any single account more than
    // one failure.
    expect(await consume('spray')).toBe(true)
    expect(await consume('spray')).toBe(true)
    expect(await consume('spray')).toBe(true)
    expect(await consume('spray')).toBe(false)
  })

  it('clears the counter after somebody signs in successfully', async () => {
    // Without this an office of twenty behind one NAT address locks itself out
    // on an ordinary Monday morning.
    await consume('office')
    await consume('office')
    await consume('office')
    expect(await consume('office')).toBe(false)

    await t.client.query(`select public.clear_signin_attempts($1)`, ['office'])
    expect(await consume('office')).toBe(true)
  })

  it('counts each address separately', async () => {
    await consume('noisy')
    await consume('noisy')
    await consume('noisy')
    expect(await consume('noisy')).toBe(false)
    expect(await consume('quiet')).toBe(true)
  })

  it('is not readable or resettable by the application role', async () => {
    await expect(
      t.client.exec(`set role syncrese_app; select * from signin_attempts;`),
    ).rejects.toThrow(/permission denied/i)
    await t.sudo('reset role')
  })
})

describe('recovery codes', () => {
  it('generates ten distinct codes', () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
  })

  it('avoids characters people confuse when reading them aloud', () => {
    // These get printed, written down and read down a phone line.
    for (const code of generateRecoveryCodes()) {
      expect(code).not.toMatch(/[01OIL]/)
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/)
    }
  })

  it('normalises however somebody types one back', () => {
    const code = generateRecoveryCodes(1)[0]!
    const bare = code.replace('-', '')
    expect(normaliseRecoveryCode(code.toLowerCase())).toBe(bare)
    expect(normaliseRecoveryCode(` ${code} `)).toBe(bare)
    expect(normaliseRecoveryCode(code.replace('-', ' '))).toBe(bare)
  })
})
