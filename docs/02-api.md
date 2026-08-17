# Syncrèse — Public API & Webhooks

Implements **MUST DO #8** (API-first design) and the API-security items in **MUST DO #18**
(per-tenant keys with scoped permissions and rate limiting, HMAC-signed webhooks).

The machine-readable description lives at **`GET /api/v1/openapi.json`** and is *generated*
from the module registry and the permission catalogue — hand-written API docs drift within
about two releases, so the spec is wrong only if the code is wrong.

---

## Design principles

**One service layer.** Every route calls the same functions the UI calls. An invoice created
through the API posts to the ledger under identical double-entry rules; a payment records
realised FX the same way. Two implementations of "issue an invoice" would eventually
disagree, and the customer's integration would be the one running the wrong one.

**Money is always integer minor units** paired with a `currencyCode`. `123456` + `EUR` is
€1,234.56. There are no floats anywhere in the API.

**A key identifies a tenant, not a user.** `ApiContext` mirrors the session context so the
code beneath cannot tell the difference.

---

## Authentication

```
Authorization: Bearer syn_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are `syn_live_` (or `syn_test_`) plus 32 bytes of entropy, base64url. Stored as SHA-256
— never plaintext, never recoverable. The secret is shown exactly once at creation.

SHA-256 rather than argon2 is deliberate: these are high-entropy values *we* generate, so
they are not brute-forceable, and they are verified on **every** request — argon2's memory
cost there would be a self-inflicted denial of service. Passwords are low-entropy and
human-chosen, which is why they get the expensive treatment and keys do not.

### Scopes

A key carries a subset of the [permission catalogue](../src/auth/permissions.ts) — one
authorization model, not two.

Two rules matter:

1. **You cannot grant a key permissions you do not hold.** Otherwise any Sales user could
   mint an Owner-scoped key and walk straight around RBAC.
2. **Scopes are frozen at issue.** If the creating user is later promoted, their old
   integration key must not silently gain the ability to delete the organization.

Unknown, revoked and expired keys all return the same `401`. Distinguishing them tells an
attacker which of their guesses was once real.

### Rate limiting

Fixed window, one minute, counted **in the database** so the limit holds across app
instances and survives a restart — an in-process counter would let two servers each allow
the full quota. The increment and the check are one atomic statement, which removes the
read-then-write race that lets a burst through.

Every response carries:

```
ratelimit-limit: 600
ratelimit-remaining: 599
ratelimit-reset: 60
```

Exceeding it returns `429`.

---

## Endpoints

| Method | Path | Scope |
|---|---|---|
| GET | `/api/v1/invoices` | `invoice.read` |
| POST | `/api/v1/invoices` | `invoice.create` |
| POST | `/api/v1/payments` | `payment.record` |
| GET | `/api/v1/customers` | `crm.read` |
| GET | `/api/v1/sales-orders` | `sales.read` |
| GET | `/api/v1/purchase-orders` | `purchase.read` |
| GET | `/api/v1/products` | `inventory.read` |
| GET | `/api/v1/deals` | `crm.read` |
| GET | `/api/v1/journal` | `ledger.read` |
| GET | `/api/v1/banking` | `bank.manage` |
| GET | `/api/v1/openapi.json` | *(public)* |

List endpoints resolve through the **module registry**, so a new module gets an API endpoint
the moment it is registered — and cannot be exposed without a declared permission, because
the registry entry requires one.

### List parameters

`q`, `status`, `sort`, `dir`, `page`, `limit` (max 200), and `filter`.

`filter` is URL-encoded JSON using the same structured filter the UI builds:

```json
{"conditions":[{"field":"outstandingMinor","op":"gt","value":500000}]}
```

Field names are resolved through a per-module allowlist — they reach SQL as identifiers and
can never be bind parameters, so an unrecognised field is rejected rather than interpolated.
Custom fields are addressed as `custom.<key>`.

```bash
curl -H "Authorization: Bearer $KEY" \
  'http://localhost:3000/api/v1/invoices?status=issued&limit=25'
