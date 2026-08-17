import { and, eq, sql } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { apiKeys } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { hashOpaqueToken } from '@/auth/password'
import { PERMISSIONS, type Permission } from '@/auth/permissions'
import type { RequestContext } from '@/server/context'

/**
 * Per-tenant API keys (MUST DO #8, #18).
 *
 * Format: `syn_live_<43 base64url chars>` — 32 bytes of entropy, which is far
 * beyond brute-forcing, so a SHA-256 hash is the right store rather than a slow
 * KDF. Passwords get argon2 because they are low-entropy and human-chosen;
 * verifying a key on every single API request with argon2's memory cost would
 * be a self-inflicted denial of service.
 *
 * THE PREFIX IS `syn_`, NOT `sk_`.
 *
 * These were `sk_live_` / `sk_test_`, copying Stripe. That collides with
 * Stripe's own namespace, and this product talks to Stripe — so two unrelated
 * credentials would have looked identical in the same system, and pasting one
 * where the other belongs is the kind of mistake that is obvious only
 * afterwards.
 *
 * It also trips every secret scanner in existence. GitHub blocked a push over
 * the PLACEHOLDER in docs/02-api.md, which was a row of x's; a customer
 * committing a real key would have it flagged as a leaked Stripe key, in their
 * repository, with whatever reporting that triggers on their side.
 *
 * Changed while no key had ever been issued. Later it would have meant
 * invalidating every integration in the field.
 */

const PREFIX_LIVE = 'syn_live_'
const PREFIX_TEST = 'syn_test_'

export const createKeySchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.string()).min(1).max(64),
  rateLimitPerMinute: z.number().int().min(1).max(6000).default(120),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  test: z.boolean().default(false),
})

export type IssuedKey = {
  id: string
  name: string
  /** The ONLY time the plaintext exists. Never stored, never recoverable. */
  secret: string
  prefix: string
  scopes: string[]
}

/**
 * Issues a key.
 *
 * The requested scopes must be a SUBSET of what the creating user actually
 * holds — otherwise any Sales user could mint themselves an Owner-scoped key
 * and bypass RBAC entirely. The scopes are then FROZEN on the key: if that user
 * is later promoted, their old integration key must not silently gain new
 * powers, and if they are demoted or leave, the key keeps working at the level
 * it was authorised for until someone revokes it.
 */
export async function issueApiKey(
  tx: TenantTx,
  ctx: RequestContext,
  input: unknown,
): Promise<IssuedKey> {
  const parsed = createKeySchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid API key request', parsed.error.issues)
  }
  const { name, scopes, rateLimitPerMinute, expiresInDays, test } = parsed.data

  const unknown = scopes.filter((s) => !(s in PERMISSIONS))
  if (unknown.length > 0) {
    throw new AppError('VALIDATION_FAILED', `Unknown scope(s): ${unknown.join(', ')}`)
  }

  const beyond = scopes.filter((s) => !ctx.permissions.has(s as Permission))
  if (beyond.length > 0) {
    throw new AppError(
      'FORBIDDEN',
      `You cannot grant a key permissions you do not hold: ${beyond.join(', ')}`,
    )
  }

  const secret = `${test ? PREFIX_TEST : PREFIX_LIVE}${randomBytes(32).toString('base64url')}`
  const id = newId()
  const prefix = secret.slice(0, 16)

  await tx.insert(apiKeys).values({
    id,
    organizationId: ctx.organizationId,
    name,
    keyHash: hashOpaqueToken(secret),
    keyPrefix: prefix,
    scopes,
    rateLimitPerMinute,
    expiresAt: expiresInDays
      ? new Date(Date.now() + expiresInDays * 86_400_000)
      : null,
    createdBy: ctx.userId,
  })

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'api_key.issued',
    entityType: 'api_key',
    entityId: id,
    // The secret must never reach the audit trail — anyone with audit.read
    // would then hold a working credential.
    after: { name, prefix, scopes, rateLimitPerMinute },
    requestId: ctx.requestId,
    ip: ctx.ip,
  })

  return { id, name, secret, prefix, scopes }
}

export async function revokeApiKey(
  tx: TenantTx,
  ctx: RequestContext,
  keyId: string,
  reason?: string,
): Promise<void> {
  const result = await tx
    .update(apiKeys)
    .set({ revokedAt: new Date(), revokedReason: reason ?? null })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, ctx.organizationId)))
    .returning({ id: apiKeys.id, name: apiKeys.name })

  if (result.length === 0) throw new AppError('NOT_FOUND', 'API key not found')

  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action: 'api_key.revoked',
    entityType: 'api_key',
    entityId: keyId,
    after: { name: result[0]!.name, reason },
    requestId: ctx.requestId,
  })
}

export async function listApiKeys(tx: TenantTx, organizationId: string) {
  const res = await tx.execute(sql`
    select id, name, key_prefix as "keyPrefix", scopes,
           rate_limit_per_minute as "rateLimitPerMinute",
           last_used_at as "lastUsedAt", expires_at as "expiresAt",
           revoked_at as "revokedAt", created_at as "createdAt"
      from api_keys
     where organization_id = ${organizationId}
     order by revoked_at nulls first, created_at desc
  `)
  return (res as unknown as { rows: Record<string, unknown>[] }).rows
}
