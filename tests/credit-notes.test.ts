import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { invoiceLines, invoices } from '@/db/schema'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { createCreditNote } from '@/finance/credit-notes'
import { recordPayment } from '@/finance/payments'
import { agingReport, trialBalance } from '@/finance/reports'
import { accountBySubtype } from '@/finance/ledger'
import { createFinanceFixture, type FinanceFixture } from './helpers/finance'

/**
 * Credit notes.
 *
 * An issued invoice is immutable, so "I invoiced the wrong amount" has exactly
 * one correct answer and this is it. Most of what matters is arithmetic against
 * the LEDGER rather than against the invoice row: a credit note that updates the
 * document but posts a wrong entry produces books that do not tie out, which is
 * the failure a finance product cannot have.
 */

const RANGE = { from: '2026-01-01', to: '2026-12-31' }

/** Balance on an account across the whole test year, debit-positive. */
async function accountBalance(f: FinanceFixture, subtype: string): Promise<number> {
  return f.tx(async (tx) => {
    const accountId = await accountBySubtype(tx, f.orgId, subtype as never)
    const res = await tx.execute(sql`
      select coalesce(sum(jl.base_debit_minor) - sum(jl.base_credit_minor), 0)::bigint as v
      from journal_lines jl
      join journal_entries je on je.id = jl.journal_entry_id
      where jl.account_id = ${accountId}
        and je.status in ('posted','reversed')
    `)
    return Number((res as unknown as { rows: { v: string }[] }).rows[0]!.v)
  })
}

async function invoiceRow(f: FinanceFixture, id: string) {
  return f.tx(async (tx) => {
    const rows = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1)
    return rows[0]!
  })
}

/** An issued AR invoice: 2 × 500.00 net, 19% VAT → 1,190.00. */
async function issuedInvoice(f: FinanceFixture, opts: { qty?: number } = {}) {
  const created = await f.tx((tx) =>
    createInvoice(tx, f.actor, {
      direction: 'ar',
      businessPartnerId: f.customerId,
      issueDate: '2026-03-01',
      lines: [
        {
          description: 'Consulting',
          quantity: opts.qty ?? 2,
          unitPriceMinor: 50_000,
          taxRateId: f.vatRateId,
        },
      ],
    }),
  )
  await f.tx((tx) => issueInvoice(tx, f.actor, created.id))
  return created
}

