import { and, eq, sql } from 'drizzle-orm'
import {
  businessPartners,
  deliveries,
  deliveryLines,
  products,
  salesOrderLines,
  salesOrders,
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

export type SalesOrderLineInput = {
  productId?: string | null
  description?: string
  quantity: number
  unitPriceMinor?: Minor
  discountMinor?: Minor
  taxRateId?: string | null
}

export type CreateSalesOrderInput = {
  businessPartnerId: string
  orderDate: string
  requestedDeliveryDate?: string | null
  warehouseId?: string | null
  currencyCode?: string
  fxRate?: number | string
  customerReference?: string | null
  notes?: string | null
  quoteId?: string | null
  lines: SalesOrderLineInput[]
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0)

export async function createSalesOrder(
  tx: TenantTx,
  actor: PostingActor,
  input: CreateSalesOrderInput,
): Promise<{ id: string; orderNo: string; totalMinor: Minor }> {
  const { organizationId } = actor
  if (input.lines.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A sales order needs at least one line')
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
  if (!partner) throw new AppError('NOT_FOUND', 'Customer not found')

  const rateRows = await tx.select().from(taxRates).where(eq(taxRates.organizationId, organizationId))
  const rateById = new Map(rateRows.map((r) => [r.id, r]))

  const productIds = input.lines.map((l) => l.productId).filter(Boolean) as string[]
  const productRows = productIds.length
    ? await tx
        .select()
        .from(products)
        .where(
          and(
            eq(products.organizationId, organizationId),
            sql`${products.id} = any(${sql.raw(`ARRAY['${productIds.join("','")}']::uuid[]`)})`,
          ),
        )
    : []
  const productById = new Map(productRows.map((p) => [p.id, p]))

  let subtotal = 0
  let taxTotal = 0

  const prepared = input.lines.map((line, i) => {
    const product = line.productId ? productById.get(line.productId) : undefined
    if (line.productId && !product) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1} references an unknown product`)
    }

    const description = line.description ?? product?.name
    if (!description) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1} needs a description`)
    }
    if (!(line.quantity > 0)) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1} quantity must be positive`)
    }

    const unitPrice = assertSafeMinor(
      line.unitPriceMinor ?? product?.salesPriceMinor ?? 0,
      `line ${i + 1} unit price`,
    )
    const discount = assertSafeMinor(line.discountMinor ?? 0, `line ${i + 1} discount`)
    const net = Math.round(line.quantity * unitPrice) - discount

    const taxRateId = line.taxRateId ?? product?.taxRateId ?? null
    const rate = taxRateId ? rateById.get(taxRateId) : undefined
    if (taxRateId && !rate) {
      throw new AppError('VALIDATION_FAILED', `Line ${i + 1} references an unknown tax rate`)
    }
    const tax = rate ? taxOn(net, rate.rate) : 0

    subtotal += net
    taxTotal += tax

    return {
      id: newId(),
      organizationId,
      salesOrderId: '',
      lineNo: i + 1,
      productId: line.productId ?? null,
      description,
      quantity: String(line.quantity),
      unitCode: product?.unitCode ?? 'C62',
      unitPriceMinor: unitPrice,
      discountMinor: discount,
      netMinor: net,
      taxRateId,
      taxAmountMinor: tax,
      accountId: product?.incomeAccountId ?? null,
    }
  })

  const orderId = newId()
  const orderNo = await nextDocumentNumber(tx, organizationId, 'sales_order')

  await tx.insert(salesOrders).values({
    id: orderId,
    organizationId,
    orderNo,
    businessPartnerId: partner.id,
    quoteId: input.quoteId ?? null,
    status: 'draft',
    orderDate: input.orderDate,
    requestedDeliveryDate: input.requestedDeliveryDate ?? null,
    warehouseId: input.warehouseId ?? null,
    currencyCode: currency,
    fxRate: String(fxRate),
    subtotalMinor: subtotal,
    taxTotalMinor: taxTotal,
    totalMinor: subtotal + taxTotal,
    ownerUserId: actor.userId ?? null,
    customerReference: input.customerReference ?? null,
    notes: input.notes ?? null,
    createdBy: actor.userId ?? null,
  })

  await tx.insert(salesOrderLines).values(prepared.map((l) => ({ ...l, salesOrderId: orderId })))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'sales_order.created',
    entityType: 'sales_order',
    entityId: orderId,
    after: { orderNo, partner: partner.name, total: subtotal + taxTotal, currency },
    requestId: actor.requestId,
  })

  return { id: orderId, orderNo, totalMinor: subtotal + taxTotal }
}

export async function confirmSalesOrder(
  tx: TenantTx,
  actor: PostingActor,
  orderId: string,
): Promise<void> {
  const { organizationId } = actor
  const order = (
    await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.id, orderId), eq(salesOrders.organizationId, organizationId)))
      .limit(1)
  )[0]
  if (!order) throw new AppError('NOT_FOUND', 'Sales order not found')
  if (order.status !== 'draft') {
    throw new AppError('CONFLICT', `Only a draft order can be confirmed (this one is ${order.status})`)
  }

  // No ledger posting here, deliberately. Confirming an order is a commercial
  // commitment, not an accounting event — nothing has been delivered and
  // nothing is owed. Revenue recognition happens at invoice, cost at delivery.
  await tx.update(salesOrders).set({ status: 'confirmed' }).where(eq(salesOrders.id, orderId))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'sales_order.confirmed',
    entityType: 'sales_order',
    entityId: orderId,
    before: { status: 'draft' },
    after: { status: 'confirmed' },
    requestId: actor.requestId,
  })
}

export type DeliverInput = {
  salesOrderId: string
  deliveryDate: string
  warehouseId?: string | null
  carrier?: string | null
  trackingRef?: string | null
  /** Omit to ship everything still outstanding. */
  lines?: { salesOrderLineId: string; quantity: number; binLocationId?: string | null }[]
}

/**
 * Ships a sales order and posts cost of goods sold.
 *
 * Dr Cost of goods sold / Cr Inventory, at the weighted-average cost consumed
 * at this moment.
 *
 * COGS posts HERE, not at invoice. An order shipped in March and invoiced in
 * April must show its cost in March, or the margin in both months is wrong.
 * That is the entire reason the delivery exists as its own document.
 */
export async function deliverSalesOrder(
  tx: TenantTx,
  actor: PostingActor,
  input: DeliverInput,
): Promise<{ id: string; deliveryNo: string; cogsMinor: Minor; journalEntryId: string | null }> {
  const { organizationId } = actor

  const order = (
    await tx
      .select()
      .from(salesOrders)
      .where(
        and(eq(salesOrders.id, input.salesOrderId), eq(salesOrders.organizationId, organizationId)),
      )
      .limit(1)
  )[0]
  if (!order) throw new AppError('NOT_FOUND', 'Sales order not found')
  if (!['confirmed', 'partially_delivered'].includes(order.status)) {
    throw new AppError(
      'CONFLICT',
      `Order must be confirmed before it can ship (this one is ${order.status})`,
    )
  }

  const warehouseId = input.warehouseId ?? order.warehouseId
  if (!warehouseId) {
    throw new AppError('VALIDATION_FAILED', 'No warehouse specified for this delivery')
  }

  const orderLines = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, order.id))
    .orderBy(salesOrderLines.lineNo)

  // Default: everything still outstanding.
  const requested =
    input.lines ??
    orderLines
      .map((l) => ({
        salesOrderLineId: l.id,
        quantity: num(l.quantity) - num(l.qtyDelivered),
        binLocationId: null as string | null,
      }))
      .filter((l) => l.quantity > 0)

  if (requested.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Nothing left to deliver on this order')
  }

  const deliveryId = newId()
  const deliveryNo = await nextDocumentNumber(tx, organizationId, 'delivery')

  await tx.insert(deliveries).values({
    id: deliveryId,
    organizationId,
    deliveryNo,
    salesOrderId: order.id,
    businessPartnerId: order.businessPartnerId,
    warehouseId,
    status: 'draft',
    deliveryDate: input.deliveryDate,
    carrier: input.carrier ?? null,
    trackingRef: input.trackingRef ?? null,
    createdBy: actor.userId ?? null,
  })

  let cogsTotal = 0

  for (const req of requested) {
    const line = orderLines.find((l) => l.id === req.salesOrderLineId)
    if (!line) throw new AppError('VALIDATION_FAILED', 'Delivery references an unknown order line')

    const outstanding = num(line.quantity) - num(line.qtyDelivered)
    if (req.quantity <= 0) continue
    if (req.quantity > outstanding + 1e-9) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Line ${line.lineNo}: delivering ${req.quantity} exceeds the ${outstanding} outstanding`,
      )
    }

    let unitCost = 0

    // Only stock items move inventory. A consulting line on the same order is
    // delivered without touching valuation.
    if (line.productId) {
      const product = (
        await tx.select().from(products).where(eq(products.id, line.productId)).limit(1)
      )[0]

      if (product?.isTracked && product.type === 'stock') {
        const movement = await applyStockMovement(tx, actor, {
          productId: line.productId,
          warehouseId,
          binLocationId: req.binLocationId ?? null,
          qtyDelta: -req.quantity,
          movementType: 'sale_delivery',
          sourceType: 'delivery',
          sourceId: deliveryId,
        })
        unitCost = movement.unitCostMinor
        cogsTotal += movement.valueMinor
      }
    }

    await tx.insert(deliveryLines).values({
      id: newId(),
      organizationId,
      deliveryId,
      salesOrderLineId: line.id,
      productId: line.productId!,
      quantity: String(req.quantity),
      binLocationId: req.binLocationId ?? null,
      unitCostMinor: unitCost,
    })

    await tx
      .update(salesOrderLines)
      .set({ qtyDelivered: String(num(line.qtyDelivered) + req.quantity) })
      .where(eq(salesOrderLines.id, line.id))
  }

  // Post COGS only if something with a cost actually moved. A services-only
  // shipment produces no entry rather than an empty one.
  let journalEntryId: string | null = null
  if (cogsTotal > 0) {
    const cogsAccount = await accountBySubtype(tx, organizationId, 'cogs')
    const inventoryAccount = await accountBySubtype(tx, organizationId, 'inventory')

    const entry = await postJournalEntry(tx, actor, {
      entryDate: input.deliveryDate,
      description: `Cost of goods sold · ${deliveryNo}`,
      sourceType: 'stock_movement',
      sourceId: deliveryId,
      lines: [
        { accountId: cogsAccount, debitMinor: cogsTotal },
        { accountId: inventoryAccount, creditMinor: cogsTotal },
      ],
    })
    journalEntryId = entry.id
  }

  await tx
    .update(deliveries)
    .set({ status: 'shipped', journalEntryId })
    .where(eq(deliveries.id, deliveryId))

  // Roll the order's status up from its lines.
  const refreshed = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, order.id))
  const fullyDelivered = refreshed.every((l) => num(l.qtyDelivered) >= num(l.quantity) - 1e-9)

  await tx
    .update(salesOrders)
    .set({ status: fullyDelivered ? 'delivered' : 'partially_delivered' })
    .where(eq(salesOrders.id, order.id))

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'delivery.shipped',
    entityType: 'delivery',
    entityId: deliveryId,
    after: { deliveryNo, orderNo: order.orderNo, cogsMinor: cogsTotal, lines: requested.length },
    requestId: actor.requestId,
  })

  return { id: deliveryId, deliveryNo, cogsMinor: cogsTotal, journalEntryId }
}

