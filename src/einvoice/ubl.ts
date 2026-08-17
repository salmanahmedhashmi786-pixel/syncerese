import { decimal, type InvoiceDocument } from '@/invoices/document'

/**
 * EN 16931 e-invoices as UBL 2.1, following Peppol BIS Billing 3.0.
 *
 * WHICH SYNTAX, AND WHY ONLY ONE
 *
 * EN 16931 permits two: UBL 2.1 and UN/CEFACT CII. Peppol — the network most
 * European public bodies and an increasing number of private buyers accept —
 * mandates UBL, and the German XRechnung profile accepts it. CII is what
 * Factur-X/ZUGFeRD embeds in a PDF, which is the French and German hybrid
 * approach. Supporting both doubles the surface for no immediate customer, so
 * this is UBL, and CII is a second generator against the same document model
 * when somebody actually needs it.
 *
 * WHAT THIS IS NOT
 *
 * It is not transmission. Producing a conformant document and getting it onto
 * the Peppol network are separate problems; the second needs an accredited
 * access point, which is a commercial relationship rather than code. See
 * docs/11-einvoicing.md. What this gives a customer today is a file their buyer,
 * their accountant, or their own access-point provider can accept.
 *
 * VALIDATION BEFORE EMISSION
 *
 * `checkRules` refuses to produce a document that a receiving validator would
 * reject. That is deliberately stricter than emitting something and hoping: a
 * rejection at the far end arrives days later as an opaque code, usually to
 * somebody who cannot read Schematron, whereas a refusal here can say "this
 * customer has no country on file" while the invoice is still on screen.
 */

const NS = {
  inv: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cn: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
}

/** Peppol BIS Billing 3.0. Both identifiers are mandatory (BR-01, BR-02) and a
 *  receiver uses them to pick which rule set to validate against. */
const CUSTOMIZATION_ID =
  'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0'
const PROFILE_ID = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0'

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type RuleViolation = { rule: string; message: string }

/**
 * The mandatory EN 16931 rules this document can actually break.
 *
 * Not the whole rule set — that is several hundred Schematron assertions, and
 * reimplementing them here would be a second, worse validator that drifts. These
 * are the ones a real invoice from this system plausibly fails, each with a
 * message aimed at the person who can fix it rather than at a specification.
 */
export function checkRules(doc: InvoiceDocument): RuleViolation[] {
  const problems: RuleViolation[] = []
  const require = (ok: unknown, rule: string, message: string) => {
    if (!ok) problems.push({ rule, message })
  }

  require(doc.invoiceNo, 'BR-02', 'The invoice has no number.')
  require(doc.issueDate, 'BR-03', 'The invoice has no issue date.')
  require(doc.currencyCode, 'BR-05', 'The invoice has no currency.')

  require(doc.seller.name, 'BR-06', 'Your workspace has no name set.')
  require(
    doc.seller.countryCode,
    'BR-09',
    'Your workspace has no country set. Settings → Organization.',
  )
  require(
    doc.seller.taxId,
    'BR-CO-26',
    'Your workspace has no VAT or tax identifier set, which a receiver needs to identify you.',
  )

  require(doc.buyer.name, 'BR-07', `${label(doc)} has no customer name.`)
  require(
    doc.buyer.countryCode,
    'BR-11',
    'The customer has no country on file. Open the customer and add a billing address.',
  )

  require(doc.lines.length > 0, 'BR-16', 'The invoice has no lines.')

  for (const line of doc.lines) {
    require(line.description, 'BR-25', `Line ${line.lineNo} has no description.`)
    require(
      line.quantity !== null && line.quantity !== '',
      'BR-22',
      `Line ${line.lineNo} has no quantity.`,
    )
  }

  require(
    doc.taxSubtotals.length > 0,
    'BR-45',
    'The invoice has no VAT breakdown, which every EN 16931 document must carry.',
  )

  // BR-CO-13 and BR-CO-15: the breakdown must explain the totals, not merely sit
  // beside them. A document whose subtotals do not add up is rejected at the far
  // end with a code nobody can act on, so it is caught here.
  const taxableSum = doc.taxSubtotals.reduce((n, t) => n + t.taxableMinor, 0)
  const taxSum = doc.taxSubtotals.reduce((n, t) => n + t.taxMinor, 0)
  require(
    taxableSum === doc.subtotalMinor,
    'BR-CO-13',
    `The VAT breakdown covers ${taxableSum} but the net total is ${doc.subtotalMinor}.`,
  )
  require(
    taxSum === doc.taxTotalMinor,
    'BR-CO-14',
    `The VAT breakdown totals ${taxSum} but the tax total is ${doc.taxTotalMinor}.`,
  )
  require(
    doc.subtotalMinor + doc.taxTotalMinor === doc.totalMinor,
    'BR-CO-15',
    `Net plus tax is ${doc.subtotalMinor + doc.taxTotalMinor}, but the total says ${doc.totalMinor}.`,
  )

  // A draft has no legal existence, and emitting one as an e-invoice would put
  // a document into a buyer's system that this workspace does not consider
  // issued.
  require(
    doc.status !== 'draft',
    'SYNC-01',
    'This invoice is still a draft. Issue it before sending it electronically.',
  )

  return problems
}

