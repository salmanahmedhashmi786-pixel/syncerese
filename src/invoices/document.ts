import { sql } from 'drizzle-orm'
import type { TenantTx } from '@/db/tenant'
import { type RequestContext, requirePermission } from '@/server/context'
import { AppError } from '@/lib/errors'
import { minorUnitsFor } from '@/finance/money'

/**
 * The invoice as a legal document — one model, read by every renderer.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * There are three outputs: a printed page, a PDF, and an EN 16931 XML document.
 * The obvious way to build them is three functions each querying what they
 * need. The failure that produces is not cosmetic: the PDF the customer files
 * says €1,204.00 and the XML their accounting system ingests says €1,240.00,
 * and nobody notices until a VAT return disagrees with a bank statement.
 *
 * So the document is assembled once, here, and the renderers are pure functions
 * of it. They can differ in what they SHOW — the XML carries scheme identifiers
 * a printed page has no use for — but they cannot differ in what they say a
 * number is.
 *
 * Amounts stay in minor units the whole way through. Each renderer converts at
 * the very end, using the currency's own scale, because 124000 is ¥124,000 in
 * JPY and €1,240.00 in EUR and a shared `/100` is a rounding bug with a
 * nationality.
 */

export type DocumentParty = {
  name: string
  legalName: string | null
  taxId: string | null
  countryCode: string | null
  street: string | null
  city: string | null
  postcode: string | null
  region: string | null
}

export type DocumentLine = {
  lineNo: number
  description: string
  quantity: string
  unitCode: string
  unitPriceMinor: number
  discountMinor: number
  netMinor: number
  taxAmountMinor: number
  /**
   * A PERCENTAGE — 19 for 19% — not the fraction the database holds.
   *
   * `tax_rates.rate` stores 0.19, because `taxOn` multiplies net by it directly.
   * EN 16931's `cbc:Percent` wants 19, and so does anybody reading a printed
   * invoice. Converting here rather than in each renderer is the point of this
   * model: the first version emitted `<cbc:Percent>0.19</cbc:Percent>`, which a
   * receiving system reads as 0.19% and computes tax roughly a hundredfold
   * wrong while the amounts beside it stay correct.
   */
  taxPercent: string | null
  taxCategory: string | null
}

/**
 * One row per distinct (category, percent).
 *
 * EN 16931 requires this breakdown (BG-23) and requires each subtotal's tax to
 * be derived from that group's own base — not apportioned from the invoice
 * total, which is how rounding drift gets in.
 */
export type TaxSubtotal = {
  category: string
  percent: string
  taxableMinor: number
  taxMinor: number
}

export type InvoiceDocument = {
  id: string
  invoiceNo: string
  /** UNTDID 1001. 380 invoice, 381 credit note. */
  documentTypeCode: string
  isCreditNote: boolean
  direction: string
  status: string
  issueDate: string
  dueDate: string
  deliveryDate: string | null
  currencyCode: string
  /** How many decimal places this currency actually has. */
  currencyScale: number
  buyerReference: string | null
  orderReference: string | null
  paymentMeansCode: string | null
  paymentTerms: string | null
  notes: string | null

  seller: DocumentParty
  buyer: DocumentParty

  lines: DocumentLine[]
  taxSubtotals: TaxSubtotal[]

  subtotalMinor: number
  taxTotalMinor: number
  totalMinor: number
  amountPaidMinor: number
  creditedMinor: number
  /** total − paid − credited. What is actually still owed. */
  dueMinor: number

  /** Where to pay. Absent when the workspace has no default bank account. */
  payee: { name: string; iban: string | null; bic: string | null } | null
}

type Row = Record<string, unknown>
const rows = (res: unknown): Row[] => (res as { rows: Row[] }).rows
const num = (v: unknown): number => Number(v ?? 0)
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null

/**
 * Assembles the document.
 *
 * Gated on `invoice.read` like every other way of seeing an invoice — the three
 * download routes are not a side door.
 */
