import { CATALOGUE, type CatalogueEntry } from './catalogue'

/**
 * Deterministic routing, for when no model is configured.
 *
 * A self-hosted installation on an isolated network cannot call anybody's API,
 * and that is a supported way to run this product. The alternative to this file
 * is an assistant that is simply dead in those deployments.
 *
 * Keyword matching picks a catalogue entry; the rows are then rendered as a
 * table with no prose around them. It cannot handle a question phrased sideways
 * and it will not summarise. What it will never do is state a figure that is
 * not in the table directly beneath it — which is the property that mattered.
 */

type Rule = {
  entry: string
  /** Any of these present in the question. */
  any: RegExp[]
  params?: (question: string) => Record<string, unknown>
}

/**
 * Money owed BY this workspace, rather than TO it.
 *
 * Anchored on word boundaries, and that is the point: "how much are we owed"
 * CONTAINS the substring "we owe", so an unanchored pattern flipped the
 * question's direction and answered with the payables figure: a real,
 * well-formatted, exactly-wrong number. The boundary excludes "owed",
 * because `d` is a word character.
 */
const PAYABLE = /\bsuppliers?\b|\bpayables?\b|\bbills?\b|\bwe owe\b|\bowe them\b/i

const RULES: Rule[] = [
  {
    entry: 'receivables.summary',
    any: [/how much (are|is) (we|i|it)?\s*owed/i, /total (receivable|outstanding)/i],
    params: (q) => ({ direction: PAYABLE.test(q) ? 'ap' : 'ar' }),
  },
  {
    entry: 'invoices.outstanding',
    any: [/overdue/i, /outstanding/i, /unpaid/i, /who owes/i, /chase/i, /owe/i],
    params: (q) => ({
      direction: PAYABLE.test(q) ? 'ap' : 'ar',
      onlyOverdue: /overdue|late|past due/i.test(q),
    }),
  },
  {
    entry: 'partners.top_by_revenue',
    any: [/top|biggest|largest|best/i],
    params: () => ({}),
  },
  {
    entry: 'inventory.low_stock',
    any: [/low stock/i, /reorder/i, /running (out|low)/i, /short of/i],
  },
  {
    entry: 'ledger.account_balances',
    any: [/balance/i, /cash position/i, /ledger/i, /account \d/i],
    params: (q) => {
      const code = /\b(\d{3,6})\b/.exec(q)
      return code ? { accountQuery: code[1] } : {}
    },
  },
  {
    entry: 'invoices.find',
    any: [/\binv[- ]?\d/i, /invoice/i, /credit note/i, /bill/i],
    params: (q) => {
      const no = /\b([A-Z]{2,4}-[\w-]*\d[\w-]*)\b/.exec(q)
      return no ? { invoiceNo: no[1] } : {}
    },
  },
  {
    entry: 'partners.find',
    any: [/customer|supplier|partner|contact|client/i],
  },
]

export type Routed = { entry: CatalogueEntry; params: Record<string, unknown> }

/**
 * Picks a lookup for a question, or nothing.
 *
 * `available` is the catalogue already filtered to what this user may read, so
 * a rule matching something they have no permission for simply finds no entry
 * and falls through to the next — the fallback cannot reach further than the
 * model path could.
 */
export function routeQuestion(question: string, available: CatalogueEntry[]): Routed | null {
  for (const rule of RULES) {
    if (!rule.any.some((re) => re.test(question))) continue
    const entry = available.find((e) => e.name === rule.entry)
    if (!entry) continue
    return { entry, params: rule.params?.(question) ?? {} }
  }
  return null
}

/** Everything the deterministic router knows how to answer, for the panel's
 *  empty state. Written from the catalogue so it cannot drift out of date. */
export const routableExamples = (available: CatalogueEntry[]): string[] => {
  const names = new Set(available.map((e) => e.name))
  const examples: [string, string][] = [
    ['receivables.summary', 'How much are we owed?'],
    ['invoices.outstanding', 'What is overdue?'],
    ['partners.top_by_revenue', 'Who are our biggest customers?'],
    ['inventory.low_stock', 'What needs reordering?'],
    ['ledger.account_balances', 'What is the balance of account 1200?'],
  ]
  return examples.filter(([name]) => names.has(name)).map(([, text]) => text)
}

/** Sanity: every rule points at a catalogue entry that exists. A typo here
 *  would silently disable one branch of the fallback, which is invisible until
 *  a customer on an isolated network reports that a question stopped working. */
export const unknownRuleTargets = (): string[] =>
  RULES.map((r) => r.entry).filter((name) => !CATALOGUE.some((e) => e.name === name))
