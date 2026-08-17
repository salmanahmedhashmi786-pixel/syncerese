# Data retention

Settings → **Data retention**. GDPR Art. 5(1)(e), storage limitation. MUST DO #15.

---

## Why this is the dangerous one

Every other part of the privacy tooling answers a request: a subject asks, the controller
responds, a person is in the loop. Storage limitation is the obligation nobody sends a
request about, which is why it needs a scheduled job — and which makes it **the only part
of this system that destroys data by working correctly.**

Everything below follows from that.

---

## What it can never remove

Invoices, invoice lines, journal entries, journal lines, payments, payment allocations,
customers, products, and the audit log.

Statutory accounting retention overrides an erasure request. §147 AO requires ten years in
Germany, and every EU member state has an equivalent. GDPR Art. 17(3)(b) exempts processing
required for compliance with a legal obligation from the right to erasure. **Deleting those
records to satisfy storage limitation would put the customer in breach of accounting law in
order to comply with privacy law**, and that is not a trade this software makes on their
behalf.

The protection is structural, not a filter:

- The expirable categories are a **closed list** in
  [`src/gdpr/retention.ts`](../src/gdpr/retention.ts). A policy naming anything else is
  rejected on save — there is no configuration that adds a table.
- The audit log additionally **cannot be reached at all**: `drizzle/0001` puts a
  `BEFORE UPDATE OR DELETE` trigger on it that raises unconditionally. A trigger, not a
  grant, so it binds the schema owner too. Personal data in the audit trail is handled by
  erasure's *pseudonymisation* instead — the sequence of events survives, the person in it
  does not.
- A test asserts every statutory table is untouched after a sweep with **every category set
  to its shortest permitted retention**, ten years into the future. Adding invoices as a
  category fails four tests.

---

## What it can remove

| Category | Minimum | Suggested | What goes |
| --- | --- | --- | --- |
| Access records | 90 days | 365 | Rows from `access_log` |
| Team chat content | 30 days | 730 | Message **bodies**, redacted in place |
| Assistant conversations | 30 days | 365 | Threads and their messages |
| Read notifications | 7 days | 90 | Only notifications already read |
| Webhook delivery attempts | 7 days | 30 | Only `succeeded` and `abandoned` rows |

Each minimum exists because deleting sooner breaks something concrete, and the reason is
written next to the number in the source. The access-log floor of 90 days is the one worth
knowing: Art. 33 gives 72 hours to *report* a breach, but reconstructing one routinely
reaches back further, and a trail already pruned cannot answer the question the regulator
actually asks. That floor is enforced **in the database as well** — `prune_access_log()`
raises below 90 days — because a floor that exists only in TypeScript is one the next
caller forgets.

### Two things that are redacted, not deleted

**Chat message bodies.** `drizzle/0011` refuses `DELETE` on `messages` outright — "messages
are soft-deleted, not removed" — because they link to financial records and a dangling
citation is worse than a redacted one. Retention does what erasure already does to that
table: replaces the body, keeps the author and timestamp. The content goes; the conversation
stays citeable.

**The access log** is deleted, but only through a `SECURITY DEFINER` function. The
application role has `SELECT` and `INSERT` on that table and nothing else, which is what
makes "application code cannot quietly erase the access trail" true. The function takes an
organization and a number of days — not a table name, not a predicate — so there is no shape
of argument that makes it delete something else.

### The event outbox, and the one exception to append-only

`events` is the transactional outbox: a row per business event, drained by the webhook and
chat fan-out. It carries its own append-only trigger, and left at that it grows for ever —
on a busy workspace it becomes the largest table in the database, holding rows whose only
remaining purpose was to be dispatched, months ago.

`drizzle/0024` prunes it, and is careful about what it does not loosen:

- **The trigger still refuses every `DELETE`**, with one exception: a transaction that has
  set `app.prune_outbox`. `prune_outbox_events()` sets that flag immediately before deleting
  and clears it immediately after, and it is transaction-local either way, so it cannot
  survive into the next statement on a pooled connection.
- **The application role still has no `DELETE` grant** on `events`. Both barriers would have
  to fail together. Application code cannot delete an event whether or not it sets the flag.
- **`UPDATE` is untouched.** An event still cannot be rewritten — only `dispatched_at` may
  change, exactly as before.

