import { NextResponse } from 'next/server'
import { db } from '@/db'
import { withTenant, type TenantTx } from '@/db/tenant'
import { AppError, fromDatabaseError } from '@/lib/errors'
import type { Permission } from '@/auth/permissions'
import { authenticateApiRequest, requireScope, type ApiContext, type RateLimitInfo } from './auth'

/**
 * One wrapper for every API route.
 *
 * Authentication, scope enforcement, tenant scoping, rate-limit headers and
 * error shaping happen here rather than in each handler — the alternative is
 * thirty routes that each get it 95% right, and the 5% is where the tenant
 * leak lives.
 */

export type ApiHandlerContext = {
  ctx: ApiContext
  tx: TenantTx
  searchParams: URLSearchParams
  body: unknown
}

type Handler<T> = (c: ApiHandlerContext) => Promise<T>

function rateLimitHeaders(rl: RateLimitInfo): Record<string, string> {
  return {
    'ratelimit-limit': String(rl.limit),
    'ratelimit-remaining': String(rl.remaining),
    'ratelimit-reset': String(Math.max(0, Math.ceil((rl.resetsAt.getTime() - Date.now()) / 1000))),
  }
}

function errorResponse(err: unknown, headers: Record<string, string> = {}): NextResponse {
  const appErr =
    err instanceof AppError ? err : (fromDatabaseError(err) ?? new AppError('INTERNAL', 'Internal error.'))

  if (appErr.code === 'INTERNAL') {
    // The real cause goes to the server log, never to the client — an
    // unexpected error's message can carry SQL, table names or another
    // tenant's data.
    console.error('[api]', err)
  }

  const body: Record<string, unknown> = {
    error: { code: appErr.code, message: appErr.message },
  }
  if (appErr.code === 'VALIDATION_FAILED' && appErr.details) {
    ;(body.error as Record<string, unknown>).details = appErr.details
  }

  return NextResponse.json(body, { status: appErr.status, headers })
}

/**
 * Builds a route handler.
 *
 * `scope` is required, not optional — an endpoint with no declared scope would
 * be reachable by any valid key for any tenant, so making it a mandatory
 * argument means the mistake cannot be made by omission.
 */
export function apiRoute<T>(scope: Permission, handler: Handler<T>) {
  return async (request: Request): Promise<NextResponse> => {
    let rateLimit: RateLimitInfo | undefined

    try {
      const handle = await db()
      const authed = await authenticateApiRequest(request.headers, handle)
      rateLimit = authed.rateLimit
      requireScope(authed.ctx, scope)

      let body: unknown = undefined
      if (request.method !== 'GET' && request.method !== 'DELETE') {
        const text = await request.text()
        if (text) {
          try {
            body = JSON.parse(text)
          } catch {
            throw new AppError('VALIDATION_FAILED', 'Request body must be valid JSON')
          }
        }
      }

      const searchParams = new URL(request.url).searchParams

      const result = await withTenant(
        handle,
        {
          organizationId: authed.ctx.organizationId,
          requestId: authed.ctx.requestId,
        },
        (tx) => handler({ ctx: authed.ctx, tx, searchParams, body }),
      )

      return NextResponse.json(result as Record<string, unknown>, {
        headers: rateLimitHeaders(authed.rateLimit),
      })
    } catch (err) {
      return errorResponse(err, rateLimit ? rateLimitHeaders(rateLimit) : {})
    }
  }
}

/** Pagination shared by every list endpoint, so `limit`/`offset` mean the same
 *  thing everywhere and no endpoint can be asked for the whole table. */
export function paging(searchParams: URLSearchParams) {
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 50, 1), 200)
  const page = Math.max(Number(searchParams.get('page')) || 1, 1)
  return { limit, page, offset: (page - 1) * limit }
}
