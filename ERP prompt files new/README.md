# Handoff: ERP System UI (Nordhaven)

## Overview
A desktop-web ERP workspace covering 10 modules (executive dashboard, reports, inventory, purchasing, manufacturing, sales, CRM, finance, HR, settings) with a persistent left navigation, a sticky module header, dense data tables, a record detail drawer, a create-record modal, toasts, and a live workspace customizer (accent color, light/dark, row density, sidebar state, font scale, table columns, dashboard widget layout).

Target audience: design exploration / pitch-quality reference for a European mid-market manufacturer. Currency EUR, dates ISO (`YYYY-MM-DD`), numbers in `de-DE` grouping (`184.200`).

## About the Design Files
The files in this bundle are **design references authored in HTML** — a working prototype of the intended look and behavior, not production code to lift. The task is to **recreate these designs inside the target codebase's existing environment** (React, Vue, Angular, SwiftUI, whatever is in use), using its established component library, routing, state, and data layer. If no environment exists yet, choose an appropriate stack and implement there. Do not ship the prototype HTML.

`ERP System.dc.html` uses a custom template runtime; read it for structure and exact values, not for architecture. All layout is inline-styled by design — in the real codebase, use the codebase's styling system.

## Fidelity
**High-fidelity.** Colors, typography, spacing, density, and interaction behavior are final-intent. Recreate faithfully, substituting the codebase's own primitives (buttons, inputs, table, drawer, modal, toast) where they exist. Where the codebase has a design system, its tokens win over the hex values below — map, don't fork.

---

## Global Shell

**Frame**: full-height flex row. Sidebar (fixed) + main column (flex:1, min-width:0).

### Sidebar
- Width **234px** expanded / **60px** collapsed; `transition: width .16s ease`; `position: sticky; top:0; height:100vh`.
- Background: `#111725` (light theme) / `#080b11` (dark). Sidebar is dark in **both** themes.
- **Brand row**: height 52px, padding `0 14px`, bottom border `1px solid rgba(255,255,255,.07)`. 26×26 rounded-6px accent square with a white 11px/600 mono initial; brand name 13px/600 white, `letter-spacing:-.01em`; subline `ERP · EU-CENTRAL` 10px mono `rgba(255,255,255,.4)`.
- **Nav groups**: 5 labelled groups (`OVERVIEW`, `OPERATIONS`, `COMMERCIAL`, `BACK OFFICE`, `SYSTEM`), group label 9.5px mono, `letter-spacing:.09em`, `rgba(255,255,255,.32)`, padding `6px 8px 5px`; 12px gap between groups.
- **Nav item**: height 30px, radius 6px, gap 10px, padding `0 9px`, font 12.4px. Idle `rgba(255,255,255,.66)` on transparent; **active** = white 600 on solid accent. Each item has a 22×18 code chip (radius 4, 9.5px mono): idle `rgba(255,255,255,.08)`/`rgba(255,255,255,.6)`, active `rgba(255,255,255,.2)`/white. Optional right badge pill: 9.5px mono, `rgba(255,255,255,.12)` bg, radius 9px, padding `1px 5px`.
- **Collapsed state**: labels, group headers, and badges hide; items center; `title` attr carries the label as tooltip.
- **Footer**: collapse toggle, height 30px, radius 6, `rgba(255,255,255,.05)`, label `« Collapse` / `»`.

Nav map (id → code → label → badge):
`dashboard/DB/Executive dashboard`, `reports/RP/Reports & analytics` · `inventory/IN/Inventory / Stock/12`, `purchasing/PO/Purchase orders/5`, `manufacturing/MO/Production orders` · `sales/SO/Sales orders/8`, `crm/CU/Customers` · `finance/FI/Invoices & GL/3`, `hr/HR/Employees & payroll` · `settings/ST/Settings`.

### Header
Sticky, `z-index:20`, height **52px**, padding `0 18px`, background panel, bottom border 1px. Left: module title 14.5px/600 `letter-spacing:-.015em` + subtitle 10.5px mono muted. Right cluster (gap 12px): search input (table modules only), theme toggle icon button, **Customize** button, **+ New** (table modules only), 28px avatar circle (`LK`, accent-soft bg, accent text, 10.5px mono 600).

