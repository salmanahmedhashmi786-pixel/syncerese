import { AppError } from '@/lib/errors'

/**
 * Which URLs this server is willing to POST to.
 *
 * WHY THIS FILE EXISTS
 *
 * A chat integration is a customer-supplied URL that the server fetches. That
 * is a server-side request forgery primitive, handed over deliberately: any
 * member who can add an integration could otherwise point it at
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and have
 * the application read the deployment's cloud credentials, or at
 * `http://localhost:5432`, or at an internal admin service that trusts anything
 * originating inside the network. The event payload goes in the request body,
 * so it doubles as an exfiltration channel.
 *
 * Blocking private IP ranges is the usual answer and it is not enough on its
 * own: DNS resolves after the check, so a hostname that answers 203.0.113.1 for
 * the validating lookup and 127.0.0.1 for the real one walks straight past it.
 *
 * So this is an ALLOWLIST of the two vendors' webhook hosts. There is no
 * legitimate third value — a Slack integration posts to Slack — and an
 * allowlist of names nobody outside Slack and Microsoft controls is not subject
 * to the rebinding problem, because the attacker cannot make those names
 * resolve anywhere.
 *
 * The redirect rule in `delivery.ts` is the other half: a 302 to an internal
 * address would defeat everything here, so redirects are never followed.
 */

export type ChatKind = 'slack' | 'teams'

/**
 * Host suffixes, per vendor.
 *
 * Matched as "equal to, or ending in a dot followed by" — never a bare
 * `endsWith`, which would accept `hooks.slack.com.evil.test` and
 * `nothooks.slack.com`. That is the classic way an allowlist is bypassed.
 */
const ALLOWED: Record<ChatKind, readonly string[]> = {
  slack: ['hooks.slack.com'],
  teams: [
    // Power Automate / Logic Apps, which is what the Teams "Workflows" app
    // creates. The subdomain carries the region and instance, e.g.
    // prod-27.westeurope.logic.azure.com — so the suffix has to be the zone.
    'logic.azure.com',
    'logic.azure.us',
    // Office 365 connectors, which Microsoft retired over the first half of
    // 2026. Kept narrow — `webhook.office.com` and not `office.com`, which
    // would admit every Microsoft property under that name for the sake of a
    // feature that no longer issues new URLs.
    'webhook.office.com',
  ],
}

/** Every host any kind may use — for validating a URL whose kind is not yet
 *  known, and for showing the customer what is acceptable. */
export const ALLOWED_HOSTS: readonly string[] = Object.values(ALLOWED).flat()

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

export type CheckedUrl = {
  url: string
  host: string
  /** Host plus a short tail of the path — enough for the customer to recognise
   *  which webhook this is, not enough for anyone reading it to post with. */
  hint: string
}

/**
 * Validates a customer-supplied webhook URL for the given kind.
 *
 * Throws `AppError('VALIDATION_FAILED')` with a message meant to be shown, and
 * returns the normalised URL when it passes. Called on save AND again
 * immediately before every request — a URL that was valid when stored is not
 * necessarily what is in the row now, and the check is cheap.
 */
export function checkWebhookUrl(kind: ChatKind, raw: string): CheckedUrl {
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new AppError('VALIDATION_FAILED', 'Paste the webhook URL from your workspace.')
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new AppError('VALIDATION_FAILED', 'That is not a valid URL.')
  }

  // HTTPS only. The URL is a credential and the payload is tenant data; neither
  // travels in clear text. This also rules out file:, gopher: and the other
  // schemes that make SSRF interesting.
  if (url.protocol !== 'https:') {
    throw new AppError('VALIDATION_FAILED', 'The webhook URL must start with https://.')
  }

  // Credentials in the URL would be sent to the host and written to logs by
  // anything in the path. Neither vendor uses them.
  if (url.username !== '' || url.password !== '') {
    throw new AppError('VALIDATION_FAILED', 'The webhook URL must not contain a username or password.')
  }

  // A non-default port on an allowlisted host is not something either vendor
  // issues, and it is how someone reaches a different service on a machine that
  // happens to be in the allowlist.
  if (url.port !== '' && url.port !== '443') {
    throw new AppError('VALIDATION_FAILED', 'The webhook URL must not specify a port.')
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '') // trailing dot: same host, different string
  const allowed = ALLOWED[kind]
  if (!allowed.some((suffix) => hostMatches(host, suffix))) {
    throw new AppError(
      'VALIDATION_FAILED',
      `A ${kind === 'slack' ? 'Slack' : 'Teams'} webhook URL must be on ${allowed.join(' or ')}. ` +
        `This one points at ${host}, so it will not be saved.`,
    )
  }

  return { url: url.toString(), host, hint: hintFor(url) }
}

/**
 * The displayable fragment.
 *
 * Host plus the last path segment truncated to four characters. Slack's path is
 * `/services/T…/B…/<24 secret chars>` and Power Automate's carries a signature
 * in the query string — so the query is dropped entirely and the tail is short
 * enough that it identifies without reconstructing.
 */
function hintFor(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? ''
  return last ? `${url.hostname}/…${last.slice(-4)}` : url.hostname
}
