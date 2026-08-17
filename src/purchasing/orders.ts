import { and, eq } from 'drizzle-orm'
import {
  businessPartners,
  goodsReceiptLines,
  goodsReceipts,
  invoiceLines,
  invoices,
  moduleSettings,
  products,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequisitionLines,
  purchaseRequisitions,
  taxRates,
} from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { assertSafeMinor, taxOn, type Minor } from '@/finance/money'
import {
  accountBySubtype,
  baseCurrencyOf,
  nextDocumentNumber,
  postJournalEntry,
  type PostingActor,
} from '@/finance/ledger'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { applyStockMovement } from '@/inventory/valuation'

const num = (v: string | number | null | undefined): number => Number(v ?? 0)

// ---------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------

export type RequisitionLineInput = {
  productId?: string | null
  description: string
  quantity: number
  estimatedUnitPriceMinor?: Minor
  suggestedSupplierId?: string | null
}

export async function createRequisition(
  tx: TenantTx,
  actor: PostingActor,
  input: {
    department?: string | null
    neededBy?: string | null
    justification?: string | null
    currencyCode?: string
    lines: RequisitionLineInput[]
  },
): Promise<{ id: string; requisitionNo: string; estimatedTotalMinor: Minor }> {
  const { organizationId } = actor
  if (input.lines.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A requisition needs at least one line')
  }

  const currency = (input.currencyCode ?? (await baseCurrencyOf(tx, organizationId))).toUpperCase()
  const estimated = input.lines.reduce(
    (s, l) => s + Math.round(l.quantity * assertSafeMinor(l.estimatedUnitPriceMinor ?? 0)),
    0,
  )

  const id = newId()
  const requisitionNo = await nextDocumentNumber(tx, organizationId, 'requisition')

  await tx.insert(purchaseRequisitions).values({
    id,
    organizationId,
    requisitionNo,
    requestedBy: actor.userId ?? null,
    department: input.department ?? null,
    status: 'draft',
    neededBy: input.neededBy ?? null,
    justification: input.justification ?? null,
    currencyCode: currency,
    estimatedTotalMinor: estimated,
  })

  await tx.insert(purchaseRequisitionLines).values(
    input.lines.map((l, i) => ({
      id: newId(),
      organizationId,
      requisitionId: id,
      lineNo: i + 1,
      productId: l.productId ?? null,
      description: l.description,
      quantity: String(l.quantity),
      estimatedUnitPriceMinor: l.estimatedUnitPriceMinor ?? 0,
      suggestedSupplierId: l.suggestedSupplierId ?? null,
    })),
  )

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'requisition.created',
    entityType: 'purchase_requisition',
    entityId: id,
    after: { requisitionNo, estimatedTotalMinor: estimated, lines: input.lines.length },
    requestId: actor.requestId,
  })

  return { id, requisitionNo, estimatedTotalMinor: estimated }
}

/** Per-tenant threshold, in base-currency minor units. Below it, submitting
 *  auto-approves; at or above it, one approver must act. */
async function approvalThreshold(tx: TenantTx, organizationId: string): Promise<number> {
  const rows = await tx
    .select()
    .from(moduleSettings)
    .where(
      and(
        eq(moduleSettings.organizationId, organizationId),
        eq(moduleSettings.moduleKey, 'purchasing'),
      ),
    )
    .limit(1)
  const settings = rows[0]?.settings as { requisitionApprovalThresholdMinor?: number } | undefined
  return settings?.requisitionApprovalThresholdMinor ?? 0
}