Button specs:
- **Icon button**: 28×28, radius 6, `1px solid` border, transparent, muted glyph.
- **Chip / secondary button**: height 26, padding `0 10px`, radius 6, `1px solid` border, 11.5px, transparent.
- **Primary button**: height 28, padding `0 12px`, radius 6, solid accent, white, 12px/600.
- **Customize button**: height 28, padding `0 11px`, radius 6, `1px solid accent`, accent text, accent-soft background, 12px/500.
- **Search input**: height 28, width 216, radius 6, 1px border, padding `0 10px 0 22px`, 12px; a `/` mono glyph absolutely positioned at left 9px, muted, `pointer-events:none`.

Content area padding: `16px 18px 40px`.

---

## Screens / Views

### 1. Executive dashboard
Purpose: group-level snapshot. Subtitle `Group consolidated · Aug 2026 · EUR`.

A **12-column CSS grid**, `gap:12px`, `align-items:start`. Above it, a layout control row: `WIDGET LAYOUT` label (10px mono, `letter-spacing:.08em`, muted) + **Edit layout / Done editing** chip button + (in edit mode) chips to restore hidden widgets.

Widget shell: panel bg, `1px solid` border, radius 8, `overflow:hidden`; in edit mode an extra `outline: 1px dashed accent`. Widget header: padding `11px 13px 0`, title 12.5px/600 + note 10px mono muted; in edit mode, four 20×20 micro-buttons (radius 4, 1px border, 9px glyph): `◀` `▶` reorder, `↔` widen (+3 columns, capped at 12), `✕` hide.

Default order and spans:
1. **Key figures** — span 12, KPI strip.
2. **Revenue** — span 7, bar chart.
3. **Order pipeline** — span 5, bar list.
4. **Replenishment alerts** — span 5, item list.
5. **Activity stream** — span 7, item list.

**KPI strip**: 4-column grid with `gap:1px` over a border-colored background (hairline dividers), `border-top:1px solid border`, each cell panel bg, padding `13px 14px 15px`. Label 9.5px mono `letter-spacing:.07em` muted; value 22px/600 `letter-spacing:-.025em`; delta 11px/600 green `#0d9488` up / red `#dc2626` down, followed by ` vs last month` in muted 400.
Values: `REVENUE MTD €5.94M +12.4%↑`, `OPEN ORDERS 312 +4.1%↑`, `STOCK VALUE €41.2M −2.7%↓`, `OVERDUE AR €360.6K +18.3%↓`.

**Revenue bars**: height 170px container, padding `16px 13px 12px`, gap 7px, bars `align-items:flex-end`. Bar radius `3px 3px 0 0`; idle fill = accent at 34% alpha (45% in dark), hover = solid accent, `transition: background .12s`. Month label 9.5px mono muted below each bar. Hover tooltip above the bar: dark `#111725` (`#252d3a` dark theme), white, padding `4px 8px`, radius 5, 10.5px mono, content `Sep · €3.1M`.
Series (€M, Sep→Aug): 3.1, 3.4, 4.2, 5.1, 3.6, 3.9, 4.4, 4.1, 4.8, 5.3, 5.0, 5.9.

**Order pipeline**: rows with label (11.5px) + right value (11px mono muted), and a 7px track (radius 4, `rgba(0,0,0,.06)` / `rgba(255,255,255,.08)` dark) with an accent fill proportional to count.
Quotation 84 · €2.1M; Confirmed 126 · €4.8M; In production 61 · €3.2M; Shipped 33 · €1.4M; Blocked 8 · €0.3M.

**Replenishment alerts**: derived from inventory rows where signal ≠ OK. Row: 7px status dot, title 12px, sub 10px mono muted (`SKU · site`), right `onhand / reorder` in 11px mono colored by status. Click → navigate to Inventory with search prefilled to that SKU.

**Activity stream**: same row anatomy, accent dot at 80% alpha, right column = relative time in 10px mono muted.
Entries: `SO-24188 confirmed by L. Kraus / Sales · 14 lines · €184 200 / 2m`; `PO-90412 awaiting approval / Procurement · Steinmetz Metallwerke / 19m`; `MO-7728 flagged material shortage / Production · Munich plant / 54m`; `INV-2026-4412 became overdue / Finance · 21 days · €184 200 / 2h`; `Cycle count posted · Rotterdam / Inventory · 312 SKUs · −0.4% variance / 4h`; `EMP-3306 entered notice period / HCM · Procurement · Munich / 6h`.

