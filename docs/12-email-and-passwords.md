# Email and password reset

---

## Email

**SMTP, and only SMTP.** [`src/email/send.ts`](../src/email/send.ts).

Every managed provider worth using — Resend, Postmark, SES, Mailgun, SendGrid — exposes an
SMTP endpoint, and a self-hosted customer already has one. A single transport reaches all of
them, with no per-provider API to keep current and no second code path that only some
deployments exercise.

```bash
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASSWORD=…
EMAIL_FROM="Syncrèse <no-reply@yourdomain.com>"
```

Port 465 is implicit TLS; 587 and 25 start in the clear and upgrade. `requireTLS` is set on
anything that is not 465, so a relay that refuses to upgrade fails rather than quietly
sending credentials and message bodies in clear text.

### Leaving it unconfigured is supported

With no `SMTP_HOST`, `sendEmail` returns `{ sent: false, reason: 'not-configured' }` and each
caller falls back:

- **Invitations** show the link to copy, exactly as before.
- **Password reset** says plainly, *before* anything is typed, that this installation cannot
  send email — rather than sending somebody to watch an inbox that will stay empty.

An installation on an isolated network genuinely has nowhere to send mail, and a product that
throws on a missing optional dependency cannot be evaluated without setting up a mail server
first.

`sendEmail` never throws. The callers are flows a person is waiting on, and a slow relay must
not turn into a 500 on a page that otherwise succeeded.

### What is never emailed

A password, a product key, an API key — anything that would let the holder of a mailbox act
as the account. Reset and invitation **links** are the exception and are treated accordingly:
single-use, short-lived, stored only as a hash.

Send failures log the recipient and the subject, **never the body** — a reset email's body
contains a live token, and a log is exactly the wrong place for one.

---

## Password reset

[`src/auth/password-reset.ts`](../src/auth/password-reset.ts), schema in `drizzle/0023`.

This is the flow most often got wrong, so the decisions are explicit.

### No user enumeration

The request endpoint returns the same sentence whether the address exists, belongs to a
deactivated account, or signs in with Google. An endpoint that distinguishes them is a free
membership oracle for anyone holding a list of addresses — and a company's staff addresses
are not hard to guess.

Throttling happens **before** the lookup, so response timing does not leak the answer either.
Its own counter, deliberately not `signin_attempts`: sharing that table would let somebody
probing resets lock out sign-in for an entire office behind one NAT address, turning a rate
limit into a denial of service against the customer.

### The application cannot read the token table

`password_reset_tokens` and `reset_attempts` have RLS enabled, **no policy, and no grant to
the application role** — the same treatment `signin_attempts` and `signup_attempts` get. Every
access goes through a `SECURITY DEFINER` function, so a bug or an injection in application
code cannot enumerate live reset tokens. That matters more here than elsewhere because
`users` is global: there is no tenant column to scope by if the table were readable.

The RLS coverage guard caught this — the first version granted the app role full DML, which
is weaker than the pattern already established for pre-tenant tables. Both tables now carry an
explicit exemption in `tests/rls-coverage.test.ts` stating why.

### The token

Hashed, single-use, one hour, with the lifetime enforced by the issuing function rather than
a caller-supplied expiry. Claiming it and marking it consumed happen in **one statement**,
so two racing requests cannot both spend it. A completed reset also kills every other
outstanding token for that account — somebody who clicks "forgot password" three times in a
panic should not leave spare keys in their mailbox.

Expired, already-used and never-existed all produce the same message. All three lead the same
place, and telling them apart helps somebody testing tokens more than the person reading it.

### A reset revokes existing sessions

**The part most implementations miss.** Sessions here are JWTs and cannot be deleted
server-side, so `users.credentials_changed_at` is stamped on reset and the session callback
refuses any token issued before it. Without this, a reset after an account compromise leaves
the attacker signed in for the remaining life of their token — up to twelve hours — which
makes the reset close to useless in the case it exists for.

The cost is one indexed lookup per session read. It buys the only thing that makes "you have
been signed out everywhere else" a true statement.

### A reset does not bypass MFA

Nothing in this flow touches the second factor. Somebody who has taken over a mailbox still
has to produce a code — which is the entire reason the second factor exists. A user who has
lost both uses a recovery code.

### It does clear the lockout

A person who forgot their password has usually just failed to guess it eight times. Leaving
them locked out after they have proved control of the mailbox and set a new secret is a
support call for no security benefit.

### An SSO-only account cannot be reset

An account with no `password_hash` resolves to nothing. Issuing a token would let somebody
holding the mailbox *create* a password — converting a Google account into a password account
they control.

### After the fact

A confirmation email is sent when a password changes. Not a formality: it is how somebody
discovers that an attacker who reached their mailbox has taken the account. Without it, a
silent takeover stays silent.

---

## Development without a mail server

Outside production, an unconfigured deployment returns the reset link to the page so the flow
can be finished locally. Guarded on `NODE_ENV !== 'production'` rather than a flag somebody
could set by accident — handing a live reset link to an unauthenticated caller in production
would be the whole vulnerability in one line.

---

## Testing

`tests/password-reset.test.ts` covers enumeration, single use, expiry, session revocation, MFA
being untouched, the lockout clearing, throttle isolation from sign-in, and that the token is
never stored in the clear.

Two mutation checks are worth repeating after any change here: remove
`credentials_changed_at = now()` and remove `AND consumed_at IS NULL` from
`consume_password_reset`. Each should fail exactly one test.

> One caution from building this: the fixture creates users with **no password**, which
> `resolve_reset_recipient` correctly refuses. The deactivated-account and SSO-only tests
> passed at first for that reason rather than because their guards worked. The fixture now
> sets a password, which is what makes those two assertions mean anything.
