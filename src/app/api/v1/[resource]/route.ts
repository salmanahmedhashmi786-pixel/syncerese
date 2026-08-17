import { NextResponse } from 'next/server'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { AppError, fromDatabaseError } from '@/lib/errors'
import { authenticateApiRequest, logApiRead, requireScope } from '@/api/auth'
import { paging } from '@/api/handler'
import { listModule } from '@/modules/queries'
import { parseFilter, type Filter } from '@/modules/filters'
import { MODULES, moduleById, type ModuleId } from '@/modules/registry'
import type { Permission } from '@/auth/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Generic read endpoint for every table module.
 *
 * `GET /api/v1/{customers|sales-orders|purchase-orders|products|deals|journal|banking}`
 *
 * Rather than hand-writing seven near-identical handlers, this resolves the
 * resource against the module registry — the same registry that drives the
 * sidebar and the table screen. A new module gets an API endpoint the moment it
 * is registered, and cannot be accidentally exposed without a declared
 * permission, because the registry entry requires one.
 *
 * Not wrapped in `apiRoute` because the scope is resolved from the path rather
 * than known at module load.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ resource: string }> },
): Promise<NextResponse> {
  const { resource } = await params

  try {
    const module = moduleById(resource)
    if (!module || module.kind !== 'table') {
      throw new AppError(
        'NOT_FOUND',
        `Unknown resource "${resource}". Available: ${MODULES.filter((m) => m.kind === 'table')
          .map((m) => m.id)
          .join(', ')}`,
      )
    }

    const handle = await db()
    const { ctx, rateLimit } = await authenticateApiRequest(request.headers, handle)
    requireScope(ctx, module.permission as Permission)

    const searchParams = new URL(request.url).searchParams
    const { limit, page } = paging(searchParams)
    const today = new Date().toISOString().slice(0, 10)

    let filter: Filter | undefined
    const raw = searchParams.get('filter')
    if (raw) {
      try {
        filter = parseFilter(JSON.parse(raw))
      } catch {
        filter = undefined
      }
    }

    const result = await withTenant(
      handle,
      { organizationId: ctx.organizationId, requestId: ctx.requestId },
      async (tx) => {
        const listed = await listModule(
          tx,
          ctx.organizationId,
          module.id as ModuleId,
          {
            q: searchParams.get('q') ?? undefined,
            status: searchParams.get('status') ?? undefined,
            sort: searchParams.get('sort') ?? undefined,
            dir: searchParams.get('dir') === 'asc' ? 'asc' : 'desc',
            page,
            pageSize: limit,
            filter,
          },
          today,
        )
        await logApiRead(tx, ctx, module.id, listed.rows.length)
        return listed
      },
    )

    return NextResponse.json(
      {
        data: result.rows,
        meta: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          pageCount: result.pageCount,
        },
      },
      {
        headers: {
          'ratelimit-limit': String(rateLimit.limit),
          'ratelimit-remaining': String(rateLimit.remaining),
          'ratelimit-reset': String(
            Math.max(0, Math.ceil((rateLimit.resetsAt.getTime() - Date.now()) / 1000)),
          ),
        },
      },
    )
  } catch (err) {
    const appErr =
      err instanceof AppError
        ? err
        : (fromDatabaseError(err) ?? new AppError('INTERNAL', 'Internal error.'))
    if (appErr.code === 'INTERNAL') console.error('[api]', err)
    return NextResponse.json(
      { error: { code: appErr.code, message: appErr.message } },
      { status: appErr.status },
    )
  }
}