### 2. Reports & analytics
Subtitle `BI · rolling 12 months`. Two panels on the 12-col grid.
- **Gross margin trend · 12 months** (span 7): inline SVG `viewBox="0 0 600 200"`, `preserveAspectRatio="none"`, height 200px. A filled area polyline in accent-at-12% plus a 2.5px accent stroke polyline, `stroke-linejoin:round`. Points normalized from series `31,30,33,35,32,34,36,35,38,37,39,41` into y-range 30–180. Month labels below in 9.5px mono muted, space-between.
- **Revenue by country** (span 5): same bar-list anatomy as pipeline. Germany €18.4M, Netherlands €11.2M, Italy €8.7M, France €7.9M, Poland €5.1M, Nordics €4.3M.
Panel headers: padding `12px 14px`, bottom border, 12.5px/600.

### 3. Table modules (Inventory, Purchasing, Manufacturing, Sales, CRM, Finance, HR)
All seven share one table screen driven by per-module config. Panel: panel bg, 1px border, radius 8.

**Filter bar** (padding `9px 11px`, bottom border, wrap): status filter chips derived from the module's badge column, `All` first, capped at 7. Chip: height 26, padding `0 10px`, radius 6, 11.5px; idle 1px border + transparent; **active** accent border, accent-soft bg, accent text, 600. Each chip shows its count in mono at 55% opacity. Right side: **Columns (n)** chip opening a dropdown (absolute, `top:30px`, right-aligned, `z-index:40`, panel bg, 1px border, radius 8, `box-shadow: 0 12px 30px rgba(0,0,0,.16)`, padding 6, min-width 190, entry animation `fade+6px rise, .12s`) listing every column with a 14px checkbox.

**Bulk action bar** (appears when ≥1 row selected, above the header row): accent-soft background, bottom border, padding `8px 12px`, 12px accent text, `N selected` in 600, then chip buttons **Approve**, **Export CSV**, **Delete**, **Clear** (height 24, radius 5, accent border at 40% alpha, panel bg).

**Table**: `border-collapse:collapse`, `min-width:900px`, horizontally scrollable wrapper.
- **Header cell**: padding `(density+2)px 10px`, 9.5px mono uppercase `letter-spacing:.07em`, muted (accent when it is the sort column), bottom border, `user-select:none`, subtle tint bg `rgba(0,0,0,.012)` / `rgba(255,255,255,.02)`. Click to sort; the active column appends `↑`/`↓`.
- **Body cell**: padding `(density)px 10px`; mono font at `0.94em` for id/number/money columns; the first (id) column is accent-colored 500; editable columns carry a right `1px dashed` hairline at 7% as an affordance plus `title="Double-click to edit"`.
- **Row**: bottom hairline `rgba(0,0,0,.045)` / `rgba(255,255,255,.05)`; selected rows take an accent-soft background.
- **Checkbox** (header + each row): 14×14, radius 3, 1px border; checked = accent fill + white `✓`.
- **Status badge**: `inline-flex`, padding `2px 7px`, radius 4, `0.86em`/600, colored text on the same color at 11% alpha (20% in dark).
- **Footer**: padding `9px 12px`, top border, 11px mono muted: `N of M records · Double-click an editable cell to change it · click a row for detail`.

Money format: `€184.200` (de-DE grouping); negatives render `−€8.300`. Empty → `—`.

Module configs (column key · label · width · type; `E` = inline-editable):