export async function submitRequisition(
  tx: TenantTx,
  actor: PostingActor,
  requisitionId: string,
): Promise<{ status: 'approved' | 'submitted' }> {
  const { organizationId } = actor
  const req = (
    await tx
      .select()
      .from(purchaseRequisitions)
      .where(
        and(
          eq(purchaseRequisitions.id, requisitionId),
          eq(purchaseRequisitions.organizationId, organizationId),
        ),
      )
      .limit(1)
  )[0]
  if (!req) throw new AppError('NOT_FOUND', 'Requisition not found')
  if (req.status !== 'draft') {
    throw new AppError('CONFLICT', `Only a draft requisition can be submitted (this one is ${req.status})`)
  }

  const threshold = await approvalThreshold(tx, organizationId)
  const autoApprove = threshold > 0 && req.estimatedTotalMinor < threshold

  await tx
    .update(purchaseRequisitions)
    .set(
      autoApprove
        ? { status: 'approved', approvedBy: actor.userId ?? null, approvedAt: new Date() }
        : { status: 'submitted' },
    )
    .where(eq(purchaseRequisitions.id, requisitionId))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: autoApprove ? 'requisition.auto_approved' : 'requisition.submitted',
    entityType: 'purchase_requisition',
    entityId: requisitionId,
    before: { status: 'draft' },
    after: {
      status: autoApprove ? 'approved' : 'submitted',
      thresholdMinor: threshold,
      estimatedTotalMinor: req.estimatedTotalMinor,
    },
    requestId: actor.requestId,
  })

  return { status: autoApprove ? 'approved' : 'submitted' }
}

export async function decideRequisition(
  tx: TenantTx,
  actor: PostingActor,
  requisitionId: string,
  decision: { approve: boolean; reason?: string },
): Promise<void> {
  const { organizationId } = actor
  const req = (
    await tx
      .select()
      .from(purchaseRequisitions)
      .where(
        and(
          eq(purchaseRequisitions.id, requisitionId),
          eq(purchaseRequisitions.organizationId, organizationId),
        ),
      )
      .limit(1)
  )[0]
  if (!req) throw new AppError('NOT_FOUND', 'Requisition not found')
  if (req.status !== 'submitted') {
    throw new AppError('CONFLICT', `Requisition is ${req.status}, not awaiting a decision`)
  }
  // The requester approving their own request defeats the point of the control.
  if (req.requestedBy && actor.userId && req.requestedBy === actor.userId) {
    throw new AppError('FORBIDDEN', 'You cannot approve your own requisition')
  }

  await tx
    .update(purchaseRequisitions)
    .set(
      decision.approve
        ? { status: 'approved', approvedBy: actor.userId ?? null, approvedAt: new Date() }
        : { status: 'rejected', rejectedReason: decision.reason ?? null },
    )
    .where(eq(purchaseRequisitions.id, requisitionId))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: decision.approve ? 'requisition.approved' : 'requisition.rejected',
    entityType: 'purchase_requisition',
    entityId: requisitionId,
    before: { status: 'submitted' },
    after: { status: decision.approve ? 'approved' : 'rejected', reason: decision.reason },
    requestId: actor.requestId,
  })
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export type PurchaseOrderLineInput = {
  productId?: string | null
  description?: string
  quantity: number
  unitPriceMinor: Minor
  taxRateId?: string | null
}

