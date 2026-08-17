import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core'
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import * as schema from './schema'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema, any>
export type TenantTx = PgTransaction<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>
/* eslint-enable @typescript-eslint/no-explicit-any */

export type TenantContext = {
  organizationId: string
  userId?: string | null
  requestId?: string | null
}

/** Role names cannot be passed as bind parameters, so anything interpolated
 *  into `SET LOCAL ROLE` is validated as a plain identifier first. */
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i

/**
 * Runs `fn` inside a transaction scoped to exactly one tenant.
 *
 * THIS IS THE ONLY SANCTIONED WAY TO REACH TENANT DATA. Every API route, server
 * action and background job goes through it. Reaching for the raw `db` handle
 * on a table that carries `organization_id` is a bug, because the RLS policy
 * reads `app.org_id` and will return nothing (or, as a superuser, everything).
 *
 * Two properties make this safe under connection pooling:
 *
 *  - `set_config(..., is_local => true)` scopes the setting to the TRANSACTION,
 *    so a pooled connection cannot carry one tenant's id into the next
 *    request's query. A plain `SET` would leak across requests — this is the
 *    single most dangerous mistake available in a multi-tenant Postgres app.
 *
 *  - `set_config` is a function call and therefore takes bind parameters.
 *    `SET LOCAL app.org_id = $1` is not valid SQL, and building that statement
 *    by string concatenation would be an injection hole on the one value that
 *    decides which tenant's data is visible.
 *
 * `app.user_id` and `app.request_id` are published for triggers and audit
 * writes so the database can attribute changes without the caller passing the
 * actor down through every function signature.
 */
export async function withTenant<T>(
  db: AnyDb,
  ctx: TenantContext,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!ctx.organizationId) {
    throw new Error('withTenant called without an organizationId')
  }

  return db.transaction(async (tx) => {
    // Drop superuser/owner privilege where configured. In production the
    // connection already authenticates as the app role and this is a no-op;
    // in tests it is what stops the superuser bypassing RLS entirely.
    const role = process.env.DB_APP_ROLE
    if (role) {
      if (!IDENT_RE.test(role)) throw new Error(`Invalid DB_APP_ROLE: ${role}`)
      await tx.execute(sql.raw(`set local role ${role}`))
    }

    await tx.execute(sql`select set_config('app.org_id', ${ctx.organizationId}, true)`)
    await tx.execute(sql`select set_config('app.user_id', ${ctx.userId ?? ''}, true)`)
    await tx.execute(sql`select set_config('app.request_id', ${ctx.requestId ?? ''}, true)`)

    return fn(tx as TenantTx)
  })
}

/**
 * For genuinely pre-tenant work: authenticating a user, resolving which
 * organizations they belong to, accepting an invitation.
 *
 * Restricted by convention to the global tables (`users`, `accounts`,
 * `sessions`, `verification_tokens`) — every tenant-scoped table is protected
 * by RLS, so a query issued here against one returns nothing rather than
 * leaking. The name is deliberately unpleasant so it stands out in review.
 */
export async function withoutTenantScope<T>(
  db: AnyDb,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const role = process.env.DB_APP_ROLE
    if (role) {
      if (!IDENT_RE.test(role)) throw new Error(`Invalid DB_APP_ROLE: ${role}`)
      await tx.execute(sql.raw(`set local role ${role}`))
    }
    return fn(tx as TenantTx)
  })
}

/**
 * Runs WITHOUT dropping to the application role, so RLS does not apply.
 *
 * FOR ADMINISTRATIVE SCRIPTS ONLY — seeding, migrations, back-office tooling.
 * It must never be reachable from a request path: there is no tenant scope
 * here, and a query issued through it sees every organization's data.
 *
 * This exists because `withoutTenantScope` is still bound by RLS — it drops the
 * tenant SETTING, not the policy — so even a genuinely pre-tenant lookup like
 * "does an organization with this slug already exist?" returns nothing through
 * it. That silently turned the seed's idempotency check into dead code.
 *
 * Request-path code that needs a pre-tenant lookup uses a narrow SECURITY
 * DEFINER function instead (`user_organizations`, `resolve_api_key`), which
 * exposes exactly one query rather than the whole database.
 */
export async function asPlatformAdmin<T>(
  db: AnyDb,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (process.env.NEXT_RUNTIME) {
    throw new Error('asPlatformAdmin must not be called from a request path')
  }
  return db.transaction(async (tx) => fn(tx as TenantTx))
}
