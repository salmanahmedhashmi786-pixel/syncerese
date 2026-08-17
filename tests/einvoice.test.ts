import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { grantsFor } from '@/auth/permissions'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { createCreditNote } from '@/finance/credit-notes'
import { decimal, groupTax, invoiceDocument } from '@/invoices/document'
import { renderInvoicePdf } from '@/invoices/pdf'
import { INVOICE_FONT_BOLD, INVOICE_FONT_REGULAR } from '@/invoices/fonts'
import { checkRules, EInvoiceError, toUbl, ublFilename } from '@/einvoice/ubl'
import type { RequestContext } from '@/server/context'
import { createOpsFixture, type OpsFixture } from './helpers/operations'
import { FULL_ACCESS } from '@/billing/access'

const ctxFor = (f: OpsFixture, role: 'owner' | 'readonly' = 'owner'): RequestContext => ({
  userId: f.actor.userId!,
  organizationId: f.orgId,
  membershipId: 'test',
  role,
  permissions: grantsFor(role),
  requestId: null,
  ip: null,
  userAgent: null,
  licence: FULL_ACCESS,
})

/** Gives the workspace and the customer the identifiers EN 16931 demands. */
async function makeConformant(f: OpsFixture) {
  await f.tx(async (tx) => {
    await tx.execute(sql`
      update organizations set country_code = 'DE', tax_id = 'DE123456789'
       where id = ${f.orgId}
    `)
    await tx.execute(sql`
      update business_partners set country_code = 'IT', tax_id = 'IT98765432109'
       where id = ${f.customerId}
    `)
    await tx.execute(sql`
      insert into partner_addresses
        (id, organization_id, partner_id, type, street, city, postcode, country_code, is_default)
      values (gen_random_uuid(), ${f.orgId}, ${f.customerId}, 'billing',
              'Via Roma 1', 'Milano', '20121', 'IT', true)
    `)
  })
}

async function anIssuedInvoice(f: OpsFixture, qty = 2, unit = 50_000) {
  return f.tx(async (tx) => {
    const inv = await createInvoice(tx, f.actor, {
      direction: 'ar',
      businessPartnerId: f.customerId,
      issueDate: '2026-03-01',
      lines: [
        { description: 'Consulting', quantity: qty, unitPriceMinor: unit, taxRateId: f.vatRateId },
      ],
    })
    await issueInvoice(tx, f.actor, inv.id)
    return inv.id
  })
}

