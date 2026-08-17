import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MODULES } from '@/modules/registry'
import { listModule } from '@/modules/queries'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { confirmSalesOrder, createSalesOrder, deliverSalesOrder } from '@/sales/orders'
import { approvePurchaseOrder, createPurchaseOrder, receiveGoods } from '@/purchasing/orders'
import { applyStockMovement } from '@/inventory/valuation'
import { createOpsFixture, type OpsFixture } from './helpers/operations'

/**
 * Every list query, executed for real.
 *
 * SQL is invisible to the type checker: two of these queries shipped with a
 * JOIN placed after the WHERE clause, which compiles perfectly and fails the
 * instant it runs. A smoke test that actually executes each one is the only
 * thing that catches that class of bug before a user does.
 */
describe('module list queries', () => {
  let f: OpsFixture
  const TODAY = '2026-03-20'

  beforeAll(async () => {
    f = await createOpsFixture()

    await f.tx((tx) =>
      applyStockMovement(tx, f.actor, {
        productId: f.widgetId,
        warehouseId: f.warehouseId,
        qtyDelta: 100,
        unitCostMinor: 40_00,
        movementType: 'purchase_receipt',
      }),
    )

    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Consulting', unitPriceMinor: 1000_00, taxRateId: f.vatRateId }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

    const so = await f.tx((tx) =>
      createSalesOrder(tx, f.actor, {
        businessPartnerId: f.customerId,
        orderDate: '2026-03-02',
        warehouseId: f.warehouseId,
        lines: [{ productId: f.widgetId, quantity: 10, taxRateId: f.vatRateId }],
      }),
    )
    await f.tx((tx) => confirmSalesOrder(tx, f.actor, so.id))
    await f.tx((tx) =>
      deliverSalesOrder(tx, f.actor, { salesOrderId: so.id, deliveryDate: '2026-03-05' }),
    )

    const po = await f.tx((tx) =>
      createPurchaseOrder(tx, f.actor, {
        supplierId: f.supplierId,
        orderDate: '2026-03-03',
        shipToWarehouseId: f.warehouseId,
        lines: [
          { productId: f.widgetId, description: 'Widgets', quantity: 20, unitPriceMinor: 42_00 },
        ],
      }),
    )
    await f.tx((tx) => approvePurchaseOrder(tx, f.actor, po.id))
    await f.tx((tx) =>
      receiveGoods(tx, f.actor, { purchaseOrderId: po.id, receiptDate: '2026-03-08' }),
    )
  })

  afterAll(async () => {
    await f.t.close()
  })

  const tableModules = MODULES.filter((m) => m.kind === 'table')

  it.each(tableModules.map((m) => m.id))('runs the %s list query', async (moduleId) => {
    const result = await f.tx((tx) => listModule(tx, f.orgId, moduleId, {}, TODAY))
    expect(result.rows).toBeInstanceOf(Array)
    expect(result.page).toBe(1)
    expect(result.pageCount).toBeGreaterThanOrEqual(1)
  })

  it.each(tableModules.map((m) => m.id))('searches, filters and paginates %s', async (moduleId) => {
    const module = MODULES.find((m) => m.id === moduleId)!

    // Search must not throw and must narrow.
    const searched = await f.tx((tx) =>
      listModule(tx, f.orgId, moduleId, { q: 'zzz-no-such-record' }, TODAY),
    )
    expect(searched.rows).toHaveLength(0)

    // Every declared status filter must be a valid query.
    for (const status of module.statuses ?? []) {
      const filtered = await f.tx((tx) => listModule(tx, f.orgId, moduleId, { status }, TODAY))
      expect(filtered.rows).toBeInstanceOf(Array)
    }

    // Page 2 of a 1-row page size.
    const paged = await f.tx((tx) =>
      listModule(tx, f.orgId, moduleId, { pageSize: 1, page: 2 }, TODAY),
    )
    expect(paged.pageSize).toBe(1)
  })

  it.each(tableModules.map((m) => m.id))('sorts %s by every sortable column', async (moduleId) => {
    const module = MODULES.find((m) => m.id === moduleId)!
    for (const column of module.columns) {
      for (const dir of ['asc', 'desc'] as const) {
        const result = await f.tx((tx) =>
          listModule(tx, f.orgId, moduleId, { sort: column.key, dir }, TODAY),
        )
        expect(result.rows).toBeInstanceOf(Array)
      }
    }
  })

  it('ignores an unknown sort key instead of injecting it', async () => {
    // Sort keys cannot be bind parameters, so they are resolved through an
    // allowlist. Anything unrecognised must fall back, never reach the SQL.
    const result = await f.tx((tx) =>
      listModule(
        tx,
        f.orgId,
        'invoices',
        { sort: 'id; drop table invoices; --', dir: 'asc' },
        TODAY,
      ),
    )
    expect(result.rows).toBeInstanceOf(Array)

    const stillThere = await f.tx((tx) => listModule(tx, f.orgId, 'invoices', {}, TODAY))
    expect(stillThere.total).toBeGreaterThan(0)
  })

  it('returns the data the new modules are supposed to show', async () => {
    const orders = await f.tx((tx) => listModule(tx, f.orgId, 'sales-orders', {}, TODAY))
    expect(orders.rows[0]).toMatchObject({ partnerName: expect.any(String) })
    expect(orders.rows[0]!.fulfilment).toBe('100%')

    const pos = await f.tx((tx) => listModule(tx, f.orgId, 'purchase-orders', {}, TODAY))
    expect(pos.rows[0]!.supplierName).toBe('Steinmetz Metallwerke')
    expect(pos.rows[0]!.fulfilment).toBe('100%')

    const products = await f.tx((tx) => listModule(tx, f.orgId, 'products', {}, TODAY))
    const widget = products.rows.find((r) => r.sku === 'WIDGET-01')!
    // 100 received @ 40.00, 10 shipped, 20 received @ 42.00
    expect(widget.qtyOnHand).toBe(110)
    expect(Number(widget.stockValueMinor)).toBeGreaterThan(0)
    expect(widget.signal).toBe('Not tracked') // no reorder point set
  })

  it('caps the page size so a caller cannot pull the whole table', async () => {
    const result = await f.tx((tx) =>
      listModule(tx, f.orgId, 'invoices', { pageSize: 100_000 }, TODAY),
    )
    expect(result.pageSize).toBeLessThanOrEqual(200)
  })
})
