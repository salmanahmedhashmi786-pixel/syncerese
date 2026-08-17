# Syncrèse — Database Schema Proposal (v1)

**Status:** awaiting approval. No application code will be generated until this is signed off.
**Target:** PostgreSQL 16+ (Neon / Supabase / RDS compatible), Drizzle ORM.

Decisions already confirmed:

| Question | Decision |
|---|---|
| Module scope | Syncrèse set **+ Purchasing**. No Manufacturing, no payroll. |
| Accent | Syncrèse teal added as 7th accent, **tenant default**; spec's 6 remain user choices. |
| Invoicing | Built **e-invoicing-shaped** now (EN 16931 field coverage); transmission adapters deferred. |
| Logo | Quatrefoil mark **alone**, no wordmark — cropped from `syncrese-logo.jpg`. |
| Inventory valuation | **Weighted average cost.** Moving average held per (product, warehouse). |
| GDPR erasure | **Pseudonymisation/anonymisation** of audit logs, not deletion. |
| P2P depth | Full requisition → PO → receipt → invoice chain with **three-way match**. |
| Warehouse depth | **Bin locations + transfer documents.** Not full WMS — see §9. |

---

## 0. Conventions

These apply to every table unless explicitly noted.

- **Primary keys** are `uuid`, generated **application-side as UUIDv7** (`uuidv7` npm package). Rationale: UUIDv7 is time-sortable so it indexes like a sequence without leaking row counts, and generating in-app avoids depending on a Postgres extension that some managed providers restrict.
- **Tenant column**: `organization_id uuid not null references organizations(id)` on *every* business table. No exceptions — see §3.
- **Money** is stored as `bigint` **minor units** (cents) plus an explicit `currency_code char(3)`. Never `float`, never a bare `decimal` without its currency. `currencies.minor_unit` handles 0-decimal currencies (JPY) and 3-decimal (KWD).
- **Quantities** are `numeric(18,4)` — quantities legitimately need fractions (2.5 hours, 1.25 kg); money does not.
- **Timestamps** are `timestamptz`, always UTC. Dates that are legally dates (invoice issue date, due date) are `date`, not `timestamptz` — a German invoice issued on the 1st must not become the 31st in another timezone.
- **Status columns** are `text` + `CHECK` constraint, not Postgres `enum`. Enums require a migration and an exclusive lock to add a value; check constraints don't.
- **Soft delete**: `deleted_at timestamptz` on user-facing records. Ledger entries and audit rows are **never** soft-deleted or hard-deleted.
- **Audit columns**: `created_at`, `created_by`, `updated_at`, `updated_by` on business tables.
- **Custom fields**: a `custom_fields jsonb not null default '{}'` column on extensible entities, with a GIN index. Definitions live in `custom_field_defs` (§10).

---

## 1. Tenancy & identity

### `organizations`
The tenant root.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `slug` | text unique | ASCII only — `syncrese`-safe, used in URLs |
| `name` | text | display name, may contain accents |
| `legal_name` | text | appears on invoices |
| `region` | text | `eu-central` \| `us-east`, **check constraint**. Data-residency hook — see §14 |
| `base_currency` | char(3) | functional currency for the ledger |
| `locale` | text | e.g. `de-DE`, `en-US` — drives number/date formatting |
| `country_code` | char(2) | |
| `tax_id` | text | VAT / EIN |
| `fiscal_year_start_month` | smallint | 1–12, default 1 |
| `accent` | text | default `syncrese` — tenant-level branding |
| `logo_url` | text | white-label |
| `custom_domain` | text | reserved, unused in v1 |
| `status` | text | `active` \| `suspended` \| `pending_deletion` |
| `created_at`, `deleted_at` | timestamptz | |

### `users`
**Global, not tenant-scoped** — this is what lets one accountant serve many clients.

> **Implementation note (step 2):** `email` is `text` with a `CHECK (email = lower(email))`
> constraint rather than `citext`. The extension is unavailable on some managed
> Postgres (including the PGlite build the tests run against), and a check
> constraint enforces normalisation at the database without adding a deployment
> dependency.

`id`, `email text unique` (lowercased), `email_verified_at`, `password_hash` (argon2id, nullable for SSO-only accounts), `name`, `avatar_url`, `mfa_secret_encrypted`, `mfa_enabled_at`, `mfa_recovery_codes_hashed`, `last_login_at`, `failed_login_count`, `locked_until`, `status`, `created_at`, `deleted_at`.

`failed_login_count` + `locked_until` are the brute-force control from MUST DO #18, enforced in the database rather than only in a rate-limiter that a second app instance wouldn't see.

### `memberships` — user × organization
**This table is the seat counter.** Its row count is the licensing source of truth.

`id`, `organization_id`, `user_id`, `role_id`, `status` (`active` | `invited` | `deactivated`), `joined_at`, `deactivated_at`, `deactivated_by`. Unique on `(organization_id, user_id)`.

Deactivating sets `status='deactivated'` — the user keeps every historical record and audit entry they authored, and the seat is freed. **Nothing is ever hard-deleted here**, per MUST DO #16 and the GDPR/audit tension in §14.

### `roles`, `permissions`, `role_permissions`
`roles`: `id`, `organization_id` (null = system role), `key`, `name`, `is_system`. Seeded system roles: `owner`, `admin`, `finance`, `sales`, `readonly`.

