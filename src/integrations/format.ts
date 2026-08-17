import { formatMoney } from '@/finance/money'

/**
 * Slack and Teams message bodies (MUST DO #14).
 *
 * Pure. No network, no database, no clock — an event and an organization name
 * in, a JSON body out. That is what makes the payload shapes testable against
 * what the two vendors actually accept.
 *
 * NOTHING IS INVENTED HERE.
 *
 * Every number and name in a message comes out of the stored event payload, and
 * a field that is absent is omitted rather than guessed or defaulted. The
 * temptation is small and specific: an amount arrives without a currency, and
 * "1,240.00" reads fine. It is also wrong, silently, for any tenant not billing
 * in the currency the reader assumed. So an amount without a currency is not
 * rendered as money at all. The same rule the AI assistant works under.
 */

/** What the delivery step hands to a formatter. Deliberately the shape of a row
 *  from the outbox, so nothing has to be assembled on the way in. */
export type ChatEvent = {
  id: string
  type: string
  entityType: string
  entityId: string | null
  payload: Record<string, unknown>
  occurredAt: string | Date
}

export type ChatContext = {
  /** Shown as the message footer so a channel receiving several workspaces'
   *  notifications can tell them apart. */
  organizationName: string
  /** Absolute base URL, e.g. https://app.example.com. Omitted if not
   *  configured — a relative link is useless in a chat client, and a link to
   *  the wrong host is worse than none. */
  appUrl?: string | null
}

/** Human titles. An event type not listed still sends, under its raw type —
 *  a missing entry should degrade to something plain, not drop the message. */
const TITLES: Record<string, string> = {
  'invoice.created': 'Invoice created',
  'invoice.issued': 'Invoice issued',
  'invoice.paid': 'Invoice paid',
  'invoice.overdue': 'Invoice overdue',
  'creditnote.issued': 'Credit note issued',
  'payment.recorded': 'Payment recorded',
  'sales_order.created': 'Sales order created',
  'sales_order.confirmed': 'Sales order confirmed',
  'sales_order.delivered': 'Sales order delivered',
  'purchase_order.created': 'Purchase order created',
  'purchase_order.approved': 'Purchase order approved',
  'goods_receipt.posted': 'Goods received',
  'deal.won': 'Deal won',
  'deal.lost': 'Deal lost',
  'partner.created': 'Contact added',
  'product.low_stock': 'Low stock',
  // Not in the outbox catalogue — only ever sent by the "Send test message"
  // button, so that a customer finds out the URL works here rather than the
  // next time an invoice is issued.
  'integration.test': 'Syncrèse test message',
}

export const titleFor = (type: string): string => TITLES[type] ?? type

/**
 * Where the entity lives in the app.
 *
 * Keyed on `entityType` rather than event type, because both halves of
 * "invoice.created" and "invoice.paid" point at the same page. An unmapped
 * entity type yields no link rather than a guessed URL that 404s.
 */
const PATHS: Record<string, string> = {
  invoice: '/invoices',
  credit_note: '/invoices',
  payment: '/payments',
  sales_order: '/sales-orders',
  purchase_order: '/purchase-orders',
  goods_receipt: '/goods-receipts',
  deal: '/crm',
  partner: '/partners',
  product: '/products',
}

export function linkFor(event: ChatEvent, ctx: ChatContext): string | null {
  if (!ctx.appUrl) return null
  const path = PATHS[event.entityType]
  if (!path || !event.entityId) return null
  return `${ctx.appUrl.replace(/\/+$/, '')}${path}/${encodeURIComponent(event.entityId)}`
}

// --- payload reading --------------------------------------------------------
// Payloads are written by a dozen call sites and are not a closed shape. Each
// reader returns undefined rather than coercing, so a field that is missing or
// the wrong type produces a shorter message instead of "undefined" or "NaN"
// appearing in a customer's Slack channel.

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  // bigint columns arrive as strings over the wire often enough to be worth
  // handling — but only when the whole string is a number.
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) {
    const n = Number(v.trim())
    return Number.isSafeInteger(n) ? n : undefined
  }
  return undefined
}

/** A reference number, whatever this kind of document calls it. */
export function referenceOf(payload: Record<string, unknown>): string | undefined {
  return (
    str(payload.invoiceNo) ??
    str(payload.creditNoteNo) ??
    str(payload.paymentNo) ??
    str(payload.orderNo) ??
    str(payload.poNo) ??
    str(payload.soNo) ??
    str(payload.receiptNo) ??
    str(payload.number) ??
    str(payload.sku) ??
    str(payload.name)
  )
}

