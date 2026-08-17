import { sql } from 'drizzle-orm'
import type { TenantTx } from '@/db/tenant'
import type { RequestContext } from '@/server/context'

/**
 * What data retention is allowed to expire (MUST DO #15, GDPR Art. 5(1)(e)).
 *
 * A CLOSED LIST, for the same reason the assistant's retrieval catalogue is
 * one: the alternative is a table name and a cutoff in a configuration row,
 * and the failure mode of that is a customer's ledger being deleted by a
 * feature they enabled to be compliant.
 *
 * WHAT IS NOT HERE, AND WILL NOT BE
 *
 * Invoices, journal entries, payments, partners, products — every record with
 * statutory accounting retention behind it. §147 AO requires ten years in
 * Germany and each EU member state has an equivalent; GDPR Art. 17(3)(b)
 * exempts exactly this processing from erasure. Deleting them to satisfy
 * storage limitation would put the customer in breach of accounting law to
 * comply with privacy law, which is not a trade this software gets to make on
 * their behalf.
 *
 * The audit log is not here either, and additionally cannot be reached: it
 * carries a BEFORE UPDATE OR DELETE trigger that raises unconditionally, so
 * even a bug in this file fails loudly rather than quietly. Personal data in
 * the audit trail is handled by erasure's PSEUDONYMISATION instead — the
 * sequence of events survives, the person in it does not.
 *
 * EVERY CATEGORY HOLDING THE CUSTOMER'S DATA IS OFF BY DEFAULT
 *
 * `retain_days` is NULL until somebody sets it. A retention job that starts
 * deleting a customer's records on the day it ships is a data-loss incident
 * wearing a compliance label.
 *
 * The event outbox is the single exception, and the reasoning is different in
 * kind rather than a weaker version of the same one — it is OUR dispatch queue,
 * not their records. See `defaultDays` below.
 */

export type RetentionCategory = {
  key: string
  label: string
  /** What this actually removes, in the words of somebody deciding whether to
   *  switch it on. */
  description: string
  /**
   * The shortest retention this category will accept.
   *
   * Not a nag. Each of these exists because deleting sooner breaks something
   * concrete, and the reason is written next to the number.
   */
  minimumDays: number
  /** What a cautious controller might choose, shown as a hint. */
  suggestedDays: number
  /**
   * A retention that applies when no policy row exists.
   *
   * Almost every category leaves this undefined and therefore ships OFF, because
   * deleting a customer's records without being asked is a data-loss incident
   * wearing a compliance label. The event outbox is the exception and the
   * reasoning is different in kind: it is OUR queue, not the customer's records,
   * its payloads are already redacted, and every business fact it refers to
   * lives in the invoice or order it describes. Nobody configures how long a
   * log rotation keeps its files either.
   *
   * A tenant can still override it, extend it, or stop it with a legal hold.
   */
  defaultDays?: number
  /** Counts what WOULD go, without removing it. Preview is not optional: an
   *  admin should see the number before, not after. */
  count: (tx: TenantTx, organizationId: string, days: number) => Promise<number>
  /** Removes it, returning how many rows went. */
  sweep: (tx: TenantTx, organizationId: string, days: number) => Promise<number>
}

const countOf = async (tx: TenantTx, query: ReturnType<typeof sql>): Promise<number> => {
  const res = await tx.execute(query)
  return Number((res as unknown as { rows: { n: number | string }[] }).rows[0]?.n ?? 0)
}

const deletedBy = async (tx: TenantTx, query: ReturnType<typeof sql>): Promise<number> => {
  const res = await tx.execute(query)
  return (res as unknown as { rows: unknown[] }).rows.length
}

// ---------------------------------------------------------------------------