const label = (doc: InvoiceDocument): string =>
  doc.isCreditNote ? 'The credit note' : 'The invoice'

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export class EInvoiceError extends Error {
  constructor(public violations: RuleViolation[]) {
    super(violations.map((v) => v.message).join(' '))
    this.name = 'EInvoiceError'
  }
}

/**
 * Renders the document as UBL.
 *
 * A credit note becomes a `CreditNote` document rather than an Invoice with
 * negative amounts. That is what EN 16931 requires, and it matters here because
 * credit notes are stored in this system as positive rows discriminated by
 * document type — so the sign lives in the element name, exactly as it lives in
 * `document_type_code` in the database.
 */
export function toUbl(doc: InvoiceDocument): string {
  const violations = checkRules(doc)
  if (violations.length > 0) throw new EInvoiceError(violations)

  const root = doc.isCreditNote ? 'CreditNote' : 'Invoice'
  const rootNs = doc.isCreditNote ? NS.cn : NS.inv
  const scale = doc.currencyScale
  const cur = doc.currencyCode

  const out: string[] = []
  out.push('<?xml version="1.0" encoding="UTF-8"?>')
  out.push(
    `<${root} xmlns="${rootNs}" xmlns:cac="${NS.cac}" xmlns:cbc="${NS.cbc}">`,
  )

  out.push(el('cbc:CustomizationID', CUSTOMIZATION_ID))
  out.push(el('cbc:ProfileID', PROFILE_ID))
  out.push(el('cbc:ID', doc.invoiceNo))
  out.push(el('cbc:IssueDate', doc.issueDate))
  // A credit note has no due date of its own — it reduces what is owed rather
  // than creating an obligation with a deadline.
  if (!doc.isCreditNote) out.push(el('cbc:DueDate', doc.dueDate))
  out.push(
    el(
      doc.isCreditNote ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode',
      doc.documentTypeCode,
    ),
  )
  if (doc.notes) out.push(el('cbc:Note', doc.notes))
  out.push(el('cbc:DocumentCurrencyCode', cur))
  // BT-10. Mandatory in Peppol BIS for public-sector buyers, who use it to route
  // the invoice internally. Falls back to the invoice number so the element is
  // always present rather than conditionally missing.
  out.push(el('cbc:BuyerReference', doc.buyerReference ?? doc.invoiceNo))

  if (doc.orderReference) {
    out.push('<cac:OrderReference>')
    out.push(el('cbc:ID', doc.orderReference))
    out.push('</cac:OrderReference>')
  }

  if (doc.deliveryDate) {
    out.push('<cac:Delivery>')
    out.push(el('cbc:ActualDeliveryDate', doc.deliveryDate))
    out.push('</cac:Delivery>')
  }

  out.push(party('cac:AccountingSupplierParty', doc.seller, true))
  out.push(party('cac:AccountingCustomerParty', doc.buyer, false))

  if (doc.payee?.iban) {
    out.push('<cac:PaymentMeans>')
    // UNTDID 4461. 30 is a credit transfer, which is what an IBAN means.
    out.push(el('cbc:PaymentMeansCode', doc.paymentMeansCode ?? '30'))
    out.push('<cac:PayeeFinancialAccount>')
    out.push(el('cbc:ID', doc.payee.iban))
    out.push(el('cbc:Name', doc.payee.name))
    if (doc.payee.bic) {
      out.push('<cac:FinancialInstitutionBranch>')
      out.push(el('cbc:ID', doc.payee.bic))
      out.push('</cac:FinancialInstitutionBranch>')
    }
    out.push('</cac:PayeeFinancialAccount>')
    out.push('</cac:PaymentMeans>')
  }

  if (doc.paymentTerms) {
    out.push('<cac:PaymentTerms>')
    out.push(el('cbc:Note', doc.paymentTerms))
    out.push('</cac:PaymentTerms>')
  }

  // BG-22 tax total, and BG-23 the breakdown that explains it.
  out.push('<cac:TaxTotal>')
  out.push(money('cbc:TaxAmount', doc.taxTotalMinor, cur, scale))
  for (const group of doc.taxSubtotals) {
    out.push('<cac:TaxSubtotal>')
    out.push(money('cbc:TaxableAmount', group.taxableMinor, cur, scale))
    out.push(money('cbc:TaxAmount', group.taxMinor, cur, scale))
    out.push('<cac:TaxCategory>')
    out.push(el('cbc:ID', ublCategory(group.category)))
    out.push(el('cbc:Percent', trimPercent(group.percent)))
    out.push('<cac:TaxScheme>')
    out.push(el('cbc:ID', 'VAT'))
    out.push('</cac:TaxScheme>')
    out.push('</cac:TaxCategory>')
    out.push('</cac:TaxSubtotal>')
  }
  out.push('</cac:TaxTotal>')

  out.push('<cac:LegalMonetaryTotal>')
  out.push(money('cbc:LineExtensionAmount', doc.subtotalMinor, cur, scale))
  out.push(money('cbc:TaxExclusiveAmount', doc.subtotalMinor, cur, scale))
  out.push(money('cbc:TaxInclusiveAmount', doc.totalMinor, cur, scale))
  // BT-113. What has already been paid, so PayableAmount is what is genuinely
  // still owed rather than the face value of the document.
  if (doc.amountPaidMinor > 0) {
    out.push(money('cbc:PrepaidAmount', doc.amountPaidMinor, cur, scale))
  }
  out.push(
    money(
      'cbc:PayableAmount',
      doc.isCreditNote ? doc.totalMinor : doc.totalMinor - doc.amountPaidMinor,
      cur,
      scale,
    ),
  )
  out.push('</cac:LegalMonetaryTotal>')

  const lineTag = doc.isCreditNote ? 'cac:CreditNoteLine' : 'cac:InvoiceLine'
  const qtyTag = doc.isCreditNote ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity'

  for (const line of doc.lines) {
    out.push(`<${lineTag}>`)
    out.push(el('cbc:ID', String(line.lineNo)))
    out.push(`<${qtyTag} unitCode="${attr(line.unitCode)}">${text(line.quantity)}</${qtyTag}>`)
    out.push(money('cbc:LineExtensionAmount', line.netMinor, cur, scale))
    out.push('<cac:Item>')
    out.push(el('cbc:Name', line.description))
    out.push('<cac:ClassifiedTaxCategory>')
    out.push(el('cbc:ID', ublCategory(line.taxCategory ?? (line.taxPercent ? 'S' : 'E'))))
    out.push(el('cbc:Percent', trimPercent(line.taxPercent ?? '0')))
    out.push('<cac:TaxScheme>')
    out.push(el('cbc:ID', 'VAT'))
    out.push('</cac:TaxScheme>')
    out.push('</cac:ClassifiedTaxCategory>')
    out.push('</cac:Item>')
    out.push('<cac:Price>')
    out.push(money('cbc:PriceAmount', line.unitPriceMinor, cur, scale))
    out.push('</cac:Price>')
    out.push(`</${lineTag}>`)
  }

  out.push(`</${root}>`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------

function party(tag: string, p: { name: string; legalName: string | null; taxId: string | null; countryCode: string | null; street: string | null; city: string | null; postcode: string | null }, isSeller: boolean): string {
  const out: string[] = [`<${tag}>`, '<cac:Party>']

  out.push('<cac:PostalAddress>')
  if (p.street) out.push(el('cbc:StreetName', p.street))
  if (p.city) out.push(el('cbc:CityName', p.city))
  if (p.postcode) out.push(el('cbc:PostalZone', p.postcode))
  out.push('<cac:Country>')
  out.push(el('cbc:IdentificationCode', p.countryCode ?? ''))
  out.push('</cac:Country>')
  out.push('</cac:PostalAddress>')

  // BT-31 for the seller, BT-48 for the buyer. Only emitted when there is one:
  // a buyer without a VAT number is an ordinary consumer sale, not an error.
  if (p.taxId) {
    out.push('<cac:PartyTaxScheme>')
    out.push(el('cbc:CompanyID', p.taxId))
    out.push('<cac:TaxScheme>')
    out.push(el('cbc:ID', 'VAT'))
    out.push('</cac:TaxScheme>')
    out.push('</cac:PartyTaxScheme>')
  }

  out.push('<cac:PartyLegalEntity>')
  out.push(el('cbc:RegistrationName', p.legalName ?? p.name))
  out.push('</cac:PartyLegalEntity>')

  // The trading name, for a receiver that shows one rather than the legal name.
  if (isSeller || p.legalName) {
    out.push('<cac:PartyName>')
    out.push(el('cbc:Name', p.name))
    out.push('</cac:PartyName>')
  }

  out.push('</cac:Party>', `</${tag}>`)
  return out.join('\n')
}

const money = (tag: string, minor: number, currency: string, scale: number): string =>
  `<${tag} currencyID="${attr(currency)}">${decimal(minor, scale)}</${tag}>`

const el = (tag: string, value: string): string => `<${tag}>${text(value)}</${tag}>`

/**
 * UNTDID 5305 tax category.
 *
 * The internal vocabulary is friendlier than the code list, so it is mapped
 * rather than stored in the standard's terms — a customer creating a tax rate
 * should not have to know that "reverse charge" is `AE`.
 */
function ublCategory(category: string): string {
  switch (category) {
    case 'standard':
    case 'S':
      return 'S'
    case 'reduced':
      // Still a standard-rated supply, just at a reduced percentage. UNTDID has
      // no separate code for it, and using one would be wrong.
      return 'S'
    case 'zero':
    case 'Z':
      return 'Z'
    case 'exempt':
    case 'E':
      return 'E'
    case 'reverse_charge':
    case 'AE':
      return 'AE'
    case 'intra_community':
    case 'K':
      return 'K'
    case 'export':
    case 'G':
      return 'G'
    default:
      return 'S'
  }
}

/** "19.0000" → "19". Validators accept either, but a document a human may open
 *  should not read like a database column. */
function trimPercent(percent: string): string {
  const n = Number(percent)
  if (!Number.isFinite(n)) return '0'
  return String(Number(n.toFixed(4)))
}

/**
 * XML text escaping.
 *
 * Every value in this document comes from tenant-supplied data — a customer
 * name, a line description, a payment term someone typed. Interpolating those
 * into markup without escaping is how a description containing `</cbc:Name>`
 * rewrites the document, and in a format that is machine-read by a buyer's
 * accounting system that is worth more than a rendering glitch.
 */
function text(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Control characters are invalid in XML 1.0 and make a document unparseable
    // rather than merely wrong. Tab, newline and carriage return are legal.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

const attr = (value: string): string => text(value).replace(/"/g, '&quot;')

/** A filename a receiver's system will accept: Peppol implementations are
 *  routinely unhappy with spaces and slashes in attachment names. */
export const ublFilename = (doc: InvoiceDocument): string =>
  `${doc.invoiceNo.replace(/[^A-Za-z0-9._-]/g, '-')}.xml`
