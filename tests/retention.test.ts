import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { grantsFor } from '@/auth/permissions'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import {
  RETENTION_CATEGORIES,
  NEVER_EXPIRED,
  REDACTED_BODY,
  retentionOverview,
} from '@/gdpr/retention'
import { ORGS_WITH_RETENTION, setPolicy, sweepRetention } from '@/gdpr/retention-service'
import type { RequestContext } from '@/server/context'
import { createOpsFixture, type OpsFixture } from './helpers/operations'
import { FULL_ACCESS } from '@/billing/access'

const ctxFor = (f: OpsFixture, role: 'owner' | 'readonly' = 'owner'): RequestContext => ({
  userId: f.actor.userId!,
  organizationId: f.orgId,
  membershipId: 'test',
  role,
  permissions: grantsFor(role),
  requestId: null,
  ip: null,
  userAgent: null,
  licence: FULL_ACCESS,
})

/** Far enough in the future that everything seeded is past every cutoff. */
const LATER = new Date('2030-01-01T00:00:00Z')

const count = (f: OpsFixture, table: string) =>
  f.tx(async (tx) => {
    const res = await tx.execute(sql.raw(`select count(*)::int as n from ${table}`))
    return (res as unknown as { rows: { n: number }[] }).rows[0]!.n
  })

/** Switches every category on at its shortest permitted retention — the most
 *  aggressive configuration a customer could possibly ask for. */
async function enableEverythingAtMinimum(f: OpsFixture) {
  for (const c of RETENTION_CATEGORIES) {
    await f.tx((tx) => setPolicy(tx, ctxFor(f), { category: c.key, retainDays: c.minimumDays }))
  }
}

