import { createTransport, type Transporter } from 'nodemailer'

/**
 * Sending mail.
 *
 * SMTP, AND ONLY SMTP
 *
 * Every managed provider worth using — Resend, Postmark, SES, Mailgun,
 * SendGrid — exposes an SMTP endpoint, and a self-hosted customer already has
 * one. A single transport therefore reaches all of them, with no per-provider
 * API to keep current and no second code path that only some deployments
 * exercise. An HTTP adapter would be faster on serverless cold starts and is
 * not worth two implementations of the same thing.
 *
 * NOT CONFIGURING IT IS A SUPPORTED STATE
 *
 * With no SMTP host set, `sendEmail` returns `{ sent: false }` and the caller
 * falls back — invitations show a link to copy, and a password reset says so
 * rather than pretending. That matters because an installation on an isolated
 * network legitimately has nowhere to send mail, and because a product that
 * throws on a missing optional dependency is one that cannot be evaluated
 * without setting up a mail server first.
 *
 * WHAT IS NEVER PUT IN AN EMAIL
 *
 * A password, a product key, an API key, or anything else that would let the
 * holder of a mailbox act as the account. Reset and invitation LINKS are the
 * exception and are treated accordingly: single-use, short-lived, and stored
 * only as a hash.
 */

export type EmailMessage = {
  to: string
  subject: string
  /** Plain text is the real message. Every mail client renders it, it survives
   *  a corporate gateway that strips HTML, and it is what a screen reader gets
   *  when the HTML part is mangled. */
  text: string
  html?: string
}

export type SendResult =
  | { sent: true }
  | { sent: false; reason: 'not-configured' | 'failed'; error?: string }

let cached: Transporter | null = null
let cachedKey = ''

/**
 * Set only by the tests, and checked BEFORE the environment.
 *
 * The first version stored the stub in `cached` and let `transport()` return
 * early on a missing `SMTP_HOST`, so the injection never took effect and every
 * test saw "not configured" — passing the ones that assert nothing is sent, for
 * the wrong reason.
 */
let override: Transporter | null = null

export const emailConfigured = (): boolean => Boolean(override ?? process.env.SMTP_HOST)

/** The From address. Falls back to the host so a misconfigured deployment
 *  produces a bounce that names itself rather than an empty header. */
export const emailFrom = (): string =>
  process.env.EMAIL_FROM ?? `Syncrese <no-reply@${process.env.SMTP_HOST ?? 'localhost'}>`

function transport(): Transporter | null {
  if (override) return override

  const host = process.env.SMTP_HOST
  if (!host) return null

  const port = Number(process.env.SMTP_PORT ?? 587)
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASSWORD

  // Rebuilt when the configuration changes, which in practice means the tests.
  const key = `${host}:${port}:${user ?? ''}`
  if (cached && cachedKey === key) return cached

  cached = createTransport({
    host,
    port,
    // 465 is implicit TLS; 587 and 25 start in the clear and upgrade. Getting
    // this backwards produces a connection that hangs rather than an error,
    // which is a miserable thing to debug.
    secure: port === 465,
    // On 587, refuse to continue if the server will not upgrade. Without this
    // nodemailer silently sends credentials and message bodies in clear text
    // over any network between here and the relay.
    requireTLS: port !== 465,
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
  cachedKey = key
  return cached
}

/**
 * Sends one message.
 *
 * Never throws. Callers are flows a person is waiting on — a password reset, an
 * invitation — and a mail server that is slow or down must not turn into a 500
 * on a page that otherwise succeeded. The result says what happened so the
 * caller can decide; `sendEmail` deliberately does not decide for them.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const mailer = transport()
  if (!mailer) return { sent: false, reason: 'not-configured' }

  try {
    await mailer.sendMail({
      from: emailFrom(),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    })
    return { sent: true }
  } catch (err) {
    // The recipient and the subject, never the body: a reset email's body
    // contains a live token, and a log is exactly the wrong place for one.
    console.error('[email] send failed', {
      to: message.to,
      subject: message.subject,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false, reason: 'failed', error: 'The message could not be sent.' }
  }
}

/** Test seam. The suite swaps the transport rather than opening a socket. */
export function __setTransportForTests(t: Transporter | null): void {
  override = t
  cached = null
  cachedKey = ''
}