describe('e-invoicing, PDF and print', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
    await makeConformant(f)
  })

  afterEach(async () => {
    await f.t.close()
  })

  // -------------------------------------------------------------------------
  // The property the whole design rests on.
  // -------------------------------------------------------------------------

  it('gives every renderer the same figures', async () => {
    // The reason `InvoiceDocument` exists. Three renderers each querying what
    // they need is how a filed PDF says one total and the XML a buyer's system
    // ingested says another — discovered when a VAT return disagrees with a
    // bank statement, months later.
    const id = await anIssuedInvoice(f)
    const doc = await f.tx((tx) => invoiceDocument(tx, ctxFor(f), id))

    const xml = toUbl(doc)
    const pdf = await renderInvoicePdf(doc)

    // The XML states the total in major units at the currency's own scale.
    const payable = decimal(doc.totalMinor, doc.currencyScale)
    expect(xml).toContain(`<cbc:PayableAmount currencyID="EUR">${payable}</cbc:PayableAmount>`)
    expect(xml).toContain(
      `<cbc:TaxInclusiveAmount currencyID="EUR">${payable}</cbc:TaxInclusiveAmount>`,
    )
    expect(pdf.byteLength).toBeGreaterThan(500)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('reconciles the VAT breakdown with the totals', async () => {
    const id = await anIssuedInvoice(f)
    const doc = await f.tx((tx) => invoiceDocument(tx, ctxFor(f), id))

    const taxable = doc.taxSubtotals.reduce((n, t) => n + t.taxableMinor, 0)
    const tax = doc.taxSubtotals.reduce((n, t) => n + t.taxMinor, 0)

    // BR-CO-13/14/15. A breakdown that does not add up to the total it explains
    // is rejected at the far end with a code nobody can act on.
    expect(taxable).toBe(doc.subtotalMinor)
    expect(tax).toBe(doc.taxTotalMinor)
    expect(doc.subtotalMinor + doc.taxTotalMinor).toBe(doc.totalMinor)
    expect(checkRules(doc)).toEqual([])
  })

  it('states VAT as a percentage, not the fraction the database holds', async () => {
    // `tax_rates.rate` is 0.19 because `taxOn` multiplies net by it. EN 16931's
    // cbc:Percent wants 19. Emitting 0.19 makes a receiving system compute tax
    // roughly a hundredfold wrong while every amount beside it stays correct —
    // which is exactly the kind of wrong that survives review.
    const id = await anIssuedInvoice(f)
    const doc = await f.tx((tx) => invoiceDocument(tx, ctxFor(f), id))

    expect(doc.lines[0]!.taxPercent).toBe('19')
    expect(doc.taxSubtotals[0]!.percent).toBe('19')

    const xml = toUbl(doc)
    expect(xml).toContain('<cbc:Percent>19</cbc:Percent>')
    expect(xml).not.toContain('<cbc:Percent>0.19</cbc:Percent>')

    // And the stated percentage actually explains the stated tax.
    const group = doc.taxSubtotals[0]!
    const implied = Math.round((group.taxableMinor * Number(group.percent)) / 100)
    expect(implied).toBe(group.taxMinor)
  })

  it('never renders a total the currency scale would misplace', () => {
    // 124000 minor units is ¥124,000 and €1,240.00. A shared /100 is a rounding
    // bug with a nationality.
    expect(decimal(124_000, 2)).toBe('1240.00')
    expect(decimal(124_000, 0)).toBe('124000')
    expect(decimal(124_000, 3)).toBe('124.000')
    expect(decimal(-5, 2)).toBe('-0.05')
  })

  // -------------------------------------------------------------------------
  // EN 16931 conformance.
  // -------------------------------------------------------------------------

  it('emits a Peppol BIS Billing 3.0 invoice', async () => {
    const id = await anIssuedInvoice(f)
    const doc = await f.tx((tx) => invoiceDocument(tx, ctxFor(f), id))
    const xml = toUbl(doc)

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2')
    // BR-01 and BR-02: a receiver picks its rule set from these.
    expect(xml).toContain('urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0')
    expect(xml).toContain('<cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>')
    expect(xml).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>')
    expect(xml).toContain('<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>')
    // BT-10, mandatory for public-sector buyers who route on it.
    expect(xml).toContain('<cbc:BuyerReference>')
    expect(xml).toContain('<cac:TaxTotal>')
    expect(xml).toContain('<cac:LegalMonetaryTotal>')
    expect(xml).toContain('<cac:InvoiceLine>')
  })

  it('emits a credit note as a CreditNote, not a negative invoice', async () => {
    // EN 16931 requires it, and it matters here because credit notes are stored
    // as POSITIVE rows discriminated by document type — the sign lives in the
    // document type, so it must live in the element name too.
    const invoiceId = await anIssuedInvoice(f)
    const creditId = await f.tx(async (tx) => {
      // Created as a DRAFT and then issued through the same path as any other
      // invoice, which is also what makes it pass the not-a-draft rule.
      const cn = await createCreditNote(tx, f.actor, {
        invoiceId,
        reason: 'Goods returned',
      })
      await issueInvoice(tx, f.actor, cn.id)
      return cn.id
    })

    const doc = await f.tx((tx) => invoiceDocument(tx, ctxFor(f), creditId))
    expect(doc.isCreditNote).toBe(true)

    const xml = toUbl(doc)
    expect(xml).toContain('ubl:schema:xsd:CreditNote-2')
    expect(xml).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>')
    expect(xml).toContain('<cac:CreditNoteLine>')
    expect(xml).toContain('<cbc:CreditedQuantity')
    // No due date: a credit note reduces what is owed rather than creating an
    // obligation with a deadline.
    expect(xml).not.toContain('<cbc:DueDate>')
    expect(xml).not.toContain('<cac:InvoiceLine>')
  })

  it('refuses to emit a document a receiver would reject', async () => {
    // The alternative is emitting it and finding out days later, via an opaque
    // code, usually to somebody who cannot read Schematron.
    await f.tx((tx) =>
      tx.execute(sql`update business_partners set country_code = null where id = ${f.customerId}`),
    )
    await f.tx((tx) => tx.execute(sql`delete from partner_addresses where partner_id = ${f.customerId}`))

    const id = await anIssuedInvoice(f)
    const doc = await f.tx((tx) => invoiceDocument(tx, ctxFor(f), id))

    expect(() => toUbl(doc)).toThrow(EInvoiceError)
    const violations = checkRules(doc)
    expect(violations.map((v) => v.rule)).toContain('BR-11')
    // The message names what to do, not what rule number was broken.
    expect(violations.find((v) => v.rule === 'BR-11')?.message).toMatch(/billing address/i)
  })

  it('refuses a draft', async () => {
    const id = await f.tx(async (tx) => {
      const inv = await createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [
          { description: 'Consulting', quantity: 1, unitPriceMinor: 10_000, taxRateId: f.vatRateId },
        ],
      })
      return inv.id
    })
    const doc = await f.tx((tx) => invoiceDocument(tx, ctxFor(f), id))
    expect(checkRules(doc).map((v) => v.rule)).toContain('SYNC-01')
  })

  it('escapes tenant text rather than letting it rewrite the document', async () => {
    // Every value in the XML comes from tenant data. A description containing
    // markup would otherwise restructure a document that a buyer's accounting
    // system parses.
    const hostile = 'Widget </cbc:Name><cbc:Evil>x</cbc:Evil> & "quoted"'
    const id = await f.tx(async (tx) => {
      const inv = await createInvoice(tx, f.actor, {
        direction: 'ar',
        businessPartnerId: f.customerId,
        issueDate: '2026-03-01',
        lines: [
          { description: hostile, quantity: 1, unitPriceMinor: 10_000, taxRateId: f.vatRateId },
        ],
      })
      await issueInvoice(tx, f.actor, inv.id)
      return inv.id
    })

    const doc = await f.tx((tx) => invoiceDocument(tx, ctxFor(f), id))
    const xml = toUbl(doc)

    expect(xml).not.toContain('<cbc:Evil>')
    expect(xml).toContain('&lt;/cbc:Name&gt;')
    expect(xml).toContain('&amp;')

    // The line item's own Name carries the hostile text as ONE element. The
    // other <cbc:Name> occurrences are the two parties' trading names, which is
    // why counting them all would prove nothing.
    const itemName = /<cac:Item>\s*<cbc:Name>([\s\S]*?)<\/cbc:Name>/.exec(xml)
    expect(itemName).not.toBeNull()
    expect(itemName![1]).not.toContain('<')
    expect(itemName![1]).toContain('&lt;/cbc:Name&gt;')
  })

  it('produces a filename a receiving system will accept', async () => {
    const id = await anIssuedInvoice(f)
    const doc = await f.tx((tx) => invoiceDocument(tx, ctxFor(f), id))
    expect(ublFilename(doc)).toMatch(/^[A-Za-z0-9._-]+\.xml$/)
  })

  // -------------------------------------------------------------------------
  // The tax breakdown.
  // -------------------------------------------------------------------------

  it('groups the VAT breakdown by category and rate', () => {
    const grouped = groupTax([
      line({ netMinor: 10_000, taxAmountMinor: 1_900, taxPercent: '19.0000', taxCategory: 'standard' }),
      line({ netMinor: 5_000, taxAmountMinor: 950, taxPercent: '19.0000', taxCategory: 'standard' }),
      line({ netMinor: 2_000, taxAmountMinor: 140, taxPercent: '7.0000', taxCategory: 'reduced' }),
    ])

    expect(grouped).toHaveLength(2)
    // Ascending by rate, so a reader sees the same order every time.
    expect(grouped[0]!.percent).toBe('7.0000')
    expect(grouped[1]!.taxableMinor).toBe(15_000)
    expect(grouped[1]!.taxMinor).toBe(2_850)
  })

  it('treats an untaxed line as exempt rather than standard-rated at zero', () => {
    // "Standard rate, 0%" is a different statement from "exempt", and a
    // validator distinguishes them.
    const grouped = groupTax([line({ netMinor: 1_000, taxAmountMinor: 0, taxPercent: null, taxCategory: null })])
    expect(grouped[0]!.category).toBe('E')
  })

  // -------------------------------------------------------------------------
  // Permissions and PDF.
  // -------------------------------------------------------------------------

  it('needs invoice.read like every other way of seeing an invoice', async () => {
    const id = await anIssuedInvoice(f)
    const noAccess: RequestContext = { ...ctxFor(f), permissions: new Set() }
    await expect(f.tx((tx) => invoiceDocument(tx, noAccess, id))).rejects.toThrow()
  })

  it('will not read another tenant\'s invoice', async () => {
    const id = await anIssuedInvoice(f)
    const other = await createOpsFixture()
    try {
      await expect(other.tx((tx) => invoiceDocument(tx, ctxFor(other), id))).rejects.toThrow()
    } finally {
      await other.t.close()
    }
  })

  it('covers Polish, Czech and Hungarian letters in the embedded font', async () => {
    // The bug this fixes: pdfkit's built-in Helvetica is WinAnsi and has no
    // glyph for ł, ř or ő, so a customer called Łukasiewicz came out as
    // "?ukasiewicz" — their own name, wrong, on a legal document.
    //
    // Asked of the FONT, not of the rendered PDF, because pdfkit does not throw
    // on a missing glyph — it silently draws .notdef. A test that only checked
    // "a valid PDF came out" would have passed just as happily before this fix
    // as after it, which is worth stating because that is the test I first
    // wrote.
    const fontkit = await import('fontkit')
    const create = fontkit.create ?? fontkit.default.create

    for (const font of [INVOICE_FONT_REGULAR, INVOICE_FONT_BOLD]) {
      const face = create(font)
      const covers = (text: string) =>
        [...text].every((c) => face.hasGlyphForCodePoint(c.codePointAt(0)!))

      expect(covers('ŁąćęłńóśźżĄĆĘŁŃÓŚŹŻ'), 'Polish').toBe(true)
      expect(covers('áčďéěíňóřšťúůýžČĎŇŘŠŤŽ'), 'Czech').toBe(true)
      expect(covers('őűŐŰ'), 'Hungarian').toBe(true)
      expect(covers('ăâîșțĂÂÎȘȚ'), 'Romanian').toBe(true)
      expect(covers('äöüßéèçñÄÖÜ'), 'Western European').toBe(true)
      expect(covers('€£$—–…−'), 'symbols an invoice prints').toBe(true)
    }
  })

  it('still renders a document once those names are in the data', async () => {
    const name = 'Łukasiewicz — Příliš žluťoučký kůň — Őrült'
    await f.tx((tx) =>
      tx.execute(sql`update business_partners set name = ${name} where id = ${f.customerId}`),
    )

    const id = await anIssuedInvoice(f)
    const doc = await f.tx((tx) => invoiceDocument(tx, ctxFor(f), id))
    // Nothing mangles the name on the way through the document model either.
    expect(doc.buyer.name).toBe(name)

    const pdf = await renderInvoicePdf(doc)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('embeds a font rather than reading one from disk', async () => {
    // pdfkit's own metrics are read from the filesystem, and bundling moved them
    // out of reach — every PDF failed with ENOENT in Next while this suite
    // passed, because a test resolves straight out of node_modules. A font with
    // no file cannot fail that way anywhere.
    for (const font of [INVOICE_FONT_REGULAR, INVOICE_FONT_BOLD]) {
      expect(Buffer.isBuffer(font)).toBe(true)
      // A TrueType file starts with 0x00010000; anything else is not a font.
      expect(font.subarray(0, 4).toString('hex')).toBe('00010000')
      // Subsetted, so the repository does not carry three quarters of a
      // megabyte per face.
      expect(font.byteLength).toBeLessThan(150_000)
    }
  })
})

function line(over: Partial<Parameters<typeof groupTax>[0][number]>) {
  return {
    lineNo: 1,
    description: 'x',
    quantity: '1',
    unitCode: 'C62',
    unitPriceMinor: 0,
    discountMinor: 0,
    netMinor: 0,
    taxAmountMinor: 0,
    taxPercent: null,
    taxCategory: null,
    ...over,
  }
}
