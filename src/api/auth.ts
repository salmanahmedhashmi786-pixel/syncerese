import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { withoutTenantScope, withTenant, type AnyDb, type TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { hashOpaqueToken } from '@/auth/password'
import type { Permission } from '@/auth/permissions'
import { writeAccess } from '@/lib/audit'

/**
 * API request authentication (MUST DO #8, #18).
 *
 * A key identifies a TENANT, not a user. `ApiContext` deliberately mirrors the
 * shape of the session `RequestContext` so the service layer beneath is
 * identical whether a call arrives from the UI or from curl — one set of
 * business rules, not two that drift.
 */
export type ApiContext = {
  organizationId: string
  apiKeyId: string
  scopes: Set<string>
  requestId: string | null
  ip: string | null
  userAgent: string | null
}

export type RateLimitInfo = {
  limit: number
  used: number
  remaining: number
  resetsAt: Date
}

export type AuthedRequest = { ctx: ApiContext; rateLimit: RateLimitInfo }

const BEARER = /^Bearer\s+(.+)$/i

export function extractToken(headers: Headers): string | null {
  const auth = headers.get('authorization')
  if (!auth) return null
  const m = BEARER.exec(auth.trim())
  return m ? m[1]!.trim() : null
}

/**
 * Resolves a bearer token to a tenant context and consumes one unit of rate
 * limit.
 *
 * Lookup goes through the `resolve_api_key` SECURITY DEFINER function: which
 * tenant the key belongs to is exactly what we are determining, so there is no
 * `app.org_id` to scope by yet. Once resolved, every subsequent query runs
 * inside `withTenant` under normal RLS.
 *
 * Revoked and expired keys are rejected with the same 401 as an unknown key —
 * distinguishing them tells an attacker which of their guesses was once real.
 */
export async function authenticateApiRequest(
  headers: Headers,
  handle?: AnyDb,
): Promise<AuthedRequest> {
  const token = extractToken(headers)
  if (!token) {
    throw new AppError('UNAUTHENTICATED', 'Provide an API key as a bearer token.')
  }

  const dbHandle = handle ?? (await db())
  const keyHash = hashOpaqueToken(token)

  const resolved = await withoutTenantScope(dbHandle, async (tx) => {
    const res = await tx.execute(sql`select * from public.resolve_api_key(${keyHash})`)
    return (
      res as unknown as {
        rows: {
          api_key_id: string
          organization_id: string
          scopes: string[]
          rate_limit: number
          revoked: boolean
          expired: boolean
        }[]
      }
    ).rows[0]
  })

  if (!resolved || resolved.revoked || resolved.expired) {
    throw new AppError('UNAUTHENTICATED', 'Invalid API key.')
  }

  const limit = await withTenant(
    dbHandle,
    { organizationId: resolved.organization_id },
    async (tx) => {
      const res = await tx.execute(
        sql`select * from public.consume_rate_limit(${resolved.api_key_id}::uuid)`,
      )
      return (
        res as unknown as {
          rows: { allowed: boolean; used: number; limit_per_minute: number; resets_at: string }[]
        }
      ).rows[0]!
    },
  )

  const rateLimit: RateLimitInfo = {
    limit: Number(limit.limit_per_minute),
    used: Number(limit.used),
    remaining: Math.max(0, Number(limit.limit_per_minute) - Number(limit.used)),
    resetsAt: new Date(limit.resets_at),
  }

  if (!limit.allowed) {
    throw new AppError('RATE_LIMITED', 'Rate limit exceeded. Slow down and retry.', rateLimit)
  }

  return {
    ctx: {
      organizationId: resolved.organization_id,
      apiKeyId: resolved.api_key_id,
      scopes: new Set(resolved.scopes ?? []),
      requestId: headers.get('x-request-id'),
      ip: headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      userAgent: headers.get('user-agent'),
    },
    rateLimit,
  }
}

/** Server-side scope check. Every route calls this before doing anything. */
export function requireScope(ctx: ApiContext, scope: Permission): void {
  if (!ctx.scopes.has(scope)) {
    throw new AppError('FORBIDDEN', `This API key lacks the "${scope}" scope.`)
  }
}

/**
 * Records a read through the API.
 *
 * MUST DO #15 asks to be able to reconstruct "who accessed what" within GDPR's
 * 72-hour window, and an integration pulling every contact nightly is exactly
 * the access pattern that matters. `rowCount` is also the anomaly signal from
 * MUST DO #18.
 */
export async function logApiRead(
  tx: TenantTx,
  ctx: ApiContext,
  resource: string,
  rowCount: number,
  action: 'list' | 'read' | 'export' = 'list',
): Promise<void> {
  await writeAccess(tx, {
    organizationId: ctx.organizationId,
    userId: null,
    resource,
    resourceId: ctx.apiKeyId,
    action,
    rowCount,
    ip: ctx.ip,
    requestId: ctx.requestId,
  })
}