`permissions`: `key` pk (e.g. `invoice.create`, `ledger.post`, `member.invite`, `license.manage`), `description`. `role_permissions` joins them.

Permissions are checked **server-side in a single middleware on every mutation**, never only in the UI. Org-defined custom roles are possible on this shape but not exposed in v1.

### `invitations`
`id`, `organization_id`, `email`, `role_id`, `token_hash`, `expires_at`, `accepted_at`, `invited_by`.

Seat availability is checked **twice** — when the invite is sent *and* again when it's accepted — because seats can fill in between.

### Auth.js tables
`accounts` (OAuth links), `sessions`, `verification_tokens` — standard Auth.js v5 Postgres adapter shape.

### `user_preferences` / `workspace_preferences`
Split deliberately:

- `user_preferences` (pk `user_id`): `theme`, `accent`, `density`, `font_scale`, `sidebar_collapsed`. Appearance follows the person everywhere — per README, server-side, not localStorage.
- `workspace_preferences` (pk `user_id, organization_id`): `column_visibility jsonb`, `dashboard_layout jsonb`. Structural layout is per-workspace, because an accountant's column setup for Client A shouldn't overwrite Client B's.

---

## 2. Licensing & seats (MUST DO #16)

### `licenses`
`id`, `organization_id` (unique — one live licence per org), `plan`, `seat_count int not null check (seat_count > 0)`, `status` (`trial`|`active`|`past_due`|`suspended`|`cancelled`), `valid_from`, `valid_until`, `grace_until`, `billing_ref` (Stripe subscription id), `created_at`, `updated_at`.

### `license_keys`
`id`, `license_id`, `organization_id`, `key_hash` (argon2id of the normalised key), `key_last4` (display only: `…4F2K`), `status`, `issued_at`, `revoked_at`, `revoked_reason`.

Partial unique index enforces **one active key per licence**.

**Key format:** `SYNC-XXXXX-XXXXX-XXXXX-XXXXX`, Crockford base32 (no `I`/`L`/`O`/`U` — unambiguous when read aloud over the phone to a support line), with a trailing check character. The key is **stored hashed, exactly like a password** — a database leak must not yield working licences.

The check character is the *only* thing the client is trusted to evaluate: it lets an obvious typo fail instantly without a round trip. Every real validation is a server lookup.

### `license_events` — append-only
`id`, `license_id`, `organization_id`, `event` (`issued`|`activated`|`renewed`|`seat_added`|`seat_removed`|`revoked`|`validation_failed`), `payload jsonb`, `actor_user_id`, `ip`, `created_at`.

### `device_activations`
`id`, `organization_id`, `license_id`, `device_fingerprint_hash`, `platform`, `app_version`, `first_seen_at`, `last_seen_at`, `revoked_at`.

Lets an admin see and revoke desktop installs. **Not** authoritative for seats — seats are people, not machines — but buyers expect this visibility.

### Seat enforcement — the critical part

Enforcement is a **database trigger**, not application code:

```sql
create or replace function enforce_seat_limit() returns trigger as $$
declare
  active_seats int;
  licensed_seats int;
begin
  if new.status <> 'active' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'active' then return new; end if;

  select seat_count into licensed_seats
    from licenses
   where organization_id = new.organization_id
     and status in ('trial','active')
   for update;                      -- serialises concurrent invite accepts

  if licensed_seats is null then
    raise exception 'SYNC_NO_LICENSE' using errcode = 'check_violation';
  end if;

  select count(*) into active_seats
    from memberships
   where organization_id = new.organization_id
     and status = 'active'
     and id <> new.id;

  if active_seats + 1 > licensed_seats then
    raise exception 'SYNC_SEAT_LIMIT_REACHED (% of % seats used)',
      active_seats, licensed_seats using errcode = 'check_violation';
  end if;
  return new;
end $$ language plpgsql;
```

Why a trigger rather than a service-layer check: a trigger cannot be forgotten by a new code path, cannot be bypassed by a direct API call, a bulk import, a background job, or a tampered desktop client — and the `FOR UPDATE` on the licence row closes the race where two admins accept invitations simultaneously and both pass a naive count. This is the guarantee the MUST DO #10 test asserts against.

---

## 3. Tenant isolation (MUST DO #1, #18)

Three layers, because any one of them can be defeated by a single mistake:

**Layer 1 — schema.** `organization_id` is `not null` on every business table. A row that belongs to nobody cannot exist.

**Layer 2 — Postgres RLS.** The application connects as a role that has **no `BYPASSRLS`** and is **not** the table owner. Every business table gets:

```sql
alter table invoices enable row level security;
alter table invoices force row level security;

create policy tenant_isolation on invoices
  using      (organization_id = current_setting('app.org_id', true)::uuid)
  with check (organization_id = current_setting('app.org_id', true)::uuid);
```

Every request runs inside a transaction opened with `set local app.org_id = $1`. `set local` scopes to the transaction, so a pooled connection cannot leak the setting to the next request. `force row level security` matters: without it the table owner silently bypasses the policy.

