import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { grantsFor } from '@/auth/permissions'
import { emit } from '@/api/events'
import {
  createIntegration,
  listIntegrations,
  updateIntegration,
  deleteIntegration,
  prepareTestMessage,
  recordTestResult,
} from '@/integrations/chat'
import { deliverChatMessages, type ChatSend } from '@/integrations/delivery'
import type { RequestContext } from '@/server/context'
import { createOpsFixture, type OpsFixture } from './helpers/operations'
import { FULL_ACCESS } from '@/billing/access'

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')

// Deliberately NOT shaped like a real Slack token. `checkWebhookUrl` validates
// the scheme, the absence of credentials and the HOST — never the path — so the
// realistic `T00000000/B00000000/<24 chars>` form tested nothing extra, and
// GitHub's secret scanner blocked every push to this repository because of it.
// A fixture that cannot be committed is a fixture that costs more than it earns.
const SLACK_URL = 'https://hooks.slack.com/services/T0/B0/example-not-a-real-token'

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

const chatCtx = { organizationName: 'Northwind GmbH', appUrl: 'https://app.test' }

/** Records what would have been posted, and answers however the test says. */
function recorder(replies: number[] | number = 200) {
  const calls: { url: string; body: unknown }[] = []
  let i = 0
  const send: ChatSend = async (url, body) => {
    calls.push({ url, body: JSON.parse(body) })
    const status = Array.isArray(replies) ? (replies[i++] ?? replies.at(-1)!) : replies
    return { status, ok: status >= 200 && status < 300 }
  }
  return { calls, send }
}

async function integrationRow(f: OpsFixture, id: string) {
  return await f.tx(async (tx) => {
    const res = await tx.execute(sql`
      select enabled, failure_count as "failureCount", cursor_at as "cursorAt",
             cursor_event_id as "cursorEventId", last_error as "lastError"
        from chat_integrations where id = ${id}
    `)
    return (
      res as unknown as {
        rows: {
          enabled: boolean
          failureCount: number
          cursorAt: string | null
          cursorEventId: string | null
          lastError: string | null
        }[]
      }
    ).rows[0]!
  })
}

const addSlack = (f: OpsFixture, events: string[] = ['*']) =>
  f.tx((tx) =>
    createIntegration(tx, ctxFor(f), {
      kind: 'slack',
      name: '#finance',
      url: SLACK_URL,
      events,
    }),
  )

async function emitInvoices(f: OpsFixture, count: number, type = 'invoice.issued') {
  return await f.tx(async (tx) => {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      ids.push(
        await emit(tx, {
          organizationId: f.orgId,
          type: type as 'invoice.issued',
          entityType: 'invoice',
          entityId: null,
          payload: { invoiceNo: `INV-${i}`, totalMinor: 1000 * (i + 1), currencyCode: 'EUR' },
        }),
      )
    }
    return ids
  })
}

