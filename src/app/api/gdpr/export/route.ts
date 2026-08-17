import { NextResponse } from 'next/server'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { AppError } from '@/lib/errors'
import { exportOrganization, exportSubject } from '@/server/gdpr'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Data exports, streamed as a download.
 *
 * A route rather than a server action because the result is a FILE — the
 * browser has to be handed a Content-Disposition, which an action's JSON
 * response cannot do.
 *
 * Nothing is written to disk. `export_jobs.file_url` exists in the schema for a
 * stored-file design, and this deliberately does not use it: a complete dump of
 * a company's customers, staff and ledger sitting behind a URL is a breach
 * waiting for someone to find it. Generated on request, held in memory, gone
 * when the response ends.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { ctx } = await getSession()
  if (!ctx) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } },
      { status: 401 },
    )
  }

  const url = new URL(request.url)
  const subjectType = url.searchParams.get('subjectType')
  const subjectId = url.searchParams.get('subjectId')

  try {
    const handle = await db()
    const { payload, filename } = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      async (tx) => {
        if (subjectType && subjectId) {
          const data = await exportSubject(tx, ctx, { subjectType, subjectId })
          return {
            payload: data as unknown,
            // The subject id, not their name: the filename ends up in a
            // downloads folder, an email attachment and a support ticket, and
            // "sar-annika-vogel.json" identifies them in all three.
            filename: `syncrese-subject-${subjectId}.json`,
          }
        }
        const data = await exportOrganization(tx, ctx)
        return { payload: data as unknown, filename: `syncrese-export-${ctx.organizationId}.json` }
      },
    )

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        // Personal data must not sit in a shared cache or a CDN edge.
        'cache-control': 'no-store, private',
      },
    }) as NextResponse
  } catch (err) {
    if (err instanceof AppError) {
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.status },
      )
    }
    console.error('[gdpr] export failed:', err)
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Export failed.' } },
      { status: 500 },
    )
  }
}
