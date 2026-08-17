import { and, eq, sql } from 'drizzle-orm'
import { products, stockLevels, stockMovements, warehouses } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { assertSafeMinor, type Minor } from '@/finance/money'
import type { PostingActor } from '@/finance/ledger'

/**
 * Weighted-average cost inventory valuation.
 *
 * On receipt:
 *     new_avg = (qty_on_hand × avg_cost + qty_in × receipt_unit_cost)
 *               ÷ (qty_on_hand + qty_in)
 *
 * On issue, the movement records the average AT THAT MOMENT as its unit cost
 * and the average after. Storing both is what makes COGS auditable line by
 * line — you can prove what any historical shipment cost without replaying the
 * entire movement history, which is the difference between an answer and an
 * argument when an auditor asks.
 *
 * The `stock_levels` row is locked FOR UPDATE for the whole calculation, so two
 * concurrent receipts cannot both read the old average and write conflicting
 * new ones.
 */

export type MovementType =
  | 'purchase_receipt'
  | 'sale_delivery'
  | 'adjustment'
  | 'transfer_out'
  | 'transfer_in'
  | 'count_correction'
  | 'scrap'
  | 'return_in'
  | 'return_out'

export type MovementInput = {
  productId: string
  warehouseId: string
  binLocationId?: string | null
  /** Signed. Positive receives, negative issues. */
  qtyDelta: number
  /** Required for inbound movements. Ignored for outbound, which consume the
   *  current average. */
  unitCostMinor?: Minor
  movementType: MovementType
  sourceType?: string | null
  sourceId?: string | null
  journalEntryId?: string | null
  occurredAt?: Date
}

export type MovementResult = {
  movementId: string
  /** Cost actually applied — the receipt cost inbound, the average outbound. */
  unitCostMinor: Minor
  /** Total value moved: |qty| × unitCost. This is the amount that posts. */
  valueMinor: Minor
  avgCostAfterMinor: Minor
  qtyOnHandAfter: number
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0)

/**
 * Applies one stock movement and updates the level and average cost.
 *
 * MUST be called inside the same transaction as the ledger posting it belongs
 * to, so stock and the general ledger can never disagree about a shipment that
 * half-happened.
 */
