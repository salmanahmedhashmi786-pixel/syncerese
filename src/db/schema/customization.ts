import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './identity'

/**
 * Tenant-defined fields on core objects, WITHOUT a schema migration
 * (MUST DO #9).
 *
 * Definitions live here; values live in each table's existing `custom_fields`
 * jsonb column with a GIN index. The alternative — a column per tenant field —
 * turns every customer's customisation into a migration and a lock on a table
 * every other tenant is using.
 */
export const customFieldDefs = pgTable(
  'custom_field_defs',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    /** Slug used as the jsonb key. Immutable once created — renaming it would
     *  orphan every value already stored under the old key. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    fieldType: text('field_type').notNull().default('text'),
    /** For `select`: the allowed options. */
    options: jsonb('options').notNull().default([]),
    isRequired: boolean('is_required').notNull().default(false),
    helpText: text('help_text'),
    position: smallint('position').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    unique('custom_field_defs_org_entity_key_uq').on(t.organizationId, t.entityType, t.key),
    index('custom_field_defs_org_entity_idx').on(t.organizationId, t.entityType),
    check(
      'custom_field_defs_entity_type',
      sql`${t.entityType} in
        ('business_partner','product','deal','invoice','sales_order','purchase_order','partner_contact')`,
    ),
    check(
      'custom_field_defs_field_type',
      sql`${t.fieldType} in ('text','number','date','select','boolean','currency','url','email')`,
    ),
    // A jsonb key that collides with SQL identifier rules or contains dots would
    // break path-based querying later.
    check('custom_field_defs_key_slug', sql`${t.key} ~ '^[a-z][a-z0-9_]{0,48}$'`),
  ],
)

/**
 * Saved filter views, per user (MUST DO #11).
 *
 * `userId` null means the view is shared with the whole organization — that is
 * how a team standardises on "Overdue over €5k" without everyone rebuilding it.
 */
export const savedViews = pgTable(
  'saved_views',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    module: text('module').notNull(),
    name: text('name').notNull(),
    /** Structured filter tree — see `src/modules/filters.ts`. Stored as data so
     *  new operators need no migration. */
    filters: jsonb('filters').notNull().default({}),
    sort: jsonb('sort').notNull().default({}),
    columns: jsonb('columns').notNull().default({}),
    isDefault: boolean('is_default').notNull().default(false),
    position: smallint('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('saved_views_org_module_idx').on(t.organizationId, t.module, t.userId),
    unique('saved_views_org_user_module_name_uq').on(
      t.organizationId,
      t.userId,
      t.module,
      t.name,
    ),
  ],
)

/**
 * Free-form tags, polymorphic.
 *
 * The segmentation primitive for MUST DO #11: "build the data model so new
 * segments can be added without a rewrite (tag-based or custom-field-driven
 * segmentation, not hard-coded categories)". An `industry` enum would need a
 * migration for every new industry; a tag does not.
 */
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Optional grouping, e.g. `industry`, `size`, `region`. Lets the
     *  demographics layer offer "segment by industry" without hard-coding
     *  which tags are industries. */
    category: text('category'),
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tags_org_name_uq').on(t.organizationId, t.name),
    index('tags_org_category_idx').on(t.organizationId, t.category),
  ],
)

export const taggings = pgTable(
  'taggings',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tagId, t.entityType, t.entityId] }),
    index('taggings_org_entity_idx').on(t.organizationId, t.entityType, t.entityId),
  ],
)

/**
 * Lightweight automation: trigger → condition → action, stored as DATA.
 *
 * Deliberately not a BPMN engine (explicit AVOID in the brief). Triggers,
 * operators and actions are registry entries in code; a rule is a row. Adding
 * "when a deal is won, create a sales order" is a new action handler, not a
 * schema change and not a new table.
 */
export const workflowRules = pgTable(
  'workflow_rules',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),

    triggerType: text('trigger_type').notNull(),
    /** e.g. `{ entityType: 'invoice', field: 'status', to: 'issued' }` */
    triggerConfig: jsonb('trigger_config').notNull().default({}),
    /** Array of `{ field, op, value }`, ANDed. */
    conditions: jsonb('conditions').notNull().default([]),
    /** Array of `{ type, config }`, executed in order. */
    actions: jsonb('actions').notNull().default([]),

    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    runCount: integer('run_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('workflow_rules_org_trigger_idx').on(t.organizationId, t.triggerType, t.isActive),
    check(
      'workflow_rules_trigger_type',
      sql`${t.triggerType} in
        ('record.created','record.updated','field.changed','invoice.overdue','schedule')`,
    ),
  ],
)

/**
 * One execution. Kept even on success: "why did this customer get an email?"
 * is unanswerable without a run log, and automation nobody can explain is
 * automation nobody trusts.
 */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => workflowRules.id, { onDelete: 'cascade' }),
    triggerPayload: jsonb('trigger_payload').notNull().default({}),
    status: text('status').notNull().default('pending'),
    /** Per-action outcome, so a partial failure is visible rather than the run
     *  simply being marked failed. */
    actionsLog: jsonb('actions_log').notNull().default([]),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('workflow_runs_org_rule_idx').on(t.organizationId, t.ruleId, t.startedAt),
    check(
      'workflow_runs_status',
      sql`${t.status} in ('pending','skipped','succeeded','partial','failed')`,
    ),
  ],
)
