import { sql } from 'drizzle-orm'
import type { AnyDb } from '@/db/tenant'
import { withoutTenantScope } from '@/db/tenant'
import { forbidden } from '@/lib/errors'

/**
 * Platform administration — the VENDOR's view, not a tenant's.
 *
 * Issuing a product key means acting across tenants: listing every organization
 * in order to pick one. That is not a tenant capability, and it must not be
 * reachable from a tenant session however carefully this application checks.
 *
 * So the check is in the DATABASE. Every function below passes the caller's
 * user id to a SECURITY DEFINER function that returns nothing unless that user
 * is in `platform_admins`. If a future refactor forgets to gate the admin page,
 * the queries simply answer empty rather than leaking every customer's name.
 *
 * Membership is granted from the command line only — `npm run admin:grant`.
 * A platform admin who could appoint another through a browser would be one
 * XSS away from a compromise of every tenant on the installation.
 */

export type PlatformOrganization = {
  organizationId: string
  name: string
  slug: string
  plan: string | null
  status: string | null
  seatCount: number | null
  validUntil: string | null
  seatsInUse: number
}

export type PlatformKey = {
  keyId: string
  organizationId: string
  organizationName: string
  keyLast4: string
  status: string
  plan: string | null
  durationDays: number | null
  seatCount: number | null
  issuedAt: string
  expiresAt: string | null
  activatedAt: string | null
  revokedAt: string | null
  note: string | null
}

export async function isPlatformAdmin(db: AnyDb, userId: string | null): Promise<boolean> {
  if (!userId) return false
  const res = await withoutTenantScope(db, (tx) =>
    tx.execute(sql`select public.is_platform_admin(${userId}::uuid) as ok`),
  )
  return (res as unknown as { rows: { ok: boolean }[] }).rows[0]?.ok ?? false
}

export async function assertPlatformAdmin(db: AnyDb, userId: string | null): Promise<void> {
  if (!(await isPlatformAdmin(db, userId))) {
    // Deliberately the same message a signed-in tenant user would get from any
    // other refusal. Confirming that a platform admin area exists is itself
    // information.
    throw forbidden('You do not have permission to do that.')
  }
}

export async function listOrganizations(
  db: AnyDb,
  userId: string,
): Promise<PlatformOrganization[]> {
  const res = await withoutTenantScope(db, (tx) =>
    tx.execute(sql`select * from public.platform_organizations(${userId}::uuid)`),
  )
  const rows = (
    res as unknown as {
      rows: {
        organization_id: string
        name: string
        slug: string
        plan: string | null
        status: string | null
        seat_count: number | null
        valid_until: string | Date | null
        seats_in_use: number
      }[]
    }
  ).rows

  return rows.map((r) => ({
    organizationId: r.organization_id,
    name: r.name,
    slug: r.slug,
    plan: r.plan,
    status: r.status,
    seatCount: r.seat_count,
    validUntil: r.valid_until ? new Date(r.valid_until).toISOString() : null,
    seatsInUse: r.seats_in_use,
  }))
}

export async function listKeys(db: AnyDb, userId: string): Promise<PlatformKey[]> {
  const res = await withoutTenantScope(db, (tx) =>
    tx.execute(sql`select * from public.platform_license_keys(${userId}::uuid)`),
  )
  const rows = (
    res as unknown as {
      rows: {
        key_id: string
        organization_id: string
        organization_name: string
        key_last4: string
        status: string
        plan: string | null
        duration_days: number | null
        seat_count: number | null
        issued_at: string | Date
        expires_at: string | Date | null
        activated_at: string | Date | null
        revoked_at: string | Date | null
        note: string | null
      }[]
    }
  ).rows

  const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null)

  return rows.map((r) => ({
    keyId: r.key_id,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    keyLast4: r.key_last4,
    status: r.status,
    plan: r.plan,
    durationDays: r.duration_days,
    seatCount: r.seat_count,
    issuedAt: iso(r.issued_at)!,
    expiresAt: iso(r.expires_at),
    activatedAt: iso(r.activated_at),
    revokedAt: iso(r.revoked_at),
    note: r.note,
  }))
}