**Layer 3 — CI guard.** A test that queries `pg_class`/`pg_policies` and **fails the build** if any table in the business schema lacks both `relrowsecurity` and a `tenant_isolation` policy. This is what stops a table added in month six from quietly becoming the leak. Layers 1 and 2 protect against bugs; layer 3 protects against forgetting.

The MUST DO #10 isolation test seeds two orgs, sets `app.org_id` to A, and asserts every table returns zero of B's rows — including via aggregate, join, and raw count paths.

---

## 4. Finance core (MUST DO #4)

### `currencies`, `exchange_rates`
`currencies`: `code char(3)` pk, `name`, `minor_unit smallint`, `symbol`.
`exchange_rates`: `id`, `organization_id` (null = system feed), `base_code`, `quote_code`, `rate numeric(20,10)`, `as_of date`, `source`. Unique on `(organization_id, base_code, quote_code, as_of)`.

### `accounts` — chart of accounts
`id`, `organization_id`, `code`, `name`, `type` (`asset`|`liability`|`equity`|`income`|`expense`), `subtype`, `parent_id`, `is_postable`, `currency_code` (nullable — set for currency-specific accounts like a USD bank), `is_system`, `archived_at`. Unique on `(organization_id, code)`.

`subtype` is load-bearing, not decoration: it's how the system knows *which* account to auto-post to (`accounts_receivable`, `accounts_payable`, `bank`, `vat_payable`, `vat_receivable`, `inventory`, `cogs`, `fx_gain_loss`, `retained_earnings`). Without it, every automatic posting needs hard-coded account codes, which breaks the moment a tenant customises their chart.

`is_system` protects control accounts — a tenant must not be able to delete AR while invoices reference it.

Ships with an SME default template, fully customisable.

### `fiscal_periods`
`id`, `organization_id`, `fiscal_year`, `period_no`, `starts_on`, `ends_on`, `status` (`open`|`closed`|`locked`). Posting into a non-open period is rejected at the service layer and re-checked by trigger.

### `journal_entries`
`id`, `organization_id`, `entry_no bigint` (per-org sequence), `entry_date date`, `fiscal_period_id`, `description`, `source_type` (`manual`|`invoice`|`payment`|`stock_movement`|`fx_revaluation`), `source_id`, `status` (`draft`|`posted`|`reversed`), `posted_at`, `posted_by`, `reverses_entry_id`, `created_at`, `created_by`. Unique on `(organization_id, entry_no)`.

### `journal_lines`
`id`, `organization_id`, `journal_entry_id`, `line_no`, `account_id`, `debit_minor bigint not null default 0`, `credit_minor bigint not null default 0`, `currency_code`, `fx_rate`, `base_debit_minor`, `base_credit_minor`, `business_partner_id` (nullable — the AR/AP subledger), `tax_rate_id`, `memo`.

### The three ledger guarantees — enforced in the database

**1. Entries balance.** A `DEFERRABLE INITIALLY DEFERRED` constraint trigger checks at *commit*, not per-statement — so lines can be inserted one at a time inside a transaction and still be validated as a set:

```sql
-- per entry: total base-currency debits must equal total base-currency credits
create constraint trigger je_balanced
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function assert_entry_balanced();
```

> **Correction (step 3).** An earlier draft of this section also required each
> transaction currency to balance independently. That is wrong and would make
> correct multi-currency entries impossible to post. Settling a EUR payable from
> a USD bank account balances in base currency only — the transaction-currency
> legs deliberately do not, and the difference is the FX gain or loss. **Only
> the base currency is required to balance.**

**2. One side per line.** `check ((debit_minor = 0) <> (credit_minor = 0))` plus `check (debit_minor >= 0 and credit_minor >= 0)`. A line is a debit or a credit, never both, never negative — negative debits are how sloppy ledgers hide unbalanced entries.

**3. Posted entries are immutable.** A trigger raises on `UPDATE`/`DELETE` of any entry whose `status = 'posted'`. Corrections happen by posting a **reversing entry** linked through `reverses_entry_id`. This is what auditors expect and what makes the audit trail meaningful — a ledger you can edit is not evidence of anything.

Multi-currency: every line carries both its transaction amount and its base-currency amount at a recorded `fx_rate`. Ledger balances aggregate in base currency; AR/AP retain transaction currency so realised and unrealised FX differences are derivable rather than lost at entry time.

### `tax_rates`
`id`, `organization_id`, `code`, `name`, `rate numeric(6,4)`, `country_code`, `category`, `account_id`, `valid_from`, `valid_to`, **`en16931_category char(1)`** (S / Z / E / AE / K / G / O).

That last column is the e-invoicing decision made concrete: EN 16931 requires a tax *category code*, not just a percentage. A 0% line must state *why* it's zero — exempt, reverse charge, or intra-community supply are legally different things that a bare `0.0000` cannot express.

---

## 5. Business partners (customers, suppliers, prospects)

**One table, role flags** — `business_partners` with `is_customer`, `is_supplier`, `is_prospect`.

Rationale: separate `customers` and `crm_companies` tables is the classic source of duplicate-account pain — a prospect converts to a customer and you now have two records, two revenue histories, and a reconciliation problem. One partner, flags that accumulate.

`id`, `organization_id`, `partner_no`, `name`, `legal_name`, role flags, `country_code`, `tax_id`, `tax_scheme`, `registration_no`, `payment_terms_days`, `credit_limit_minor`, `currency_code`, `custom_fields jsonb`, `archived_at`.