const accessLog: RetentionCategory = {
  key: 'access_log',
  label: 'Access records',
  description:
    'Who viewed or exported which records. Kept for breach reconstruction, not ' +
    'for accounting — no statutory period applies, so it is the clearest case ' +
    'for storage limitation.',
  // Art. 33 gives 72 hours to REPORT a breach, but reconstructing one routinely
  // reaches back further, and an access trail already pruned cannot answer the
  // question the regulator actually asks.
  minimumDays: 90,
  suggestedDays: 365,
  count: (tx, organizationId, days) =>
    countOf(
      tx,
      sql`select count(*)::int as n from access_log
           where organization_id = ${organizationId}
             and occurred_at < now() - make_interval(days => ${days})`,
    ),
  sweep: async (tx, organizationId, days) => {
    // Through the SECURITY DEFINER function: the application role has SELECT
    // and INSERT on this table and nothing else, which is what makes "the
    // application cannot quietly erase the access trail" true. See 0021.
    const res = await tx.execute(
      sql`select public.prune_access_log(${organizationId}::uuid, ${days}::int) as n`,
    )
    return Number((res as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0)
  },
}

/** What an expired message body is replaced with. */
export const REDACTED_BODY = '[removed under this workspace’s retention policy]'

const chatMessages: RetentionCategory = {
  key: 'chat_messages',
  label: 'Team chat content',
  description:
    'The text of channel and direct messages. The messages themselves stay, ' +
    'with their author and timestamp, so anything that cites them still reads ' +
    'coherently — it is the content that goes.',
  // Short enough to be useful, long enough that "what did we agree about that
  // order" still has an answer through a quarter-end.
  minimumDays: 30,
  suggestedDays: 730,
  count: (tx, organizationId, days) => countOf(tx, expiredMessages(organizationId, days, true)),
  sweep: (tx, organizationId, days) =>
    deletedBy(tx, expiredMessages(organizationId, days, false)),
}

/**
 * Message bodies past their retention.
 *
 * REDACTED, not deleted, and not by preference: drizzle/0011 puts a trigger on
 * `messages` that refuses DELETE outright — "messages are soft-deleted, not
 * removed" — because they link to financial records and a dangling citation is
 * worse than a redacted one. The application role has no DELETE grant either.
 *
 * So this does what erasure already does to the same table: replaces the body
 * and leaves the skeleton. The personal data goes; the conversation stays
 * citeable. Bodies already redacted are excluded, or every sweep would report
 * the same rows again for ever.
 */
function expiredMessages(organizationId: string, days: number, counting: boolean) {
  const where = sql`
     where organization_id = ${organizationId}
       and created_at < now() - make_interval(days => ${days})
       and body <> ${REDACTED_BODY}
  `
  return counting
    ? sql`select count(*)::int as n from messages ${where}`
    : sql`update messages set body = ${REDACTED_BODY} ${where} returning id`
}

const assistantHistory: RetentionCategory = {
  key: 'assistant_conversations',
  label: 'Assistant conversations',
  description:
    'Questions asked of the assistant and the answers given, including which ' +
    'lookups ran. Deleting these removes the record of what the assistant was ' +
    'asked, so keep them at least as long as you would want to answer that.',
  minimumDays: 30,
  suggestedDays: 365,
  count: (tx, organizationId, days) =>
    countOf(
      tx,
      sql`select count(*)::int as n from assistant_conversations
           where organization_id = ${organizationId}
             and created_at < now() - make_interval(days => ${days})`,
    ),
  sweep: (tx, organizationId, days) =>
    deletedBy(
      tx,
      sql`delete from assistant_conversations
           where organization_id = ${organizationId}
             and created_at < now() - make_interval(days => ${days})
           returning id`,
    ),
}

const notifications: RetentionCategory = {
  key: 'notifications',
  label: 'Read notifications',
  description: 'In-app notifications the recipient has already read.',
  minimumDays: 7,
  suggestedDays: 90,
  count: (tx, organizationId, days) =>
    countOf(
      tx,
      sql`select count(*)::int as n from notifications
           where organization_id = ${organizationId}
             and read_at is not null
             and created_at < now() - make_interval(days => ${days})`,
    ),
  sweep: (tx, organizationId, days) =>
    deletedBy(
      tx,
      sql`delete from notifications
           where organization_id = ${organizationId}
             and read_at is not null
             and created_at < now() - make_interval(days => ${days})
           returning id`,
    ),
}

const webhookDeliveries: RetentionCategory = {
  key: 'webhook_deliveries',
  label: 'Webhook delivery attempts',
  description:
    'Per-attempt delivery records for outbound webhooks, once they have ' +
    'succeeded or been abandoned. Operational, and the largest table in most ' +
    'busy workspaces.',
  minimumDays: 7,
  suggestedDays: 30,
  count: (tx, organizationId, days) =>
    countOf(
      tx,
      sql`select count(*)::int as n from webhook_deliveries
           where organization_id = ${organizationId}
             and status in ('succeeded', 'abandoned')
             and created_at < now() - make_interval(days => ${days})`,
    ),
  sweep: (tx, organizationId, days) =>
    // Only terminal ones. Deleting a pending delivery would silently drop a
    // customer's webhook rather than expire a record of one.
    deletedBy(
      tx,
      sql`delete from webhook_deliveries
           where organization_id = ${organizationId}
             and status in ('succeeded', 'abandoned')
             and created_at < now() - make_interval(days => ${days})
           returning id`,
    ),
}

const outboxEvents: RetentionCategory = {
  key: 'events',
  label: 'Event outbox',
  description:
    'The internal record that a business event happened and was dispatched — not ' +
    'the invoice or order itself, which is untouched. Removed only once every ' +
    'webhook delivery has finished and every chat integration has read past it.',
  // Seven days is the floor the database enforces too. Below that a webhook
  // endpoint that has been down over a long weekend loses its backlog.
  minimumDays: 7,
  suggestedDays: 90,
  // The one category with a default — see `defaultDays` above.
  defaultDays: 90,
  count: async (tx, organizationId, days) =>
    Number(
      (
        (await tx.execute(
          sql`select public.count_prunable_events(${organizationId}::uuid, ${days}::int) as n`,
        )) as unknown as { rows: { n: number }[] }
      ).rows[0]?.n ?? 0,
    ),
  sweep: async (tx, organizationId, days) =>
    Number(
      (
        (await tx.execute(
          sql`select public.prune_outbox_events(${organizationId}::uuid, ${days}::int) as n`,
        )) as unknown as { rows: { n: number }[] }
      ).rows[0]?.n ?? 0,
    ),
}

/**
 * HOW THE OUTBOX IS PRUNED, GIVEN THAT IT IS APPEND-ONLY.
 *
 * `events` carries a BEFORE UPDATE OR DELETE trigger (drizzle/0009) refusing
 * everything except a change to `dispatched_at`, and it binds the OWNER, not
 * merely the application role. That immutability is deliberate and is NOT
 * loosened: drizzle/0024 adds exactly one exception, a transaction-local flag
 * that only `prune_outbox_events()` sets. The application role still has no
 * DELETE grant, so both barriers would have to fail together, and UPDATE is
 * untouched — an event still cannot be rewritten.
 *
 * The three conditions on what may go are in that migration, and each one is a
 * way a customer silently loses a webhook or a Slack message without them.
 */

// ---------------------------------------------------------------------------

export const RETENTION_CATEGORIES: readonly RetentionCategory[] = [
  accessLog,
  chatMessages,
  assistantHistory,
  notifications,
  webhookDeliveries,
  outboxEvents,
]

export const categoryByKey = (key: string): RetentionCategory | undefined =>
  RETENTION_CATEGORIES.find((c) => c.key === key)

/**
 * Tables this feature must never write to.
 *
 * Listed so a test can assert it, because "we did not include invoices" is a
 * claim about the absence of code, and the only way to keep an absence true is
 * to check for it.
 */
export const NEVER_EXPIRED = [
  'invoices',
  'invoice_lines',
  'journal_entries',
  'journal_lines',
  'payments',
  'payment_allocations',
  'business_partners',
  'products',
  'audit_log',
] as const

// ---------------------------------------------------------------------------

export type PolicyView = {
  category: string
  label: string
  description: string
  retainDays: number | null
  minimumDays: number
  suggestedDays: number
  legalHold: boolean
  legalHoldNote: string | null
  lastSweptAt: string | null
  lastRemoved: number | null
  /** How many rows would go if a sweep ran now. Null when the category is off,
   *  because there is no cutoff to count against. */
  dueNow: number | null
  /** True when `retainDays` comes from the category default rather than
   *  anything this tenant chose. The panel says so, because a number nobody set
   *  looking exactly like one somebody set is a small lie. */
  isDefault: boolean
}

/** Every category with its policy, and a live preview for the ones that are on. */
export async function retentionOverview(
  tx: TenantTx,
  ctx: RequestContext,
): Promise<PolicyView[]> {
  const res = await tx.execute(sql`
    select category, retain_days as "retainDays", legal_hold as "legalHold",
           legal_hold_note as "legalHoldNote", last_swept_at as "lastSweptAt",
           last_removed as "lastRemoved"
      from retention_policies
     where organization_id = ${ctx.organizationId}
  `)
  const stored = new Map(
    (
      res as unknown as {
        rows: {
          category: string
          retainDays: number | null
          legalHold: boolean
          legalHoldNote: string | null
          lastSweptAt: string | null
          lastRemoved: number | null
        }[]
      }
    ).rows.map((r) => [r.category, r]),
  )

  const views: PolicyView[] = []
  for (const category of RETENTION_CATEGORIES) {
    const policy = stored.get(category.key)
    // A stored row wins, including a stored NULL — turning a defaulted category
    // off has to be possible, so "no row" and "row with NULL" mean different
    // things here.
    const retainDays = policy ? policy.retainDays : (category.defaultDays ?? null)
    views.push({
      category: category.key,
      label: category.label,
      description: category.description,
      retainDays,
      minimumDays: category.minimumDays,
      suggestedDays: category.suggestedDays,
      legalHold: policy?.legalHold ?? false,
      legalHoldNote: policy?.legalHoldNote ?? null,
      lastSweptAt: policy?.lastSweptAt ?? null,
      lastRemoved: policy?.lastRemoved ?? null,
      isDefault: !policy && category.defaultDays !== undefined,
      dueNow:
        retainDays === null
          ? null
          : await category.count(tx, ctx.organizationId, retainDays),
    })
  }
  return views
}
