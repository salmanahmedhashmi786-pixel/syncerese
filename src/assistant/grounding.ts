import { minorUnitsFor } from '@/finance/money'
import type { CatalogueRow } from './catalogue'

/**
 * The anti-hallucination check (MUST DO #12).
 *
 * WHY THIS EXISTS AND NOT JUST A PROMPT
 *
 * The retrieval catalogue guarantees that the assistant only ever SEES real
 * rows. It does not guarantee that the sentence it writes about them is
 * faithful. A model handed `outstandingMinor: 120400` can still write "you are
 * owed €1,240" — a transposition, a rounding, a stray zero. Telling it not to
 * in the system prompt reduces the rate; it does not make the claim checkable.
 *
 * So every figure in the drafted answer is checked against the figures that
 * were actually retrieved. If one cannot be traced, the draft is REJECTED and
 * the user sees a refusal instead. That converts "we asked it nicely" into a
 * property of the system, which is the only version worth having in a product
 * where the number is the whole point.
 *
 * WHAT COUNTS AS GROUNDED
 *
 *   - a retrieved value, in minor units (120400) or formatted major units
 *     (1204, 1204.00, 1,204.00 — and the European 1.204,00)
 *   - a count of rows returned, and small integers up to that count, so
 *     "3 invoices" and "the first 2" are allowed
 *   - a sum of any single retrieved numeric column, so "€8,400 in total" is
 *     allowed without the model having to be handed a pre-computed total
 *   - years and other date parts appearing in the retrieved rows
 *   - a short whitelist of structural numbers (0, 1, 2… up to 12) that appear
 *     in ordinary prose — "the last 3 months", "both". Kept deliberately small:
 *     the larger this list, the weaker the guarantee.
 *
 * WHAT DOES NOT
 *
 *   Anything else. Including a number that is arithmetically derivable in a way
 *   this file does not model — an average, a percentage, a difference between
 *   two rows. Those are rejected, and that is the intended trade: a refusal is
 *   recoverable, a confidently wrong receivables figure is not.
 */

/** Numbers small enough to appear in ordinary prose without being a claim about
 *  the data. Twelve so that month counts pass. */
const STRUCTURAL_MAX = 12

/**
 * Every number-looking token in the text, as a normalised numeric value.
 *
 * Handles both conventions, because a workspace's answers may be read in either
 * and "1.204" is one thousand two hundred and four in Germany and roughly one
 * and a fifth in the UK. Both readings are returned as candidates, so an
 * ambiguous token is grounded if EITHER reading is real — the check must not
 * reject a correct answer because of a locale it guessed wrong.
 */
