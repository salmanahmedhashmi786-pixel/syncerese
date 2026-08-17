# Slack and Microsoft Teams

Post business events into a chat channel. Settings → **Slack & Teams**.

---

## Why incoming webhooks and not an app

Both vendors offer two routes: an OAuth app (the customer clicks "Add to Slack", picks a
channel from a dropdown) and an **incoming webhook** (the customer creates a URL in their
own workspace and pastes it in).

This uses incoming webhooks. The OAuth route is nicer to use and puts a Slack app review,
a Microsoft Partner Center listing, and a vendor client secret in your deployment's
configuration between this product and its first customer. The paste is worth it.

The consequence is that the setup instructions matter more than the code, so they are in
the panel itself rather than in a link nobody opens.

---

## Getting the URL

**Slack** — api.slack.com/apps → your app → Incoming Webhooks → *Add New Webhook to
Workspace*. The result starts `https://hooks.slack.com/services/`.

**Teams** — in the channel, ⋯ → Workflows → *Post to a channel when a webhook request is
received*. The result is on `logic.azure.com`.

Microsoft retired Office 365 connectors over the first half of 2026, which is why this is
a Power Automate workflow and not the old "Incoming Webhook" connector. Existing
`webhook.office.com` URLs are still accepted.

---

## Only two hosts, ever

A customer-supplied URL that the server sends a POST to is a **server-side request forgery
primitive**. Without a restriction, any member who can manage webhooks could point one at
`http://169.254.169.254/latest/meta-data/iam/security-credentials/` and have the
application read the deployment's cloud credentials — and the event payload rides along in
the request body as an exfiltration channel.

So `src/integrations/allowlist.ts` allows exactly:

| Kind | Hosts |
| --- | --- |
| Slack | `hooks.slack.com` |
| Teams | `logic.azure.com`, `logic.azure.us`, `webhook.office.com` |

`webhook.office.com` is the retired Office 365 connector host, kept for URLs created before
the retirement. Deliberately *not* bare `office.com`, which would admit every Microsoft
property under that name for the sake of a feature that no longer issues new URLs.

with these rules:

- Matched as *equal to, or ending in a dot followed by* — never a bare `endsWith`, which
  accepts `hooks.slack.com.evil.test`.
- `https` only, no embedded username or password, no port other than 443.
- A Slack URL is not accepted for a Teams integration or the reverse.
- **Redirects are never followed.** This is the other half of the allowlist: a 302 from an
  allowlisted host pointing at an internal address would defeat all of the above.

Blocking private IP ranges is the more common answer and it is not sufficient on its own,
because DNS resolves *after* the check — a name that answers a public address for the
validating lookup and `127.0.0.1` for the real one walks straight past it. An allowlist of
names that only Slack and Microsoft control is not subject to that.

The check runs on save **and again immediately before every request**, because the stored
row could have come from a backup taken before the allowlist existed. A stored URL that
fails the second check disables the integration rather than being skipped quietly.

---

## The URL is a credential

Anyone holding it can post into the customer's channel as though they were you. It is
therefore:

- **encrypted at rest** (`ENCRYPTION_KEY`, same as webhook signing secrets and TOTP
  secrets),
- never returned by the settings page — the UI shows a hint like
  `hooks.slack.com/…UvWx`,
- never written to the audit trail, which records the hint instead.

There is no "reveal" action. Unlike a webhook signing secret, a customer who loses this
URL can simply make a new one in their own workspace.

---

## How delivery works

Each integration stores a **cursor** into the organization's event stream rather than
getting a delivery row per message.

Ordered by `(occurred_at, id)`. The id breaks ties because Postgres `now()` is
transaction-start time, so several events emitted in one transaction share a timestamp
exactly — a cursor on the timestamp alone would skip all but the last of them.

- Sending stops at the **first failure** and the cursor stays where the last success put
  it, so nothing is lost and nothing arrives out of order.
- Events the integration is not subscribed to still **advance** the cursor. Otherwise an
  integration watching one rare event type re-reads the same thousand rows every tick.
- At most **20 messages per integration per tick**. A tenant that just imported two
  thousand invoices does not empty the lot into a channel at once; the rest follow.
- Adding an integration starts the cursor at the **newest existing event**, so connecting a
  channel does not replay the workspace's history into it.

### When it gives up

| Response | Behaviour |
| --- | --- |
| 404, 410 | Disabled immediately — the webhook was deleted in the customer's workspace. |
| 429 | Retried next tick. **Not** counted against the failure budget: that is a rate limit, not a broken integration. |
| Anything else | Counted; 20 consecutive failures disables the integration. |

Re-enabling resets the counter. Leaving it at the ceiling would mean the customer's "try
again" does nothing — the next single failure would switch it straight back off.

### Scheduling

Delivery runs from the same tick as webhooks, `POST /api/internal/dispatch`. See
[deployment](03-deployment.md). Without it scheduled, nothing is ever sent.

Set `AUTH_URL`: messages link back to the record they describe, and without it they carry
no link rather than a broken one.

---

## Message content

Nothing in a message is invented. Every number and name comes from the stored event
payload, and a field that is absent is omitted rather than guessed.

The rule that matters: **an amount with no currency in the payload is not rendered as
money at all.** "1,240.00" reads as correct and is wrong for every tenant not billing in
whatever the reader assumed. This is the same constraint the AI assistant works under, and
it is the reason to trust a figure that does appear.

Currencies with other than two decimal places are respected — 124000 minor units is
¥124,000 in JPY and KWD 124.000 in KWD.

Slack messages set `text` as well as `blocks`; a Block Kit message without `text` produces
a push notification with no content in it. Teams messages use the Adaptive Card envelope
Power Automate expects — the retired `MessageCard` shape posts 200 OK and renders an empty
card, which is the worst available failure mode.

---

## Permissions

Gated on `integration.manage` — "Connect Slack and Microsoft Teams" — granted to owner and
admin by default.