describe('credit notes', () => {
  let f: FinanceFixture

  beforeAll(async () => {
    f = await createFinanceFixture()
  })

  afterAll(async () => {
    await f.t.close()
  })

  // -------------------------------------------------------------------------
  // The ledger
  // -------------------------------------------------------------------------

  it('reverses the invoice exactly, to the cent', async () => {
    const arBefore = await accountBalance(f, 'accounts_receivable')
    const revenueBefore = await accountBalance(f, 'revenue')
    const vatBefore = await accountBalance(f, 'vat_payable')

    const inv = await issuedInvoice(f)
    expect(inv.totalMinor).toBe(119_000)

    const arAfterInvoice = await accountBalance(f, 'accounts_receivable')
    expect(arAfterInvoice - arBefore).toBe(119_000)

    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, {
        invoiceId: inv.id,
        reason: 'Billed the wrong client',
        issueDate: '2026-03-05',
      }),
    )
    expect(cn.totalMinor).toBe(119_000)
    expect(cn.invoiceNo).toMatch(/^CN-\d{5}$/)

    // Still a draft: nothing has hit the ledger yet.
    expect(await accountBalance(f, 'accounts_receivable')).toBe(arAfterInvoice)

    await f.tx((tx) => issueInvoice(tx, f.actor, cn.id))

    // Every account is back exactly where it started. Not "close" — exactly,
    // because the credit note scales the invoice's own tax rather than
    // recomputing it from the rate.
    expect(await accountBalance(f, 'accounts_receivable')).toBe(arBefore)
    expect(await accountBalance(f, 'revenue')).toBe(revenueBefore)
    expect(await accountBalance(f, 'vat_payable')).toBe(vatBefore)
  })

  it('hits the same accounts as the invoice, with the signs flipped', async () => {
    // The trap: reusing the invoice's `isAr` flag for BOTH account selection and
    // sign would send an AR credit note to accounts payable and operating
    // expenses — balanced, posted, and completely wrong.
    const inv = await issuedInvoice(f)
    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, { invoiceId: inv.id, reason: 'Duplicate' }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, cn.id))

    const lines = await f.tx(async (tx) => {
      const row = (await tx.select().from(invoices).where(eq(invoices.id, cn.id)).limit(1))[0]!
      const res = await tx.execute(sql`
        select a.subtype as subtype, jl.base_debit_minor as dr, jl.base_credit_minor as cr
        from journal_lines jl
        join accounts a on a.id = jl.account_id
        where jl.journal_entry_id = ${row.journalEntryId}
        order by a.subtype
      `)
      return (res as unknown as { rows: { subtype: string; dr: string; cr: string }[] }).rows
    })

    const bySubtype = Object.fromEntries(
      lines.map((l) => [l.subtype, { dr: Number(l.dr), cr: Number(l.cr) }]),
    )

    // Receivables CREDITED (the customer owes less), revenue and VAT DEBITED.
    expect(bySubtype['accounts_receivable']).toEqual({ dr: 0, cr: 119_000 })
    expect(bySubtype['revenue']).toEqual({ dr: 100_000, cr: 0 })
    expect(bySubtype['vat_payable']).toEqual({ dr: 19_000, cr: 0 })
    expect(bySubtype['accounts_payable']).toBeUndefined()
    expect(bySubtype['operating_expense']).toBeUndefined()
  })

  it('keeps the trial balance in balance', async () => {
    const tb = await f.tx((tx) => trialBalance(tx, f.orgId, RANGE))
    expect(tb.inBalance).toBe(true)
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor)
  })

  // -------------------------------------------------------------------------
  // The invoice it credits
  // -------------------------------------------------------------------------

  it('marks the invoice credited and clears what is outstanding', async () => {
    const inv = await issuedInvoice(f)
    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, { invoiceId: inv.id, reason: 'Cancelled order' }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, cn.id))

    const after = await invoiceRow(f, inv.id)
    expect(after.status).toBe('credited')
    expect(after.creditedMinor).toBe(119_000)
    expect(after.totalMinor - after.amountPaidMinor - after.creditedMinor).toBe(0)
  })

  it('drops the invoice off the aging report', async () => {
    const inv = await issuedInvoice(f)

    const before = await f.tx((tx) =>
      agingReport(tx, f.orgId, { direction: 'ar', asOf: '2026-12-31' }),
    )
    expect(before.rows.some((r) => r.invoiceId === inv.id)).toBe(true)

    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, { invoiceId: inv.id, reason: 'Goods returned' }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, cn.id))

    const after = await f.tx((tx) =>
      agingReport(tx, f.orgId, { direction: 'ar', asOf: '2026-12-31' }),
    )
    // Gone, and the credit note has NOT taken its place. A credit note is
    // already reflected in the credited invoice; listing it separately would
    // subtract the same credit twice and report a negative receivable.
    expect(after.rows.some((r) => r.invoiceId === inv.id)).toBe(false)
    expect(after.rows.some((r) => r.invoiceId === cn.id)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Partial credits
  // -------------------------------------------------------------------------

  it('credits part of a line and leaves the rest payable', async () => {
    const inv = await issuedInvoice(f, { qty: 4 }) // 4 × 500 = 2,000 + VAT = 2,380
    const invRow = await invoiceRow(f, inv.id)
    expect(invRow.totalMinor).toBe(238_000)

    const sourceLine = await f.tx(async (tx) => {
      const rows = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id))
      return rows[0]!
    })

    // One of the four was returned.
    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, {
        invoiceId: inv.id,
        reason: 'One unit returned',
        lines: [{ sourceLineId: sourceLine.id, quantity: 1 }],
      }),
    )
    expect(cn.totalMinor).toBe(59_500) // 500 net + 95 VAT

    await f.tx((tx) => issueInvoice(tx, f.actor, cn.id))

    const after = await invoiceRow(f, inv.id)
    expect(after.creditedMinor).toBe(59_500)
    // Partly credited, nothing paid — still owed, and still an open receivable.
    expect(after.status).toBe('issued')
    expect(after.totalMinor - after.amountPaidMinor - after.creditedMinor).toBe(178_500)

    const aging = await f.tx((tx) =>
      agingReport(tx, f.orgId, { direction: 'ar', asOf: '2026-12-31' }),
    )
    const row = aging.rows.find((r) => r.invoiceId === inv.id)
    expect(row?.outstandingMinor).toBe(178_500)
  })

  it('settles an invoice that is part credited and part paid', async () => {
    const inv = await issuedInvoice(f) // 1,190.00
    const sourceLine = await f.tx(async (tx) => {
      const rows = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id))
      return rows[0]!
    })

    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, {
        invoiceId: inv.id,
        reason: 'Half not delivered',
        lines: [{ sourceLineId: sourceLine.id, quantity: 1 }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, cn.id))

    // The customer pays the remaining half.
    await f.tx((tx) =>
      recordPayment(tx, f.actor, {
        direction: 'in',
        paymentDate: '2026-04-01',
        bankAccountId: f.bankAccountId,
        amountMinor: 59_500,
        allocations: [{ invoiceId: inv.id, amountMinor: 59_500 }],
      }),
    )

    const after = await invoiceRow(f, inv.id)
    // Fully settled. Left at 'partially_paid' it would be chased forever by
    // every dunning run, for money the customer does not owe.
    expect(after.status).toBe('paid')
    expect(after.totalMinor - after.amountPaidMinor - after.creditedMinor).toBe(0)
  })

  it('refuses a payment larger than what is left after crediting', async () => {
    const inv = await issuedInvoice(f)
    const sourceLine = await f.tx(async (tx) => {
      const rows = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id))
      return rows[0]!
    })
    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, {
        invoiceId: inv.id,
        reason: 'Half returned',
        lines: [{ sourceLineId: sourceLine.id, quantity: 1 }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, cn.id))

    await expect(
      f.tx((tx) =>
        recordPayment(tx, f.actor, {
          direction: 'in',
          paymentDate: '2026-04-01',
          bankAccountId: f.bankAccountId,
          amountMinor: 119_000,
          allocations: [{ invoiceId: inv.id, amountMinor: 119_000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('cannot be settled by a payment itself', async () => {
    const inv = await issuedInvoice(f)
    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, { invoiceId: inv.id, reason: 'Void' }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, cn.id))

    await expect(
      f.tx((tx) =>
        recordPayment(tx, f.actor, {
          direction: 'in',
          paymentDate: '2026-04-01',
          bankAccountId: f.bankAccountId,
          amountMinor: 1_000,
          allocations: [{ invoiceId: cn.id, amountMinor: 1_000 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  // -------------------------------------------------------------------------
  // Refusals
  // -------------------------------------------------------------------------

  it('refuses to credit a draft', async () => {
    const draft = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Draft', unitPriceMinor: 10_000 }],
      }),
    )
    await expect(
      f.tx((tx) => createCreditNote(tx, f.actor, { invoiceId: draft.id, reason: 'Oops' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses to credit more than the invoice is worth', async () => {
    const inv = await issuedInvoice(f)
    await f.tx((tx) =>
      createCreditNote(tx, f.actor, { invoiceId: inv.id, reason: 'First' }),
    ).then((cn) => f.tx((tx) => issueInvoice(tx, f.actor, cn.id)))

    // Fully credited already; a second one has nothing left to credit.
    await expect(
      f.tx((tx) => createCreditNote(tx, f.actor, { invoiceId: inv.id, reason: 'Again' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses to credit a credit note', async () => {
    const inv = await issuedInvoice(f)
    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, { invoiceId: inv.id, reason: 'Original' }),
    )
    await expect(
      f.tx((tx) => createCreditNote(tx, f.actor, { invoiceId: cn.id, reason: 'Credit the credit' })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses a credit note with no reason', async () => {
    const inv = await issuedInvoice(f)
    await expect(
      f.tx((tx) => createCreditNote(tx, f.actor, { invoiceId: inv.id, reason: '   ' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('refuses to credit more of a line than the invoice has', async () => {
    const inv = await issuedInvoice(f) // quantity 2
    const sourceLine = await f.tx(async (tx) => {
      const rows = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id))
      return rows[0]!
    })
    await expect(
      f.tx((tx) =>
        createCreditNote(tx, f.actor, {
          invoiceId: inv.id,
          reason: 'Too much',
          lines: [{ sourceLineId: sourceLine.id, quantity: 3 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('refuses a line belonging to a different invoice', async () => {
    const a = await issuedInvoice(f)
    const b = await issuedInvoice(f)
    const lineOfB = await f.tx(async (tx) => {
      const rows = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, b.id))
      return rows[0]!
    })
    await expect(
      f.tx((tx) =>
        createCreditNote(tx, f.actor, {
          invoiceId: a.id,
          reason: 'Wrong line',
          lines: [{ sourceLineId: lineOfB.id }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  // -------------------------------------------------------------------------
  // Database guards — service code is not the enforcement point
  // -------------------------------------------------------------------------

  it('will not let a credit note exist without something to credit', async () => {
    await expect(
      f.tx((tx) =>
        tx.execute(sql`
          update invoices set credits_invoice_id = null
          where document_type_code = '381' and organization_id = ${f.orgId}
        `),
      ),
    ).rejects.toThrow(/SYNC_CREDIT_LINK/)
  })

  it('will not let an ordinary invoice credit something', async () => {
    const inv = await issuedInvoice(f)
    const other = await issuedInvoice(f)
    await expect(
      f.tx((tx) =>
        tx.execute(sql`
          update invoices set credits_invoice_id = ${other.id} where id = ${inv.id}
        `),
      ),
    ).rejects.toThrow(/SYNC_CREDIT_LINK/)
  })

  it('will not let credited exceed the invoice total', async () => {
    const inv = await issuedInvoice(f)
    await expect(
      f.tx((tx) =>
        tx.execute(sql`
          update invoices set credited_minor = total_minor + 1 where id = ${inv.id}
        `),
      ),
    ).rejects.toThrow(/invoices_credited_within_total/)
  })

  it('will not accept an unknown document type', async () => {
    // Applied to a CREDIT NOTE rather than an invoice, because on an invoice
    // the link trigger fires first — anything that is not '380' is treated as a
    // credit note, and an invoice has nothing to credit — and that refusal
    // would mask whether the CHECK exists at all.
    const inv = await issuedInvoice(f)
    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, { invoiceId: inv.id, reason: 'Type check' }),
    )

    await expect(
      f.tx((tx) =>
        tx.execute(sql`update invoices set document_type_code = '999' where id = ${cn.id}`),
      ),
    ).rejects.toThrow(/invoices_document_type_code/)
  })
})

// ---------------------------------------------------------------------------
// AP and foreign currency
// ---------------------------------------------------------------------------

describe('credit notes on the purchase side', () => {
  let f: FinanceFixture

  beforeAll(async () => {
    f = await createFinanceFixture()
  })

  afterAll(async () => {
    await f.t.close()
  })

  it('reverses a supplier bill against payables and expenses', async () => {
    const apBefore = await accountBalance(f, 'accounts_payable')
    const expenseBefore = await accountBalance(f, 'operating_expense')

    const bill = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ap',
        businessPartnerId: f.supplierId,
        issueDate: '2026-03-01',
        lines: [
          { description: 'Materials', quantity: 1, unitPriceMinor: 80_000, taxRateId: f.vatRateId },
        ],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, bill.id))

    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, { invoiceId: bill.id, reason: 'Supplier overcharged' }),
    )
    // Its own series, not the sales one.
    expect(cn.invoiceNo).toMatch(/^VCN-\d{5}$/)

    await f.tx((tx) => issueInvoice(tx, f.actor, cn.id))

    expect(await accountBalance(f, 'accounts_payable')).toBe(apBefore)
    expect(await accountBalance(f, 'operating_expense')).toBe(expenseBefore)

    const tb = await f.tx((tx) => trialBalance(tx, f.orgId, RANGE))
    expect(tb.inBalance).toBe(true)
  })
})

describe('credit notes in a foreign currency', () => {
  let f: FinanceFixture

  beforeAll(async () => {
    f = await createFinanceFixture({ baseCurrency: 'EUR' })
  })

  afterAll(async () => {
    await f.t.close()
  })

  it('reverses at the invoice’s own rate, not today’s', async () => {
    const arBefore = await accountBalance(f, 'accounts_receivable')

    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        currencyCode: 'USD',
        fxRate: 0.9123,
        lines: [
          { description: 'Export', quantity: 3, unitPriceMinor: 33_333, taxRateId: f.vatRateId },
        ],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

    const cn = await f.tx((tx) =>
      createCreditNote(tx, f.actor, { invoiceId: inv.id, reason: 'Shipment lost' }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, cn.id))

    const cnRow = await invoiceRow(f, cn.id)
    expect(cnRow.currencyCode).toBe('USD')
    // Same rate as the original. Revaluing at a new one would post an FX
    // difference on a document that moved no money.
    expect(Number(cnRow.fxRate)).toBeCloseTo(0.9123, 6)

    // Back to exactly where it started, in base currency, despite the awkward
    // rate and the odd unit price.
    expect(await accountBalance(f, 'accounts_receivable')).toBe(arBefore)

    const tb = await f.tx((tx) => trialBalance(tx, f.orgId, RANGE))
    expect(tb.inBalance).toBe(true)
  })
})