| Module | Title / subtitle | Columns |
|---|---|---|
| Sales orders | `SD · order-to-cash · EUR` | Order 104 mono, Customer 210, Country 90, Status 128 badge, Lines 70 right mono, Net value 130 right money **E**, Delivery 110 mono, Owner 130 |
| Inventory / Stock | `MM · 4 warehouses · live valuation` | SKU 116 mono, Material 230, Site 130, Signal 118 badge, On hand 92 right mono **E**, Reorder pt 96 right mono **E**, Value 126 right money, Lead time 96 mono |
| Purchase orders | `MM · procure-to-pay` | PO 104 mono, Supplier 214, Country 88, Status 132 badge, Value 128 right money **E**, ETA 110 mono, Buyer 128 |
| Production orders | `PP · BOM & routing · 3 plants` | Order 104 mono, Finished good 224, Plant 128, Status 130 badge, Qty 74 right mono **E**, Progress 92 right mono, Start 108 mono, Finish 108 mono |
| Invoices & general ledger | `FI · EUR · VAT-compliant` | Document 118 mono, Business partner 214, Type 104, Status 118 badge, Net 118 right money **E**, VAT 78 right mono, Due date 110 mono, Aging 90 mono |
| Customers | `CRM · accounts & credit exposure` | Account 110 mono, Name 218, Country 88, Tier 108 badge, Revenue YTD 134 right money, Credit limit 128 right money **E**, Terms 92 mono, Owner 124 |
| Employees & payroll | `HCM · 4 entities · 1 284 headcount` | Person 104 mono, Name 190, Department 168, Location 122, Status 112 badge, Annual gross 132 right money **E**, Start date 112 mono |

Sample data lives in the `tables` object of `ERP System.dc.html` (8–12 realistic European rows per module) — copy it verbatim for the prototype, replace with API data in production.

### 4. Settings
Renders the same control set as the Customize drawer, inside a 760px-max panel (padding `18px 20px 22px`): heading `Appearance & workspace` 14px/600 + 12px muted subline. Groups stacked with 20px gap.

---

## Overlays

### Record detail drawer
Right-anchored, **460px** wide, full height, panel bg, `1px solid` left border, `z-index:65`, slide-in `translateX(18px)+fade, .16s ease`. Scrim: `position:fixed; inset:0; rgba(8,11,17,.34)`, `z-index:60`, click to close.
- Header (padding `15px 18px`, bottom border): kicker = module noun uppercase, 10px mono `letter-spacing:.08em` muted; title `<ID> · <name>` 16px/600 `letter-spacing:-.02em`; close icon button.
- Body: a 2-column field grid with 1px hairline gutters over a bordered radius-8 container — every column of the record as `LABEL` (9.5px mono muted) + value (12.5px).
- `ACTIVITY` timeline: 8px dots connected by a 1px vertical rule, entry text 12px + timestamp 10px mono muted. Entries: record created (system), approved by L. Kraus (workflow), posted to general ledger (FI batch), last modified by current user (manual).
- Footer (top border, padding `12px 18px`): primary **Approve**, chip **Duplicate**, right-aligned chip **Close**.

### Create-record modal
Centered `left:50%; translateX(-50%)`, `top:9vh`, width 620 (max 92vw), panel bg, 1px border, radius 10, `box-shadow: 0 24px 60px rgba(0,0,0,.32)`, `z-index:75`, `fade+6px rise .15s`. Scrim `rgba(8,11,17,.42)` at `z-index:70`.
- Header: `New <module noun>` 15px/600 + 11.5px muted `Required fields are marked. Values validate on save.`
- Body: 2-column grid, gap 13px; fields whose column width > 180px span both columns. Field label 9.5px mono muted uppercase; input height 30, radius 6, 1px border, padding `0 9px`, 12px. Badge columns render as a `<select>` of the module's distinct status values; everything else is a text input.
- Validation: first two columns are required; failures set a `#dc2626` border + 10.5px red message below and fire an error toast. Only the first 6 columns appear in the form; omitted/blank fields default to `0` (numeric) or `—`.
- Footer: right-aligned **Cancel** (chip) + **Save record** (primary).

### Customize drawer
Right-anchored **360px** panel, same slide-in as the detail drawer, `z-index:90`, scrim `rgba(8,11,17,.3)` at 80. Header `Customize workspace` 14px/600 + close. Controls (20px gap), each with a 9.5px mono uppercase label and an 11px muted hint:
1. **ACCENT COLOR** — six 30×30 radius-8 swatches; selected gets `box-shadow: 0 0 0 2px panel, 0 0 0 4px <color>` and a white `✓`. Hint: *Blue is the ERP default — the most widely used enterprise-software accent.*
2. **APPEARANCE** — segmented Light / Dark.
3. **ROW DENSITY** — segmented Compact / Comfortable / Relaxed. Hint: *Compact fits ~40% more rows per screen.*
4. **SIDEBAR** — segmented Expanded / Collapsed.
5. **FONT SIZE** — range 0.85–1.30 step 0.05, `accent-color` = theme accent, readout as a percentage.
Segmented control: inline-flex, 1px border, radius 7, `overflow:hidden`, subtle input bg; each segment padding `6px 13px`, 11.5px, 1px right divider; active = solid accent + white + 600.

