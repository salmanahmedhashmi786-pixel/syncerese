import { and, eq, isNull, sql } from 'drizzle-orm'
import { accounts, journalEntries, journalLines, organizations } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { convertToBase, assertSafeMinor, type Minor } from './money'
import type { AccountSubtype } from './chart-of-accounts'

export type PostingActor = {
  organizationId: string
  userId?: string | null
  requestId?: string | null
  ip?: string | null
  userAgent?: string | null
}

export type JournalLineInput = {
  accountId: string
  /** Exactly one of debitMinor / creditMinor must be non-zero. */
  debitMinor?: Minor
  creditMinor?: Minor
  /** Defaults to the organization's base currency. */
  currencyCode?: string
  /** Required when currencyCode differs from base. */
  fxRate?: number | string
  /**
   * Explicit base-currency amount, overriding the computed conversion.
   *
   * Needed when a caller has already distributed a converted total across
   * several lines so they sum exactly (see `allocate()` in invoices.ts).
   * Converting each line independently can round to a one-cent discrepancy
   * against the control account, which the balance trigger would — correctly —
   * reject. The override must sit on the same side as the transaction amount.
   */
  baseAmountMinor?: Minor
  businessPartnerId?: string | null
  taxRateId?: string | null
  memo?: string | null
}

export type JournalEntryInput = {
  entryDate: string
  description?: string | null
  sourceType?: 'manual' | 'invoice' | 'payment' | 'stock_movement' | 'fx_revaluation' | 'opening_balance' | 'period_close'
  sourceId?: string | null
  lines: JournalLineInput[]
}

export async function baseCurrencyOf(tx: TenantTx, organizationId: string): Promise<string> {
  const rows = await tx
    .select({ baseCurrency: organizations.baseCurrency })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  const base = rows[0]?.baseCurrency
  if (!base) throw new AppError('NOT_FOUND', 'Organization not found')
  return base
}

/**
 * Finds an account by SUBTYPE rather than by code.
 *
 * This is what lets a tenant renumber or rename their chart without breaking
 * automatic postings. Code that looks up "account 1200" breaks the first time
 * someone customises; code that asks for `accounts_receivable` does not.
 */
export async function accountBySubtype(
  tx: TenantTx,
  organizationId: string,
  subtype: AccountSubtype,
): Promise<string> {
  const rows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.subtype, subtype),
        eq(accounts.isPostable, true),
        isNull(accounts.archivedAt),
      ),
    )
    .orderBy(accounts.code)
    .limit(1)

  const id = rows[0]?.id
  if (!id) {
    throw new AppError(
      'VALIDATION_FAILED',
      `No postable account is configured for "${subtype}". Add one in the chart of accounts.`,
    )
  }
  return id
}

async function nextEntryNo(tx: TenantTx, organizationId: string): Promise<number> {
  const res = await tx.execute(
    sql`select public.next_sequence_value(${organizationId}::uuid, 'journal_entry') as n`,
  )
  const rows = (res as unknown as { rows: { n: number }[] }).rows
  return Number(rows[0]!.n)
}

export async function nextDocumentNumber(
  tx: TenantTx,
  organizationId: string,
  key: string,
): Promise<string> {
  const res = await tx.execute(
    sql`select public.next_document_number(${organizationId}::uuid, ${key}) as v`,
  )
  const rows = (res as unknown as { rows: { v: string }[] }).rows
  return rows[0]!.v
}

/**
 * Posts a balanced double-entry journal entry.
 *
 * The database is the authority on balance, immutability, period status and
 * account postability — this function validates the same things first only so
 * the caller gets a precise message instead of a raw Postgres exception. It is
 * NOT the enforcement point, and must never be treated as one.
 *
 * Sequence matters: the entry is inserted as `draft`, the lines are added, then
 * the status flips to `posted`. Lines cannot be attached to an already-posted
 * entry (that is the immutability guard doing its job), so building it in this
 * order is required rather than stylistic.
 */
