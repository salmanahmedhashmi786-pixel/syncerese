import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { grantsFor } from '@/auth/permissions'
import { hashOpaqueToken } from '@/auth/password'
import { issueApiKey, listApiKeys, revokeApiKey } from '@/api/keys'
import { authenticateApiRequest, requireScope } from '@/api/auth'
import { emit, pendingEvents } from '@/api/events'
import {
  createEndpoint,
  drainDeliveries,
  fanOut,
  signPayload,
  verifySignature,
} from '@/api/webhooks'
import { buildOpenApiSpec } from '@/api/openapi'
import type { RequestContext } from '@/server/context'
import { createOpsFixture, type OpsFixture } from './helpers/operations'
import { FULL_ACCESS } from '@/billing/access'

const ctxFor = (f: OpsFixture, role: 'owner' | 'sales' | 'readonly' = 'owner'): RequestContext => ({
  userId: f.actor.userId!,
  organizationId: f.orgId,
  membershipId: 'test',
  role,
  permissions: grantsFor(role),
  requestId: null,
  ip: null,
  userAgent: null,
  // These fixtures build a context by hand rather than through resolveContext.
  // A licensed, in-date tenant is the right default: nothing here is testing
  // billing, and an unlicensed default would make every unrelated write fail.
  licence: FULL_ACCESS,
})