E-invoicing routing: `einvoice_routing_id` (Peppol participant ID, Italian *codice destinatario*, or PEC address), `einvoice_format` (`peppol_bis3`|`fatturapa`|`facturx`|`none`).

### `partner_addresses`
`id`, `organization_id`, `partner_id`, `type` (`billing`|`shipping`|`legal`), `street`, `street2`, `city`, `region`, `postcode`, `country_code`.

**Structured, not a text blob** — EN 16931 mandates discrete address components. A single `address text` field cannot produce a compliant e-invoice.

### `partner_contacts`
`id`, `organization_id`, `partner_id`, `name`, `email`, `phone`, `role`, **`marketing_consent bool`**, `consent_recorded_at`, `consent_source`.

Consent is an explicit, timestamped, auditable field per MUST DO #15 — not an implied default.

---

## 6. Invoicing & payments

### `invoices` (AR **and** AP, discriminated by `direction`)
`id`, `organization_id`, `invoice_no`, `direction` (`ar`|`ap`), `business_partner_id`, **`partner_snapshot jsonb`**, `issue_date`, `due_date`, `delivery_date`, `payment_terms`, `currency_code`, `fx_rate`, `subtotal_minor`, `tax_total_minor`, `total_minor`, `base_total_minor`, `amount_paid_minor`, `status`, `journal_entry_id`, `source_order_id`, `notes`, `custom_fields`, `deleted_at`.

`partner_snapshot` captures the customer's name, address and tax ID **as of issue**. A legally issued invoice must not silently change when the customer moves office — a live foreign key would rewrite history.

E-invoicing columns: `document_type_code` (UNTDID 1001 — 380 invoice, 381 credit note), `buyer_reference`, `order_reference`, `payment_means_code`, `einvoice_status` (`not_required`|`pending`|`sent`|`accepted`|`rejected`), `einvoice_payload_id`.

`delivery_date` is separate from `issue_date` because EN 16931 requires the *supply* date, which is frequently not the invoice date.

Issued invoices are **never deleted** — they are credited. Only drafts honour `deleted_at`.

### `invoice_lines`
`id`, `organization_id`, `invoice_id`, `line_no`, `product_id`, `description` (**required** — EN 16931 mandates a line description even for a known product), `quantity numeric(18,4)`, `unit_code` (UN/ECE Rec 20, e.g. `C62` = piece, `HUR` = hour), `unit_price_minor`, `discount_pct`, `discount_minor`, `net_minor`, `tax_rate_id`, `tax_amount_minor`, `account_id`, `custom_fields`.

On AP invoices, lines additionally carry `purchase_order_line_id` and `goods_receipt_line_id`, and the header carries `match_status` / `match_tolerance_applied` — see the three-way match in §8. On AR invoices these are null.

### `payments` / `payment_allocations`
`payments`: `id`, `organization_id`, `payment_no`, `direction` (`in`|`out`), `payment_date`, `business_partner_id`, `bank_account_id`, `currency_code`, `fx_rate`, `amount_minor`, `base_amount_minor`, `method`, `reference`, `journal_entry_id`, `status`.

`payment_allocations`: `id`, `organization_id`, `payment_id`, `invoice_id`, `amount_minor`.

A separate allocation table is what makes partial payments and one-payment-across-many-invoices work correctly. Collapsing this into an `invoice_id` on `payments` is the single most common way SME accounting tools get AR wrong.

### `bank_accounts`, `bank_transactions`, `bank_import_batches`
`bank_accounts`: `id`, `organization_id`, `name`, `iban`, `bic`, `account_number`, `currency_code`, `gl_account_id`, `opening_balance_minor`.

`bank_transactions`: `id`, `organization_id`, `bank_account_id`, `value_date`, `booking_date`, `amount_minor`, `currency_code`, `description`, `counterparty_name`, `counterparty_iban`, **`external_id`**, `import_batch_id`, `reconciliation_status`, `matched_payment_id`, `journal_entry_id`.

`external_id` with a unique index is the idempotency key — it makes re-importing the same CSV a no-op, and it's exactly the field a future bank feed (Plaid / GoCardless / Nordigen) writes into. **`bank_import_batches` is the documented seam** where that integration plugs in without schema change.

---

## 7. Sales (MUST DO #5)

`quotes` → `sales_orders` → `invoices` → `payments`, each transition posting to the ledger.

- `quotes`: `id`, `organization_id`, `quote_no`, `partner_id`, `deal_id`, `status` (`draft`|`sent`|`accepted`|`declined`|`expired`), `valid_until`, `currency_code`, totals, `owner_user_id`, `custom_fields`. Plus `quote_lines`.
- `sales_orders`: `id`, `organization_id`, `order_no`, `partner_id`, `quote_id`, `status` (`draft`|`confirmed`|`partially_delivered`|`delivered`|`invoiced`|`cancelled`), `order_date`, `requested_delivery_date`, `currency_code`, totals, `owner_user_id`, `custom_fields`.
- `sales_order_lines`: `product_id`, `description`, `quantity`, `qty_delivered`, `qty_invoiced`, `unit_price_minor`, `tax_rate_id`, `net_minor`.