export function numberTokens(text: string): number[][] {
  // Everything that carries digits WITHOUT being a claim about a quantity is
  // removed first, whole. Scanning for numbers and then inspecting the
  // neighbouring character is not enough: in "INV-2026-0042" the run "-0042"
  // is preceded by a digit, so a character-level check accepts it and the
  // answer appears to assert minus forty-two.
  const cleaned = text
    // Anything the writer quoted as a name.
    .replace(/`[^`]*`/g, ' ')
    // ISO dates and timestamps. A date is not a quantity; whether the date
    // itself was in the data is `groundedDateParts`, a separate question.
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/g, ' ')
    // Identifiers: any run joining letters and digits, hyphens, slashes or
    // underscores. INV-2026-0042, Q4, PO/2026/17, account code 4000-01.
    .replace(/[\w/-]*[A-Za-z][\w/-]*/g, (token) => (/\d/.test(token) ? ' ' : token))
    // A hyphenated run of digits that survived the above is a range or a
    // partial date, not one figure.
    .replace(/\d+(?:-\d+)+/g, ' ')

  const tokens: number[][] = []
  for (const match of cleaned.matchAll(/-?\d[\d.,   ]*\d|-?\d/g)) {
    const raw = match[0]!.replace(/[   ]/g, '')
    const readings = readingsOf(raw).filter((v) => Number.isFinite(v))
    if (readings.length > 0) tokens.push(readings)
  }
  return tokens
}

/** Every reading of every figure, flattened. For diagnostics and tests — the
 *  check itself works per TOKEN, because a token's readings are alternatives,
 *  not separate claims. */
export const extractNumbers = (text: string): number[] => numberTokens(text).flat()

/**
 * How to read one token, given that "1.204" is one thousand two hundred and
 * four in Germany and roughly one and a fifth in the UK.
 *
 * Most tokens are NOT actually ambiguous, and resolving them matters: emitting
 * both readings of "9,999.00" produces the candidate 9.999, which sits within
 * rounding distance of the perfectly ordinary number 10 — so an invented figure
 * would slip through on a technicality.
 */
function readingsOf(raw: string): number[] {
  const anglo = () => Number(raw.replace(/,/g, ''))
  const euro = () => Number(raw.replace(/\./g, '').replace(/,/g, '.'))

  const hasComma = raw.includes(',')
  const hasDot = raw.includes('.')

  // Both present: the LAST one is the decimal separator. Unambiguous.
  if (hasComma && hasDot) {
    return [raw.lastIndexOf(',') > raw.lastIndexOf('.') ? euro() : anglo()]
  }

  const sep = hasComma ? ',' : hasDot ? '.' : null
  if (!sep) return [Number(raw)]

  // Repeated: it groups thousands, so it is the other convention's decimal
  // character being used for grouping. 1.204.000 is a million-ish, not a
  // decimal.
  const occurrences = raw.split(sep).length - 1
  if (occurrences > 1) return [sep === ',' ? anglo() : euro()]

  // Once, followed by exactly three digits: genuinely ambiguous. 1,204 is
  // either one thousand two hundred and four or one-point-two-oh-four.
  const tail = raw.slice(raw.lastIndexOf(sep) + 1)
  if (tail.length === 3) return [...new Set([anglo(), euro()])]

  // Once, followed by anything else: it is a decimal point. 1,5 / 1.5 / 12.50
  return [sep === ',' ? euro() : anglo()]
}

/**
 * Every value the answer is allowed to state, given what was retrieved.
 *
 * Minor-unit amounts are admitted in both their raw form and their major-unit
 * form, because the answer is written for a person: 120400 minor units is what
 * the database holds and "1,204.00" is what belongs in a sentence.
 */
export function groundedValues(
  rows: CatalogueRow[],
  numericFields: readonly string[],
  /**
   * Which of those columns it is meaningful to add up.
   *
   * Not all of them are. Totalling `daysOverdue` across two invoices that are
   * 12 and 5 days late yields 17, which is not a fact about anything — but
   * admitting it lets the model state "17" and be believed. Every column summed
   * here widens the set of numbers that pass, so the ones that are not
   * genuinely additive must be left out or the check quietly weakens itself.
   *
   * Defaults to nothing summable, so a catalogue entry that forgets to declare
   * this is stricter than intended rather than looser.
   */
  sumFields: readonly string[] = [],
): GroundedValues {
  const allowed = new Set<number>()

  for (let i = 0; i <= Math.max(STRUCTURAL_MAX, rows.length); i++) allowed.add(i)
  const fromData = new Set<number>()

  const columnTotals = new Map<string, number>()

  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      const n = numericValue(value)
      if (n === null) continue

      const isFigure = numericFields.includes(key)
      admit(allowed, n, isFigure ? currencyOf(row) : null)
      admit(fromData, n, isFigure ? currencyOf(row) : null)

      if (sumFields.includes(key)) columnTotals.set(key, (columnTotals.get(key) ?? 0) + n)
    }
  }

  // Whole-column sums of the additive columns only, so "€8,400 in total across
  // the three" needs no pre-computed total handed to the model. Never an
  // arbitrary SUBSET sum: with more than a handful of rows those cover so much
  // of the number line that the check would be off in all but name.
  for (const [key, total] of columnTotals) {
    const anyRow = rows.find((r) => numericValue(r[key]) !== null)
    admit(allowed, total, anyRow ? currencyOf(anyRow) : null)
    admit(fromData, total, anyRow ? currencyOf(anyRow) : null)
  }

  return { allowed, fromData }
}

export type GroundedValues = {
  /** Everything the answer may state exactly. */
  allowed: Set<number>
  /**
   * The subset that came from the tenant's data rather than from the structural
   * 0..N range.
   *
   * Only these get the rounding tolerance. Extending it to the structural
   * numbers means an invented "9,999.00" is accepted because its European
   * reading, 9.999, lands within a rounding of the ordinary number 10. The
   * tolerance exists to permit a rendering of a real figure, not to license
   * being approximately any small integer.
   */
  fromData: Set<number>
}

/** Adds a value and, when it is money, its major-unit rendering. */
function admit(into: Set<number>, value: number, currency: string | null): void {
  into.add(value)
  into.add(Math.abs(value))
  if (currency) {
    const scale = 10 ** minorUnitsFor(currency)
    const major = value / scale
    into.add(major)
    into.add(Math.abs(major))
    // Rounded to whole units, for "about €1,204".
    into.add(Math.round(major))
    into.add(Math.abs(Math.round(major)))
  }
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  // bigint and numeric columns arrive as strings from the driver.
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  // Everything else, dates included, is not a quantity. A date's parts are
  // handled by `groundedDateParts`, deliberately kept out of this set: a year
  // is not an amount and must not become a permitted one.
  return null
}

/** The currency this row is denominated in, if it says. */
function currencyOf(row: CatalogueRow): string | null {
  const code = row.currencyCode ?? row.baseCurrency
  return typeof code === 'string' && code.length === 3 ? code : null
}

/** Date parts from any ISO date in the rows, so "March 2026" is not a
 *  fabrication. Kept separate from `groundedValues` because a year is not a
 *  quantity and should not become a permitted amount. */
export function groundedDateParts(rows: CatalogueRow[]): Set<number> {
  const parts = new Set<number>()
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value !== 'string') continue
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
      if (!m) continue
      parts.add(Number(m[1]))
      parts.add(Number(m[2]))
      parts.add(Number(m[3]))
    }
  }
  return parts
}

export type GroundingResult = {
  grounded: boolean
  /** The figures that could not be traced. Logged, and shown in development —
   *  in production the user gets a refusal, not a diagnostic. */
  ungrounded: number[]
}

/**
 * Checks a drafted answer against what was retrieved.
 *
 * An answer that states no numbers at all is grounded by definition: "I could
 * not find any invoices for that customer" is a true and useful sentence, and
 * refusing it would make the assistant useless for every negative result.
 */
export function checkGrounding(
  answer: string,
  retrievals: {
    rows: CatalogueRow[]
    numericFields: readonly string[]
    sumFields?: readonly string[]
  }[],
): GroundingResult {
  const allowed = new Set<number>()
  const dates = new Set<number>()

  const tolerant = new Set<number>()

  for (const r of retrievals) {
    const values = groundedValues(r.rows, r.numericFields, r.sumFields ?? [])
    for (const v of values.allowed) allowed.add(v)
    for (const v of values.fromData) tolerant.add(v)
    for (const d of groundedDateParts(r.rows)) dates.add(d)
  }

  // Per TOKEN, not per reading. "1,204.00" is one claim that could mean 1204
  // or 1.204 depending on the reader's locale; it is grounded if EITHER
  // reading is real. Flattening the readings first would demand that a
  // correctly-quoted figure be valid under both conventions at once, which
  // rejects almost every true answer.
  const ungrounded: number[] = []
  for (const readings of numberTokens(answer)) {
    const ok = readings.some(
      (n) => allowed.has(n) || dates.has(n) || nearlyAllowed(n, tolerant),
    )
    if (!ok) ungrounded.push(readings[0]!)
  }

  return { grounded: ungrounded.length === 0, ungrounded }
}

/**
 * Tolerates a rounded rendering of a permitted value: 1204.004 → "1,204.00".
 *
 * Two decimal places of slack and nothing more. This is not a range check —
 * "about 1,200" for 1,204 is still rejected, because a figure a reader would
 * quote back to their accountant should be the figure, not a paraphrase.
 */
function nearlyAllowed(value: number, allowed: Set<number>): boolean {
  for (const a of allowed) {
    if (Math.abs(a - value) < 0.005) return true
  }
  return false
}
