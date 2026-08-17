import { and, eq } from 'drizzle-orm'
import { invoiceLines, invoices } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { assertSafeMinor, convertToBase, type Minor } from './money'
import { baseCurrencyOf, nextDocumentNumber, type PostingActor } from './ledger'

/**
 * Credit notes.
 *
 * An issued invoice is immutable — the ledger entry behind it is posted and the
 * document is a legal record — so "I invoiced the wrong amount" has exactly one
 * correct answer: credit it and, if appropriate, invoice again. Before this
 * existed the product had no answer at all, which is not a gap a finance system
 * can have.
 *
 * A credit note is an invoice row with `document_type_code` 381. It has its own
 * gap-free number series, its own lines, its own ledger entry (the exact mirror
 * of the original's, posted by `issueInvoice`), and it reduces the original's
 * outstanding balance when issued.
 *
 * Amounts are stored POSITIVE. The sign lives in the document type, not in the
 * numbers — negative quantities and negative totals would have to be
 * special-cased in tax calculation, aging, allocation and every report, and one
 * of those would eventually miss the minus.
 */

export type CreditLineInput = {
  /** A line on the invoice being credited. */
  sourceLineId: string
  /** How much of that line to credit. Defaults to all of it. */
  quantity?: string | number
}

export type CreateCreditNoteInput = {
  invoiceId: string
  /** Required: every credit note needs a stated reason, and an auditor will ask. */
  reason: string
  issueDate?: string
  /** Omit to credit the invoice in full. */
  lines?: CreditLineInput[]
}

/** Statuses from which an invoice can be credited. A draft is edited or
 *  deleted instead; a cancelled invoice never reached the ledger. */
const CREDITABLE = new Set(['issued', 'partially_paid', 'paid', 'credited'])

/**
 * Creates a DRAFT credit note against an issued invoice.
 *
 * Draft, not issued: it appears in the UI for review and is posted by the same
 * `invoice.issue` path as everything else. A credit note that posted itself the
 * moment it was created would give the person who mistyped an amount no chance
 * to notice before it hit the ledger.
 */