### Toasts
Fixed `right:18px; bottom:18px`, `z-index:120`, column, gap 8px. Toast: dark `#111725` (`#1b2330` dark theme), white, padding `9px 14px`, radius 8, 12px, `box-shadow: 0 8px 26px rgba(0,0,0,.28)`, `fade+6px rise .16s`, auto-dismiss after **3200ms**. Leading 7px dot: ok `#34d399`, warn `#fbbf24`, error `#f87171`.
Copy: `SO-24188 · Net value updated`, `N records approved`, `Export queued · N rows → CSV`, `N records deleted` (warn), `<Noun> <ID> created`, `Fix N field(s) before saving` (error), `Record approved · workflow advanced`, `Draft copy created`, `Opening audit entry`.

---

## Interactions & Behavior

- **Navigation**: clicking a nav item switches module and **resets** search, sort, selection, filter, inline edit, and the column menu. Sidebar collapse persists across modules.
- **Sorting**: click a header to sort ascending; click again to flip. Numeric columns compare numerically, everything else via `localeCompare`.
- **Search**: free-text, case-insensitive, matched against **all** columns of the module (including hidden ones).
- **Filtering**: status chips filter on the module's badge column; changing the filter clears selection. Search and filter compose; sort applies last.
- **Row click** opens the detail drawer. **Double-click** on an editable cell enters inline edit instead (the edit handler stops propagation).
- **Inline edit**: input takes `autoFocus`, inherits alignment, accent border. `Enter` or blur commits, `Escape` cancels. Money/mono columns are coerced with `Number(String(v).replace(/[^\d.-]/g,''))`. Commit fires a success toast naming the record and column.
- **Selection**: per-row checkboxes; the header checkbox selects/clears **the currently filtered set**, and reads checked only when every visible row is selected. Delete removes rows optimistically (tracked per module) and toasts a warning.
- **Column visibility**: per-module, persists while the session lives; hidden columns still participate in search.
- **Widget layout**: `Edit layout` reveals per-widget controls; reorder swaps adjacent positions in the order array; widen toggles +3 grid columns capped at 12; hide moves the widget to a restore-chip row.
- **Charts**: bar hover sets a hovered index that both solidifies the bar fill and renders the tooltip; mouse-leave clears it.
- **Overlays**: scrim click closes drawer, modal, and customizer.
- **Transitions**: sidebar width `.16s ease`; drawers `.16s` slide; modal/menu/toast `.10–.16s` fade+rise; bar and nav color changes `.12s`.

## State Management

Single view-model; in production split per concern (route state, table state, user preferences persisted to profile/localStorage).

| Key | Type | Purpose |
|---|---|---|
| `mod` | string | active module id |
| `dark`, `accent`, `density`, `fs`, `collapsed` | bool/string/number | user preferences — **persist these server-side per user** |
| `q`, `sortKey`, `sortDir`, `filter` | string/number | table query state (reset on module change) |
| `sel` | `{id: bool}` | row selection |
| `editing`, `editVal` | `"rowId\|colKey"`, string | inline edit target and buffer |
| `drawer` | record or null | detail drawer subject |
| `modal`, `form`, `errs` | bool, object, object | create-record modal |
| `toasts` | array | transient notifications (id, text, kind) |
| `cols` | `{module: {colKey: hidden}}` | per-module column visibility |
| `colMenu`, `customizeOpen`, `layoutEdit` | bool | overlay/mode flags |
| `order`, `hidden`, `wide` | array, maps | dashboard widget layout |
| `extra`, `removed` | `{module: rows}`, `{module: {id:true}}` | optimistic creates/deletes |
| `tip` | number or null | hovered chart bar |

