# Syncrèse — Deployment

How to put this on real infrastructure and know it is safe once it is there.

Implements the deployment side of **MUST DO #18** (secrets management, encryption in
transit, no privileged database access from the app) and **MUST DO #17** (data residency:
nothing in the schema or the queries assumes a region, so an EU-only deployment is a
choice of where you run this, not a fork of it).

---

## The one thing that matters

The application connects to Postgres as **`syncrese_app`** — a role that:

- is **not** a superuser,
- does **not** have `BYPASSRLS`,
- does **not** own the tables,
- cannot create objects in `public`.

Every tenant-isolation guarantee in this system rests on that. A superuser or `BYPASSRLS`
connection reads and writes identically to a correct one — the same code, the same
queries, the same tests passing — right up until a query returns another tenant's
invoices. There is no runtime symptom. There is no application-level fallback.

So: provision the roles properly, and run `npm run db:verify` after every deployment and
every credential change. That script exists solely to answer this question about the
database you actually deployed to, rather than the one the tests build.

---

## Environment variables

`npm run env:check -- --production` applies these rules to a candidate environment before
you deploy into it. The server applies the same rules at boot (`src/instrumentation.ts`)
and refuses to start if an error-level rule fails.

### Required in production

| Variable | What it is | What happens if it is wrong |
| --- | --- | --- |
| `DATABASE_URL` | Application connection. Must be `syncrese_app`. | Superuser here silently disables tenant isolation. |
| `AUTH_SECRET` | Signs session tokens. 32 bytes, base64. | Unset, next-auth derives a per-instance key: sessions break the moment a second container starts, and every restart logs everyone out. |
| `AUTH_URL` | Public URL including scheme, exactly as browsers reach it. | OAuth callbacks fail; non-https sends session cookies in the clear. |
| `ENCRYPTION_KEY` | Encrypts integration tokens and MFA secrets at rest. Exactly 32 bytes, base64. | **Not recoverable.** Lose it and the data it protects is gone. Back it up separately from the database. |
| `LICENSE_KEY_PEPPER` | Peppers API-key and webhook-secret hashes. | Must be set **before the first key is issued**. Changing it later invalidates every key already handed out. |

### Required for migrations only

| Variable | What it is |
| --- | --- |
| `DATABASE_MIGRATION_URL` | Owner connection (`syncrese_owner`). Used by `npm run db:migrate` and nothing else. The running app must never hold these credentials — a compromised app process could otherwise drop an RLS policy. |

### Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `SIGNUP_MODE` | `closed` | `open` enables public signup at `/sign-up`. Anything other than `open` or `closed` is rejected rather than quietly treated as closed. |
| `CRON_SECRET` | — | Authenticates `POST /api/internal/dispatch`. Unset, that endpoint answers 503 and **no webhook is ever delivered**. Also unlocks detail on `/api/health`. |
| `TRUST_PROXY_HEADERS` | `true` | Set to `false` if the app is exposed directly with no proxy. `x-forwarded-for` is client-controlled unless something trusted overwrites it, and believing it lets one caller wear a new address per request — which defeats the signup throttle. |
| `DATABASE_SSL` | on | `false` requires `ALLOW_INSECURE_DB_CONNECTION=true` as well, so plaintext database traffic is always a deliberate act. |
| `DATABASE_POOL_MAX` | `10` | Per instance. Multiply by your instance count and compare against the server's `max_connections` before raising it. |
| `AUTH_GOOGLE_ID` / `_SECRET` | — | Google sign-in appears only when both are set. |
| `AUTH_MICROSOFT_ENTRA_ID_*` | — | Microsoft 365 sign-in. Most SME buyers are Microsoft shops. |
| `ANTHROPIC_API_KEY` | — | The AI assistant. Server-side only. **Unset is a supported state**, not a broken one: the assistant falls back to deterministic keyword routing and renders the rows itself, which makes no outbound call at all. Set it and the question, the tool definitions and the retrieved rows leave your deployment. See [docs/08-assistant.md](08-assistant.md). |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | The work is picking one of seven lookups and writing two sentences about the rows, not reasoning. |
| `SMTP_HOST` / `_PORT` / `_USER` / `_PASSWORD` | — | Sends password resets and invitations. **Unset is supported**: invitations fall back to a link the admin copies, and the reset page says plainly that this installation cannot send email. Without it a user who forgets their password has no self-service route back. See [docs/12-email-and-passwords.md](12-email-and-passwords.md). |
| `EMAIL_FROM` | `no-reply@$SMTP_HOST` | The From address. Set it to a domain you control, or expect the mail to be filtered. |

