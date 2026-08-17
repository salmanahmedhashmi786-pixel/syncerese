import { apiRoute, paging } from '@/api/handler'
import { logApiRead } from '@/api/auth'
import { emit } from '@/api/events'
import { listModule } from '@/modules/queries'
import { parseFilter } from '@/modules/filters'
import { createInvoice, issueInvoice } from '@/finance/invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/v1/invoices
 *
 * Reuses the same `listModule` query the UI uses, so filtering, sorting and
 * paging behave identically through the API and on screen. Two implementations
 * of "which invoices are overdue" would eventually disagree, and the one the
 * customer's integration sees is the one they would believe.
 */
export const GET = apiRoute('invoice.read', async ({ ctx, tx, searchParams }) => {
  const { limit, page } = paging(searchParams)
  const today = new Date().toISOString().slice(0, 10)

  let filter
  const raw = searchParams.get('filter')
  if (raw) {
    try {
      filter = parseFilter(JSON.parse(raw))
    } catch {
      filter = undefined
    }
  }

  const result = await listModule(
    tx,
    ctx.organizationId,
    'invoices',
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

  await logApiRead(tx, ctx, 'invoices', result.rows.length)

  return {
    data: result.rows,
    meta: { page: result.page, pageSize: result.pageSize, total: result.total, pageCount: result.pageCount },
  }
})

/**
 * POST /api/v1/invoices
 *
 * Creates a draft, and issues it when `issue: true` — the same service the UI
 * calls, so an invoice created through the API posts to the ledger under
 * exactly the same double-entry rules.
 */
export const POST = apiRoute('invoice.create', async ({ ctx, tx, body }) => {
  const input = body as Record<string, unknown>
  const actor = { organizationId: ctx.organizationId, userId: null, requestId: ctx.requestId }

  const created = await createInvoice(tx, actor, input as never)

  await emit(tx, {
    organizationId: ctx.organizationId,
    type: 'invoice.created',
    entityType: 'invoice',
    entityId: created.id,
    payload: { invoiceNo: created.invoiceNo, totalMinor: created.totalMinor },
  })

  if (input.issue === true) {
    await issueInvoice(tx, actor, created.id)
    await emit(tx, {
      organizationId: ctx.organizationId,
      type: 'invoice.issued',
      entityType: 'invoice',
      entityId: created.id,
      payload: { invoiceNo: created.invoiceNo, totalMinor: created.totalMinor },
    })
  }

  return {
    data: {
      id: created.id,
      invoiceNo: created.invoiceNo,
      totalMinor: created.totalMinor,
      status: input.issue === true ? 'issued' : 'draft',
    },
  }
})