/**
 * Money, or nothing.
 *
 * Both halves required. `formatMoney` would happily be given a default
 * currency, and every message would then be right for most tenants and quietly
 * wrong for the rest — the failure mode this product cannot afford.
 */
export function moneyOf(payload: Record<string, unknown>): string | undefined {
  const currency = str(payload.currencyCode) ?? str(payload.currency)
  if (!currency) return undefined
  const amount =
    num(payload.totalMinor) ?? num(payload.amountMinor) ?? num(payload.valueMinor)
  if (amount === undefined) return undefined
  try {
    return formatMoney(amount, currency)
  } catch {
    // Intl throws on a currency code it does not recognise. A malformed code in
    // a payload should cost the message one line, not the whole delivery.
    return undefined
  }
}

/** The one-line summary both products share. */
export function summaryOf(event: ChatEvent): string {
  const parts = [referenceOf(event.payload), moneyOf(event.payload)].filter(Boolean)
  // Low stock reads as a quantity, not an amount.
  const qty = num(event.payload.quantityOnHand)
  if (event.type === 'product.low_stock' && qty !== undefined) {
    parts.push(`${qty} on hand`)
  }
  const partner = str(event.payload.partnerName) ?? str(event.payload.customerName)
  if (partner) parts.push(partner)
  return parts.join(' · ')
}

// --- Slack ------------------------------------------------------------------

/**
 * Slack incoming webhook body.
 *
 * `text` is set as well as `blocks` — it is what Slack shows in the
 * notification preview and in clients that do not render Block Kit, and a body
 * with blocks but no text produces a silent, contentless push notification.
 */
export function slackMessage(event: ChatEvent, ctx: ChatContext): Record<string, unknown> {
  const title = titleFor(event.type)
  const summary = summaryOf(event)
  const link = linkFor(event, ctx)
  const text = summary ? `${title} — ${summary}` : title

  const blocks: Record<string, unknown>[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Slack's mrkdwn link syntax is <url|label>, not markdown's [label](url).
        text: link ? `*<${link}|${escapeSlack(text)}>*` : `*${escapeSlack(text)}*`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${escapeSlack(ctx.organizationName)} · ${formatWhen(event.occurredAt)}`,
        },
      ],
    },
  ]

  return { text, blocks }
}

/**
 * Slack treats `&`, `<` and `>` as control characters in mrkdwn, and nothing
 * else. Escaping more than these three mangles ordinary text — an organization
 * called "Smith & Sons" is common, one with a literal `*` in its name is not.
 */
function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// --- Microsoft Teams --------------------------------------------------------

/**
 * Teams body, as an Adaptive Card inside a `message` attachment.
 *
 * NOT the old MessageCard / `@type: MessageCard` shape. Microsoft retired
 * Office 365 connectors, and the incoming-webhook URL a customer creates today
 * comes from Power Automate ("Workflows"), whose Teams action expects this
 * envelope. The older format posts successfully and renders as an empty card.
 *
 * `contentUrl: null` and the `$schema`/`version` pair are required by the Teams
 * renderer; it rejects the attachment without them.
 */
export function teamsMessage(event: ChatEvent, ctx: ChatContext): Record<string, unknown> {
  const title = titleFor(event.type)
  const summary = summaryOf(event)
  const link = linkFor(event, ctx)

  const body: Record<string, unknown>[] = [
    { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
  ]
  if (summary) {
    body.push({ type: 'TextBlock', text: summary, wrap: true, spacing: 'Small' })
  }
  body.push({
    type: 'TextBlock',
    text: `${ctx.organizationName} · ${formatWhen(event.occurredAt)}`,
    wrap: true,
    isSubtle: true,
    size: 'Small',
    spacing: 'Small',
  })

  const card: Record<string, unknown> = {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
  }
  if (link) {
    card.actions = [{ type: 'Action.OpenUrl', title: 'Open in Syncrèse', url: link }]
  }

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: card,
      },
    ],
  }
}

// --- shared -----------------------------------------------------------------

/** UTC, explicitly labelled. An integration has no user and therefore no
 *  timezone; a bare local time would be rendered in the server's zone and read
 *  as the reader's. */
function formatWhen(when: string | Date): string {
  const d = when instanceof Date ? when : new Date(when)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function messageFor(
  kind: 'slack' | 'teams',
  event: ChatEvent,
  ctx: ChatContext,
): Record<string, unknown> {
  return kind === 'slack' ? slackMessage(event, ctx) : teamsMessage(event, ctx)
}