export async function createPurchaseOrder(
  tx: TenantTx,
  actor: PostingActor,
  input: {
    supplierId: string
    orderDate: string
    expectedDate?: string | null
    shipToWarehouseId?: string | null
    currencyCode?: string
    fxRate?: number | string
    requisitionId?: string | null
    lines: PurchaseOrderLineInput[]
  },
): Promise<{ id: string; poNo: string; totalMinor: Minor }> {
  const { organizationId } = actor
  if (input.lines.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A purchase order needs at least one line')
  }

  const base = await baseCurrencyOf(tx, organizationId)
  const currency = (input.currencyCode ?? base).toUpperCase()
  const fxRate = input.fxRate ?? 1
  if (currency !== base && Number(fxRate) === 1) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Order is in ${currency} but no exchange rate to ${base} was supplied`,
    )
  }

  const supplier = (
    await tx
      .select()
      .from(businessPartners)
      .where(
        and(
          eq(businessPartners.id, input.supplierId),
          eq(businessPartners.organizationId, organizationId),
        ),
      )
      .limit(1)
  )[0]
  if (!supplier) throw new AppError('NOT_FOUND', 'Supplier not found')

  const rateRows = await tx.select().from(taxRates).where(eq(taxRates.organizationId, organizationId))
  const rateById = new Map(rateRows.map((r) => [r.id, r]))

  let subtotal = 0
  let taxTotal = 0

  const prepared = input.lines.map((line, i) => {
    if (!(line.quantity > 0)) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1} quantity must be positive`)
    }
    const unitPrice = assertSafeMinor(line.unitPriceMinor, `line ${i + 1} unit price`)
    const net = Math.round(line.quantity * unitPrice)
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
      purchaseOrderId: '',
      lineNo: i + 1,
      productId: line.productId ?? null,
      description: line.description ?? 'Purchased item',
      quantity: String(line.quantity),
      unitPriceMinor: unitPrice,
      netMinor: net,
      taxRateId: line.taxRateId ?? null,
      taxAmountMinor: tax,
    }
  })

  const id = newId()
  const poNo = await nextDocumentNumber(tx, organizationId, 'purchase_order')

  await tx.insert(purchaseOrders).values({
    id,
    organizationId,
    poNo,
    supplierId: supplier.id,
    requisitionId: input.requisitionId ?? null,
    status: 'draft',
    orderDate: input.orderDate,
    expectedDate: input.expectedDate ?? null,
    shipToWarehouseId: input.shipToWarehouseId ?? null,
    currencyCode: currency,
    fxRate: String(fxRate),
    subtotalMinor: subtotal,
    taxTotalMinor: taxTotal,
    totalMinor: subtotal + taxTotal,
    buyerUserId: actor.userId ?? null,
    createdBy: actor.userId ?? null,
  })

  await tx.insert(purchaseOrderLines).values(prepared.map((l) => ({ ...l, purchaseOrderId: id })))

  if (input.requisitionId) {
    await tx
      .update(purchaseRequisitions)
      .set({ status: 'converted' })
      .where(eq(purchaseRequisitions.id, input.requisitionId))
  }

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'purchase_order.created',
    entityType: 'purchase_order',
    entityId: id,
    after: { poNo, supplier: supplier.name, total: subtotal + taxTotal, currency },
    requestId: actor.requestId,
  })

  return { id, poNo, totalMinor: subtotal + taxTotal }
}

export async function approvePurchaseOrder(
  tx: TenantTx,
  actor: PostingActor,
  purchaseOrderId: string,
): Promise<void> {
  const { organizationId } = actor
  const po = (
    await tx
      .select()
      .from(purchaseOrders)
      .where(
        and(eq(purchaseOrders.id, purchaseOrderId), eq(purchaseOrders.organizationId, organizationId)),
      )
      .limit(1)
  )[0]
  if (!po) throw new AppError('NOT_FOUND', 'Purchase order not found')
  if (!['draft', 'awaiting_approval'].includes(po.status)) {
    throw new AppError('CONFLICT', `Purchase order is ${po.status} and cannot be approved`)
  }

  await tx
    .update(purchaseOrders)
    .set({ status: 'approved', approvedBy: actor.userId ?? null, approvedAt: new Date() })
    .where(eq(purchaseOrders.id, purchaseOrderId))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'purchase_order.approved',
    entityType: 'purchase_order',
    entityId: purchaseOrderId,
    before: { status: po.status },
    after: { status: 'approved', poNo: po.poNo },
    requestId: actor.requestId,
  })
}

/**
 * Receives goods against a purchase order.
 *
 *     Dr Inventory        (qty × unit cost + landed cost)
 *     Cr GR/IR clearing   (same)
 *
 * The credit goes to GR/IR — goods-received / invoice-received — NOT to
 * accounts payable. The vendor invoice later debits GR/IR and credits AP. The
 * GR/IR balance is therefore exactly "received but not yet invoiced", which is
 * a figure auditors ask for and one you cannot produce if receipts post
 * straight to payables.
 */
