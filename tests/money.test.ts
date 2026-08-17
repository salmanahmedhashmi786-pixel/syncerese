import { describe, expect, it } from 'vitest'
import {
  allocate,
  convertToBase,
  formatMoney,
  minorUnitsFor,
  parseMoney,
  taxOn,
} from '@/finance/money'

describe('money', () => {
  describe('parseMoney', () => {
    it('parses decimals without touching binary floating point', () => {
      expect(parseMoney('1234.56', 'EUR')).toBe(123456)
      expect(parseMoney('0.01', 'EUR')).toBe(1)
      expect(parseMoney('-42.50', 'EUR')).toBe(-4250)
      expect(parseMoney('1000', 'EUR')).toBe(100000)
    })

    it('accepts a comma as the decimal separator', () => {
      // German and French users type it this way and will not stop.
      expect(parseMoney('1234,56', 'EUR')).toBe(123456)
    })

    it('respects the currency’s minor units', () => {
      expect(minorUnitsFor('JPY')).toBe(0)
      expect(parseMoney('1234', 'JPY')).toBe(1234)
      expect(minorUnitsFor('KWD')).toBe(3)
      expect(parseMoney('1.234', 'KWD')).toBe(1234)
    })

    it('rejects more precision than the currency has, rather than rounding silently', () => {
      // "I typed 1.005 and it saved 1.00" is a support ticket about missing money.
      expect(() => parseMoney('1.005', 'EUR')).toThrow(/2 decimal place/)
      expect(() => parseMoney('100.5', 'JPY')).toThrow(/0 decimal place/)
    })

    it('rejects nonsense', () => {
      expect(() => parseMoney('12.34.56', 'EUR')).toThrow()
      expect(() => parseMoney('abc', 'EUR')).toThrow()
    })

    it('does not lose the classic floating-point cases', () => {
      // 0.1 + 0.2 !== 0.3 in floats. In minor units it is just 10 + 20 === 30.
      expect(parseMoney('0.1', 'EUR') + parseMoney('0.2', 'EUR')).toBe(parseMoney('0.3', 'EUR'))
    })
  })

  describe('allocate', () => {
    it('splits so the parts sum EXACTLY to the whole', () => {
      // 100 / 3 rounds to 33.33 three times = 99.99, losing a cent. The ledger
      // would reject the resulting entry.
      const parts = allocate(10000, [1, 1, 1])
      expect(parts.reduce((a, b) => a + b, 0)).toBe(10000)
      expect(parts).toEqual([3334, 3333, 3333])
    })

    it('weights proportionally', () => {
      const parts = allocate(1000, [70, 30])
      expect(parts).toEqual([700, 300])
      expect(parts.reduce((a, b) => a + b, 0)).toBe(1000)
    })

    it('never loses a unit across awkward splits', () => {
      for (const total of [1, 7, 99, 100, 12345, 999999]) {
        for (const weights of [[1, 1], [1, 2, 3], [5, 5, 5, 5, 5, 5, 5], [1, 0, 0]]) {
          const parts = allocate(total, weights)
          expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
        }
      }
    })

    it('handles zero weights without dropping the amount', () => {
      const parts = allocate(500, [0, 0, 0])
      expect(parts.reduce((a, b) => a + b, 0)).toBe(500)
    })

    it('handles negative totals (credit notes)', () => {
      const parts = allocate(-10000, [1, 1, 1])
      expect(parts.reduce((a, b) => a + b, 0)).toBe(-10000)
    })
  })

  describe('convertToBase', () => {
    it('converts at the supplied rate', () => {
      expect(convertToBase(10000, 0.9, 'USD', 'EUR')).toBe(9000)
    })

    it('is a no-op when already in base currency', () => {
      expect(convertToBase(12345, 1, 'EUR', 'EUR')).toBe(12345)
    })

    it('rounds symmetrically around zero', () => {
      // Math.round(-0.5) is -0 in JavaScript, which would make a converted
      // credit and its mirrored debit differ by a cent and break the balance
      // check.
      expect(convertToBase(1, 0.5, 'USD', 'EUR')).toBe(1)
      expect(convertToBase(-1, 0.5, 'USD', 'EUR')).toBe(-1)
    })

    it('rescales between currencies with different minor units', () => {
      // JPY has no minor unit: ¥1000 at 0.0062 is €6.20 = 620 cents.
      expect(convertToBase(1000, 0.0062, 'JPY', 'EUR')).toBe(620)
    })

    it('rejects a non-positive rate', () => {
      expect(() => convertToBase(100, 0, 'USD', 'EUR')).toThrow()
      expect(() => convertToBase(100, -1, 'USD', 'EUR')).toThrow()
    })
  })

  describe('taxOn', () => {
    it('computes VAT at the stated rate', () => {
      expect(taxOn(10000, 0.19)).toBe(1900)
      expect(taxOn(10000, 0.21)).toBe(2100)
      expect(taxOn(3333, 0.19)).toBe(633) // 633.27 -> 633
    })

    it('returns zero for a zero rate rather than throwing', () => {
      expect(taxOn(10000, 0)).toBe(0)
    })
  })

  describe('formatMoney', () => {
    it('formats per locale and currency', () => {
      expect(formatMoney(123456, 'EUR', 'de-DE')).toContain('1.234,56')
      expect(formatMoney(123456, 'USD', 'en-US')).toBe('$1,234.56')
      // No stray decimals on a zero-decimal currency.
      expect(formatMoney(1234, 'JPY', 'en-US')).not.toContain('.')
    })
  })
})