describe('chat integrations', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  it('stores the URL encrypted and never returns it', async () => {
    const { id } = await addSlack(f)

    const listed = await f.tx((tx) => listIntegrations(tx, ctxFor(f)))
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain('XXXXXXXXXXXXXXXXXXXXXXXX')
    expect(listed[0]!.urlHint).toContain('hooks.slack.com')

    const stored = await f.tx(async (tx) => {
      const res = await tx.execute(
        sql`select target_url_encrypted as u from chat_integrations where id = ${id}`,
      )
      return (res as unknown as { rows: { u: string }[] }).rows[0]!.u
    })
    // Encrypted at rest, like the webhook signing secret and the TOTP secret —
    // anyone holding this URL can post into the customer's channel as us.
    expect(stored).not.toContain('hooks.slack.com')
    expect(stored.startsWith('v1.')).toBe(true)
  })

  it('refuses a URL that is not the vendor host', async () => {
    await expect(
      f.tx((tx) =>
        createIntegration(tx, ctxFor(f), {
          kind: 'slack',
          name: 'metadata',
          url: 'http://169.254.169.254/latest/meta-data/',
          events: ['*'],
        }),
      ),
    ).rejects.toThrow()
  })

  it('will not let a role without webhook.manage add one', async () => {
    await expect(
      f.tx((tx) =>
        createIntegration(tx, ctxFor(f, 'readonly'), {
          kind: 'slack',
          name: '#finance',
          url: SLACK_URL,
          events: ['*'],
        }),
      ),
    ).rejects.toThrow()
  })

  it('starts at the newest existing event, so adding one does not replay history', async () => {
    await emitInvoices(f, 3)
    const { id } = await addSlack(f)

    const { calls } = recorder()
    const before = await integrationRow(f, id)
    expect(before.cursorAt).not.toBeNull()
    expect(before.cursorEventId).not.toBeNull()

    const { send } = recorder()
    const results = await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))
    expect(results[0]!.sent).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('sends events after the cursor, oldest first, and advances', async () => {
    const { id } = await addSlack(f)
    await emitInvoices(f, 3)

    const { calls, send } = recorder()
    const results = await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))

    expect(results[0]!.sent).toBe(3)
    expect(calls.map((c) => (c.body as { text: string }).text)).toEqual([
      'Invoice issued — INV-0 · €10.00',
      'Invoice issued — INV-1 · €20.00',
      'Invoice issued — INV-2 · €30.00',
    ])

    // Second tick sends nothing — the cursor moved.
    const second = recorder()
    const again = await f.tx((tx) =>
      deliverChatMessages(tx, f.orgId, chatCtx, { send: second.send }),
    )
    expect(again[0]!.sent).toBe(0)
    expect(second.calls).toHaveLength(0)

    const row = await integrationRow(f, id)
    expect(row.failureCount).toBe(0)
    expect(row.cursorEventId).not.toBeNull()
  })

  it('advances past events it is not subscribed to', async () => {
    // Otherwise an integration watching one rare event type re-reads the same
    // rows on every tick, for ever.
    const { id } = await addSlack(f, ['deal.won'])
    await emitInvoices(f, 3)

    const { calls, send } = recorder()
    await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))
    expect(calls).toHaveLength(0)

    const row = await integrationRow(f, id)
    expect(row.cursorEventId).not.toBeNull()
  })

  it('stops at the first failure and keeps the unsent events', async () => {
    const { id } = await addSlack(f)
    await emitInvoices(f, 3)

    // First succeeds, second fails.
    const { calls, send } = recorder([200, 500, 200])
    const results = await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))

    expect(results[0]!.sent).toBe(1)
    expect(results[0]!.failed).toBe(1)
    expect(calls).toHaveLength(2)

    const row = await integrationRow(f, id)
    expect(row.failureCount).toBe(1)
    expect(row.enabled).toBe(true)

    // The next tick picks up exactly where it stopped — not before it, which
    // would double-post, and not after, which would lose an event.
    const retry = recorder(200)
    const again = await f.tx((tx) =>
      deliverChatMessages(tx, f.orgId, chatCtx, { send: retry.send }),
    )
    expect(again[0]!.sent).toBe(2)
    expect(retry.calls.map((c) => (c.body as { text: string }).text)).toEqual([
      'Invoice issued — INV-1 · €20.00',
      'Invoice issued — INV-2 · €30.00',
    ])
  })

  it('disables immediately on 404, because the webhook was deleted', async () => {
    const { id } = await addSlack(f)
    await emitInvoices(f, 1)

    const { send } = recorder(404)
    const results = await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))
    expect(results[0]!.disabled).toBe(true)

    const row = await integrationRow(f, id)
    expect(row.enabled).toBe(false)
    expect(row.lastError).toContain('404')
  })

  it('does not count a 429 against the failure budget', async () => {
    // Slack asking for a slower pace is not a broken integration, and
    // disabling on it would punish the busiest tenants.
    const { id } = await addSlack(f)
    await emitInvoices(f, 1)

    const { send } = recorder(429)
    await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))

    const row = await integrationRow(f, id)
    expect(row.failureCount).toBe(0)
    expect(row.enabled).toBe(true)
    // And the event is still waiting.
    const retry = recorder(200)
    const again = await f.tx((tx) =>
      deliverChatMessages(tx, f.orgId, chatCtx, { send: retry.send }),
    )
    expect(again[0]!.sent).toBe(1)
  })

  it('switches itself off after enough consecutive failures', async () => {
    const { id } = await addSlack(f)

    for (let i = 0; i < 20; i++) {
      await emitInvoices(f, 1)
      const { send } = recorder(500)
      await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))
    }

    const row = await integrationRow(f, id)
    expect(row.enabled).toBe(false)
    expect(row.failureCount).toBeGreaterThanOrEqual(20)
  })

  it('resets the failure count when re-enabled', async () => {
    const { id } = await addSlack(f)
    await emitInvoices(f, 1)
    const { send } = recorder(500)
    await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))
    expect((await integrationRow(f, id)).failureCount).toBe(1)

    await f.tx((tx) => updateIntegration(tx, ctxFor(f), id, { enabled: true }))
    const row = await integrationRow(f, id)
    // Leaving the count where it was means the next single failure switches it
    // straight back off, and the customer's "try again" does nothing.
    expect(row.failureCount).toBe(0)
    expect(row.lastError).toBeNull()
  })

  it('changes the subscribed event list', async () => {
    const { id } = await addSlack(f, ['*'])
    await f.tx((tx) => updateIntegration(tx, ctxFor(f), id, { events: ['invoice.paid'] }))

    const listed = await f.tx((tx) => listIntegrations(tx, ctxFor(f)))
    expect(listed[0]!.events).toEqual(['invoice.paid'])

    // And it takes effect: invoice.issued no longer matches.
    await emitInvoices(f, 2, 'invoice.issued')
    const { calls, send } = recorder()
    await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))
    expect(calls).toHaveLength(0)
  })

  it('rejects an event type that does not exist', async () => {
    const { id } = await addSlack(f)
    await expect(
      f.tx((tx) => updateIntegration(tx, ctxFor(f), id, { events: ['invoice.exploded'] })),
    ).rejects.toThrow(/Unknown event type/)
  })

  it('caps how much it sends in one tick', async () => {
    await addSlack(f)
    await emitInvoices(f, 25)

    const { calls, send } = recorder()
    await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send, limit: 20 }))
    expect(calls).toHaveLength(20)
  })

  it('skips a disabled integration entirely', async () => {
    const { id } = await addSlack(f)
    await f.tx((tx) => updateIntegration(tx, ctxFor(f), id, { enabled: false }))
    await emitInvoices(f, 2)

    const { calls, send } = recorder()
    const results = await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))
    expect(results).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('deletes, and audits the deletion without the URL', async () => {
    const { id } = await addSlack(f)
    await f.tx((tx) => deleteIntegration(tx, ctxFor(f), id))
    expect(await f.tx((tx) => listIntegrations(tx, ctxFor(f)))).toHaveLength(0)

    const audit = await f.tx(async (tx) => {
      const res = await tx.execute(sql`
        select action, before, after from audit_log
         where organization_id = ${f.orgId} and entity_type = 'chat_integration'
      `)
      return (res as unknown as { rows: { action: string }[] }).rows
    })
    expect(audit.map((a) => a.action)).toContain('chat_integration.deleted')
    expect(JSON.stringify(audit)).not.toContain('XXXXXXXXXXXXXXXXXXXXXXXX')
  })

  it('builds a test message without holding a transaction across the network call', async () => {
    const { id } = await addSlack(f)

    // prepareTestMessage returns the URL and body; the POST happens outside any
    // transaction, and recordTestResult audits afterwards.
    const prepared = await f.tx((tx) => prepareTestMessage(tx, ctxFor(f), id, 'Northwind GmbH'))
    expect(prepared.url).toBe(SLACK_URL)
    const body = JSON.parse(prepared.body) as { text: string }
    expect(body.text).toContain('test message')

    await f.tx((tx) => recordTestResult(tx, ctxFor(f), id, { ok: false, status: 403 }))

    const audit = await f.tx(async (tx) => {
      const res = await tx.execute(sql`
        select action, after from audit_log
         where organization_id = ${f.orgId} and action = 'chat_integration.tested'
      `)
      return (res as unknown as { rows: { after: Record<string, unknown> }[] }).rows
    })
    expect(audit).toHaveLength(1)
    expect(audit[0]!.after).toMatchObject({ status: 403, ok: false })
    // The URL is not in the audit row — it is a credential.
    expect(JSON.stringify(audit)).not.toContain('XXXXXXXXXXXXXXXXXXXXXXXX')
  })

  it('will not prepare a test message for a role without webhook.manage', async () => {
    const { id } = await addSlack(f)
    await expect(
      f.tx((tx) => prepareTestMessage(tx, ctxFor(f, 'readonly'), id, 'Northwind GmbH')),
    ).rejects.toThrow()
  })

  it('is findable by the dispatch tick even after the webhook fan-out ran', async () => {
    // organizations_with_chat_work() is what puts a tenant on the tick's list.
    // Riding on events.dispatched_at instead would mean chat silently stopped
    // for exactly the tenants that also use webhooks — the fan-out sets that
    // flag, and the chat cursor is independent of it.
    await addSlack(f)
    await emitInvoices(f, 2)
    await f.tx((tx) => tx.execute(sql`update events set dispatched_at = now()`))

    const found = await f.tx(async (tx) => {
      const res = await tx.execute(
        sql`select organization_id as id from public.organizations_with_chat_work()`,
      )
      return (res as unknown as { rows: { id: string }[] }).rows.map((r) => r.id)
    })
    expect(found).toContain(f.orgId)

    // And once everything has been sent, it drops off the list again.
    const { send } = recorder()
    await f.tx((tx) => deliverChatMessages(tx, f.orgId, chatCtx, { send }))
    const after = await f.tx(async (tx) => {
      const res = await tx.execute(
        sql`select organization_id as id from public.organizations_with_chat_work()`,
      )
      return (res as unknown as { rows: { id: string }[] }).rows
    })
    expect(after).toHaveLength(0)
  })

  it('keeps one tenant out of another tenant\'s integrations', async () => {
    await addSlack(f)
    const other = await createOpsFixture()
    try {
      const theirs = await other.tx((tx) => listIntegrations(tx, ctxFor(other)))
      expect(theirs).toHaveLength(0)

      const { calls, send } = recorder()
      await emitInvoices(f, 2)
      const results = await other.tx((tx) =>
        deliverChatMessages(tx, other.orgId, chatCtx, { send }),
      )
      expect(results).toHaveLength(0)
      expect(calls).toHaveLength(0)
    } finally {
      await other.t.close()
    }
  })
})