export async function applyStockMovement(
  tx: TenantTx,
  actor: PostingActor,
  input: MovementInput,
): Promise<MovementResult> {
  const { organizationId } = actor

  if (input.qtyDelta === 0) {
    throw new AppError('VALIDATION_FAILED', 'A stock movement cannot be for zero quantity')
  }

  const product = (
    await tx
      .select()
      .from(products)
      .where(and(eq(products.id, input.productId), eq(products.organizationId, organizationId)))
      .limit(1)
  )[0]
  if (!product) throw new AppError('NOT_FOUND', 'Product not found')

  if (!product.isTracked || product.type !== 'stock') {
    throw new AppError(
      'VALIDATION_FAILED',
      `${product.sku} is a ${product.type} item and does not carry stock`,
    )
  }

  const warehouse = (
    await tx
      .select()
      .from(warehouses)
      .where(
        and(eq(warehouses.id, input.warehouseId), eq(warehouses.organizationId, organizationId)),
      )
      .limit(1)
  )[0]
  if (!warehouse) throw new AppError('NOT_FOUND', 'Warehouse not found')

  // Lock the level row for the duration. Without this, two concurrent receipts
  // both read the old average and the second silently discards the first's
  // contribution.
  const locked = await tx.execute(sql`
    select qty_on_hand, avg_cost_minor
      from stock_levels
     where organization_id = ${organizationId}
       and product_id = ${input.productId}
       and warehouse_id = ${input.warehouseId}
     for update
  `)
  const current = (
    locked as unknown as { rows: { qty_on_hand: string; avg_cost_minor: string }[] }
  ).rows[0]

  const qtyBefore = num(current?.qty_on_hand)
  const avgBefore = num(current?.avg_cost_minor)
  const qtyAfter = Number((qtyBefore + input.qtyDelta).toFixed(4))

  let unitCost: Minor
  let avgAfter: Minor

  if (input.qtyDelta > 0) {
    // --- inbound -----------------------------------------------------------
    const receiptCost = assertSafeMinor(
      input.unitCostMinor ?? product.costMinor,
      'receipt unit cost',
    )
    if (receiptCost < 0) {
      throw new AppError('VALIDATION_FAILED', 'Receipt unit cost cannot be negative')
    }
    unitCost = receiptCost

    if (qtyBefore <= 0) {
      // Nothing on hand (or negative): adopt the receipt cost outright rather
      // than dividing by zero or averaging against a meaningless base.
      avgAfter = receiptCost
    } else {
      const totalValue = qtyBefore * avgBefore + input.qtyDelta * receiptCost
      avgAfter = Math.round(totalValue / qtyAfter)
    }
  } else {
    // --- outbound ----------------------------------------------------------
    // Issues consume the CURRENT average; they never change it. A caller that
    // passes a unit cost on an issue is misunderstanding the method, so it is
    // ignored rather than silently honoured.
    if (qtyBefore <= 0 && avgBefore === 0) {
      unitCost = product.costMinor
    } else {
      unitCost = avgBefore
    }
    avgAfter = qtyAfter === 0 ? avgBefore : avgBefore
  }

  const valueMinor = assertSafeMinor(
    Math.round(Math.abs(input.qtyDelta) * unitCost),
    'movement value',
  )

  // Upsert the level. The negative-stock guard is a trigger, so it applies here
  // regardless of which code path reached it.
  await tx
    .insert(stockLevels)
    .values({
      organizationId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      binLocationId: input.binLocationId ?? null,
      qtyOnHand: String(qtyAfter),
      avgCostMinor: avgAfter,
      currencyCode: product.currencyCode ?? null,
      lastMovementAt: input.occurredAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [stockLevels.productId, stockLevels.warehouseId],
      set: {
        qtyOnHand: String(qtyAfter),
        avgCostMinor: avgAfter,
        lastMovementAt: input.occurredAt ?? new Date(),
      },
    })

  const movementId = newId()
  await tx.insert(stockMovements).values({
    id: movementId,
    organizationId,
    productId: input.productId,
    warehouseId: input.warehouseId,
    binLocationId: input.binLocationId ?? null,
    qtyDelta: String(input.qtyDelta),
    movementType: input.movementType,
    unitCostMinor: unitCost,
    avgCostAfterMinor: avgAfter,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    journalEntryId: input.journalEntryId ?? null,
    occurredAt: input.occurredAt ?? new Date(),
    createdBy: actor.userId ?? null,
  })

  return {
    movementId,
    unitCostMinor: unitCost,
    valueMinor,
    avgCostAfterMinor: avgAfter,
    qtyOnHandAfter: qtyAfter,
  }
}

/** Current on-hand and average cost for one product at one site. */
export async function stockLevel(
  tx: TenantTx,
  organizationId: string,
  productId: string,
  warehouseId: string,
): Promise<{ qtyOnHand: number; avgCostMinor: number }> {
  const rows = await tx
    .select()
    .from(stockLevels)
    .where(
      and(
        eq(stockLevels.organizationId, organizationId),
        eq(stockLevels.productId, productId),
        eq(stockLevels.warehouseId, warehouseId),
      ),
    )
    .limit(1)
  const row = rows[0]
  return {
    qtyOnHand: num(row?.qtyOnHand),
    avgCostMinor: num(row?.avgCostMinor),
  }
}

/** Total inventory value across every site — ties to the inventory control
 *  account when the ledger is correct. */
export async function inventoryValue(
  tx: TenantTx,
  organizationId: string,
): Promise<Minor> {
  const res = await tx.execute(sql`
    select coalesce(sum(round(qty_on_hand * avg_cost_minor)), 0)::bigint as v
      from stock_levels
     where organization_id = ${organizationId}
  `)
  return Number((res as unknown as { rows: { v: string }[] }).rows[0]!.v)
}
