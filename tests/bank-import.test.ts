import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bankTransactions } from '@/db/schema'
import { detectDelimiter, importBankCsv, normaliseDate, parseCsv } from '@/finance/bank-import'
import { createFinanceFixture, type FinanceFixture } from './helpers/finance'

describe('CSV parsing', () => {
  it('handles quoted fields, escaped quotes and embedded newlines', () => {
    const rows = parseCsv('a,b\n"x,y","he said ""hi"""\n"multi\nline",z')
    expect(rows[1]).toEqual(['x,y', 'he said "hi"'])
    expect(rows[2]).toEqual(['multi\nline', 'z'])
  })

  it('strips the BOM Excel exports carry', () => {
    const rows = parseCsv('﻿date,amount\n2026-01-01,10')
    expect(rows[0]![0]).toBe('date')
  })

  it('detects semicolon delimiters', () => {
    // German and Dutch banks export this way; guessing wrong turns every row
    // into a single column.
    expect(detectDelimiter('Datum;Betrag;Verwendungszweck')).toBe(';')
    expect(detectDelimiter('date,amount,description')).toBe(',')
  })

  it('normalises the date formats banks actually emit', () => {
    expect(normaliseDate('2026-03-15')).toBe('2026-03-15')
    expect(normaliseDate('15.03.2026')).toBe('2026-03-15')
    expect(normaliseDate('15/03/2026')).toBe('2026-03-15')
    expect(normaliseDate('5.3.26')).toBe('2026-03-05')
    expect(() => normaliseDate('March 15')).toThrow()
  })
})

describe('bank statement import', () => {
  let f: FinanceFixture

  const CSV = [
    'date,amount,description,counterparty',
    '2026-03-01,1190.00,Invoice payment,Brauhaus Vogel GmbH',
    '2026-03-05,-476.00,Supplier payment,Steinmetz Metallwerke',
    '2026-03-09,-89.50,Office supplies,Bürobedarf AG',
  ].join('\n')

  beforeEach(async () => {
    f = await createFinanceFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  it('imports rows with signed amounts', async () => {
    const result = await f.tx((tx) =>
      importBankCsv(tx, f.actor, {
        bankAccountId: f.bankAccountId,
        csv: CSV,
        filename: 'march.csv',
        columnMap: {
          date: 'date',
          amount: 'amount',
          description: 'description',
          counterpartyName: 'counterparty',
        },
      }),
    )

    expect(result.imported).toBe(3)
    expect(result.duplicates).toBe(0)
    expect(result.errors).toEqual([])

    const rows = await f.tx((tx) => tx.select().from(bankTransactions))
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.amountMinor === 119000)).toBeDefined()
    expect(rows.find((r) => r.amountMinor === -47600)).toBeDefined()
    expect(rows.find((r) => r.amountMinor === -8950)).toBeDefined()
  })

  it('is idempotent — re-importing the same file changes nothing', async () => {
    const opts = {
      bankAccountId: f.bankAccountId,
      csv: CSV,
      columnMap: { date: 'date', amount: 'amount', description: 'description' },
    }

    await f.tx((tx) => importBankCsv(tx, f.actor, opts))
    const second = await f.tx((tx) => importBankCsv(tx, f.actor, opts))

    // Without this, an accidental double-import silently doubles the bank
    // balance — discovered weeks later by a reconciliation that will not tie.
    expect(second.imported).toBe(0)
    expect(second.duplicates).toBe(3)

    const rows = await f.tx((tx) => tx.select().from(bankTransactions))
    expect(rows).toHaveLength(3)
  })

  it('handles separate debit and credit columns', async () => {
    const csv = [
      'Datum;Soll;Haben;Text',
      '01.03.2026;;1190,00;Zahlungseingang',
      '05.03.2026;476,00;;Lieferant',
    ].join('\n')

    const result = await f.tx((tx) =>
      importBankCsv(tx, f.actor, {
        bankAccountId: f.bankAccountId,
        csv,
        columnMap: { date: 'Datum', debit: 'Soll', credit: 'Haben', description: 'Text' },
      }),
    )

    expect(result.imported).toBe(2)
    const rows = await f.tx((tx) => tx.select().from(bankTransactions))
    expect(rows.find((r) => r.amountMinor === 119000)).toBeDefined()
    expect(rows.find((r) => r.amountMinor === -47600)).toBeDefined()
  })

  it('reports bad rows without discarding the good ones', async () => {
    const csv = [
      'date,amount,description',
      '2026-03-01,100.00,Good',
      'not-a-date,50.00,Bad date',
      '2026-03-03,0.00,Zero amount',
      '2026-03-04,75.00,Also good',
    ].join('\n')

    const result = await f.tx((tx) =>
      importBankCsv(tx, f.actor, {
        bankAccountId: f.bankAccountId,
        csv,
        columnMap: { date: 'date', amount: 'amount', description: 'description' },
      }),
    )

    // One malformed row must not throw away the other 400.
    expect(result.imported).toBe(2)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]!.row).toBe(3)
  })

  it('rejects a file whose declared columns are absent', async () => {
    await expect(
      f.tx((tx) =>
        importBankCsv(tx, f.actor, {
          bankAccountId: f.bankAccountId,
          csv: CSV,
          columnMap: { date: 'transaction_date', amount: 'amount' },
        }),
      ),
    ).rejects.toThrow(/not found/)
  })

  it('records the import batch for traceability', async () => {
    const result = await f.tx((tx) =>
      importBankCsv(tx, f.actor, {
        bankAccountId: f.bankAccountId,
        csv: CSV,
        filename: 'march.csv',
        columnMap: { date: 'date', amount: 'amount' },
      }),
    )

    const batch = await f.tx(async (tx) => {
      const { bankImportBatches } = await import('@/db/schema')
      const rows = await tx.select().from(bankImportBatches)
      return rows[0]!
    })

    expect(batch.id).toBe(result.batchId)
    expect(batch.filename).toBe('march.csv')
    expect(batch.importedRows).toBe(3)
  })
})