```

### Errors

```json
{ "error": { "code": "FORBIDDEN", "message": "This API key lacks the \"bank.manage\" scope." } }
```

`401` unauthenticated · `403` scope · `404` unknown resource · `422` validation ·
`429` rate limited · `409` conflict · `500` internal.

Unexpected errors log server-side and return a generic message — an internal error's text
can carry SQL, table names or another tenant's data.

---

## Webhooks

### Transactional outbox

Events are written in the **same transaction** as the change they describe. An invoice that
fails to post cannot emit `invoice.issued`, and one that posts cannot fail to emit it.

Firing HTTP inline would break both halves: HTTP cannot roll back, and a network stall would
hold a database transaction open. So delivery is a separate drain step.

The `events` table is append-only — only `dispatched_at` may change.

It is pruned after 90 days by the retention sweep, but only once every delivery has finished
and every chat integration has read past the row, so nothing still owed to you is ever
dropped. That default is adjustable per workspace; see
[docs/09-retention.md](09-retention.md#the-event-outbox-and-the-one-exception-to-append-only).
Consumers that need a longer history should store what they receive rather than expect to
re-read it here.

### Signature

```
syncrese-signature: t=1786557600,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
syncrese-event: invoice.issued
syncrese-delivery: 019ff0...
```

HMAC-SHA256 over **`{timestamp}.{body}`** — not the body alone. A body-only signature is
replayable forever: capture one valid request and it stays valid indefinitely. Verify the
timestamp is recent *before* trusting the MAC.

Reference implementation: [`verifySignature`](../src/api/webhooks.ts).

```ts
const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
```

Compare with `timingSafeEqual`, and check lengths first — `timingSafeEqual` throws on a
length mismatch, and the throw itself leaks length through timing.

### Delivery and retry

Six attempts with exponential backoff — roughly 30s, 2m, 8m, 32m, 2h, 8.5h — covering about
half a day, enough for a normal deploy or outage without hammering a dead endpoint for a
week. After that the delivery is `abandoned`.

An endpoint that fails 50 times consecutively is **auto-disabled**. Fan-out is idempotent: a
unique index on `(endpoint, event)` means running the drain twice cannot double-deliver.

If the signing secret is unavailable the delivery is **abandoned rather than sent unsigned** —
a receiver would be right to reject an unsigned payload, and sending one teaches integrators
to skip verification.

### Endpoint rules

- **HTTPS only.**
- Private-network hosts are refused: `localhost`, `127.*`, `10.*`, `192.168.*`, `172.16–31.*`
  and `169.254.*` (the cloud metadata endpoint). This blocks the accidental SSRF cases. It is
  **not** a complete defence — a public DNS name can still resolve to a private address — and
  proper egress filtering belongs at the network layer.
- Payloads pass through the same redaction as the audit trail, so a token or password hash
  can never be carried to a third-party endpoint.

### Event types

`invoice.created` · `invoice.issued` · `invoice.paid` · `payment.recorded` ·
`sales_order.created` · `sales_order.confirmed` · `sales_order.delivered` ·
`purchase_order.created` · `purchase_order.approved` · `goods_receipt.posted` ·
`deal.won` · `deal.lost` · `partner.created` · `product.low_stock`

Subscribe to `*` for everything.

---

## Dispatch

`POST /api/internal/dispatch`, guarded by `CRON_SECRET`, called on a schedule (Vercel Cron or
any external pinger). Next.js has no daemon; pretending otherwise would mean webhooks that
only fire while someone has the app open.

Each tenant is processed in its own transaction, so one organization's bad endpoint cannot
stall or roll back another's.

---

## Not built yet

**HTTP delivery is not wired to the dispatch tick.** Fan-out works, signing works, retry and
backoff work and are tested — but sending requires the endpoint's **plaintext secret**, and
we currently store only its hash.

That is a real design decision, not an oversight, and it has two honest answers:

1. **Encrypt at rest** with a key from a secrets manager, so the server can decrypt to sign.
   Signing works forever; a compromised encryption key exposes every customer's secret.
2. **Store hashed and re-issue** on rotation, signing with a secret held only in memory for
   the request that created it. Safer at rest, but secrets cannot survive a restart.

Option 1 is almost certainly right — Stripe and GitHub both do it — but it needs a decision
about *where* that key lives before customers depend on it. Flagging rather than guessing.

**Also outstanding:** write endpoints beyond invoices and payments; API-key and webhook
management UI (the services exist, the settings screens do not); a Zapier/Make app
definition; and cursor pagination for large exports (offset paging degrades past a few
thousand rows).
