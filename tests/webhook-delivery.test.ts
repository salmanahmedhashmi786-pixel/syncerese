import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { withTenant } from '@/db/tenant'
import { resolveContext, type RequestContext } from '@/server/context'
import {
  createEndpoint,
  drainDeliveries,
  fanOut,
  revealSecret,
  secretForEndpoint,
  signPayload,
  verifySignature,
  SIGNATURE_HEADER,
} from '@/api/webhooks'
import { emit } from '@/api/events'
import { createTestDb, seedOrg, type TestDb } from './helpers/db'

/**
 * Webhook delivery.
 *
 * This could not work at all until the signing secret was stored recoverably:
 * every delivery computes an HMAC with it, and a hash cannot sign. These tests
 * exist to prove the decision actually closed the loop — a payload leaves, and
 * the receiver can verify it came from us.
 */
describe('signed webhook delivery', () => {
  let t: TestDb
  let org: { orgId: string; ownerUserId: string }
  let ctx: RequestContext
  const saved = { ...process.env }

  beforeEach(async () => {
    process.env.LICENSE_KEY_PEPPER = 'test-pepper'
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')
    t = await createTestDb()
    org = await seedOrg(t, { name: 'Hooked Co', slug: 'hooked', seats: 5 })
    ctx = (await resolveContext(t.db, {
      userId: org.ownerUserId,
      organizationId: org.orgId,
    }))!
  })

  afterEach(async () => {
    await t.close()
    process.env = { ...saved }
  })

  const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(t.db, { organizationId: org.orgId, userId: org.ownerUserId }, fn)

  const makeEndpoint = () =>
    tx((trx) =>
      createEndpoint(trx, ctx, {
        url: 'https://receiver.example.com/hooks',
        events: ['invoice.issued'],
      }),
    )

  it('stores the secret encrypted, and can get it back to sign with', async () => {
    const endpoint = await makeEndpoint()

    const stored = await t.client.query<{ enc: string; hash: string }>(
      `select secret_encrypted as enc, secret_hash as hash from webhook_endpoints where id = $1`,
      [endpoint.id],
    )
    // Encrypted at rest, not sitting in the clear.
    expect(stored.rows[0]!.enc).not.toContain(endpoint.secret)
    expect(stored.rows[0]!.enc).toMatch(/^v1\./)
    // The hash is still kept alongside it.
    expect(stored.rows[0]!.hash).toMatch(/^[0-9a-f]{64}$/)

    // And it comes back — which is the whole point. With hash-only storage this
    // returns null and no webhook can ever be sent.
    const recovered = await tx((trx) => secretForEndpoint(trx, org.orgId, endpoint.id))
    expect(recovered).toBe(endpoint.secret)
  })

  it('delivers a signed payload the receiver can verify', async () => {
    const endpoint = await makeEndpoint()

    await tx((trx) =>
      emit(trx, {
        organizationId: org.orgId,
        type: 'invoice.issued',
        entityType: 'invoice',
        entityId: '00000000-0000-0000-0000-0000000000ab',
        payload: { invoiceNo: 'INV-00001', totalMinor: 119_000, currencyCode: 'EUR' },
      }),
    )

    await tx((trx) => fanOut(trx, org.orgId))

    const captured: { url: string; body: string; headers: Record<string, string> }[] = []

    const results = await tx((trx) =>
      drainDeliveries(trx, org.orgId, {
        secretFor: (id) => secretForEndpoint(trx, org.orgId, id),
        send: async (url, body, headers) => {
          captured.push({ url, body, headers })
          return new Response('ok', { status: 200 })
        },
      }),
    )

    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('succeeded')
    expect(captured).toHaveLength(1)
    expect(captured[0]!.url).toBe('https://receiver.example.com/hooks')

    // The receiver's side of the contract: with the secret they were given at
    // creation, the signature verifies.
    const signature = captured[0]!.headers[SIGNATURE_HEADER]!
    expect(verifySignature(endpoint.secret, captured[0]!.body, signature)).toBe(true)

    // And a different secret does not.
    expect(verifySignature('whsec_someone_elses', captured[0]!.body, signature)).toBe(false)

    // The payload is the event.
    const sent = JSON.parse(captured[0]!.body)
    expect(sent.type).toBe('invoice.issued')
    expect(sent.data.invoiceNo).toBe('INV-00001')
  })

  it('signs over the timestamp, so a captured request cannot be replayed forever', async () => {
    const secret = 'whsec_test'
    const body = JSON.stringify({ type: 'invoice.issued' })

    const fresh = signPayload(secret, body, Math.floor(Date.now() / 1000))
    expect(verifySignature(secret, body, fresh)).toBe(true)

    // The same signature, an hour later. A body-only signature would still
    // verify — this is why the timestamp is inside the MAC.
    const old = signPayload(secret, body, Math.floor(Date.now() / 1000) - 3600)
    expect(verifySignature(secret, body, old)).toBe(false)
  })

  it('refuses a tampered body', async () => {
    const secret = 'whsec_test'
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = signPayload(secret, JSON.stringify({ amount: 100 }), timestamp)

    expect(verifySignature(secret, JSON.stringify({ amount: 999_999 }), signature)).toBe(false)
  })

  it('abandons a delivery it cannot sign rather than sending garbage', async () => {
    const endpoint = await makeEndpoint()
    await tx((trx) =>
      emit(trx, {
        organizationId: org.orgId,
        type: 'invoice.issued',
        entityType: 'invoice',
        entityId: '00000000-0000-0000-0000-0000000000ac',
        payload: {},
      }),
    )
    await tx((trx) => fanOut(trx, org.orgId))

    // The key is gone. Sending something signed with rubbish would be worse
    // than not sending: the receiver would reject it silently, for ever.
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64')

    let sent = 0
    const results = await tx((trx) =>
      drainDeliveries(trx, org.orgId, {
        secretFor: (id) => secretForEndpoint(trx, org.orgId, id),
        send: async () => {
          sent++
          return new Response('ok', { status: 200 })
        },
      }),
    )

    expect(sent).toBe(0)
    expect(results[0]!.status).toBe('abandoned')
    void endpoint
  })

  it('lets somebody who can manage webhooks read the secret back', async () => {
    // A customer who has lost their signing secret should not have to break a
    // live integration to recover it.
    const endpoint = await makeEndpoint()
    const revealed = await tx((trx) => revealSecret(trx, ctx, endpoint.id))
    expect(revealed).toBe(endpoint.secret)

    // And the disclosure is recorded, without recording the secret.
    const audit = await t.client.query<{ n: string; body: string }>(
      `select count(*) as n, coalesce(string_agg(after::text, ' '), '') as body
         from audit_log
        where organization_id = $1 and action = 'webhook_endpoint.secret_revealed'`,
      [org.orgId],
    )
    expect(Number(audit.rows[0]!.n)).toBe(1)
    expect(audit.rows[0]!.body).not.toContain(endpoint.secret)
  })

  it('does not let one tenant read another tenant’s secret', async () => {
    const endpoint = await makeEndpoint()
    const other = await seedOrg(t, { name: 'Nosy Co', slug: 'nosy', seats: 5 })
    const otherCtx = (await resolveContext(t.db, {
      userId: other.ownerUserId,
      organizationId: other.orgId,
    }))!

    await expect(
      withTenant(t.db, { organizationId: other.orgId, userId: other.ownerUserId }, (trx) =>
        revealSecret(trx, otherCtx, endpoint.id),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    expect(
      await withTenant(t.db, { organizationId: other.orgId }, (trx) =>
        secretForEndpoint(trx, other.orgId, endpoint.id),
      ),
    ).toBeNull()
  })

  it('does not deliver an event the endpoint did not subscribe to', async () => {
    await makeEndpoint() // subscribed to invoice.issued only

    await tx((trx) =>
      emit(trx, {
        organizationId: org.orgId,
        type: 'payment.recorded',
        entityType: 'payment',
        entityId: '00000000-0000-0000-0000-0000000000ad',
        payload: {},
      }),
    )

    const fanned = await tx((trx) => fanOut(trx, org.orgId))
    expect(fanned.deliveries).toBe(0)

    const pending = await t.client.query<{ n: string }>(
      `select count(*) as n from webhook_deliveries where organization_id = $1`,
      [org.orgId],
    )
    expect(Number(pending.rows[0]!.n)).toBe(0)
  })

  it('retries a failing endpoint instead of giving up', async () => {
    await makeEndpoint()
    await tx((trx) =>
      emit(trx, {
        organizationId: org.orgId,
        type: 'invoice.issued',
        entityType: 'invoice',
        entityId: '00000000-0000-0000-0000-0000000000ae',
        payload: {},
      }),
    )
    await tx((trx) => fanOut(trx, org.orgId))

    const results = await tx((trx) =>
      drainDeliveries(trx, org.orgId, {
        secretFor: (id) => secretForEndpoint(trx, org.orgId, id),
        send: async () => new Response('nope', { status: 500 }),
      }),
    )

    expect(results[0]!.status).toBe('failed')

    // Scheduled for another go rather than dropped — a customer's deploy should
    // not cost them events.
    const row = await t.client.query<{ status: string; attempt: number; next: string | null }>(
      `select status, attempt, next_attempt_at as next from webhook_deliveries
        where organization_id = $1`,
      [org.orgId],
    )
    expect(row.rows[0]!.status).toBe('failed')
    expect(row.rows[0]!.attempt).toBe(1)
    expect(row.rows[0]!.next).not.toBeNull()
  })

  it('refuses an endpoint pointing at a private address', async () => {
    // Not a complete SSRF defence — DNS can still resolve a public name to a
    // private address — but it stops the accidental cases.
    for (const url of [
      'https://localhost/hooks',
      'https://127.0.0.1/hooks',
      'https://10.0.0.5/hooks',
      'https://192.168.1.1/hooks',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      await expect(
        tx((trx) => createEndpoint(trx, ctx, { url, events: ['invoice.issued'] })),
        url,
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
  })

  it('refuses a plain-http endpoint', async () => {
    await expect(
      tx((trx) =>
        createEndpoint(trx, ctx, {
          url: 'http://receiver.example.com/hooks',
          events: ['invoice.issued'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('keeps deliveries scoped to their tenant', async () => {
    await makeEndpoint()
    const other = await seedOrg(t, { name: 'Quiet Co', slug: 'quiet', seats: 5 })

    await tx((trx) =>
      emit(trx, {
        organizationId: org.orgId,
        type: 'invoice.issued',
        entityType: 'invoice',
        entityId: '00000000-0000-0000-0000-0000000000af',
        payload: {},
      }),
    )
    await tx((trx) => fanOut(trx, org.orgId))

    const theirs = await withTenant(t.db, { organizationId: other.orgId }, (trx) =>
      trx.execute(sql`select count(*)::int as n from webhook_deliveries`),
    )
    expect((theirs as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0)
  })
})
