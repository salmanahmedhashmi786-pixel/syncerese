# Prompt for Claude Code: Build "Syncrèse" — a Horizontal SME ERP MVP

Copy everything below into Claude Code (or a `CLAUDE.md` project file) as your starting brief.

---

## Project Brief

The product is called **Syncrèse**. I'm building it as a horizontal, multi-tenant ERP SaaS for small/medium businesses in the US and Europe. This is an MVP for a solo founder — it needs to be a genuinely usable, sellable v1, not a toy demo. Prioritize a **rock-solid financial core**, **clean multi-tenant architecture**, and a **highly customizable, interactive UI**, over feature breadth. Work incrementally, explain your architectural decisions, and flag anything that's a bad idea before building it.

### Branding
- **Product name:** Syncrèse (note the accented è — preserve it correctly in the UI, page titles, emails, and metadata; also register a safe ASCII fallback slug like `syncrese` for URLs, package names, and anywhere accented characters cause issues).
- **Logo:** I'm providing the Syncrèse logo (`syncrese-logo.jpg` — an interlocking teal-to-navy gradient "infinity/S" mark above the wordmark in bold black uppercase). Use it as:
  - The sidebar brand mark (replacing the mockup's generic 26×26 accent square + mono initial with the actual Syncrèse mark — adapt sizing to fit the sidebar brand row spec, and produce a simplified small-scale version of the mark alone for collapsed-sidebar/favicon use).
  - The desktop app icon (generate the full platform icon set — `.ico` for Windows, `.icns` for macOS, and PNG sizes for Linux — from the logo).
  - The browser favicon, the login/activation screen, and the desktop installer branding.
  - The default accent color palette should draw from the logo's teal-to-navy gradient — treat this as the **Syncrèse default theme**, while still keeping the mockup's 6 selectable accent colors available as user choices (Blue stays the neutral default in the design spec; consider making the Syncrèse teal an additional 7th accent option or the tenant-level default — use your judgment and flag the tradeoff to me).
  - Since the logo is a raster JPG with a white background, produce/request a transparent-background version (PNG/SVG) for use on the dark sidebar — flag this to me as something I likely need to supply separately, since the mark won't look right on the dark `#111725` sidebar background as-is with a white box around it.
- **Naming in code:** use `Syncrese` (no accent) for package names, database names, repo name, and environment variables; use `Syncrèse` (with accent) in user-facing UI text only.

### Tech stack
- **Frontend:** Next.js (App Router) + TypeScript + Tailwind CSS
- **Backend:** Next.js API routes / server actions (or a separate Node/TypeScript service if you think that's cleaner for background jobs)
- **Database:** PostgreSQL (use Prisma or Drizzle ORM — pick one and justify it)
- **Auth:** NextAuth/Auth.js or Clerk — must support role-based access control (RBAC) from day one
- **Backend hosting:** the multi-tenant backend + database stay centrally hosted (Vercel/managed Postgres, e.g. Neon/Supabase/RDS) — this does NOT change. What changes is the client:
- **Desktop client:** package the same Next.js/React UI as a **native desktop installer app for Windows, macOS, and Linux** using **Electron** or **Tauri** (propose which one and justify it — Tauri is lighter-weight/more secure but Electron has broader Node ecosystem compatibility; pick one, don't build both). The desktop app is a client shell that talks to the hosted multi-tenant API over HTTPS — it is not a fully offline/local database app. Confirm this architecture with me before building the desktop shell.
- **Installers:** produce a signed `.exe`/`.msi` (Windows), `.dmg`/`.pkg` (macOS), and `.AppImage`/`.deb` (Linux) via the packaging tool's built-in build pipeline (electron-builder or Tauri's bundler). Include auto-update support so I can ship fixes without customers manually reinstalling.

### Design reference — use these mockups as the source of truth for UI/UX
I'm providing a high-fidelity HTML/CSS design prototype (`ERP System.dc.html`) plus lo-fi wireframes (`ERP Wireframes.dc.html`) and a full design-handoff spec (`README.md`) covering: a dark persistent sidebar with grouped navigation and collapse state, a sticky module header with search/theme-toggle/Customize/+New, a 12-column dashboard grid with a live drag-and-drop-style widget layout editor (reorder/widen/hide), dense sortable/filterable data tables with inline cell editing and bulk actions, a right-anchored record detail drawer, a create-record modal with validation, a right-docked "✦ Ask ERP" AI assistant panel (this is the chatbot from MUST DO #12 — build it to this spec), a Customize drawer (accent color, light/dark, row density, sidebar state, font scale — persisted per user account, not per device), toasts, and a full design-token system (colors, typography using IBM Plex Sans/Mono, spacing, radius, shadows) plus 7 reusable chart primitives (stat+sparkline, column, donut, ranked bars, line, heatmap, stacked bars).

**Do not ship the prototype HTML as-is.** It's a design reference authored in raw HTML/inline styles to communicate exact visual intent — recreate it faithfully inside the real Next.js/React + Tailwind codebase, using proper components, routing, and the actual data layer (not the prototype's hardcoded sample data). Where the design spec gives exact values (colors, spacing, type scale, component anatomy), treat those as final-intent and implement them precisely — this is what makes the product feel premium and worth paying for versus dated incumbent UIs like SAP/NetSuite. Read the full README.md handoff doc I've provided for exact specs (color tokens for light/dark, the 6 accent-color options, status-badge color coding, component dimensions, animation timings, etc.) before building any screen.

---

## MUST DO (non-negotiable — build these first, correctly, before anything else)

### 1. Multi-tenant architecture (foundational)
- Every table, query, API route, and background job must be tenant-scoped from the start. Use a `tenant_id`/`organization_id` on all business tables, enforced at the query layer (e.g., Postgres Row-Level Security or a mandatory query middleware) — not just app-level filtering that's easy to forget.
- Support one user belonging to multiple organizations (common for SME consultants/accountants).
- Design the schema so a tenant can be fully exported or deleted cleanly (GDPR-relevant for EU customers).

### 2. Auth, roles & permissions (RBAC)
- Role-based access control with at least: Owner, Admin, Accountant/Finance, Sales, Read-only.
- Permissions should be enforced server-side on every mutation, not just hidden in the UI.
- Session/auth should support email+password and at least one SSO option (Google/Microsoft) since many SME buyers are Microsoft 365 shops.

### 3. Audit trail
- Every create/update/delete on financial and core business records must write an immutable audit log entry (who, what, when, before/after values). This is a baseline buyer expectation and needed for trust/compliance.

### 4. Core Finance & Accounting module (the system of record)
- Double-entry general ledger (this must be architecturally correct — every transaction posts balanced debits/credits; don't cut corners here even in MVP).
- Chart of accounts (with a sensible SME default template, customizable).
- Accounts Payable & Accounts Receivable (invoices, bills, payments, basic aging reports).
- Bank transactions (manual entry + CSV import for MVP; note where a future bank-feed integration would plug in).
- Multi-currency support at the data-model level, even if only 1–2 currencies are exposed in the UI initially.
- Core financial reports: P&L, Balance Sheet, basic cash flow view.

### 5. Sales & Order Management (light)
- Customers, quotes, sales orders, invoices — with a clean flow from quote → order → invoice → payment that posts correctly to the ledger.

### 6. CRM (light)
- Contacts/companies, pipeline stages, activity/notes log. Keep this simple — it should feed Sales, not try to be a full CRM.

### 7. Inventory (basic)
- Products/items, stock levels, simple stock-in/stock-out movements tied to sales orders. Don't build full warehouse/MRP logic yet.

### 8. API-first design
- Every core action available through the UI must also be exposed via a documented REST (or GraphQL) API with proper auth (API keys or OAuth per tenant).
- Include webhooks for key events (invoice created, payment received, order status changed) — this is what will let Slack/Microsoft 365/Zapier integrations plug in later without re-architecting.

### 9. Interactive, customizable UI/UX (this is a differentiator, build it properly)
- **Drag-and-drop dashboard builder:** each tenant/user can add, remove, resize, and rearrange widgets (KPI cards, charts, tables, recent activity) on their home dashboard. Persist layout per user.
- **Configurable workflow builder (lightweight, not a full BPMN engine):** let admins define simple automation rules — trigger → condition → action (e.g., "when invoice is overdue 7 days → send reminder email" or "when deal moves to Won → create sales order"). Build this as a clean, extensible data model even if the MVP only ships a handful of trigger/action types.
- **Custom fields:** let tenants add custom fields to core objects (Customer, Product, Deal, Invoice) without a schema migration — use a flexible metadata/JSONB-backed approach.
- **White-label branding:** logo, primary/accent color, and (later) custom domain per tenant.
- **Module toggles:** tenants can enable/disable modules (CRM, Inventory, etc.) from settings — the UI/nav should adapt accordingly.
- Use a real design system (not default unstyled components) — clean, modern, data-dense but not cluttered. This matters a lot for perceived value against incumbents like NetSuite/SAP that are notorious for dated UI.

### 10. Multi-currency & basic localization scaffolding
- Don't hard-code USD-only assumptions anywhere, even if only USD/EUR/GBP are supported at launch.

### 11. Filtering, search & demographics/analytics
- Every core list view (Customers, Invoices, Deals, Products, Orders) needs robust filtering (by date range, status, owner, tag, custom field, amount range) and saved filter views per user.
- Global search across core objects.
- A basic "business demographics" analytics layer: dashboards/reports segmenting customers and revenue by useful cuts — industry, company size, region/country, acquisition source, currency, customer lifetime value, churn/at-risk flags. This is a genuine differentiator for SME buyers who currently have to build this in spreadsheets — build the data model so new segments/dimensions can be added without a rewrite (tag-based or custom-field-driven segmentation, not hard-coded categories).

### 12. In-app AI chatbot / assistant
- A chat interface (accessible from anywhere in the app) that can answer natural-language questions against the tenant's own data — e.g. "show me overdue invoices over $5k," "which customers churned this quarter," "summarize this month's P&L."
- Architect it as: user query → intent/entity extraction → scoped, permission-aware query against the tenant's data (never cross-tenant) → LLM-generated natural-language summary of real query results. Do not let the model invent numbers — it must only summarize/explain data actually retrieved.
- Respect RBAC: the assistant must only see/return data the asking user is permitted to see.
- Keep the first version narrow (financial + CRM Q&A) rather than trying to cover every module at once.

### 13. Internal team chat (within an organization)
- A built-in chat/messaging feature so all users within one tenant/organization can message each other — DMs and simple channels/groups (e.g., per-department or per-project).
- Should support @mentions and basic notifications, and ideally let messages reference/deep-link to ERP records (e.g., "@Sarah check this invoice #1234").
- This is tenant-scoped like everything else — no cross-organization messaging.
- Use a straightforward real-time approach (WebSockets, e.g. via Pusher/Ably/Socket.io, or Postgres LISTEN/NOTIFY) — don't over-engineer this into a separate messaging platform.

### 14. Connectors with standard business tools (thin but real, not just "future-ready")
- Build actual, working native integrations for the two most requested by SME buyers, on top of the webhook/API layer:
  - **Slack:** send notifications to a channel/DM for key events (invoice paid, deal won, overdue payment, new lead) and support a basic slash command to query the ERP (e.g., `/erp invoice status #1234`).
  - **Microsoft Teams:** equivalent notification/webhook integration (Teams incoming webhooks or a Teams app), given how much of the SME market lives in Microsoft 365.
- Beyond these two, don't hand-build more native connectors yet — instead, ship a clean, documented public API + webhook system and a **Zapier/Make-compatible app definition** so customers (or you, later) can connect to other "famous standard tools" (Google Workspace, QuickBooks, HubSpot, etc.) without you maintaining a bespoke integration for each.
- OAuth-based connection flow per tenant (each tenant connects their own Slack/Teams workspace — never share credentials across tenants).

### 15. GDPR compliance (must be real, not a checkbox)
- **Data residency awareness:** design the schema/infra so EU tenant data *could* be pinned to an EU region later without a rewrite (don't hard-code a single US-only database region assumption).
- **Right to access & right to erasure:** build an admin function (and ideally a self-service one) to export all of a tenant's data and to fully delete a user's or tenant's personal data on request, including cascading deletes/anonymization in the audit log where legally permissible (audit logs may need anonymization rather than deletion — flag this tradeoff to me rather than deciding silently).
- **Consent & data minimization:** don't collect personal data (especially in CRM/contacts) beyond what's needed; make any marketing-consent field explicit and auditable.
- **Data processing agreement readiness:** keep clear separation of tenant data so you can honestly tell customers where their data lives and who can access it (support/admin access should itself be logged).
- **Cookie/consent banner** on any public-facing marketing pages, defaulting to privacy-preserving choices.
- **Breach-readiness:** structure logging so you could reconstruct "who accessed what" if you ever needed to report a breach within GDPR's 72-hour window.

### 16. Product-key licensing & admin-gated user provisioning (this is how I charge per user — must be enforced server-side, not just in the desktop client)
- **Licensing model:** each tenant/organization purchases a license tied to a **product key** and a **seat count** (number of users they've paid for). The product key is issued/managed by me (or generated automatically on signup/payment) and is the source of truth for how many user accounts that tenant is allowed to create.
- **Org Admin role:** the tenant's Owner/Admin account is the only role that can create new user accounts within their organization. When they attempt to create a new user, the system must:
  1. Validate the tenant's product key against the central licensing service (hosted alongside the backend — this must NOT be checkable purely on the desktop client, since a modified client shouldn't be able to bypass it).
  2. Check current active-user count against the licensed seat count.
  3. Block user creation with a clear error ("Seat limit reached — purchase additional seats or upgrade your plan") if the tenant is at or over their licensed seats.
  4. On successful creation, decrement/track seat usage and log the action in the audit trail.
- **Desktop app activation:** on first install/launch, the desktop app should prompt for the organization's product key (or an admin login that resolves to one) before allowing any use — this is the licensing gate for the installer-based distribution model. Treat the product key as a license identifier, not a payment credential — don't build actual payment/card processing into the desktop app itself; that stays on a web-based billing page (Stripe or similar) that issues/renews the key.
- **Seat management UI:** the Admin should be able to see current seat usage (e.g., "7 of 10 seats used"), see a list of active users, deactivate/offboard a user (freeing a seat without deleting their historical records/audit trail — deactivate, don't hard-delete, per GDPR/audit needs above), and get a clear prompt to upgrade seats when near/at the limit.
- **Anti-tamper consideration:** because this is a distributed desktop app (unlike a pure web SaaS you fully control), assume a technically sophisticated user could try to tamper with the client. All licensing/seat enforcement must be re-validated server-side on every user-creation request and periodically re-validated during normal app usage (e.g., on login) — never trust a client-side "seats remaining" value as authoritative.
- Propose the product-key format/generation scheme (e.g., signed JWT-style key encoding tenant ID + seat count + expiry, versus a simple database-backed key with server lookup) and get my confirmation before implementing — this is a decision with real security implications.

### 17. Build the UI/UX to the provided design mockups
- Implement every screen (Executive dashboard, Reports & analytics, the seven table modules, Settings, the record detail drawer, create-record modal, Customize drawer, toasts, and the "✦ Ask ERP" assistant panel) matching the provided design handoff exactly in layout, spacing, typography, and interaction behavior — using real React components and Tailwind (mapped to the design's token system: colors, spacing scale, radius, shadows) rather than copying the prototype's inline-styled HTML.
- Build the **6 accent-color options**, **light/dark theme**, **row density (Compact/Comfortable/Relaxed)**, **sidebar collapse state**, and **font-scale** controls exactly as specified, and persist these preferences **per user account server-side** (not per-device localStorage-only) so they follow the user across the desktop app and any future web access.
- Build the reusable chart primitives (stat+sparkline, column chart, donut, ranked horizontal bars, line chart, heatmap, stacked bars) as real components driven by live data from the backend, not the prototype's hardcoded sample series — every module's analytics band should aggregate real tenant data.
- Table module behavior (sorting, filtering by status chips, free-text search across all columns including hidden ones, inline double-click-to-edit cells, bulk select/approve/export/delete, column visibility toggles) must work against real paginated, server-side-filtered data, not client-side arrays — the prototype does this client-side for demo purposes only; production must not load a tenant's entire dataset into the browser/client at once.

### 18. Cybersecurity fundamentals
- Encrypt sensitive data at rest and in transit (HTTPS everywhere, TLS to the database).
- Hash/salt credentials properly (bcrypt/argon2); never store plaintext secrets.
- Rate-limit and monitor auth endpoints (brute-force protection, optional MFA for Owner/Admin roles — treat MFA as strongly recommended, not optional, for financial-data access).
- Enforce strict tenant isolation at the query layer (Postgres RLS or equivalent) so a bug can never leak one tenant's data to another — this is the single most damaging failure mode for a multi-tenant ERP.
- Input validation/sanitization on every API route; parameterized queries only (no raw SQL string concatenation).
- Secrets management: no secrets in source control; use environment variables / a secrets manager.
- Dependency hygiene: lockfiles, and flag if you use any package with known critical vulnerabilities.
- API security: per-tenant API keys with scoped permissions and rate limiting; webhook payloads signed (HMAC) so receivers can verify authenticity.
- Structure the codebase so a future SOC 2 audit isn't a rewrite — clear data-access boundaries, no sensitive data in logs, documented data flows.
- Log and alert on anomalous access patterns (e.g., one user exporting unusually large amounts of data) — doesn't need to be sophisticated at MVP stage, but the hooks should exist.

---

## NICE-TO-HAVE (good, but don't build until the above is solid)

- **Expanding the AI assistant** beyond finance/CRM Q&A — into proactive insights, anomaly detection on transactions, AI-drafted report narratives, AI-assisted data entry.
- **Additional native connectors** beyond Slack/Teams (Salesforce, Google Workspace, QuickBooks/Xero import, HubSpot) — use the Zapier/Make layer and API until real demand justifies bespoke ones.
- **SAP/Oracle connectors** — enterprise-grade, high-maintenance; only worth it once you have paying enterprise-track customers.
- **Procurement/Purchasing module** (POs, vendor management).
- **Project management module** (time tracking, project billing) — useful for services SMEs, but a v2 feature.
- **Advanced BI/custom-report builder** beyond the fixed P&L/Balance Sheet and demographics dashboards.
- **Multi-entity/consolidation** accounting (for customers with multiple subsidiaries).
- **Marketplace/plugin system** for third-party extensions.
- **Mobile app** (start with a responsive, mobile-friendly web UI; native app later).
- **Payroll** — do not build; plan to integrate with a third-party provider (e.g., Gusto/Rippling) later.
- **Manufacturing/MRP** — do not build in this MVP at all.
- **Video/voice calls** in the internal team chat — text chat only for now.
- **Formal SOC 2 certification** — build toward it structurally, but the audit itself is a later-stage investment.

---

## Explicit things to AVOID
- Don't build native SAP, Oracle, or Salesforce connectors yet — far too heavy for MVP; the API/webhook layer, plus Slack and Teams, is what matters now.
- Don't try to build payroll or tax-filing logic — legally risky and jurisdiction-specific; stub with a clear "coming via integration" placeholder.
- Don't over-engineer the workflow builder into a full BPM/rules engine — keep the trigger/condition/action model simple and extensible.
- Don't over-engineer the internal team chat into a full messaging platform (no video/voice, no elaborate channel admin) — DMs, simple groups, mentions, and record deep-links are enough.
- Don't let the AI chatbot generate or guess numbers it didn't retrieve from the tenant's actual data — this destroys trust in a finance product instantly.
- Don't skip the audit trail, RBAC, tenant isolation, or GDPR data-export/erasure "for now" — these are foundational, legally relevant, and expensive to retrofit.
- Don't hard-code single-tenant, single-region, or USD-only assumptions anywhere in the schema or queries.
- Don't store any real secrets, API keys, or credentials in source control or logs.
- Don't trust the desktop client as the authority on seat/license limits — always re-validate server-side; a client-side-only check is trivially bypassed once software is installed on someone's machine.
- Don't build actual credit-card/payment processing inside the desktop app — keep billing on a web page (Stripe Checkout/Billing Portal or similar) that issues the product key; the desktop app only *consumes* a key, it doesn't handle payments.
- Don't build a fully offline/local-database version of the app for this MVP — it's a hosted multi-tenant backend with a native client shell, not an offline desktop database product (that's a much bigger, different architecture).
- Don't reinvent the design system — implement the provided mockup's exact tokens (colors, spacing, type scale, component dimensions) rather than approximating "something similar."

---

## How I want you to work
1. Start by proposing the **database schema** (core tables, relationships, tenant scoping strategy, plus licensing/seat tables) and get my confirmation before generating code.
2. Then scaffold the **project structure** (folders, auth, tenant middleware, RBAC, audit logging, tenant isolation via Postgres RLS) — the security/multi-tenancy foundation — before building feature modules.
3. Build **Finance/Accounting first**, fully working end-to-end (ledger → reports), before touching Sales/CRM/Inventory.
4. Build the **web UI** for core modules against the provided design mockups (implementing the design-token system properly) before wrapping it in a desktop shell — it's much faster to iterate on layout/behavior in a browser first.
5. Once core modules (Finance, Sales, CRM, Inventory) exist with real data flowing and the UI matches the design spec, build these as their own subsystems, in this order: (a) dashboard/workflow customization layer, (b) filters/search/demographics analytics, (c) internal team chat, (d) AI chatbot/assistant ("✦ Ask ERP" panel), (e) Slack + Teams connectors.
6. Build the GDPR data export/erasure tooling and the cybersecurity checklist items (RLS enforcement, secrets management, input validation, MFA, webhook signing) as an explicit pass — don't treat them as implicit side effects of other work.
7. Build the **product-key licensing service and admin-gated user provisioning** next, including the seat-management UI — this needs the auth/RBAC and tenant model to already be solid.
8. Only once the web app is feature-complete and stable, wrap it as a **desktop installer app** (Electron/Tauri) for Windows, macOS, and Linux, wire up the product-key activation flow on first launch, and set up signed installer builds + auto-update.
9. After each major module, give me a short summary of what was built, what's stubbed, and what decisions you made — flag anything where you deviated from this brief or think a MUST DO item should be reprioritized.
10. Write tests for the accounting/ledger logic, tenant-isolation (a test that proves tenant A can never read tenant B's data), and seat-limit enforcement (a test that proves user creation is blocked server-side once a tenant is at its licensed seat count even if the client is bypassed) — these areas must never have silent bugs.

---

## Files to hand to Claude Code alongside this prompt
Attach/reference the design handoff bundle you were given: `ERP System.dc.html` (hi-fidelity prototype), `ERP Wireframes.dc.html` (lo-fi structural wireframes), `README.md` (the full design-token and component spec), and `syncrese-logo.jpg` (the product logo). Tell Claude Code to read the README in full before building any screen, and to treat it as the authoritative UI/UX spec for this project — with the branding section above overriding the mockup's generic placeholder brand mark.
