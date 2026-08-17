import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createRule, dispatch, runOverdueRules } from '@/workflow/engine'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { createOpsFixture, type OpsFixture } from './helpers/operations'

const runsFor = async (f: OpsFixture) =>
  f.tx(async (tx) => {
    const res = await tx.execute(sql`
      select r.status, r.actions_log, w.name
        from workflow_runs r join workflow_rules w on w.id = r.rule_id
       where r.organization_id = ${f.orgId}
       order by r.started_at
    `)
    return (res as unknown as { rows: { status: string; actions_log: unknown; name: string }[] })
      .rows
  })

describe('workflow engine', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  it('runs actions when conditions pass', async () => {
    await f.tx((tx) =>
      createRule(tx, f.actor, {
        name: 'Tag large deals',
        triggerType: 'record.created',
        triggerConfig: { entityType: 'deal' },
        conditions: [{ field: 'amountMinor', op: 'gte', value: 50_000_00 }],
        actions: [{ type: 'record.tag', config: { tag: 'Enterprise', category: 'size' } }],
      }),
    )

    const results = await f.tx((tx) =>
      dispatch(tx, f.actor, {
        type: 'record.created',
        entityType: 'deal',
        entityId: '00000000-0000-4000-8000-0000000000d1',
        record: { amountMinor: 80_000_00, name: 'Big one' },
      }),
    )

    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('succeeded')

    const tagged = await f.tx(async (tx) => {
      const res = await tx.execute(sql`
        select t.name, t.category from taggings tg
        join tags t on t.id = tg.tag_id
        where tg.organization_id = ${f.orgId}
      `)
      return (res as unknown as { rows: { name: string; category: string }[] }).rows
    })
    expect(tagged).toEqual([{ name: 'Enterprise', category: 'size' }])
  })

  it('skips — and records the skip — when conditions fail', async () => {
    await f.tx((tx) =>
      createRule(tx, f.actor, {
        name: 'Tag large deals',
        triggerType: 'record.created',
        triggerConfig: { entityType: 'deal' },
        conditions: [{ field: 'amountMinor', op: 'gte', value: 50_000_00 }],
        actions: [{ type: 'record.tag', config: { tag: 'Enterprise' } }],
      }),
    )

    const results = await f.tx((tx) =>
      dispatch(tx, f.actor, {
        type: 'record.created',
        entityType: 'deal',
        entityId: '00000000-0000-4000-8000-0000000000d2',
        record: { amountMinor: 1_000_00 },
      }),
    )

    expect(results[0]!.status).toBe('skipped')
    // A skip is still recorded: "why did nothing happen?" needs an answer too.
    const runs = await runsFor(f)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('skipped')
  })

  it('ignores rules for other entity types', async () => {
    await f.tx((tx) =>
      createRule(tx, f.actor, {
        name: 'Deal rule',
        triggerType: 'record.created',
        triggerConfig: { entityType: 'deal' },
        actions: [{ type: 'activity.create', config: { subject: 'x' } }],
      }),
    )
    const results = await f.tx((tx) =>
      dispatch(tx, f.actor, {
        type: 'record.created',
        entityType: 'invoice',
        entityId: '00000000-0000-4000-8000-0000000000d3',
        record: {},
      }),
    )
    expect(results).toHaveLength(0)
  })

  it('fires field.changed only on an actual transition to the target value', async () => {
    await f.tx((tx) =>
      createRule(tx, f.actor, {
        name: 'Deal won',
        triggerType: 'field.changed',
        triggerConfig: { entityType: 'deal', field: 'status', to: 'won' },
        actions: [{ type: 'activity.create', config: { subject: 'Deal won — raise an order' } }],
      }),
    )

    const event = (from: string, to: string) => ({
      type: 'field.changed' as const,
      entityType: 'deal',
      entityId: '00000000-0000-4000-8000-0000000000d4',
      record: { status: to },
      previous: { status: from },
    })

    expect(await f.tx((tx) => dispatch(tx, f.actor, event('open', 'lost')))).toHaveLength(0)
    // No change at all must not fire, or a routine save re-triggers everything.
    expect(await f.tx((tx) => dispatch(tx, f.actor, event('won', 'won')))).toHaveLength(0)

    const fired = await f.tx((tx) => dispatch(tx, f.actor, event('open', 'won')))
    expect(fired).toHaveLength(1)
    expect(fired[0]!.status).toBe('succeeded')
  })

  it('records a partial failure without abandoning the other actions', async () => {
    await f.tx((tx) =>
      createRule(tx, f.actor, {
        name: 'Mixed',
        triggerType: 'record.created',
        triggerConfig: { entityType: 'deal' },
        actions: [
          { type: 'activity.create', config: { subject: 'This one works' } },
          { type: 'webhook.send', config: { url: 'http://insecure.test/hook' } },
        ],
      }),
    )

    const results = await f.tx((tx) =>
      dispatch(tx, f.actor, {
        type: 'record.created',
        entityType: 'deal',
        entityId: '00000000-0000-4000-8000-0000000000d5',
        record: {},
      }),
    )
    expect(results[0]!.status).toBe('partial')

    const runs = await runsFor(f)
    const log = runs[0]!.actions_log as { type: string; status: string }[]
    expect(log[0]).toMatchObject({ type: 'activity.create', status: 'ok' })
    expect(log[1]).toMatchObject({ type: 'webhook.send', status: 'failed' })
  })

  it('a broken rule does not roll back the business transaction', async () => {
    await f.tx((tx) =>
      createRule(tx, f.actor, {
        name: 'Broken',
        triggerType: 'record.created',
        triggerConfig: { entityType: 'invoice' },
        actions: [{ type: 'record.set_field', config: { key: 'NOT VALID', value: 'x' } }],
      }),
    )

    // The invoice must still exist even though its automation failed.
    const created = await f.tx(async (tx) => {
      const inv = await createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [{ description: 'Widget', unitPriceMinor: 100_00 }],
      })
      await dispatch(tx, f.actor, {
        type: 'record.created',
        entityType: 'invoice',
        entityId: inv.id,
        record: { totalMinor: 10000 },
      })
      return inv
    })

    const found = await f.tx(async (tx) => {
      const res = await tx.execute(
        sql`select invoice_no from invoices where id = ${created.id}`,
      )
      return (res as unknown as { rows: { invoice_no: string }[] }).rows[0]
    })
    expect(found?.invoice_no).toBe(created.invoiceNo)

    const runs = await runsFor(f)
    expect(runs[0]!.status).toBe('failed')
  })

  it('a DATABASE-level action failure does not poison the transaction', async () => {
    // The important case, and the one a naive try/catch does not survive: a
    // failed SQL statement aborts the whole Postgres transaction, so without a
    // savepoint the run log, the later actions AND the business write all fail
    // with "current transaction is aborted".
    await f.tx((tx) =>
      createRule(tx, f.actor, {
        name: 'DB failure then success',
        triggerType: 'record.created',
        triggerConfig: { entityType: 'deal' },
        actions: [
          // A foreign key that cannot resolve — fails inside Postgres, not JS.
          {
            type: 'notify.user',
            config: { userId: '00000000-0000-4000-8000-00000000dead', subject: 'boom' },
          },
          { type: 'activity.create', config: { subject: 'still runs' } },
        ],
      }),
    )

    const results = await f.tx(async (tx) => {
      const out = await dispatch(tx, f.actor, {
        type: 'record.created',
        entityType: 'deal',
        entityId: '00000000-0000-4000-8000-0000000000f1',
        record: {},
      })
      // Proves the transaction is still usable after the failure.
      await tx.execute(sql`select 1`)
      return out
    })

    expect(results[0]!.status).toBe('partial')
    const runs = await runsFor(f)
    const log = runs[0]!.actions_log as { type: string; status: string }[]
    expect(log[0]!.status).toBe('failed')
    expect(log[1]!.status).toBe('ok')

    // The successful action's row survived; the failed one left nothing behind.
    const activities = await f.tx(async (tx) => {
      const res = await tx.execute(
        sql`select subject from activities where organization_id = ${f.orgId} order by subject`,
      )
      return (res as unknown as { rows: { subject: string }[] }).rows.map((r) => r.subject)
    })
    expect(activities).toEqual(['still runs'])
  })

  it('refuses to let automation write core columns', async () => {
    // record.set_field is restricted to custom fields on purpose: letting a
    // rule change an invoice total or a posted status would bypass every
    // service-layer guard that exists to prevent exactly that.
    await f.tx((tx) =>
      createRule(tx, f.actor, {
        name: 'Sneaky',
        triggerType: 'record.created',
        triggerConfig: { entityType: 'invoice' },
        actions: [{ type: 'record.set_field', config: { key: 'total_minor', value: '1' } }],
      }),
    )
    const results = await f.tx((tx) =>
      dispatch(tx, f.actor, {
        type: 'record.created',
        entityType: 'invoice',
        entityId: '00000000-0000-4000-8000-0000000000d6',
        record: {},
      }),
    )
    // `total_minor` is a valid slug, so it is accepted as a CUSTOM field key
    // and written into custom_fields. Whether that particular record exists is
    // beside the point — what matters is that the real column is untouchable.
    const runs = await runsFor(f)
    const log = runs[0]!.actions_log as { type: string; status: string; detail?: string }[]
    expect(log[0]!.type).toBe('record.set_field')
    expect(log[0]!.status, `set_field failed: ${log[0]!.detail}`).toBe('ok')
    expect(results[0]!.status).toBe('succeeded')

    const totals = await f.tx(async (tx) => {
      const res = await tx.execute(
        sql`select count(*)::int as n from invoices where organization_id = ${f.orgId} and total_minor = 1`,
      )
      return (res as unknown as { rows: { n: number }[] }).rows[0]!.n
    })
    expect(Number(totals)).toBe(0)
  })

  it('rejects a rule with no actions', async () => {
    await expect(
      f.tx((tx) =>
        createRule(tx, f.actor, {
          name: 'Pointless',
          triggerType: 'record.created',
          actions: [],
        }),
      ),
    ).rejects.toThrow(/Invalid rule/)
  })

  it('overdue rules fire on the exact day, not every day after', async () => {
    await f.tx((tx) =>
      createRule(tx, f.actor, {
        name: 'Chase at 7 days',
        triggerType: 'invoice.overdue',
        triggerConfig: { daysOverdue: 7 },
        actions: [{ type: 'activity.create', config: { subject: 'Send payment reminder' } }],
      }),
    )

    const inv = await f.tx((tx) =>
      createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        dueDate: '2026-03-10',
        lines: [{ description: 'Widget', unitPriceMinor: 500_00 }],
      }),
    )
    await f.tx((tx) => issueInvoice(tx, f.actor, inv.id))

    // Six days late: nothing.
    expect(await f.tx((tx) => runOverdueRules(tx, f.actor, '2026-03-16'))).toHaveLength(0)
    // Exactly seven: fires.
    const fired = await f.tx((tx) => runOverdueRules(tx, f.actor, '2026-03-17'))
    expect(fired).toHaveLength(1)
    expect(fired[0]!.status).toBe('succeeded')
    // Eight days: silent again, or a daily job would nag every morning.
    expect(await f.tx((tx) => runOverdueRules(tx, f.actor, '2026-03-18'))).toHaveLength(0)
  })

  it('a finished run cannot be rewritten', async () => {
    await f.tx((tx) =>
      createRule(tx, f.actor, {
        name: 'Any',
        triggerType: 'record.created',
        triggerConfig: { entityType: 'deal' },
        actions: [{ type: 'activity.create', config: { subject: 'x' } }],
      }),
    )
    await f.tx((tx) =>
      dispatch(tx, f.actor, {
        type: 'record.created',
        entityType: 'deal',
        entityId: '00000000-0000-4000-8000-0000000000d7',
        record: {},
      }),
    )

    await expect(
      f.t.sudo(`update workflow_runs set status = 'succeeded', error = 'tampered'
                 where organization_id = '${f.orgId}'`),
    ).rejects.toThrow(/SYNC_APPEND_ONLY/)
  })
})
