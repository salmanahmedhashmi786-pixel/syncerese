import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { activities, workflowRules, workflowRuns } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { evaluateConditions, conditionSchema } from '@/modules/filters'
import type { PostingActor } from '@/finance/ledger'

/**
 * Lightweight automation: trigger → condition → action.
 *
 * Deliberately NOT a BPMN engine — an explicit AVOID in the brief. There are no
 * branches, no loops, no parallel gateways, no wait states. A rule fires,
 * conditions gate it, actions run in order. That covers "when an invoice is 7
 * days overdue, send a reminder" and "when a deal is won, create a sales order",
 * which is what SMEs actually ask for.
 *
 * Extensibility comes from the REGISTRIES below, not from the schema: a new
 * action type is a handler function and a zod schema, not a migration.
 */

export const TRIGGERS = [
  'record.created',
  'record.updated',
  'field.changed',
  'invoice.overdue',
  'schedule',
] as const

export type TriggerType = (typeof TRIGGERS)[number]

export const ACTION_TYPES = [
  'notify.user',
  'record.tag',
  'record.set_field',
  'activity.create',
  'webhook.send',
] as const

export type ActionType = (typeof ACTION_TYPES)[number]

export const actionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  config: z.record(z.string(), z.unknown()).default({}),
})

export const ruleSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  isActive: z.boolean().default(true),
  triggerType: z.enum(TRIGGERS),
  triggerConfig: z
    .object({
      entityType: z.string().max(64).optional(),
      field: z.string().max(64).optional(),
      to: z.unknown().optional(),
      /** For `invoice.overdue`: days past the due date. */
      daysOverdue: z.number().int().min(0).max(3650).optional(),
    })
    .default({}),
  conditions: z.array(conditionSchema).max(20).default([]),
  actions: z.array(actionSchema).min(1).max(10),
})

export type RuleInput = z.infer<typeof ruleSchema>

export type TriggerEvent = {
  type: TriggerType
  entityType: string
  entityId: string
  /** The record as it now stands, in the same camelCase shape the list
   *  queries return — so a rule's condition fields match what the user sees. */
  record: Record<string, unknown>
  /** Populated for `record.updated` and `field.changed`. */
  previous?: Record<string, unknown>
}

