import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { invoices, journalLines } from '@/db/schema'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { recordPayment } from '@/finance/payments'
import { trialBalance } from '@/finance/reports'
import { createFinanceFixture, type FinanceFixture } from './helpers/finance'

/** Sums the base-currency movement on one account, for asserting postings. */
async function accountMovement(f: FinanceFixture, accountId: string): Promise<number> {
  return f.tx(async (tx) => {
    const res = await tx.execute(sql`
      select coalesce(sum(jl.base_debit_minor - jl.base_credit_minor), 0) as v
      from journal_lines jl
      join journal_entries je on je.id = jl.journal_entry_id
      where jl.organization_id = ${f.orgId}
        and jl.account_id = ${accountId}
        and je.status in ('posted','reversed')
    `)
    return Number((res as unknown as { rows: { v: string }[] }).rows[0]!.v)
  })
}

describe('order-to-cash', () => {
  let f: FinanceFixture

  beforeEach(async () => {
    f = await createFinanceFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  it('posts an AR invoice: Dr receivable / Cr revenue + Cr VAT', async () => {
    const created = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [
          { description: 'Consulting', quantity: 10, unitPriceMinor: 100_00, taxRateId: f.vatRateId },
        ],
      }),
    )

    // 1000.00 net + 19% VAT = 1190.00
    expect(created.totalMinor).toBe(119000)

    await f.tx((tx) => issueInvoice(tx, f.actor, created.id))

    expect(await accountMovement(f, await f.accountId('accounts_receivable'))).toBe(119000)
    expect(await accountMovement(f, await f.accountId('revenue'))).toBe(-100000) // credit
    expect(await accountMovement(f, await f.accountId('vat_payable'))).toBe(-19000) // credit

    const tb = await f.tx((tx) =>
      trialBalance(tx, f.orgId, { from: '2026-01-01', to: '2026-12-31' }),
    )
    expect(tb.inBalance).toBe(true)
  })

  it('posts an AP bill the other way: Dr expense + Dr VAT receivable / Cr payable', async () => {
    const created = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ap',
        businessPartnerId: f.supplierId,
        issueDate: '2026-03-02',
        lines: [{ description: 'Steel', unitPriceMinor: 500_00, taxRateId: f.vatRateId }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, created.id))

    expect(await accountMovement(f, await f.accountId('accounts_payable'))).toBe(-59500) // credit
    expect(await accountMovement(f, await f.accountId('operating_expense'))).toBe(50000) // debit
    expect(await accountMovement(f, await f.accountId('vat_receivable'))).toBe(9500) // debit
  })

  it('settles an invoice in full and marks it paid', async () => {
    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Widgets', unitPriceMinor: 1000_00 }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

    await f.tx((tx) =>
      recordPayment(tx, f.actor, {
        direction: 'in',
        paymentDate: '2026-03-20',
        bankAccountId: f.bankAccountId,
        amountMinor: 100000,
        allocations: [{ invoiceId: inv.id, amountMinor: 100000 }],
      }),
    )

    const after = await f.tx((tx) =>
      tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1),
    )
    expect(after[0]!.status).toBe('paid')
    expect(after[0]!.amountPaidMinor).toBe(100000)

    // Receivable is back to zero; the cash is in the bank.
    expect(await accountMovement(f, await f.accountId('accounts_receivable'))).toBe(0)
    expect(await accountMovement(f, await f.accountId('bank'))).toBe(100000)
  })

  it('handles a partial payment', async () => {
    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Widgets', unitPriceMinor: 1000_00 }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

    await f.tx((tx) =>
      recordPayment(tx, f.actor, {
        direction: 'in',
        paymentDate: '2026-03-20',
        bankAccountId: f.bankAccountId,
        amountMinor: 40000,
        allocations: [{ invoiceId: inv.id, amountMinor: 40000 }],
      }),
    )

    const after = await f.tx((tx) =>
      tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1),
    )
    expect(after[0]!.status).toBe('partially_paid')
    expect(after[0]!.amountPaidMinor).toBe(40000)
    expect(await accountMovement(f, await f.accountId('accounts_receivable'))).toBe(60000)
  })

  it('splits one payment across several invoices', async () => {
    const mk = async (amount: number) => {
      const inv = await f.tx((tx) =>
        createInvoice(tx, f.actor, {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-03-01',
          lines: [{ description: 'Goods', unitPriceMinor: amount }],
        }),
      )
      await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))
      return inv.id
    }
    const a = await mk(300_00)
    const b = await mk(700_00)

    await f.tx((tx) =>
      recordPayment(tx, f.actor, {
        direction: 'in',
        paymentDate: '2026-03-25',
        bankAccountId: f.bankAccountId,
        amountMinor: 100000,
        allocations: [
          { invoiceId: a, amountMinor: 30000 },
          { invoiceId: b, amountMinor: 70000 },
        ],
      }),
    )

    const rows = await f.tx((tx) => tx.select().from(invoices))
    expect(rows.every((r) => r.status === 'paid')).toBe(true)
    expect(await accountMovement(f, await f.accountId('accounts_receivable'))).toBe(0)
  })

  it('refuses to over-allocate a payment', async () => {
    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Goods', unitPriceMinor: 100_00 }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

    await expect(
      f.tx((tx) =>
        recordPayment(tx, f.actor, {
          direction: 'in',
          paymentDate: '2026-03-20',
          bankAccountId: f.bankAccountId,
          amountMinor: 20000,
          allocations: [{ invoiceId: inv.id, amountMinor: 20000 }],
        }),
      ),
    ).rejects.toThrow(/exceeds its outstanding/)
  })

  it('refuses to pay a draft invoice', async () => {
    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Goods', unitPriceMinor: 100_00 }],
      }),
    )

    await expect(
      f.tx((tx) =>
        recordPayment(tx, f.actor, {
          direction: 'in',
          paymentDate: '2026-03-20',
          bankAccountId: f.bankAccountId,
          amountMinor: 10000,
          allocations: [{ invoiceId: inv.id, amountMinor: 10000 }],
        }),
      ),
    ).rejects.toThrow(/draft/)
  })

  it('refuses to issue the same invoice twice', async () => {
    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Goods', unitPriceMinor: 100_00 }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))
    await expect(f.tx((tx) => issueInvoice(tx, f.actor, inv.id))).rejects.toThrow(/draft/)
  })

  it('freezes the partner details onto the invoice at creation', async () => {
    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Goods', unitPriceMinor: 100_00 }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

    // The customer rebrands and re-registers for VAT.
    await f.t.sudo(`
      update business_partners
         set name = 'Vogel Brewing SE', tax_id = 'DE999999999'
       where organization_id = '${f.orgId}' and name = 'Brauhaus Vogel GmbH'
    `)

    const row = await f.tx((tx) =>
      tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1),
    )
    const snap = row[0]!.partnerSnapshot as { name: string; taxId: string }
    // The issued document must still say what it said when it was issued.
    expect(snap.name).toBe('Brauhaus Vogel GmbH')
    expect(snap.taxId).toBe('DE123456789')
  })

  describe('multi-currency', () => {
    it('keeps a multi-line foreign-currency invoice balanced to the cent', async () => {
      // Amounts and a rate chosen so independent per-component rounding would
      // drift: each line converts to a value ending in half a cent.
      const inv = await f.tx((tx) =>
        createInvoice(tx, f.actor, {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-04-01',
          currencyCode: 'USD',
          fxRate: 0.9137,
          lines: [
            { description: 'A', unitPriceMinor: 333_33, taxRateId: f.vatRateId },
            { description: 'B', unitPriceMinor: 333_33, taxRateId: f.vatRateId },
            { description: 'C', unitPriceMinor: 333_34, taxRateId: f.vatRateId },
          ],
        }),
      )
      await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

      const lines = await f.tx((tx) =>
        tx.select().from(journalLines).where(eq(journalLines.organizationId, f.orgId)),
      )
      const debits = lines.reduce((s, l) => s + l.baseDebitMinor, 0)
      const credits = lines.reduce((s, l) => s + l.baseCreditMinor, 0)
      expect(debits).toBe(credits)

      const tb = await f.tx((tx) =>
        trialBalance(tx, f.orgId, { from: '2026-01-01', to: '2026-12-31' }),
      )
      expect(tb.inBalance).toBe(true)
    })

    it('posts a realised FX gain when the rate moves in your favour', async () => {
      // Invoice USD 1000 at 0.90 -> receivable carries EUR 900.
      const inv = await f.tx((tx) =>
        createInvoice(tx, f.actor, {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-04-01',
          currencyCode: 'USD',
          fxRate: 0.9,
          lines: [{ description: 'Export order', unitPriceMinor: 1000_00 }],
        }),
      )
      await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))
      expect(await accountMovement(f, await f.accountId('accounts_receivable'))).toBe(90000)

      // Settled later at 0.95 -> EUR 950 cash for a EUR 900 receivable.
      const result = await f.tx((tx) =>
        recordPayment(tx, f.actor, {
          direction: 'in',
          paymentDate: '2026-05-15',
          bankAccountId: f.bankAccountId,
          currencyCode: 'USD',
          fxRate: 0.95,
          amountMinor: 100000,
          allocations: [{ invoiceId: inv.id, amountMinor: 100000 }],
        }),
      )

      expect(result.fxDifferenceMinor).toBe(5000)
      // Receivable fully released at its original rate...
      expect(await accountMovement(f, await f.accountId('accounts_receivable'))).toBe(0)
      // ...bank holds the actual cash...
      expect(await accountMovement(f, await f.accountId('bank'))).toBe(95000)
      // ...and the EUR 50 difference is a gain (credit balance on the FX account).
      expect(await accountMovement(f, await f.accountId('fx_gain_loss'))).toBe(-5000)

      const tb = await f.tx((tx) =>
        trialBalance(tx, f.orgId, { from: '2026-01-01', to: '2026-12-31' }),
      )
      expect(tb.inBalance).toBe(true)
    })

    it('posts a realised FX loss when the rate moves against you', async () => {
      const inv = await f.tx((tx) =>
        createInvoice(tx, f.actor, {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-04-01',
          currencyCode: 'USD',
          fxRate: 0.95,
          lines: [{ description: 'Export order', unitPriceMinor: 1000_00 }],
        }),
      )
      await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

      const result = await f.tx((tx) =>
        recordPayment(tx, f.actor, {
          direction: 'in',
          paymentDate: '2026-05-15',
          bankAccountId: f.bankAccountId,
          currencyCode: 'USD',
          fxRate: 0.9,
          amountMinor: 100000,
          allocations: [{ invoiceId: inv.id, amountMinor: 100000 }],
        }),
      )

      expect(result.fxDifferenceMinor).toBe(-5000)
      expect(await accountMovement(f, await f.accountId('fx_gain_loss'))).toBe(5000) // debit = loss
    })

    it('refuses to settle an invoice with a payment in a different currency', async () => {
      const inv = await f.tx((tx) =>
        createInvoice(tx, f.actor, {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-04-01',
          currencyCode: 'USD',
          fxRate: 0.9,
          lines: [{ description: 'Export', unitPriceMinor: 100_00 }],
        }),
      )
      await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

      await expect(
        f.tx((tx) =>
          recordPayment(tx, f.actor, {
            direction: 'in',
            paymentDate: '2026-05-01',
            bankAccountId: f.bankAccountId,
            currencyCode: 'EUR',
            amountMinor: 9000,
            allocations: [{ invoiceId: inv.id, amountMinor: 9000 }],
          }),
        ),
      ).rejects.toThrow(/is in USD but the payment is in EUR/)
    })
  })
})
