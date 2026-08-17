import { sql } from 'drizzle-orm'
import {
  bigint,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './identity'
import { accounts, journalEntries, taxRates } from './finance'
import { businessPartners } from './partners'
import { binLocations, products, warehouses } from './inventory'

/** requisition → purchase order → goods receipt → vendor invoice → payment. */

/**
 * The internal request that precedes a PO. Deliberately looser than a purchase
 * order: `productId` is nullable because the requester usually does not know
 * the catalogue item, and pricing is an estimate. The buyer resolves both on
 * conversion.
 *
 * Approval is a SINGLE approver above a per-tenant amount threshold (confirmed
 * decision). No `requisition_approvals` table exists — multi-step and
 * departmental routing are not built, and if they are added later these header
 * fields remain valid as the denormalised final outcome.
 */
export const purchaseRequisitions = pgTable(
  'purchase_requisitions',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    requisitionNo: text('requisition_no').notNull(),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    department: text('department'),
    status: text('status').notNull().default('draft'),
    neededBy: date('needed_by'),
    justification: text('justification'),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    estimatedTotalMinor: bigint('estimated_total_minor', { mode: 'number' })
      .notNull()
      .default(0),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    customFields: jsonb('custom_fields').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('purchase_requisitions_org_no_uq').on(t.organizationId, t.requisitionNo),
    index('purchase_requisitions_org_status_idx').on(t.organizationId, t.status),
    check(
      'purchase_requisitions_status',
      sql`${t.status} in ('draft','submitted','approved','rejected','converted','cancelled')`,
    ),
  ],
)

export const purchaseRequisitionLines = pgTable(
  'purchase_requisition_lines',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('1'),
    estimatedUnitPriceMinor: bigint('estimated_unit_price_minor', { mode: 'number' })
      .notNull()
      .default(0),
    suggestedSupplierId: uuid('suggested_supplier_id').references(() => businessPartners.id, {
      onDelete: 'set null',
    }),
    purchaseOrderLineId: uuid('purchase_order_line_id'),
  },
  (t) => [
    unique('purchase_requisition_lines_req_line_uq').on(t.requisitionId, t.lineNo),
    index('purchase_requisition_lines_req_idx').on(t.organizationId, t.requisitionId),
  ],
)

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    poNo: text('po_no').notNull(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartners.id, { onDelete: 'restrict' }),
    requisitionId: uuid('requisition_id').references(() => purchaseRequisitions.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('draft'),
    orderDate: date('order_date').notNull(),
    expectedDate: date('expected_date'),
    shipToWarehouseId: uuid('ship_to_warehouse_id').references(() => warehouses.id, {
      onDelete: 'restrict',
    }),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    fxRate: numeric('fx_rate', { precision: 20, scale: 10 }).notNull().default('1'),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    taxTotalMinor: bigint('tax_total_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    buyerUserId: uuid('buyer_user_id').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    notes: text('notes'),
    customFields: jsonb('custom_fields').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('purchase_orders_org_no_uq').on(t.organizationId, t.poNo),
    index('purchase_orders_org_status_idx').on(t.organizationId, t.status, t.orderDate),
    index('purchase_orders_org_supplier_idx').on(t.organizationId, t.supplierId),
    check(
      'purchase_orders_status',
      sql`${t.status} in
        ('draft','awaiting_approval','approved','partially_received','received','closed','cancelled')`,
    ),
  ],
)

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('1'),
    qtyReceived: numeric('qty_received', { precision: 18, scale: 4 }).notNull().default('0'),
    qtyInvoiced: numeric('qty_invoiced', { precision: 18, scale: 4 }).notNull().default('0'),
    unitCode: text('unit_code').notNull().default('C62'),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull().default(0),
    netMinor: bigint('net_minor', { mode: 'number' }).notNull().default(0),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'restrict' }),
    taxAmountMinor: bigint('tax_amount_minor', { mode: 'number' }).notNull().default(0),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict' }),
    expectedDate: date('expected_date'),
  },
  (t) => [
    unique('purchase_order_lines_po_line_uq').on(t.purchaseOrderId, t.lineNo),
    index('purchase_order_lines_po_idx').on(t.organizationId, t.purchaseOrderId),
    check('purchase_order_lines_qty_positive', sql`${t.quantity} > 0`),
  ],
)

/**
 * Goods receipt.
 *
 * Posting one debits inventory and credits GR/IR (goods-received /
 * invoice-received clearing). The vendor invoice later debits GR/IR and credits
 * AP. The GR/IR balance is therefore "received but not yet invoiced" — a figure
 * every auditor asks for, and one you simply cannot produce if receipts post
 * straight to accounts payable.
 */
export const goodsReceipts = pgTable(
  'goods_receipts',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    receiptNo: text('receipt_no').notNull(),
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id, {
      onDelete: 'restrict',
    }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartners.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    receiptDate: date('receipt_date').notNull(),
    status: text('status').notNull().default('draft'),
    deliveryNoteRef: text('delivery_note_ref'),
    receivedBy: uuid('received_by').references(() => users.id, { onDelete: 'set null' }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('goods_receipts_org_no_uq').on(t.organizationId, t.receiptNo),
    index('goods_receipts_org_po_idx').on(t.organizationId, t.purchaseOrderId),
    check('goods_receipts_status', sql`${t.status} in ('draft','posted','reversed')`),
  ],
)

export const goodsReceiptLines = pgTable(
  'goods_receipt_lines',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    goodsReceiptId: uuid('goods_receipt_id')
      .notNull()
      .references(() => goodsReceipts.id, { onDelete: 'cascade' }),
    purchaseOrderLineId: uuid('purchase_order_line_id').references(() => purchaseOrderLines.id, {
      onDelete: 'set null',
    }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    qtyReceived: numeric('qty_received', { precision: 18, scale: 4 }).notNull(),
    qtyRejected: numeric('qty_rejected', { precision: 18, scale: 4 }).notNull().default('0'),
    rejectionReason: text('rejection_reason'),
    binLocationId: uuid('bin_location_id').references(() => binLocations.id, {
      onDelete: 'set null',
    }),
    unitCostMinor: bigint('unit_cost_minor', { mode: 'number' }).notNull().default(0),
    /**
     * Freight, duty and customs handling, typed in by the buyer.
     *
     * Added to line cost BEFORE the weighted-average recalculation, so it
     * capitalises into inventory value rather than being expensed. Automatic
     * allocation of a freight invoice across lines is deliberately not built —
     * a future allocator writes this same column.
     */
    landedCostMinor: bigint('landed_cost_minor', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    index('goods_receipt_lines_receipt_idx').on(t.organizationId, t.goodsReceiptId),
    check('goods_receipt_lines_qty_non_negative', sql`${t.qtyReceived} >= 0`),
  ],
)
