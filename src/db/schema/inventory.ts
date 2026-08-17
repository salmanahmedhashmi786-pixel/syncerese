import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './identity'
import { accounts, journalEntries, taxRates } from './finance'

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** `service` and `non_stock` items never touch inventory valuation. */
    type: text('type').notNull().default('stock'),
    /** UN/ECE Rec 20 — C62 piece, HUR hour, KGM kilogram. */
    unitCode: text('unit_code').notNull().default('C62'),

    salesPriceMinor: bigint('sales_price_minor', { mode: 'number' }).notNull().default(0),
    /** Standard/last cost. The valuation cost that actually moves the ledger
     *  lives on `stock_levels.avg_cost_minor` — this is a default for pricing
     *  and for the first receipt of a brand-new item. */
    costMinor: bigint('cost_minor', { mode: 'number' }).notNull().default(0),
    currencyCode: char('currency_code', { length: 3 }),

    incomeAccountId: uuid('income_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    expenseAccountId: uuid('expense_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    inventoryAccountId: uuid('inventory_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'restrict' }),

    /** Only tracked items maintain stock levels and post COGS on delivery. */
    isTracked: boolean('is_tracked').notNull().default(true),
    reorderPoint: numeric('reorder_point', { precision: 18, scale: 4 }),
    barcode: text('barcode'),

    customFields: jsonb('custom_fields').notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('products_org_sku_uq').on(t.organizationId, t.sku),
    index('products_org_name_idx').on(t.organizationId, t.name),
    check('products_type', sql`${t.type} in ('stock','service','non_stock')`),
  ],
)

export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    addressLine: text('address_line'),
    city: text('city'),
    countryCode: char('country_code', { length: 2 }),
    isDefault: boolean('is_default').notNull().default(false),
    /** Issuing below zero makes weighted-average cost meaningless, so it is
     *  refused unless a site explicitly opts in. */
    allowsNegativeStock: boolean('allows_negative_stock').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [unique('warehouses_org_code_uq').on(t.organizationId, t.code)],
)

/**
 * Bin locations, kept proportionate.
 *
 * `binLocationId` is nullable everywhere it appears. A tenant that does not
 * care about bins never sees the concept — each warehouse gets an implicit
 * default bin. A tenant that does gets real bin-level stock with no schema
 * change.
 *
 * Deliberately NOT full WMS: no putaway strategies, no pick-path optimisation,
 * no wave picking, no licence plates. Stock is located, transfers are
 * documented, receipts and shipments name a bin. That is the whole scope.
 */
export const binLocations = pgTable(
  'bin_locations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name'),
    zone: text('zone'),
    type: text('type').notNull().default('storage'),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    unique('bin_locations_wh_code_uq').on(t.warehouseId, t.code),
    index('bin_locations_org_idx').on(t.organizationId, t.warehouseId),
    check(
      'bin_locations_type',
      sql`${t.type} in ('storage','receiving','shipping','quarantine','transit')`,
    ),
  ],
)

/**
 * On-hand quantity and weighted-average cost per (product, warehouse, bin).
 *
 * Stored rather than derived: recomputing on-hand from the full movement
 * history on every list view does not scale past a few thousand movements.
 * Maintained inside the same transaction as the movement, with the row locked
 * FOR UPDATE so concurrent receipts cannot interleave and corrupt the average.
 */
export const stockLevels = pgTable(
  'stock_levels',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),
    binLocationId: uuid('bin_location_id').references(() => binLocations.id, {
      onDelete: 'set null',
    }),
    qtyOnHand: numeric('qty_on_hand', { precision: 18, scale: 4 }).notNull().default('0'),
    qtyReserved: numeric('qty_reserved', { precision: 18, scale: 4 }).notNull().default('0'),
    /** The moving average. Zero on-hand keeps the last known cost so a
     *  re-stock does not lose history. */
    avgCostMinor: bigint('avg_cost_minor', { mode: 'number' }).notNull().default(0),
    currencyCode: char('currency_code', { length: 3 }),
    lastMovementAt: timestamp('last_movement_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.warehouseId] }),
    index('stock_levels_org_idx').on(t.organizationId, t.productId),
  ],
)

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    binLocationId: uuid('bin_location_id').references(() => binLocations.id, {
      onDelete: 'set null',
    }),

    /** Signed: positive is a receipt, negative is an issue. */
    qtyDelta: numeric('qty_delta', { precision: 18, scale: 4 }).notNull(),
    movementType: text('movement_type').notNull(),

    /** Cost used for THIS movement, and the resulting average. Storing both
     *  makes COGS auditable line by line — you can prove what a historical
     *  shipment cost without replaying the whole movement history. */
    unitCostMinor: bigint('unit_cost_minor', { mode: 'number' }).notNull().default(0),
    avgCostAfterMinor: bigint('avg_cost_after_minor', { mode: 'number' }).notNull().default(0),

    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('stock_movements_org_product_idx').on(t.organizationId, t.productId, t.occurredAt),
    index('stock_movements_source_idx').on(t.organizationId, t.sourceType, t.sourceId),
    check(
      'stock_movements_type',
      sql`${t.movementType} in
        ('purchase_receipt','sale_delivery','adjustment','transfer_out','transfer_in',
         'count_correction','scrap','return_in','return_out')`,
    ),
    check('stock_movements_qty_nonzero', sql`${t.qtyDelta} <> 0`),
  ],
)

/**
 * A transfer is TWO movements with a gap, not one instantaneous relocation.
 *
 * Shipping writes `transfer_out` and moves the goods into an in-transit
 * position; receiving writes `transfer_in`. Between those events the stock is
 * on neither warehouse's shelf but is still on the balance sheet — which is
 * correct, and which a single-movement design silently gets wrong.
 */
export const stockTransfers = pgTable(
  'stock_transfers',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    transferNo: text('transfer_no').notNull(),
    fromWarehouseId: uuid('from_warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    toWarehouseId: uuid('to_warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('draft'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    shippedBy: uuid('shipped_by').references(() => users.id, { onDelete: 'set null' }),
    receivedBy: uuid('received_by').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('stock_transfers_org_no_uq').on(t.organizationId, t.transferNo),
    index('stock_transfers_org_status_idx').on(t.organizationId, t.status),
    check(
      'stock_transfers_status',
      sql`${t.status} in ('draft','in_transit','received','cancelled')`,
    ),
    check('stock_transfers_distinct_sites', sql`${t.fromWarehouseId} <> ${t.toWarehouseId}`),
  ],
)

export const stockTransferLines = pgTable(
  'stock_transfer_lines',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => stockTransfers.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    qtyReceived: numeric('qty_received', { precision: 18, scale: 4 }).notNull().default('0'),
    fromBinLocationId: uuid('from_bin_location_id').references(() => binLocations.id, {
      onDelete: 'set null',
    }),
    toBinLocationId: uuid('to_bin_location_id').references(() => binLocations.id, {
      onDelete: 'set null',
    }),
    /** Cross-warehouse transfers move at the SOURCE's average cost, so moving
     *  your own goods around never manufactures a gain or a loss. */
    unitCostMinor: bigint('unit_cost_minor', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    index('stock_transfer_lines_transfer_idx').on(t.organizationId, t.transferId),
    check('stock_transfer_lines_qty_positive', sql`${t.quantity} > 0`),
  ],
)