describe('data retention', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  // -------------------------------------------------------------------------
  // The property the whole feature is judged on.
  // -------------------------------------------------------------------------

  it('never removes a statutory record, however aggressively it is configured', async () => {
    await f.tx(async (tx) => {
      const inv = await createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2020-01-01',
        lines: [
          { description: 'Consulting', quantity: 2, unitPriceMinor: 50_000, taxRateId: f.vatRateId },
        ],
      })
      await issueInvoice(tx, f.actor, inv.id)
    })

    // The audit log is checked separately: a sweep legitimately ADDS to it, one
    // row per category, so equality is the wrong assertion there. Everything
    // else must come through untouched.
    const statutory = NEVER_EXPIRED.filter((t) => t !== 'audit_log')

    const before = await Promise.all(statutory.map((t) => count(f, t)))
    const auditBefore = await count(f, 'audit_log')
    expect(before.some((n) => n > 0)).toBe(true) // the test would be vacuous otherwise

    await enableEverythingAtMinimum(f)
    // Ten years on, with every retention at its floor. §147 AO requires these
    // records to still be here; GDPR Art. 17(3)(b) is why that wins.
    await f.tx((tx) => sweepRetention(tx, f.orgId, { now: LATER, force: true }))

    const after = await Promise.all(statutory.map((t) => count(f, t)))
    expect(after).toEqual(before)
    // Never fewer. The append-only trigger would raise rather than delete, but
    // asserting it means a future category that tried would fail here first.
    expect(await count(f, 'audit_log')).toBeGreaterThanOrEqual(auditBefore)
  })

  it('cannot be pointed at a table that is not a category', async () => {
    await expect(
      f.tx((tx) => setPolicy(tx, ctxFor(f), { category: 'invoices', retainDays: 30 })),
    ).rejects.toThrow(/no retention category/i)

    await expect(
      f.tx((tx) => setPolicy(tx, ctxFor(f), { category: 'audit_log', retainDays: 30 })),
    ).rejects.toThrow(/no retention category/i)
  })

  it('lists no statutory table among its categories', () => {
    // The absence is the feature. A future category added carelessly fails here
    // rather than in a customer's ledger.
    const keys = RETENTION_CATEGORIES.map((c) => c.key)
    for (const table of NEVER_EXPIRED) {
      expect(keys, `${table} must never be an expirable category`).not.toContain(table)
    }
  })

  it('leaves the audit log alone even though a sweep writes to it', async () => {
    await enableEverythingAtMinimum(f)
    const before = await count(f, 'audit_log')
    await f.tx((tx) => sweepRetention(tx, f.orgId, { now: LATER, force: true }))
    // A sweep only ever ADDS to the audit log — one row per category swept.
    expect(await count(f, 'audit_log')).toBeGreaterThanOrEqual(before)
  })

  // -------------------------------------------------------------------------
  // Off by default, and the floors.
  // -------------------------------------------------------------------------

  it('touches nothing the customer owns until a category is switched on', async () => {
    const results = await f.tx((tx) => sweepRetention(tx, f.orgId, { now: LATER, force: true }))

    // Exactly one category acts unasked, and it is the event outbox — our own
    // dispatch queue, not the customer's records. Everything they own stays.
    expect(results.map((r) => r.category)).toEqual(['events'])

    const overview = await f.tx((tx) => retentionOverview(tx, ctxFor(f)))
    const defaulted = RETENTION_CATEGORIES.filter((c) => c.defaultDays !== undefined)
    expect(defaulted.map((c) => c.key)).toEqual(['events'])

    for (const view of overview) {
      const isDefaulted = defaulted.some((c) => c.key === view.category)
      expect(view.retainDays === null, view.category).toBe(!isDefaulted)
      expect(view.dueNow === null, view.category).toBe(!isDefaulted)
    }
  })

  it('refuses a retention shorter than the category floor', async () => {
    for (const c of RETENTION_CATEGORIES) {
      await expect(
        f.tx((tx) =>
          setPolicy(tx, ctxFor(f), { category: c.key, retainDays: c.minimumDays - 1 }),
        ),
        c.key,
      ).rejects.toThrow(/at least/i)
    }
  })

  it('ignores a stored policy below the floor rather than honouring it', async () => {
    // A row written before a floor was raised, or by a direct database edit.
    // Validating only on save would mean the job trusts whatever it finds.
    await f.tx((tx) => setPolicy(tx, ctxFor(f), { category: 'access_log', retainDays: 90 }))
    await f.tx((tx) =>
      tx.execute(sql`
        update retention_policies set retain_days = 1
         where organization_id = ${f.orgId} and category = 'access_log'
      `),
    )

    const results = await f.tx((tx) => sweepRetention(tx, f.orgId, { now: LATER, force: true }))
    const accessLog = results.find((r) => r.category === 'access_log')
    expect(accessLog?.removed).toBe(0)
    expect(accessLog?.skipped).toBe('not-configured')
  })

  it('enforces the access-log floor in the database too, not only in TypeScript', async () => {
    // The pruner is reachable by anything holding the app role. A floor that
    // exists only in the application is a floor the next caller forgets.
    await expect(
      f.tx((tx) =>
        tx.execute(sql`select public.prune_access_log(${f.orgId}::uuid, 5::int) as n`),
      ),
    ).rejects.toThrow(/90 days/i)
  })

  // -------------------------------------------------------------------------
  // Legal hold.
  // -------------------------------------------------------------------------

  it('stops a category while a legal hold is on, without unconfiguring it', async () => {
    await f.tx((tx) =>
      setPolicy(tx, ctxFor(f), {
        category: 'access_log',
        retainDays: 90,
        legalHold: true,
        legalHoldNote: 'Tax audit 2026-08',
      }),
    )

    const results = await f.tx((tx) => sweepRetention(tx, f.orgId, { now: LATER, force: true }))
    expect(results.find((r) => r.category === 'access_log')?.skipped).toBe('legal-hold')

    // And the configuration survived the hold, so lifting it resumes.
    const overview = await f.tx((tx) => retentionOverview(tx, ctxFor(f)))
    const view = overview.find((v) => v.category === 'access_log')!
    expect(view.retainDays).toBe(90)
    expect(view.legalHoldNote).toBe('Tax audit 2026-08')
  })

  // -------------------------------------------------------------------------
  // Actually expiring things.
  // -------------------------------------------------------------------------

  it('removes read notifications past their retention and keeps unread ones', async () => {
    await f.tx((tx) =>
      tx.execute(sql`
        insert into notifications (id, organization_id, user_id, type, title, read_at, created_at)
        values
          (gen_random_uuid(), ${f.orgId}, ${f.actor.userId}, 'test', 'old read',
           now() - interval '400 days', now() - interval '400 days'),
          (gen_random_uuid(), ${f.orgId}, ${f.actor.userId}, 'test', 'old unread',
           null, now() - interval '400 days'),
          (gen_random_uuid(), ${f.orgId}, ${f.actor.userId}, 'test', 'recent read',
           now(), now())
      `),
    )

    await f.tx((tx) => setPolicy(tx, ctxFor(f), { category: 'notifications', retainDays: 90 }))
    await f.tx((tx) => sweepRetention(tx, f.orgId, { force: true }))

    const remaining = await f.tx(async (tx) => {
      const res = await tx.execute(sql`select title from notifications order by title`)
      return (res as unknown as { rows: { title: string }[] }).rows.map((r) => r.title)
    })
    // Unread is kept whatever its age: the recipient has not seen it yet.
    expect(remaining).toEqual(['old unread', 'recent read'])
  })

  it('redacts old chat bodies instead of deleting the messages', async () => {
    // drizzle/0011 refuses DELETE on messages outright — they link to financial
    // records and a dangling citation is worse than a redacted one. Retention
    // does what erasure does: the content goes, the skeleton stays.
    const channelId = await f.tx(async (tx) => {
      const res = await tx.execute(sql`
        insert into channels (id, organization_id, name, type, created_by)
        values (gen_random_uuid(), ${f.orgId}, 'finance', 'channel', ${f.actor.userId})
        returning id
      `)
      const id = (res as unknown as { rows: { id: string }[] }).rows[0]!.id
      await tx.execute(sql`
        insert into channel_members (organization_id, channel_id, user_id)
        values (${f.orgId}, ${id}, ${f.actor.userId})
      `)
      await tx.execute(sql`
        insert into messages (id, organization_id, channel_id, user_id, body, created_at)
        values
          (gen_random_uuid(), ${f.orgId}, ${id}, ${f.actor.userId}, 'ancient chatter',
           now() - interval '900 days'),
          (gen_random_uuid(), ${f.orgId}, ${id}, ${f.actor.userId}, 'recent chatter', now())
      `)
      return id
    })
    expect(channelId).toBeTruthy()

    await f.tx((tx) => setPolicy(tx, ctxFor(f), { category: 'chat_messages', retainDays: 730 }))
    await f.tx((tx) => sweepRetention(tx, f.orgId, { force: true }))

    const bodies = await f.tx(async (tx) => {
      const res = await tx.execute(sql`select body from messages order by created_at`)
      return (res as unknown as { rows: { body: string }[] }).rows.map((r) => r.body)
    })
    // Two rows still, one redacted. Nothing deleted.
    expect(bodies).toEqual([REDACTED_BODY, 'recent chatter'])

    // And a second sweep finds nothing left to do, rather than re-reporting the
    // same rows for ever.
    await f.tx((tx) => sweepRetention(tx, f.orgId, { force: true }))
    const overview = await f.tx((tx) => retentionOverview(tx, ctxFor(f)))
    expect(overview.find((v) => v.category === 'chat_messages')?.dueNow).toBe(0)
  })

  it('previews what would go without removing it', async () => {
    await f.tx((tx) =>
      tx.execute(sql`
        insert into notifications (id, organization_id, user_id, type, title, read_at, created_at)
        values (gen_random_uuid(), ${f.orgId}, ${f.actor.userId}, 'test', 'old',
                now() - interval '400 days', now() - interval '400 days')
      `),
    )
    await f.tx((tx) => setPolicy(tx, ctxFor(f), { category: 'notifications', retainDays: 90 }))

    const overview = await f.tx((tx) => retentionOverview(tx, ctxFor(f)))
    expect(overview.find((v) => v.category === 'notifications')?.dueNow).toBe(1)
    // Preview does not delete.
    expect(await count(f, 'notifications')).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Pacing, permissions and isolation.
  // -------------------------------------------------------------------------

  it('sweeps a category at most once a day', async () => {
    await f.tx((tx) => setPolicy(tx, ctxFor(f), { category: 'notifications', retainDays: 90 }))
    await f.tx((tx) => sweepRetention(tx, f.orgId, {}))

    const second = await f.tx((tx) => sweepRetention(tx, f.orgId, {}))
    expect(second.find((r) => r.category === 'notifications')?.skipped).toBe(
      'already-swept-today',
    )
  })

  it('will not let a role without gdpr.manage change a policy', async () => {
    await expect(
      f.tx((tx) =>
        setPolicy(tx, ctxFor(f, 'readonly'), { category: 'notifications', retainDays: 90 }),
      ),
    ).rejects.toThrow()
  })

  it('does not sweep another tenant\'s data', async () => {
    const other = await createOpsFixture()
    try {
      await other.tx((tx) =>
        tx.execute(sql`
          insert into notifications (id, organization_id, user_id, type, title, read_at, created_at)
          values (gen_random_uuid(), ${other.orgId}, ${other.actor.userId}, 'test', 'theirs',
                  now() - interval '400 days', now() - interval '400 days')
        `),
      )

      await f.tx((tx) => setPolicy(tx, ctxFor(f), { category: 'notifications', retainDays: 90 }))
      await f.tx((tx) => sweepRetention(tx, f.orgId, { force: true }))

      expect(await count(other, 'notifications')).toBe(1)
    } finally {
      await other.t.close()
    }
  })

  it('records every sweep, including the ones that removed nothing', async () => {
    // "Ran and found nothing" and "never ran" look identical otherwise, and the
    // second is the compliance failure.
    await f.tx((tx) => setPolicy(tx, ctxFor(f), { category: 'notifications', retainDays: 90 }))
    await f.tx((tx) => sweepRetention(tx, f.orgId, { force: true }))

    const swept = await f.tx(async (tx) => {
      const res = await tx.execute(sql`
        select after from audit_log
         where organization_id = ${f.orgId} and action = 'retention.swept'
      `)
      return (res as unknown as { rows: { after: { removed: number } }[] }).rows
    })
    // Two: the category just configured, and the defaulted event outbox.
    expect(swept).toHaveLength(2)
    expect(swept.every((row) => row.after.removed === 0)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The event outbox.
//
// The one category that acts without being configured, and the only table with
// an append-only trigger that retention is allowed to reach through at all.
// Both of those deserve more than a "does it delete rows" test.
// ---------------------------------------------------------------------------

describe('event outbox pruning', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  /**
   * An event that happened in the past.
   *
   * Inserted with its timestamp rather than emitted and then aged, because the
   * append-only trigger refuses to let `occurred_at` move — which is the whole
   * point of it, and is asserted below. INSERT is the only way in.
   */
  const oldEvent = async (opts: { days: number; dispatched: boolean }) =>
    f.tx(async (tx) => {
      const res = await tx.execute(sql`
        insert into events (id, organization_id, type, entity_type, occurred_at, dispatched_at)
        values (gen_random_uuid(), ${f.orgId}, 'invoice.issued', 'invoice',
                now() - make_interval(days => ${opts.days}),
                ${opts.dispatched ? sql`now()` : sql`null`})
        returning id
      `)
      return (res as unknown as { rows: { id: string }[] }).rows[0]!.id
    })

  const eventCount = () =>
    f.tx(async (tx) => {
      const res = await tx.execute(sql`select count(*)::int as n from events`)
      return (res as unknown as { rows: { n: number }[] }).rows[0]!.n
    })

  const prune = (days = 90) =>
    f.tx(async (tx) => {
      const res = await tx.execute(
        sql`select public.prune_outbox_events(${f.orgId}::uuid, ${days}::int) as n`,
      )
      return (res as unknown as { rows: { n: number }[] }).rows[0]!.n
    })

  it('removes dispatched events past the cutoff and nothing else', async () => {
    const stale = await oldEvent({ days: 200, dispatched: true })
    const recent = await oldEvent({ days: 3, dispatched: true })
    const undelivered = await oldEvent({ days: 200, dispatched: false })

    expect(await prune()).toBe(1)

    const left = await f.tx(async (tx) => {
      const res = await tx.execute(sql`select id from events`)
      return (res as unknown as { rows: { id: string }[] }).rows.map((r) => r.id)
    })
    expect(left).toContain(recent)
    // An event the fan-out has not processed is still owed to somebody's
    // endpoint, however old it is. Age is not the same as finished.
    expect(left).toContain(undelivered)
    expect(left).not.toContain(stale)
  })

  it('keeps an event a webhook is still owed', async () => {
    // webhook_deliveries.event_id cascades, so pruning an event with a retry
    // outstanding would silently drop that retry: the customer's endpoint never
    // hears about it and nothing anywhere records a failure.
    const id = await oldEvent({ days: 200, dispatched: true })
    const endpointId = await f.tx(async (tx) => {
      const res = await tx.execute(sql`
        insert into webhook_endpoints (id, organization_id, url, secret_hash, secret_prefix)
        values (gen_random_uuid(), ${f.orgId}, 'https://hooks.example.test/x', 'h', 'sk_')
        returning id
      `)
      return (res as unknown as { rows: { id: string }[] }).rows[0]!.id
    })

    for (const status of ['pending', 'failed'] as const) {
      await f.tx((tx) =>
        tx.execute(sql`
          insert into webhook_deliveries (id, organization_id, endpoint_id, event_id, status)
          values (gen_random_uuid(), ${f.orgId}, ${endpointId}, ${id}, ${status})
          on conflict (endpoint_id, event_id) do update set status = excluded.status
        `),
      )
      expect(await prune(), status).toBe(0)
      expect(await eventCount()).toBe(1)
    }

    // Once the delivery reaches a terminal state the event may go, and the
    // delivery row goes with it — they are the same generation of operational
    // data, and a delivery whose event has gone refers to nothing.
    await f.tx((tx) => tx.execute(sql`update webhook_deliveries set status = 'succeeded'`))
    expect(await prune()).toBe(1)
    expect(await eventCount()).toBe(0)
  })

  it('keeps events an enabled chat integration has not read yet', async () => {
    // Slack and Teams delivery reads forward through this table. Deleting rows
    // in front of a cursor makes those messages vanish without ever being sent
    // — no error, no retry, just silence in the customer's channel.
    const id = await oldEvent({ days: 200, dispatched: true })
    await f.tx((tx) =>
      tx.execute(sql`
        insert into chat_integrations
          (id, organization_id, kind, name, target_url_encrypted, url_hint, enabled)
        values (gen_random_uuid(), ${f.orgId}, 'slack', '#finance', 'enc', 'hooks.slack.com', true)
      `),
    )
    expect(await prune()).toBe(0)

    // Read past it, and it may go.
    await f.tx((tx) =>
      tx.execute(sql`
        update chat_integrations
           set cursor_at = (select occurred_at from events where id = ${id}),
               cursor_event_id = ${id}
      `),
    )
    expect(await prune()).toBe(1)
  })

  it('ignores the cursor of a disabled integration', async () => {
    // Otherwise switching an integration off, which customers do, would quietly
    // pin the outbox at its size on that day for ever.
    await oldEvent({ days: 200, dispatched: true })
    await f.tx((tx) =>
      tx.execute(sql`
        insert into chat_integrations
          (id, organization_id, kind, name, target_url_encrypted, url_hint, enabled)
        values (gen_random_uuid(), ${f.orgId}, 'teams', 'Ops', 'enc', 'webhook.office.com', false)
      `),
    )
    expect(await prune()).toBe(1)
  })

  // Two independent barriers stop an event being deleted outside the prune
  // function, and they are asserted SEPARATELY on purpose. A single test that
  // accepts either error passes when one of them is gone — which is what
  // happened when this was written the obvious way: opening the trigger
  // completely still left the test green, because the missing grant was doing
  // all the work.

  it('gives the application role no way to delete an event', async () => {
    await expect(f.tx((tx) => tx.execute(sql`delete from events`))).rejects.toThrow(
      /permission denied/i,
    )

    const grants = await f.t.db.execute(sql`
      select count(*)::int as n from information_schema.role_table_grants
       where table_name = 'events' and grantee = 'syncrese_app' and privilege_type = 'DELETE'
    `)
    expect((grants as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0)
  })

  it('refuses a delete from a role that does have the grant', async () => {
    // The trigger, on its own, with the grant out of the picture — f.t.db is
    // the superuser handle. This is the barrier drizzle/0024 actually modified,
    // and the only way to see it work is to remove the other one.
    await oldEvent({ days: 200, dispatched: true })
    await expect(f.t.db.execute(sql`delete from events`)).rejects.toThrow(/SYNC_APPEND_ONLY/i)
    expect(await eventCount()).toBe(1)
  })

  it('does not leave the flag set for the rest of the transaction', async () => {
    // Transaction-local, so a caller that goes on to do other work in the same
    // transaction must not inherit the ability to delete events. Run as the
    // superuser for the same reason as above: otherwise the grant answers first
    // and the flag is never tested at all.
    await oldEvent({ days: 200, dispatched: true })
    const survivor = await oldEvent({ days: 3, dispatched: true })

    await expect(
      f.t.db.transaction(async (tx) => {
        await tx.execute(sql`select public.prune_outbox_events(${f.orgId}::uuid, 90::int)`)
        await tx.execute(sql`delete from events where id = ${survivor}`)
      }),
    ).rejects.toThrow(/SYNC_APPEND_ONLY/i)
  })

  it('still refuses to rewrite an event', async () => {
    const id = await oldEvent({ days: 1, dispatched: false })
    await expect(
      f.tx((tx) => tx.execute(sql`update events set payload = '{"x":1}' where id = ${id}`)),
    ).rejects.toThrow(/cannot be rewritten/i)
  })

  it('enforces the seven-day floor in the database, not only in TypeScript', async () => {
    // This function is reachable by anything holding the app role, and a limit
    // that lives only in the application is one the next caller forgets. Below
    // a week, an endpoint down over a long weekend loses its backlog.
    await expect(prune(6)).rejects.toThrow(/shorter than 7 days/i)
  })

  it('previews exactly what the sweep would remove', async () => {
    await oldEvent({ days: 200, dispatched: true })
    await oldEvent({ days: 200, dispatched: false })

    const preview = await f.tx(async (tx) => {
      const res = await tx.execute(
        sql`select public.count_prunable_events(${f.orgId}::uuid, 90::int) as n`,
      )
      return (res as unknown as { rows: { n: number }[] }).rows[0]!.n
    })
    expect(preview).toBe(1)
    // Preview did not delete, and agrees with the sweep. They share a predicate
    // precisely so an admin cannot be shown one number and get another.
    expect(await eventCount()).toBe(2)
    expect(await prune()).toBe(preview)
  })

  it('runs from the daily sweep with nothing configured', async () => {
    await oldEvent({ days: 200, dispatched: true })
    const results = await f.tx((tx) => sweepRetention(tx, f.orgId, { force: true }))

    expect(results.find((r) => r.category === 'events')?.removed).toBe(1)
    expect(await eventCount()).toBe(0)
  })

  it('reaches a workspace that has configured nothing at all', async () => {
    // The job iterates the organizations this query returns. Left as "tenants
    // with a policy row" the default would never run for a workspace that had
    // configured nothing — which is every workspace on day one, and precisely
    // the case the default exists for.
    await oldEvent({ days: 200, dispatched: true })

    const orgs = await f.t.db.execute(ORGS_WITH_RETENTION)
    const ids = (orgs as unknown as { rows: { id: string }[] }).rows.map((r) => r.id)
    expect(ids).toContain(f.orgId)

    const policies = await f.t.db.execute(
      sql`select count(*)::int as n from retention_policies where organization_id = ${f.orgId}`,
    )
    expect((policies as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0)
  })

  it('stops for a legal hold like every other category', async () => {
    await oldEvent({ days: 200, dispatched: true })
    await f.tx((tx) =>
      setPolicy(tx, ctxFor(f), { category: 'events', retainDays: 90, legalHold: true }),
    )

    const results = await f.tx((tx) => sweepRetention(tx, f.orgId, { force: true }))
    expect(results.find((r) => r.category === 'events')?.skipped).toBe('legal-hold')
    expect(await eventCount()).toBe(1)
  })

  it('lets a tenant switch the default off entirely', async () => {
    // A stored row wins over the default, including one whose retain_days is
    // NULL. Otherwise a customer who wants their outbox kept has no way to say
    // so, which would make the default a policy rather than a default.
    await oldEvent({ days: 200, dispatched: true })
    await f.tx((tx) => setPolicy(tx, ctxFor(f), { category: 'events', retainDays: null }))

    const results = await f.tx((tx) => sweepRetention(tx, f.orgId, { force: true }))
    expect(results.find((r) => r.category === 'events')?.skipped).toBe('not-configured')
    expect(await eventCount()).toBe(1)
  })

  it('does not reach into another tenant outbox', async () => {
    await oldEvent({ days: 200, dispatched: true })
    const other = await createOpsFixture()
    try {
      await other.tx((tx) =>
        tx.execute(sql`
          insert into events (id, organization_id, type, entity_type, occurred_at, dispatched_at)
          values (gen_random_uuid(), ${other.orgId}, 'invoice.issued', 'invoice',
                  now() - interval '200 days', now())
        `),
      )

      expect(await prune()).toBe(1)
      const left = await other.tx(async (tx) => {
        const res = await tx.execute(sql`select count(*)::int as n from events`)
        return (res as unknown as { rows: { n: number }[] }).rows[0]!.n
      })
      expect(left).toBe(1)
    } finally {
      await other.t.close()
    }
  })
})
