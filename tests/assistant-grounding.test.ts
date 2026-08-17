import { describe, it, expect } from 'vitest'
import { checkGrounding, extractNumbers, groundedValues } from '@/assistant/grounding'

/**
 * The anti-hallucination guarantee.
 *
 * These tests are the reason the assistant can be shipped in a finance product.
 * The catalogue makes sure it only SEES real rows; this makes sure the sentence
 * it writes about them is faithful, which is a separate claim and the one a
 * customer actually cares about.
 */

const INVOICE_ROWS = [
  {
    invoiceNo: 'INV-2026-0042',
    partnerName: 'Milano Impianti Srl',
    dueDate: '2026-03-04',
    currencyCode: 'EUR',
    totalMinor: 120_400,
    amountPaidMinor: 0,
    outstandingMinor: 120_400,
    daysOverdue: 12,
  },
  {
    invoiceNo: 'INV-2026-0043',
    partnerName: 'Nordwind Logistik AG',
    dueDate: '2026-03-11',
    currencyCode: 'EUR',
    totalMinor: 720_000,
    amountPaidMinor: 200_000,
    outstandingMinor: 520_000,
    daysOverdue: 5,
  },
]

const FIELDS = ['totalMinor', 'amountPaidMinor', 'outstandingMinor', 'daysOverdue']
// daysOverdue is a figure but not an additive one — see the catalogue.
const SUMS = ['totalMinor', 'amountPaidMinor', 'outstandingMinor']
const retrieval = [{ rows: INVOICE_ROWS, numericFields: FIELDS, sumFields: SUMS }]

describe('extracting figures from an answer', () => {
  it('finds numbers in both separator conventions', () => {
    expect(extractNumbers('The total is 1,204.00')).toContain(1204)
    expect(extractNumbers('Der Betrag ist 1.204,00')).toContain(1204)
  })

  it('ignores digits that are part of an identifier', () => {
    // INV-2026-0042 is a name, not a quantity. Treating its digits as claims
    // would make almost every answer that cites an invoice number fail.
    const found = extractNumbers('Invoice INV-2026-0042 is overdue')
    expect(found).not.toContain(2026)
    expect(found).not.toContain(42)
  })

  it('ignores numbers inside backticks', () => {
    expect(extractNumbers('See `INV-9999` for details')).not.toContain(9999)
  })
})

describe('what an answer is allowed to say', () => {
  it('admits a retrieved amount in minor units and in major units', () => {
    const { allowed } = groundedValues(INVOICE_ROWS, FIELDS, SUMS)
    expect(allowed.has(120_400)).toBe(true) // as stored
    expect(allowed.has(1204)).toBe(true) // as a person writes it
  })

  it('admits the sum of a whole column', () => {
    // So the model can say "€6,404 outstanding in total" without being handed a
    // pre-computed total.
    const { allowed } = groundedValues(INVOICE_ROWS, FIELDS, SUMS)
    expect(allowed.has(640_400)).toBe(true)
    expect(allowed.has(6404)).toBe(true)
  })

  it('admits the row count and small structural numbers', () => {
    const { allowed } = groundedValues(INVOICE_ROWS, FIELDS, SUMS)
    expect(allowed.has(2)).toBe(true)
    expect(allowed.has(12)).toBe(true)
  })

  it('respects currencies without two decimal places', () => {
    const jpy = [{ currencyCode: 'JPY', totalMinor: 124_000 }]
    const { allowed } = groundedValues(jpy, ['totalMinor'], ['totalMinor'])
    expect(allowed.has(124_000)).toBe(true)
    // 124000 minor units of JPY is ¥124,000, NOT ¥1,240.
    expect(allowed.has(1240)).toBe(false)
  })
})

describe('checking a drafted answer', () => {
  it('passes an answer that quotes the data correctly', () => {
    const answer =
      'Two invoices are outstanding: INV-2026-0042 for €1,204.00 from Milano Impianti Srl, ' +
      'and INV-2026-0043 with €5,200.00 still due. That is €6,404.00 in total.'
    expect(checkGrounding(answer, retrieval).grounded).toBe(true)
  })

  it('REJECTS a transposed figure', () => {
    // 1204 → 1240. The single most likely way a model gets this wrong, and
    // completely invisible to a reader who does not have the invoice open.
    const result = checkGrounding('Milano Impianti owes €1,240.00.', retrieval)
    expect(result.grounded).toBe(false)
    expect(result.ungrounded).toContain(1240)
  })

  it('REJECTS a plausible total that was never retrieved', () => {
    const result = checkGrounding('You are owed €47,300 across your customers.', retrieval)
    expect(result.grounded).toBe(false)
  })

  it('REJECTS an invented extra invoice count', () => {
    const result = checkGrounding('There are 17 invoices outstanding.', retrieval)
    expect(result.grounded).toBe(false)
    expect(result.ungrounded).toContain(17)
  })

  it('passes an answer with no figures at all', () => {
    // A negative result is a true and useful sentence. Refusing it would make
    // the assistant useless for every "no, nothing matched".
    expect(
      checkGrounding('I could not find any invoices for that customer.', []).grounded,
    ).toBe(true)
  })

  it('passes dates that appear in the retrieved rows', () => {
    const result = checkGrounding('The oldest is due on 2026-03-04.', retrieval)
    expect(result.grounded).toBe(true)
  })

  it('REJECTS a percentage it derived on its own', () => {
    // Arithmetic this file does not model is rejected on purpose. A refusal is
    // recoverable; a confidently wrong figure in a finance product is not.
    const result = checkGrounding('That is 81% of what you are owed.', retrieval)
    expect(result.grounded).toBe(false)
    expect(result.ungrounded).toContain(81)
  })

  it('tolerates a rounded rendering but not a paraphrase', () => {
    const rows = [{ currencyCode: 'EUR', outstandingMinor: 120_400.4 }]
    const r = [{ rows, numericFields: ['outstandingMinor'], sumFields: ['outstandingMinor'] }]
    expect(checkGrounding('€1,204.00 is due.', r).grounded).toBe(true)
    // "about 1,200" is not the figure, and a reader would quote it back to
    // their accountant as though it were.
    expect(checkGrounding('About €1,200 is due.', r).grounded).toBe(false)
  })

  it('is not fooled by an answer that mixes one real figure with one invented', () => {
    const result = checkGrounding(
      'INV-2026-0042 is €1,204.00 and INV-2026-0043 is €9,999.00.',
      retrieval,
    )
    expect(result.grounded).toBe(false)
    expect(result.ungrounded).toContain(9999)
  })
})