Data fetching in production: one list endpoint per module with server-side pagination, sort, filter, and search (the prototype does all of this client-side over fixed arrays); a detail endpoint for the drawer; PATCH for inline edits; POST for creates; bulk endpoints for approve/delete/export.

## Design Tokens

**Accents** (the six offered): Blue `#2563eb` *(default)*, Indigo `#4f46e5`, Teal `#0d9488`, Violet `#7c3aed`, Amber `#b45309`, Graphite `#334155`.
`accent-soft` = accent at **12%** alpha (light) / **22%** (dark).

**Surfaces**

| Token | Light | Dark |
|---|---|---|
| bg | `#f6f7f9` | `#0d1117` |
| panel | `#ffffff` | `#151b24` |
| foreground | `#14181f` | `#e7eaf0` |
| muted | `#6b7382` | `#8b93a3` |
| border | `#e3e6eb` | `#242c38` |
| hover | `rgba(0,0,0,.028)` | `rgba(255,255,255,.045)` |
| track | `rgba(0,0,0,.06)` | `rgba(255,255,255,.08)` |
| nav | `#111725` | `#080b11` |

**Status colors** (badge text; background is the same color at 11% / 20% dark):
`#0d9488` Confirmed, OK, Approved, Paid, Active, Strategic-adjacent success · `#2563eb` Open, Released, Key · `#64748b` Draft, Cancelled, Closed, Standard · `#0891b2` Shipped, Received, Posted · `#b45309` In production, Low, Awaiting approval, Watchlist, On leave · `#dc2626` Blocked, Critical, Material shortage, Overdue, Notice · `#7c3aed` Partially received, Strategic.

**Typography**: `IBM Plex Sans` 400/500/600/700 for UI; `IBM Plex Mono` 400/500/600 for ids, numbers, money, timestamps, and micro-labels. Base body size `12.5px` (compact) / `13.5px` (comfortable), multiplied by the font scale (0.85–1.30). Line-height 1.45. Scale in use: 9.5, 10, 10.5, 11, 11.5, 12, 12.4, 12.5, 13, 14, 14.5, 15, 16, 22px. Negative tracking on headings (`-.01em` to `-.025em`); positive tracking on mono micro-labels (`.07em`–`.09em`).

**Density** → vertical cell padding: Compact **6px**, Comfortable **10px**, Relaxed **14px** (header cells use +2px).

**Spacing**: 1, 4, 6, 8, 9, 10, 12, 13, 14, 16, 18, 20px. Grid gap 12px, content padding `16px 18px`.

**Radius**: 3 (checkbox), 4 (badge, code chip), 5 (small button, tooltip), 6 (button, input, nav item), 7 (segmented), 8 (panel, swatch, widget), 9px pill (nav badge), 50% (avatar, dot).

**Shadows**: dropdown `0 12px 30px rgba(0,0,0,.16)`; modal `0 24px 60px rgba(0,0,0,.32)`; toast `0 8px 26px rgba(0,0,0,.28)`; swatch selection ring `0 0 0 2px <panel>, 0 0 0 4px <accent>`.

**Scrollbars**: 9px, thumb `rgba(128,138,157,.35)` radius 6, transparent track.

## Assets
None. No images or icon fonts — every glyph is a Unicode character (`✓ ✕ ◀ ▶ ↔ ↑ ↓ ☀ ☾ « » /`) and the only external dependency is IBM Plex Sans + IBM Plex Mono from Google Fonts. Substitute the codebase's own icon set for the glyphs.

## Files
- `ERP System.dc.html` — the full prototype (template + logic + sample data). Open it directly in a browser.
- `support.js` — runtime required by the prototype; not part of the design.

## Notes for implementation
- Accent **blue** is the intended default; the other five are user choices, not brand variants.
- The color-blindness risk in the status palette is teal vs. blue — badges always carry text, never color alone. Preserve that.
- Tables are the product. Keep compact density the default, keep the sticky header, and keep horizontal scroll rather than truncating columns.
- Preferences (accent, theme, density, font scale, sidebar, column visibility, widget layout) should persist per user account, not per device.


---

## Addendum — Final version

### Analytics band (every module)
All non-settings modules render a 12-column chart grid **above** their main content (`gap:12px`, 12px bottom margin). Chart card = panel bg, 1px border, radius 8, header `11px 13px 0` (title 12.5px/600 + note 10px mono muted, both truncating).

