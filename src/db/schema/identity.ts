import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'

/**
 * Users are GLOBAL, not tenant-scoped. This is deliberate and load-bearing:
 * MUST DO #1 requires one user to belong to several organizations, which is the
 * normal case for SME accountants and consultants. Tenant scoping happens on
 * `memberships`, not here.
 *
 * Because this table has no `organization_id`, it is exempt from the RLS
 * tenant policy — and the CI guard in tests/rls-coverage.test.ts enforces that
 * the exemption is explicit rather than accidental.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),

    /** Stored already-lowercased. `citext` is avoided so the schema carries no
     *  extension dependency (it is unavailable on some managed Postgres); the
     *  check constraint enforces normalisation at the database, not by
     *  convention. */
    email: text('email').notNull().unique(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),

    /** argon2id. Null for SSO-only accounts. Never a plaintext secret. */
    passwordHash: text('password_hash'),

    name: text('name'),
    avatarUrl: text('avatar_url'),

    // MFA — strongly recommended for Owner/Admin per MUST DO #18.
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    mfaEnabledAt: timestamp('mfa_enabled_at', { withTimezone: true }),
    mfaRecoveryCodesHashed: jsonb('mfa_recovery_codes_hashed'),
    /** Last TOTP counter accepted. A code is valid for up to 90 seconds once
     *  skew is allowed for; remembering the counter makes each one single-use. */
    mfaLastCounter: bigint('mfa_last_counter', { mode: 'number' }),

    // Brute-force control lives in the database so it holds across app
    // instances, unlike an in-memory rate limiter.
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /**
     * When the password last changed. Sessions are JWTs and cannot be deleted
     * server-side, so the auth callback refuses any token issued before this —
     * without it, a reset after a compromise leaves the attacker signed in for
     * the remaining life of their token. See drizzle/0023.
     */
    credentialsChangedAt: timestamp('credentials_changed_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),

    status: text('status').notNull().default('active'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
    check('users_status', sql`${t.status} in ('active','deactivated')`),
  ],
)

/**
 * Roles. `organizationId` null means a built-in system role shared by every
 * tenant. Org-defined custom roles fit this shape but are not exposed in v1.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('roles_org_key_uq').on(t.organizationId, t.key)],
)

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
})

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
)

/**
 * user x organization. THIS TABLE IS THE SEAT COUNTER — its count of
 * status='active' rows is the licensing source of truth (MUST DO #16), enforced
 * by the `enforce_seat_limit` trigger in drizzle/0001_rls.sql.
 *
 * Offboarding sets status='deactivated'. Rows are never hard-deleted: the user
 * keeps authorship of every historical record and audit entry, and the seat is
 * freed.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),

    status: text('status').notNull().default('active'),

    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    deactivatedBy: uuid('deactivated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    unique('memberships_org_user_uq').on(t.organizationId, t.userId),
    index('memberships_seat_idx').on(t.organizationId, t.status),
    check('memberships_status', sql`${t.status} in ('active','invited','deactivated')`),
  ],
)

/**
 * Seat availability is checked when an invite is SENT and again when it is
 * ACCEPTED, because seats can fill in between.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invitations_org_idx').on(t.organizationId),
    check('invitations_email_lowercase', sql`${t.email} = lower(${t.email})`),
  ],
)

// ---------------------------------------------------------------------------
// Auth.js adapter tables. Global like `users` — see the exemption note above.
// ---------------------------------------------------------------------------

/**
 * Auth.js OAuth account links.
 *
 * Named `auth_accounts`, NOT the adapter's default `accounts` — that name
 * belongs to the chart of accounts in a finance product, and two tables cannot
 * share it. The DrizzleAdapter takes an explicit table map, so this costs
 * nothing and avoids a collision that would otherwise surface as a confusing
 * migration failure.
 */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refreshToken: text('refresh_token'),
    accessToken: text('access_token'),
    expiresAt: integer('expires_at'),
    tokenType: text('token_type'),
    scope: text('scope'),
    idToken: text('id_token'),
    sessionState: text('session_state'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
)

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
})

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
)

// ---------------------------------------------------------------------------
// Preferences — persisted per user account server-side, NOT localStorage, so
// they follow the user across the desktop app and the web (MUST DO #17).
// ---------------------------------------------------------------------------

/** Appearance follows the person everywhere they work. */
export const userPreferences = pgTable(
  'user_preferences',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    theme: text('theme').notNull().default('light'),
    accent: text('accent').notNull().default('syncrese'),
    density: text('density').notNull().default('compact'),
    fontScale: real('font_scale').notNull().default(1),
    sidebarCollapsed: boolean('sidebar_collapsed').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('user_preferences_theme', sql`${t.theme} in ('light','dark')`),
    check('user_preferences_density', sql`${t.density} in ('compact','comfortable','relaxed')`),
    check('user_preferences_font_scale', sql`${t.fontScale} between 0.85 and 1.30`),
  ],
)

/**
 * Structural layout is per (user, organization) rather than per user: an
 * accountant's column setup for Client A must not overwrite Client B's.
 */
export const workspacePreferences = pgTable(
  'workspace_preferences',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    columnVisibility: jsonb('column_visibility').notNull().default({}),
    dashboardLayout: jsonb('dashboard_layout').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.organizationId] })],
)

/**
 * Password reset tokens (drizzle/0023).
 *
 * Hashed, single-use, one hour. A reset token grants account takeover, so it is
 * treated like every other bearer credential here: the database holds a
 * peppered hash and never the token itself.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** Hashed: an address tied to a named person is personal data, and this
     *  table has no need to hold one in the clear. */
    requestedIpHash: text('requested_ip_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('password_reset_tokens_user_idx').on(t.userId, t.createdAt)],
)