export async function receiveGoods(
  tx: TenantTx,
  actor: PostingActor,
  input: {
    purchaseOrderId: string
    receiptDate: string
    warehouseId?: string | null
    deliveryNoteRef?: string | null
    lines?: {
      purchaseOrderLineId: string
      qtyReceived: number
      qtyRejected?: number
      rejectionReason?: string | null
      binLocationId?: string | null
      landedCostMinor?: Minor
    }[]
  },
): Promise<{ id: string; receiptNo: string; valueMinor: Minor; journalEntryId: string | null }> {
  const { organizationId } = actor

  const po = (
    await tx
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.id, input.purchaseOrderId),
          eq(purchaseOrders.organizationId, organizationId),
        ),
      )
      .limit(1)
  )[0]
  if (!po) throw new AppError('NOT_FOUND', 'Purchase order not found')
  if (!['approved', 'partially_received'].includes(po.status)) {
    throw new AppError(
      'CONFLICT',
      `Purchase order must be approved before goods can be received (this one is ${po.status})`,
    )
  }

  const warehouseId = input.warehouseId ?? po.shipToWarehouseId
  if (!warehouseId) {
    throw new AppError('VALIDATION_FAILED', 'No warehouse specified for this receipt')
  }

  const poLines = await tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(purchaseOrderLines.lineNo)

  const requested =
    input.lines ??
    poLines
      .map((l) => ({
        purchaseOrderLineId: l.id,
        qtyReceived: num(l.quantity) - num(l.qtyReceived),
        qtyRejected: 0,
        rejectionReason: null as string | null,
        binLocationId: null as string | null,
        landedCostMinor: 0,
      }))
      .filter((l) => l.qtyReceived > 0)

  if (requested.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Nothing left to receive on this order')
  }

  const receiptId = newId()
  const receiptNo = await nextDocumentNumber(tx, organizationId, 'goods_receipt')

  await tx.insert(goodsReceipts).values({
    id: receiptId,
    organizationId,
    receiptNo,
    purchaseOrderId: po.id,
    supplierId: po.supplierId,
    warehouseId,
    receiptDate: input.receiptDate,
    status: 'draft',
    deliveryNoteRef: input.deliveryNoteRef ?? null,
    receivedBy: actor.userId ?? null,
  })

  let receiptValue = 0

  for (const req of requested) {
    const line = poLines.find((l) => l.id === req.purchaseOrderLineId)
    if (!line) throw new AppError('VALIDATION_FAILED', 'Receipt references an unknown order line')
    if (req.qtyReceived <= 0) continue

    const outstanding = num(line.quantity) - num(line.qtyReceived)
    if (req.qtyReceived > outstanding + 1e-9) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Line ${line.lineNo}: receiving ${req.qtyReceived} exceeds the ${outstanding} outstanding`,
      )
    }

    const landed = assertSafeMinor(req.landedCostMinor ?? 0, 'landed cost')
    // Landed cost is spread over the received quantity and folded into unit
    // cost BEFORE the average recalculates, so freight and duty capitalise into
    // inventory value instead of being expensed.
    const unitCost = line.unitPriceMinor + Math.round(landed / req.qtyReceived)

    if (line.productId) {
      const product = (
        await tx.select().from(products).where(eq(products.id, line.productId)).limit(1)
      )[0]

      if (product?.isTracked && product.type === 'stock') {
        const movement = await applyStockMovement(tx, actor, {
          productId: line.productId,
          warehouseId,
          binLocationId: req.binLocationId ?? null,
          qtyDelta: req.qtyReceived,
          unitCostMinor: unitCost,
          movementType: 'purchase_receipt',
          sourceType: 'goods_receipt',
          sourceId: receiptId,
        })
        receiptValue += movement.valueMinor
      } else {
        // Services and non-stock still hit GR/IR — they were ordered and
        // received, they simply do not sit on a shelf.
        receiptValue += Math.round(req.qtyReceived * unitCost)
      }
    } else {
      receiptValue += Math.round(req.qtyReceived * unitCost)
    }

    await tx.insert(goodsReceiptLines).values({
      id: newId(),
      organizationId,
      goodsReceiptId: receiptId,
      purchaseOrderLineId: line.id,
      productId: line.productId!,
      qtyReceived: String(req.qtyReceived),
      qtyRejected: String(req.qtyRejected ?? 0),
      rejectionReason: req.rejectionReason ?? null,
      binLocationId: req.binLocationId ?? null,
      unitCostMinor: line.unitPriceMinor,
      landedCostMinor: landed,
    })

    await tx
      .update(purchaseOrderLines)
      .set({ qtyReceived: String(num(line.qtyReceived) + req.qtyReceived) })
      .where(eq(purchaseOrderLines.id, line.id))
  }

  let journalEntryId: string | null = null
  if (receiptValue > 0) {
    const inventoryAccount = await accountBySubtype(tx, organizationId, 'inventory')
    const grirAccount = await accountBySubtype(tx, organizationId, 'gr_ir_clearing')

    const entry = await postJournalEntry(tx, actor, {
      entryDate: input.receiptDate,
      description: `Goods receipt ${receiptNo}`,
      sourceType: 'stock_movement',
      sourceId: receiptId,
      lines: [
        { accountId: inventoryAccount, debitMinor: receiptValue },
        {
          accountId: grirAccount,
          creditMinor: receiptValue,
          businessPartnerId: po.supplierId,
        },
      ],
    })
    journalEntryId = entry.id
  }

  await tx
    .update(goodsReceipts)
    .set({ status: 'posted', journalEntryId })
    .where(eq(goodsReceipts.id, receiptId))

  const refreshed = await tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
  const fullyReceived = refreshed.every((l) => num(l.qtyReceived) >= num(l.quantity) - 1e-9)

  await tx
    .update(purchaseOrders)
    .set({ status: fullyReceived ? 'received' : 'partially_received' })
    .where(eq(purchaseOrders.id, po.id))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'goods_receipt.posted',
    entityType: 'goods_receipt',
    entityId: receiptId,
    after: { receiptNo, poNo: po.poNo, valueMinor: receiptValue, lines: requested.length },
    requestId: actor.requestId,
  })

  return { id: receiptId, receiptNo, valueMinor: receiptValue, journalEntryId }
}

export type MatchStatus =
  | 'matched'
  | 'price_variance'
  | 'quantity_variance'
  | 'unmatched'

/**
 * Records the supplier's invoice against a purchase order and performs the
 * three-way match: PO ↔ goods receipt ↔ invoice.
 *
 * Posting clears GR/IR rather than expensing again:
 *     Dr GR/IR clearing     (received value)
 *     Dr Purchase price variance (if within tolerance)
 *     Dr VAT receivable
 *     Cr Accounts payable   (invoice total)
 *
 * An invoice OUTSIDE tolerance is refused, not flagged. A three-way match that
 * warns and posts anyway is decoration — the entire value of the control is
 * that it stops the payment.
 */
export async function matchSupplierInvoice(
  tx: TenantTx,
  actor: PostingActor,
  input: {
    purchaseOrderId: string
    issueDate: string
    supplierInvoiceRef?: string | null
    /** Amount the supplier actually billed, net of tax. Defaults to the
     *  received value, i.e. a perfect match. */
    billedNetMinor?: Minor
  },
): Promise<{ invoiceId: string; invoiceNo: string; matchStatus: MatchStatus; varianceMinor: Minor }> {
  const { organizationId } = actor

  const po = (
    await tx
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.id, input.purchaseOrderId),
          eq(purchaseOrders.organizationId, organizationId),
        ),
      )
      .limit(1)
  )[0]
  if (!po) throw new AppError('NOT_FOUND', 'Purchase order not found')

  const poLines = await tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(purchaseOrderLines.lineNo)

  const billable = poLines
    .map((l) => ({ line: l, qty: num(l.qtyReceived) - num(l.qtyInvoiced) }))
    .filter((x) => x.qty > 1e-9)

  if (billable.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Nothing to invoice — receive the goods first, or the order is already fully invoiced',
    )
  }

  const expectedNet = billable.reduce(
    (s, { line, qty }) => s + Math.round(qty * line.unitPriceMinor),
    0,
  )
  const billedNet = assertSafeMinor(input.billedNetMinor ?? expectedNet, 'billed net')
  const variance = billedNet - expectedNet

  // Tolerance from module settings: absolute minor units, or a percentage.
  const settingsRow = (
    await tx
      .select()
      .from(moduleSettings)
      .where(
        and(
          eq(moduleSettings.organizationId, organizationId),
          eq(moduleSettings.moduleKey, 'purchasing'),
        ),
      )
      .limit(1)
  )[0]
  const settings = settingsRow?.settings as
    | { priceToleranceMinor?: number; priceTolerancePct?: number }
    | undefined
  const absTolerance = settings?.priceToleranceMinor ?? 0
  const pctTolerance = Math.round((expectedNet * (settings?.priceTolerancePct ?? 0)) / 100)
  const tolerance = Math.max(absTolerance, pctTolerance)

  let matchStatus: MatchStatus = 'matched'
  if (variance !== 0) {
    if (Math.abs(variance) <= tolerance) {
      matchStatus = 'price_variance'
    } else {
      throw new AppError(
        'CONFLICT',
        `Invoice is ${variance > 0 ? 'over' : 'under'} the purchase order by ` +
          `${Math.abs(variance) / 100} beyond the agreed tolerance. ` +
          `Resolve the price with the supplier or raise the tolerance before posting.`,
        { expectedNet, billedNet, variance, tolerance },
      )
    }
  }

  const created = await createInvoice(tx, actor, {
    direction: 'ap',
    businessPartnerId: po.supplierId,
    issueDate: input.issueDate,
    currencyCode: po.currencyCode,
    fxRate: po.fxRate,
    orderReference: po.poNo,
    buyerReference: input.supplierInvoiceRef ?? null,
    lines: billable.map(({ line, qty }) => ({
      description: line.description,
      quantity: qty,
      unitPriceMinor: line.unitPriceMinor,
      taxRateId: line.taxRateId,
      productId: line.productId,
    })),
  })

  await issueInvoice(tx, actor, created.id)

  // The AP invoice posting debits an expense account by default. For a
  // three-way-matched purchase the goods were already capitalised at receipt,
  // so that debit is reclassified out of expense and into GR/IR — otherwise the
  // cost is recognised twice.
  const grirAccount = await accountBySubtype(tx, organizationId, 'gr_ir_clearing')
  const expenseAccount = await accountBySubtype(tx, organizationId, 'operating_expense')

  await postJournalEntry(tx, actor, {
    entryDate: input.issueDate,
    description: `GR/IR clearing · ${created.invoiceNo} against ${po.poNo}`,
    sourceType: 'invoice',
    sourceId: created.id,
    lines: [
      { accountId: grirAccount, debitMinor: expectedNet, businessPartnerId: po.supplierId },
      { accountId: expenseAccount, creditMinor: expectedNet },
    ],
  })

  if (variance !== 0) {
    const ppvAccount = await accountBySubtype(tx, organizationId, 'purchase_price_variance')
    await postJournalEntry(tx, actor, {
      entryDate: input.issueDate,
      description: `Purchase price variance · ${created.invoiceNo}`,
      sourceType: 'invoice',
      sourceId: created.id,
      lines:
        variance > 0
          ? [
              { accountId: ppvAccount, debitMinor: variance },
              { accountId: expenseAccount, creditMinor: variance },
            ]
          : [
              { accountId: expenseAccount, debitMinor: Math.abs(variance) },
              { accountId: ppvAccount, creditMinor: Math.abs(variance) },
            ],
    })
  }

  for (const { line, qty } of billable) {
    await tx
      .update(purchaseOrderLines)
      .set({ qtyInvoiced: String(num(line.qtyInvoiced) + qty) })
      .where(eq(purchaseOrderLines.id, line.id))

    await tx
      .update(invoiceLines)
      .set({ purchaseOrderLineId: line.id })
      .where(
        and(
          eq(invoiceLines.invoiceId, created.id),
          eq(invoiceLines.description, line.description),
        ),
      )
  }

  await tx
    .update(invoices)
    .set({ matchStatus, matchToleranceApplied: { expectedNet, billedNet, variance, tolerance } })
    .where(eq(invoices.id, created.id))

  const refreshed = await tx
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
  const fullyInvoiced = refreshed.every((l) => num(l.qtyInvoiced) >= num(l.qtyReceived) - 1e-9)
  if (fullyInvoiced && po.status === 'received') {
    await tx.update(purchaseOrders).set({ status: 'closed' }).where(eq(purchaseOrders.id, po.id))
  }

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'purchase_invoice.matched',
    entityType: 'invoice',
    entityId: created.id,
    after: { invoiceNo: created.invoiceNo, poNo: po.poNo, matchStatus, variance, tolerance },
    requestId: actor.requestId,
  })

  return {
    invoiceId: created.id,
    invoiceNo: created.invoiceNo,
    matchStatus,
    varianceMinor: variance,
  }
}
