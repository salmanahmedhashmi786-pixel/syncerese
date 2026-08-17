import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
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

/**
 * Invoices — AR and AP in one table, discriminated by `direction`.
 *
 * They share every structural concern (lines, tax, aging, payment allocation,
 * ledger posting) and differ only in sign and which control account they hit.
 * Two tables would mean two of every report.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    invoiceNo: text('invoice_no').notNull(),
    direction: text('direction').notNull(),

    businessPartnerId: uuid('business_partner_id')
      .notNull()
      .references(() => businessPartners.id, { onDelete: 'restrict' }),

    /**
     * The partner's name, address and tax id AS OF ISSUE.
     *
     * A live foreign key would rewrite history: an invoice legally issued to an
     * address in March must not silently change when the customer moves in
     * September. Tax authorities care about what the document said when it was
     * issued.
     */
    partnerSnapshot: jsonb('partner_snapshot'),

    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date').notNull(),
    /** EN 16931 requires the SUPPLY date, which is frequently not the invoice
     *  date. Keeping one field for both loses information you cannot recover. */
    deliveryDate: date('delivery_date'),
    paymentTerms: text('payment_terms'),

    currencyCode: char('currency_code', { length: 3 }).notNull(),
    fxRate: numeric('fx_rate', { precision: 20, scale: 10 }).notNull().default('1'),

    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull().default(0),
    taxTotalMinor: bigint('tax_total_minor', { mode: 'number' }).notNull().default(0),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull().default(0),
    baseTotalMinor: bigint('base_total_minor', { mode: 'number' }).notNull().default(0),
    amountPaidMinor: bigint('amount_paid_minor', { mode: 'number' }).notNull().default(0),

    status: text('status').notNull().default('draft'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),
    sourceOrderId: uuid('source_order_id'),

    /**
     * Credit notes.
     *
     * On a credit note (document_type_code 381) this points at the invoice
     * being credited. On an ordinary invoice it is null, and a trigger enforces
     * both directions — a 381 must credit a 380 of the same tenant, direction,
     * partner and currency.
     */
    creditsInvoiceId: uuid('credits_invoice_id'),

    /**
     * How much of THIS invoice has been credited away.
     *
     * Outstanding is total − paid − credited. Omitting credits from that is how
     * a fully credited invoice keeps turning up on the aging report and in the
     * dunning run.
     */
    creditedMinor: bigint('credited_minor', { mode: 'number' }).notNull().default(0),

    // --- e-invoicing (EN 16931 field coverage) ---
    /** UNTDID 1001: 380 invoice, 381 credit note. */
    documentTypeCode: text('document_type_code').notNull().default('380'),
    buyerReference: text('buyer_reference'),
    orderReference: text('order_reference'),
    paymentMeansCode: text('payment_means_code'),
    einvoiceStatus: text('einvoice_status').notNull().default('not_required'),
    einvoicePayloadId: uuid('einvoice_payload_id'),

    // --- three-way match (AP only; null on AR) ---
    matchStatus: text('match_status'),
    matchToleranceApplied: jsonb('match_tolerance_applied'),

    notes: text('notes'),
    customFields: jsonb('custom_fields').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    /** Drafts only. An ISSUED invoice is never deleted — it is credited. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    unique('invoices_org_no_uq').on(t.organizationId, t.invoiceNo),
    index('invoices_org_partner_idx').on(t.organizationId, t.businessPartnerId),
    index('invoices_org_status_due_idx').on(t.organizationId, t.status, t.dueDate),
    index('invoices_org_direction_idx').on(t.organizationId, t.direction, t.issueDate),
    check('invoices_direction', sql`${t.direction} in ('ar','ap')`),
    check(
      'invoices_status',
      sql`${t.status} in ('draft','issued','partially_paid','paid','cancelled','credited')`,
    ),
    check(
      'invoices_einvoice_status',
      sql`${t.einvoiceStatus} in ('not_required','pending','sent','accepted','rejected')`,
    ),
    check(
      'invoices_match_status',
      sql`${t.matchStatus} is null or ${t.matchStatus} in
          ('not_applicable','matched','price_variance','quantity_variance','unmatched')`,
    ),
    check('invoices_due_after_issue', sql`${t.dueDate} >= ${t.issueDate}`),
    check('invoices_totals_non_negative', sql`${t.amountPaidMinor} >= 0`),
  ],
)

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    productId: uuid('product_id'),
    /** Required: EN 16931 mandates a line description even for a catalogue
     *  item, because the buyer's system may not know your product codes. */
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull().default('1'),
    /** UN/ECE Rec 20 code — C62 = piece, HUR = hour, KGM = kilogram. */
    unitCode: text('unit_code').notNull().default('C62'),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull().default(0),

    discountPct: numeric('discount_pct', { precision: 6, scale: 4 }),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),

    netMinor: bigint('net_minor', { mode: 'number' }).notNull().default(0),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'restrict' }),
    taxAmountMinor: bigint('tax_amount_minor', { mode: 'number' }).notNull().default(0),

    /** Revenue account (AR) or expense/inventory account (AP). */
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'restrict' }),

    // three-way match links (AP only)
    purchaseOrderLineId: uuid('purchase_order_line_id'),
    goodsReceiptLineId: uuid('goods_receipt_line_id'),

    customFields: jsonb('custom_fields').notNull().default({}),
  },
  (t) => [
    unique('invoice_lines_invoice_line_uq').on(t.invoiceId, t.lineNo),
    index('invoice_lines_invoice_idx').on(t.organizationId, t.invoiceId),
  ],
)