### Generating secrets

```bash
openssl rand -base64 32
```

Store them in the platform's secret manager (Vercel environment variables, Docker/Swarm
secrets, AWS Secrets Manager, 1Password). Never in the repository, never in an image
layer, never in a CI log. `.gitignore` and `.dockerignore` both already exclude every
`.env*` variant — do not add exceptions.

---

## Path A — managed platform (Vercel + managed Postgres)

The fastest route to a running instance. Suits the hosted product.

### 1. Provision the database

Create a Postgres 16 database with your provider. **Choose the region deliberately** — for
EU customers, an EU region — because moving it later means a migration window, not a
setting change.

Then create the roles, as the provider's administrative user:

```bash
psql "$ADMIN_URL" -v owner_password="'…'" -v app_password="'…'" -f scripts/provision-db.sql
```

The script prints every role's attributes at the end. All three columns must read `false`.

It creates three roles: `syncrese_owner` (owns the schema, runs migrations), `syncrese_app`
(what the application connects as) and `syncrese_definer` (`NOLOGIN`, owns the
`SECURITY DEFINER` functions). The third is not optional and cannot be created later by the
migration role — inside a definer function the current user is the function's *owner*, and
`FORCE ROW LEVEL SECURITY` subjects the owner to the policies, so functions owned by
`syncrese_owner` read nothing at all from a policed table. That is every pre-tenant lookup
in the system, sign-in included. Migration `0019` refuses to apply if the role is missing.

Provider notes:

- **Neon** — run as `neondb_owner`. Set the region at project creation.
- **Supabase** — run as `postgres`. Leave Supabase's own roles and extensions alone.
- **RDS/Aurora** — the master user is not a true superuser but does have `CREATEROLE`, which is enough.

If a provider does not allow `CREATE ROLE` at all, you cannot run this application safely
on it.

### 2. Apply migrations

From a machine that can reach the database:

```bash
DATABASE_MIGRATION_URL="postgresql://syncrese_owner:…@host/db" npm run db:migrate
```

The runner applies every `.sql` file in `drizzle/` in order, each in its own transaction,
tracked in `__drizzle_migrations`. It is idempotent — re-running applies only what is new.

It is deliberately **not** `drizzle-kit migrate`: this project's migrations include
hand-written SQL (RLS policies, triggers, grants) that drizzle-kit does not generate and
would drop from its journal.

### 3. Verify

```bash
DATABASE_URL="postgresql://syncrese_app:…@host/db" npm run db:verify
```

