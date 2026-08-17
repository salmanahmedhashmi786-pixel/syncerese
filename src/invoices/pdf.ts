import PDFDocument from 'pdfkit'
import { decimal, type InvoiceDocument, type DocumentParty } from './document'
import { INVOICE_FONT_BOLD, INVOICE_FONT_REGULAR } from './fonts'

/**
 * The invoice as a PDF.
 *
 * WHY NOT A HEADLESS BROWSER
 *
 * Rendering the print view with Puppeteer would guarantee the PDF and the
 * printed page look identical, which is genuinely attractive. It also means
 * shipping a ~300MB Chromium into every deployment, and it does not run on
 * serverless without a special build. For a document that is a header, a table
 * and a totals block, a PDF writer is the proportionate tool.
 *
 * The cost is real and worth stating: this and the print view are two renderers
 * of the same document, so they can drift in APPEARANCE. They cannot drift in
 * CONTENT, because both are pure functions of `InvoiceDocument` and neither
 * queries anything — see the comment there about why that matters more.
 *
 * FONTS AND EUROPEAN TEXT
 *
 * DejaVu Sans, subsetted and embedded — see ./fonts.ts. The built-in Helvetica
 * uses WinAnsi encoding, which has no glyph for Polish (ą ć ę ł ń ś ź ż), Czech
 * (č ď ě ň ř š ť ů ž) or Hungarian (ő ű), so a customer called Łukasiewicz
 * rendered as a question mark. For a product sold across the EU that is not a
 * cosmetic defect: it is the customer's own name, on a legal document.
 */

/** A4 in PostScript points, and a 50pt margin — roughly 18mm, which fits every
 *  European window envelope this is likely to be posted in. */
const PAGE = { size: 'A4' as const, margin: 50 }

/** Names for the embedded faces. Naming a built-in instead — 'Helvetica' and
 *  friends — silently reintroduces WinAnsi and the missing glyphs with it. */
const BODY = 'Syncrese'
const BOLD = 'Syncrese-Bold'
const CONTENT_WIDTH = 595.28 - PAGE.margin * 2

type Column = { label: string; width: number; align: 'left' | 'right' }

const COLUMNS: Column[] = [
  { label: 'Description', width: 210, align: 'left' },
  { label: 'Qty', width: 50, align: 'right' },
  { label: 'Unit price', width: 80, align: 'right' },
  { label: 'VAT', width: 45, align: 'right' },
  { label: 'Net', width: 110, align: 'right' },
]

export function invoiceFilename(doc: InvoiceDocument): string {
  return `${doc.invoiceNo.replace(/[^A-Za-z0-9._-]/g, '-')}.pdf`
}

/**
 * Renders to a Buffer.
 *
 * Buffered rather than streamed: an invoice is a handful of kilobytes, the
 * caller needs a Content-Length, and streaming would complicate every route for
 * no measurable gain.
 */
export function renderInvoicePdf(doc: InvoiceDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: PAGE.size, margin: PAGE.margin })

    // Registered before anything is drawn. pdfkit embeds only the glyphs this
    // document actually uses, so a subsetted face costs the output almost
    // nothing while covering every Latin-script customer name.
    pdf.registerFont(BODY, INVOICE_FONT_REGULAR)
    pdf.registerFont(BOLD, INVOICE_FONT_BOLD)
    pdf.font(BODY)
    const chunks: Buffer[] = []
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk))
    pdf.on('end', () => resolve(Buffer.concat(chunks)))
    pdf.on('error', reject)

    try {
      draw(pdf, doc)
      pdf.end()
    } catch (err) {
      reject(err)
    }
  })
}

