/**
 * Shared SQL fragments for reading the `invoices` table.
 *
 * Credit notes live in that table as ordinary rows with `document_type_code`
 * 381 and POSITIVE amounts — the sign lives in the document type, not in the
 * numbers (see credit-notes.ts for why). That is the right storage decision and
 * a trap for every reader: `sum(base_total_minor)` over a customer's invoices
 * silently ADDS their credit notes to revenue.
 *
 * There were nine places reading this table when credit notes were introduced.
 * Nine hand-written CASE expressions would have drifted, and the failure mode is
 * an overstated revenue figure that looks plausible — so the expression is
 * written once, here.
 *
 * These are fragments interpolated with `sql.raw`, so they must never carry a
 * caller-supplied value. `alias` is the table alias in the surrounding query and
 * is validated as a plain identifier.
 */

const ALIAS_RE = /^[a-z_][a-z0-9_]*$/i

function checkAlias(alias: string): string {
  if (!ALIAS_RE.test(alias)) throw new Error(`Invalid SQL alias: ${alias}`)
  return alias
}

/** The credit-note discriminator. UNTDID 1001: 380 invoice, 381 credit note. */
export function isCreditNote(alias = 'i'): string {
  return `${checkAlias(alias)}.document_type_code = '381'`
}

/** `false` for a credit note — for the WHERE clause of anything that means
 *  "real invoices only", such as an aging report. */
export function excludeCreditNotes(alias = 'i'): string {
  return `${checkAlias(alias)}.document_type_code <> '381'`
}

/**
 * Base-currency value with the credit note's sign applied.
 *
 * Use for revenue, turnover and any "how much did we bill this customer"
 * figure. A customer invoiced €10,000 and credited €2,000 has revenue of
 * €8,000, and that is the number they will check against their own records.
 */
export function signedBaseTotal(alias = 'i'): string {
  const a = checkAlias(alias)
  return `(case when ${a}.document_type_code = '381' then -${a}.base_total_minor else ${a}.base_total_minor end)`
}

/** Document-currency equivalent of `signedBaseTotal`. */
export function signedTotal(alias = 'i'): string {
  const a = checkAlias(alias)
  return `(case when ${a}.document_type_code = '381' then -${a}.total_minor else ${a}.total_minor end)`
}

/**
 * What is still owed on an invoice.
 *
 * Credits reduce it exactly as payments do. Leaving `credited_minor` out is how
 * a fully credited invoice keeps appearing on the aging report and in the
 * dunning run — the customer owes nothing and is chased anyway.
 */
export function outstanding(alias = 'i'): string {
  const a = checkAlias(alias)
  return `(${a}.total_minor - ${a}.amount_paid_minor - ${a}.credited_minor)`
}
