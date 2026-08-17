import { describe, it, expect } from 'vitest'
import { checkWebhookUrl, ALLOWED_HOSTS } from '@/integrations/allowlist'
import {
  slackMessage,
  teamsMessage,
  summaryOf,
  moneyOf,
  linkFor,
  titleFor,
  type ChatEvent,
} from '@/integrations/format'

const ctx = { organizationName: 'Northwind GmbH', appUrl: 'https://app.syncrese.test' }

const event = (over: Partial<ChatEvent> = {}): ChatEvent => ({
  id: '018f0000-0000-7000-8000-000000000001',
  type: 'invoice.issued',
  entityType: 'invoice',
  entityId: '018f0000-0000-7000-8000-0000000000aa',
  payload: { invoiceNo: 'INV-2026-0042', totalMinor: 124_000, currencyCode: 'EUR' },
  occurredAt: '2026-03-04T09:15:30.000Z',
  ...over,
})

// ---------------------------------------------------------------------------
// The allowlist. This is the SSRF boundary, so it gets the paranoid tests.
// ---------------------------------------------------------------------------

describe('the webhook URL allowlist', () => {
  it('accepts the URLs the two vendors actually issue', () => {
    expect(
      checkWebhookUrl('slack', 'https://hooks.slack.com/services/T0/B0/example-not-a-real-token')
        .host,
    ).toBe('hooks.slack.com')

    expect(
      checkWebhookUrl(
        'teams',
        'https://prod-27.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=xyz',
      ).host,
    ).toBe('prod-27.westeurope.logic.azure.com')

    expect(
      checkWebhookUrl('teams', 'https://acme.webhook.office.com/webhookb2/guid@guid/IncomingWebhook/x/y')
        .host,
    ).toBe('acme.webhook.office.com')
  })

  it('refuses the addresses that make an outbound fetch an SSRF primitive', () => {
    const targets = [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'https://169.254.169.254/',
      'http://localhost:5432/',
      'https://127.0.0.1/',
      'http://[::1]/',
      'https://10.0.0.5/internal',
      'https://192.168.1.1/',
      'https://172.16.0.1/',
      'file:///etc/passwd',
      'gopher://internal:11211/_stats',
    ]
    for (const target of targets) {
      expect(() => checkWebhookUrl('slack', target), target).toThrow()
      expect(() => checkWebhookUrl('teams', target), target).toThrow()
    }
  })

  it('is not fooled by hostnames that merely contain an allowed one', () => {
    // Every one of these passes a naive `host.includes('hooks.slack.com')` or
    // `host.endsWith('slack.com')`, and every one is attacker-controlled.
    const impostors = [
      'https://hooks.slack.com.evil.test/x',
      'https://hooks.slack.com.evil.test./x',
      'https://nothooks.slack.com/x',
      'https://evil.test/?u=hooks.slack.com',
      'https://evil.test/hooks.slack.com/services/x',
      'https://hooks.slack.com@evil.test/x',
      'https://xhooks.slack.com/x',
    ]
    for (const url of impostors) {
      expect(() => checkWebhookUrl('slack', url), url).toThrow()
    }

    for (const url of [
      'https://logic.azure.com.evil.test/x',
      'https://notlogic.azure.com/x',
      'https://evil.test/logic.azure.com',
    ]) {
      expect(() => checkWebhookUrl('teams', url), url).toThrow()
    }
  })

  it('will not accept a Teams URL for Slack, or the reverse', () => {
    expect(() =>
      checkWebhookUrl('teams', 'https://hooks.slack.com/services/T0/B0/xxxxxxxxxxxxxxxxxxxxxxxx'),
    ).toThrow()
    expect(() =>
      checkWebhookUrl('slack', 'https://prod-1.westeurope.logic.azure.com/workflows/x'),
    ).toThrow()
  })

  it('requires https, and rejects embedded credentials and odd ports', () => {
    expect(() => checkWebhookUrl('slack', 'http://hooks.slack.com/services/x')).toThrow(/https/i)
    expect(() =>
      checkWebhookUrl('slack', 'https://user:pass@hooks.slack.com/services/x'),
    ).toThrow(/username or password/i)
    expect(() => checkWebhookUrl('slack', 'https://hooks.slack.com:8080/services/x')).toThrow(
      /port/i,
    )
    // 443 is the default and Power Automate writes it out explicitly.
    expect(() => checkWebhookUrl('slack', 'https://hooks.slack.com:443/services/x')).not.toThrow()
  })

  it('treats a trailing dot as the same host', () => {
    // "hooks.slack.com." is the fully-qualified form of the same name and
    // resolves identically, so rejecting it would be a support ticket — but
    // accepting it via a bare endsWith would also accept "…com.evil.test.".
    const checked = checkWebhookUrl('slack', 'https://hooks.slack.com./services/T0/B0/xxxx')
    expect(checked.host).toBe('hooks.slack.com')
  })

  it('produces a hint that identifies the webhook without reconstructing it', () => {
    const secret = 'XXXXXXXXXXXXXXXXXXXXXXXX'
    const { hint } = checkWebhookUrl('slack', `https://hooks.slack.com/services/T0/B0/${secret}`)
    expect(hint).toContain('hooks.slack.com')
    expect(hint).not.toContain(secret)
    expect(hint.length).toBeLessThan(40)
  })

  it('never follows a redirect, in either code path', async () => {
    // The other half of the allowlist, and the easier half to lose in a
    // refactor. The host check applies to the URL being requested; if a 302
    // were followed, an allowlisted host answering
    // `Location: http://169.254.169.254/…` would send this server — and the
    // event payload — exactly where the allowlist exists to prevent.
    //
    // Asserted against the source rather than a live server, because a fetch
    // that follows a redirect only misbehaves when something actually issues
    // one, which is precisely the case a unit test cannot stage.
    const { readFileSync } = await import('node:fs')
    for (const file of ['src/integrations/delivery.ts', 'src/integrations/chat.ts']) {
      const source = readFileSync(file, 'utf8')
      const sites = [...source.matchAll(/\bawait fetch\(/g)]
      expect(sites.length, `${file} should call fetch`).toBeGreaterThan(0)
      for (const site of sites) {
        // The options object of this particular call, not the file at large —
        // a comment elsewhere mentioning the flag must not satisfy the check.
        const options = source.slice(site.index!, site.index! + 500)
        expect(options, `${file}: this fetch is missing redirect: 'manual'`).toContain(
          "redirect: 'manual'",
        )
      }
    }
  })

  it('lists only vendor hosts', () => {
    expect(ALLOWED_HOSTS).toContain('hooks.slack.com')
    expect(ALLOWED_HOSTS.some((h) => h.includes('localhost'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Formatting. The rule under test is that nothing is invented.
// ---------------------------------------------------------------------------

describe('message formatting', () => {
  it('renders money only when the currency is in the payload', () => {
    expect(moneyOf({ totalMinor: 124_000, currencyCode: 'EUR' })).toBe('€1,240.00')

    // The whole point. An amount with no currency is NOT rendered as a number —
    // "1,240.00" reads as correct and is wrong for every tenant not billing in
    // whatever the reader assumed.
    expect(moneyOf({ totalMinor: 124_000 })).toBeUndefined()
    expect(moneyOf({ currencyCode: 'EUR' })).toBeUndefined()
  })

  it('respects currencies that do not have two decimal places', () => {
    // 124000 minor units is ¥124,000 in JPY (no minor unit) and KWD 124.000 in
    // KWD (three). A hard-coded /100 would print ¥1,240.00 and KWD 1,240.00 —
    // both wrong, both plausible-looking.
    //
    // `nbsp` because Intl separates a currency code from the number with U+00A0.
    const nbsp = (s: string | undefined) => s?.replace(/ /g, ' ')
    expect(nbsp(moneyOf({ totalMinor: 124_000, currencyCode: 'JPY' }))).toBe('¥124,000')
    expect(nbsp(moneyOf({ totalMinor: 124_000, currencyCode: 'KWD' }))).toBe('KWD 124.000')
  })

  it('drops a field it cannot trust rather than printing undefined or NaN', () => {
    const summary = summaryOf(
      event({ payload: { invoiceNo: 'INV-1', totalMinor: 'not a number', currencyCode: 'EUR' } }),
    )
    expect(summary).toBe('INV-1')
    expect(summary).not.toMatch(/undefined|NaN|null/)
  })

  it('omits the link when there is no app URL or no entity', () => {
    expect(linkFor(event(), ctx)).toBe('https://app.syncrese.test/invoices/018f0000-0000-7000-8000-0000000000aa')
    expect(linkFor(event(), { ...ctx, appUrl: null })).toBeNull()
    expect(linkFor(event({ entityId: null }), ctx)).toBeNull()
    expect(linkFor(event({ entityType: 'something_new' }), ctx)).toBeNull()
  })

  it('falls back to the raw type for an event with no title', () => {
    expect(titleFor('invoice.paid')).toBe('Invoice paid')
    expect(titleFor('module.thing.happened')).toBe('module.thing.happened')
  })

  describe('Slack', () => {
    it('sets text as well as blocks', () => {
      const body = slackMessage(event(), ctx)
      // A Block Kit message with no `text` produces a push notification with no
      // content in it, which is worse than not sending.
      expect(body.text).toBe('Invoice issued — INV-2026-0042 · €1,240.00')
      expect(Array.isArray(body.blocks)).toBe(true)
    })

    it('uses Slack link syntax, not markdown', () => {
      const json = JSON.stringify(slackMessage(event(), ctx))
      expect(json).toContain('<https://app.syncrese.test/invoices/')
      expect(json).not.toContain('](http')
    })

    it('escapes the three mrkdwn control characters and nothing else', () => {
      const json = JSON.stringify(
        slackMessage(event({ payload: { invoiceNo: 'A<b>&c' } }), {
          ...ctx,
          organizationName: 'Smith & Sons',
        }),
      )
      expect(json).toContain('A&lt;b&gt;&amp;c')
      expect(json).toContain('Smith &amp; Sons')
    })
  })

  describe('Teams', () => {
    it('uses the Adaptive Card envelope Workflows expects', () => {
      const body = teamsMessage(event(), ctx) as {
        type: string
        attachments: { contentType: string; contentUrl: unknown; content: Record<string, unknown> }[]
      }
      // NOT the retired MessageCard shape — that posts 200 OK and renders an
      // empty card, which is the worst possible failure mode.
      expect(body.type).toBe('message')
      expect(body.attachments[0]!.contentType).toBe(
        'application/vnd.microsoft.card.adaptive',
      )
      expect(body.attachments[0]!.contentUrl).toBeNull()
      expect(body.attachments[0]!.content.type).toBe('AdaptiveCard')
      expect(body.attachments[0]!.content.$schema).toBeTruthy()
      expect(body.attachments[0]!.content.version).toBeTruthy()
      expect(JSON.stringify(body)).not.toContain('MessageCard')
    })

    it('adds an action only when there is somewhere to go', () => {
      const withLink = teamsMessage(event(), ctx) as { attachments: { content: { actions?: [] } }[] }
      expect(withLink.attachments[0]!.content.actions).toHaveLength(1)

      const without = teamsMessage(event(), { ...ctx, appUrl: null }) as {
        attachments: { content: { actions?: [] } }[]
      }
      expect(without.attachments[0]!.content.actions).toBeUndefined()
    })
  })

  it('labels the timestamp as UTC', () => {
    // An integration has no user and therefore no timezone. An unlabelled time
    // rendered in the server's zone reads as the reader's.
    expect(JSON.stringify(slackMessage(event(), ctx))).toContain('2026-03-04 09:15 UTC')
  })
})
