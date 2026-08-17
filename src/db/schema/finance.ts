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
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './identity'

/**
 * ISO 4217. `minorUnit` is why money is never assumed to have two decimals:
 * JPY has none, KWD has three. A hard-coded /100 is a rounding bug waiting for
 * the first non-EUR/USD customer.
 */
export const currencies = pgTable('currencies', {
  code: char('code', { length: 3 }).primaryKey(),
  name: text('name').notNull(),
  minorUnit: smallint('minor_unit').notNull().default(2),
  symbol: text('symbol'),
})

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: uuid('id').primaryKey(),
    /** Null = a system-wide rate from a feed. Non-null = a tenant's own
     *  contractual or month-end rate, which overrides it. */
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    baseCode: char('base_code', { length: 3 }).notNull(),
    quoteCode: char('quote_code', { length: 3 }).notNull(),
    rate: numeric('rate', { precision: 20, scale: 10 }).notNull(),
    asOf: date('as_of').notNull(),
    source: text('source'),
  },
  (t) => [
    unique('exchange_rates_uq').on(t.organizationId, t.baseCode, t.quoteCode, t.asOf),
    index('exchange_rates_lookup_idx').on(t.baseCode, t.quoteCode, t.asOf),
  ],
)

/**
 * Chart of accounts.
 *
 * `subtype` is load-bearing, not decoration: it is how the posting engine finds
 * the right account without hard-coding account codes. The moment a tenant
 * customises their chart, code that looks up "account 1200" breaks; code that
 * looks up subtype 'accounts_receivable' does not.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    subtype: text('subtype'),
    parentId: uuid('parent_id'),
    /** Header accounts group children and cannot receive postings. */
    isPostable: boolean('is_postable').notNull().default(true),
    /** Set only for currency-specific accounts, e.g. a USD bank account. */
    currencyCode: char('currency_code', { length: 3 }),
    /** Control accounts (AR, AP, retained earnings) cannot be deleted while
     *  documents reference them. */
    isSystem: boolean('is_system').notNull().default(false),
    description: text('description'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('accounts_org_code_uq').on(t.organizationId, t.code),
    index('accounts_org_type_idx').on(t.organizationId, t.type),
    index('accounts_org_subtype_idx').on(t.organizationId, t.subtype),
    check('accounts_type', sql`${t.type} in ('asset','liability','equity','income','expense')`),
  ],
)

/**
 * Posting into a period that is not open is refused. Closing a period is what
 * makes a filed VAT return or a signed-off year stay filed and signed off.
 */
export const fiscalPeriods = pgTable(
  'fiscal_periods',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fiscalYear: integer('fiscal_year').notNull(),
    periodNo: smallint('period_no').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: text('status').notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    unique('fiscal_periods_uq').on(t.organizationId, t.fiscalYear, t.periodNo),
    index('fiscal_periods_range_idx').on(t.organizationId, t.startsOn, t.endsOn),
    check('fiscal_periods_status', sql`${t.status} in ('open','closed','locked')`),
    check('fiscal_periods_range', sql`${t.endsOn} >= ${t.startsOn}`),
  ],
)

/**
 * `en16931Category` is the e-invoicing decision made concrete: EN 16931 needs a
 * tax CATEGORY, not just a percentage. A 0% line must say why it is zero —
 * exempt (E), reverse charge (AE) and intra-community supply (K) are legally
 * different things that a bare 0.0000 cannot express.
 */
export const taxRates = pgTable(
  'tax_rates',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    rate: numeric('rate', { precision: 6, scale: 4 }).notNull(),
    countryCode: char('country_code', { length: 2 }),
    category: text('category').notNull().default('standard'),
    /**
     * UNTDID 5305 tax category code. `text`, not char(1): "AE" (VAT reverse
     * charge) is two characters, as is nothing else in the set — which is
     * exactly the kind of assumption that passes review and fails on the first
     * reverse-charge invoice.
     */
    en16931Category: text('en16931_category').notNull().default('S'),
    /** Where the tax lands: VAT payable for sales, VAT receivable for
     *  purchases. */
    salesAccountId: uuid('sales_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    purchaseAccountId: uuid('purchase_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    validFrom: date('valid_from'),
    validTo: date('valid_to'),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    unique('tax_rates_org_code_uq').on(t.organizationId, t.code),
    check(
      'tax_rates_en16931_category',
      sql`${t.en16931Category} in ('S','Z','E','AE','K','G','O','L','M')`,
    ),
    check('tax_rates_rate_range', sql`${t.rate} >= 0 and ${t.rate} <= 1`),
  ],
)