/**
 * Invoices the delivered-but-not-yet-invoiced quantity on an order.
 *
 * Bills what has actually shipped, not what was ordered — invoicing ahead of
 * delivery would recognise revenue for goods the customer does not have.
 */
export async function invoiceSalesOrder(
  tx: TenantTx,
  actor: PostingActor,
  orderId: string,
  opts: { issueDate: string } ,
): Promise<{ invoiceId: string; invoiceNo: string; totalMinor: Minor }> {
  const { organizationId } = actor

  const order = (
    await tx
      .select()
      .from(salesOrders)
      .where(and(eq(salesOrders.id, orderId), eq(salesOrders.organizationId, organizationId)))
      .limit(1)
  )[0]
  if (!order) throw new AppError('NOT_FOUND', 'Sales order not found')
  if (order.status === 'draft' || order.status === 'cancelled') {
    throw new AppError('CONFLICT', `An order with status ${order.status} cannot be invoiced`)
  }

  const lines = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, order.id))
    .orderBy(salesOrderLines.lineNo)

  const billable = lines
    .map((l) => ({ line: l, qty: num(l.qtyDelivered) - num(l.qtyInvoiced) }))
    .filter((x) => x.qty > 1e-9)

  if (billable.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Nothing to invoice — deliver the order first, or it is already fully invoiced',
    )
  }

  const created = await createInvoice(tx, actor, {
    direction: 'ar',
    businessPartnerId: order.businessPartnerId,
    issueDate: opts.issueDate,
    currencyCode: order.currencyCode,
    fxRate: order.fxRate,
    orderReference: order.orderNo,
    lines: billable.map(({ line, qty }) => ({
      description: line.description,
      quantity: qty,
      unitPriceMinor: line.unitPriceMinor,
      taxRateId: line.taxRateId,
      accountId: line.accountId,
      productId: line.productId,
    })),
  })

  await issueInvoice(tx, actor, created.id)

  for (const { line, qty } of billable) {
    await tx
      .update(salesOrderLines)
      .set({ qtyInvoiced: String(num(line.qtyInvoiced) + qty) })
      .where(eq(salesOrderLines.id, line.id))
  }

  const refreshed = await tx
    .select()
    .from(salesOrderLines)
    .where(eq(salesOrderLines.salesOrderId, order.id))
  const fullyInvoiced = refreshed.every((l) => num(l.qtyInvoiced) >= num(l.quantity) - 1e-9)

  if (fullyInvoiced) {
    await tx.update(salesOrders).set({ status: 'invoiced' }).where(eq(salesOrders.id, order.id))
  }

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    action: 'sales_order.invoiced',
    entityType: 'sales_order',
    entityId: order.id,
    after: { invoiceNo: created.invoiceNo, total: created.totalMinor },
    requestId: actor.requestId,
  })

  return { invoiceId: created.id, invoiceNo: created.invoiceNo, totalMinor: created.totalMinor }
}
