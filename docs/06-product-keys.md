# Syncrèse — Product keys

The licensing path that does not go through Stripe. A key is issued by you for one customer
and one term, handed over however the sale happened, and redeemed to grant that term.

It is how an invoice-paying customer, an offline installation, or a reseller's customer gets
licensed — and how the desktop app will be licensed when it ships.

---

## The format

```
SYNC-XXXXX-XXXXX-XXXXX-XXXXX
```

**Crockford base32.** The alphabet excludes **I, L, O and U**. I/1 and O/0 are the pairs
people confuse reading a key aloud; U is left out so a random key cannot spell something
unfortunate. On the way in, I and L are read as 1 and O as 0 — Crockford's own rule, which
turns the commonest transcription mistake into a non-event rather than a support call.

**A check character.** The last character is derived from the other nineteen, so a typo is
caught in the browser before a round trip.

- **Every single mistyped character is caught** — provably, not statistically. The weights
  are odd (`2i+1`), and an odd weight is coprime with 32, so `delta × weight ≡ 0 (mod 32)`
  forces `delta = 0`. Weighting by the obvious `i + 1` misses about one typo in seventeen,
  because 32 is 2⁵ and even weights swallow errors.
- **Adjacent transpositions are caught ~94% of the time.** Weighting at all is what catches
  them; an unweighted sum gives "…AB…" and "…BA…" the same character. The residual is a swap
  of two characters differing by exactly 16. Closing it needs a prime modulus, which costs
  either the unambiguous alphabet or a check character outside it.

It is **not a security control** — anyone can compute it. Its job is telling somebody they
mistyped instead of telling them their key is invalid.

**95 bits of entropy.** Nineteen random characters at five bits each. Guessing one is not a
threat model.

**Stored hashed.** Only a peppered SHA-256 (`LICENSE_KEY_PEPPER`) is persisted, exactly like
an API key — a database leak must not yield working licences. The plaintext exists once, at
issue, and is **never recoverable**. If a key is lost, issue another; the old one stops
working.

---

## Terms

| Term | Typical use |
| --- | --- |
| **3 days** | A trial extension or a demo. |
| **30 days** | A monthly term, or a bridge while an invoice is paid. |
| **1 year** | An annual licence. |

Activating extends from **whichever is later — today, or the current expiry**. Somebody
renewing a week before their year ends gets a year *and* the week, not a year.

A key optionally carries a seat count. Seats only ever go **up**: a key for fewer seats than
are already in use would leave the seat trigger refusing every future change for a customer
who has just paid.

---

## Becoming a platform administrator

Issuing keys means acting across tenants, so it is not a tenant capability.

```bash
npm run admin:grant -- you@example.com
npm run admin:grant -- --list
npm run admin:grant -- someone@example.com --revoke
```

**Command line only, deliberately.** A platform admin can see every organization on the
installation and license any of them. Somebody who could appoint another through a browser
would put the whole installation one XSS or one stolen session away from compromise;
requiring shell access to the deployment raises that bar to something meaningful.

The person must already have an account — they sign up or accept an invitation first.

### How the gate actually works

The check is in the **database**, not the application. Every cross-tenant function takes the
caller's user id and returns nothing unless that user is in `platform_admins`:

```sql
WHERE public.is_platform_admin(p_user_id) AND ...
```

So if a future refactor forgets to gate the admin page, the queries answer *empty* rather
than leaking every customer's name. The application-level check in `/admin/layout.tsx` and
in each server action is the second layer, not the only one.

---

## Issuing

`/admin/keys` — a separate area with its own frame, outside the tenant app. Pick the
organization, the term, optionally a seat count and a note (an invoice number is the useful
thing to put there), and generate.

The key is shown **once**. Copy it before you leave the page.

Only one key per organization is live at a time. Issuing a replacement **supersedes** the
outstanding one — which is also what you want when a customer says the key never arrived.

An activated key cannot be withdrawn: revoking it would not claw back a term already
granted, and would strand a paying customer.

---

## Redeeming

Settings → Plan & billing → **Have a product key?**

The customer can type it however it arrives — lower case, no dashes, spaces instead, with
the prefix or without, with a letter O for a zero. All of it normalises to the same key.

Requires `license.manage`, which is one of the four permissions that **keep working while a
workspace is read-only**. Without that, redeeming a key would be impossible for exactly the
customers who most need to (see [05-billing.md](05-billing.md)).

---

## What is not built

- **Unbound keys.** A key is issued *for* an organization that already exists. Selling a key
  to somebody who has not signed up yet would need a redeem-then-create flow.
- **Bulk issuance.** One key at a time.
- **Device binding.** `device_activations` exists in the schema and nothing writes to it. It
  is for the desktop app, which does not exist yet — and seats are people, not machines.
- **Emailing the key.** There is no email sender on this deployment; you copy the key and
  send it yourself.
