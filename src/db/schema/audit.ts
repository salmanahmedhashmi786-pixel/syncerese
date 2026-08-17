import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './identity'

/**
 * Immutable audit trail (MUST DO #3).
 *
 * Immutability is a GRANT, not a convention: the application role is given
 * INSERT and SELECT only, with UPDATE and DELETE revoked in
 * drizzle/0001_rls.sql. Application code physically cannot rewrite history.
 *
 * GDPR erasure PSEUDONYMISES rather than deletes (confirmed decision, schema
 * §14): `actorUserId`, `ip` and `userAgent` are nulled and `actorPseudonym`
 * retains a stable opaque handle, so the sequence of events survives while the
 * personal data does not. Statutory accounting retention (e.g. §147 AO, ten
 * years) requires the record to persist; GDPR Art. 17(3) permits exactly this.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorType: text('actor_type').notNull().default('user'),
    /** Survives erasure so the trail stays coherent without personal data. */
    actorPseudonym: text('actor_pseudonym'),

    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),

    before: jsonb('before'),
    after: jsonb('after'),

    requestId: text('request_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_org_time_idx').on(t.organizationId, t.occurredAt),
    index('audit_log_entity_idx').on(t.organizationId, t.entityType, t.entityId),
    check(
      'audit_log_actor_type',
      sql`${t.actorType} in ('user','system','api_key','integration')`,
    ),
  ],
)

/**
 * Read/export log. This is the GDPR 72-hour breach-reconstruction requirement
 * made concrete — it answers "who accessed what".
 *
 * `rowCount` doubles as the anomaly hook from MUST DO #18: "one user exporting
 * unusually large amounts of data" is a query against this table, which is all
 * that is required at MVP stage.
 */
export const accessLog = pgTable(
  'access_log',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    resource: text('resource').notNull(),
    resourceId: text('resource_id'),
    action: text('action').notNull(),
    rowCount: integer('row_count'),

    ip: text('ip'),
    requestId: text('request_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('access_log_org_time_idx').on(t.organizationId, t.occurredAt),
    index('access_log_user_idx').on(t.organizationId, t.userId, t.occurredAt),
    check('access_log_action', sql`${t.action} in ('read','list','export','download')`),
  ],
)

/** Right to erasure (MUST DO #15). `method` records which posture was applied
 *  to each subject, so the tenant can evidence compliance. */
export const erasureRequests = pgTable(
  'erasure_requests',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').notNull().default('pending'),
    method: text('method'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    report: jsonb('report'),
  },
  (t) => [
    index('erasure_requests_org_idx').on(t.organizationId),
    check('erasure_requests_method', sql`${t.method} is null or ${t.method} in ('deleted','pseudonymized')`),
  ],
)

/** Right of access (MUST DO #15) — full tenant data export. */
export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    scope: text('scope').notNull().default('organization'),
    status: text('status').notNull().default('queued'),
    fileUrl: text('file_url'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('export_jobs_org_idx').on(t.organizationId)],
)

/** Explicit, timestamped, auditable consent — not an implied default
 *  (MUST DO #15, data minimisation & consent). */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    purpose: text('purpose').notNull(),
    granted: boolean('granted').notNull(),
    source: text('source'),
    ip: text('ip'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('consent_records_subject_idx').on(t.organizationId, t.subjectType, t.subjectId)],
)

/**
 * Data retention policies (MUST DO #15, GDPR Art. 5(1)(e)).
 *
 * Storage limitation is the obligation nobody sends a request about, which is
 * why it needs a job rather than a button. See drizzle/0021 for the reasoning,
 * and src/gdpr/retention.ts for the closed list of categories this can reach —
 * financial records and the audit log are not on it, and no configuration puts
 * them there.
 */
export const retentionPolicies = pgTable(
  'retention_policies',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** A key from the catalogue, never a table name: the mapping to an actual
     *  statement lives in reviewed code. */
    category: text('category').notNull(),
    /** NULL means keep indefinitely, and that is the default for every
     *  category. A retention job that starts deleting the day it ships is a
     *  data-loss incident, not a compliance feature. */
    retainDays: integer('retain_days'),
    /** Litigation, a tax audit, a regulatory investigation — all impose a duty
     *  to preserve that outranks storage limitation. */
    legalHold: boolean('legal_hold').notNull().default(false),
    legalHoldNote: text('legal_hold_note'),
    lastSweptAt: timestamp('last_swept_at', { withTimezone: true }),
    lastRemoved: integer('last_removed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('retention_policies_org_category_uq').on(t.organizationId, t.category),
    check('retention_policies_days', sql`${t.retainDays} is null or ${t.retainDays} >= 1`),
  ],
)
