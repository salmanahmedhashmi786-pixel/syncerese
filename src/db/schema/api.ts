import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'
import { users } from './identity'

/**
 * Per-tenant API keys (MUST DO #8, #18).
 *
 * Stored as SHA-256, never plaintext — the secret is shown once at creation and
 * is unrecoverable afterwards, which is the only honest way to hold a
 * credential a customer will paste into someone else's system.
 *
 * `scopes` is a subset of the PERMISSION catalogue, so there is one
 * authorization model rather than two. A key carries its own frozen scopes
 * rather than inheriting the creating user's live role: if that user is later
 * promoted to Owner, their old integration key must not silently gain the
 * ability to delete the organization.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),

    keyHash: text('key_hash').notNull(),
    /** `syn_live_a1b2c3` — enough to identify a key in a list, useless as a
     *  credential. */
    keyPrefix: text('key_prefix').notNull(),

    scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),

    /** Fixed-window rate limiting, counted on this row so the limit holds
     *  across every app instance rather than per-process. */
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(120),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }),
    windowCount: integer('window_count').notNull().default(0),

    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    uniqueIndex('api_keys_hash_uq').on(t.keyHash),
    index('api_keys_org_idx').on(t.organizationId),
    check('api_keys_rate_limit_positive', sql`${t.rateLimitPerMinute} > 0`),
  ],
)

/**
 * Transactional outbox.
 *
 * An event is written in the SAME transaction as the change it describes, so
 * "invoice issued" and "invoice.issued event" either both happen or neither
 * does. Delivery is a separate step — HTTP cannot participate in a database
 * transaction, and a webhook fired from inside one would be sent even when the
 * transaction later rolls back.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    payload: jsonb('payload').notNull().default({}),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null until the fan-out worker has created deliveries for it. */
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (t) => [
    index('events_org_type_idx').on(t.organizationId, t.type, t.occurredAt),
    index('events_undispatched_idx').on(t.dispatchedAt, t.occurredAt),
  ],
)

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description'),
    /** The shared secret used for HMAC signing. Shown once, like an API key. */
    secretHash: text('secret_hash').notNull(),
    /** The same secret, ENCRYPTED — a hash cannot sign, and every delivery has
     *  to compute an HMAC with it. See drizzle/0017 for the reasoning. */
    secretEncrypted: text('secret_encrypted'),
    secretPrefix: text('secret_prefix').notNull(),
    /** Event types this endpoint wants. `*` subscribes to everything. */
    events: text('events').array().notNull().default(sql`'{}'::text[]`),
    isActive: boolean('is_active').notNull().default(true),
    /** Consecutive failures. An endpoint that has been dead for a long time is
     *  auto-disabled rather than retried forever. */
    failureCount: integer('failure_count').notNull().default(0),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('webhook_endpoints_org_idx').on(t.organizationId, t.isActive),
    check('webhook_endpoints_https', sql`${t.url} like 'https://%'`),
  ],
)

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),

    status: text('status').notNull().default('pending'),
    attempt: smallint('attempt').notNull().default(0),
    /** Exponential backoff. Null once the delivery has succeeded or been
     *  abandoned. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),

    responseCode: integer('response_code'),
    responseBody: text('response_body'),
    error: text('error'),
    durationMs: integer('duration_ms'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_endpoint_event_uq').on(t.endpointId, t.eventId),
    index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    index('webhook_deliveries_org_idx').on(t.organizationId, t.createdAt),
    check(
      'webhook_deliveries_status',
      sql`${t.status} in ('pending','delivering','succeeded','failed','abandoned')`,
    ),
  ],
)

/**
 * Slack and Microsoft Teams notifications (MUST DO #14).
 *
 * Incoming webhooks, not OAuth apps: the customer creates a URL in their own
 * workspace and pastes it in. No app-store review sits between this product and
 * its first customer, and this deployment holds no vendor client secret.
 *
 * Delivery is by CURSOR rather than a row per message — see drizzle/0018 and
 * src/integrations/delivery.ts. A chat notification that fails should be
 * retried on the next tick, in order, not scheduled independently.
 */
export const chatIntegrations = pgTable(
  'chat_integrations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** 'slack' or 'teams'. They take different payload shapes entirely. */
    kind: text('kind').notNull(),
    /** What the customer calls it — "#finance", "Ops channel". */
    name: text('name').notNull(),
    /**
     * The incoming-webhook URL, ENCRYPTED.
     *
     * Anyone holding it can post into the customer's channel as though they
     * were us, so it is a credential and gets the same treatment as a webhook
     * signing secret. `urlHint` is host plus a few characters, so the UI can
     * say which one this is without revealing it.
     */
    targetUrlEncrypted: text('target_url_encrypted').notNull(),
    urlHint: text('url_hint').notNull(),
    /** Event types to post. `*` subscribes to everything. */
    events: text('events').array().notNull().default(sql`'{}'::text[]`),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * How far through this organization's event stream this integration has
     * read, ordered by `(occurred_at, id)`.
     *
     * The id breaks ties because Postgres `now()` is transaction-start time, so
     * several events emitted in one transaction share a timestamp exactly, and
     * a cursor on the timestamp alone would skip all but the last of them.
     */
    cursorAt: timestamp('cursor_at', { withTimezone: true }),
    cursorEventId: uuid('cursor_event_id'),
    failureCount: integer('failure_count').notNull().default(0),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('chat_integrations_org_idx').on(t.organizationId),
    check('chat_integrations_kind', sql`${t.kind} in ('slack','teams')`),
    // Both halves of the cursor move together or not at all. Half a cursor
    // makes every subsequent comparison return NULL, which reads as "nothing
    // waiting" — an integration that goes permanently, silently quiet.
    check(
      'chat_integrations_cursor_whole',
      sql`(${t.cursorAt} is null) = (${t.cursorEventId} is null)`,
    ),
  ],
)
