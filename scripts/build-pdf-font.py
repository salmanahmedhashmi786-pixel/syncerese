"""
Subsets DejaVu Sans and embeds it as base64 TypeScript.

WHY EMBED RATHER THAN READ A FILE

pdfkit's own font metrics are read from disk, and bundling moved them out of
reach — every PDF failed with ENOENT in Next while passing in a unit test. An
embedded font cannot fail that way in any deployment target, because there is no
file to lose. The cost is repo size, which is why the font is subsetted first.

WHY THESE RANGES

Latin Extended-A is the one that matters: it carries Polish (ą ć ę ł ń ś ź ż),
Czech (č ď ě ň ř š ť ů ž), Hungarian (ő ű), Romanian, Baltic and Turkish. Latin-1
Supplement covers Western Europe. The rest are the symbols an invoice actually
prints — the euro sign, the minus that is not a hyphen, curly quotes, an em dash.

Regenerate with:  python scripts/build-pdf-font.py
"""

import base64
import io
import os
from fontTools import subset

SRC = "node_modules/dejavu-fonts-ttf/ttf"
OUT = "src/invoices/fonts.ts"

# Explicit, not a guess. Each range is here because something on an invoice
# needs it.
UNICODES = (
    "U+0020-007E,"   # Basic Latin
    "U+00A0-00FF,"   # Latin-1 Supplement — Western European accents
    "U+0100-017F,"   # Latin Extended-A — Polish, Czech, Hungarian, Baltic
    "U+0180-024F,"   # Latin Extended-B — Romanian s/t-comma (U+0219, U+021B)
                     # live at the top of this block, so stopping at 01FF drops
                     # them and Romanian names render as .notdef.
    "U+02C6-02DD,"   # spacing modifiers that appear in Latin Extended text
    "U+2010-201F,"   # dashes and curly quotes
    "U+2020-2027,"   # dagger, bullet, ellipsis
    "U+2030-2044,"   # per mille, prime, fraction slash
    "U+20A0-20BF,"   # currency symbols, including the euro
    "U+2122,"        # trademark
    "U+2202-2265,"   # the handful of maths symbols, incl. U+2212 minus
    "U+FB00-FB04"    # ligatures DejaVu may substitute
)


def build(name: str, source: str) -> tuple[str, int, int]:
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    # Hinting and glyph names are what a PDF viewer never needs and what makes a
    # subset twice the size it has to be.
    options.hinting = False
    options.glyph_names = False
    options.desubroutinize = True
    options.drop_tables += ["DSIG"]

    font = subset.load_font(source, options)
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)

    buffer = io.BytesIO()
    subset.save_font(font, buffer, options)
    data = buffer.getvalue()
    return base64.b64encode(data).decode("ascii"), os.path.getsize(source), len(data)


def main() -> None:
    regular, r_before, r_after = build("regular", f"{SRC}/DejaVuSans.ttf")
    bold, b_before, b_after = build("bold", f"{SRC}/DejaVuSans-Bold.ttf")

    header = f'''/**
 * The invoice font, subsetted and embedded.
 *
 * GENERATED — run `python scripts/build-pdf-font.py` to rebuild. Do not edit.
 *
 * DejaVu Sans, cut down to the Latin ranges an EU invoice needs. Latin
 * Extended-A is the range that matters: it carries Polish (ą ć ę ł ń ś ź ż),
 * Czech (č ď ě ň ř š ť ů ž), Hungarian (ő ű), Romanian, Baltic and Turkish —
 * none of which exist in the WinAnsi encoding of pdfkit's built-in Helvetica,
 * where a customer called Łukasiewicz rendered as a question mark.
 *
 * EMBEDDED AS BASE64 rather than read from disk, and that is deliberate. pdfkit
 * reads its own built-in metrics from the filesystem, and bundling moved them
 * out of reach — every PDF failed with ENOENT in Next while the unit tests
 * passed, because a test resolves straight out of node_modules. A font with no
 * file cannot fail that way on Vercel, in a standalone container, or anywhere
 * else. Subsetting is what keeps the cost of that decision reasonable:
 * {r_before // 1024} KB → {r_after // 1024} KB regular,
 * {b_before // 1024} KB → {b_after // 1024} KB bold.
 *
 * pdfkit embeds only the glyphs a given document uses, so the PDFs themselves
 * stay small regardless.
 *
 * LICENCE: Bitstream Vera Fonts Licence and Arev Fonts Licence, both permissive.
 * Full text in src/invoices/fonts.LICENSE.txt, which must ship with any
 * redistribution.
 */

export const INVOICE_FONT_REGULAR = Buffer.from(
  '{regular}',
  'base64',
)

export const INVOICE_FONT_BOLD = Buffer.from(
  '{bold}',
  'base64',
)
'''
    with open(OUT, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(header)

    print(f"regular {r_before // 1024}KB -> {r_after // 1024}KB")
    print(f"bold    {b_before // 1024}KB -> {b_after // 1024}KB")
    print(f"wrote {OUT} ({os.path.getsize(OUT) // 1024}KB)")


if __name__ == "__main__":
    main()
