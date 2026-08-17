import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { purchaseOrderLines, purchaseOrders } from '@/db/schema'
import {
  approvePurchaseOrder,
  createPurchaseOrder,
  createRequisition,
  decideRequisition,
  matchSupplierInvoice,
  receiveGoods,
  submitRequisition,
} from '@/purchasing/orders'
import { stockLevel } from '@/inventory/valuation'
import { trialBalance } from '@/finance/reports'
import {
  accountMovement,
  createOpsFixture,
  setPurchasingSettings,
  type OpsFixture,
} from './helpers/operations'

const YEAR = { from: '2026-01-01', to: '2026-12-31' }

describe('procure to pay', () => {
  let f: OpsFixture

  const makePo = async (qty = 10, unitPrice = 40_00) => {
    const po = await f.tx((tx) =>
      createPurchaseOrder(tx, f.actor, {
        supplierId: f.supplierId,
        orderDate: '2026-03-01',
        shipToWarehouseId: f.warehouseId,
        lines: [{ productId: f.widgetId, description: 'Widgets', quantity: qty, unitPriceMinor: unitPrice }],
      }),
    )
    await f.tx((tx) => approvePurchaseOrder(tx, f.actor, po.id))
    return po
  }

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  describe('requisitions', () => {
    it('auto-approves below the threshold', async () => {
      await setPurchasingSettings(f, { requisitionApprovalThresholdMinor: 1000_00 })
      const req = await f.tx((tx) =>
        createRequisition(tx, f.actor, {
          currencyCode: 'EUR',
          lines: [{ description: 'Office chairs', quantity: 2, estimatedUnitPriceMinor: 100_00 }],
        }),
      )
      const result = await f.tx((tx) => submitRequisition(tx, f.actor, req.id))
      expect(result.status).toBe('approved')
    })

    it('routes to an approver at or above the threshold', async () => {
      await setPurchasingSettings(f, { requisitionApprovalThresholdMinor: 100_00 })
      const req = await f.tx((tx) =>
        createRequisition(tx, f.actor, {
          currencyCode: 'EUR',
          lines: [{ description: 'Machine tool', quantity: 1, estimatedUnitPriceMinor: 5000_00 }],
        }),
      )
      const result = await f.tx((tx) => submitRequisition(tx, f.actor, req.id))
      expect(result.status).toBe('submitted')
    })

    it('will not let the requester approve their own request', async () => {
      await setPurchasingSettings(f, { requisitionApprovalThresholdMinor: 100_00 })
      const req = await f.tx((tx) =>
        createRequisition(tx, f.actor, {
          currencyCode: 'EUR',
          lines: [{ description: 'Machine tool', quantity: 1, estimatedUnitPriceMinor: 5000_00 }],
        }),
      )
      await f.tx((tx) => submitRequisition(tx, f.actor, req.id))

      // Self-approval defeats the entire point of the control.
      await expect(
        f.tx((tx) => decideRequisition(tx, f.actor, req.id, { approve: true })),
      ).rejects.toThrow(/cannot approve your own/)
    })
  })

  describe('goods receipt and GR/IR', () => {
    it('receives to inventory against GR/IR, not accounts payable', async () => {
      const po = await makePo(10, 40_00)

      const receipt = await f.tx((tx) =>
        receiveGoods(tx, f.actor, { purchaseOrderId: po.id, receiptDate: '2026-03-10' }),
      )
      expect(receipt.valueMinor).toBe(40000)

      expect(await accountMovement(f, 'inventory')).toBe(40000) // debit
      expect(await accountMovement(f, 'gr_ir_clearing')).toBe(-40000) // credit
      // Nothing is owed until the supplier actually invoices.
      expect(await accountMovement(f, 'accounts_payable')).toBe(0)

      expect((await f.tx((tx) => stockLevel(tx, f.orgId, f.widgetId, f.warehouseId))).qtyOnHand).toBe(10)
    })

    it('capitalises manually entered landed cost into inventory value', async () => {
      const po = await makePo(10, 40_00)
      const lineId = await f.tx(async (tx) => {
        const rows = await tx
          .select()
          .from(purchaseOrderLines)
          .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
        return rows[0]!.id
      })

      // 100.00 of freight over 10 units = +10.00 each.
      await f.tx((tx) =>
        receiveGoods(tx, f.actor, {
          purchaseOrderId: po.id,
          receiptDate: '2026-03-10',
          lines: [{ purchaseOrderLineId: lineId, qtyReceived: 10, landedCostMinor: 100_00 }],
        }),
      )

      const level = await f.tx((tx) => stockLevel(tx, f.orgId, f.widgetId, f.warehouseId))
      // Freight must sit in inventory value, not be expensed.
      expect(level.avgCostMinor).toBe(5000)
      expect(await accountMovement(f, 'inventory')).toBe(50000)
    })

    it('refuses to receive against an unapproved order', async () => {
      const po = await f.tx((tx) =>
        createPurchaseOrder(tx, f.actor, {
          supplierId: f.supplierId,
          orderDate: '2026-03-01',
          shipToWarehouseId: f.warehouseId,
          lines: [{ productId: f.widgetId, description: 'Widgets', quantity: 5, unitPriceMinor: 40_00 }],
        }),
      )
      await expect(
        f.tx((tx) => receiveGoods(tx, f.actor, { purchaseOrderId: po.id, receiptDate: '2026-03-10' })),
      ).rejects.toThrow(/must be approved/)
    })

    it('refuses to over-receive', async () => {
      const po = await makePo(5, 40_00)
      const lineId = await f.tx(async (tx) => {
        const rows = await tx
          .select()
          .from(purchaseOrderLines)
          .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
        return rows[0]!.id
      })
      await expect(
        f.tx((tx) =>
          receiveGoods(tx, f.actor, {
            purchaseOrderId: po.id,
            receiptDate: '2026-03-10',
            lines: [{ purchaseOrderLineId: lineId, qtyReceived: 9 }],
          }),
        ),
      ).rejects.toThrow(/exceeds the 5 outstanding/)
    })

    it('supports partial receipt', async () => {
      const po = await makePo(10, 40_00)
      const lineId = await f.tx(async (tx) => {
        const rows = await tx
          .select()
          .from(purchaseOrderLines)
          .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
        return rows[0]!.id
      })

      await f.tx((tx) =>
        receiveGoods(tx, f.actor, {
          purchaseOrderId: po.id,
          receiptDate: '2026-03-10',
          lines: [{ purchaseOrderLineId: lineId, qtyReceived: 4 }],
        }),
      )

      const status = await f.tx(async (tx) => {
        const rows = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id))
        return rows[0]!.status
      })
      expect(status).toBe('partially_received')
      expect((await f.tx((tx) => stockLevel(tx, f.orgId, f.widgetId, f.warehouseId))).qtyOnHand).toBe(4)
    })
  })

  describe('three-way match', () => {
    it('clears GR/IR to accounts payable on a clean match', async () => {
      const po = await makePo(10, 40_00)
      await f.tx((tx) =>
        receiveGoods(tx, f.actor, { purchaseOrderId: po.id, receiptDate: '2026-03-10' }),
      )

      const result = await f.tx((tx) =>
        matchSupplierInvoice(tx, f.actor, { purchaseOrderId: po.id, issueDate: '2026-03-15' }),
      )
      expect(result.matchStatus).toBe('matched')
      expect(result.varianceMinor).toBe(0)

      // GR/IR nets to zero: credited at receipt, debited at invoice.
      expect(await accountMovement(f, 'gr_ir_clearing')).toBe(0)
      // Cost sits in inventory, not expensed twice.
      expect(await accountMovement(f, 'inventory')).toBe(40000)
      expect(await accountMovement(f, 'operating_expense')).toBe(0)
      // And the supplier is now owed.
      expect(await accountMovement(f, 'accounts_payable')).toBe(-40000)

      const tb = await f.tx((tx) => trialBalance(tx, f.orgId, YEAR))
      expect(tb.inBalance).toBe(true)
    })

    it('BLOCKS an invoice priced outside tolerance', async () => {
      await setPurchasingSettings(f, { priceToleranceMinor: 5_00 })
      const po = await makePo(10, 40_00)
      await f.tx((tx) =>
        receiveGoods(tx, f.actor, { purchaseOrderId: po.id, receiptDate: '2026-03-10' }),
      )

      // Supplier bills 450.00 against an expected 400.00.
      await expect(
        f.tx((tx) =>
          matchSupplierInvoice(tx, f.actor, {
            purchaseOrderId: po.id,
            issueDate: '2026-03-15',
            billedNetMinor: 450_00,
          }),
        ),
      ).rejects.toThrow(/beyond the agreed tolerance/)

      // Blocking must mean blocking: nothing posted, nothing owed.
      expect(await accountMovement(f, 'accounts_payable')).toBe(0)
      expect(await accountMovement(f, 'gr_ir_clearing')).toBe(-40000)
    })

    it('posts a variance within tolerance to the PPV account', async () => {
      await setPurchasingSettings(f, { priceToleranceMinor: 20_00 })
      const po = await makePo(10, 40_00)
      await f.tx((tx) =>
        receiveGoods(tx, f.actor, { purchaseOrderId: po.id, receiptDate: '2026-03-10' }),
      )

      const result = await f.tx((tx) =>
        matchSupplierInvoice(tx, f.actor, {
          purchaseOrderId: po.id,
          issueDate: '2026-03-15',
          billedNetMinor: 410_00,
        }),
      )
      expect(result.matchStatus).toBe('price_variance')
      expect(result.varianceMinor).toBe(1000)
      expect(await accountMovement(f, 'purchase_price_variance')).toBe(1000)

      const tb = await f.tx((tx) => trialBalance(tx, f.orgId, YEAR))
      expect(tb.inBalance).toBe(true)
    })

    it('honours a percentage tolerance', async () => {
      await setPurchasingSettings(f, { priceTolerancePct: 5 })
      const po = await makePo(10, 40_00)
      await f.tx((tx) =>
        receiveGoods(tx, f.actor, { purchaseOrderId: po.id, receiptDate: '2026-03-10' }),
      )
      // 5% of 400.00 is 20.00; a 15.00 variance is inside it.
      const result = await f.tx((tx) =>
        matchSupplierInvoice(tx, f.actor, {
          purchaseOrderId: po.id,
          issueDate: '2026-03-15',
          billedNetMinor: 415_00,
        }),
      )
      expect(result.matchStatus).toBe('price_variance')
    })

    it('refuses to invoice goods that were never received', async () => {
      const po = await makePo(10, 40_00)
      await expect(
        f.tx((tx) =>
          matchSupplierInvoice(tx, f.actor, { purchaseOrderId: po.id, issueDate: '2026-03-15' }),
        ),
      ).rejects.toThrow(/receive the goods first/)
    })

    it('GR/IR reports what has been received but not yet invoiced', async () => {
      const po = await makePo(10, 40_00)
      const lineId = await f.tx(async (tx) => {
        const rows = await tx
          .select()
          .from(purchaseOrderLines)
          .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
        return rows[0]!.id
      })

      await f.tx((tx) =>
        receiveGoods(tx, f.actor, {
          purchaseOrderId: po.id,
          receiptDate: '2026-03-10',
          lines: [{ purchaseOrderLineId: lineId, qtyReceived: 6 }],
        }),
      )
      // Six units received, none invoiced: GR/IR carries 240.00.
      expect(await accountMovement(f, 'gr_ir_clearing')).toBe(-24000)

      await f.tx((tx) =>
        matchSupplierInvoice(tx, f.actor, { purchaseOrderId: po.id, issueDate: '2026-03-15' }),
      )
      expect(await accountMovement(f, 'gr_ir_clearing')).toBe(0)
    })
  })
})
