# Invoices out: e-invoice, PDF, print

Three ways an invoice leaves the system. All three read one model.

---

## One document, three renderers

[`src/invoices/document.ts`](../src/invoices/document.ts) assembles the invoice once — seller,
buyer, lines, VAT breakdown, totals. The PDF, the print view and the UBL generator are pure
functions of it and query nothing themselves.

That is not tidiness. Three renderers each fetching what they need is how the PDF a customer
files says €1,204.00 and the XML their accounting system ingested says €1,240.00 — discovered
months later when a VAT return disagrees with a bank statement. The renderers may differ in
what they **show**; they cannot differ in what they say a number **is**, and a test asserts it.

Amounts stay in minor units throughout and are converted at the very end at the currency's own
scale, because 124000 is ¥124,000 in JPY and €1,240.00 in EUR.

> **The bug this design caught.** `tax_rates.rate` stores `0.19` — `taxOn` multiplies net by it
> directly. EN 16931's `cbc:Percent` wants `19`. The first version emitted
> `<cbc:Percent>0.19</cbc:Percent>`, which a receiving system reads as 0.19% and uses to compute
> tax roughly a hundredfold wrong, while every amount beside it stayed correct. Because the
> conversion belongs in the shared model, one fix corrected all three outputs.

---

## The e-invoice

**EN 16931, UBL 2.1, Peppol BIS Billing 3.0.** [`src/einvoice/ubl.ts`](../src/einvoice/ubl.ts).

EN 16931 permits two syntaxes: UBL and UN/CEFACT CII. Peppol — the network most European
public bodies accept — mandates UBL, and the German XRechnung profile takes it. CII is what
Factur-X/ZUGFeRD embeds in a PDF. Supporting both doubles the surface for no immediate
customer, so this is UBL; CII would be a second generator against the same model.

A credit note becomes a **`CreditNote` document**, not an Invoice with negative amounts. That
is what the standard requires, and it fits how credit notes are stored here — as positive rows
discriminated by `document_type_code`, so the sign lives in the document type and therefore in
the element name.

### Validated before it is emitted

`checkRules` refuses to produce a document a receiving validator would reject. A rejection at
the far end arrives days later as an opaque code, usually to somebody who cannot read
Schematron; a refusal here says *"the customer has no country on file — open the customer and
add a billing address"* while the invoice is still on screen.

Checked: BR-02/03/05 (number, date, currency), BR-06/09 and BR-CO-26 (seller name, country,
tax id), BR-07/11 (buyer name, country), BR-16/22/25 (lines), BR-45 (VAT breakdown present),
BR-CO-13/14/15 (the breakdown reconciles to the totals), and a local rule refusing drafts.

This is **not** the whole rule set — that is several hundred Schematron assertions, and
reimplementing them would be a second, worse validator that drifts. It is the ones a real
invoice from this system plausibly fails. Validate against the official artefacts before
going live in a regulated market.

### What this is not

**Transmission.** Producing a conformant document and getting it onto Peppol are separate
problems; the second needs an accredited access point, which is a commercial relationship
rather than code. Nothing here talks to SDI (Italy), KSeF (Poland) or Chorus Pro (France)
either — each is a national gateway with its own registration, credentials and envelope.

What a customer gets today is a file their buyer, their accountant or their own access-point
provider accepts. `invoices.einvoice_status` exists for a future adapter to drive.

---

## The PDF

`pdfkit`, server-side, no headless browser. [`src/invoices/pdf.ts`](../src/invoices/pdf.ts).

Rendering the print view with Puppeteer would guarantee the two look identical, and would ship
~300MB of Chromium into every deployment while not running on serverless without a special
build. For a header, a table and a totals block, a PDF writer is proportionate.

> **`pdfkit` must stay in `serverExternalPackages`.** It reads its font metrics
> (`Helvetica.afm`) from disk at runtime. Bundled, the code moves into
> `.next/server/vendor-chunks` and the `data/` directory does not follow, so every PDF fails
> with ENOENT — and only in Next, because a unit test resolves it straight from `node_modules`
> and passes. It was the browser check that caught this, not the suite.

### The font is embedded, not read from disk

DejaVu Sans, subsetted to the Latin ranges an EU invoice needs and base64-embedded in
[`src/invoices/fonts.ts`](../src/invoices/fonts.ts).

pdfkit's built-in Helvetica is WinAnsi, which has no glyph for Polish (ą ć ę ł ń ś ź ż),
Czech (č ď ě ň ř š ť ů ž), Hungarian (ő ű) or Romanian (ș ț) — a customer called
Łukasiewicz rendered as "?ukasiewicz". Their own name, wrong, on a legal document.

**Embedded rather than loaded from a file**, and that is the same lesson as the ENOENT
above: a font with no file cannot be lost by a bundler, on Vercel or in a container.
Subsetting is what keeps that affordable — 739 KB → 76 KB regular, 689 KB → 69 KB bold.
pdfkit then embeds only the glyphs a given document uses, so the PDFs stay small.

Regenerate with `python scripts/build-pdf-font.py` after changing the ranges. The licence
(Bitstream Vera + Arev, both permissive) is in `src/invoices/fonts.LICENSE.txt` and must ship
with any redistribution.

> **The test asks the font, not the PDF.** pdfkit does **not** throw on a missing glyph — it
> silently draws `.notdef`. A test that only checked "a valid PDF came out" would have passed
> just as happily before this fix as after it. So the assertion uses fontkit to ask whether
> the embedded face actually has a glyph for each codepoint. Removing Latin Extended-A from
> the subset fails it.

Coverage: Basic Latin, Latin-1 Supplement, Latin Extended-A and -B (through U+024F, which is
where Romanian's comma-below letters live), the punctuation and currency symbols an invoice
prints. **Not** Greek or Cyrillic — a Greek or Bulgarian customer name would still render as
`.notdef`. Widening the range in the build script is the fix; it costs a few more kilobytes.

---

## Print

`/invoices/[id]/print` — a route outside the application layout, with its own stylesheet.

No sidebar, no header, no theme. A print stylesheet that has to hide an application shell
works by selector, and the next component someone adds to the shell reappears in the middle of
a customer's invoice. Nothing to hide is a stronger guarantee than hiding everything.

The page calls `window.print()` on load, since it is reached from a Print button. That gives:

- paper, and
- **Save as PDF** through the OS dialog — using the browser's own text stack, so it covers
  scripts the embedded subset does not, Greek and Cyrillic included.

It also works inside the desktop app's instance webview, which has no native IPC and therefore
cannot open a print dialog any other way.

The stylesheet uses millimetres and points rather than the app's pixel scale, sets
`@page { size: A4; margin: 0 }` with the sheet supplying its own padding, repeats table headers
across pages, and prevents a row or the totals block from splitting across a break — a
description on one sheet and its amount on the next is how a customer queries an invoice that
is arithmetically fine.

---

## Where to find it

Open an invoice → the drawer footer has **Print**, **PDF** and **e-Invoice**.

`e-Invoice` fetches rather than navigates, so a validation failure becomes a readable list of
what to fix instead of a raw JSON error page.

Both downloads are generated on demand and never stored: no file in a bucket waiting to be
found, and no cache to invalidate when an invoice is credited. Every download is written to
the audit trail with its format.

Gated on `invoice.read` — the same permission as seeing the invoice at all.