export async function invoiceDocument(
  tx: TenantTx,
  ctx: RequestContext,
  invoiceId: string,
): Promise<InvoiceDocument> {
  requirePermission(ctx, 'invoice.read')

  const header = rows(
    await tx.execute(sql`
      select i.id, i.invoice_no as "invoiceNo", i.document_type_code as "documentTypeCode",
             i.direction, i.status, i.issue_date as "issueDate", i.due_date as "dueDate",
             i.delivery_date as "deliveryDate", i.currency_code as "currencyCode",
             i.buyer_reference as "buyerReference", i.order_reference as "orderReference",
             i.payment_means_code as "paymentMeansCode", i.payment_terms as "paymentTerms",
             i.notes,
             i.subtotal_minor as "subtotalMinor", i.tax_total_minor as "taxTotalMinor",
             i.total_minor as "totalMinor", i.amount_paid_minor as "amountPaidMinor",
             i.credited_minor as "creditedMinor",
             i.partner_snapshot as "partnerSnapshot",
             bp.name as "buyerName", bp.legal_name as "buyerLegalName",
             bp.tax_id as "buyerTaxId", bp.country_code as "buyerCountry",
             addr.street as "buyerStreet", addr.city as "buyerCity",
             addr.postcode as "buyerPostcode", addr.region as "buyerRegion",
             addr.country_code as "buyerAddrCountry",
             o.name as "sellerName", o.legal_name as "sellerLegalName",
             o.tax_id as "sellerTaxId", o.country_code as "sellerCountry"
        from invoices i
        join organizations o on o.id = i.organization_id
        left join business_partners bp on bp.id = i.business_partner_id
        left join lateral (
          select street, city, postcode, region, country_code
            from partner_addresses
           where partner_id = bp.id and type = 'billing'
           order by is_default desc
           limit 1
        ) addr on true
       where i.id = ${invoiceId}
         and i.organization_id = ${ctx.organizationId}
         and i.deleted_at is null
    `),
  )[0]

  if (!header) throw new AppError('NOT_FOUND', 'No such invoice.')

  const currencyCode = String(header.currencyCode)

  const lineRows = rows(
    await tx.execute(sql`
      select l.line_no as "lineNo", l.description, l.quantity, l.unit_code as "unitCode",
             l.unit_price_minor as "unitPriceMinor", l.discount_minor as "discountMinor",
             l.net_minor as "netMinor", l.tax_amount_minor as "taxAmountMinor",
             t.rate as "taxPercent", t.category as "taxCategory"
        from invoice_lines l
        left join tax_rates t on t.id = l.tax_rate_id
       where l.invoice_id = ${invoiceId}
         and l.organization_id = ${ctx.organizationId}
       order by l.line_no
    `),
  )

  const lines: DocumentLine[] = lineRows.map((l) => ({
    lineNo: num(l.lineNo),
    description: String(l.description ?? ''),
    quantity: String(l.quantity ?? '1'),
    unitCode: String(l.unitCode ?? 'C62'),
    unitPriceMinor: num(l.unitPriceMinor),
    discountMinor: num(l.discountMinor),
    netMinor: num(l.netMinor),
    taxAmountMinor: num(l.taxAmountMinor),
    taxPercent: toPercent(l.taxPercent),
    taxCategory: str(l.taxCategory),
  }))

  // The bank account the customer should pay into. Only the default one: an
  // invoice listing several is an invitation to pay the wrong one.
  const payeeRow = rows(
    await tx.execute(sql`
      select name, iban, bic from bank_accounts
       where organization_id = ${ctx.organizationId}
         and archived_at is null
         and currency_code = ${currencyCode}
       order by is_default desc, created_at
       limit 1
    `),
  )[0]

  // `partner_snapshot` is what the buyer looked like when the invoice was
  // ISSUED. It wins over the live partner record, because a customer who has
  // since moved must not retroactively change a document that has already been
  // filed for tax.
  const snapshot = (header.partnerSnapshot ?? {}) as Record<string, unknown>
  const snap = (key: string): string | null => str(snapshot[key])

  const totalMinor = num(header.totalMinor)
  const amountPaidMinor = num(header.amountPaidMinor)
  const creditedMinor = num(header.creditedMinor)

  return {
    id: String(header.id),
    invoiceNo: String(header.invoiceNo),
    documentTypeCode: String(header.documentTypeCode ?? '380'),
    isCreditNote: String(header.documentTypeCode) === '381',
    direction: String(header.direction),
    status: String(header.status),
    issueDate: isoDate(header.issueDate),
    dueDate: isoDate(header.dueDate),
    deliveryDate: header.deliveryDate ? isoDate(header.deliveryDate) : null,
    currencyCode,
    currencyScale: minorUnitsFor(currencyCode),
    buyerReference: str(header.buyerReference),
    orderReference: str(header.orderReference),
    paymentMeansCode: str(header.paymentMeansCode),
    paymentTerms: str(header.paymentTerms),
    notes: str(header.notes),

    seller: {
      name: String(header.sellerName ?? ''),
      legalName: str(header.sellerLegalName),
      taxId: str(header.sellerTaxId),
      countryCode: str(header.sellerCountry),
      // The workspace's own postal address is not modelled yet — see
      // docs/11-einvoicing.md. EN 16931 requires the seller country (BR-09),
      // which IS held; the street lines are what a printed page would like and
      // Peppol does not demand.
      street: null,
      city: null,
      postcode: null,
      region: null,
    },
    buyer: {
      name: snap('name') ?? String(header.buyerName ?? ''),
      legalName: snap('legalName') ?? str(header.buyerLegalName),
      taxId: snap('taxId') ?? str(header.buyerTaxId),
      countryCode:
        snap('countryCode') ?? str(header.buyerAddrCountry) ?? str(header.buyerCountry),
      street: snap('street') ?? str(header.buyerStreet),
      city: snap('city') ?? str(header.buyerCity),
      postcode: snap('postcode') ?? str(header.buyerPostcode),
      region: snap('region') ?? str(header.buyerRegion),
    },

    lines,
    taxSubtotals: groupTax(lines),

    subtotalMinor: num(header.subtotalMinor),
    taxTotalMinor: num(header.taxTotalMinor),
    totalMinor,
    amountPaidMinor,
    creditedMinor,
    dueMinor: totalMinor - amountPaidMinor - creditedMinor,

    payee: payeeRow
      ? { name: String(payeeRow.name), iban: str(payeeRow.iban), bic: str(payeeRow.bic) }
      : null,
  }
}

