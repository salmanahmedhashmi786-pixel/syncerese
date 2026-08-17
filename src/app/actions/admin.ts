'use server'

import { revalidatePath } from 'next/cache'
import { and, eq, sql } from 'drizzle-orm'
import { customFieldDefs, workflowRules } from '@/db/schema'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { requirePermission } from '@/server/context'
import { createCustomField } from '@/modules/custom-fields'
import { createRule } from '@/workflow/engine'
import { globalSearch } from '@/modules/search'
import { writeAudit } from '@/lib/audit'
import { AppError } from '@/lib/errors'

type Result = { ok: true; id?: string } | { ok: false; error: string }

const fail = (err: unknown): Result =>
  err instanceof AppError
    ? { ok: false, error: err.message }
    : { ok: false, error: 'Something went wrong.' }

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

export async function addCustomField(input: unknown): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    requirePermission(ctx, 'customfield.manage')
    const handle = await db()
    const actor = { organizationId: ctx.organizationId, userId: ctx.userId }
    const result = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId },
      (tx) => createCustomField(tx, actor, input),
    )
    revalidatePath('/settings')
    return { ok: true, id: result.id }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Archives rather than deletes.
 *
 * The key is immutable and values live under it in every record's jsonb;
 * deleting the definition would leave that data unreachable but still present.
 * Archiving hides the field from forms and keeps the history readable.
 */
export async function archiveCustomField(fieldId: string): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    requirePermission(ctx, 'customfield.manage')
    const handle = await db()
    await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        await tx
          .update(customFieldDefs)
          .set({ archivedAt: new Date() })
          .where(
            and(
              eq(customFieldDefs.id, fieldId),
              eq(customFieldDefs.organizationId, ctx.organizationId),
            ),
          )
        await writeAudit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'custom_field.archived',
          entityType: 'custom_field_def',
          entityId: fieldId,
        })
      },
    )
    revalidatePath('/settings')
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// Workflow rules
// ---------------------------------------------------------------------------

export async function addWorkflowRule(input: unknown): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    requirePermission(ctx, 'workflow.manage')
    const handle = await db()
    const actor = { organizationId: ctx.organizationId, userId: ctx.userId }
    const result = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId },
      (tx) => createRule(tx, actor, input),
    )
    revalidatePath('/settings')
    return { ok: true, id: result.id }
  } catch (err) {
    return fail(err)
  }
}

export async function setRuleActive(ruleId: string, isActive: boolean): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    requirePermission(ctx, 'workflow.manage')
    const handle = await db()
    await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        await tx
          .update(workflowRules)
          .set({ isActive })
          .where(
            and(
              eq(workflowRules.id, ruleId),
              eq(workflowRules.organizationId, ctx.organizationId),
            ),
          )
        await writeAudit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: isActive ? 'workflow_rule.enabled' : 'workflow_rule.disabled',
          entityType: 'workflow_rule',
          entityId: ruleId,
        })
      },
    )
    revalidatePath('/settings')
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

export async function deleteWorkflowRule(ruleId: string): Promise<Result> {
  const { ctx } = await getSession()
  if (!ctx) return { ok: false, error: 'Sign in to continue.' }

  try {
    requirePermission(ctx, 'workflow.manage')
    const handle = await db()
    await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId },
      async (tx) => {
        await writeAudit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'workflow_rule.deleted',
          entityType: 'workflow_rule',
          entityId: ruleId,
        })
        await tx
          .delete(workflowRules)
          .where(
            and(
              eq(workflowRules.id, ruleId),
              eq(workflowRules.organizationId, ctx.organizationId),
            ),
          )
      },
    )
    revalidatePath('/settings')
    return { ok: true }
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// Global search
// ---------------------------------------------------------------------------

/** Permission filtering happens inside globalSearch — each source is skipped
 *  unless the caller can read that module. */
export async function search(query: string) {
  const { ctx } = await getSession()
  if (!ctx) return { query, hits: [], counts: {}, truncated: false }

  const handle = await db()
  return withTenant(handle, { organizationId: ctx.organizationId, userId: ctx.userId }, (tx) =>
    globalSearch(tx, ctx, query),
  )
}

/** Dashboard widget layout, loaded on the server so the first paint already
 *  reflects the user's saved arrangement. */
export async function currentDashboardLayout() {
  const { ctx } = await getSession()
  if (!ctx) return {}
  const handle = await db()
  return withTenant(handle, { organizationId: ctx.organizationId, userId: ctx.userId }, async (tx) => {
    const res = await tx.execute(sql`
      select dashboard_layout from workspace_preferences
       where user_id = ${ctx.userId} and organization_id = ${ctx.organizationId}
       limit 1
    `)
    const rows = (res as unknown as { rows: { dashboard_layout: unknown }[] }).rows
    return (rows[0]?.dashboard_layout ?? {}) as Record<string, unknown>
  })
}
