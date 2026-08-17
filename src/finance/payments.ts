import { and, eq, inArray } from 'drizzle-orm'
import { bankAccounts, invoices, paymentAllocations, payments } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { emit } from '@/api/events'
import { convertToBase, assertSafeMinor, type Minor } from './money'
import {
  accountBySubtype,
  baseCurrencyOf,
  nextDocumentNumber,
  postJournalEntry,
  type JournalLineInput,
  type PostingActor,
} from './ledger'

export type AllocationInput = { invoiceId: string; amountMinor: Minor }

export type RecordPaymentInput = {
  direction: 'in' | 'out'
  paymentDate: string
  bankAccountId: string
  businessPartnerId?: string | null
  currencyCode?: string
  fxRate?: number | string
  amountMinor: Minor
  method?: 'bank_transfer' | 'card' | 'cash' | 'sepa_dd' | 'cheque' | 'other'
  reference?: string | null
  allocations?: AllocationInput[]
}

/**
 * Records a payment and posts it, settling the invoices it is allocated to.
 *
 *   in:  Dr Bank / Cr Accounts receivable   (+ FX difference)
 *   out: Dr Accounts payable / Cr Bank      (+ FX difference)
 *
 * REALISED FX. When a foreign-currency invoice is settled at a rate other than
 * the one it was booked at, the base-currency value of the receivable released
 * differs from the base-currency cash received. That difference is a realised
 * gain or loss and must be posted — otherwise the AR control account slowly
 * drifts away from the sum of its open invoices, and nobody can explain why.
 *
 * The AR/AP leg is released at the INVOICE's original rate; the bank leg lands
 * at the payment date's rate; the residual goes to FX gain/loss.
 */
