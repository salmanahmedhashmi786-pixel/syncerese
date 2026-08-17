import { sql } from 'drizzle-orm'
import type { AnyDb, TenantTx } from '@/db/tenant'
import { withoutTenantScope, withTenant } from '@/db/tenant'
import { AppError, forbidden, unauthenticated } from '@/lib/errors'
import { grantsFor, type Permission, type RoleKey, ROLE_KEYS } from '@/auth/permissions'
import { licenceAccess, permittedWhileReadOnly, type LicenceAccess } from '@/billing/access'

/**
 * Who is asking, on behalf of which tenant, with what rights.
 *
 * Built once per request from the session and re-verified against the database
 * — never trusted from a client-supplied header or a JWT claim the client could
 * edit. The organization id in particular decides which tenant's data RLS will
 * expose, so it is resolved from a membership row every time.
 */
export type RequestContext = {
  userId: string
  organizationId: string
  membershipId: string
  role: RoleKey
  permissions: ReadonlySet<Permission>
  requestId: string | null
  ip: string | null
  userAgent: string | null
  /**
   * What the tenant's licence permits right now.
   *
   * Resolved once per request alongside the membership, so `requirePermission`
   * can gate writes without every call site remembering to ask.
   */
  licence: LicenceAccess
}

const isRoleKey = (v: string): v is RoleKey => (ROLE_KEYS as readonly string[]).includes(v)

/**
 * Resolves the caller's membership of the requested organization.
 *
 * Returns null when there is no ACTIVE membership — which covers the deactivated
 * ex-employee and the user who simply is not in this tenant. Both must be
 * indistinguishable from the caller's point of view: telling an outsider that an
 * organization exists but they lack access is itself a disclosure.
 */
export async function resolveContext(
  db: AnyDb,
  input: {
    userId: string | null | undefined
    organizationId: string
    requestId?: string | null
    ip?: string | null
    userAgent?: string | null
  },
): Promise<RequestContext | null> {
  if (!input.userId) return null

  // Goes through the `user_organizations` SECURITY DEFINER function rather than
  // querying `memberships` directly.
  //
  // This lookup is genuinely PRE-tenant: there is no app.org_id established
  // yet, which is exactly what we are trying to determine. A direct query would
  // be filtered by RLS to zero rows and every sign-in would fail — the function
  // is the one small, reviewed bypass that exists for this case, and it returns
  // only the caller's own memberships.
  const row = await withoutTenantScope(db, async (tx) => {
    const res = await tx.execute(
      sql`select role_key, membership_id
            from public.user_organizations(${input.userId}::uuid)
           where organization_id = ${input.organizationId}::uuid
           limit 1`,
    )
    const rows = (res as unknown as { rows: { role_key: string; membership_id: string }[] }).rows
    return rows[0] ?? null
  })

  if (!row || !isRoleKey(row.role_key)) return null

  // The licence, read once per request. Tenant-scoped, so it comes AFTER the
  // membership check has established which organization this is.
  const licence = await licenceFor(db, input.organizationId, input.userId)

  return {
    userId: input.userId,
    organizationId: input.organizationId,
    membershipId: row.membership_id,
    role: row.role_key,
    permissions: grantsFor(row.role_key),
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    licence,
  }
}

async function licenceFor(
  db: AnyDb,
  organizationId: string,
  userId: string,
): Promise<LicenceAccess> {
  const res = await withTenant(db, { organizationId, userId }, (tx) =>
    tx.execute(sql`
      select status, valid_until, grace_until from licenses
      where organization_id = ${organizationId} limit 1
    `),
  )
  const row = (
    res as unknown as {
      rows: { status: string; valid_until: string | null; grace_until: string | null }[]
    }
  ).rows[0]

  return licenceAccess(
    row ? { status: row.status, validUntil: row.valid_until, graceUntil: row.grace_until } : null,
  )
}

export function requireContext(ctx: RequestContext | null): RequestContext {
  if (!ctx) throw unauthenticated()
  return ctx
}

/**
 * The server-side permission gate. Every mutation calls this.
 *
 * MUST DO #2: "permissions should be enforced server-side on every mutation,
 * not just hidden in the UI."
 */
export function requirePermission(
  ctx: RequestContext | null,
  permission: Permission,
): RequestContext {
  const c = requireContext(ctx)
  if (!c.permissions.has(permission)) {
    throw forbidden(`Your role (${c.role}) cannot perform this action.`)
  }

  // The licence gate, HERE rather than at each write site.
  //
  // Every mutation in this codebase already funnels through this function —
  // that is the existing discipline for RBAC — so hanging the licence check off
  // it means a write path physically cannot forget it. A `requireWritable()`
  // that each service had to remember to call would be missed within a month.
  //
  // Reads always pass. So do the few writes that must keep working when a
  // tenant is read-only, or read-only becomes a trap the customer cannot pay
  // their way out of (see billing/access.ts).
  if (!c.licence.canWrite && !permittedWhileReadOnly(permission)) {
    throw new AppError('LICENSE_INVALID', c.licence.reason ?? 'This workspace is read-only.')
  }

  return c
}

export function can(ctx: RequestContext | null, permission: Permission): boolean {
  return !!ctx && ctx.permissions.has(permission)
}

/** Convenience: the audit fields every entry wants, taken from the context so
 *  callers cannot forget the actor. */
export function auditFieldsFrom(ctx: RequestContext) {
  return {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorType: 'user' as const,
    requestId: ctx.requestId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  }
}

export type { TenantTx }
