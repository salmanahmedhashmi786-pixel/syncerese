import type { EmailMessage } from './send'

/**
 * The messages this system sends.
 *
 * WRITTEN AS PLAIN TEXT FIRST. The HTML part is a courtesy; the text part is the
 * message. Corporate gateways strip HTML, screen readers prefer text, and a
 * password-reset email that renders as a blank page because a `<div>` upset
 * somebody's client is a support call at the worst possible moment.
 *
 * Deliberately plain in another sense too: no logo, no marketing, no tracking
 * pixel. These are transactional messages about somebody's account, and the
 * more they look like a newsletter the more they look like phishing — which
 * matters most for exactly the email that asks a person to click a link and
 * type a new password.
 */

/** Kept short and specific. A subject line is what the recipient uses to decide
 *  whether the message is genuine. */
const wrap = (body: string): string =>
  `${body.trim()}\n\n—\nSyncrèse\nThis is an automated message. Nobody monitors replies to it.\n`

/**
 * Minimal HTML.
 *
 * Inline styles only — every mail client strips <style> blocks — and no images,
 * so nothing has to load from a server for the message to be readable.
 */
const html = (body: string): string => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f6f4;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1c1d1f">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e3e0;border-radius:10px;padding:28px">
${body}
<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e3e3e0;color:#6b6f76;font-size:12px">
Syncrèse · This is an automated message. Nobody monitors replies to it.
</p>
</div></body></html>`

const button = (url: string, label: string): string =>
  `<p style="margin:22px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>
<p style="margin:0;color:#6b6f76;font-size:12px;word-break:break-all">Or paste this into your browser:<br>${escapeHtml(url)}</p>`

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------

export function passwordResetEmail(to: string, url: string, minutes: number): EmailMessage {
  const text = wrap(`Somebody asked to reset the password for your Syncrèse account.

Open this link to choose a new one. It works once and expires in ${minutes} minutes:

${url}

If that was not you, you can ignore this message — your password has not changed,
and nobody can use this link without your mailbox.

If you use a second factor, you will still be asked for it when you sign in.`)

  return {
    to,
    // No name, no workspace, no "urgent". A reset subject that is boring and
    // specific is the one a person can recognise as genuine.
    subject: 'Reset your Syncrèse password',
    text,
    html: html(`<p style="margin:0 0 12px;font-size:16px;font-weight:600">Reset your password</p>
<p style="margin:0">Somebody asked to reset the password for your Syncrèse account. This link works once and expires in ${minutes} minutes.</p>
${button(url, 'Choose a new password')}
<p style="margin:22px 0 0;color:#6b6f76;font-size:12px">If that was not you, ignore this message — your password has not changed. If you use a second factor, you will still be asked for it when you sign in.</p>`),
  }
}

/**
 * Confirmation that a password actually changed.
 *
 * Sent AFTER the fact, and it is not a formality: it is how somebody finds out
 * that an attacker who reached their mailbox has taken the account. Without it
 * a silent takeover stays silent.
 */
export function passwordChangedEmail(to: string): EmailMessage {
  const text = wrap(`The password for your Syncrèse account was just changed.

You have been signed out everywhere else.

If this was not you, contact whoever administers your workspace immediately —
somebody with access to this mailbox has changed your password.`)

  return {
    to,
    subject: 'Your Syncrèse password was changed',
    text,
    html: html(`<p style="margin:0 0 12px;font-size:16px;font-weight:600">Your password was changed</p>
<p style="margin:0">The password for your Syncrèse account was just changed, and you have been signed out everywhere else.</p>
<p style="margin:16px 0 0;color:#b42318">If this was not you, contact whoever administers your workspace immediately.</p>`),
  }
}

export function invitationEmail(
  to: string,
  url: string,
  organizationName: string,
  inviterName: string | null,
): EmailMessage {
  const who = inviterName ? `${inviterName} has` : 'You have been'
  const text = wrap(`${who} invited you to join ${organizationName} on Syncrèse.

Open this link to accept:

${url}

If you were not expecting this, you can ignore it. The invitation expires on its
own and does nothing until it is accepted.`)

  return {
    to,
    subject: `Join ${organizationName} on Syncrèse`,
    text,
    html: html(`<p style="margin:0 0 12px;font-size:16px;font-weight:600">Join ${escapeHtml(organizationName)}</p>
<p style="margin:0">${escapeHtml(who)} invited you to join <strong>${escapeHtml(organizationName)}</strong> on Syncrèse.</p>
${button(url, 'Accept the invitation')}
<p style="margin:22px 0 0;color:#6b6f76;font-size:12px">If you were not expecting this, ignore it. The invitation expires on its own and does nothing until it is accepted.</p>`),
  }
}