An event is removed only when all three of these hold, and each one is a way a customer
silently loses a message without it:

1. **It was dispatched.** An event the fan-out has not processed is still owed to somebody's
   endpoint, however old it is.
2. **No delivery is still `pending` or `failed`.** `webhook_deliveries.event_id` cascades, so
   pruning an event with a retry outstanding would drop that retry: the endpoint never hears
   about it and nothing anywhere records a failure.
3. **Every enabled chat integration has read past it.** Slack and Teams delivery reads
   forward through this table; deleting rows in front of a cursor makes those messages vanish
   without ever being sent.

The seven-day floor is enforced inside the function, not only in TypeScript. Below a week, a
webhook endpoint that has been down over a long weekend loses its backlog.

#### The one category with a default

Every other category ships off, because deleting a customer's records without being asked is
a data-loss incident wearing a compliance label. The outbox defaults to **90 days**, and the
reasoning is different in kind: it is *our* dispatch queue rather than the customer's
records, its payloads are already redacted by `emit()`, and every business fact it refers to
lives in the invoice or order it describes. Nobody configures how long a log rotation keeps
its files either.

A tenant can still lengthen it, shorten it to the floor, stop it with a legal hold, or switch
it off entirely by saving a null retention — a stored row always wins over the default,
which is what keeps it a default rather than a policy.

---

## How it behaves

- **Off by default**, with one deliberate exception. Every category covering the customer's
  own data ships with no retention set; only the event outbox, which is our dispatch queue,
  has a default. A retention job that starts deleting a customer's records the day it ships
  is a data-loss incident wearing a compliance label.
- **Preview before, not after.** Each category shows how many rows would go if a sweep ran
  now, next to the setting, before you enable it.
- **Legal hold** suspends a category without unconfiguring it. Litigation, a tax audit or a
  regulatory investigation imposes a duty to preserve that outranks storage limitation, and
  the alternative is remembering to turn every policy off one by one at exactly the moment
  everyone is busy. Lifting the hold resumes the stored setting.
- **Floors are re-checked at deletion**, not only on save. A row written before a floor was
  raised, or by a direct database edit, is ignored rather than honoured.
- **Once a day per category**, so a misconfigured cron costs nothing. "Run now" in the panel
  bypasses that gate — the pacing exists to keep a stray pinger cheap, not to stop a person
  who asked.
- **Every sweep is audited, including the ones that removed nothing.** "The job ran and
  found nothing" and "the job never ran" look identical from the outside otherwise, and the
  second one is the compliance failure.

## Scheduling

Daily, via `/api/internal/retention`, guarded by `CRON_SECRET`. Declared in `vercel.json`.
See [deployment](03-deployment.md#5b-schedule-the-retention-sweep).

> Both internal endpoints answer **GET as well as POST**. Vercel Cron invokes jobs with a
> GET, and the dispatch route previously exported only `POST` — so on Vercel the configured
> cron answered 405 every minute and no webhook was ever delivered. A guarded GET is safe
> here because the credential is a bearer token in a header rather than a cookie: a browser
> cannot attach it cross-origin, so there is no CSRF surface.

## Permissions

`gdpr.manage` — owner and admin by default. The same permission as subject access requests
and erasure.

## Testing

`tests/retention.test.ts`. The property the whole feature is judged on is the first test:
every category on, at its floor, ten years into the future, and not one statutory record
gone.

Three mutation checks are worth repeating after any change to the outbox pruning, because
each one leaves the suite green if the corresponding test is written carelessly:

1. Replace the `app.prune_outbox` check in the trigger with `IF true`.
2. Remove the `pending`/`failed` delivery condition from `prune_outbox_events()`.
3. Replace the chat-cursor condition with `false`.

Each should fail exactly one test.

> A caution from building this. The obvious way to assert "an event cannot be deleted" is one
> test accepting either `SYNC_APPEND_ONLY` **or** `permission denied`. That test stays green
> with the trigger opened completely, because the missing `DELETE` grant answers first — it
> passes for a reason that has nothing to do with the thing being tested. The two barriers
> are now asserted separately, and the trigger is exercised through the superuser handle so
> the grant is out of the way. Mutation 1 above is what found this.
>
> Ageing an event with `update events set occurred_at = ...` also fails, correctly: the
> append-only trigger refuses it. Fixtures insert events with the timestamp they want.
