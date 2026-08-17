import { cache } from 'react'
import { cookies, headers } from 'next/headers'
import { eq, sql } from 'drizzle-orm'
import { auth } from '@/auth'
import { db } from '@/db'
import { userPreferences, workspacePreferences } from '@/db/schema'
import { withoutTenantScope, withTenant, type TenantTx } from '@/db/tenant'
import { resolveContext, type RequestContext } from './context'
import { DEFAULT_ACCENT, FONT_SCALE, type AccentKey, type Density } from '@/lib/theme'

export const ACTIVE_ORG_COOKIE = 'syncrese_org'

export type Preferences = {
  theme: 'light' | 'dark'
  accent: AccentKey
  density: Density
  fontScale: number
  sidebarCollapsed: boolean
  columnVisibility: Record<string, Record<string, boolean>>
  dashboardLayout: { order?: string[]; hidden?: Record<string, boolean>; wide?: Record<string, boolean> }
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'light',
  accent: DEFAULT_ACCENT,
  density: 'compact',
  fontScale: FONT_SCALE.default,
  sidebarCollapsed: false,
  columnVisibility: {},
  dashboardLayout: {},
}

/**
 * Resolves the caller and their active organization for one request.
 *
 * `cache()` dedupes this across every server component in a single render —
 * the layout, the header and the page all need it, and without deduping each
 * would issue its own membership query.
 *
 * The active organization comes from a cookie but is NEVER trusted: it is only
 * a hint about which membership to look up, and `resolveContext` re-verifies
 * that an active membership actually exists. A user editing that cookie to
 * another tenant's id gets null, not access.
 */
export const getSession = cache(
  async (): Promise<{ ctx: RequestContext | null; organizations: OrgSummary[] }> => {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) return { ctx: null, organizations: [] }

    const organizations = await listOrganizations(userId)
    if (organizations.length === 0) return { ctx: null, organizations: [] }

    const jar = await cookies()
    const requested = jar.get(ACTIVE_ORG_COOKIE)?.value
    const active =
      organizations.find((o) => o.organizationId === requested) ?? organizations[0]!

    const h = await headers()
    const handle = await db()

    const ctx = await resolveContext(handle, {
      userId,
      organizationId: active.organizationId,
      requestId: h.get('x-request-id'),
      ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: h.get('user-agent'),
    })

    return { ctx, organizations }
  },
)

export type OrgSummary = {
  organizationId: string
  organizationName: string
  organizationSlug: string
  roleKey: string
}

/**
 * Which organizations this user belongs to.
 *
 * Goes through the `user_organizations` SECURITY DEFINER function rather than a
 * direct query: listing memberships is genuinely pre-tenant (there is no
 * app.org_id yet), and that one small reviewed bypass is preferable to
 * loosening the RLS policies on organizations and memberships.
 */
async function listOrganizations(userId: string): Promise<OrgSummary[]> {
  const handle = await db()
  return withoutTenantScope(handle, async (tx) => {
    const res = await tx.execute(
      sql`select * from public.user_organizations(${userId}::uuid)`,
    )
    const rows = (res as unknown as { rows: Record<string, string>[] }).rows
    return rows.map((r) => ({
      organizationId: r.organization_id!,
      organizationName: r.organization_name!,
      organizationSlug: r.organization_slug!,
      roleKey: r.role_key!,
    }))
  })
}

/** Preferences for the current user, merged over the defaults. Appearance is
 *  per user; layout is per (user, organization). */
export const getPreferences = cache(async (): Promise<Preferences> => {
  const { ctx } = await getSession()
  if (!ctx) return DEFAULT_PREFERENCES

  const handle = await db()

  const appearance = await withoutTenantScope(handle, async (tx) => {
    const rows = await tx
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, ctx.userId))
      .limit(1)
    return rows[0]
  })

  const workspace = await withTenant(
    handle,
    { organizationId: ctx.organizationId, userId: ctx.userId },
    async (tx) => {
      const rows = await tx
        .select()
        .from(workspacePreferences)
        .where(eq(workspacePreferences.userId, ctx.userId))
        .limit(1)
      return rows[0]
    },
  )

  return {
    theme: (appearance?.theme as 'light' | 'dark') ?? DEFAULT_PREFERENCES.theme,
    accent: (appearance?.accent as AccentKey) ?? DEFAULT_PREFERENCES.accent,
    density: (appearance?.density as Density) ?? DEFAULT_PREFERENCES.density,
    fontScale: appearance?.fontScale ?? DEFAULT_PREFERENCES.fontScale,
    sidebarCollapsed: appearance?.sidebarCollapsed ?? DEFAULT_PREFERENCES.sidebarCollapsed,
    columnVisibility:
      (workspace?.columnVisibility as Preferences['columnVisibility']) ?? {},
    dashboardLayout: (workspace?.dashboardLayout as Preferences['dashboardLayout']) ?? {},
  }
})

/** Runs `fn` scoped to the caller's active tenant. Throws if unauthenticated —
 *  pages must check `getSession()` and redirect before calling this. */
export async function tenantQuery<T>(fn: (tx: TenantTx, ctx: RequestContext) => Promise<T>): Promise<T> {
  const { ctx } = await getSession()
  if (!ctx) throw new Error('tenantQuery called without an authenticated context')
  const handle = await db()
  return withTenant(
    handle,
    { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
    (tx) => fn(tx, ctx),
  )
}