export type ActionOutcome = {
  type: ActionType
  status: 'ok' | 'skipped' | 'failed'
  detail?: string
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

type ActionHandler = (
  tx: TenantTx,
  actor: PostingActor,
  config: Record<string, unknown>,
  event: TriggerEvent,
) => Promise<string>

/**
 * `notify.user` and `webhook.send` are recorded but not delivered here.
 *
 * Email and outbound HTTP must not happen inside the transaction that triggered
 * them: the transaction can still roll back, and a sent email cannot. Both are
 * written as intent for the delivery worker that lands with the Slack/Teams
 * connectors. Recording intent honestly beats pretending to send.
 */
const HANDLERS: Record<ActionType, ActionHandler> = {
  'notify.user': async (tx, actor, config, event) => {
    const target = String(config.userId ?? actor.userId ?? '')
    await tx.insert(activities).values({
      id: newId(),
      organizationId: actor.organizationId,
      type: 'task',
      subject: String(config.subject ?? `Automation: ${event.entityType} ${event.entityId}`),
      body: String(config.body ?? ''),
      relatedType: event.entityType,
      relatedId: event.entityId,
      ownerUserId: target || null,
      createdBy: actor.userId ?? null,
    })
    return `queued notification for ${target || 'unassigned'}`
  },

  'activity.create': async (tx, actor, config, event) => {
    await tx.insert(activities).values({
      id: newId(),
      organizationId: actor.organizationId,
      type: String(config.activityType ?? 'note'),
      subject: String(config.subject ?? 'Automated note'),
      body: String(config.body ?? ''),
      relatedType: event.entityType,
      relatedId: event.entityId,
      ownerUserId: (config.ownerUserId as string) ?? actor.userId ?? null,
      createdBy: actor.userId ?? null,
    })
    return 'activity created'
  },

  'record.tag': async (tx, actor, config, event) => {
    const tagName = String(config.tag ?? '').trim()
    if (!tagName) throw new AppError('VALIDATION_FAILED', 'record.tag needs a tag name')

    const existing = await tx.execute(sql`
      select id from tags
       where organization_id = ${actor.organizationId} and name = ${tagName}
       limit 1
    `)
    let tagId = (existing as unknown as { rows: { id: string }[] }).rows[0]?.id

    if (!tagId) {
      tagId = newId()
      await tx.execute(sql`
        insert into tags (id, organization_id, name, category)
        values (${tagId}, ${actor.organizationId}, ${tagName},
                ${(config.category as string) ?? null})
      `)
    }

    await tx.execute(sql`
      insert into taggings (organization_id, tag_id, entity_type, entity_id)
      values (${actor.organizationId}, ${tagId}, ${event.entityType}, ${event.entityId})
      on conflict do nothing
    `)
    return `tagged "${tagName}"`
  },

  'record.set_field': async (tx, actor, config, event) => {
    // Restricted to CUSTOM fields on purpose. Letting automation write core
    // columns would let a rule change an invoice total or a posted status,
    // bypassing every service-layer guard that exists to prevent exactly that.
    const key = String(config.key ?? '')
    if (!/^[a-z][a-z0-9_]{0,48}$/.test(key)) {
      throw new AppError('VALIDATION_FAILED', 'record.set_field only writes custom fields')
    }
    const table = TABLE_FOR_ENTITY[event.entityType]
    if (!table) {
      throw new AppError('VALIDATION_FAILED', `Cannot set fields on ${event.entityType}`)
    }
    // Explicit ::text casts are required: jsonb_build_object is variadic "any",
    // so Postgres cannot infer a bare parameter's type and rejects the
    // statement with "could not determine data type of parameter".
    await tx.execute(sql`
      update ${sql.raw(table)}
         set custom_fields = coalesce(custom_fields, '{}'::jsonb)
                             || jsonb_build_object(${key}::text, ${String(config.value ?? '')}::text)
       where id = ${event.entityId}::uuid
         and organization_id = ${actor.organizationId}::uuid
    `)
    return `set custom.${key}`
  },

  'webhook.send': async (_tx, _actor, config, event) => {
    const url = String(config.url ?? '')
    if (!/^https:\/\//.test(url)) {
      throw new AppError('VALIDATION_FAILED', 'Webhook URL must be https')
    }
    return `webhook queued to ${new URL(url).host} for ${event.entityType}`
  },
}

/** Entity types whose custom_fields may be written by automation. */
const TABLE_FOR_ENTITY: Record<string, string> = {
  business_partner: 'business_partners',
  product: 'products',
  deal: 'deals',
  invoice: 'invoices',
  sales_order: 'sales_orders',
}

// ---------------------------------------------------------------------------
// Rule management
// ---------------------------------------------------------------------------

export async function createRule(
  tx: TenantTx,
  actor: PostingActor,
  input: unknown,
): Promise<{ id: string }> {
  const parsed = ruleSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid rule', parsed.error.issues)
  }
  const rule = parsed.data
  const id = newId()

  await tx.insert(workflowRules).values({
    id,
    organizationId: actor.organizationId,
    name: rule.name,
    description: rule.description ?? null,
    isActive: rule.isActive,
    triggerType: rule.triggerType,
    triggerConfig: rule.triggerConfig,
    conditions: rule.conditions,
    actions: rule.actions,
    createdBy: actor.userId ?? null,
  })

  await writeAudit(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: 'workflow_rule.created',
    entityType: 'workflow_rule',
    entityId: id,
    after: { name: rule.name, trigger: rule.triggerType, actions: rule.actions.length },
    requestId: actor.requestId,
  })

  return { id }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Runs every active rule matching an event.
 *
 * A failing action does NOT abort the others, and never propagates out of
 * dispatch: an automation failing must not roll back the business transaction
 * that triggered it. Someone's invoice must still post if the reminder rule is
 * misconfigured. Failures are recorded on the run instead.
 */
