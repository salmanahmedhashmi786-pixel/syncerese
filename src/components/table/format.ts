/**
 * Client-side money formatting.
 *
 * Mirrors the minor-unit table in `@/finance/money` rather than importing it,
 * because that module pulls in AppError and the server error taxonomy — not
 * something to ship to the browser for a currency lookup.
 */
const MINOR_UNITS: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

export const minorUnitsFor = (code: string): number => MINOR_UNITS[code?.toUpperCase()] ?? 2

export function formatMoneyClient(amountMinor: number, currency: string, locale: string): string {
  const scale = minorUnitsFor(currency)
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
    }).format(amountMinor / 10 ** scale)
  } catch {
    // An unknown currency code must not blank the whole table.
    return `${(amountMinor / 10 ** scale).toFixed(scale)} ${currency}`
  }
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value)
}