Every check must pass before traffic reaches the instance. See
[what it checks](#what-dbverify-checks) below.

### 4. Configure and deploy

Set the environment variables above in the platform. Then:

```bash
npm run env:check -- --production
```

Deploy. The app boots, `instrumentation.ts` re-runs the same checks, and the process
refuses to start if anything is wrong.

### 5. Schedule webhook and chat delivery

Next.js has no daemon, so the outbox is drained by a scheduled call. On Vercel Hobby
that call comes from `.github/workflows/dispatch.yml`, because Hobby rejects any cron
faster than daily — see [docs/04-vercel-neon.md](04-vercel-neon.md). `vercel.json` already
declares a once-a-minute cron against `/api/internal/dispatch`; Vercel Cron authenticates
it with `CRON_SECRET` automatically.

Vercel's Hobby plan permits only daily crons — on that plan, either upgrade or point any
external scheduler at the endpoint instead. Both endpoints accept **GET and POST** with the
same bearer guard, because Vercel Cron invokes jobs with a GET:

```bash
curl -X POST -H "authorization: Bearer $CRON_SECRET" https://your-host/api/internal/dispatch
```

The same tick also posts to any Slack and Microsoft Teams integrations. Those go to the
vendors' own webhook hosts and nowhere else — see `src/integrations/allowlist.ts`, which
is the boundary that stops a customer-supplied URL becoming a request-forgery primitive
against your own network.

Without this, events accumulate in the outbox and no webhook or chat message is ever
delivered. That is a quiet failure: the API keeps working perfectly.

Set `AUTH_URL` before this matters — chat messages link back to the record they describe,
and a message with no `AUTH_URL` set simply carries no link rather than a broken one.

### 5b. Schedule the retention sweep

`vercel.json` also declares a daily cron against `/api/internal/retention`. It is separate
from the dispatch tick on purpose: that one runs every minute and exists to be fast, this
one deletes data and should run once a day. Calling it more often is harmless — each policy
refuses to run again inside twenty hours.

```bash
curl -X POST -H "authorization: Bearer $CRON_SECRET" https://your-host/api/internal/retention
```

On a fresh installation this does nothing at all: every retention category ships **off**,
and stays off until somebody enables it in Settings → Data retention. See
[docs/09-retention.md](09-retention.md) for what it can and — more importantly — cannot
remove.

### 6. Create the first organization

Set `SIGNUP_MODE=open`, redeploy, create your organization at `/sign-up`, then set it back
to `closed` if this is not a public multi-tenant instance.

---

## Path B — self-hosted (Docker Compose)

For customers who want it on their own infrastructure, and for a single-region EU
deployment where the answer to "where is our data" must be a place you can point at.

```bash
cp .env.docker.example .env.docker
# fill in every value — the compose file refuses to start with any of them blank
docker compose --env-file .env.docker up -d --build
```

Three services start in order:

1. **`db`** — Postgres 16. `docker/init-roles.sh` runs once on an empty data directory and
   creates `syncrese_owner`, `syncrese_app` and `syncrese_definer`. The port is **not**
   published; nothing outside the compose network needs it.
2. **`migrate`** — runs the migrations as the owner, then exits. It is the only container
   that ever receives the owner credentials.
3. **`app`** — the application, as `syncrese_app`. Starts only after `migrate` has
   completed successfully, so it never boots against an unmigrated database.

Webhook delivery is opt-in:

```bash
docker compose --env-file .env.docker --profile webhooks up -d
```

### Verifying a compose deployment

```bash
docker compose exec app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log)"
docker compose run --rm -e DATABASE_URL="postgresql://syncrese_app:…@db:5432/syncrese" -e DATABASE_SSL=false migrate npx tsx scripts/verify-db.ts
```

### What compose does not give you

- **TLS.** Put a reverse proxy in front (Caddy, nginx, Traefik) and set `AUTH_URL` to the
  public https URL. If you do, set `TRUST_PROXY_HEADERS=true` *and* make sure the proxy
  **overwrites** `x-forwarded-for` rather than appending to it.
- **Backups.** See below. The compose volume is not a backup.
- **A second instance.** `restart: unless-stopped` covers a crash, not a failed host.

---

## Signup and the first organization

A production database has no organizations in it — `db:seed` builds a demo tenant and is a
development tool only. `/sign-up` is the only way in.

`SIGNUP_MODE` decides whether that route works:

- **`open`** — anyone can create an organization. This is the hosted SaaS.
- **`closed`** (default) — the route explains that signups are closed and the action
  refuses regardless of what the form posts. New members arrive by invitation from inside
  an existing organization.

Closed is the default because it is the safe answer for a self-hosted instance that
someone put on the public internet without reading this page.

A self-hosted deployment normally sets `open` just long enough to create the first
organization, then sets `closed` and restarts.

Each new tenant is provisioned in a single transaction: the owner's user account, the
organization, a 30-day 5-seat trial licence, the owner's membership, a working chart of
accounts and a default CRM pipeline. A half-provisioned tenant — an organization with no
ledger, or a licence with no owner — is unreachable and occupies its slug forever, so a
failure anywhere rolls all of it back, including the user row, so the person can retry
with the same email address.

Signup is unauthenticated and expensive (argon2, then several hundred rows), so it is
throttled per calling network — five attempts an hour, counted in the database rather than
in process memory. The counter is keyed by a **salted hash** of the address, never the
address, and the application role can neither read that table nor reset it; it reaches the
counter only through a `SECURITY DEFINER` function. This is why `TRUST_PROXY_HEADERS` has
to match your topology: believing a client-supplied `x-forwarded-for` lets one caller wear
a new address per request and the throttle stops nothing.

---

## What `db:verify` checks

Run it after every migration and every credential change.

**Role posture** — the connected role is not a superuser, has no `BYPASSRLS`, no
`CREATEROLE`/`CREATEDB`, owns no tables, and cannot create objects in `public`.

**Row level security** — every table carrying `organization_id` has RLS *enabled*, has a
policy, and has `FORCE` set. `FORCE` is the one that gets missed: without it the table
owner bypasses the policy, and the table owner is exactly who runs migrations and any
admin tool someone later points at this database.

**Append-only audit** — the application role holds `INSERT` but not `UPDATE`, `DELETE` or
`TRUNCATE` on `audit_log` and `access_log`. Application code physically cannot rewrite
history.

**Schema currency** — every migration on disk is applied, and the database is not *ahead*
of the checkout (which is what a rolled-back deploy leaves behind, and it fails in far
stranger ways than being behind).

**Live isolation** — the end-to-end proof, and the reason the other checks are not
sufficient: a query issued with no tenant scope set returns **zero rows**, and a query
with a scope set returns exactly that tenant's. Every structural check above could pass
while some grant or role inheritance still let rows through.

---

## Health checks

`GET /api/health`

- **200** `{"status":"ok"}` — database reachable, schema present, migrations applied.
- **503** `{"status":"degraded"}` — anything else.

It checks the database rather than just the socket, because a container that serves errors
for every request while reporting healthy is precisely the failure this is meant to catch.

Unauthenticated callers get the status word and nothing else — a health endpoint is the
most-scraped URL on any deployment, and versions, hostnames and error strings are free
reconnaissance. With `authorization: Bearer $CRON_SECRET` it also returns the migration
count, latency, uptime and the underlying error message.

A `migrations` count of `0` means the process is talking to a database that has never been
migrated — usually the wrong one.

---

## Backups and recovery

**What to back up**

1. The database. Everything is in it.
2. `ENCRYPTION_KEY` — **not** in the database, and not derivable from it. Without it,
   integration tokens and MFA secrets are unrecoverable ciphertext. Store it somewhere the
   database backup restore procedure does not depend on.
3. `AUTH_SECRET` and `LICENSE_KEY_PEPPER` — losing `AUTH_SECRET` signs everyone out;
   losing `LICENSE_KEY_PEPPER` invalidates every API key ever issued.

**Restore drill.** Restore to a scratch database, point `DATABASE_URL` at it, and run
`npm run db:verify`. A restored dump does **not** necessarily carry role attributes,
schema ownership or `REVOKE`s — which means a restore can quietly produce a database where
the app role owns the tables. This is the single most likely way a correctly deployed
system becomes an incorrectly deployed one. `scripts/provision-db.sql` is safe to re-run
against a restored database and re-asserts all of it.

---

## Data residency

Nothing in the schema, the queries or the application code assumes a region or a currency
(`organizations.region`, `organizations.base_currency`). Pinning EU tenant data to the EU
is therefore an infrastructure decision:

- **Separate instance per region.** One deployment and one database per region, each in
  that region. Simplest, and the only arrangement where "where is our data" has a
  one-sentence answer. Recommended.
- **One instance, regional read replicas.** Does not satisfy residency on its own —
  the primary still holds everything.

Sub-processor list, retention policy and DPA are commercial documents, not code, but they
have to match whichever arrangement you pick.

---

## Rotating secrets

| Secret | How | Effect |
| --- | --- | --- |
| `AUTH_SECRET` | Replace and redeploy. | Every session is invalidated; everyone signs in again. |
| `ENCRYPTION_KEY` | Set the old value as `ENCRYPTION_KEY_PREVIOUS`, the new one as `ENCRYPTION_KEY`, redeploy, re-encrypt, then clear `ENCRYPTION_KEY_PREVIOUS`. | Zero downtime. The env check rejects the two being identical, so a rotation that has not happened cannot look like one that has. |
| `LICENSE_KEY_PEPPER` | Do not, unless you intend to. | Invalidates every API key and webhook secret already issued. |
| Database passwords | `ALTER ROLE … PASSWORD …`, update the secret, redeploy. | Brief connection errors during rollover. |
| `CRON_SECRET` | Replace in both the app and the scheduler. | Dispatch 401s until both sides match. |

---

## The build is offline and self-contained

Two things were needed for that, and both were found by running `next build` rather than by
reading the code — `next dev` exercises neither.

**The fonts are vendored.** IBM Plex Sans and Mono live in `src/app/fonts` and are loaded
with `next/font/local`. They were previously fetched through `next/font/google`, which
self-hosts them but downloads them *at build time*, so a build with no route to
fonts.gstatic.com died with `TypeError: Cannot read properties of null` — a message naming
neither fonts nor the network. Vercel was fine; a firewalled `docker build` was not. The
files are under the SIL Open Font License and `LICENSE.txt` sits beside them, which the OFL
requires of anyone redistributing the font, and shipping this application does.

**There is an `app/not-found.tsx`.** Without one, Next falls back to the Pages Router error
page and prerenders it, which fails with "`<Html>` should not be imported outside of
pages/_document" and takes the build down at the static-generation step. `app/global-error.tsx`
covers the other half — a crash in the root layout, which no nested boundary can catch. It
renders its own `<html>`, and prints only Next's `digest`, never the error: a stack trace on
that page can carry a connection string or a query with tenant identifiers in it.

---

## Where the deployment tools read their configuration

`src/lib/load-env.ts` loads `.env.local`, then `.env`, then `.env.vercel` — first file to
define a variable wins, and a real environment variable beats all three.

`.env.vercel` is last on purpose. `.env.local` has to keep winning for local work, or a
`.env.vercel` holding production credentials would silently point every one of these tools at
the live database. Only the deployment tools import it — provisioning, migration,
verification, drizzle-kit and the admin scripts. `next dev` and `npm run db:seed` do not, so
neither can be redirected at production by that file.

It was not read at all until this was fixed, which meant the walkthrough's instruction to
paste the Neon string into `.env.vercel` produced `DATABASE_ADMIN_URL is not set` from the
very next command.

---

## Go-live checklist

- [ ] `scripts/provision-db.sql` run; both roles report `false` for superuser, bypassrls and createrole
- [ ] `npm run db:migrate` applied cleanly
- [ ] `npm run db:verify` — all checks pass
- [ ] `npm run env:check -- --production` — no errors
- [ ] `npm test` — all suites pass against this checkout
- [ ] `npm run lint && npm run typecheck` — both clean
- [ ] `npm run build` — succeeds, and needs no network to do it
- [ ] `AUTH_URL` is https and matches the URL browsers actually use
- [ ] `ENCRYPTION_KEY` backed up **outside** the database
- [ ] `GET /api/health` returns 200 from outside the deployment
- [ ] `SIGNUP_MODE` is what you meant
- [ ] Dispatch scheduled, or you have decided not to deliver webhooks or chat messages
- [ ] A restore of a real backup verified with `db:verify`
- [ ] Reverse proxy terminates TLS; `TRUST_PROXY_HEADERS` matches the topology

---

## Not yet covered

Honest gaps, so they are not discovered at the wrong moment:

- **The assistant's catalogue is deliberately small** — seven lookups covering receivables,
  invoices, partners, ledger balances and stock. Questions outside it get "I cannot see
  that" rather than an improvised answer, which is the intended behaviour and will still
  read as a gap to some users. Widening it means adding entries, not loosening the rules;
  see [docs/08-assistant.md](08-assistant.md).
- **E-invoicing transmission.** Conformant EN 16931 UBL documents are generated and validated
  before emission, but there are no network adapters (Peppol, SDI, KSeF, Chorus Pro) — each
  needs an accredited access point or a national registration, which is a commercial
  relationship rather than code. Customers download the file and send it as they do today.
  See [docs/11-einvoicing.md](11-einvoicing.md).
- **PDFs cover Latin scripts only.** DejaVu Sans is embedded, subsetted through Latin
  Extended-B, so Polish, Czech, Hungarian, Romanian and Baltic names render correctly. Greek
  and Cyrillic do not — widening the range in `scripts/build-pdf-font.py` is the fix and costs
  a few kilobytes.
- **The desktop app is unsigned.** It builds and runs — installer, MSI and standalone binary,
  with the pairing window verified — but nothing signs it, so Windows SmartScreen warns every
  user who runs the installer. A code-signing certificate is a purchase against your
  registered business, and no amount of build configuration substitutes for it. See
  [docs/10-desktop.md](10-desktop.md).