Tracking `qty_delivered` and `qty_invoiced` per line (rather than a single order-level status) is what makes partial delivery and partial invoicing representable.

### `deliveries` / `delivery_lines` — the shipment document

- `deliveries`: `id`, `organization_id`, `delivery_no`, `sales_order_id`, `partner_id`, `warehouse_id`, `status` (`draft`|`picked`|`shipped`|`cancelled`), `delivery_date`, `ship_to_address_id`, `carrier`, `tracking_ref`, `journal_entry_id`, `created_by`.
- `delivery_lines`: `id`, `organization_id`, `delivery_id`, `sales_order_line_id`, `product_id`, `quantity`, `bin_location_id`, `unit_cost_minor`.

Why this exists as its own document rather than a quantity on the order: **COGS posts at delivery, revenue posts at invoice**, and those are frequently different dates and different periods. Without a shipment document there is nothing to post cost-of-goods against, so margin lands in the wrong period whenever an order ships in one month and invoices in the next. It is also the exact mirror of `goods_receipts` on the buy side, which keeps the inventory posting logic symmetrical instead of special-cased per direction.

`delivery_lines.unit_cost_minor` records the weighted-average cost **as consumed at that moment** — see §9.

---

## 8. Purchasing / Procure-to-Pay

The full chain: **requisition → purchase order → goods receipt → vendor invoice → payment**, with three-way match as the control.

### `purchase_requisitions` / `purchase_requisition_lines`
The internal request that precedes a PO — raised by anyone, approved by a budget holder, then converted.

- `purchase_requisitions`: `id`, `organization_id`, `requisition_no`, `requested_by`, `department`, `status` (`draft`|`submitted`|`approved`|`rejected`|`converted`|`cancelled`), `needed_by`, `justification`, `approved_by`, `approved_at`, `rejected_reason`, `custom_fields`.
- `purchase_requisition_lines`: `id`, `organization_id`, `requisition_id`, `product_id` (nullable — free-text requests are normal at this stage), `description`, `quantity`, `estimated_unit_price_minor`, `currency_code`, `suggested_supplier_id`, `purchase_order_line_id` (set on conversion).

Requisitions are deliberately looser than POs: `product_id` is nullable because the requester often doesn't know the catalogue item, and pricing is an estimate. The buyer resolves both when converting.

**Approval routing: single approver by amount threshold.** `module_settings` holds a per-tenant `requisition_approval_threshold_minor` and an approver role (default `admin`). A requisition under the threshold auto-approves on submit; at or over it, it routes to one approver who approves or rejects. `approved_by` / `approved_at` / `rejected_reason` on the header carry the outcome, and every transition writes to `audit_log`.

No `requisition_approvals` table is created — multi-step and departmental routing are not built. If you later need them, that table is additive and the header fields stay valid as a denormalised "final outcome" record.

### `purchase_orders` / `purchase_order_lines`
- `purchase_orders`: `id`, `organization_id`, `po_no`, `supplier_id`, `requisition_id`, `status` (`draft`|`awaiting_approval`|`approved`|`partially_received`|`received`|`closed`|`cancelled`), `order_date`, `expected_date`, `currency_code`, `fx_rate`, totals, `buyer_user_id`, `approved_by`, `approved_at`, `ship_to_warehouse_id`, `custom_fields`.
- `purchase_order_lines`: `id`, `organization_id`, `purchase_order_id`, `product_id`, `description`, `quantity`, `qty_received`, `qty_invoiced`, `unit_price_minor`, `tax_rate_id`, `net_minor`, `expected_date`.

### `goods_receipts` / `goods_receipt_lines`
- `goods_receipts`: `id`, `organization_id`, `receipt_no`, `purchase_order_id`, `supplier_id`, `warehouse_id`, `receipt_date`, `status` (`draft`|`posted`|`reversed`), `delivery_note_ref`, `received_by`, `journal_entry_id`.
- `goods_receipt_lines`: `id`, `organization_id`, `goods_receipt_id`, `purchase_order_line_id`, `product_id`, `qty_received`, `qty_rejected`, `rejection_reason`, `bin_location_id`, `unit_cost_minor`, **`landed_cost_minor`**.

**Landed costs — manual entry only.** `landed_cost_minor` is a nullable per-line field the buyer types in directly (freight, duty, customs handling). It is added to the line's cost before the weighted-average recalculation in §9, so it capitalises into inventory value correctly rather than being expensed.

What is deliberately **not** built: automatic allocation of a freight invoice across receipt lines by weight, volume or value. That engine is where landed-cost features get expensive, and this shape supports adding it later without migration — a future allocator simply writes the same per-line column that a human writes today.

Posting a receipt debits inventory and credits **GR/IR** (goods-received/invoice-received, a clearing account seeded in the default chart with `subtype = 'gr_ir_clearing'`). The vendor invoice later debits GR/IR and credits AP. The GR/IR balance is therefore "received but not yet invoiced" — a number every auditor asks for and one you cannot produce if receipts post straight to AP.

### Three-way match
AP invoice lines carry `purchase_order_line_id` and `goods_receipt_line_id`. `invoices` gains `match_status` (`not_applicable`|`matched`|`price_variance`|`quantity_variance`|`unmatched`) and `match_tolerance_applied`.