function draw(pdf: PDFKit.PDFDocument, doc: InvoiceDocument): void {
  const money = (minor: number) => `${doc.currencyCode} ${decimal(minor, doc.currencyScale)}`
  const title = doc.isCreditNote ? 'Credit note' : 'Invoice'

  // --- header --------------------------------------------------------------
  pdf.fontSize(20).font(BOLD).text(doc.seller.name, PAGE.margin, PAGE.margin)
  pdf
    .fontSize(18)
    .font(BOLD)
    .text(title, PAGE.margin, PAGE.margin, { width: CONTENT_WIDTH, align: 'right' })

  pdf.moveDown(0.4)
  pdf.fontSize(9).font(BODY).fillColor('#555')
  if (doc.seller.legalName && doc.seller.legalName !== doc.seller.name) {
    pdf.text(doc.seller.legalName)
  }
  if (doc.seller.taxId) pdf.text(`VAT ${doc.seller.taxId}`)
  pdf.fillColor('#000')

  // --- parties and dates ---------------------------------------------------
  const detailsTop = 130
  pdf.fontSize(8).fillColor('#555').text('BILL TO', PAGE.margin, detailsTop)
  pdf.fillColor('#000').fontSize(10).font(BOLD)
  pdf.text(doc.buyer.name, PAGE.margin, detailsTop + 13, { width: 260 })
  pdf.font(BODY).fontSize(9.5)
  for (const line of addressLines(doc.buyer)) {
    pdf.text(line, { width: 260 })
  }

  // Right column: the facts somebody quotes back on the phone.
  const facts = (
    [
      [`${title} number`, doc.invoiceNo],
      ['Issue date', doc.issueDate],
      // A credit note has no due date — it reduces what is owed rather than
      // creating an obligation with a deadline.
      ['Due date', doc.isCreditNote ? null : doc.dueDate],
      ['Delivery date', doc.deliveryDate],
      ['Your reference', doc.buyerReference],
      ['Order reference', doc.orderReference],
    ] as [string, string | null][]
  ).filter((f): f is [string, string] => Boolean(f[1]))

  let y = detailsTop
  for (const [key, value] of facts) {
    pdf.fontSize(8).fillColor('#555').text(key.toUpperCase(), 340, y, { width: 90 })
    pdf.fontSize(9.5).fillColor('#000').text(value, 435, y, {
      width: CONTENT_WIDTH - 385,
      align: 'right',
    })
    y += 15
  }

  // --- line table ----------------------------------------------------------
  let cursor = Math.max(y, detailsTop + 90) + 18
  cursor = drawTableHeader(pdf, cursor)

  for (const line of doc.lines) {
    // A description can wrap, so the row height is measured before drawing
    // rather than assumed — otherwise a long line silently overlaps the next.
    const descriptionHeight = pdf
      .fontSize(9.5)
      .font(BODY)
      .heightOfString(line.description, { width: COLUMNS[0]!.width - 8 })
    const rowHeight = Math.max(descriptionHeight, 12) + 8

    if (cursor + rowHeight > 720) {
      pdf.addPage()
      cursor = drawTableHeader(pdf, PAGE.margin)
    }

    const cells = [
      line.description,
      trimQuantity(line.quantity),
      decimal(line.unitPriceMinor, doc.currencyScale),
      line.taxPercent ? `${trimPercent(line.taxPercent)}%` : '—',
      decimal(line.netMinor, doc.currencyScale),
    ]

    let x = PAGE.margin
    cells.forEach((cell, i) => {
      const column = COLUMNS[i]!
      pdf.fontSize(9.5).font(BODY).fillColor('#000')
      pdf.text(cell, x, cursor, { width: column.width - 8, align: column.align })
      x += column.width
    })

    cursor += rowHeight
    pdf.moveTo(PAGE.margin, cursor - 4).lineTo(PAGE.margin + CONTENT_WIDTH, cursor - 4)
      .strokeColor('#eee').lineWidth(0.5).stroke()
  }

  // --- totals --------------------------------------------------------------
  cursor += 10
  const totalsLeft = PAGE.margin + CONTENT_WIDTH - 240

  const totals: [string, string, boolean][] = [
    ['Net', money(doc.subtotalMinor), false],
    ...doc.taxSubtotals.map(
      (t): [string, string, boolean] => [
        `VAT ${trimPercent(t.percent)}%${t.category && t.category !== 'S' ? ` (${t.category})` : ''}`,
        money(t.taxMinor),
        false,
      ],
    ),
    ['Total', money(doc.totalMinor), true],
  ]

  if (!doc.isCreditNote && (doc.amountPaidMinor > 0 || doc.creditedMinor > 0)) {
    if (doc.amountPaidMinor > 0) totals.push(['Paid', `− ${money(doc.amountPaidMinor)}`, false])
    if (doc.creditedMinor > 0) totals.push(['Credited', `− ${money(doc.creditedMinor)}`, false])
    totals.push(['Due', money(doc.dueMinor), true])
  }

  for (const [key, value, strong] of totals) {
    if (strong) {
      pdf.moveTo(totalsLeft, cursor - 3).lineTo(PAGE.margin + CONTENT_WIDTH, cursor - 3)
        .strokeColor('#000').lineWidth(0.7).stroke()
      cursor += 4
    }
    pdf
      .fontSize(strong ? 11 : 9.5)
      .font(strong ? BOLD : BODY)
      .fillColor('#000')
    pdf.text(key, totalsLeft, cursor, { width: 110 })
    pdf.text(value, totalsLeft + 110, cursor, { width: 130, align: 'right' })
    cursor += strong ? 18 : 14
  }

  // --- payment and notes ---------------------------------------------------
  cursor += 16
  if (doc.payee?.iban && !doc.isCreditNote) {
    pdf.fontSize(8).fillColor('#555').text('PAYMENT', PAGE.margin, cursor)
    cursor += 12
    pdf.fontSize(9.5).fillColor('#000').text(doc.payee.name, PAGE.margin, cursor)
    cursor += 12
    pdf.text(`IBAN ${doc.payee.iban}`, PAGE.margin, cursor)
    cursor += 12
    if (doc.payee.bic) {
      pdf.text(`BIC ${doc.payee.bic}`, PAGE.margin, cursor)
      cursor += 12
    }
    // Quoting the invoice number is what lets the payment be matched
    // automatically at the other end.
    pdf.fillColor('#555').text(`Please quote ${doc.invoiceNo}`, PAGE.margin, cursor)
    cursor += 16
  }

  if (doc.paymentTerms) {
    pdf.fontSize(9).fillColor('#555').text(doc.paymentTerms, PAGE.margin, cursor, {
      width: CONTENT_WIDTH,
    })
    cursor += 14
  }
  if (doc.notes) {
    pdf.fontSize(9).fillColor('#555').text(doc.notes, PAGE.margin, cursor, {
      width: CONTENT_WIDTH,
    })
  }
}

