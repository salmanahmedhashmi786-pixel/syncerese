import { NextResponse } from 'next/server'
import { db } from '@/db'
import { withTenant } from '@/db/tenant'
import { getSession } from '@/server/session'
import { AppError } from '@/lib/errors'
import { writeAudit } from '@/lib/audit'
import { invoiceDocument } from '@/invoices/document'
import { invoiceFilename, renderInvoicePdf } from '@/invoices/pdf'
import { EInvoiceError, toUbl, ublFilename } from '@/einvoice/ubl'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Downloading an invoice as a PDF or as an EN 16931 XML document.
 *
 * One route for both, because they are two renderings of one document and
 * splitting them would invite two different permission checks. The format is a
 * query parameter, and everything else — the tenant transaction, the
 * permission, the audit entry — is shared.
 *
 * Both are generated on demand and never stored. There is therefore no file
 * sitting in a bucket waiting to be found, and no cache to invalidate when an
 * invoice is credited.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { ctx } = await getSession()
  if (!ctx) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } },
      { status: 401 },
    )
  }

  const { id } = await context.params
  const format = new URL(request.url).searchParams.get('format') ?? 'pdf'
  if (format !== 'pdf' && format !== 'xml') {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'format must be pdf or xml.' } },
      { status: 400 },
    )
  }

  try {
    const handle = await db()
    const doc = await withTenant(
      handle,
      { organizationId: ctx.organizationId, userId: ctx.userId, requestId: ctx.requestId },
      async (tx) => {
        const document = await invoiceDocument(tx, ctx, id)
        // Audited inside the same transaction as the read. Taking a copy of an
        // invoice out of the system is exactly what the access log is for, and
        // an unusually large run of these is the anomaly worth noticing.
        await writeAudit(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'invoice.downloaded',
          entityType: 'invoice',
          entityId: id,
          after: { format },
          requestId: ctx.requestId,
          ip: ctx.ip,
        })
        return document
      },
    )

    if (format === 'xml') {
      const xml = toUbl(doc)
      return new NextResponse(xml, {
        headers: {
          'content-type': 'application/xml; charset=utf-8',
          'content-disposition': `attachment; filename="${ublFilename(doc)}"`,
          'cache-control': 'no-store',
        },
      })
    }

    const pdf = await renderInvoicePdf(doc)
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${invoiceFilename(doc)}"`,
        'content-length': String(pdf.byteLength),
        'cache-control': 'no-store',
      },
    })
  } catch (err) {
    if (err instanceof EInvoiceError) {
      // The violations, not a generic failure: the whole point of checking
      // before emitting is that somebody can act on the answer. "The customer
      // has no country on file" is fixable; "invalid document" is not.
      return NextResponse.json(
        {
          error: {
            code: 'EINVOICE_INVALID',
            message: 'This invoice is not yet a valid e-invoice.',
            violations: err.violations,
          },
        },
        { status: 422 },
      )
    }
    if (err instanceof AppError) {
      // AppError already carries the right status for its code — mapping it
      // again here would be a second table to keep in step.
      return NextResponse.json(
        { error: { code: err.code, message: err.message } },
        { status: err.status },
      )
    }
    console.error('[invoice-document]', err)
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Could not produce the document.' } },
      { status: 500 },
    )
  }
}
