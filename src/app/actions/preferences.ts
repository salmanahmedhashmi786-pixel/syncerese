'use server'

import { z } from 'zod'
import { db } from '@/db'
import { userPreferences, workspacePreferences } from '@/db/schema'
import { withoutTenantScope, withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { FONT_SCALE } from '@/lib/theme'

/**
 * Appearance preferences.
 *
 * Validated with zod even though the only caller is our own UI: a server
 * action is a public HTTP endpoint, and "the client wouldn't send that" is not
 * an access control (MUST DO #18 — input validation on every route).
 */
const appearanceSchema = z.object({
  theme: z.enum(['light', 'dark']).optional(),
  accent: z.enum(['syncrese', 'blue', 'indigo', 'teal', 'violet', 'amber', 'graphite']).optional(),
  density: z.enum(['compact', 'comfortable', 'relaxed']).optional(),
  fontScale: z.number().min(FONT_SCALE.min).max(FONT_SCALE.max).optional(),
  sidebarCollapsed: z.boolean().optional(),
})

export async function savePreferences(input: unknown): Promise<{ ok: boolean }> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false }

  const parsed = appearanceSchema.safeParse(input)
  if (!parsed.success || Object.keys(parsed.data).length === 0) return { ok: false }

  const handle = await db()
  await withoutTenantScope(handle, async (tx) => {
    await tx
      .insert(userPreferences)
      .values({ userId: ctx.userId, ...parsed.data })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { ...parsed.data, updatedAt: new Date() },
      })
  })

  return { ok: true }
}

const layoutSchema = z.object({
  columnVisibility: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
  dashboardLayout: z
    .object({
      order: z.array(z.string()).optional(),
      hidden: z.record(z.string(), z.boolean()).optional(),
      wide: z.record(z.string(), z.boolean()).optional(),
    })
    .optional(),
})

/**
 * Structural layout, stored per (user, organization).
 *
 * Deliberately separate from appearance: an accountant's column setup for
 * Client A must not overwrite their setup for Client B.
 */
export async function saveWorkspacePreferences(input: unknown): Promise<{ ok: boolean }> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false }

  const parsed = layoutSchema.safeParse(input)
  if (!parsed.success || Object.keys(parsed.data).length === 0) return { ok: false }

  const handle = await db()
  await withTenant(
    handle,
    { organizationId: ctx.organizationId, userId: ctx.userId },
    async (tx) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() }
      if (parsed.data.columnVisibility) patch.columnVisibility = parsed.data.columnVisibility
      if (parsed.data.dashboardLayout) patch.dashboardLayout = parsed.data.dashboardLayout

      await tx
        .insert(workspacePreferences)
        .values({
          userId: ctx.userId,
          organizationId: ctx.organizationId,
          columnVisibility: parsed.data.columnVisibility ?? {},
          dashboardLayout: parsed.data.dashboardLayout ?? {},
        })
        .onConflictDoUpdate({
          target: [workspacePreferences.userId, workspacePreferences.organizationId],
          set: patch,
        })
    },
  )

  return { ok: true }
}