function drawTableHeader(pdf: PDFKit.PDFDocument, top: number): number {
  let x = PAGE.margin
  pdf.fontSize(8).font(BOLD).fillColor('#555')
  for (const column of COLUMNS) {
    pdf.text(column.label.toUpperCase(), x, top, {
      width: column.width - 8,
      align: column.align,
    })
    x += column.width
  }
  const bottom = top + 14
  pdf.moveTo(PAGE.margin, bottom).lineTo(PAGE.margin + CONTENT_WIDTH, bottom)
    .strokeColor('#000').lineWidth(0.7).stroke()
  pdf.fillColor('#000')
  return bottom + 8
}

function addressLines(party: DocumentParty): string[] {
  return [
    party.legalName && party.legalName !== party.name ? party.legalName : null,
    party.street,
    [party.postcode, party.city].filter(Boolean).join(' ') || null,
    party.region,
    party.countryCode,
    party.taxId ? `VAT ${party.taxId}` : null,
  ].filter((line): line is string => Boolean(line))
}

/** "2.0000" → "2", "1.5000" → "1.5". A quantity column full of trailing zeroes
 *  reads as a database dump rather than a document. */
function trimQuantity(quantity: string): string {
  const n = Number(quantity)
  return Number.isFinite(n) ? String(Number(n.toFixed(4))) : quantity
}

function trimPercent(percent: string): string {
  const n = Number(percent)
  return Number.isFinite(n) ? String(Number(n.toFixed(4))) : percent
}