Six chart primitives, all hand-built SVG/CSS — no chart library required, but substitute the codebase's charting lib if one exists:
- **Stat + sparkline** — span 3. 26px/600 value, delta 11px/600 (green up / red `#dc2626` down), 46px-tall filled sparkline in the delta color.
- **Column chart** — span 5–8, 150px tall. Accent bars at 34% alpha (45% dark), solid on hover with a dark tooltip above.
- **Donut** — span 4. 112px SVG, `r=54`, `stroke-width=21`, rotated −90°, segments via `stroke-dasharray`/`dashoffset` over a track ring; center holds a 17px value + 9px mono label; legend below with 9px square swatches, label, and `value · %`.
- **Ranked horizontal bars** — span 5. Label + right value, 7px track, fill per palette index.
- **Line chart** — span 5–7. 600×190 viewBox, 4 horizontal gridlines in border color, filled area at 10% accent, 2.5px accent stroke; optional dashed second series (teal) with a legend.
- **Heatmap** — span 7. Row labels + column headers in 9px mono, 19px cells at radius 3, accent alpha ramped `0.12 → 0.90` by value, `title` tooltip per cell, LOW→HIGH scale legend.
- **Stacked bars** — span 5. 9px rounded track split into palette-colored segments, legend below.

Chart palette (series colors, cycling): accent, `#0d9488`, `#7c3aed`, `#b45309`, `#0891b2`, `#64748b`, `#db2777`.

Per-module chart sets (5–8 charts each) are defined in `buildCharts()` — dashboard (division donut, cash vs forecast, OTD, intake heatmap, headcount stack), reports (4 stats, channel mix, intake columns, country×quarter heat, cost structure), sales, inventory, purchasing, manufacturing, finance, CRM, HR. Copy the values verbatim for the prototype; wire to aggregate endpoints in production.

### ERP Assistant
Header button **✦ Ask ERP** (chip styling, accent-soft when open) toggles a **384px** right-docked panel (`z-index:95`, `box-shadow:-14px 0 40px rgba(0,0,0,.14)`, slide-in .16s). No scrim — the module stays usable underneath, deliberately: it is a work surface, not a modal.

Anatomy: header (26px accent tile + title + `Searches orders · invoices · stock · people` + clear/close icon buttons) → scrolling message log → suggestion chips (radius 14, 10.5px, 1px border) → input row (34px input + 34px accent send button).

Message bubbles: max-width 88%, padding `9px 12px`, 12.5px, line-height 1.5. User = accent fill, white, radius `10 10 3 10`, right-aligned. Bot = hover-tint bg, 1px border, radius `10 10 10 3`, left-aligned. A 380ms `Searching records…` placeholder precedes each answer.

Two rich attachments below a bot bubble:
- **Fact tiles** — 2-col grid with 1px hairline gutters; 9px mono uppercase label + 14px/600 value.
- **Result cards** — 1px border, radius 8, padding `9px 11px`: accent mono id + status badge + right-aligned amount, then title (12px) and `module · qualifier` (9.5px mono muted). **Clicking a card navigates to that module and opens the record's detail drawer.**

Intent resolution (prototype is deterministic — swap for real NL search/RAG in production, keeping the response *shape*):
1. **Document-id regex** `(so|po|mo|inv|mat|cu|emp)-?\w*\d` → exact/partial id lookup across all seven tables.
2. **Intent keywords** → overdue/past-due, low stock/reorder/critical, approvals, blocked/shortage, top customers, suppliers, headcount/payroll, revenue/turnover, production/OEE, greeting.
3. **Fallback** — full-text scan of every field of every record in every module, reporting hit count and how many modules matched.
4. **No match** — suggests the id prefixes and an example question.

Answers always state a number and a consequence (`3 invoices are past due, worth €360.600 in total. The oldest is INV-2026-4404 at 37 d.`), never just a list.

### Wireframes
`ERP Wireframes.dc.html` — six lo-fi frames (dashboard, table module, detail drawer, create modal, assistant, customize/settings) with numbered annotations and a navigation-model strip. Greyscale only; hatched blocks = charts, lined blocks = text, striped blocks = tables. Use these for structure review; the hi-fi file is the source of truth for values.