/**
 * Journal entry header.
 *
 * A POSTED entry is immutable — enforced by trigger, not convention. Mistakes
 * are corrected by posting a reversing entry linked through `reversesEntryId`,
 * which is what auditors expect and what makes the trail evidence rather than
 * a suggestion. A ledger you can edit proves nothing.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    entryNo: integer('entry_no').notNull(),
    entryDate: date('entry_date').notNull(),
    fiscalPeriodId: uuid('fiscal_period_id').references(() => fiscalPeriods.id, {
      onDelete: 'restrict',
    }),
    description: text('description'),

    /** What produced this entry. Lets a report drill from a ledger line back to
     *  the invoice or payment that caused it. */
    sourceType: text('source_type').notNull().default('manual'),
    sourceId: uuid('source_id'),

    status: text('status').notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => users.id, { onDelete: 'set null' }),

    reversesEntryId: uuid('reverses_entry_id'),
    reversedByEntryId: uuid('reversed_by_entry_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('journal_entries_org_no_uq').on(t.organizationId, t.entryNo),
    index('journal_entries_org_date_idx').on(t.organizationId, t.entryDate),
    index('journal_entries_source_idx').on(t.organizationId, t.sourceType, t.sourceId),
    check('journal_entries_status', sql`${t.status} in ('draft','posted','reversed')`),
    check(
      'journal_entries_source_type',
      sql`${t.sourceType} in ('manual','invoice','payment','stock_movement','fx_revaluation','opening_balance','period_close')`,
    ),
  ],
)

/**
 * Journal line.
 *
 * Money is bigint MINOR UNITS with an explicit currency — never a float, never
 * a bare decimal. Each line carries both its transaction amount and its
 * base-currency amount at a recorded rate, so FX gain and loss is derivable
 * later instead of being lost at entry time.
 */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),

    debitMinor: bigint('debit_minor', { mode: 'number' }).notNull().default(0),
    creditMinor: bigint('credit_minor', { mode: 'number' }).notNull().default(0),
    currencyCode: char('currency_code', { length: 3 }).notNull(),

    fxRate: numeric('fx_rate', { precision: 20, scale: 10 }).notNull().default('1'),
    baseDebitMinor: bigint('base_debit_minor', { mode: 'number' }).notNull().default(0),
    baseCreditMinor: bigint('base_credit_minor', { mode: 'number' }).notNull().default(0),

    /** The AR/AP subledger link — what makes an aging report possible without
     *  a separate parallel ledger. */
    businessPartnerId: uuid('business_partner_id'),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id, { onDelete: 'restrict' }),
    memo: text('memo'),
  },
  (t) => [
    index('journal_lines_entry_idx').on(t.journalEntryId, t.lineNo),
    index('journal_lines_account_idx').on(t.organizationId, t.accountId),
    index('journal_lines_partner_idx').on(t.organizationId, t.businessPartnerId),
    unique('journal_lines_entry_line_uq').on(t.journalEntryId, t.lineNo),

    // A line is a debit OR a credit. Never both, never neither.
    check(
      'journal_lines_one_sided',
      sql`(${t.debitMinor} = 0) <> (${t.creditMinor} = 0)`,
    ),
    // Negative debits are how sloppy ledgers disguise unbalanced entries.
    check(
      'journal_lines_non_negative',
      sql`${t.debitMinor} >= 0 and ${t.creditMinor} >= 0
          and ${t.baseDebitMinor} >= 0 and ${t.baseCreditMinor} >= 0`,
    ),
    // The base amount must sit on the same side as the transaction amount,
    // otherwise an entry could balance in base while being nonsense.
    check(
      'journal_lines_sides_agree',
      sql`(${t.debitMinor} = 0) = (${t.baseDebitMinor} = 0)
          and (${t.creditMinor} = 0) = (${t.baseCreditMinor} = 0)`,
    ),
    check('journal_lines_fx_positive', sql`${t.fxRate} > 0`),
  ],
)

/** Opening balances and per-document numbering, kept out of the application so
 *  two concurrent posts cannot draw the same number. */
export const documentSequences = pgTable(
  'document_sequences',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sequenceKey: text('sequence_key').notNull(),
    prefix: text('prefix').notNull().default(''),
    nextValue: integer('next_value').notNull().default(1),
    padding: smallint('padding').notNull().default(5),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (t) => [uniqueIndex('document_sequences_pk').on(t.organizationId, t.sequenceKey)],
)