Match rules live in `module_settings` per tenant (absolute and percentage tolerance on price and quantity). An invoice outside tolerance is **blocked from posting** and routed to approval rather than silently accepted — that block is the entire point of P2P. Variances post to a purchase price variance account (`subtype = 'ppv'`).

**Scope note.** Your brief said "don't build full warehouse/MRP logic yet", and requisitions with approval routing plus three-way match are a step beyond the "light" purchasing originally scoped. You've asked for them explicitly, so they're in — but flagging that this is the largest single scope increase since the original brief and it lands before Finance is complete in the build order. I'd still build Finance first and this immediately after, rather than interleaving.

---

## 9. CRM (MUST DO #6) & Inventory (MUST DO #7)

### CRM
Companies and contacts **reuse `business_partners` / `partner_contacts`** (§5) — see the rationale there.

- `pipelines`: `id`, `organization_id`, `name`, `is_default`.
- `pipeline_stages`: `id`, `organization_id`, `pipeline_id`, `name`, `position`, `probability_pct`, `is_won`, `is_lost`.
- `deals`: `id`, `organization_id`, `name`, `partner_id`, `pipeline_id`, `stage_id`, `amount_minor`, `currency_code`, `expected_close_date`, `owner_user_id`, `status` (`open`|`won`|`lost`), `lost_reason`, **`source`**, `custom_fields`, `closed_at`.
- `activities`: `id`, `organization_id`, `type` (`note`|`call`|`email`|`meeting`|`task`), `subject`, `body`, `related_type`, `related_id`, `due_at`, `completed_at`, `owner_user_id`.

