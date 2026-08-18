# Syncrèse — Deploying to Vercel + Neon

The specific walkthrough for the hosted product. [03-deployment.md](03-deployment.md) is
the general reference — env var meanings, backups, rotation, residency.

Steps marked **[you]** need your own accounts and cannot be done for you. Everything else
is already done.

---

## Already done

- [x] Git repository initialised, one commit on `main`. `.env.local` and `.env.vercel` are
      gitignored and were confirmed absent from the commit.
- [x] Secrets generated into `.env.vercel` (`npm run gen:secrets`).
- [x] `vercel.json` with the webhook dispatch cron.
- [x] `output: 'standalone'` disabled on Vercel builds — their builder does its own
      packaging.
- [x] `@node-rs/argon2` `linux-x64-gnu` binary confirmed present in `package-lock.json`, so
      password hashing will build on their runners.

---

## Scheduling, and why it depends on your plan

Two endpoints need calling on a schedule:

| Endpoint | How often | Why |
| --- | --- | --- |
| `/api/internal/dispatch` | every minute | Turns queued events into webhook deliveries and Slack/Teams messages. |
| `/api/internal/retention` | daily | Applies retention policies and prunes the event outbox. |

**Hobby allows only DAILY cron jobs, and rejects the entire deployment if `vercel.json` asks
for anything faster.** Not a warning, not a downgrade — a plan error at config validation,
which leaves the project with a domain and no deployment behind it. `DEPLOYMENT_NOT_FOUND`
from the edge on every path is what that looks like from outside.

So `vercel.json` ships with the daily retention cron only, which is within Hobby's limit, and
the minute-tick lives in `.github/workflows/dispatch.yml` instead.

### On Hobby: the GitHub Actions workflow

Add two repository secrets under Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `SYNCRESE_BASE_URL` | your production URL, e.g. `https://syncrese.vercel.app` — no trailing slash |
| `SYNCRESE_CRON_SECRET` | the same `CRON_SECRET` you set in Vercel |

Then run it once by hand from the Actions tab to confirm it authenticates.

**Be honest about what this is.** GitHub's scheduler has a five-minute floor, is routinely
late by ten minutes or more under load, and drops runs entirely. It is adequate for a Hobby
deployment you are testing. It is not adequate for a customer promised timely webhooks.

It also stops after **60 days without a commit to the repository**, silently. The API carries
on working and nothing anywhere reports that delivery has stopped.

### On Pro: put it back in vercel.json

Delete the workflow and restore the cron:

```json
{ "path": "/api/internal/dispatch", "schedule": "* * * * *" }
```

### Any other scheduler

Anything that can make an authenticated HTTPS request will do — cron-job.org, Upstash QStash,
an uptime monitor:

```bash
curl -H "authorization: Bearer $CRON_SECRET" https://your-host/api/internal/dispatch
```

Without a scheduler of some kind, events accumulate in the outbox and **no webhook is ever
delivered**. The API keeps working perfectly, which is what makes this easy to miss.

---

## 1. Create the Neon project **[you]**

