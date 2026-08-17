import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './identity'
import { businessPartners } from './partners'

/**
 * Light CRM. Companies and contacts REUSE `business_partners` and
 * `partner_contacts` rather than getting their own tables — see the rationale
 * there. A prospect that converts to a customer keeps one record and one
 * history instead of becoming a reconciliation problem.
 */

export const pipelines = pgTable(
  'pipelines',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('pipelines_org_name_uq').on(t.organizationId, t.name)],
)

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: smallint('position').notNull(),
    probabilityPct: smallint('probability_pct').notNull().default(0),
    isWon: boolean('is_won').notNull().default(false),
    isLost: boolean('is_lost').notNull().default(false),
  },
  (t) => [
    unique('pipeline_stages_pipeline_pos_uq').on(t.pipelineId, t.position),
    index('pipeline_stages_org_idx').on(t.organizationId, t.pipelineId),
    check('pipeline_stages_probability', sql`${t.probabilityPct} between 0 and 100`),
    // A stage cannot be both the win and the loss terminus.
    check('pipeline_stages_outcome', sql`not (${t.isWon} and ${t.isLost})`),
  ],
)

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    dealNo: text('deal_no').notNull(),
    name: text('name').notNull(),
    businessPartnerId: uuid('business_partner_id').references(() => businessPartners.id, {
      onDelete: 'set null',
    }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'restrict' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id, { onDelete: 'restrict' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull().default(0),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    expectedCloseDate: date('expected_close_date'),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('open'),
    lostReason: text('lost_reason'),
    /** Acquisition source — the dimension the demographics layer segments on
     *  (MUST DO #11). Free text plus tags rather than a hard-coded enum, so new
     *  segments need no schema change. */
    source: text('source'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    customFields: jsonb('custom_fields').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    unique('deals_org_no_uq').on(t.organizationId, t.dealNo),
    index('deals_org_stage_idx').on(t.organizationId, t.stageId),
    index('deals_org_status_idx').on(t.organizationId, t.status, t.expectedCloseDate),
    check('deals_status', sql`${t.status} in ('open','won','lost')`),
  ],
)

/**
 * Activity log. Polymorphic by (relatedType, relatedId) so a note can hang off
 * a deal, a partner, an invoice or an order without four near-identical tables.
 */
export const activities = pgTable(
  'activities',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('note'),
    subject: text('subject').notNull(),
    body: text('body'),
    relatedType: text('related_type'),
    relatedId: uuid('related_id'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('activities_org_related_idx').on(t.organizationId, t.relatedType, t.relatedId),
    index('activities_org_due_idx').on(t.organizationId, t.dueAt),
    check(
      'activities_type',
      sql`${t.type} in ('note','call','email','meeting','task','stage_change')`,
    ),
    check(
      'activities_related_pair',
      // Both or neither — a dangling relatedId with no type is unqueryable.
      sql`(${t.relatedType} is null) = (${t.relatedId} is null)`,
    ),
  ],
)