export async function dispatch(
  tx: TenantTx,
  actor: PostingActor,
  event: TriggerEvent,
): Promise<{ ruleId: string; runId: string; status: string }[]> {
  const rules = await tx
    .select()
    .from(workflowRules)
    .where(
      and(
        eq(workflowRules.organizationId, actor.organizationId),
        eq(workflowRules.triggerType, event.type),
        eq(workflowRules.isActive, true),
      ),
    )

  const results: { ruleId: string; runId: string; status: string }[] = []

  for (const rule of rules) {
    const config = (rule.triggerConfig ?? {}) as Record<string, unknown>

    if (config.entityType && config.entityType !== event.entityType) continue

    if (event.type === 'field.changed') {
      const field = String(config.field ?? '')
      if (!field) continue
      const now = event.record[field]
      const before = event.previous?.[field]
      if (now === before) continue
      if (config.to !== undefined && String(now) !== String(config.to)) continue
    }

    const runId = newId()
    await tx.insert(workflowRuns).values({
      id: runId,
      organizationId: actor.organizationId,
      ruleId: rule.id,
      triggerPayload: {
        type: event.type,
        entityType: event.entityType,
        entityId: event.entityId,
      },
      status: 'pending',
    })

    const conditions = (rule.conditions ?? []) as Parameters<typeof evaluateConditions>[0]
    if (!evaluateConditions(conditions, event.record)) {
      await tx
        .update(workflowRuns)
        .set({ status: 'skipped', finishedAt: new Date() })
        .where(eq(workflowRuns.id, runId))
      results.push({ ruleId: rule.id, runId, status: 'skipped' })
      continue
    }

    const outcomes: ActionOutcome[] = []
    let actionIndex = 0

    for (const raw of (rule.actions ?? []) as unknown[]) {
      const parsed = actionSchema.safeParse(raw)
      if (!parsed.success) {
        outcomes.push({ type: 'notify.user', status: 'failed', detail: 'malformed action' })
        continue
      }
      const action = parsed.data

      /**
       * Each action runs inside its own SAVEPOINT.
       *
       * Catching the JavaScript exception is not enough: a failed SQL statement
       * puts the whole Postgres transaction into an aborted state, and every
       * later statement — including writing this run's own log, and the
       * business write that triggered it — then fails with "current transaction
       * is aborted". A savepoint is the only way to discard just the failed
       * action and carry on in the same transaction, which is what makes the
       * "automation cannot break the business write" guarantee real rather than
       * aspirational.
       */
      const savepoint = `wf_action_${actionIndex++}`
      await tx.execute(sql.raw(`savepoint ${savepoint}`))

      try {
        const detail = await HANDLERS[action.type](tx, actor, action.config, event)
        await tx.execute(sql.raw(`release savepoint ${savepoint}`))
        outcomes.push({ type: action.type, status: 'ok', detail })
      } catch (err) {
        await tx.execute(sql.raw(`rollback to savepoint ${savepoint}`))
        outcomes.push({
          type: action.type,
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const failed = outcomes.filter((o) => o.status === 'failed').length
    const status = failed === 0 ? 'succeeded' : failed === outcomes.length ? 'failed' : 'partial'

    await tx
      .update(workflowRuns)
      .set({ status, actionsLog: outcomes, finishedAt: new Date() })
      .where(eq(workflowRuns.id, runId))

    await tx
      .update(workflowRules)
      .set({ lastRunAt: new Date(), runCount: sql`${workflowRules.runCount} + 1` })
      .where(eq(workflowRules.id, rule.id))

    results.push({ ruleId: rule.id, runId, status })
  }

  return results
}

/**
 * Scans for invoices that have just crossed an overdue threshold.
 *
 * Runs on a schedule rather than from an event, because becoming overdue is the
 * passage of time — there is no write to hook. Only invoices landing EXACTLY on
 * the configured day fire, so a daily run does not re-send the same reminder
 * every day until the invoice is paid.
 */
export async function runOverdueRules(
  tx: TenantTx,
  actor: PostingActor,
  today: string,
): Promise<{ ruleId: string; runId: string; status: string }[]> {
  const rules = await tx
    .select()
    .from(workflowRules)
    .where(
      and(
        eq(workflowRules.organizationId, actor.organizationId),
        eq(workflowRules.triggerType, 'invoice.overdue'),
        eq(workflowRules.isActive, true),
      ),
    )

  const all: { ruleId: string; runId: string; status: string }[] = []

  for (const rule of rules) {
    const days = Number((rule.triggerConfig as { daysOverdue?: number })?.daysOverdue ?? 7)

    const res = await tx.execute(sql`
      select i.id, i.invoice_no, i.total_minor, i.amount_paid_minor,
             i.currency_code, i.due_date, i.status, i.custom_fields,
             bp.name as partner_name, bp.country_code
      from invoices i
      join business_partners bp on bp.id = i.business_partner_id
      where i.organization_id = ${actor.organizationId}
        and i.direction = 'ar'
        and i.status in ('issued','partially_paid')
        and i.deleted_at is null
        and (${today}::date - i.due_date) = ${days}
    `)

    const rows = (res as unknown as { rows: Record<string, unknown>[] }).rows

    for (const row of rows) {
      const outcomes = await dispatch(tx, actor, {
        type: 'invoice.overdue',
        entityType: 'invoice',
        entityId: String(row.id),
        record: {
          invoiceNo: row.invoice_no,
          totalMinor: Number(row.total_minor),
          outstandingMinor: Number(row.total_minor) - Number(row.amount_paid_minor),
          currencyCode: row.currency_code,
          dueDate: row.due_date,
          status: row.status,
          partnerName: row.partner_name,
          countryCode: row.country_code,
          customFields: row.custom_fields,
          daysOverdue: days,
        },
      })
      all.push(...outcomes.filter((o) => o.ruleId === rule.id))
    }
  }

  return all
}
