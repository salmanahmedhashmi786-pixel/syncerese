import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { applyStockMovement, inventoryValue, stockLevel } from '@/inventory/valuation'
import { createOpsFixture, type OpsFixture } from './helpers/operations'

/**
 * Weighted-average cost.
 *
 * Valuation errors are silent and compounding: a wrong average is not visible
 * anywhere until a year-end stock count disagrees with the balance sheet by an
 * amount nobody can explain.
 */
describe('weighted average cost', () => {
  let f: OpsFixture

  const receive = (qty: number, unitCost: number) =>
    f.tx((tx) =>
      applyStockMovement(tx, f.actor, {
        productId: f.widgetId,
        warehouseId: f.warehouseId,
        qtyDelta: qty,
        unitCostMinor: unitCost,
        movementType: 'purchase_receipt',
      }),
    )

  const issue = (qty: number) =>
    f.tx((tx) =>
      applyStockMovement(tx, f.actor, {
        productId: f.widgetId,
        warehouseId: f.warehouseId,
        qtyDelta: -qty,
        movementType: 'sale_delivery',
      }),
    )

  const level = () => f.tx((tx) => stockLevel(tx, f.orgId, f.widgetId, f.warehouseId))

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  it('adopts the receipt cost when nothing is on hand', async () => {
    await receive(10, 40_00)
    expect(await level()).toEqual({ qtyOnHand: 10, avgCostMinor: 4000 })
  })

  it('averages across receipts at different costs', async () => {
    await receive(10, 40_00) // 400.00
    await receive(10, 60_00) // 600.00 -> 1000.00 over 20 units
    const { qtyOnHand, avgCostMinor } = await level()
    expect(qtyOnHand).toBe(20)
    expect(avgCostMinor).toBe(5000) // 50.00
  })

  it('issues at the average and leaves it unchanged', async () => {
    await receive(10, 40_00)
    await receive(10, 60_00)

    const out = await issue(5)
    expect(out.unitCostMinor).toBe(5000)
    expect(out.valueMinor).toBe(25000) // 5 × 50.00

    const { qtyOnHand, avgCostMinor } = await level()
    expect(qtyOnHand).toBe(15)
    // Issuing does not move the average — only receipts do.
    expect(avgCostMinor).toBe(5000)
  })

  it('records the cost used AND the average after, on every movement', async () => {
    await receive(10, 40_00)
    await receive(10, 60_00)
    await issue(5)

    const rows = await f.tx(async (tx) => {
      const res = await tx.execute(sql`
        select qty_delta, unit_cost_minor, avg_cost_after_minor
          from stock_movements
         where organization_id = ${f.orgId}
         order by occurred_at, id
      `)
      return (
        res as unknown as {
          rows: { qty_delta: string; unit_cost_minor: string; avg_cost_after_minor: string }[]
        }
      ).rows
    })

    // Without both columns you cannot prove what a historical shipment cost
    // without replaying every movement since.
    expect(rows.map((r) => Number(r.unit_cost_minor))).toEqual([4000, 6000, 5000])
    expect(rows.map((r) => Number(r.avg_cost_after_minor))).toEqual([4000, 5000, 5000])
  })

  it('refuses to go negative by default', async () => {
    await receive(5, 40_00)
    await expect(issue(10)).rejects.toThrow(/SYNC_NEGATIVE_STOCK/)
    // The failed issue must not have moved anything.
    expect((await level()).qtyOnHand).toBe(5)
  })

  it('allows negative stock only where the warehouse opts in', async () => {
    await receive(5, 40_00)
    await f.t.sudo(
      `update warehouses set allows_negative_stock = true where id = '${f.warehouseId}'`,
    )
    await expect(issue(10)).resolves.toBeDefined()
    expect((await level()).qtyOnHand).toBe(-5)
  })

  it('keeps the last known cost when stock runs to zero', async () => {
    await receive(10, 40_00)
    await issue(10)
    const { qtyOnHand, avgCostMinor } = await level()
    expect(qtyOnHand).toBe(0)
    // Losing the cost here would make the next receipt look like a first
    // receipt and silently discard the history.
    expect(avgCostMinor).toBe(4000)
  })

  it('values each warehouse independently', async () => {
    await receive(10, 40_00)
    await f.tx((tx) =>
      applyStockMovement(tx, f.actor, {
        productId: f.widgetId,
        warehouseId: f.warehouse2Id,
        qtyDelta: 10,
        unitCostMinor: 90_00,
        movementType: 'purchase_receipt',
      }),
    )

    const muc = await f.tx((tx) => stockLevel(tx, f.orgId, f.widgetId, f.warehouseId))
    const rtm = await f.tx((tx) => stockLevel(tx, f.orgId, f.widgetId, f.warehouse2Id))

    expect(muc.avgCostMinor).toBe(4000)
    expect(rtm.avgCostMinor).toBe(9000)
    // 10 × 40.00 + 10 × 90.00
    expect(await f.tx((tx) => inventoryValue(tx, f.orgId))).toBe(130000)
  })

  it('refuses to move a service item', async () => {
    await expect(
      f.tx((tx) =>
        applyStockMovement(tx, f.actor, {
          productId: f.serviceId,
          warehouseId: f.warehouseId,
          qtyDelta: 5,
          unitCostMinor: 100,
          movementType: 'purchase_receipt',
        }),
      ),
    ).rejects.toThrow(/service item and does not carry stock/)
  })

  it('rejects a zero-quantity movement', async () => {
    await expect(
      f.tx((tx) =>
        applyStockMovement(tx, f.actor, {
          productId: f.widgetId,
          warehouseId: f.warehouseId,
          qtyDelta: 0,
          movementType: 'adjustment',
        }),
      ),
    ).rejects.toThrow(/zero quantity/)
  })

  it('movement history is append-only', async () => {
    await receive(10, 40_00)
    await expect(
      f.t.sudo(`update stock_movements set unit_cost_minor = 1 where organization_id = '${f.orgId}'`),
    ).rejects.toThrow(/SYNC_APPEND_ONLY/)
    await expect(
      f.t.sudo(`delete from stock_movements where organization_id = '${f.orgId}'`),
    ).rejects.toThrow(/SYNC_APPEND_ONLY/)
  })

  it('survives an awkward average without drifting', async () => {
    // 3 @ 10.00 then 7 @ 3.33 -> (3000 + 2331) / 10 = 533.1 -> 533
    await receive(3, 10_00)
    await receive(7, 3_33)
    const { avgCostMinor } = await level()
    expect(avgCostMinor).toBe(533)

    // Issuing everything at the rounded average leaves the level at zero.
    const out = await issue(10)
    expect(out.valueMinor).toBe(5330)
    expect((await level()).qtyOnHand).toBe(0)
  })
})