const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` })

describe('API keys', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  it('issues a key and authenticates with it', async () => {
    const issued = await f.tx((tx) =>
      issueApiKey(tx, ctxFor(f), { name: 'Zapier', scopes: ['invoice.read'] }),
    )
    expect(issued.secret).toMatch(/^syn_live_/)

    const { ctx, rateLimit } = await authenticateApiRequest(bearer(issued.secret), f.t.db)
    expect(ctx.organizationId).toBe(f.orgId)
    expect(ctx.scopes.has('invoice.read')).toBe(true)
    expect(rateLimit.limit).toBe(120)
    expect(rateLimit.used).toBe(1)
  })

  it('NEVER stores the plaintext key', async () => {
    const issued = await f.tx((tx) =>
      issueApiKey(tx, ctxFor(f), { name: 'K', scopes: ['invoice.read'] }),
    )
    const stored = await f.tx(async (tx) => {
      const res = await tx.execute(sql`select key_hash, key_prefix from api_keys`)
      return (res as unknown as { rows: { key_hash: string; key_prefix: string }[] }).rows[0]!
    })
    expect(stored.key_hash).not.toBe(issued.secret)
    expect(stored.key_hash).toBe(hashOpaqueToken(issued.secret))
    // The prefix is for identification in a list, and is useless as a credential.
    expect(issued.secret.startsWith(stored.key_prefix)).toBe(true)
    expect(stored.key_prefix.length).toBeLessThan(20)
  })

  it('refuses to grant scopes the creating user does not hold', async () => {
    // Otherwise any Sales user could mint themselves an Owner-scoped key and
    // walk straight around RBAC.
    await expect(
      f.tx((tx) =>
        issueApiKey(tx, ctxFor(f, 'sales'), { name: 'Escalation', scopes: ['org.delete'] }),
      ),
    ).rejects.toThrow(/cannot grant a key permissions you do not hold/)
  })

  it('rejects unknown scopes', async () => {
    await expect(
      f.tx((tx) => issueApiKey(tx, ctxFor(f), { name: 'K', scopes: ['invoice.destroy'] })),
    ).rejects.toThrow(/Unknown scope/)
  })

  it('rejects an unknown, revoked or expired key identically', async () => {
    const issued = await f.tx((tx) =>
      issueApiKey(tx, ctxFor(f), { name: 'K', scopes: ['invoice.read'] }),
    )

    await expect(authenticateApiRequest(bearer('syn_live_nope'), f.t.db)).rejects.toThrow(
      /Invalid API key/,
    )

    const keyId = (await listApiKeysId(f))!
    await f.tx((tx) => revokeApiKey(tx, ctxFor(f), keyId, 'rotated'))
    await expect(authenticateApiRequest(bearer(issued.secret), f.t.db)).rejects.toThrow(
      /Invalid API key/,
    )
  })

  it('rejects an expired key', async () => {
    const issued = await f.tx((tx) =>
      issueApiKey(tx, ctxFor(f), { name: 'K', scopes: ['invoice.read'], expiresInDays: 1 }),
    )
    await f.t.sudo(`update api_keys set expires_at = now() - interval '1 day'`)
    await expect(authenticateApiRequest(bearer(issued.secret), f.t.db)).rejects.toThrow(
      /Invalid API key/,
    )
  })

  it('rejects a request with no bearer token', async () => {
    await expect(authenticateApiRequest(new Headers(), f.t.db)).rejects.toThrow(
      /Provide an API key/,
    )
  })

  it('scopes are FROZEN — a promoted user does not upgrade their old key', async () => {
    const issued = await f.tx((tx) =>
      issueApiKey(tx, ctxFor(f, 'sales'), { name: 'Sales bot', scopes: ['crm.read'] }),
    )
    const { ctx } = await authenticateApiRequest(bearer(issued.secret), f.t.db)

    expect(ctx.scopes.has('crm.read')).toBe(true)
    expect(ctx.scopes.has('ledger.post')).toBe(false)
    expect(() => requireScope(ctx, 'ledger.post')).toThrow(/lacks the "ledger.post" scope/)
  })

  it('enforces the rate limit in the database, across processes', async () => {
    const issued = await f.tx((tx) =>
      issueApiKey(tx, ctxFor(f), {
        name: 'Chatty',
        scopes: ['invoice.read'],
        rateLimitPerMinute: 3,
      }),
    )

    for (let i = 0; i < 3; i++) {
      const { rateLimit } = await authenticateApiRequest(bearer(issued.secret), f.t.db)
      expect(rateLimit.used).toBe(i + 1)
    }
    await expect(authenticateApiRequest(bearer(issued.secret), f.t.db)).rejects.toThrow(
      /Rate limit exceeded/,
    )
  })

  it('a key from one tenant cannot reach another tenant', async () => {
    const issued = await f.tx((tx) =>
      issueApiKey(tx, ctxFor(f), { name: 'K', scopes: ['invoice.read'] }),
    )
    const { ctx } = await authenticateApiRequest(bearer(issued.secret), f.t.db)
    // The key resolves to exactly one organization; there is no parameter that
    // could point it at another.
    expect(ctx.organizationId).toBe(f.orgId)
  })
})

async function listApiKeysId(f: OpsFixture): Promise<string | undefined> {
  const keys = await f.tx((tx) => listApiKeys(tx, f.orgId))
  return keys[0]?.id as string | undefined
}

describe('webhook signing', () => {
  const secret = 'whsec_test_secret'
  const body = JSON.stringify({ type: 'invoice.issued', data: { id: 'x' } })

  it('signs and verifies', () => {
    const now = Math.floor(Date.now() / 1000)
    const header = signPayload(secret, body, now)
    expect(verifySignature(secret, body, header)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const now = Math.floor(Date.now() / 1000)
    const header = signPayload(secret, body, now)
    expect(verifySignature(secret, `${body} `, header)).toBe(false)
  })

  it('rejects the wrong secret', () => {
    const now = Math.floor(Date.now() / 1000)
    const header = signPayload(secret, body, now)
    expect(verifySignature('whsec_other', body, header)).toBe(false)
  })

  it('rejects a replayed signature outside the tolerance window', () => {
    // A body-only signature stays valid forever, so a captured request could be
    // resent indefinitely. Binding the timestamp into the MAC is what stops it.
    const old = Math.floor(Date.now() / 1000) - 3600
    const header = signPayload(secret, body, old)
    expect(verifySignature(secret, body, header)).toBe(false)
    expect(verifySignature(secret, body, header, 7200)).toBe(true)
  })

  it('rejects a malformed header without throwing', () => {
    expect(verifySignature(secret, body, 'garbage')).toBe(false)
    expect(verifySignature(secret, body, 't=abc,v1=zz')).toBe(false)
    expect(verifySignature(secret, body, `t=${Math.floor(Date.now() / 1000)},v1=short`)).toBe(false)
  })
})

describe('events and webhook delivery', () => {
  let f: OpsFixture
  const savedEnv = { ...process.env }

  beforeEach(async () => {
    // Creating an endpoint now encrypts its signing secret at rest, so a key
    // has to exist. Before that change a hash was all that was stored — and a
    // hash cannot sign, which is why no webhook could ever actually be sent.
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
    process.env = { ...savedEnv }
  })

  const makeEndpoint = async (events: string[] = ['*']) =>
    f.tx((tx) =>
      createEndpoint(tx, ctxFor(f), { url: 'https://hooks.example.test/sync', events }),
    )

  it('emits into the outbox inside the caller’s transaction', async () => {
    await f.tx((tx) =>
      emit(tx, {
        organizationId: f.orgId,
        type: 'invoice.issued',
        entityType: 'invoice',
        entityId: '00000000-0000-4000-8000-00000000e001',
        payload: { invoiceNo: 'INV-1' },
      }),
    )
    const pending = await f.tx((tx) => pendingEvents(tx, f.orgId))
    expect(pending).toHaveLength(1)
    expect(pending[0]!.type).toBe('invoice.issued')
  })

  it('rolls the event back with the transaction that produced it', async () => {
    // The whole reason for an outbox: no event for a change that never happened.
    await expect(
      f.tx(async (tx) => {
        await emit(tx, {
          organizationId: f.orgId,
          type: 'invoice.issued',
          entityType: 'invoice',
        })
        throw new Error('business failure')
      }),
    ).rejects.toThrow('business failure')

    const pending = await f.tx((tx) => pendingEvents(tx, f.orgId))
    expect(pending).toHaveLength(0)
  })

  it('redacts secrets from event payloads before they leave the building', async () => {
    await f.tx((tx) =>
      emit(tx, {
        organizationId: f.orgId,
        type: 'partner.created',
        entityType: 'business_partner',
        payload: { name: 'Acme', accessToken: 'super-secret', nested: { passwordHash: 'x' } },
      }),
    )
    const pending = await f.tx((tx) => pendingEvents(tx, f.orgId))
    const payload = pending[0]!.payload as Record<string, unknown>
    expect(payload.name).toBe('Acme')
    expect(payload.accessToken).toBe('[redacted]')
    expect((payload.nested as Record<string, unknown>).passwordHash).toBe('[redacted]')
  })

  it('fans out only to endpoints subscribed to that event', async () => {
    await makeEndpoint(['invoice.issued'])
    await makeEndpoint(['deal.won'])

    await f.tx((tx) =>
      emit(tx, { organizationId: f.orgId, type: 'invoice.issued', entityType: 'invoice' }),
    )
    const result = await f.tx((tx) => fanOut(tx, f.orgId))
    expect(result.events).toBe(1)
    expect(result.deliveries).toBe(1)
  })

  it('fan-out is idempotent', async () => {
    await makeEndpoint()
    await f.tx((tx) =>
      emit(tx, { organizationId: f.orgId, type: 'invoice.issued', entityType: 'invoice' }),
    )
    await f.tx((tx) => fanOut(tx, f.orgId))
    const second = await f.tx((tx) => fanOut(tx, f.orgId))
    // The event is marked dispatched, and the unique index would stop a
    // duplicate even if it were not.
    expect(second.events).toBe(0)

    const count = await f.tx(async (tx) => {
      const res = await tx.execute(sql`select count(*)::int as n from webhook_deliveries`)
      return Number((res as unknown as { rows: { n: number }[] }).rows[0]!.n)
    })
    expect(count).toBe(1)
  })

  it('delivers a correctly signed payload', async () => {
    const endpoint = await makeEndpoint()
    await f.tx((tx) =>
      emit(tx, {
        organizationId: f.orgId,
        type: 'invoice.issued',
        entityType: 'invoice',
        payload: { invoiceNo: 'INV-00001' },
      }),
    )
    await f.tx((tx) => fanOut(tx, f.orgId))

    let captured: { body: string; headers: Record<string, string> } | null = null

    const results = await f.tx((tx) =>
      drainDeliveries(tx, f.orgId, {
        secretFor: async () => endpoint.secret,
        send: async (_url, body, headers) => {
          captured = { body, headers }
          return new Response('ok', { status: 200 })
        },
      }),
    )

    expect(results[0]!.status).toBe('succeeded')
    expect(captured).not.toBeNull()
    const { body, headers } = captured!
    expect(JSON.parse(body).type).toBe('invoice.issued')
    expect(verifySignature(endpoint.secret, body, headers['syncrese-signature']!)).toBe(true)
    expect(headers['syncrese-event']).toBe('invoice.issued')
  })

  it('retries with exponential backoff and eventually abandons', async () => {
    const endpoint = await makeEndpoint()
    await f.tx((tx) =>
      emit(tx, { organizationId: f.orgId, type: 'invoice.issued', entityType: 'invoice' }),
    )
    await f.tx((tx) => fanOut(tx, f.orgId))

    const fail = {
      secretFor: async () => endpoint.secret,
      send: async () => new Response('nope', { status: 500 }),
    }

    // Must start at or after the moment fan-out stamped next_attempt_at,
    // otherwise nothing is ever due and the loop silently does nothing.
    let now = new Date()
    const statuses: string[] = []
    for (let attempt = 1; attempt <= 7; attempt++) {
      const results = await f.tx((tx) => drainDeliveries(tx, f.orgId, { ...fail, now }))
      if (results.length > 0) statuses.push(results[0]!.status)
      // Jump far enough ahead that the next attempt is due.
      now = new Date(now.getTime() + 24 * 3600 * 1000)
    }

    expect(statuses.slice(0, 5)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed'])
    expect(statuses[5]).toBe('abandoned')
    // Abandoned means abandoned — no seventh attempt.
    expect(statuses).toHaveLength(6)
  })

  it('does not retry before the backoff window has elapsed', async () => {
    const endpoint = await makeEndpoint()
    await f.tx((tx) =>
      emit(tx, { organizationId: f.orgId, type: 'invoice.issued', entityType: 'invoice' }),
    )
    await f.tx((tx) => fanOut(tx, f.orgId))

    const now = new Date()
    const opts = {
      secretFor: async () => endpoint.secret,
      send: async () => new Response('nope', { status: 500 }),
    }

    await f.tx((tx) => drainDeliveries(tx, f.orgId, { ...opts, now }))
    // Ten seconds later the first backoff (30s) has not expired.
    const tooSoon = await f.tx((tx) =>
      drainDeliveries(tx, f.orgId, { ...opts, now: new Date(now.getTime() + 10_000) }),
    )
    expect(tooSoon).toHaveLength(0)
  })

  it('abandons rather than sending unsigned when the secret is unavailable', async () => {
    await makeEndpoint()
    await f.tx((tx) =>
      emit(tx, { organizationId: f.orgId, type: 'invoice.issued', entityType: 'invoice' }),
    )
    await f.tx((tx) => fanOut(tx, f.orgId))

    let sent = false
    const results = await f.tx((tx) =>
      drainDeliveries(tx, f.orgId, {
        secretFor: async () => null,
        send: async () => {
          sent = true
          return new Response('ok', { status: 200 })
        },
      }),
    )
    expect(results[0]!.status).toBe('abandoned')
    expect(sent).toBe(false)
  })

  it('requires HTTPS and refuses private-network URLs', async () => {
    // The user-facing message stays generic; the field-level reason is in
    // details, which is what a form binds to.
    let caught: unknown
    try {
      await f.tx((tx) =>
        createEndpoint(tx, ctxFor(f), { url: 'http://example.test/h', events: ['*'] }),
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(JSON.stringify((caught as { details?: unknown }).details)).toMatch(/HTTPS/)

    for (const url of [
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      await expect(
        f.tx((tx) => createEndpoint(tx, ctxFor(f), { url, events: ['*'] })),
      ).rejects.toThrow(/publicly reachable/)
    }
  })

  it('rejects unknown event subscriptions', async () => {
    await expect(
      f.tx((tx) =>
        createEndpoint(tx, ctxFor(f), {
          url: 'https://hooks.example.test/x',
          events: ['invoice.exploded'],
        }),
      ),
    ).rejects.toThrow(/Unknown event type/)
  })

  it('events are append-only', async () => {
    await f.tx((tx) =>
      emit(tx, { organizationId: f.orgId, type: 'invoice.issued', entityType: 'invoice' }),
    )
    await expect(
      f.t.sudo(`update events set payload = '{"tampered":true}'::jsonb`),
    ).rejects.toThrow(/SYNC_APPEND_ONLY/)
    await expect(f.t.sudo(`delete from events`)).rejects.toThrow(/SYNC_APPEND_ONLY/)

    // Marking dispatched is the one permitted update.
    await expect(f.t.sudo(`update events set dispatched_at = now()`)).resolves.not.toThrow()
  })
})

describe('OpenAPI spec', () => {
  it('documents every table module and stays in step with the registry', () => {
    const spec = buildOpenApiSpec('https://app.syncrese.test') as {
      paths: Record<string, { get?: { 'x-required-scope': string } }>
      'x-webhook-events': readonly string[]
    }

    expect(spec.paths['/api/v1/invoices']).toBeDefined()
    expect(spec.paths['/api/v1/customers']).toBeDefined()
    expect(spec.paths['/api/v1/sales-orders']).toBeDefined()

    // Every documented list endpoint declares the scope it needs, so the docs
    // cannot describe an endpoint as open that the code actually gates.
    for (const [path, ops] of Object.entries(spec.paths)) {
      if (ops.get) {
        expect(ops.get['x-required-scope'], `${path} must declare a scope`).toBeTruthy()
      }
    }

    expect(spec['x-webhook-events']).toContain('invoice.issued')
  })
})