export async function recordPayment(
  tx: TenantTx,
  actor: PostingActor,
  input: RecordPaymentInput,
): Promise<{ id: string; paymentNo: string; journalEntryId: string; fxDifferenceMinor: Minor }> {
  const { organizationId } = actor

  const amount = assertSafeMinor(input.amountMinor, 'payment amount')
  if (amount <= 0) throw new AppError('VALIDATION_FAILED', 'Payment amount must be positive')

  const base = await baseCurrencyOf(tx, organizationId)

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

  const currency = (input.currencyCode ?? bank.currencyCode).toUpperCase()
  const fxRate = input.fxRate ?? 1
  if (currency !== base && Number(fxRate) === 1) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Payment is in ${currency} but no exchange rate to ${base} was supplied`,
    )
  }

  const isIn = input.direction === 'in'
  const allocations = input.allocations ?? []
  const allocatedTotal = allocations.reduce((sum, a) => sum + a.amountMinor, 0)

  if (allocatedTotal > amount) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Allocations (${allocatedTotal}) exceed the payment amount (${amount})`,
    )
  }

  // --- load and validate the target invoices -------------------------------
  const invoiceRows = allocations.length
    ? await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.organizationId, organizationId),
            inArray(
              invoices.id,
              allocations.map((a) => a.invoiceId),
            ),
          ),
        )
    : []

  const invoiceById = new Map(invoiceRows.map((r) => [r.id, r]))

  let releasedBaseTotal = 0
  const perInvoice: { invoice: (typeof invoiceRows)[number]; amount: Minor; baseAmount: Minor }[] =
    []

  for (const alloc of allocations) {
    const inv = invoiceById.get(alloc.invoiceId)
    if (!inv) throw new AppError('NOT_FOUND', `Invoice ${alloc.invoiceId} not found`)

    if (inv.status === 'draft') {
      throw new AppError('CONFLICT', `Invoice ${inv.invoiceNo} is a draft and cannot be paid`)
    }
    if (inv.status === 'cancelled') {
      throw new AppError('CONFLICT', `Invoice ${inv.invoiceNo} is cancelled`)
    }
    if (inv.currencyCode !== currency) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Invoice ${inv.invoiceNo} is in ${inv.currencyCode} but the payment is in ${currency}`,
      )
    }
    if ((inv.direction === 'ar') !== isIn) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Invoice ${inv.invoiceNo} is ${inv.direction.toUpperCase()} and cannot be settled by an incoming payment`,
      )
    }

    if (inv.documentTypeCode === '381') {
      throw new AppError(
        'CONFLICT',
        `${inv.invoiceNo} is a credit note. It reduces what is owed on the invoice it credits ` +
          `rather than being settled by a payment.`,
      )
    }

    // Credits reduce what is payable exactly as payments do. Without them a
    // customer could be asked to pay — and the system would happily accept —
    // an amount that had already been credited away.
    const outstanding = inv.totalMinor - inv.amountPaidMinor - inv.creditedMinor
    if (alloc.amountMinor > outstanding) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Allocating ${alloc.amountMinor} to ${inv.invoiceNo} exceeds its outstanding ${outstanding}`,
      )
    }

    // Released at the INVOICE's rate, not today's — that is what makes the
    // control account tie back to the invoices behind it.
    const baseAmount = convertToBase(alloc.amountMinor, inv.fxRate, currency, base)
    releasedBaseTotal += baseAmount
    perInvoice.push({ invoice: inv, amount: alloc.amountMinor, baseAmount })
  }

  const unallocated = amount - allocatedTotal
  const baseCash = convertToBase(amount, fxRate, currency, base)
  const baseUnallocated =
    unallocated === 0 ? 0 : convertToBase(unallocated, fxRate, currency, base)

  // Difference between cash at today's rate and the receivable released at the
  // invoices' original rates.
  const fxDifference = baseCash - baseUnallocated - releasedBaseTotal

  const paymentId = newId()
  const paymentNo = await nextDocumentNumber(tx, organizationId, 'payment')

  // --- build the entry -----------------------------------------------------
  const controlAccountId = await accountBySubtype(
    tx,
    organizationId,
    isIn ? 'accounts_receivable' : 'accounts_payable',
  )

  const entryLines: JournalLineInput[] = []

  entryLines.push({
    accountId: bank.glAccountId,
    ...(isIn ? { debitMinor: amount } : { creditMinor: amount }),
    currencyCode: currency,
    fxRate,
    baseAmountMinor: baseCash,
    memo: `${paymentNo} · ${bank.name}`,
  })

  for (const p of perInvoice) {
    entryLines.push({
      accountId: controlAccountId,
      ...(isIn ? { creditMinor: p.amount } : { debitMinor: p.amount }),
      currencyCode: currency,
      fxRate: p.invoice.fxRate,
      baseAmountMinor: p.baseAmount,
      businessPartnerId: p.invoice.businessPartnerId,
      memo: `${paymentNo} · settles ${p.invoice.invoiceNo}`,
    })
  }

  if (unallocated > 0) {
    // A payment on account. Parking it on the control account keeps the
    // customer's balance right without inventing an invoice to attach it to.
    entryLines.push({
      accountId: controlAccountId,
      ...(isIn ? { creditMinor: unallocated } : { debitMinor: unallocated }),
      currencyCode: currency,
      fxRate,
      baseAmountMinor: baseUnallocated,
      businessPartnerId: input.businessPartnerId ?? null,
      memo: `${paymentNo} · on account`,
    })
  }

  if (fxDifference !== 0) {
    const fxAccountId = await accountBySubtype(tx, organizationId, 'fx_gain_loss')
    // A positive difference means more base-currency cash arrived than the
    // receivable was carrying: a gain, which is a credit to the FX account.
    entryLines.push({
      accountId: fxAccountId,
      ...(fxDifference > 0
        ? { creditMinor: Math.abs(fxDifference) }
        : { debitMinor: Math.abs(fxDifference) }),
      currencyCode: base,
      fxRate: 1,
      memo: `${paymentNo} · realised FX`,
    })
  }

  const entry = await postJournalEntry(tx, actor, {
    entryDate: input.paymentDate,
    description: `Payment ${paymentNo}`,
    sourceType: 'payment',
    sourceId: paymentId,
    lines: entryLines,
  })

  await tx.insert(payments).values({
    id: paymentId,
    organizationId,
    paymentNo,
    direction: input.direction,
    paymentDate: input.paymentDate,
    businessPartnerId: input.businessPartnerId ?? perInvoice[0]?.invoice.businessPartnerId ?? null,
    bankAccountId: bank.id,
    currencyCode: currency,
    fxRate: String(fxRate),
    amountMinor: amount,
    baseAmountMinor: baseCash,
    unallocatedMinor: unallocated,
    method: input.method ?? 'bank_transfer',
    reference: input.reference ?? null,
    status: 'posted',
    journalEntryId: entry.id,
    createdBy: actor.userId ?? null,
  })

  if (perInvoice.length) {
    await tx.insert(paymentAllocations).values(
      perInvoice.map((p) => ({
        id: newId(),
        organizationId,
        paymentId,
        invoiceId: p.invoice.id,
        amountMinor: p.amount,
        baseAmountMinor: p.baseAmount,
      })),
    )

    for (const p of perInvoice) {
      const paid = p.invoice.amountPaidMinor + p.amount
      // Settled = paid + credited. An invoice part-credited and then paid for
      // the remainder is fully settled, and would otherwise sit at
      // 'partially_paid' forever, chased by every dunning run.
      const settled = paid + p.invoice.creditedMinor
      await tx
        .update(invoices)
        .set({
          amountPaidMinor: paid,
          status: settled >= p.invoice.totalMinor ? 'paid' : 'partially_paid',
        })
        .where(eq(invoices.id, p.invoice.id))
    }
  }

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'payment.recorded',
    entityType: 'payment',
    entityId: paymentId,
    after: {
      paymentNo,
      direction: input.direction,
      amount,
      currency,
      allocations: perInvoice.map((p) => ({
        invoiceNo: p.invoice.invoiceNo,
        amount: p.amount,
      })),
      fxDifferenceMinor: fxDifference,
    },
    requestId: actor.requestId,
    ip: actor.ip,
  })

  await emit(tx, {
    organizationId,
    type: 'payment.recorded',
    entityType: 'payment',
    entityId: paymentId,
    payload: {
      paymentNo,
      direction: input.direction,
      amountMinor: amount,
      currencyCode: currency,
      fxDifferenceMinor: fxDifference,
    },
    actorUserId: actor.userId,
  })

  // A fully-settled invoice is the event integrations actually care about —
  // "payment recorded" says money moved, "invoice paid" says a specific
  // receivable closed.
  for (const p of perInvoice) {
    if (p.invoice.amountPaidMinor + p.amount + p.invoice.creditedMinor >= p.invoice.totalMinor) {
      await emit(tx, {
        organizationId,
        type: 'invoice.paid',
        entityType: 'invoice',
        entityId: p.invoice.id,
        payload: {
          invoiceNo: p.invoice.invoiceNo,
          totalMinor: p.invoice.totalMinor,
          currencyCode: p.invoice.currencyCode,
        },
        actorUserId: actor.userId,
      })
    }
  }

  return {
    id: paymentId,
    paymentNo,
    journalEntryId: entry.id,
    fxDifferenceMinor: fxDifference,
  }
}
