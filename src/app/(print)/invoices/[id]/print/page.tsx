import { notFound } from 'next/navigation'
import { getSession, tenantQuery } from '@/server/session'
import { AppError } from '@/lib/errors'
import { decimal, type InvoiceDocument } from '@/invoices/document'
import { invoiceDocument } from '@/invoices/document'
import { PrintTrigger } from './PrintTrigger'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Print' }

/**
 * The printable invoice.
 *
 * Outside the `(app)` layout on purpose — no sidebar, no header, no theme
 * chrome. A print stylesheet that has to fight an application shell ends up
 * hiding things by selector, and the first component someone adds to the shell
 * reappears in the middle of a customer's invoice.
 *
 * WHY THIS EXISTS ALONGSIDE THE PDF
 *
 * Printing from here uses the browser's own renderer, which means correct
 * Unicode for every European language — something the PDF's built-in font
 * cannot do (see src/invoices/pdf.ts). It also gives "Save as PDF" through the
 * OS dialog for free, and it works inside the desktop app's instance webview,
 * which has no native IPC and therefore cannot open a print dialog any other
 * way.
 *
 * Both read the same `InvoiceDocument`, so they can differ in appearance and
 * cannot differ in what they say a number is.
 */
export default async function InvoicePrintPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { ctx } = await getSession()
  if (!ctx) notFound()

  let doc: InvoiceDocument
  try {
    doc = await tenantQuery((tx) => invoiceDocument(tx, ctx, id))
  } catch (err) {
    if (err instanceof AppError) notFound()
    throw err
  }

  const money = (minor: number) => `${doc.currencyCode} ${decimal(minor, doc.currencyScale)}`
  const title = doc.isCreditNote ? 'Credit note' : 'Invoice'

  return (
    <>
      <PrintTrigger />

      <article className="sheet">
        <header className="head">
          <div>
            <h1>{doc.seller.name}</h1>
            {doc.seller.legalName && doc.seller.legalName !== doc.seller.name && (
              <div className="mut">{doc.seller.legalName}</div>
            )}
            {doc.seller.taxId && <div className="mut">VAT {doc.seller.taxId}</div>}
          </div>
          <div className="doctype">{title}</div>
        </header>

        <section className="parties">
          <div>
            <div className="label">Bill to</div>
            <div className="strong">{doc.buyer.name}</div>
            {doc.buyer.legalName && doc.buyer.legalName !== doc.buyer.name && (
              <div>{doc.buyer.legalName}</div>
            )}
            {doc.buyer.street && <div>{doc.buyer.street}</div>}
            {(doc.buyer.postcode || doc.buyer.city) && (
              <div>{[doc.buyer.postcode, doc.buyer.city].filter(Boolean).join(' ')}</div>
            )}
            {doc.buyer.countryCode && <div>{doc.buyer.countryCode}</div>}
            {doc.buyer.taxId && <div>VAT {doc.buyer.taxId}</div>}
          </div>

          <dl className="facts">
            <Fact label={`${title} number`} value={doc.invoiceNo} />
            <Fact label="Issue date" value={doc.issueDate} />
            {/* A credit note has no due date: it reduces what is owed rather
                than creating an obligation with a deadline. */}
            {!doc.isCreditNote && <Fact label="Due date" value={doc.dueDate} />}
            <Fact label="Delivery date" value={doc.deliveryDate} />
            <Fact label="Your reference" value={doc.buyerReference} />
            <Fact label="Order reference" value={doc.orderReference} />
          </dl>
        </section>

        <table className="lines">
          <thead>
            <tr>
              <th>Description</th>
              <th className="r">Qty</th>
              <th className="r">Unit price</th>
              <th className="r">VAT</th>
              <th className="r">Net</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((line) => (
              <tr key={line.lineNo}>
                <td>{line.description}</td>
                <td className="r">{trim(line.quantity)}</td>
                <td className="r num">{decimal(line.unitPriceMinor, doc.currencyScale)}</td>
                <td className="r">{line.taxPercent ? `${trim(line.taxPercent)}%` : '—'}</td>
                <td className="r num">{decimal(line.netMinor, doc.currencyScale)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="totals">
          <Row label="Net" value={money(doc.subtotalMinor)} />
          {doc.taxSubtotals.map((t) => (
            <Row
              key={`${t.category}:${t.percent}`}
              label={`VAT ${trim(t.percent)}%${t.category && t.category !== 'S' ? ` (${t.category})` : ''}`}
              value={money(t.taxMinor)}
            />
          ))}
          <Row label="Total" value={money(doc.totalMinor)} strong />

          {!doc.isCreditNote && (doc.amountPaidMinor > 0 || doc.creditedMinor > 0) && (
            <>
              {doc.amountPaidMinor > 0 && (
                <Row label="Paid" value={`− ${money(doc.amountPaidMinor)}`} />
              )}
              {doc.creditedMinor > 0 && (
                <Row label="Credited" value={`− ${money(doc.creditedMinor)}`} />
              )}
              <Row label="Due" value={money(doc.dueMinor)} strong />
            </>
          )}
        </section>

        {doc.payee?.iban && !doc.isCreditNote && (
          <section className="pay">
            <div className="label">Payment</div>
            <div>{doc.payee.name}</div>
            <div className="num">IBAN {doc.payee.iban}</div>
            {doc.payee.bic && <div className="num">BIC {doc.payee.bic}</div>}
            {/* Quoting the number is what lets the payment be matched
                automatically when it lands. */}
            <div className="mut">Please quote {doc.invoiceNo}</div>
          </section>
        )}

        {(doc.paymentTerms || doc.notes) && (
          <footer className="notes">
            {doc.paymentTerms && <p>{doc.paymentTerms}</p>}
            {doc.notes && <p>{doc.notes}</p>}
          </footer>
        )}
      </article>
    </>
  )
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={strong ? 'row strong' : 'row'}>
      <span>{label}</span>
      <span className="num">{value}</span>
    </div>
  )
}

/** "2.0000" → "2". A column of trailing zeroes reads as a database dump. */
function trim(value: string): string {
  const n = Number(value)
  return Number.isFinite(n) ? String(Number(n.toFixed(4))) : value
}
