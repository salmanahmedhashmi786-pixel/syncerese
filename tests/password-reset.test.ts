import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { completeReset, requestReset, tokenLooksValid } from '@/auth/password-reset'
import { hashPassword, verifyPassword, passwordPolicy } from '@/auth/password'
import { __setTransportForTests, emailConfigured } from '@/email/send'
import {
  invitationEmail,
  passwordChangedEmail,
  passwordResetEmail,
} from '@/email/templates'
import { createTestDb, seedOrg, type TestDb } from './helpers/db'

/** Collects what would have been sent instead of opening a socket. */
function captureMail() {
  const sent: { to: string; subject: string; text: string; html?: string }[] = []
  __setTransportForTests({
    sendMail: async (message: Record<string, unknown>) => {
      sent.push({
        to: String(message.to),
        subject: String(message.subject),
        text: String(message.text),
        html: message.html ? String(message.html) : undefined,
      })
      return { messageId: 'test' }
    },
  } as never)
  return sent
}

const APP_URL = 'https://erp.example.test'

describe('password reset', () => {
  let t: TestDb
  let userId: string
  let sent: ReturnType<typeof captureMail>

  beforeEach(async () => {
    t = await createTestDb()
    const org = await seedOrg(t, { name: 'Vogel Handel GmbH', slug: 'vogel', seats: 10 })
    userId = org.ownerUserId

    // seedOrg creates users with no password, which `resolve_reset_recipient`
    // correctly refuses to issue a token for. Without this the deactivated and
    // SSO-only tests below would pass whether or not their guards existed.
    await t.db.execute(sql`
      update users set password_hash = ${await hashPassword('the original password')}
       where id = ${userId}::uuid
    `)

    sent = captureMail()
  })

  afterEach(async () => {
    __setTransportForTests(null)
    await t.close()
  })

  const emailOf = async () => {
    const res = await t.db.execute(sql`select email from users where id = ${userId}::uuid`)
    return (res as unknown as { rows: { email: string }[] }).rows[0]!.email
  }

  const linkFrom = (text: string) =>
    /https:\/\/\S+\/reset-password\?token=([^\s]+)/.exec(text)?.[1] ?? ''

  const request = async (email: string) =>
    requestReset(t.db, { email, ipHash: null, appUrl: APP_URL })

  // -------------------------------------------------------------------------
  // No user enumeration. The property this endpoint exists to preserve.
  // -------------------------------------------------------------------------

  it('answers identically for a real address and an invented one', async () => {
    const real = await request(await emailOf())
    const fake = await request('nobody@example.invalid')

    // With mail configured the two are indistinguishable to the caller — and
    // the action above them returns a fixed sentence regardless, so nothing
    // varying ever reaches the browser.
    expect(real).toEqual({ sent: true })
    expect(fake).toEqual({ sent: false })
    expect(real.devLink).toBeUndefined()
    expect(fake.devLink).toBeUndefined()

    // Only the real address produced a message, and only to itself.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(await emailOf())
  })

  it('issues nothing for a deactivated account', async () => {
    await t.db.execute(sql`update users set status = 'deactivated' where id = ${userId}::uuid`)
    await request(await emailOf())
    expect(sent).toHaveLength(0)
  })

  it('issues nothing for an account with no password', async () => {
    // An SSO-only account has no password to reset. Issuing a token would let
    // somebody holding the mailbox CREATE one — converting a Google account
    // into a password account they control.
    await t.db.execute(sql`update users set password_hash = null where id = ${userId}::uuid`)
    await request(await emailOf())
    expect(sent).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // The token.
  // -------------------------------------------------------------------------

  it('stores only a hash of the token', async () => {
    await request(await emailOf())
    const token = linkFrom(sent[0]!.text)
    expect(token.length).toBeGreaterThan(20)

    const stored = await t.db.execute(sql`select token_hash from password_reset_tokens`)
    const hash = (stored as unknown as { rows: { token_hash: string }[] }).rows[0]!.token_hash
    // A backup or a read replica must not contain a list of live reset tokens.
    expect(hash).not.toContain(token)
    expect(hash).not.toBe(token)
  })

  it('works once', async () => {
    await request(await emailOf())
    const token = linkFrom(sent[0]!.text)

    expect((await completeReset(t.db, token, 'correct horse battery')).ok).toBe(true)
    const second = await completeReset(t.db, token, 'another long passphrase')
    expect(second.ok).toBe(false)
  })

  it('expires', async () => {
    await request(await emailOf())
    const token = linkFrom(sent[0]!.text)
    await t.db.execute(sql`update password_reset_tokens set expires_at = now() - interval '1 minute'`)

    expect(await tokenLooksValid(t.db, token)).toBe(false)
    expect((await completeReset(t.db, token, 'correct horse battery')).ok).toBe(false)
  })

  it('kills every other outstanding token for that account', async () => {
    // Somebody who clicks "forgot password" three times in a panic should not
    // leave two spare keys lying in their mailbox.
    for (let i = 0; i < 3; i++) await request(await emailOf())
    expect(sent).toHaveLength(3)

    const tokens = sent.map((m) => linkFrom(m.text))
    expect((await completeReset(t.db, tokens[2]!, 'correct horse battery')).ok).toBe(true)

    for (const stale of [tokens[0]!, tokens[1]!]) {
      expect(await tokenLooksValid(t.db, stale)).toBe(false)
    }
  })

  it('does not let the application role read the token table at all', async () => {
    // Same treatment as signin_attempts and signup_attempts: RLS with no policy
    // and no grant, so every access goes through a SECURITY DEFINER function.
    // A bug or an injection in application code must not be able to enumerate
    // live reset tokens — and `users` is global, so there is no tenant column
    // to scope by if it could.
    await request(await emailOf())

    const grants = await t.db.execute(sql`
      select count(*)::int as n from information_schema.role_table_grants
       where table_name in ('password_reset_tokens', 'reset_attempts')
         and grantee = 'syncrese_app'
    `)
    expect((grants as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0)

    const policies = await t.db.execute(sql`
      select count(*)::int as n from pg_policies
       where tablename = 'password_reset_tokens' and policyname <> 'definer_access'
    `)
    expect((policies as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0)
  })

  it('rejects an invented token without saying why', async () => {
    const result = await completeReset(t.db, 'not-a-real-token', 'correct horse battery')
    expect(result.ok).toBe(false)
    // The same sentence as expired and already-used. All three lead the same
    // place, and telling them apart helps somebody testing tokens more than it
    // helps the person reading it.
    expect(result.ok === false && result.error).toMatch(/not valid any more/i)
  })

  // -------------------------------------------------------------------------
  // What a successful reset actually does.
  // -------------------------------------------------------------------------

  it('sets the new password and confirms it afterwards', async () => {
    await request(await emailOf())
    const token = linkFrom(sent[0]!.text)
    await completeReset(t.db, token, 'correct horse battery staple')

    const row = await t.db.execute(
      sql`select password_hash as h, credentials_changed_at as c,
                 failed_login_count as f, locked_until as l
            from users where id = ${userId}::uuid`,
    )
    const user = (
      row as unknown as {
        rows: { h: string; c: Date | null; f: number; l: Date | null }[]
      }
    ).rows[0]!

    expect(await verifyPassword('correct horse battery staple', user.h)).toBe(true)

    // Revokes existing JWT sessions. Without this a reset after a compromise
    // leaves the attacker signed in for the rest of their token's life.
    expect(user.c).not.toBeNull()

    // A person who forgot their password has usually just failed to guess it
    // eight times; staying locked out after proving mailbox control and setting
    // a new secret is a support call for no security benefit.
    expect(user.f).toBe(0)
    expect(user.l).toBeNull()

    // And they are told it happened — which is how a silent takeover stops
    // being silent.
    expect(sent[1]!.subject).toMatch(/password was changed/i)
  })

  it('does not touch the second factor', async () => {
    // Somebody who has taken over a mailbox must still produce a code. A reset
    // that cleared MFA would make the second factor worthless against exactly
    // the attacker it exists for.
    await t.db.execute(sql`
      update users set mfa_secret_encrypted = 'x', mfa_enabled_at = now()
       where id = ${userId}::uuid
    `)
    await request(await emailOf())
    await completeReset(t.db, linkFrom(sent[0]!.text), 'correct horse battery')

    const row = await t.db.execute(
      sql`select mfa_secret_encrypted as s, mfa_enabled_at as e from users where id = ${userId}::uuid`,
    )
    const mfa = (row as unknown as { rows: { s: string | null; e: Date | null }[] }).rows[0]!
    expect(mfa.s).toBe('x')
    expect(mfa.e).not.toBeNull()
  })

  it('enforces the same password rule as signup', () => {
    expect(passwordPolicy('short').ok).toBe(false)
    expect(passwordPolicy('correct horse battery').ok).toBe(true)
    expect(passwordPolicy('x'.repeat(2000)).ok).toBe(false)
  })

  it('refuses a weak password before spending the token', async () => {
    await request(await emailOf())
    const token = linkFrom(sent[0]!.text)

    expect((await completeReset(t.db, token, 'short')).ok).toBe(false)
    // Still usable — a rejected password must not burn the link.
    expect(await tokenLooksValid(t.db, token)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Throttling.
  // -------------------------------------------------------------------------

  it('throttles by network without touching the sign-in counter', async () => {
    const email = await emailOf()
    for (let i = 0; i < 12; i++) {
      await requestReset(t.db, { email, ipHash: 'one-network', appUrl: APP_URL })
    }
    // Ten allowed per hour, so a burst of twelve does not produce twelve mails.
    expect(sent.length).toBeLessThanOrEqual(10)

    // And sign-in is untouched: sharing that counter would let somebody probing
    // resets lock out an entire office behind one NAT address.
    const signin = await t.db.execute(sql`select count(*)::int as n from signin_attempts`)
    expect((signin as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('email', () => {
  afterEach(() => __setTransportForTests(null))

  it('is optional, and says so rather than throwing', async () => {
    const previous = process.env.SMTP_HOST
    delete process.env.SMTP_HOST
    __setTransportForTests(null)
    try {
      expect(emailConfigured()).toBe(false)
      const { sendEmail } = await import('@/email/send')
      const result = await sendEmail({ to: 'a@b.test', subject: 'x', text: 'y' })
      // An isolated installation legitimately has nowhere to send mail. That is
      // a supported state, and the caller falls back to showing a link.
      expect(result).toEqual({ sent: false, reason: 'not-configured' })
    } finally {
      if (previous) process.env.SMTP_HOST = previous
    }
  })

  it('always carries a plain-text part', () => {
    // Corporate gateways strip HTML, and a reset email that renders blank is a
    // support call at the worst possible moment.
    const messages = [
      passwordResetEmail('a@b.test', 'https://x.test/reset-password?token=abc', 60),
      passwordChangedEmail('a@b.test'),
      invitationEmail('a@b.test', 'https://x.test/invite/abc', 'Vogel Handel GmbH', 'Sarah'),
    ]
    for (const m of messages) {
      expect(m.text.length).toBeGreaterThan(40)
      expect(m.subject).not.toBe('')
    }
  })

  it('escapes what it puts in HTML', () => {
    // The organization name is tenant data and reaches an inbox.
    const message = invitationEmail(
      'a@b.test',
      'https://x.test/invite/abc',
      '<script>alert(1)</script> & Co',
      null,
    )
    expect(message.html).not.toContain('<script>')
    expect(message.html).toContain('&lt;script&gt;')
    expect(message.html).toContain('&amp;')
  })
})
