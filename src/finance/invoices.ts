import { and, eq } from 'drizzle-orm'
import {
  businessPartners,
  invoiceLines,
  invoices,
  partnerAddresses,
  taxRates,
} from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { emit } from '@/api/events'
import { allocate, assertSafeMinor, convertToBase, taxOn, type Minor } from './money'
import {
  accountBySubtype,
  baseCurrencyOf,
  nextDocumentNumber,
  postJournalEntry,
  type JournalLineInput,
  type PostingActor,
} from './ledger'

export type InvoiceLineInput = {
  description: string
  quantity?: string | number
  unitCode?: string
  unitPriceMinor: Minor
  discountMinor?: Minor
  taxRateId?: string | null
  accountId?: string | null
  productId?: string | null
}

export type CreateInvoiceInput = {
  direction: 'ar' | 'ap'
  businessPartnerId: string
  issueDate: string
  dueDate?: string
  deliveryDate?: string | null
  currencyCode?: string
  fxRate?: number | string
  documentTypeCode?: '380' | '381'
  buyerReference?: string | null
  orderReference?: string | null
  notes?: string | null
  lines: InvoiceLineInput[]
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Creates a DRAFT invoice. Nothing hits the ledger yet — a draft is editable
 * and deletable, an issued invoice is neither.
 */
export async function createInvoice(
  tx: TenantTx,
  actor: PostingActor,
  input: CreateInvoiceInput,
): Promise<{ id: string; invoiceNo: string; totalMinor: Minor }> {
  const { organizationId } = actor
  if (input.lines.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'An invoice needs at least one line')
  }

  const base = await baseCurrencyOf(tx, organizationId)
  const currency = (input.currencyCode ?? base).toUpperCase()
  const fxRate = input.fxRate ?? 1
  if (currency !== base && Number(fxRate) === 1) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Invoice is in ${currency} but no exchange rate to ${base} was supplied`,
    )
  }

  const partner = (
    await tx
      .select()
      .from(businessPartners)
      .where(
        and(
          eq(businessPartners.id, input.businessPartnerId),
          eq(businessPartners.organizationId, organizationId),
        ),
      )
      .limit(1)
  )[0]
  if (!partner) throw new AppError('NOT_FOUND', 'Business partner not found')

  const rateRows = await tx
    .select()
    .from(taxRates)
    .where(eq(taxRates.organizationId, organizationId))
  const rateById = new Map(rateRows.map((r) => [r.id, r]))

  let subtotal = 0
  let taxTotal = 0

  const prepared = input.lines.map((line, i) => {
    const qty = Number(line.quantity ?? 1)
    if (!Number.isFinite(qty)) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1} has an invalid quantity`)
    }
    const gross = assertSafeMinor(
      Math.round(qty * assertSafeMinor(line.unitPriceMinor, `line ${i + 1} unit price`)),
      `line ${i + 1} amount`,
    )
    const discount = assertSafeMinor(line.discountMinor ?? 0, `line ${i + 1} discount`)
    const net = gross - discount

    const rate = line.taxRateId ? rateById.get(line.taxRateId) : undefined
    if (line.taxRateId && !rate) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1} references an unknown tax rate`)
    }
    const tax = rate ? taxOn(net, rate.rate) : 0

    subtotal += net
    taxTotal += tax

    return {
      id: newId(),
      organizationId,
      invoiceId: '',
      lineNo: i + 1,
      productId: line.productId ?? null,
      description: line.description,
      quantity: String(qty),
      unitCode: line.unitCode ?? 'C62',
      unitPriceMinor: line.unitPriceMinor,
      discountPct: null,
      discountMinor: discount,
      netMinor: net,
      taxRateId: line.taxRateId ?? null,
      taxAmountMinor: tax,
      accountId: line.accountId ?? null,
      purchaseOrderLineId: null,
      goodsReceiptLineId: null,
      customFields: {},
    }
  })

  const total = subtotal + taxTotal
  const invoiceId = newId()
  const invoiceNo = await nextDocumentNumber(
    tx,
    organizationId,
    input.direction === 'ar' ? 'invoice_ar' : 'invoice_ap',
  )

  const address = (
    await tx
      .select()
      .from(partnerAddresses)
      .where(
        and(
          eq(partnerAddresses.partnerId, partner.id),
          eq(partnerAddresses.organizationId, organizationId),
          eq(partnerAddresses.type, 'billing'),
        ),
      )
      .limit(1)
  )[0]

  await tx.insert(invoices).values({
    id: invoiceId,
    organizationId,
    invoiceNo,
    direction: input.direction,
    businessPartnerId: partner.id,
    // Frozen at creation: an issued invoice must not change when the customer
    // later moves office or updates its VAT registration.
    partnerSnapshot: {
      name: partner.name,
      legalName: partner.legalName,
      taxId: partner.taxId,
      countryCode: partner.countryCode,
      address: address
        ? {
            street: address.street,
            street2: address.street2,
            city: address.city,
            region: address.region,
            postcode: address.postcode,
            countryCode: address.countryCode,
          }
        : null,
    },
    issueDate: input.issueDate,
    dueDate: input.dueDate ?? addDays(input.issueDate, partner.paymentTermsDays),
    deliveryDate: input.deliveryDate ?? null,
    paymentTerms: `NET ${partner.paymentTermsDays}`,
    currencyCode: currency,
    fxRate: String(fxRate),
    subtotalMinor: subtotal,
    taxTotalMinor: taxTotal,
    totalMinor: total,
    baseTotalMinor: convertToBase(total, fxRate, currency, base),
    status: 'draft',
    documentTypeCode: input.documentTypeCode ?? '380',
    buyerReference: input.buyerReference ?? null,
    orderReference: input.orderReference ?? null,
    matchStatus: input.direction === 'ap' ? 'not_applicable' : null,
    notes: input.notes ?? null,
    createdBy: actor.userId ?? null,
  })

  await tx.insert(invoiceLines).values(prepared.map((l) => ({ ...l, invoiceId })))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'invoice.created',
    entityType: 'invoice',
    entityId: invoiceId,
    after: { invoiceNo, direction: input.direction, total, currency, status: 'draft' },
    requestId: actor.requestId,
    ip: actor.ip,
  })

  return { id: invoiceId, invoiceNo, totalMinor: total }
}

/**
 * Issues a draft invoice: posts it to the ledger and makes it immutable.
 *
 * AR:  Dr Accounts receivable (total) / Cr Revenue (net) + Cr VAT payable (tax)
 * AP:  Dr Expense (net) + Dr VAT receivable (tax) / Cr Accounts payable (total)
 *
 * A CREDIT NOTE (document_type_code 381) posts the exact mirror of that — every
 * debit becomes a credit — and then applies itself to the invoice it credits.
 * It goes through this function rather than a parallel one on purpose: two
 * implementations of "post a document to the ledger" would eventually disagree
 * about rounding, FX or account selection, and the credit note is precisely the
 * document that has to agree with the invoice it reverses.
 *
 * Rounding across currencies is handled by deriving the component base amounts
 * from the invoice's base total with `allocate()`, rather than converting each
 * component independently. Independent conversion can round to a one-cent
 * difference between the control account and the sum of its counterparts, and
 * the ledger would — correctly — refuse the entry.
 */
export async function issueInvoice(
  tx: TenantTx,
  actor: PostingActor,
  invoiceId: string,
): Promise<{ journalEntryId: string; entryNo: number }> {
  const { organizationId } = actor

  const inv = (
    await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)))
      .limit(1)
  )[0]

  if (!inv) throw new AppError('NOT_FOUND', 'Invoice not found')
  if (inv.status !== 'draft') {
    throw new AppError('CONFLICT', `Only a draft invoice can be issued (this one is ${inv.status})`)
  }

  const lines = await tx
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(invoiceLines.lineNo)

  if (lines.length === 0) throw new AppError('VALIDATION_FAILED', 'Invoice has no lines')

  const base = await baseCurrencyOf(tx, organizationId)
  const isCredit = inv.documentTypeCode === '381'

  // TWO separate questions, and conflating them is the bug waiting to happen.
  //
  // `isAr` decides WHICH ACCOUNTS the document touches, and a credit note
  // touches exactly the same ones as the invoice it reverses — an AR credit
  // note still hits receivables, revenue and VAT payable.
  //
  // `debitControl` decides the SIGN. An AR invoice debits receivables; an AR
  // credit note credits them. That is the only thing the mirror changes.
  const isAr = inv.direction === 'ar'
  const debitControl = isCredit ? !isAr : isAr

  const controlAccountId = await accountBySubtype(
    tx,
    organizationId,
    isAr ? 'accounts_receivable' : 'accounts_payable',
  )
  const defaultIncomeExpense = await accountBySubtype(
    tx,
    organizationId,
    isAr ? 'revenue' : 'operating_expense',
  )
  const taxAccountId = await accountBySubtype(
    tx,
    organizationId,
    isAr ? 'vat_payable' : 'vat_receivable',
  )

  // Group net by account so a 40-line invoice does not produce 40 ledger lines.
  const netByAccount = new Map<string, number>()
  for (const l of lines) {
    const acct = l.accountId ?? defaultIncomeExpense
    netByAccount.set(acct, (netByAccount.get(acct) ?? 0) + l.netMinor)
  }

  const components: { accountId: string; amount: number; isTax: boolean }[] = [
    ...[...netByAccount.entries()].map(([accountId, amount]) => ({
      accountId,
      amount,
      isTax: false,
    })),
  ]
  if (inv.taxTotalMinor !== 0) {
    components.push({ accountId: taxAccountId, amount: inv.taxTotalMinor, isTax: true })
  }

  // Distribute the base total across components so they sum EXACTLY to it.
  const baseTotal = convertToBase(inv.totalMinor, inv.fxRate, inv.currencyCode, base)
  const baseParts = allocate(
    baseTotal,
    components.map((c) => c.amount),
  )

  const journalLinesInput: JournalLineInput[] = []

  // Control account: the whole invoice value, carrying the partner for the
  // AR/AP subledger — this is what makes aging reports possible.
  journalLinesInput.push({
    accountId: controlAccountId,
    ...(debitControl ? { debitMinor: inv.totalMinor } : { creditMinor: inv.totalMinor }),
    currencyCode: inv.currencyCode,
    fxRate: inv.fxRate,
    baseAmountMinor: baseTotal,
    businessPartnerId: inv.businessPartnerId,
    memo: `${inv.invoiceNo} · ${isAr ? 'receivable' : 'payable'}`,
  })

  components.forEach((c, i) => {
    const amount = c.amount
    if (amount === 0) return
    journalLinesInput.push({
      accountId: c.accountId,
      ...(debitControl ? { creditMinor: amount } : { debitMinor: amount }),
      currencyCode: inv.currencyCode,
      fxRate: inv.fxRate,
      memo: c.isTax ? `${inv.invoiceNo} · tax` : `${inv.invoiceNo} · ${isAr ? 'revenue' : 'cost'}`,
      // The pre-allocated share, so the components sum exactly to the control
      // account's base amount instead of each rounding on its own.
      baseAmountMinor: baseParts[i],
    })
  })

  const documentLabel = isCredit ? 'Credit note' : isAr ? 'Invoice' : 'Bill'

  const entry = await postJournalEntry(tx, actor, {
    entryDate: inv.issueDate,
    description: `${documentLabel} ${inv.invoiceNo}`,
    sourceType: 'invoice',
    sourceId: inv.id,
    lines: journalLinesInput,
  })

  await tx
    .update(invoices)
    .set({ status: 'issued', journalEntryId: entry.id, baseTotalMinor: baseTotal })
    .where(eq(invoices.id, invoiceId))

  // Applying the credit to the invoice it credits. Done HERE, in the same
  // transaction as the ledger entry, so the two can never disagree: a posted
  // reversal whose invoice still shows the full amount outstanding would show
  // up as an unexplained gap between the AR control account and the aging
  // report.
  if (isCredit && inv.creditsInvoiceId) {
    await applyCreditToInvoice(tx, actor, inv.creditsInvoiceId, inv.totalMinor, inv.invoiceNo)
  }

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: isCredit ? 'creditnote.issued' : 'invoice.issued',
    entityType: 'invoice',
    entityId: invoiceId,
    before: { status: 'draft' },
    after: {
      status: 'issued',
      journalEntryNo: entry.entryNo,
      total: inv.totalMinor,
      ...(isCredit ? { creditsInvoiceId: inv.creditsInvoiceId } : {}),
    },
    requestId: actor.requestId,
    ip: actor.ip,
  })

  // Emitted in this transaction: an invoice that fails to post cannot emit
  // "issued", and one that posts cannot fail to.
  await emit(tx, {
    organizationId,
    type: isCredit ? 'creditnote.issued' : 'invoice.issued',
    entityType: 'invoice',
    entityId: invoiceId,
    payload: {
      invoiceNo: inv.invoiceNo,
      direction: inv.direction,
      totalMinor: inv.totalMinor,
      currencyCode: inv.currencyCode,
      dueDate: inv.dueDate,
      businessPartnerId: inv.businessPartnerId,
      ...(isCredit ? { creditsInvoiceId: inv.creditsInvoiceId } : {}),
    },
    actorUserId: actor.userId,
  })

  return { journalEntryId: entry.id, entryNo: entry.entryNo }
}

/**
 * Records a credit against the invoice it was raised for.
 *
 * The status is recomputed from scratch rather than nudged, because the
 * combinations are not obvious: an invoice can be partly paid AND partly
 * credited, and an invoice paid in full then credited in full is a refund owed
 * to the customer — still 'credited', with the money side handled by an
 * outgoing payment.
 */
async function applyCreditToInvoice(
  tx: TenantTx,
  actor: PostingActor,
  targetInvoiceId: string,
  amountMinor: Minor,
  creditNoteNo: string,
): Promise<void> {
  const target = (
    await tx
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.id, targetInvoiceId), eq(invoices.organizationId, actor.organizationId)),
      )
      .limit(1)
  )[0]
  if (!target) throw new AppError('NOT_FOUND', 'The invoice being credited no longer exists')

  const credited = target.creditedMinor + amountMinor
  if (credited > target.totalMinor) {
    // Also a CHECK constraint. Caught here so the message names the document
    // rather than surfacing a constraint name to the user.
    throw new AppError(
      'VALIDATION_FAILED',
      `Crediting ${creditNoteNo} would take the total credited on ${target.invoiceNo} past its value`,
    )
  }

  const outstanding = target.totalMinor - target.amountPaidMinor - credited

  const status =
    credited >= target.totalMinor
      ? 'credited'
      : outstanding <= 0
        ? 'paid'
        : target.amountPaidMinor > 0
          ? 'partially_paid'
          : 'issued'

  await tx
    .update(invoices)
    .set({ creditedMinor: credited, status })
    .where(eq(invoices.id, targetInvoiceId))

  await writeAudit(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: 'invoice.credited',
    entityType: 'invoice',
    entityId: targetInvoiceId,
    before: { creditedMinor: target.creditedMinor, status: target.status },
    after: { creditedMinor: credited, status, by: creditNoteNo },
    requestId: actor.requestId,
    ip: actor.ip,
  })
}
