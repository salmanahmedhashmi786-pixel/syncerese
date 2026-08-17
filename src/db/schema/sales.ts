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

/** quote → sales order → delivery → invoice → payment. */

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    quoteNo: text('quote_no').notNull(),
    businessPartnerId: uuid('business_partner_id')
      .notNull()
      .references(() => businessPartners.id, { onDelete: 'restrict' }),
    dealId: uuid('deal_id'),
    status: text('status').notNull().default('draft'),
    quoteDate: date('quote_date').notNull(),
    validUntil: date('valid_until'),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    fxRate: numeric('fx_rate', { precision: 20, scale: 10 }).notNull().default('1'),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    taxTotalMinor: bigint('tax_total_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),
    customFields: jsonb('custom_fields').notNull().default({}),
    convertedOrderId: uuid('converted_order_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('quotes_org_no_uq').on(t.organizationId, t.quoteNo),
    index('quotes_org_partner_idx').on(t.organizationId, t.businessPartnerId),
    check(
      'quotes_status',
      sql`${t.status} in ('draft','sent','accepted','declined','expired','converted')`,
    ),
  ],
)

export const quoteLines = pgTable(
  'quote_lines',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => quotes.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('1'),
    unitCode: text('unit_code').notNull().default('C62'),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull().default(0),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),
    netMinor: bigint('net_minor', { mode: 'number' }).notNull().default(0),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'restrict' }),
    taxAmountMinor: bigint('tax_amount_minor', { mode: 'number' }).notNull().default(0),
  },
  (t) => [unique('quote_lines_quote_line_uq').on(t.quoteId, t.lineNo)],
)

export const salesOrders = pgTable(
  'sales_orders',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderNo: text('order_no').notNull(),
    businessPartnerId: uuid('business_partner_id')
      .notNull()
      .references(() => businessPartners.id, { onDelete: 'restrict' }),
    quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('draft'),
    orderDate: date('order_date').notNull(),
    requestedDeliveryDate: date('requested_delivery_date'),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id, { onDelete: 'restrict' }),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    fxRate: numeric('fx_rate', { precision: 20, scale: 10 }).notNull().default('1'),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    taxTotalMinor: bigint('tax_total_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    customerReference: text('customer_reference'),
    notes: text('notes'),
    customFields: jsonb('custom_fields').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('sales_orders_org_no_uq').on(t.organizationId, t.orderNo),
    index('sales_orders_org_status_idx').on(t.organizationId, t.status, t.orderDate),
    index('sales_orders_org_partner_idx').on(t.organizationId, t.businessPartnerId),
    check(
      'sales_orders_status',
      sql`${t.status} in
        ('draft','confirmed','partially_delivered','delivered','invoiced','cancelled')`,
    ),
  ],
)

/**
 * Per-line delivered and invoiced quantities rather than a single order-level
 * status — that is what makes partial delivery and partial invoicing
 * representable at all.
 */
export const salesOrderLines = pgTable(
  'sales_order_lines',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    salesOrderId: uuid('sales_order_id')
      .notNull()
      .references(() => salesOrders.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('1'),
    qtyDelivered: numeric('qty_delivered', { precision: 18, scale: 4 }).notNull().default('0'),
    qtyInvoiced: numeric('qty_invoiced', { precision: 18, scale: 4 }).notNull().default('0'),
    unitCode: text('unit_code').notNull().default('C62'),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull().default(0),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),
    netMinor: bigint('net_minor', { mode: 'number' }).notNull().default(0),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'restrict' }),
    taxAmountMinor: bigint('tax_amount_minor', { mode: 'number' }).notNull().default(0),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('sales_order_lines_order_line_uq').on(t.salesOrderId, t.lineNo),
    index('sales_order_lines_order_idx').on(t.organizationId, t.salesOrderId),
    check('sales_order_lines_qty_positive', sql`${t.quantity} > 0`),
  ],
)

/**
 * The shipment document.
 *
 * Exists as its own record rather than a quantity on the order because COGS
 * posts at DELIVERY while revenue posts at INVOICE, and those are routinely
 * different dates in different periods. Without it, margin lands in the wrong
 * month every time an order ships in one month and invoices in the next. It is
 * also the exact mirror of `goods_receipts` on the buy side, which keeps the
 * inventory posting logic symmetrical instead of special-cased per direction.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    deliveryNo: text('delivery_no').notNull(),
    salesOrderId: uuid('sales_order_id').references(() => salesOrders.id, {
      onDelete: 'restrict',
    }),
    businessPartnerId: uuid('business_partner_id')
      .notNull()
      .references(() => businessPartners.id, { onDelete: 'restrict' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('draft'),
    deliveryDate: date('delivery_date').notNull(),
    carrier: text('carrier'),
    trackingRef: text('tracking_ref'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('deliveries_org_no_uq').on(t.organizationId, t.deliveryNo),
    index('deliveries_org_order_idx').on(t.organizationId, t.salesOrderId),
    check('deliveries_status', sql`${t.status} in ('draft','shipped','cancelled')`),
  ],
)

export const deliveryLines = pgTable(
  'delivery_lines',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    deliveryId: uuid('delivery_id')
      .notNull()
      .references(() => deliveries.id, { onDelete: 'cascade' }),
    salesOrderLineId: uuid('sales_order_line_id').references(() => salesOrderLines.id, {
      onDelete: 'set null',
    }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    binLocationId: uuid('bin_location_id').references(() => binLocations.id, {
      onDelete: 'set null',
    }),
    /** Weighted-average cost AS CONSUMED at this moment — the COGS figure. */
    unitCostMinor: bigint('unit_cost_minor', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    index('delivery_lines_delivery_idx').on(t.organizationId, t.deliveryId),
    check('delivery_lines_qty_positive', sql`${t.quantity} > 0`),
  ],
)
