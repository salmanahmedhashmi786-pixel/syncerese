# Syncrèse

Multi-tenant ERP for small and medium businesses in the US and Europe. Next.js 15, TypeScript,
PostgreSQL, Drizzle.

The shape of the thing: a double-entry financial core that other modules post into, strict
tenant isolation enforced by the database rather than by application code, and a UI meant to
be configured by the customer instead of by a consultant.

---

## Running it locally

```bash
npm install
npm run db:seed
npm run dev
```

`db:seed` creates an embedded PostgreSQL (PGlite) under `.syncrese-dev`, applies every
migration and loads a demo workspace — a German trading company with a chart of accounts,
partners, products, invoices and a year of history. No database server to install.

Sign in at <http://localhost:3000> as **owner@syncrese.test** / **syncrese-demo-2026**.

`npm run db:reset` throws the local database away and rebuilds it.

Against a real PostgreSQL, set `DATABASE_URL` and run `npm run db:provision` first — it
creates the three roles the isolation model depends on. See
[deployment](docs/03-deployment.md).

## Checking it

```bash
npm run typecheck && npm run lint && npm test
```

663 tests across 40 files, running against real PostgreSQL in-process rather than mocks, so
row-level security, triggers and constraints are exercised as they are in production. The
suite takes about twenty minutes.

The build needs no network: the IBM Plex faces are vendored under
[`src/app/fonts`](src/app/fonts) under the SIL Open Font License, so `next build` and
`docker build` work offline.

`npm run db:verify` checks a live database's posture — RLS forced on every tenant table, the
`SECURITY DEFINER` functions owned by the right role, the application role unable to create
objects. Run it after provisioning and after any migration.

---

## How it is put together

**Tenant isolation is a database property.** Every tenant table has RLS with
`FORCE ROW LEVEL SECURITY`, scoped by a transaction-local `app.org_id`. The application
connects as a role that cannot bypass it. A missing `WHERE organization_id = …` returns
nothing rather than another customer's ledger, and a test asserts every table is covered.

**Money is integer minor units plus an explicit currency.** No floats anywhere, no implied
USD, no implied single region.

**Some tables are append-only, and the database is what enforces it** — the audit log,
message history, the event outbox. The trigger binds the schema owner, not merely the
application role, so a bug in application code cannot quietly rewrite history. Where that has
to be relaxed (outbox pruning) the exception is narrow, explicit and
[documented](docs/09-retention.md#the-event-outbox-and-the-one-exception-to-append-only).

**The assistant never states a number it did not retrieve.** Every figure in an answer is
checked against the rows the lookup returned, and an unmatched one fails the answer rather
than reaching the user. In a finance product one invented total costs all the trust.

## Modules

Executive dashboard · Reports & analytics · Business analytics · Invoices & bills ·
General ledger · Bank transactions · Customers & suppliers · Sales orders · Deals ·
Products & stock · Purchase orders · Team chat · Settings

Every list view shares one grid: filter builder, saved views, inline editing, CSV export,
user-defined custom fields that become filterable and analysable without a migration.

---

## Documentation

| | |
|---|---|
| [01 · Database schema](docs/01-database-schema.md) | Tables, RLS, the isolation model |
| [02 · API](docs/02-api.md) | REST surface, API keys, webhooks, the outbox |
| [03 · Deployment](docs/03-deployment.md) | Environment, provisioning, cron, the runbook |
| [04 · Vercel + Neon](docs/04-vercel-neon.md) | One managed path, start to finish |
| [05 · Billing](docs/05-billing.md) | Stripe Checkout, seats, licence enforcement |
| [06 · Product keys](docs/06-product-keys.md) | Offline activation, format and generation |
| [07 · Chat integrations](docs/07-chat-integrations.md) | Slack and Teams, host allowlisting |
| [08 · Assistant](docs/08-assistant.md) | Retrieval catalogue and numeric grounding |
| [09 · Retention](docs/09-retention.md) | GDPR storage limitation, and what it may never touch |
| [10 · Desktop](docs/10-desktop.md) | Tauri shell, device pairing, signing |
| [11 · E-invoicing](docs/11-einvoicing.md) | EN 16931 / UBL 2.1, PDF, print |
| [12 · Email & passwords](docs/12-email-and-passwords.md) | SMTP, reset, session revocation |

## Known gaps

Listed honestly in [deployment](docs/03-deployment.md#not-yet-covered) so they are not
discovered at the wrong moment. In short: no e-invoicing transmission adapters (each needs an
accredited access point, which is a commercial relationship rather than code); PDFs cover
Latin scripts only; the desktop shell is written and its server side tested, but the Tauri
application has never been compiled.