export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    iban: text('iban'),
    bic: text('bic'),
    accountNumber: text('account_number'),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    /** The ledger account this bank account posts to. */
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    openingBalanceMinor: bigint('opening_balance_minor', { mode: 'number' })
      .notNull()
      .default(0),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [index('bank_accounts_org_idx').on(t.organizationId)],
)

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    paymentNo: text('payment_no').notNull(),
    direction: text('direction').notNull(),
    paymentDate: date('payment_date').notNull(),

    businessPartnerId: uuid('business_partner_id').references(() => businessPartners.id, {
      onDelete: 'restrict',
    }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),

    currencyCode: char('currency_code', { length: 3 }).notNull(),
    fxRate: numeric('fx_rate', { precision: 20, scale: 10 }).notNull().default('1'),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    baseAmountMinor: bigint('base_amount_minor', { mode: 'number' }).notNull(),
    /** Unallocated remainder — a customer overpayment or a payment on account
     *  is a real thing and must not be forced onto an invoice. */
    unallocatedMinor: bigint('unallocated_minor', { mode: 'number' }).notNull().default(0),

    method: text('method').notNull().default('bank_transfer'),
    reference: text('reference'),
    status: text('status').notNull().default('posted'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('payments_org_no_uq').on(t.organizationId, t.paymentNo),
    index('payments_org_partner_idx').on(t.organizationId, t.businessPartnerId),
    index('payments_org_date_idx').on(t.organizationId, t.paymentDate),
    check('payments_direction', sql`${t.direction} in ('in','out')`),
    check('payments_amount_positive', sql`${t.amountMinor} > 0`),
    check(
      'payments_method',
      sql`${t.method} in ('bank_transfer','card','cash','sepa_dd','cheque','other')`,
    ),
  ],
)

/**
 * The allocation table is what makes AR correct.
 *
 * Partial payments, one payment settling several invoices, and one invoice
 * settled by several payments are all ordinary. Collapsing this into an
 * `invoice_id` column on `payments` is the single most common way SME
 * accounting tools get receivables wrong.
 */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    baseAmountMinor: bigint('base_amount_minor', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payment_allocations_uq').on(t.paymentId, t.invoiceId),
    index('payment_allocations_invoice_idx').on(t.organizationId, t.invoiceId),
    check('payment_allocations_positive', sql`${t.amountMinor} > 0`),
  ],
)

/** The documented seam where a bank feed (Plaid / GoCardless / Nordigen) plugs
 *  in later without schema change. */
export const bankImportBatches = pgTable(
  'bank_import_batches',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    source: text('source').notNull().default('csv'),
    filename: text('filename'),
    rowCount: integer('row_count').notNull().default(0),
    importedRows: integer('imported_rows').notNull().default(0),
    duplicateRows: integer('duplicate_rows').notNull().default(0),
    importedBy: uuid('imported_by').references(() => users.id, { onDelete: 'set null' }),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bank_import_batches_org_idx').on(t.organizationId, t.bankAccountId)],
)

export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),

    valueDate: date('value_date').notNull(),
    bookingDate: date('booking_date'),
    /** Signed: positive is money in, negative is money out. Bank statements
     *  are naturally signed and forcing them into a direction column loses the
     *  bank's own view of the transaction. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull(),

    description: text('description'),
    counterpartyName: text('counterparty_name'),
    counterpartyIban: text('counterparty_iban'),

    /**
     * Idempotency key. Makes re-importing the same CSV a no-op, and is exactly
     * the field a bank feed writes its own transaction id into. Without it,
     * every accidental double-import silently doubles the bank balance.
     */
    externalId: text('external_id'),
    importBatchId: uuid('import_batch_id').references(() => bankImportBatches.id, {
      onDelete: 'set null',
    }),

    reconciliationStatus: text('reconciliation_status').notNull().default('unreconciled'),
    matchedPaymentId: uuid('matched_payment_id').references(() => payments.id, {
      onDelete: 'set null',
    }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('bank_transactions_external_uq').on(t.bankAccountId, t.externalId),
    index('bank_transactions_org_date_idx').on(t.organizationId, t.bankAccountId, t.valueDate),
    index('bank_transactions_recon_idx').on(t.organizationId, t.reconciliationStatus),
    check(
      'bank_transactions_recon_status',
      sql`${t.reconciliationStatus} in ('unreconciled','matched','reconciled','ignored')`,
    ),
    check('bank_transactions_amount_nonzero', sql`${t.amountMinor} <> 0`),
  ],
)