/**
 * The VAT breakdown (BG-23).
 *
 * Grouped by (category, percent) and summed from the LINES, never apportioned
 * from the invoice total. Apportioning is where a breakdown stops adding up to
 * the total it is supposed to explain, and a validator will reject the document
 * for exactly that (BR-CO-13 and friends).
 *
 * A line with no tax rate is grouped as category "E" — exempt — which is what a
 * zero-rated line without a rate record actually is. Guessing "S" at 0% would
 * claim a standard rate of zero, which is a different statement.
 */
export function groupTax(lines: DocumentLine[]): TaxSubtotal[] {
  const groups = new Map<string, TaxSubtotal>()

  for (const line of lines) {
    const category = line.taxCategory ?? (line.taxPercent ? 'S' : 'E')
    const percent = line.taxPercent ?? '0'
    const key = `${category}:${percent}`

    const existing = groups.get(key)
    if (existing) {
      existing.taxableMinor += line.netMinor
      existing.taxMinor += line.taxAmountMinor
    } else {
      groups.set(key, {
        category,
        percent,
        taxableMinor: line.netMinor,
        taxMinor: line.taxAmountMinor,
      })
    }
  }

  return [...groups.values()].sort((a, b) => Number(a.percent) - Number(b.percent))
}

/**
 * `tax_rates.rate` is a FRACTION — 0.19 for 19% — because `taxOn` multiplies
 * the net amount by it. Every human-facing and standards-facing use wants the
 * percentage, so the conversion happens once, here.
 */
function toPercent(rate: unknown): string | null {
  const raw = str(rate)
  if (raw === null) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  // toFixed(4) then Number() drops the trailing zeroes a numeric column carries
  // without losing a rate like 8.25%.
  return String(Number((n * 100).toFixed(4)))
}

/** Postgres `date` arrives as a string or a Date depending on the driver. */
function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

/** Minor units to a decimal string, at the currency's own scale. Shared so the
 *  three renderers cannot round differently. */
export function decimal(minor: number, scale: number): string {
  const negative = minor < 0
  const digits = Math.abs(Math.round(minor)).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : ''
  return `${negative ? '-' : ''}${whole}${fraction}`
}
