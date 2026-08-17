import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { TenantTx } from '@/db/tenant'
import { type RequestContext, requirePermission } from '@/server/context'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { categoryByKey, RETENTION_CATEGORIES } from './retention'

/**
 * Setting and running retention policies.
 *
 * Storage limitation (GDPR Art. 5(1)(e)) is the only part of the GDPR tooling
 * here that acts without anybody asking, which makes it the only part that can
 * destroy data by working correctly. Everything below is shaped by that:
 *
 *   - every category is OFF until deliberately switched on;
 *   - a floor per category that cannot be configured away;
 *   - a legal hold that stops a category without unconfiguring it;
 *   - every change and every sweep is audited, with counts;
 *   - the sweep runs at most once a day per category, so a misconfigured cron
 *     costs nothing.
 */

export const policySchema = z.object({
  category: z.string().min(1),
  /** Null switches the category off. */
  retainDays: z.number().int().min(1).max(36_500).nullable(),
  legalHold: z.boolean().optional(),
  legalHoldNote: z.string().trim().max(500).optional(),
})

export async function setPolicy(
  tx: TenantTx,
  ctx: RequestContext,
  input: unknown,
): Promise<void> {
  requirePermission(ctx, 'gdpr.manage')

  const parsed = policySchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid retention policy', parsed.error.issues)
  }
  const { category, retainDays, legalHold, legalHoldNote } = parsed.data

  const definition = categoryByKey(category)
  if (!definition) {
    // The category has to exist in the catalogue. A policy row naming something
    // else would be inert, which is worse than an error: the customer would
    // believe a retention period was in force.
    throw new AppError('VALIDATION_FAILED', `There is no retention category "${category}".`)
  }

  if (retainDays !== null && retainDays < definition.minimumDays) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${definition.label} must be kept for at least ${definition.minimumDays} days. ` +
        `Shorter than that and the records stop being able to answer the question they exist for.`,
    )
  }

  await tx.execute(sql`
    insert into retention_policies
      (id, organization_id, category, retain_days, legal_hold, legal_hold_note, updated_by)
    values (${newId()}, ${ctx.organizationId}, ${category}, ${retainDays},
            ${legalHold ?? false}, ${legalHoldNote ?? null}, ${ctx.userId})
    on conflict (organization_id, category) do update
      set retain_days = excluded.retain_days,
          legal_hold = excluded.legal_hold,
          legal_hold_note = excluded.legal_hold_note,
          updated_at = now(),
          updated_by = excluded.updated_by
  `)

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'retention_policy.updated',
    entityType: 'retention_policy',
    entityId: category,
    after: { retainDays, legalHold: legalHold ?? false },
    requestId: ctx.requestId,
  })
}

export type SweepResult = {
  category: string
  removed: number
  /** Why nothing happened, when nothing happened. Distinguishing "off" from
   *  "on hold" from "already run today" from "nothing was old enough" is the
   *  difference between a usable panel and a mystery. */
  skipped?: 'not-configured' | 'legal-hold' | 'already-swept-today'
}

/** How often a category may be swept. Calling the endpoint more often than this
 *  is harmless rather than expensive, which matters because Vercel's Hobby plan
 *  only offers daily crons and everyone else will point a pinger at it. */
const SWEEP_INTERVAL_HOURS = 20

/**
 * Applies every configured policy for one organization.
 *
 * `now` is injectable so the tests can age data past a cutoff without waiting.
 */
export async function sweepRetention(
  tx: TenantTx,
  organizationId: string,
  opts: { now?: Date; force?: boolean; actorUserId?: string | null } = {},
): Promise<SweepResult[]> {
  const now = opts.now ?? new Date()

  const res = await tx.execute(sql`
    select category, retain_days as "retainDays", legal_hold as "legalHold",
           last_swept_at as "lastSweptAt"
      from retention_policies
     where organization_id = ${organizationId}
  `)
  const stored = (
    res as unknown as {
      rows: {
        category: string
        retainDays: number | null
        legalHold: boolean
        lastSweptAt: string | Date | null
      }[]
    }
  ).rows

  // Categories with a `defaultDays` and no stored row are swept at their
  // default. Only the event outbox has one, and only because it is our queue
  // rather than the customer's records — see the note on `defaultDays`.
  //
  // A stored row always wins, including one whose `retain_days` is NULL, so
  // switching a defaulted category off remains possible.
  const configured = new Set(stored.map((p) => p.category))
  const policies = [
    ...stored,
    ...RETENTION_CATEGORIES.filter(
      (c) => c.defaultDays !== undefined && !configured.has(c.key),
    ).map((c) => ({
      category: c.key,
      retainDays: c.defaultDays!,
      legalHold: false,
      lastSweptAt: null as string | Date | null,
    })),
  ]

  const results: SweepResult[] = []

  for (const policy of policies) {
    const definition = categoryByKey(policy.category)
    // A policy row for a category that no longer exists — a downgrade, or a
    // hand-edited row. Ignored rather than guessed at.
    if (!definition) continue

    if (policy.retainDays === null) {
      results.push({ category: policy.category, removed: 0, skipped: 'not-configured' })
      continue
    }

    if (policy.legalHold) {
      results.push({ category: policy.category, removed: 0, skipped: 'legal-hold' })
      continue
    }

    if (!opts.force && policy.lastSweptAt) {
      const last = new Date(policy.lastSweptAt).getTime()
      if (now.getTime() - last < SWEEP_INTERVAL_HOURS * 3_600_000) {
        results.push({ category: policy.category, removed: 0, skipped: 'already-swept-today' })
        continue
      }
    }

    // Re-checked at the point of deletion, not only when the policy was saved.
    // A row written before a floor was raised, or by a direct database edit,
    // must not be honoured just because it is stored.
    if (policy.retainDays < definition.minimumDays) {
      results.push({ category: policy.category, removed: 0, skipped: 'not-configured' })
      continue
    }

    const removed = await definition.sweep(tx, organizationId, policy.retainDays)

    // Upsert rather than update: a defaulted category may have no row yet, and
    // without one there is nowhere to record that it ran — which would make it
    // sweep on every tick instead of daily.
    await tx.execute(sql`
      insert into retention_policies
        (id, organization_id, category, retain_days, last_swept_at, last_removed)
      values (${newId()}, ${organizationId}, ${policy.category}, ${policy.retainDays},
              ${now.toISOString()}, ${removed})
      on conflict (organization_id, category) do update
        set last_swept_at = excluded.last_swept_at,
            last_removed = excluded.last_removed
    `)

    // Audited even when it removed nothing. "The job ran and found nothing" and
    // "the job never ran" look identical from the outside otherwise, and the
    // second one is a compliance failure.
    await writeAudit(tx, {
      organizationId,
      actorUserId: opts.actorUserId ?? null,
      action: 'retention.swept',
      entityType: 'retention_policy',
      entityId: policy.category,
      after: { removed, retainDays: policy.retainDays },
      requestId: null,
    })

    results.push({ category: policy.category, removed })
  }

  return results
}

/**
 * Organizations the daily sweep has work for.
 *
 * Any tenant with a live policy — and, because the event outbox has a default,
 * any tenant with events at all. Restricting this to `retention_policies` would
 * mean the defaulted category never ran for a workspace that had configured
 * nothing, which is every workspace on day one and exactly the case the default
 * exists for.
 */
export const ORGS_WITH_RETENTION = sql`
  select distinct id from (
    select organization_id as id from retention_policies
     where retain_days is not null and not legal_hold
    union
    -- EXISTS per organization, not DISTINCT over every event. The outbox is the
    -- largest table in a busy workspace and this runs before any pruning has
    -- happened, so the naive form scans exactly the table the job exists to
    -- keep small. This probes events_org_type_idx once per tenant instead.
    select o.id from organizations o
     where exists (select 1 from events e where e.organization_id = o.id)
  ) t
`

export const categoryKeys = (): string[] => RETENTION_CATEGORIES.map((c) => c.key)
