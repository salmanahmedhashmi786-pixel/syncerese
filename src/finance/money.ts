import { AppError } from '@/lib/errors'

/**
 * Money is an integer count of MINOR UNITS plus a currency. Never a float.
 *
 * 0.1 + 0.2 !== 0.3 in binary floating point. In a ledger that is not a
 * curiosity — it is an entry that fails to balance by one cent, and an
 * accountant who stops trusting the system.
 *
 * `bigint` in Postgres, `number` in JS. That is safe because 2^53 minor units
 * is roughly 90 trillion currency units; `assertSafeMinor` enforces the bound
 * rather than assuming it.
 */
export type Minor = number

export type Money = {
  amountMinor: Minor
  currencyCode: string
}

/** Minor units per major unit. JPY has 0, KWD has 3 — a hard-coded 100 is a
 *  rounding bug waiting for the first non-EUR/USD customer. */
const MINOR_UNITS: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

export const minorUnitsFor = (currencyCode: string): number =>
  MINOR_UNITS[currencyCode.toUpperCase()] ?? 2

export function assertSafeMinor(value: number, what = 'amount'): Minor {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new AppError('VALIDATION_FAILED', `${what} must be a whole number of minor units`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new AppError('VALIDATION_FAILED', `${what} exceeds the maximum supported value`)
  }
  return value
}

/** Parses a human-entered decimal into minor units WITHOUT going through
 *  binary floating point — the string is split on the decimal separator and
 *  the parts are combined as integers. */
export function parseMoney(input: string | number, currencyCode: string): Minor {
  const scale = minorUnitsFor(currencyCode)
  const raw = String(input).trim().replace(/\s|_/g, '')
  if (raw === '') return 0

  const m = /^([+-]?)(\d*)(?:[.,](\d*))?$/.exec(raw)
  if (!m) throw new AppError('VALIDATION_FAILED', `"${input}" is not a valid amount`)

  const sign = m[1] === '-' ? -1 : 1
  const whole = m[2] || '0'
  const frac = m[3] ?? ''

  if (frac.length > scale) {
    // Silently rounding a user's typed input is how "I entered 1.005 and it
    // saved 1.00" becomes a support ticket about missing money.
    throw new AppError(
      'VALIDATION_FAILED',
      `${currencyCode} supports ${scale} decimal place(s); "${input}" has ${frac.length}`,
    )
  }

  const padded = frac.padEnd(scale, '0')
  const combined = Number(whole) * 10 ** scale + Number(padded || '0')
  return assertSafeMinor(sign * combined)
}

export function formatMoney(
  amountMinor: Minor,
  currencyCode: string,
  locale = 'en-US',
): string {
  const scale = minorUnitsFor(currencyCode)
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).format(amountMinor / 10 ** scale)
}

/**
 * Converts an amount to the organization's base currency.
 *
 * Rounds HALF-UP on the absolute value, so -0.5 rounds to -1 rather than 0.
 * JavaScript's Math.round is asymmetric for negatives (Math.round(-0.5) === -0),
 * which would make a converted credit and its mirrored debit differ by a cent
 * and break the balance check.
 */
export function convertToBase(
  amountMinor: Minor,
  fxRate: number | string,
  fromCurrency: string,
  baseCurrency: string,
): Minor {
  const rate = typeof fxRate === 'string' ? Number(fxRate) : fxRate
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new AppError('VALIDATION_FAILED', 'Exchange rate must be a positive number')
  }
  if (fromCurrency === baseCurrency) return assertSafeMinor(amountMinor)

  // Rescale between currencies with different minor units, e.g. JPY (0) -> EUR (2).
  const fromScale = minorUnitsFor(fromCurrency)
  const toScale = minorUnitsFor(baseCurrency)
  const scaled = (amountMinor * rate * 10 ** toScale) / 10 ** fromScale

  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled))
  return assertSafeMinor(rounded)
}

/**
 * Splits an amount across weights so the parts sum EXACTLY to the whole.
 *
 * Used for allocating a discount or a rounding difference across invoice lines.
 * Rounding each share independently loses or invents cents — distributing the
 * remainder one unit at a time to the largest fractional parts (the largest
 * remainder method) does not. A single stray cent is enough to leave an entry
 * unbalanced and rejected by the ledger.
 */
export function allocate(totalMinor: Minor, weights: number[]): Minor[] {
  if (weights.length === 0) return []
  const totalWeight = weights.reduce((a, b) => a + b, 0)

  if (totalWeight === 0) {
    // Nothing to weight by: put it all on the first line rather than dropping it.
    return weights.map((_, i) => (i === 0 ? totalMinor : 0))
  }

  const exact = weights.map((w) => (totalMinor * w) / totalWeight)
  const floored = exact.map((v) => Math.floor(v))
  let remainder = totalMinor - floored.reduce((a, b) => a + b, 0)

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)

  const out = [...floored]
  let k = 0
  while (remainder > 0 && order.length > 0) {
    out[order[k % order.length]!.i]! += 1
    remainder -= 1
    k += 1
  }
  while (remainder < 0 && order.length > 0) {
    out[order[k % order.length]!.i]! -= 1
    remainder += 1
    k += 1
  }
  return out
}

/** Tax on a net amount, half-up on the absolute value for the same reason as
 *  convertToBase. */
export function taxOn(netMinor: Minor, rate: number | string): Minor {
  const r = typeof rate === 'string' ? Number(rate) : rate
  if (!Number.isFinite(r) || r < 0) {
    throw new AppError('VALIDATION_FAILED', 'Tax rate must be a non-negative number')
  }
  const exact = netMinor * r
  return assertSafeMinor(Math.sign(exact) * Math.round(Math.abs(exact)))
}
