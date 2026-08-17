import { hash, verify } from '@node-rs/argon2'
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto'

/**
 * @node-rs/argon2 exports `Algorithm` as a const enum, which `isolatedModules`
 * cannot reference. The numeric value is part of the library's public ABI
 * (Argon2d=0, Argon2i=1, Argon2id=2) and is stated explicitly here rather than
 * relying on the library default — the choice of variant is a security
 * parameter and should be visible in the source, not inherited silently.
 */
const ARGON2ID = 2 as const

/**
 * Credential hashing (MUST DO #18).
 *
 * argon2id, not bcrypt: bcrypt silently truncates at 72 bytes and has no
 * memory-hardness, so it is far cheaper to attack on GPUs. Parameters follow
 * the OWASP Password Storage recommendation for argon2id (19 MiB, t=2, p=1),
 * which is deliberately memory-bound rather than merely slow.
 */
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 12) {
    throw new Error('Password must be at least 12 characters')
  }
  // argon2 has no bcrypt-style truncation, but an unbounded input is a cheap
  // memory-exhaustion vector on a public endpoint.
  if (plain.length > 1024) {
    throw new Error('Password must be at most 1024 characters')
  }
  return hash(plain, OPTIONS)
}

/**
 * Always returns a boolean, never throws on a malformed stored hash — a
 * distinguishable error would let an attacker tell "no such user" from
 * "wrong password".
 */
export async function verifyPassword(plain: string, storedHash: string | null): Promise<boolean> {
  if (!storedHash) {
    // Spend comparable work for a user that has no password (SSO-only or
    // non-existent) so response timing does not enumerate accounts.
    await hash(randomBytes(16).toString('hex'), OPTIONS).catch(() => undefined)
    return false
  }
  try {
    return await verify(storedHash, plain, OPTIONS)
  } catch {
    return false
  }
}

/**
 * Opaque secrets — API keys, licence keys, invitation tokens — are stored as
 * SHA-256 rather than argon2.
 *
 * These are high-entropy values we generate ourselves, so they are not
 * brute-forceable and do not need a slow KDF; they *are* verified on every API
 * request, where argon2's memory cost would be a self-inflicted denial of
 * service. Passwords are low-entropy and human-chosen, which is why they get
 * the expensive treatment above and these do not.
 */
export function hashOpaqueToken(token: string, pepper = process.env.LICENSE_KEY_PEPPER ?? ''): string {
  return createHash('sha256').update(`${pepper}:${token}`).digest('hex')
}

export function compareOpaqueToken(token: string, storedHash: string, pepper?: string): boolean {
  const computed = Buffer.from(hashOpaqueToken(token, pepper), 'hex')
  let stored: Buffer
  try {
    stored = Buffer.from(storedHash, 'hex')
  } catch {
    return false
  }
  if (computed.length !== stored.length) return false
  return timingSafeEqual(computed, stored)
}

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * The one password rule.
 *
 * Twelve characters and nothing else — no character-class requirements, which
 * push people towards `Password1!` and are worse than length. This matches the
 * `z.string().min(12)` used by signup and invitation acceptance; it exists as a
 * function so the reset flow, which validates outside a zod schema, cannot
 * drift to a different minimum.
 */
export function passwordPolicy(password: string): { ok: true } | { ok: false; reason: string } {
  if (password.length < 12) {
    return { ok: false, reason: 'Use at least 12 characters.' }
  }
  if (password.length > 1024) {
    // Argon2 on a megabyte of input is a denial of service against ourselves.
    return { ok: false, reason: 'That password is too long.' }
  }
  return { ok: true }
}
