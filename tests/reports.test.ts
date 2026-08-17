import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { recordPayment } from '@/finance/payments'
import { agingReport, balanceSheet, cashFlow, profitAndLoss, trialBalance } from '@/finance/reports'
import { createFinanceFixture, type FinanceFixture } from './helpers/finance'

const YEAR = { from: '2026-01-01', to: '2026-12-31' }

/**
 * Reports are derived from journal_lines only. Nothing here reads an invoice
 * total or a cached balance — the moment a report and the ledger can disagree,
 * one of them is lying and nobody knows which.
 */
describe('financial reports', () => {
  let f: FinanceFixture

  beforeAll(async () => {
    f = await createFinanceFixture()

    // Revenue: two sales, 1000 and 2000 net, both +19% VAT.
    for (const [amount, date] of [
      [1000_00, '2026-02-10'],
      [2000_00, '2026-03-12'],
    ] as const) {
      const inv = await f.tx((tx) =>
        createInvoice(tx, f.actor, {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: date,
          dueDate: date,
          lines: [{ description: 'Sale', unitPriceMinor: amount, taxRateId: f.vatRateId }],
        }),
      )
      await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))
      // Collect the first one only, so AR carries a balance.
      if (amount === 1000_00) {
        await f.tx((tx) =>
          recordPayment(tx, f.actor, {
            direction: 'in',
            paymentDate: '2026-02-28',
            bankAccountId: f.bankAccountId,
            amountMinor: 119000,
            allocations: [{ invoiceId: inv.id, amountMinor: 119000 }],
          }),
        )
      }
    }

    // Costs: one supplier bill of 400 net, paid.
    const bill = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ap',
        businessPartnerId: f.supplierId,
        issueDate: '2026-02-15',
        dueDate: '2026-02-15',
        lines: [{ description: 'Materials', unitPriceMinor: 400_00, taxRateId: f.vatRateId }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, bill.id))
    await f.tx((tx) =>
      recordPayment(tx, f.actor, {
        direction: 'out',
        paymentDate: '2026-02-20',
        bankAccountId: f.bankAccountId,
        amountMinor: 47600,
        allocations: [{ invoiceId: bill.id, amountMinor: 47600 }],
      }),
    )
  })

  afterAll(async () => {
    await f.t.close()
  })

  /**
   * These exercise ranges that EXCLUDE data.
   *
   * The original suite only ever asked for the full year, which contained
   * every seeded row — so a completely broken date filter produced identical
   * numbers and passed. A period report is only proven correct by a period
   * that leaves something out.
   */
  describe('period boundaries actually filter', () => {
    it('a month with no activity reports zero, not the annual total', async () => {
      const empty = await f.tx((tx) =>
        profitAndLoss(tx, f.orgId, { from: '2026-11-01', to: '2026-11-30' }),
      )
      expect(empty.totalIncomeMinor).toBe(0)
      expect(empty.totalOperatingExpensesMinor).toBe(0)
      expect(empty.netProfitMinor).toBe(0)
    })

    it('February alone reports only February revenue', async () => {
      // The 1000 sale was issued 2026-02-10; the 2000 sale on 2026-03-12.
      const feb = await f.tx((tx) =>
        profitAndLoss(tx, f.orgId, { from: '2026-02-01', to: '2026-02-28' }),
      )
      expect(feb.totalIncomeMinor).toBe(100000)

      const mar = await f.tx((tx) =>
        profitAndLoss(tx, f.orgId, { from: '2026-03-01', to: '2026-03-31' }),
      )
      expect(mar.totalIncomeMinor).toBe(200000)

      const both = await f.tx((tx) =>
        profitAndLoss(tx, f.orgId, { from: '2026-02-01', to: '2026-03-31' }),
      )
      expect(both.totalIncomeMinor).toBe(300000)
    })

    it('range boundaries are inclusive on both ends', async () => {
      const exact = await f.tx((tx) =>
        profitAndLoss(tx, f.orgId, { from: '2026-02-10', to: '2026-02-10' }),
      )
      expect(exact.totalIncomeMinor).toBe(100000)

      const dayBefore = await f.tx((tx) =>
        profitAndLoss(tx, f.orgId, { from: '2026-02-11', to: '2026-02-28' }),
      )
      expect(dayBefore.totalIncomeMinor).toBe(0)
    })

    it('trial balance for an empty period is empty but still balanced', async () => {
      const tb = await f.tx((tx) =>
        trialBalance(tx, f.orgId, { from: '2026-11-01', to: '2026-11-30' }),
      )
      expect(tb.rows).toEqual([])
      expect(tb.totalDebitMinor).toBe(0)
      expect(tb.inBalance).toBe(true)
    })

    it('balance sheet as at an early date excludes later activity', async () => {
      const early = await f.tx((tx) => balanceSheet(tx, f.orgId, '2026-01-31'))
      // Nothing had been posted by the end of January.
      expect(early.totalAssetsMinor).toBe(0)
      expect(early.balances).toBe(true)

      const later = await f.tx((tx) => balanceSheet(tx, f.orgId, '2026-12-31'))
      expect(later.totalAssetsMinor).toBeGreaterThan(0)
      expect(later.balances).toBe(true)
    })

    it('cash flow for an empty period reports no movement', async () => {
      const cf = await f.tx((tx) =>
        cashFlow(tx, f.orgId, { from: '2026-11-01', to: '2026-11-30' }),
      )
      expect(cf.inflowMinor).toBe(0)
      expect(cf.outflowMinor).toBe(0)
      // ...but opening cash still reflects everything before the window.
      expect(cf.openingCashMinor).toBeGreaterThan(0)
      expect(cf.closingCashMinor).toBe(cf.openingCashMinor)
    })
  })

  it('trial balance is in balance', async () => {
    const tb = await f.tx((tx) => trialBalance(tx, f.orgId, YEAR))
    expect(tb.inBalance).toBe(true)
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor)
    expect(tb.totalDebitMinor).toBeGreaterThan(0)
  })

  it('profit and loss reports revenue net of VAT', async () => {
    const pl = await f.tx((tx) => profitAndLoss(tx, f.orgId, YEAR))

    // VAT is a liability, never income: 3000 net, not 3570 gross.
    expect(pl.totalIncomeMinor).toBe(300000)
    expect(pl.totalOperatingExpensesMinor).toBe(40000)
    expect(pl.netProfitMinor).toBe(260000)
  })

  it('excludes reversed entries in net', async () => {
    const before = await f.tx((tx) => profitAndLoss(tx, f.orgId, YEAR))

    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-06-01',
        lines: [{ description: 'Mistake', unitPriceMinor: 500_00 }],
      }),
    )
    const issued = await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

    const withMistake = await f.tx((tx) => profitAndLoss(tx, f.orgId, YEAR))
    expect(withMistake.totalIncomeMinor).toBe(before.totalIncomeMinor + 50000)

    const { reverseJournalEntry } = await import('@/finance/ledger')
    await f.tx((tx) => reverseJournalEntry(tx, f.actor, issued.journalEntryId))

    // Both entries remain in the ledger; they cancel. The audit trail keeps the
    // mistake AND the correction visible, which is the point.
    const after = await f.tx((tx) => profitAndLoss(tx, f.orgId, YEAR))
    expect(after.totalIncomeMinor).toBe(before.totalIncomeMinor)
  })

  it('balance sheet balances: assets = liabilities + equity', async () => {
    const bs = await f.tx((tx) => balanceSheet(tx, f.orgId, '2026-12-31'))
    expect(bs.differenceMinor).toBe(0)
    expect(bs.balances).toBe(true)
  })

  it('balance sheet includes current-year earnings', async () => {
    const bs = await f.tx((tx) => balanceSheet(tx, f.orgId, '2026-12-31'))
    const pl = await f.tx((tx) => profitAndLoss(tx, f.orgId, YEAR))

    // Without this line the sheet cannot balance — profit has not yet been
    // closed to retained earnings. It is the most common reason a hand-rolled
    // balance sheet is out.
    expect(bs.currentYearEarningsMinor).toBe(pl.netProfitMinor)
  })

  it('current-year earnings TIE to the P&L when prior-year data exists', async () => {
    // Post something in the previous fiscal year. The balance sheet must then
    // split it into retained earnings rather than folding it into the current
    // year — otherwise the sheet and the P&L disagree for the same date, which
    // is exactly what an accountant checks first.
    const prior = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2025-11-15',
        dueDate: '2025-12-15',
        lines: [{ description: 'Prior year sale', unitPriceMinor: 900_00 }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, prior.id))

    const bs = await f.tx((tx) =>
      balanceSheet(tx, f.orgId, '2026-12-31', { fiscalYearStart: '2026-01-01' }),
    )
    const pl = await f.tx((tx) => profitAndLoss(tx, f.orgId, YEAR))

    expect(bs.currentYearEarningsMinor).toBe(pl.netProfitMinor)
    expect(bs.retainedEarningsMinor).toBe(90000)
    // And it must still balance with the split applied.
    expect(bs.differenceMinor).toBe(0)
  })

  it('balance sheet still balances after a payment moves cash around', async () => {
    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-07-01',
        lines: [{ description: 'Extra', unitPriceMinor: 750_00, taxRateId: f.vatRateId }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))
    await f.tx((tx) =>
      recordPayment(tx, f.actor, {
        direction: 'in',
        paymentDate: '2026-07-15',
        bankAccountId: f.bankAccountId,
        amountMinor: 44625,
        allocations: [{ invoiceId: inv.id, amountMinor: 44625 }],
      }),
    )

    const bs = await f.tx((tx) => balanceSheet(tx, f.orgId, '2026-12-31'))
    expect(bs.differenceMinor).toBe(0)
  })

  it('cash flow reconciles opening + movement = closing', async () => {
    const cf = await f.tx((tx) => cashFlow(tx, f.orgId, YEAR))
    expect(cf.openingCashMinor + cf.netMovementMinor).toBe(cf.closingCashMinor)
    expect(cf.inflowMinor).toBeGreaterThan(0)
    expect(cf.outflowMinor).toBeGreaterThan(0)
  })

  it('cash flow classifies where the cash came from', async () => {
    const cf = await f.tx((tx) => cashFlow(tx, f.orgId, YEAR))
    const receivable = cf.counterparts.find((c) => c.subtype === 'accounts_receivable')
    expect(receivable).toBeDefined()
    // Customers paying = cash in.
    expect(receivable!.netCashMinor).toBeGreaterThan(0)
  })

  it('ages receivables into the standard buckets', async () => {
    // The unpaid 2000+VAT invoice was due 2026-03-12.
    const aging = await f.tx((tx) =>
      agingReport(tx, f.orgId, { direction: 'ar', asOf: '2026-04-20' }),
    )

    expect(aging.rows.length).toBeGreaterThan(0)
    const overdue = aging.rows.find((r) => r.outstandingMinor === 238000)
    expect(overdue).toBeDefined()
    expect(overdue!.daysOverdue).toBe(39)
    expect(aging.buckets.d31_60).toBe(238000)
    expect(aging.buckets.current).toBe(0)
  })

  it('excludes fully paid invoices from aging', async () => {
    const aging = await f.tx((tx) =>
      agingReport(tx, f.orgId, { direction: 'ar', asOf: '2026-04-20' }),
    )
    // The 1000+VAT invoice was settled in February.
    expect(aging.rows.some((r) => r.outstandingMinor === 119000)).toBe(false)
  })

  it('ages payables independently of receivables', async () => {
    const ap = await f.tx((tx) => agingReport(tx, f.orgId, { direction: 'ap', asOf: '2026-04-20' }))
    // The only bill was paid in full.
    expect(ap.totalOutstandingMinor).toBe(0)
  })
})
