import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './identity'

/**
 * Customers, suppliers and prospects in ONE table with role flags.
 *
 * Separate `customers` and `crm_companies` tables is the classic source of
 * duplicate-account pain: a prospect converts to a customer and you now hold
 * two records, two revenue histories and a reconciliation problem nobody owns.
 * One partner, flags that accumulate.
 */
export const businessPartners = pgTable(
  'business_partners',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    partnerNo: text('partner_no').notNull(),
    name: text('name').notNull(),
    legalName: text('legal_name'),

    isCustomer: boolean('is_customer').notNull().default(false),
    isSupplier: boolean('is_supplier').notNull().default(false),
    isProspect: boolean('is_prospect').notNull().default(false),

    countryCode: char('country_code', { length: 2 }),
    /** VAT number / EIN. Required on an EN 16931 invoice above the simplified
     *  threshold, so it is a first-class column rather than a custom field. */
    taxId: text('tax_id'),
    taxScheme: text('tax_scheme'),
    registrationNo: text('registration_no'),

    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    creditLimitMinor: bigint('credit_limit_minor', { mode: 'number' }),
    currencyCode: char('currency_code', { length: 3 }),

    /** Peppol participant ID, Italian codice destinatario, or PEC address. */
    einvoiceRoutingId: text('einvoice_routing_id'),
    einvoiceFormat: text('einvoice_format').notNull().default('none'),

    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    customFields: jsonb('custom_fields').notNull().default({}),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('business_partners_org_no_uq').on(t.organizationId, t.partnerNo),
    index('business_partners_org_name_idx').on(t.organizationId, t.name),
    index('business_partners_roles_idx').on(t.organizationId, t.isCustomer, t.isSupplier),
    check(
      'business_partners_einvoice_format',
      sql`${t.einvoiceFormat} in ('none','peppol_bis3','fatturapa','facturx','xrechnung')`,
    ),
  ],
)

/**
 * STRUCTURED addresses, not a text blob.
 *
 * EN 16931 mandates discrete components — a single `address text` field cannot
 * produce a compliant e-invoice, and splitting one later means parsing free
 * text that users have already entered inconsistently.
 */
export const partnerAddresses = pgTable(
  'partner_addresses',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => businessPartners.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('billing'),
    street: text('street'),
    street2: text('street2'),
    city: text('city'),
    region: text('region'),
    postcode: text('postcode'),
    countryCode: char('country_code', { length: 2 }),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [
    index('partner_addresses_partner_idx').on(t.organizationId, t.partnerId),
    check('partner_addresses_type', sql`${t.type} in ('billing','shipping','legal')`),
  ],
)

/**
 * Contacts. `marketingConsent` is explicit, timestamped and sourced — consent
 * has to be evidenced, not assumed (MUST DO #15). Data minimisation is why
 * there is no date of birth, no personal address, no free-text notes field
 * here: the CRM does not need them.
 */
export const partnerContacts = pgTable(
  'partner_contacts',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => businessPartners.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    role: text('role'),
    isPrimary: boolean('is_primary').notNull().default(false),

    marketingConsent: boolean('marketing_consent').notNull().default(false),
    consentRecordedAt: timestamp('consent_recorded_at', { withTimezone: true }),
    consentSource: text('consent_source'),

    customFields: jsonb('custom_fields').notNull().default({}),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('partner_contacts_partner_idx').on(t.organizationId, t.partnerId),
    check(
      'partner_contacts_consent_evidenced',
      // Consent claimed without a timestamp is not evidence of consent.
      sql`${t.marketingConsent} = false or ${t.consentRecordedAt} is not null`,
    ),
  ],
)