export async function createCreditNote(
  tx: TenantTx,
  actor: PostingActor,
  input: CreateCreditNoteInput,
): Promise<{ id: string; invoiceNo: string; totalMinor: Minor }> {
  const { organizationId } = actor

  const reason = input.reason?.trim()
  if (!reason) {
    throw new AppError('VALIDATION_FAILED', 'Give a reason for the credit note')
  }

  const original = (
    await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, input.invoiceId), eq(invoices.organizationId, organizationId)))
      .limit(1)
  )[0]

  if (!original) throw new AppError('NOT_FOUND', 'Invoice not found')

  if (original.documentTypeCode === '381') {
    throw new AppError('CONFLICT', 'A credit note cannot itself be credited.')
  }
  if (!CREDITABLE.has(original.status)) {
    throw new AppError(
      'CONFLICT',
      original.status === 'draft'
        ? 'This invoice is still a draft — edit or delete it instead of crediting it.'
        : `A ${original.status} invoice cannot be credited.`,
    )
  }

  const creditableRemaining = original.totalMinor - original.creditedMinor
  if (creditableRemaining <= 0) {
    throw new AppError('CONFLICT', `${original.invoiceNo} has already been credited in full.`)
  }

  const sourceLines = await tx
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, original.id))
    .orderBy(invoiceLines.lineNo)

  if (sourceLines.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'The invoice has no lines to credit')
  }

  const byId = new Map(sourceLines.map((l) => [l.id, l]))

  // Full credit unless specific lines were named.
  const requested: CreditLineInput[] =
    input.lines && input.lines.length > 0
      ? input.lines
      : sourceLines.map((l) => ({ sourceLineId: l.id }))

  let subtotal = 0
  let taxTotal = 0

  const prepared = requested.map((req, i) => {
    const src = byId.get(req.sourceLineId)
    if (!src) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Line ${i + 1} does not belong to ${original.invoiceNo}`,
      )
    }

    const sourceQty = Number(src.quantity)
    const qty = req.quantity === undefined ? sourceQty : Number(req.quantity)
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1} has an invalid quantity`)
    }
    if (qty > sourceQty) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Line ${i + 1} credits ${qty} but the invoice only has ${sourceQty}`,
      )
    }

    // Proportional to the quantity credited, INCLUDING any discount, so a
    // half-credit of a discounted line credits half the discounted amount
    // rather than half the list price.
    const share = sourceQty === 0 ? 1 : qty / sourceQty
    const net = assertSafeMinor(Math.round(src.netMinor * share), `line ${i + 1} amount`)

    // Scaled from the ORIGINAL's tax amount rather than recomputed from the
    // rate. At share = 1 that reproduces the invoice's tax to the cent, which
    // is what makes a full credit an exact reversal; recomputing could land a
    // penny away and leave a residue in the VAT account that nobody can
    // explain.
    const tax = src.taxRateId
      ? assertSafeMinor(Math.round(src.taxAmountMinor * share), `line ${i + 1} tax`)
      : 0

    subtotal += net
    taxTotal += tax

    return {
      id: newId(),
      organizationId,
      invoiceId: '',
      lineNo: i + 1,
      productId: src.productId,
      description: src.description,
      quantity: String(qty),
      unitCode: src.unitCode,
      unitPriceMinor: src.unitPriceMinor,
      discountPct: null,
      discountMinor: assertSafeMinor(Math.round(src.discountMinor * share), `line ${i + 1} discount`),
      netMinor: net,
      taxRateId: src.taxRateId,
      taxAmountMinor: tax,
      // The same revenue or expense account the invoice used, so the credit
      // lands where the original did instead of in a general bucket.
      accountId: src.accountId,
      purchaseOrderLineId: null,
      goodsReceiptLineId: null,
      customFields: {},
    }
  })

  const total = subtotal + taxTotal
  if (total <= 0) {
    throw new AppError('VALIDATION_FAILED', 'A credit note must credit a positive amount')
  }
  if (total > creditableRemaining) {
    throw new AppError(
      'VALIDATION_FAILED',
      `That would credit more than remains on ${original.invoiceNo} ` +
        `(${creditableRemaining} of ${original.totalMinor} left to credit)`,
    )
  }

  const base = await baseCurrencyOf(tx, organizationId)
  const issueDate = input.issueDate ?? new Date().toISOString().slice(0, 10)

  const creditNoteId = newId()
  const invoiceNo = await nextDocumentNumber(
    tx,
    organizationId,
    original.direction === 'ar' ? 'credit_note_ar' : 'credit_note_ap',
  )

  await tx.insert(invoices).values({
    id: creditNoteId,
    organizationId,
    invoiceNo,
    direction: original.direction,
    businessPartnerId: original.businessPartnerId,
    // The partner AS THE ORIGINAL SAW THEM. A credit note names the same
    // counterparty at the same address as the document it corrects, even if the
    // customer has moved since.
    partnerSnapshot: original.partnerSnapshot,
    issueDate,
    // A credit note is not a demand for payment, so there is nothing to be late
    // on. Same day keeps the NOT NULL and the due >= issue check satisfied
    // without implying a deadline.
    dueDate: issueDate,
    deliveryDate: original.deliveryDate,
    paymentTerms: null,
    // Booked at the ORIGINAL's rate, not today's. A credit note reverses a
    // specific historical amount; revaluing it at a new rate would leave an FX
    // difference nobody asked for on a document that moved no money.
    currencyCode: original.currencyCode,
    fxRate: original.fxRate,
    subtotalMinor: subtotal,
    taxTotalMinor: taxTotal,
    totalMinor: total,
    baseTotalMinor: convertToBase(total, original.fxRate, original.currencyCode, base),
    status: 'draft',
    documentTypeCode: '381',
    creditsInvoiceId: original.id,
    buyerReference: original.buyerReference,
    orderReference: original.orderReference,
    matchStatus: original.direction === 'ap' ? 'not_applicable' : null,
    notes: reason,
    createdBy: actor.userId ?? null,
  })

  await tx.insert(invoiceLines).values(prepared.map((l) => ({ ...l, invoiceId: creditNoteId })))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'creditnote.created',
    entityType: 'invoice',
    entityId: creditNoteId,
    after: {
      invoiceNo,
      credits: original.invoiceNo,
      total,
      currency: original.currencyCode,
      partial: total < creditableRemaining,
      reason,
    },
    requestId: actor.requestId,
    ip: actor.ip,
  })

  return { id: creditNoteId, invoiceNo, totalMinor: total }
}

