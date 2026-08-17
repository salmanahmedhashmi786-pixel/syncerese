import {
  boolean,
  char,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * The tenant root. Everything else in the system hangs off this.
 *
 * `region` is the data-residency hook (MUST DO #15): combined with UUIDv7 keys,
 * an EU tenant set can later be split onto EU-hosted infrastructure without ID
 * collisions and without a schema rewrite. Nothing in the codebase may assume a
 * single database or a single region.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey(),

    /** ASCII-only. Used in URLs, package refs, and anywhere the accented
     *  "Syncrèse" would need escaping. User-facing text uses `name`. */
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    legalName: text('legal_name'),

    region: text('region').notNull().default('eu-central'),

    baseCurrency: char('base_currency', { length: 3 }).notNull(),
    locale: text('locale').notNull().default('en-US'),
    countryCode: char('country_code', { length: 2 }),
    taxId: text('tax_id'),
    fiscalYearStartMonth: smallint('fiscal_year_start_month').notNull().default(1),

    // White-label branding (MUST DO #9). Syncrèse teal is the default accent.
    accent: text('accent').notNull().default('syncrese'),

    /** MUST DO #18: MFA is strongly recommended for Owner and Admin. A
     *  recommendation nobody can enforce is a line in a document, so the
     *  organization can make it a requirement. */
    requireMfaForAdmins: boolean('require_mfa_for_admins').notNull().default(false),
    logoUrl: text('logo_url'),
    customDomain: text('custom_domain'),

    status: text('status').notNull().default('active'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('organizations_region_idx').on(t.region)],
)

/**
 * Per-tenant module enablement (MUST DO #9: "tenants can enable/disable
 * modules ... the UI/nav should adapt"). Also carries per-module configuration
 * such as the requisition approval threshold and three-way match tolerances.
 */
export const moduleSettings = pgTable(
  'module_settings',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    moduleKey: text('module_key').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    settings: jsonb('settings').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('module_settings_org_idx').on(t.organizationId, t.moduleKey)],
)
