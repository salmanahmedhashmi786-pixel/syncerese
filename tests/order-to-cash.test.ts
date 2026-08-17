import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { salesOrderLines, salesOrders } from '@/db/schema'
import { applyStockMovement, stockLevel } from '@/inventory/valuation'
import {
  confirmSalesOrder,
  createSalesOrder,
  deliverSalesOrder,
  invoiceSalesOrder,
} from '@/sales/orders'
import { trialBalance } from '@/finance/reports'
import { accountMovement, createOpsFixture, type OpsFixture } from './helpers/operations'

const YEAR = { from: '2026-01-01', to: '2026-12-31' }

describe('order to cash', () => {
  let f: OpsFixture

  const stockIn = (qty: number, unitCost: number, productId?: string) =>
    f.tx((tx) =>
      applyStockMovement(tx, f.actor, {
        productId: productId ?? f.widgetId,
        warehouseId: f.warehouseId,
        qtyDelta: qty,
        unitCostMinor: unitCost,
        movementType: 'purchase_receipt',
      }),
    )

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  it('runs order → confirm → deliver → invoice, posting cost and revenue correctly', async () => {
    await stockIn(100, 40_00)

    const order = await f.tx((tx) =>
      createSalesOrder(tx, f.actor, {
        businessPartnerId: f.customerId,
        orderDate: '2026-03-01',
        warehouseId: f.warehouseId,
        lines: [{ productId: f.widgetId, quantity: 10, taxRateId: f.vatRateId }],
      }),
    )
    // 10 × 100.00 + 19% VAT
    expect(order.totalMinor).toBe(119000)

    await f.tx((tx) => confirmSalesOrder(tx, f.actor, order.id))

    const delivery = await f.tx((tx) =>
      deliverSalesOrder(tx, f.actor, {
        salesOrderId: order.id,
        deliveryDate: '2026-03-05',
      }),
    )
    // COGS at the weighted average: 10 × 40.00
    expect(delivery.cogsMinor).toBe(40000)
    expect(await accountMovement(f, 'cogs')).toBe(40000)
    expect(await accountMovement(f, 'inventory')).toBe(-40000)
    expect((await f.tx((tx) => stockLevel(tx, f.orgId, f.widgetId, f.warehouseId))).qtyOnHand).toBe(90)

    // Revenue is NOT yet recognised — nothing has been invoiced.
    expect(await accountMovement(f, 'revenue')).toBe(0)

    const invoice = await f.tx((tx) =>
      invoiceSalesOrder(tx, f.actor, order.id, { issueDate: '2026-03-10' }),
    )
    expect(invoice.totalMinor).toBe(119000)
    expect(await accountMovement(f, 'revenue')).toBe(-100000) // credit
    expect(await accountMovement(f, 'accounts_receivable')).toBe(119000)

    const tb = await f.tx((tx) => trialBalance(tx, f.orgId, YEAR))
    expect(tb.inBalance).toBe(true)
  })

  it('posts COGS in the DELIVERY period, not the invoice period', async () => {
    await stockIn(100, 40_00)

    const order = await f.tx((tx) =>
      createSalesOrder(tx, f.actor, {
        businessPartnerId: f.customerId,
        orderDate: '2026-03-01',
        warehouseId: f.warehouseId,
        lines: [{ productId: f.widgetId, quantity: 10 }],
      }),
    )
    await f.tx((tx) => confirmSalesOrder(tx, f.actor, order.id))
    // Ships in March...
    await f.tx((tx) =>
      deliverSalesOrder(tx, f.actor, { salesOrderId: order.id, deliveryDate: '2026-03-28' }),
    )
    // ...invoices in April.
    await f.tx((tx) => invoiceSalesOrder(tx, f.actor, order.id, { issueDate: '2026-04-03' }))

    const { profitAndLoss } = await import('@/finance/reports')
    const march = await f.tx((tx) =>
      profitAndLoss(tx, f.orgId, { from: '2026-03-01', to: '2026-03-31' }),
    )
    const april = await f.tx((tx) =>
      profitAndLoss(tx, f.orgId, { from: '2026-04-01', to: '2026-04-30' }),
    )

    // This is the whole reason the delivery document exists. Fold COGS into the
    // invoice and March shows no cost while April shows cost with no revenue.
    expect(march.totalCostOfSalesMinor).toBe(40000)
    expect(march.totalIncomeMinor).toBe(0)
    expect(april.totalIncomeMinor).toBe(100000)
    expect(april.totalCostOfSalesMinor).toBe(0)
  })

  it('supports partial delivery and partial invoicing', async () => {
    await stockIn(100, 40_00)

    const order = await f.tx((tx) =>
      createSalesOrder(tx, f.actor, {
        businessPartnerId: f.customerId,
        orderDate: '2026-03-01',
        warehouseId: f.warehouseId,
        lines: [{ productId: f.widgetId, quantity: 10 }],
      }),
    )
    await f.tx((tx) => confirmSalesOrder(tx, f.actor, order.id))

    const lineId = await f.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(salesOrderLines)
        .where(eq(salesOrderLines.salesOrderId, order.id))
      return rows[0]!.id
    })

    await f.tx((tx) =>
      deliverSalesOrder(tx, f.actor, {
        salesOrderId: order.id,
        deliveryDate: '2026-03-05',
        lines: [{ salesOrderLineId: lineId, quantity: 4 }],
      }),
    )

    const afterPartial = await f.tx(async (tx) => {
      const rows = await tx.select().from(salesOrders).where(eq(salesOrders.id, order.id))
      return rows[0]!
    })
    expect(afterPartial.status).toBe('partially_delivered')

    // Only the delivered four are billable.
    await f.tx((tx) => invoiceSalesOrder(tx, f.actor, order.id, { issueDate: '2026-03-06' }))
    expect(await accountMovement(f, 'revenue')).toBe(-40000)

    await f.tx((tx) =>
      deliverSalesOrder(tx, f.actor, { salesOrderId: order.id, deliveryDate: '2026-03-20' }),
    )
    await f.tx((tx) => invoiceSalesOrder(tx, f.actor, order.id, { issueDate: '2026-03-21' }))

    const done = await f.tx(async (tx) => {
      const rows = await tx.select().from(salesOrders).where(eq(salesOrders.id, order.id))
      return rows[0]!
    })
    expect(done.status).toBe('invoiced')
    expect(await accountMovement(f, 'revenue')).toBe(-100000)
    expect(await accountMovement(f, 'cogs')).toBe(40000)
  })

  it('refuses to deliver more than was ordered', async () => {
    await stockIn(100, 40_00)
    const order = await f.tx((tx) =>
      createSalesOrder(tx, f.actor, {
        businessPartnerId: f.customerId,
        orderDate: '2026-03-01',
        warehouseId: f.warehouseId,
        lines: [{ productId: f.widgetId, quantity: 5 }],
      }),
    )
    await f.tx((tx) => confirmSalesOrder(tx, f.actor, order.id))

    const lineId = await f.tx(async (tx) => {
      const rows = await tx
        .select()
        .from(salesOrderLines)
        .where(eq(salesOrderLines.salesOrderId, order.id))
      return rows[0]!.id
    })

    await expect(
      f.tx((tx) =>
        deliverSalesOrder(tx, f.actor, {
          salesOrderId: order.id,
          deliveryDate: '2026-03-05',
          lines: [{ salesOrderLineId: lineId, quantity: 8 }],
        }),
      ),
    ).rejects.toThrow(/exceeds the 5 outstanding/)
  })

  it('refuses to ship an unconfirmed order', async () => {
    await stockIn(100, 40_00)
    const order = await f.tx((tx) =>
      createSalesOrder(tx, f.actor, {
        businessPartnerId: f.customerId,
        orderDate: '2026-03-01',
        warehouseId: f.warehouseId,
        lines: [{ productId: f.widgetId, quantity: 5 }],
      }),
    )
    await expect(
      f.tx((tx) =>
        deliverSalesOrder(tx, f.actor, { salesOrderId: order.id, deliveryDate: '2026-03-05' }),
      ),
    ).rejects.toThrow(/must be confirmed/)
  })

  it('refuses to invoice before anything has shipped', async () => {
    await stockIn(100, 40_00)
    const order = await f.tx((tx) =>
      createSalesOrder(tx, f.actor, {
        businessPartnerId: f.customerId,
        orderDate: '2026-03-01',
        warehouseId: f.warehouseId,
        lines: [{ productId: f.widgetId, quantity: 5 }],
      }),
    )
    await f.tx((tx) => confirmSalesOrder(tx, f.actor, order.id))

    // Invoicing ahead of delivery recognises revenue for goods the customer
    // does not have.
    await expect(
      f.tx((tx) => invoiceSalesOrder(tx, f.actor, order.id, { issueDate: '2026-03-02' })),
    ).rejects.toThrow(/deliver the order first/)
  })

  it('will not ship stock that is not there', async () => {
    await stockIn(3, 40_00)
    const order = await f.tx((tx) =>
      createSalesOrder(tx, f.actor, {
        businessPartnerId: f.customerId,
        orderDate: '2026-03-01',
        warehouseId: f.warehouseId,
        lines: [{ productId: f.widgetId, quantity: 10 }],
      }),
    )
    await f.tx((tx) => confirmSalesOrder(tx, f.actor, order.id))

    await expect(
      f.tx((tx) =>
        deliverSalesOrder(tx, f.actor, { salesOrderId: order.id, deliveryDate: '2026-03-05' }),
      ),
    ).rejects.toThrow(/SYNC_NEGATIVE_STOCK/)

    // The whole delivery rolls back — no partial shipment, no orphan document.
    expect((await f.tx((tx) => stockLevel(tx, f.orgId, f.widgetId, f.warehouseId))).qtyOnHand).toBe(3)
  })

  it('ships a services-only order without touching inventory or COGS', async () => {
    const order = await f.tx((tx) =>
      createSalesOrder(tx, f.actor, {
        businessPartnerId: f.customerId,
        orderDate: '2026-03-01',
        warehouseId: f.warehouseId,
        lines: [{ productId: f.serviceId, quantity: 2 }],
      }),
    )
    await f.tx((tx) => confirmSalesOrder(tx, f.actor, order.id))

    const delivery = await f.tx((tx) =>
      deliverSalesOrder(tx, f.actor, { salesOrderId: order.id, deliveryDate: '2026-03-05' }),
    )
    expect(delivery.cogsMinor).toBe(0)
    // No empty journal entry for a shipment with no cost.
    expect(delivery.journalEntryId).toBeNull()

    await f.tx((tx) => invoiceSalesOrder(tx, f.actor, order.id, { issueDate: '2026-03-06' }))
    expect(await accountMovement(f, 'revenue')).toBe(-100000) // 2 × 500.00
    expect(await accountMovement(f, 'cogs')).toBe(0)
  })

  it('keeps the ledger balanced across the whole flow', async () => {
    await stockIn(50, 40_00)
    await stockIn(50, 60_00) // average 50.00

    const order = await f.tx((tx) =>
      createSalesOrder(tx, f.actor, {
        businessPartnerId: f.customerId,
        orderDate: '2026-03-01',
        warehouseId: f.warehouseId,
        lines: [
          { productId: f.widgetId, quantity: 30, taxRateId: f.vatRateId },
          { productId: f.serviceId, quantity: 1, taxRateId: f.vatRateId },
        ],
      }),
    )
    await f.tx((tx) => confirmSalesOrder(tx, f.actor, order.id))
    await f.tx((tx) =>
      deliverSalesOrder(tx, f.actor, { salesOrderId: order.id, deliveryDate: '2026-03-05' }),
    )
    await f.tx((tx) => invoiceSalesOrder(tx, f.actor, order.id, { issueDate: '2026-03-06' }))

    expect(await accountMovement(f, 'cogs')).toBe(150000) // 30 × 50.00
    const tb = await f.tx((tx) => trialBalance(tx, f.orgId, YEAR))
    expect(tb.inBalance).toBe(true)
  })
})
