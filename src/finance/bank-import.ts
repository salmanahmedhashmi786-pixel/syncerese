import { and, eq } from 'drizzle-orm'
import { bankAccounts, bankImportBatches, bankTransactions } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { parseMoney } from './money'
import type { PostingActor } from './ledger'

/**
 * CSV bank statement import.
 *
 * Deliberately simple and deliberately IDEMPOTENT. `externalId` carries a
 * unique index per bank account, so re-importing the same file inserts nothing
 * the second time. Without that, an accidental double-import silently doubles
 * the bank balance — and it is discovered weeks later during a reconciliation
 * that will not tie.
 *
 * This is also the documented seam for a future bank feed: a feed writes its
 * own transaction id into `externalId` and reuses everything below it.
 */

export type CsvColumnMap = {
  date: string
  amount?: string
  /** Some banks emit separate debit and credit columns instead of a signed one. */
  debit?: string
  credit?: string
  description?: string
  counterpartyName?: string
  counterpartyIban?: string
  externalId?: string
  bookingDate?: string
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, embedded newlines. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  const src = text.replace(/^﻿/, '') // strip BOM — Excel exports carry one

  while (i < src.length) {
    const ch = src[i]!

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      i++
      continue
    }
    if (ch === '\r') {
      i++
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
      continue
    }
    field += ch
    i++
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Detects `,` vs `;` — German and Dutch banks export semicolon-delimited
 *  files, and guessing wrong turns every row into a single column. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const commas = (firstLine.match(/,/g) ?? []).length
  const semis = (firstLine.match(/;/g) ?? []).length
  return semis > commas ? ';' : ','
}

/** Accepts ISO, and the D/M/Y forms European banks actually emit. */
export function normaliseDate(raw: string): string {
  const v = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v

  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(v)
  if (dmy) {
    const [, d, m, y] = dmy
    const year = y!.length === 2 ? `20${y}` : y!
    return `${year}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
  }
  throw new AppError('VALIDATION_FAILED', `Unrecognised date format: "${raw}"`)
}

export type ImportResult = {
  batchId: string
  totalRows: number
  imported: number
  duplicates: number
  errors: { row: number; message: string }[]
}

export async function importBankCsv(
  tx: TenantTx,
  actor: PostingActor,
  input: {
    bankAccountId: string
    csv: string
    columnMap: CsvColumnMap
    filename?: string
    delimiter?: string
  },
): Promise<ImportResult> {
  const { organizationId } = actor

  const bank = (
    await tx
      .select()
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, input.bankAccountId),
          eq(bankAccounts.organizationId, organizationId),
        ),
      )
      .limit(1)
  )[0]
  if (!bank) throw new AppError('NOT_FOUND', 'Bank account not found')

  const delimiter = input.delimiter ?? detectDelimiter(input.csv)
  const rows = parseCsv(input.csv, delimiter)
  if (rows.length < 2) {
    throw new AppError('VALIDATION_FAILED', 'CSV contains no data rows')
  }

  const header = rows[0]!.map((h) => h.trim())
  const indexOf = (name?: string) => (name ? header.indexOf(name) : -1)

  const idx = {
    date: indexOf(input.columnMap.date),
    amount: indexOf(input.columnMap.amount),
    debit: indexOf(input.columnMap.debit),
    credit: indexOf(input.columnMap.credit),
    description: indexOf(input.columnMap.description),
    counterpartyName: indexOf(input.columnMap.counterpartyName),
    counterpartyIban: indexOf(input.columnMap.counterpartyIban),
    externalId: indexOf(input.columnMap.externalId),
    bookingDate: indexOf(input.columnMap.bookingDate),
  }

  if (idx.date < 0) {
    throw new AppError('VALIDATION_FAILED', `Date column "${input.columnMap.date}" not found`)
  }
  if (idx.amount < 0 && (idx.debit < 0 || idx.credit < 0)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Provide either an amount column, or both a debit and a credit column',
    )
  }

  const batchId = newId()
  await tx.insert(bankImportBatches).values({
    id: batchId,
    organizationId,
    bankAccountId: bank.id,
    source: 'csv',
    filename: input.filename ?? null,
    rowCount: rows.length - 1,
    importedBy: actor.userId ?? null,
  })

  const errors: { row: number; message: string }[] = []
  let imported = 0
  let duplicates = 0

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '')

    try {
      const valueDate = normaliseDate(cell(idx.date))

      let amountMinor: number
      if (idx.amount >= 0) {
        amountMinor = parseMoney(cell(idx.amount), bank.currencyCode)
      } else {
        const debit = cell(idx.debit) ? parseMoney(cell(idx.debit), bank.currencyCode) : 0
        const credit = cell(idx.credit) ? parseMoney(cell(idx.credit), bank.currencyCode) : 0
        amountMinor = credit - debit
      }

      if (amountMinor === 0) {
        errors.push({ row: r + 1, message: 'Amount is zero' })
        continue
      }

      // Without a bank-supplied id, synthesise a stable one from the row's own
      // content so a re-import of the same statement still de-duplicates.
      const externalId =
        cell(idx.externalId) ||
        [valueDate, amountMinor, cell(idx.description), cell(idx.counterpartyIban)].join('|')

      const existing = await tx
        .select({ id: bankTransactions.id })
        .from(bankTransactions)
        .where(
          and(
            eq(bankTransactions.bankAccountId, bank.id),
            eq(bankTransactions.externalId, externalId),
          ),
        )
        .limit(1)

      if (existing.length > 0) {
        duplicates++
        continue
      }

      await tx.insert(bankTransactions).values({
        id: newId(),
        organizationId,
        bankAccountId: bank.id,
        valueDate,
        bookingDate: idx.bookingDate >= 0 && cell(idx.bookingDate) ? normaliseDate(cell(idx.bookingDate)) : null,
        amountMinor,
        currencyCode: bank.currencyCode,
        description: cell(idx.description) || null,
        counterpartyName: cell(idx.counterpartyName) || null,
        counterpartyIban: cell(idx.counterpartyIban) || null,
        externalId,
        importBatchId: batchId,
        reconciliationStatus: 'unreconciled',
      })
      imported++
    } catch (err) {
      // One malformed row must not discard the other 400.
      errors.push({ row: r + 1, message: err instanceof Error ? err.message : String(err) })
    }
  }

  await tx
    .update(bankImportBatches)
    .set({ importedRows: imported, duplicateRows: duplicates })
    .where(eq(bankImportBatches.id, batchId))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'bank.imported',
    entityType: 'bank_import_batch',
    entityId: batchId,
    after: {
      bankAccount: bank.name,
      filename: input.filename,
      totalRows: rows.length - 1,
      imported,
      duplicates,
      errorCount: errors.length,
    },
    requestId: actor.requestId,
    ip: actor.ip,
  })

  return { batchId, totalRows: rows.length - 1, imported, duplicates, errors }
}