`deals.source` is the acquisition-source dimension the demographics layer (MUST DO #11) segments on.

### Inventory
- `products`: `id`, `organization_id`, `sku`, `name`, `description`, `type` (`stock`|`service`|`non_stock`), `unit_code`, `sales_price_minor`, `cost_minor`, `currency_code`, `income_account_id`, `expense_account_id`, `inventory_account_id`, `tax_rate_id`, `is_tracked`, `reorder_point`, `barcode`, `custom_fields`, `archived_at`. Unique on `(organization_id, sku)`.
- `warehouses`: `id`, `organization_id`, `code`, `name`, `address_id`, `is_default`, `allows_negative_stock bool`, `archived_at`.
- `bin_locations`: `id`, `organization_id`, `warehouse_id`, `code` (e.g. `A-03-2`), `name`, `zone`, `type` (`storage`|`receiving`|`shipping`|`quarantine`|`transit`), `is_default`, `archived_at`. Unique on `(warehouse_id, code)`.
- `stock_levels`: pk `(product_id, warehouse_id, bin_location_id)`, `organization_id`, `qty_on_hand`, `qty_reserved`, **`avg_cost_minor`**, `currency_code`, `last_movement_at`. Maintained by trigger from movements — stored rather than derived, because recomputing on-hand from full movement history on every list view does not scale.
- `stock_movements`: `id`, `organization_id`, `product_id`, `warehouse_id`, `bin_location_id`, `qty_delta numeric(18,4)`, `movement_type` (`purchase_receipt`|`sale_delivery`|`adjustment`|`transfer_out`|`transfer_in`|`count_correction`|`scrap`), `unit_cost_minor`, `avg_cost_after_minor`, `source_type`, `source_id`, `journal_entry_id`, `occurred_at`, `created_by`.

### Bin locations — kept proportionate

`bin_location_id` is **nullable everywhere**. A tenant that doesn't care about bins never sees them: each warehouse gets an implicit default bin and the UI hides the concept entirely via `module_settings`. A tenant that does care gets real bin-level stock without a schema change or a migration.

This is deliberately *not* full WMS. There are no putaway strategies, no pick-path optimisation, no wave picking, no cycle-count programmes, no licence-plate/pallet tracking. Those are a different product. What's here is: stock is located, transfers are documented, and receipts and shipments name a bin.

### `stock_transfers` / `stock_transfer_lines`

- `stock_transfers`: `id`, `organization_id`, `transfer_no`, `from_warehouse_id`, `to_warehouse_id`, `status` (`draft`|`in_transit`|`received`|`cancelled`), `shipped_at`, `received_at`, `shipped_by`, `received_by`, `notes`, `journal_entry_id`.
- `stock_transfer_lines`: `id`, `organization_id`, `transfer_id`, `product_id`, `quantity`, `qty_received`, `from_bin_location_id`, `to_bin_location_id`, `unit_cost_minor`.

A transfer is **two movements with a gap**, not one instantaneous relocation. Shipping writes a `transfer_out` and moves the stock into an in-transit bin; receiving writes a `transfer_in`. Between those events the goods are on neither warehouse's shelf but are still on the balance sheet — which is correct, and which a single-movement design silently gets wrong. Cross-warehouse transfers move at the source's average cost, so no gain or loss is manufactured by moving your own goods around.

### Valuation — weighted average cost (confirmed)

`stock_levels.avg_cost_minor` holds the moving average per (product, warehouse, bin). On receipt:

```
new_avg = (qty_on_hand × avg_cost + qty_received × receipt_unit_cost)
          ÷ (qty_on_hand + qty_received)
```

On issue, the movement records `unit_cost_minor` = the average **at that moment** and `avg_cost_after_minor` = the average after. Storing both makes COGS auditable line by line — you can prove what any historical shipment cost without replaying the entire movement history.

Recalculation is done inside the same transaction as the movement, with the `stock_levels` row locked `FOR UPDATE`, so concurrent receipts can't interleave and corrupt the average.

Two known edge cases, handled explicitly rather than discovered later: issuing stock that would drive on-hand negative is rejected unless `warehouses.allows_negative_stock` is set (negative quantities make average cost meaningless); and a receipt against zero on-hand adopts the receipt cost outright rather than dividing by zero.

FIFO would need cost-layer tables and layer-consumption tracking. Not built — but `stock_movements` retains full cost history, so a later FIFO migration has the data it needs.

---

## 10. Customization layer (MUST DO #9, #11)

- `custom_field_defs`: `id`, `organization_id`, `entity_type`, `key`, `label`, `field_type` (`text`|`number`|`date`|`select`|`boolean`|`currency`), `options jsonb`, `is_required`, `position`, `archived_at`. Unique on `(organization_id, entity_type, key)`. Values live in each table's `custom_fields jsonb`, GIN-indexed — **no migration per tenant field**.
- `saved_views`: `id`, `organization_id`, `user_id` (null = shared org-wide), `module`, `name`, `filters jsonb`, `sort jsonb`, `columns jsonb`, `is_default`.
- `dashboard_layouts`: `id`, `organization_id`, `user_id`, `dashboard_key`, `layout jsonb`. The JSONB holds exactly the prototype's `order` / `wide` / `hidden` shape.
- `module_settings`: `organization_id`, `module_key`, `enabled`, `settings jsonb` — drives the nav adapting to enabled modules.
- `workflow_rules`: `id`, `organization_id`, `name`, `is_active`, `trigger_type` (`record.created`|`record.updated`|`field.changed`|`invoice.overdue`|`schedule`), `trigger_config jsonb`, `conditions jsonb`, `actions jsonb`, `created_by`, `last_run_at`.
- `workflow_runs`: `id`, `organization_id`, `rule_id`, `trigger_payload jsonb`, `status`, `error`, `started_at`, `finished_at`, `actions_log jsonb`.
- `tags` + `taggings` (polymorphic): tag-driven segmentation so new demographic cuts need no schema change, per MUST DO #11.

Trigger/condition/action as **data, not code** keeps the workflow builder extensible without becoming a BPMN engine — new trigger and action types are registry entries, not migrations.

---

## 11. Team chat (MUST DO #13)

- `channels`: `id`, `organization_id`, `type` (`channel`|`dm`|`group`), `name`, `topic`, `is_private`, `created_by`, `archived_at`.
- `channel_members`: `channel_id`, `user_id`, `organization_id`, `role`, `joined_at`, `last_read_message_id`, `notification_pref`.
- `messages`: `id`, `organization_id`, `channel_id`, `user_id`, `body`, `body_rich jsonb`, `reply_to_id`, `edited_at`, `deleted_at`, `created_at`.
- `message_mentions`: `message_id`, `mentioned_user_id`, `organization_id`, `read_at`.
- **`message_refs`**: `message_id`, `entity_type`, `entity_id`, `organization_id` — the ERP record deep-links ("check invoice #1234").
- `notifications`: `id`, `organization_id`, `user_id`, `type`, `payload jsonb`, `read_at`.

Tenant-scoped like everything else — `channels.organization_id` under RLS makes cross-organization messaging structurally impossible, not merely unimplemented.

---

## 12. AI assistant (MUST DO #12)

- `assistant_conversations`: `id`, `organization_id`, `user_id`, `title`, `created_at`.
- `assistant_messages`: `id`, `organization_id`, `conversation_id`, `role`, `content`, `tool_calls jsonb`, **`retrieved_query jsonb`**, **`result_row_count`**, `created_at`.

`retrieved_query` stores the actual parameterised query that was executed and `result_row_count` what it returned. This is the anti-hallucination audit trail: for any answer the assistant gave, you can prove exactly which tenant data it summarised. In a finance product that is not a nice-to-have — it's the difference between a defensible number and a guess.

The assistant executes queries **as the asking user**, through the same RLS session variable and the same permission middleware as the UI. It has no privileged data path, so RBAC and tenant isolation are inherited rather than reimplemented.

---

## 13. API, webhooks & security (MUST DO #8, #18)

- `api_keys`: `id`, `organization_id`, `name`, `key_hash`, `key_prefix` (display), `scopes text[]`, `created_by`, `last_used_at`, `expires_at`, `revoked_at`, `rate_limit_per_min`.
- `webhook_endpoints`: `id`, `organization_id`, `url`, `secret_encrypted`, `events text[]`, `status`, `created_by`.
- `webhook_deliveries`: `id`, `organization_id`, `endpoint_id`, `event`, `payload jsonb`, `signature`, `attempt`, `status`, `response_code`, `next_retry_at`.
- `integration_connections`: `id`, `organization_id`, `provider` (`slack`|`teams`), `external_workspace_id`, `access_token_encrypted`, `refresh_token_encrypted`, `scopes`, `installed_by`, `status`, `connected_at`.
- `integration_subscriptions`: `id`, `organization_id`, `connection_id`, `event`, `target`, `template`.

Every token is encrypted at rest with a key from the secrets manager, never the database. Webhook payloads are HMAC-signed with the per-endpoint secret.

---

## 14. Audit, GDPR & data residency (MUST DO #3, #15)

### `audit_log` — append-only, partitioned monthly
`id`, `organization_id`, `actor_user_id`, `actor_type` (`user`|`system`|`api_key`|`integration`), `action`, `entity_type`, `entity_id`, `before jsonb`, `after jsonb`, `request_id`, `ip inet`, `user_agent`, `occurred_at`.

The application role is granted `INSERT` and `SELECT` only — **no `UPDATE`, no `DELETE`**. Immutability is a grant, not a convention.

### `access_log` — partitioned monthly
`id`, `organization_id`, `user_id`, `resource`, `resource_id`, `action` (`read`|`export`), `row_count`, `ip`, `occurred_at`.

This is the GDPR 72-hour breach-reconstruction requirement made concrete: it answers "who accessed what". `row_count` is also the anomaly-detection hook — an unusually large export is a query against this table, which is all MUST DO #18 asks for at MVP stage.

### `erasure_requests`, `export_jobs`, `consent_records`
- `erasure_requests`: `id`, `organization_id`, `subject_type`, `subject_id`, `requested_by`, `requested_at`, `status`, `completed_at`, **`method`** (`deleted`|`pseudonymized`), `report jsonb`.
- `export_jobs`: `id`, `organization_id`, `requested_by`, `scope`, `status`, `file_url`, `expires_at`.
- `consent_records`: `id`, `organization_id`, `subject_type`, `subject_id`, `purpose`, `granted`, `source`, `recorded_at`, `ip`.

### The erasure tradeoff — **confirmed: pseudonymisation**

**Pseudonymise the audit log, do not delete it.** On erasure, `actor_user_id`, `ip` and `user_agent` are nulled and replaced with a stable opaque `actor_pseudonym`; the entry itself survives.

Why: financial records carry statutory retention that overrides an erasure request — Germany's §147 AO requires 10 years, and every other EU member state has an equivalent. GDPR Art. 17(3) explicitly carves out processing required for compliance with a legal obligation. **Hard-deleting audit history to satisfy a privacy request would put your customer in breach of accounting law.** Pseudonymisation satisfies both.

This is a legal posture, not a technical preference. **Have it reviewed by a lawyer in your target markets before you sell into the EU** — I'm flagging the tradeoff, not giving legal advice.

### Data residency
`organizations.region` plus UUIDv7 primary keys mean an EU tenant set can later be split to an EU-hosted database **without ID collisions and without a rewrite** — the application resolves connection by region. Nothing in the schema assumes a single database or a single region.

---

## 15. Resolved, and what's still open

**Resolved:**

- Inventory valuation → **weighted average cost** (§9).
- GDPR erasure → **pseudonymisation/anonymisation**, not deletion (§14). Still get this reviewed by a lawyer in your target markets before selling into the EU.
- Module coverage review → GL/CoA and Order-to-Cash were already covered; **Procure-to-Pay gained requisitions, goods receipts and three-way match** (§8), **Order-to-Cash gained the delivery document** (§7), and **warehouse management gained bin locations and transfer documents** (§9).

- Requisition approval → **single approver by amount threshold** (§8). Multi-step routing not built.
- Landed costs → **manual per-line entry**, no automatic allocation engine (§8).
- Fifth module bullet → withdrawn by you; nothing outstanding.

**Open: nothing.** This schema is complete and ready to implement.

### Deliberately excluded from v1

Recorded here so these are visible decisions rather than gaps discovered later. Each is additive — none requires reworking what's above.

| Excluded | Where it would attach |
|---|---|
| FIFO / specific-identification valuation | `stock_cost_layers`; `stock_movements` already retains the cost history it needs |
| Automatic landed-cost allocation | writes the existing `goods_receipt_lines.landed_cost_minor` |
| Multi-step / departmental approval routing | additive `requisition_approvals` table |
| Full WMS (putaway, pick paths, wave picking, licence plates) | on `bin_locations` |
| Multi-entity consolidation | above `organizations` |
| Manufacturing / MRP, payroll | out of scope per brief |
| E-invoicing transmission adapters | `invoices.einvoice_status` / `einvoice_payload_id` are already in place |

---

## Appendix — what gets built in what order

Per your working instructions, unchanged:

1. **This schema** ← awaiting approval
2. Project scaffold: auth, tenant middleware, RBAC, audit logging, RLS + the CI guard
3. Finance/Accounting end-to-end (ledger → P&L, Balance Sheet, cash flow)
4. Web UI to the design spec (tokens, shell, table engine, drawer/modal/toast)
5. Order-to-Cash (quote → order → delivery → invoice → payment) → CRM → Inventory incl. bins & transfers → Procure-to-Pay (requisition → PO → receipt → invoice, with three-way match)
6. Dashboard/workflow customization → filters/search/demographics → team chat → Ask ERP assistant → Slack + Teams
7. GDPR tooling + security pass as an explicit phase
8. Licensing service + seat management UI
9. Tauri desktop shell, activation flow, signed installers, auto-update

Tests written alongside, not after, for: ledger balance/immutability, tenant isolation, and seat-limit enforcement.