export async function postJournalEntry(
  tx: TenantTx,
  actor: PostingActor,
  input: JournalEntryInput,
): Promise<{ id: string; entryNo: number }> {
  const { organizationId } = actor

  if (input.lines.length < 2) {
    throw new AppError('VALIDATION_FAILED', 'A journal entry needs at least two lines')
  }

  const base = await baseCurrencyOf(tx, organizationId)

  let totalBaseDebit = 0
  let totalBaseCredit = 0

  const prepared = input.lines.map((line, i) => {
    const debit = assertSafeMinor(line.debitMinor ?? 0, `line ${i + 1} debit`)
    const credit = assertSafeMinor(line.creditMinor ?? 0, `line ${i + 1} credit`)

    if ((debit === 0) === (credit === 0)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Line ${i + 1} must be either a debit or a credit, not both and not neither`,
      )
    }
    if (debit < 0 || credit < 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Line ${i + 1} is negative. Use the opposite side instead of a negative amount.`,
      )
    }

    const currency = (line.currencyCode ?? base).toUpperCase()
    const fxRate = line.fxRate ?? 1

    if (currency !== base && (line.fxRate === undefined || Number(line.fxRate) === 1)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Line ${i + 1} is in ${currency} but no exchange rate to ${base} was supplied`,
      )
    }

    const override =
      line.baseAmountMinor === undefined
        ? undefined
        : assertSafeMinor(line.baseAmountMinor, `line ${i + 1} base amount`)

    if (override !== undefined && override < 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Line ${i + 1} base amount is negative. Use the opposite side instead.`,
      )
    }

    const baseDebit =
      debit === 0 ? 0 : (override ?? convertToBase(debit, fxRate, currency, base))
    const baseCredit =
      credit === 0 ? 0 : (override ?? convertToBase(credit, fxRate, currency, base))

    totalBaseDebit += baseDebit
    totalBaseCredit += baseCredit

    return {
      id: newId(),
      organizationId,
      journalEntryId: '',
      lineNo: i + 1,
      accountId: line.accountId,
      debitMinor: debit,
      creditMinor: credit,
      currencyCode: currency,
      fxRate: String(fxRate),
      baseDebitMinor: baseDebit,
      baseCreditMinor: baseCredit,
      businessPartnerId: line.businessPartnerId ?? null,
      taxRateId: line.taxRateId ?? null,
      memo: line.memo ?? null,
    }
  })

  if (totalBaseDebit !== totalBaseCredit) {
    throw new AppError(
      'UNBALANCED_ENTRY',
      `Entry does not balance: debits ${totalBaseDebit} vs credits ${totalBaseCredit} (in ${base} minor units)`,
      { totalBaseDebit, totalBaseCredit, baseCurrency: base },
    )
  }

  const entryId = newId()
  const entryNo = await nextEntryNo(tx, organizationId)

  await tx.insert(journalEntries).values({
    id: entryId,
    organizationId,
    entryNo,
    entryDate: input.entryDate,
    description: input.description ?? null,
    sourceType: input.sourceType ?? 'manual',
    sourceId: input.sourceId ?? null,
    status: 'draft',
    createdBy: actor.userId ?? null,
  })

  await tx.insert(journalLines).values(prepared.map((l) => ({ ...l, journalEntryId: entryId })))

  await tx
    .update(journalEntries)
    .set({ status: 'posted', postedAt: new Date(), postedBy: actor.userId ?? null })
    .where(eq(journalEntries.id, entryId))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'journal_entry.posted',
    entityType: 'journal_entry',
    entityId: entryId,
    after: {
      entryNo,
      entryDate: input.entryDate,
      description: input.description,
      sourceType: input.sourceType ?? 'manual',
      totalBaseDebit,
      lineCount: prepared.length,
    },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  })

  return { id: entryId, entryNo }
}

/**
 * Reverses a posted entry by posting its mirror image.
 *
 * The original is never touched beyond being marked `reversed` — that is the
 * only mutation the immutability trigger permits. Two entries remain visible in
 * the ledger, which is exactly what an auditor needs to see: the mistake and
 * the correction, not a silently amended record.
 */
export async function reverseJournalEntry(
  tx: TenantTx,
  actor: PostingActor,
  entryId: string,
  opts: { entryDate?: string; description?: string } = {},
): Promise<{ id: string; entryNo: number }> {
  const { organizationId } = actor

  const found = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.organizationId, organizationId)))
    .limit(1)

  const entry = found[0]
  if (!entry) throw new AppError('NOT_FOUND', 'Journal entry not found')
  if (entry.status !== 'posted') {
    throw new AppError(
      'CONFLICT',
      `Only a posted entry can be reversed (this one is ${entry.status})`,
    )
  }

  const original = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.journalEntryId, entryId))
    .orderBy(journalLines.lineNo)

  const reversalId = newId()
  const reversalNo = await nextEntryNo(tx, organizationId)

  await tx.insert(journalEntries).values({
    id: reversalId,
    organizationId,
    entryNo: reversalNo,
    entryDate: opts.entryDate ?? entry.entryDate,
    description: opts.description ?? `Reversal of entry ${entry.entryNo}`,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    status: 'draft',
    reversesEntryId: entryId,
    createdBy: actor.userId ?? null,
  })

  // Debits become credits and vice versa — including the base amounts, so the
  // reversal balances by construction rather than by recomputing FX at today's
  // rate (which would leave a spurious gain or loss behind).
  await tx.insert(journalLines).values(
    original.map((l, i) => ({
      id: newId(),
      organizationId,
      journalEntryId: reversalId,
      lineNo: i + 1,
      accountId: l.accountId,
      debitMinor: l.creditMinor,
      creditMinor: l.debitMinor,
      currencyCode: l.currencyCode,
      fxRate: l.fxRate,
      baseDebitMinor: l.baseCreditMinor,
      baseCreditMinor: l.baseDebitMinor,
      businessPartnerId: l.businessPartnerId,
      taxRateId: l.taxRateId,
      memo: l.memo,
    })),
  )

  await tx
    .update(journalEntries)
    .set({ status: 'posted', postedAt: new Date(), postedBy: actor.userId ?? null })
    .where(eq(journalEntries.id, reversalId))

  await tx
    .update(journalEntries)
    .set({ status: 'reversed', reversedByEntryId: reversalId })
    .where(eq(journalEntries.id, entryId))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'journal_entry.reversed',
    entityType: 'journal_entry',
    entityId: entryId,
    before: { entryNo: entry.entryNo, status: 'posted' },
    after: { status: 'reversed', reversedByEntryNo: reversalNo },
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  })

  return { id: reversalId, entryNo: reversalNo }
}
