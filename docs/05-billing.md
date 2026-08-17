# Syncrèse — Billing

Subscription billing through Stripe. Implements **MUST DO #16**: seats are enforced by the
database, the client is never trusted about entitlements, and no card ever touches this
application.

Billing is **optional**. With no Stripe keys set, every tenant keeps whatever licence it was
provisioned with and the billing panel says so plainly. That is the normal arrangement for a
self-hosted install.

---

## The shape of it

**Per seat.** The Stripe subscription's `quantity` *is* the licensed seat count. That is not
arbitrary: the licence carries `seat_count`, the seat limit is a database trigger, and MUST
DO #16 defines a seat as a person, not a device.

**Stripe is the source of truth for money; the licence is a mirror.** The browser never says
what it bought. It asks for a Checkout session, Stripe takes the payment, and a *signed
webhook* comes back and changes the licence. Any implementation that trusted the client here
would let a customer grant themselves an enterprise plan with a POST.

**Prices live in Stripe, not in this repo.** `src/billing/plans.ts` defines what each tier
*is* — name, features, seat bands, Price id — and the amount is read from Stripe when a page
needs to show one. Hard-coding an amount gives you two sources of truth for what a customer
pays, and the one in the code is the one that goes stale.

```
Browser ──▶ startCheckoutAction ──▶ Stripe Checkout ──▶ [customer pays]
                                                              │
   licence updated ◀── applySubscription ◀── signed webhook ◀──┘
```

---

## What happens when a payment fails

This is the decision worth reading before you change anything.

| Licence state | Writes | Reads | Exports |
| --- | --- | --- | --- |
| `trial`, `active` | ✅ | ✅ | ✅ |
| `past_due`, inside the 14-day grace window | ✅ (with a banner) | ✅ | ✅ |
| `past_due`, grace expired | ❌ | ✅ | ✅ |
| `cancelled`, still inside the paid period | ✅ | ✅ | ✅ |
| `cancelled` / `suspended`, period over | ❌ | ✅ | ✅ |

**Read-only, never locked out. Nothing is ever deleted for non-payment.**

This system holds a business's statutory accounting records. Denying access to them over an
expired card would be disproportionate, would obstruct the customer's own legal obligations,
and in several jurisdictions would create a problem of its own. Withholding the ability to
add *more* data is enough leverage to get a card updated. Withholding the books is not
leverage — it is a hostage.

Four permissions keep working while read-only, because without them read-only is a trap:

- `license.manage` — paying is a write. This is the way *out*.
- `gdpr.manage` — a data subject's rights do not lapse because their controller's card did.
- `member.deactivate` — freeing a seat must stay possible.
- `org.delete` — so must leaving.

Enforced in `requirePermission()`, which every mutation already goes through for RBAC. A
separate `requireWritable()` that each service had to remember to call would be missed
within a month.

---

## Setup

### 1. Create the products in Stripe **[you]**

One **recurring, per-unit** Price per plan. The plan keys the code expects are `starter`,
`professional` and `enterprise` — edit `src/billing/plans.ts` if you want different tiers,
names, seat bands or feature lists.

Set the amounts in Stripe. Nothing in this repo needs to know them.

### 2. Configure

```
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_STARTER=price_…
STRIPE_PRICE_PROFESSIONAL=price_…
STRIPE_PRICE_ENTERPRISE=price_…
```

A plan with no Price id configured is **hidden**, not offered and then failing at checkout.

`sk_test_…` while setting up. A live key on a staging deployment charges real cards.

### 3. Add the webhook endpoint **[you]**

Point it at `https://your-host/api/webhooks/stripe` and subscribe to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_succeeded`
- `invoice.payment_failed`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

**The signature is the only authentication on that endpoint.** It is public — it has to be —
and everything it does changes what a customer is entitled to.

Locally:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

### 4. Enable Stripe Tax **[you]**

Checkout is created with `automatic_tax` on and `tax_id_collection` enabled, so Stripe
calculates and remits VAT and collects VAT numbers. You still have to enable Tax in the
Stripe dashboard and register where you are liable. Getting cross-border VAT right across 27
member states is not a thing to hand-roll.

---

## How the webhook stays correct

Three properties, all easy to get wrong in ways that only appear in production:

**Idempotent.** Stripe delivers *at least once* and retries for days on any non-2xx. The
`billing_events` table has the Stripe event id as its primary key; a duplicate insert
conflicts and the handler returns 200 without doing the work again. Applying a seat change
twice would double it.

**Order-independent.** Stripe does not guarantee ordering. A delayed
`customer.subscription.updated` can arrive *after* the `deleted` that followed it and
silently reinstate a cancelled subscription. Anything older than an event already applied to
that tenant is discarded and logged as `webhook.out_of_order`.

**Always 2xx once accepted.** An event that is recorded but not actionable — an unknown
customer, an abandoned checkout, a Stripe account shared with another product — still
returns 200. Anything else makes Stripe retry for days and fills the customer's dashboard
with red. Only a genuine handler failure returns 500, which is exactly when a retry is what
you want.

### Seats are never reduced below the seats in use

If a downgrade to 3 seats arrives while 10 people are active, the licence keeps **10**. The
alternative is a seat trigger that refuses every future change for a customer who has just
paid. The discrepancy is written to `license_events` as `subscription.synced` with both
numbers — it is a conversation to have with the customer, not something to resolve silently.

---

## Testing without spending money

`tests/billing.test.ts` runs with no network: Stripe events are plain objects, which is
exactly what the handler receives after signature verification. It covers the duplicate
delivery, the out-of-order delivery, seat clamping, the grace window, and read-only
enforcement letting reads through while refusing writes.

Stripe's own test cards drive the real flow end to end — `4242…` succeeds,
`4000 0000 0000 0341` attaches successfully and then fails on the first charge, which is the
one that exercises `past_due` and the grace window.

---

## Not built

- **Product keys.** The desktop app is meant to consume a key issued after purchase.
  `license_keys` exists and documents the proposed format — `SYNC-XXXXX-XXXXX-XXXXX-XXXXX`,
  Crockford base32 so it can be read aloud to support, with a check character, stored
  hashed. **This has not been implemented, and your brief asks for the scheme to be confirmed
  before it is.** Nothing needs it until the desktop app ships.
- **Usage-based or metered billing.** Every plan is a flat per-seat subscription.
- **Proration UI.** Stripe prorates seat changes; nothing in this app previews the amount
  before the customer confirms in Checkout.
- **Dunning emails.** Stripe's own retry-and-notify settings handle this. There is no
  in-app email.
- **Tax registration.** Enabling Stripe Tax is not the same as being registered where you
  owe VAT.
