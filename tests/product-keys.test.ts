import { beforeEach, describe, expect, it } from 'vitest'
import {
  DURATIONS,
  formatProductKey,
  generateProductKey,
  hashProductKey,
  isKnownDuration,
  isWellFormed,
  keyLast4,
  normaliseProductKey,
} from '@/licensing/product-key'

/**
 * Product keys.
 *
 * A key is read off paper and typed by a human, often over the phone. The tests
 * that matter are the ones about what happens when they get it slightly wrong.
 */

describe('product key format', () => {
  beforeEach(() => {
    process.env.LICENSE_KEY_PEPPER = 'test-pepper'
  })

  it('looks like the agreed format', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateProductKey()).toMatch(/^SYNC-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/)
    }
  })

  it('never contains a character people misread', () => {
    // I/1 and O/0 are the pairs that get confused; U is excluded so a random
    // key cannot spell something unfortunate.
    for (let i = 0; i < 200; i++) {
      expect(generateProductKey().slice(5)).not.toMatch(/[ILOU]/)
    }
  })

  it('generates distinct keys', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateProductKey()))
    expect(keys.size).toBe(500)
  })

  it('accepts its own keys', () => {
    for (let i = 0; i < 50; i++) {
      expect(isWellFormed(generateProductKey())).toBe(true)
    }
  })

  // -------------------------------------------------------------------------
  // The whole point of the check character
  // -------------------------------------------------------------------------

  it('catches EVERY single mistyped character', () => {
    // Exhaustive, not sampled — every position, every replacement. This is the
    // property the odd weights buy: because an odd weight is coprime with 32,
    // `delta × weight ≡ 0 (mod 32)` forces delta to be zero, so no single
    // substitution can slip through. Weighting by `i + 1` instead misses about
    // one in seventeen.
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    const missed: string[] = []

    for (let k = 0; k < 20; k++) {
      const body = normaliseProductKey(generateProductKey())!
      for (let pos = 0; pos < body.length; pos++) {
        for (const replacement of ALPHABET) {
          if (replacement === body[pos]) continue
          const mutated = body.slice(0, pos) + replacement + body.slice(pos + 1)
          if (isWellFormed(mutated)) missed.push(`${body} → ${mutated}`)
        }
      }
    }

    expect(missed).toEqual([])
  })

  it('catches nearly every adjacent transposition', () => {
    // What weighting at all is for: an unweighted sum gives "…AB…" and "…BA…"
    // the same check character, and swapping two characters is exactly what
    // people do when typing from paper.
    //
    // Adjacent weights differ by 2, so a swap of two characters whose values
    // differ by exactly 16 moves the sum by 32 ≡ 0 and slips through — about
    // one in sixteen. Closing that needs a prime modulus, which costs either
    // the unambiguous alphabet or a check character outside it. Asserted at the
    // level actually achieved so a regression is still visible.
    let caught = 0
    let tried = 0

    for (let i = 0; i < 400; i++) {
      const body = normaliseProductKey(generateProductKey())!
      const pos = i % (body.length - 2)
      if (body[pos] === body[pos + 1]) continue

      tried++
      const swapped = body.slice(0, pos) + body[pos + 1] + body[pos] + body.slice(pos + 2)
      if (!isWellFormed(swapped)) caught++
    }

    expect(tried).toBeGreaterThan(300)
    expect(caught / tried).toBeGreaterThan(0.9)
  })

  // -------------------------------------------------------------------------
  // Being forgiving about how it was typed
  // -------------------------------------------------------------------------

  it('accepts a key however somebody types it back', () => {
    const key = generateProductKey()
    const body = normaliseProductKey(key)!

    const variants = [
      key.toLowerCase(),
      key.replace(/-/g, ''),
      key.replace(/-/g, ' '),
      `  ${key}  `,
      key.slice(5), // pasted without the SYNC- prefix
    ]

    for (const variant of variants) {
      expect(normaliseProductKey(variant), variant).toBe(body)
      expect(isWellFormed(variant), variant).toBe(true)
    }
  })

  it('reads I and L as 1, and O as 0', () => {
    // Crockford's own decoding rule. Somebody reading a key aloud says "oh"
    // for zero about half the time.
    const key = generateProductKey()
    const body = normaliseProductKey(key)!

    const confused = body.replace(/1/g, 'I').replace(/0/g, 'O')
    expect(normaliseProductKey(confused)).toBe(body)

    const alsoConfused = body.replace(/1/g, 'l')
    expect(normaliseProductKey(alsoConfused)).toBe(body)
  })

  it('rejects anything that is not a key', () => {
    expect(isWellFormed('')).toBe(false)
    expect(isWellFormed('SYNC-12345')).toBe(false)
    expect(isWellFormed('hello world')).toBe(false)
    expect(isWellFormed('SYNC-UUUUU-UUUUU-UUUUU-UUUUU')).toBe(false)
    expect(normaliseProductKey('SYNC-12345-12345-12345-123456')).toBeNull()
  })

  it('round-trips to the canonical form', () => {
    const key = generateProductKey()
    expect(formatProductKey(key.toLowerCase().replace(/-/g, ''))).toBe(key)
  })

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  it('hashes the same key identically however it was typed', () => {
    // Hashing the raw input would make "the same key" a dozen different rows,
    // and a customer who typed a lower-case O would be told their key is
    // invalid.
    const key = generateProductKey()
    const hash = hashProductKey(key)

    expect(hash).toBe(hashProductKey(key.toLowerCase()))
    expect(hash).toBe(hashProductKey(key.replace(/-/g, '')))
    expect(hash).toBe(hashProductKey(normaliseProductKey(key)!.replace(/0/g, 'O')))
  })

  it('does not leak the key through its hash', () => {
    const key = generateProductKey()
    const hash = hashProductKey(key)!
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(normaliseProductKey(key)!)
  })

  it('is peppered, so a leaked table is not a set of working keys', () => {
    const key = generateProductKey()
    const withPepper = hashProductKey(key)

    process.env.LICENSE_KEY_PEPPER = 'a-different-pepper'
    expect(hashProductKey(key)).not.toBe(withPepper)
  })

  it('shows the last four so two keys can be told apart', () => {
    const key = generateProductKey()
    expect(keyLast4(key)).toBe(normaliseProductKey(key)!.slice(-4))
    expect(keyLast4(key)).toHaveLength(4)
  })
})

describe('licence terms', () => {
  it('offers exactly the three terms asked for', () => {
    expect(DURATIONS.map((d) => d.days)).toEqual([3, 30, 365])
  })

  it('recognises them and rejects anything else', () => {
    expect(isKnownDuration(3)).toBe(true)
    expect(isKnownDuration(30)).toBe(true)
    expect(isKnownDuration(365)).toBe(true)
    expect(isKnownDuration(7)).toBe(false)
    expect(isKnownDuration(0)).toBe(false)
    expect(isKnownDuration(-30)).toBe(false)
  })
})