At [neon.tech](https://neon.tech), create a project.

**Pick the region deliberately.** For EU customers pick an EU region
(`aws-eu-central-1`, Frankfurt). Moving it later is a migration window, not a setting.

Copy the connection string for the default `neondb_owner` role. Neon gives you two forms —
take the **direct** one for now (the host *without* `-pooler` in it).

Paste it into `.env.vercel`:

```
DATABASE_ADMIN_URL=postgresql://neondb_owner:...@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

This is used **once**, by the next step, and then never again. Neither the application nor
the migration job ever receives it.

---

## 2. Provision the roles

```bash
npm run db:provision
```

This creates three roles, locks down schema `public`, and enables `pgcrypto` and `pg_trgm`:

| Role | Logs in | Purpose |
| --- | --- | --- |
| `syncrese_owner` | yes | Owns the schema. Used by `npm run db:migrate` and nothing else. |
| `syncrese_app` | yes | What the application connects as. Owns nothing, no `BYPASSRLS`. |
| `syncrese_definer` | **no** | Owns the `SECURITY DEFINER` functions. |

That third role has to exist **before** migrations run, because `syncrese_owner` cannot
create it (`NOCREATEROLE`, deliberately) and migration `0019` will stop with an error
telling you to come back here.

It is there because RLS applies to whoever the current user is, and inside a
`SECURITY DEFINER` function that is the function's *owner* — while `FORCE ROW LEVEL
SECURITY` exists precisely to subject the owner to the policies. Left owned by
`syncrese_owner`, every lookup that happens *before* a tenant is known reads zero rows:
sign-in, API keys, invitation links, Stripe webhooks, product-key activation. Nothing
errors; it all just quietly returns nothing.

### On managed Postgres, the admin role is not a superuser

Neon's `neondb_owner` is powerful but not `SUPERUSER`, and two steps here originally assumed
one. Both are fixed in `scripts/provision-db.ts`; they are described because the same thing
will happen on RDS, Cloud SQL or Supabase, and neither error says what it means.

**`permission denied to alter role`.** The script re-asserts `NOSUPERUSER NOBYPASSRLS
NOCREATEROLE NOCREATEDB` on all three roles, which a non-superuser may not do. What matters
is the resulting state, not the statement: `CREATE ROLE` already defaults to all four, so on
a fresh managed database the roles arrive correct. The step now falls back to *verifying* the
attributes, and still fails loudly if any of them is genuinely wrong — at which point the
database cannot safely run this application and no retry will change that.

**`must be able to SET ROLE "syncrese_owner"`.** You cannot hand an object to a role you are
not a member of. Superusers are implicitly members of everything, so this never surfaces on a
self-managed cluster. The script now grants itself membership of `syncrese_owner` before
transferring schema ownership.

Note that `neondb_owner` itself has `BYPASSRLS`. That is fine — it is used once, here — but it
is exactly why it must never end up in `DATABASE_URL`. `db:verify` checks the role the
application actually connects as.

It ends by printing both connection strings and confirming that no role is a superuser,
has `BYPASSRLS`, or can create roles. **All three columns must read false, for all three
roles.** If they do not, stop — this application cannot run safely on that database.

Paste the two printed strings into `.env.vercel` as `DATABASE_MIGRATION_URL` and
`DATABASE_URL`.

### Then switch `DATABASE_URL` to the pooled host

Serverless functions each open their own connection, and Neon's direct endpoint will run
out. Take the printed `DATABASE_URL` and change the host to Neon's **pooled** one — the
same hostname with `-pooler` inserted:

```
ep-xxx.eu-central-1.aws.neon.tech       →  direct  — use for DATABASE_MIGRATION_URL
ep-xxx-pooler.eu-central-1.aws.neon.tech →  pooled — use for DATABASE_URL
```

`DATABASE_MIGRATION_URL` stays on the **direct** host: DDL and migration locking do not
work through a transaction-mode pooler.

This is safe with the tenant-isolation design. `withTenant()` sets `app.org_id` with
`set_config(..., is_local => true)` and `SET LOCAL ROLE`, both scoped to the transaction —
which is exactly the unit a transaction-mode pooler preserves. (A plain `SET` would leak
one tenant's id into the next request on a recycled connection. That is why it was written
this way.)

---

## 3. Apply migrations and verify

```bash
npm run db:migrate
npm run db:verify
```

`db:migrate` reads `DATABASE_MIGRATION_URL`, `db:verify` reads `DATABASE_URL` — both from
`.env.vercel` once you have pasted them in, or from your shell.

**Every check in `db:verify` must pass before you send traffic.** It is the only thing that
proves tenant isolation is live on the database you actually deployed, rather than on the
one the tests build.

Expect the last check to say *"skipped — the database has no organizations yet"*. That is
correct; there are none until step 6.

---

## 4. Push to GitHub **[you]**

The repository is committed locally with no remote. Create an empty **private** repo on
GitHub, then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/syncrese.git
git push -u origin main
```

Private matters: the repo contains no secrets, but it does contain the complete product.

---

## 5. Create the Vercel project **[you]**

Import the GitHub repo at [vercel.com/new](https://vercel.com/new). Framework detects as
Next.js; leave the build settings alone.

**Set the function region to match Neon** before the first deploy — Project Settings →
Functions → Region → Frankfurt (`fra1`) if Neon is in `eu-central-1`. A Vercel function in
Washington talking to a Neon database in Frankfurt adds ~100ms to *every* query, and this
app makes several per page.

### Environment variables

Add these under Settings → Environment Variables, scope **Production** (and Preview if you
want previews to work). Values come from `.env.vercel`:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the **pooled** app connection |
| `AUTH_SECRET` | from `.env.vercel` |
| `ENCRYPTION_KEY` | from `.env.vercel` |
| `LICENSE_KEY_PEPPER` | from `.env.vercel` |
| `CRON_SECRET` | from `.env.vercel` |
| `AUTH_URL` | your https URL — see below |
| `SIGNUP_MODE` | `closed` for now |
| `DATABASE_POOL_MAX` | `3` |

**`DATABASE_MIGRATION_URL` is deliberately absent.** Only `npm run db:migrate` reads it, and
that runs from your machine against the direct endpoint — nothing at runtime touches it. It
is the schema OWNER credential: it can drop tables, disable RLS and rewrite policies, and
none of that is anything a web request should be able to reach. Putting it in Vercel widens
what an exposed environment variable would cost, and buys nothing.

`DATABASE_POOL_MAX=3` because each serverless instance keeps its own pool. The default of
10 multiplied by however many instances Vercel spins up will exhaust Neon's connection
limit under load, and the symptom is timeouts that look like a database problem.

`AUTH_URL` has a chicken-and-egg: you do not know the URL until the first deploy. Set it to
`https://syncrese.vercel.app` (or whatever project name you chose), deploy, and correct it
if Vercel assigned something different. Getting it wrong means sign-in redirects to the
wrong host — not a subtle failure.

Before deploying, sanity-check the values locally:

```bash
npm run env:check -- --production
```

---

## 6. Deploy, then create the first organization

Deploy. The app runs `assertEnvironment()` at boot and **refuses to start** if anything
above is missing or still a placeholder, so a green build with a crashing function means
read the runtime logs — the error names every problem at once.

Confirm it is up:

```bash
curl https://your-host/api/health
```

Expect `{"status":"ok"}`. With the cron secret you get detail:

```bash
curl -H "authorization: Bearer $CRON_SECRET" https://your-host/api/health
```

`migrations` should equal the number of files in `drizzle/`. If it is `0`, the app is
talking to a database that has never been migrated — almost always the wrong one.

Then:

1. Set `SIGNUP_MODE=open` and redeploy.
2. Go to `https://your-host/sign-up` and create your organization.
3. Set `SIGNUP_MODE=closed` and redeploy — unless you are opening public signup now.

You now have a real tenant with its own chart of accounts, a 30-day 5-seat trial licence,
and a default CRM pipeline.

---

## 7. Custom domain **[you]**

Add it in Vercel → Settings → Domains, then **update `AUTH_URL` to match** and redeploy.
Leaving `AUTH_URL` on the `.vercel.app` host after moving to your own domain breaks
sign-in in a way that looks like a cookie bug.

---

## Afterwards

- [ ] `.env.vercel` is in a password manager, and `ENCRYPTION_KEY` is backed up somewhere
      that does not depend on the database backup
- [ ] Neon point-in-time restore configured (Settings → History retention)
- [ ] A restore drill: restore to a branch, point `DATABASE_URL` at it, run `db:verify`.
      A restored database does not necessarily carry role attributes or schema ownership —
      re-running `npm run db:provision` against it re-asserts them.
- [ ] Re-run `npm run db:verify` after every future migration

---

## What this deployment still does not have

- **Billing.** No Stripe, no product keys, no seat purchase. The seat *limit* is enforced
  by a database trigger and tested; buying seats is not built.
- **Webhook delivery over HTTP.** Events reach the outbox and the dispatch endpoint runs,
  but how endpoint secrets are stored at rest is an open decision — see
  [02-api.md](02-api.md).
- **GDPR export and erasure tooling.** Tables exist, tooling does not.
- **MFA enrolment**, and SSO needs Google/Microsoft OAuth credentials adding.
- **The assistant panel** is built to spec and labelled as not connected.
