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
 * Product-key licensing (MUST DO #16).
 *
 * Enforcement lives in the database, not here and not in the client. See
 * `enforce_seat_limit` in drizzle/0001_rls.sql: a trigger cannot be forgotten
 * by a new code path, bypassed by a bulk import or a direct API call, or
 * defeated by a tampered desktop build. A client-reported "seats remaining" is
 * never authoritative.
 */
export const licenses = pgTable(
  'licenses',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .unique()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    plan: text('plan').notNull().default('starter'),
    seatCount: integer('seat_count').notNull(),

    status: text('status').notNull().default('trial'),

    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    /** Grace window after expiry before access is cut, so a failed card does
     *  not lock a business out of its own accounting records overnight. */
    graceUntil: timestamp('grace_until', { withTimezone: true }),

    /** Stripe subscription reference. Billing happens on the web, never inside
     *  the desktop app — the app consumes a key, it does not take payment. */
    billingRef: text('billing_ref'),

    // --- Stripe ---------------------------------------------------------
    // Both unique where present: one customer and one subscription may back
    // only one tenant, or a mis-routed webhook could point two organizations at
    // the same subscription and bill one of them for the other's seats.
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    /** End of the paid period. Distinct from `validUntil`, which is what access
     *  is judged against — they differ during the grace window. */
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    /** Cancelled but still paid up: full access until the period ends. */
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    check('licenses_seat_count_positive', sql`${t.seatCount} > 0`),
    check(
      'licenses_status',
      sql`${t.status} in ('trial','active','past_due','suspended','cancelled')`,
    ),
  ],
)

/**
 * Keys are `SYNC-XXXXX-XXXXX-XXXXX-XXXXX`, Crockford base32 (no I/L/O/U, so a
 * key can be read aloud to support without ambiguity), with a trailing check
 * character.
 *
 * Stored HASHED, exactly like a password: a database leak must not yield
 * working licences. `keyLast4` exists only so the UI can show which key is
 * which. The check character is the sole thing the client is trusted to
 * evaluate — it lets an obvious typo fail without a round trip. Every real
 * validation is a server lookup.
 */
export const licenseKeys = pgTable(
  'license_keys',
  {
    id: uuid('id').primaryKey(),
    licenseId: uuid('license_id')
      .notNull()
      .references(() => licenses.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    keyHash: text('key_hash').notNull(),
    keyLast4: text('key_last4').notNull(),

    status: text('status').notNull().default('active'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),

    // --- what the key grants, and whether it has been used ---------------
    /** Days of access activating it grants. */
    durationDays: integer('duration_days'),
    /** Seats it grants. Null leaves the licence's count alone. */
    seatCount: integer('seat_count'),
    plan: text('plan'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    activatedBy: uuid('activated_by').references(() => users.id, { onDelete: 'set null' }),
    issuedBy: uuid('issued_by').references(() => users.id, { onDelete: 'set null' }),
    note: text('note'),
    /** A key never activated should not stay redeemable for ever. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    // At most one active key per licence.
    uniqueIndex('license_keys_one_active_uq')
      .on(t.licenseId)
      .where(sql`status = 'active'`),
    index('license_keys_org_idx').on(t.organizationId),
    check('license_keys_status', sql`${t.status} in ('active','revoked','superseded')`),
  ],
)

/** Append-only licensing history. Includes failed validations, which is what
 *  makes tampering visible rather than silent. */
export const licenseEvents = pgTable(
  'license_events',
  {
    id: uuid('id').primaryKey(),
    licenseId: uuid('license_id').references(() => licenses.id, { onDelete: 'set null' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull().default({}),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('license_events_org_idx').on(t.organizationId, t.createdAt)],
)

/**
 * Desktop installs. Lets an admin see and revoke machines.
 *
 * Explicitly NOT authoritative for seats — seats are people, not devices — but
 * buyers of installer-distributed software expect this visibility, and it is
 * how a stolen laptop gets cut off.
 */
export const deviceActivations = pgTable(
  'device_activations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    licenseId: uuid('license_id').references(() => licenses.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),

    deviceFingerprintHash: text('device_fingerprint_hash').notNull(),
    platform: text('platform'),
    appVersion: text('app_version'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('device_activations_org_idx').on(t.organizationId, t.lastSeenAt)],
)
