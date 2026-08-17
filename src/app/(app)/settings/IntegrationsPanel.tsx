'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  chipButtonStyle,
  inputStyle,
  panelStyle,
  primaryButtonStyle,
} from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import {
  createIntegrationAction,
  deleteIntegrationAction,
  testIntegrationAction,
  updateIntegrationAction,
} from '@/app/actions/integrations'
import type { ChatIntegrationSummary } from '@/integrations/chat'

/**
 * Slack and Microsoft Teams notifications.
 *
 * The panel's real job is the twenty seconds before the paste: somebody who has
 * never made an incoming webhook needs to know where to click in their own
 * workspace. So the instructions are inline and specific to the product they
 * picked, rather than a link to documentation they will not open.
 */

const EVENT_GROUPS: { label: string; events: { type: string; label: string }[] }[] = [
  {
    label: 'Finance',
    events: [
      { type: 'invoice.issued', label: 'Invoice issued' },
      { type: 'invoice.paid', label: 'Invoice paid' },
      { type: 'creditnote.issued', label: 'Credit note issued' },
      { type: 'payment.recorded', label: 'Payment recorded' },
    ],
  },
  {
    label: 'Sales',
    events: [
      { type: 'sales_order.created', label: 'Sales order created' },
      { type: 'sales_order.confirmed', label: 'Sales order confirmed' },
      { type: 'sales_order.delivered', label: 'Sales order delivered' },
      { type: 'deal.won', label: 'Deal won' },
      { type: 'deal.lost', label: 'Deal lost' },
    ],
  },
  {
    label: 'Purchasing & stock',
    events: [
      { type: 'purchase_order.created', label: 'Purchase order created' },
      { type: 'purchase_order.approved', label: 'Purchase order approved' },
      { type: 'goods_receipt.posted', label: 'Goods received' },
      { type: 'product.low_stock', label: 'Low stock' },
    ],
  },
]

const HOW_TO: Record<'slack' | 'teams', { where: string; hint: string }> = {
  slack: {
    where: 'api.slack.com/apps → your app → Incoming Webhooks → Add New Webhook to Workspace',
    hint: 'The URL starts with https://hooks.slack.com/services/',
  },
  teams: {
    where: 'Teams → the channel → Workflows → "Post to a channel when a webhook request is received"',
    hint: 'The URL is on logic.azure.com. Retired Office 365 connector URLs (webhook.office.com) are still accepted.',
  },
}

export function IntegrationsPanel({
  canManage,
  integrations,
}: {
  canManage: boolean
  integrations: ChatIntegrationSummary[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<'slack' | 'teams'>('slack')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [selected, setSelected] = useState<string[]>(['invoice.paid'])

  if (!canManage) {
    return (
      <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Slack &amp; Teams</div>
        <div style={{ color: 'var(--mut)', fontSize: 12 }}>
          Only an owner or admin can connect a chat workspace.
        </div>
      </section>
    )
  }

  const reset = () => {
    setAdding(false)
    setName('')
    setUrl('')
    setSelected(['invoice.paid'])
  }

  const submit = () =>
    startTransition(async () => {
      const result = await createIntegrationAction({ kind, name, url, events: selected })
      if (result.ok) {
        reset()
        toast('Connected. Send a test message to check it.')
        router.refresh()
      } else {
        // The allowlist message names the host it rejected, which is the only
        // way somebody who pasted the wrong thing can tell what went wrong.
        toast(result.error, 'err')
      }
    })

  const act = (label: string, run: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const result = await run()
      if (result.ok) {
        toast(label)
        router.refresh()
      } else {
        toast(result.error ?? 'Something went wrong.', 'err')
      }
    })

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Slack &amp; Teams</div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16, lineHeight: 1.55 }}>
        Post events into a channel. Messages carry only what the event recorded — an amount
        appears with its currency or not at all.
      </div>

      {integrations.length === 0 && !adding && (
        <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 14 }}>
          No channels connected yet.
        </div>
      )}

      {integrations.map((i) => (
        <div
          key={i.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '11px 0',
            borderBottom: '1px solid var(--bd)',
            fontSize: 12.5,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontWeight: 600 }}>{i.name}</span>
              {/* Brand-adjacent rather than brand-exact: Slack's own #4a154b is
                  so dark it disappears against a dark panel. The badge's job is
                  to tell the two apart, and it has to do that in both themes. */}
              <Badge color={i.kind === 'slack' ? '#8b5cf6' : '#5b5fc7'}>
                {i.kind === 'slack' ? 'Slack' : 'Teams'}
              </Badge>
              {!i.enabled && <Badge color="var(--neg)">Off</Badge>}
              {i.enabled && i.failureCount > 0 && (
                <Badge color="var(--warn)">{i.failureCount} failed</Badge>
              )}
            </div>
            <div style={{ color: 'var(--mut)', fontSize: 11, marginTop: 3 }}>
              {/* The hint, never the URL — anyone holding it can post into this
                  channel as though they were us. */}
              {i.urlHint} ·{' '}
              {i.events.includes('*')
                ? 'all events'
                : `${i.events.length} event type${i.events.length === 1 ? '' : 's'}`}
              {i.lastSuccessAt && ` · last sent ${new Date(i.lastSuccessAt).toLocaleDateString()}`}
            </div>
            {i.lastError && !i.enabled && (
              <div style={{ color: 'var(--neg)', fontSize: 11, marginTop: 3 }}>{i.lastError}</div>
            )}
          </div>

          <button
            type="button"
            disabled={pending}
            onClick={() => act('Test message sent', () => testIntegrationAction(i.id))}
            style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
          >
            Test
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              act(i.enabled ? 'Paused' : 'Resumed', () =>
                updateIntegrationAction(i.id, { enabled: !i.enabled }),
              )
            }
            style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
          >
            {i.enabled ? 'Pause' : 'Resume'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => act('Removed', () => deleteIntegrationAction(i.id))}
            style={{ ...chipButtonStyle, fontFamily: 'inherit', color: 'var(--neg)' }}
          >
            Remove
          </button>
        </div>
      ))}

      {!adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          style={{ ...primaryButtonStyle, marginTop: 14, fontFamily: 'inherit' }}
        >
          Connect a channel
        </button>
      ) : (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {(['slack', 'teams'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                style={{
                  ...chipButtonStyle,
                  fontFamily: 'inherit',
                  borderColor: kind === k ? 'var(--acc)' : undefined,
                  color: kind === k ? 'var(--acc)' : undefined,
                }}
              >
                {k === 'slack' ? 'Slack' : 'Microsoft Teams'}
              </button>
            ))}
          </div>

          <div
            style={{
              fontSize: 11.5,
              color: 'var(--mut)',
              lineHeight: 1.6,
              padding: '10px 12px',
              borderRadius: 6,
              background: 'var(--bg2)',
              marginBottom: 12,
            }}
          >
            <strong style={{ color: 'var(--fg)' }}>Where to get the URL:</strong>{' '}
            {HOW_TO[kind].where}
            <br />
            {HOW_TO[kind].hint}
          </div>

          <input
            placeholder="Name it — #finance, Ops channel"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ ...inputStyle, width: '100%', marginBottom: 8 }}
          />
          <input
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ ...inputStyle, width: '100%', marginBottom: 14, fontFamily: 'var(--font-mono), monospace', fontSize: 11.5 }}
          />

          <div style={labelStyle}>POST WHICH EVENTS</div>
          <div style={{ marginTop: 8, marginBottom: 14 }}>
            {EVENT_GROUPS.map((group) => (
              <div key={group.label} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--mut)', marginBottom: 5 }}>
                  {group.label}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {group.events.map((e) => {
                    const on = selected.includes(e.type)
                    return (
                      <button
                        key={e.type}
                        type="button"
                        onClick={() =>
                          setSelected((prev) =>
                            on ? prev.filter((t) => t !== e.type) : [...prev, e.type],
                          )
                        }
                        style={{
                          ...chipButtonStyle,
                          fontFamily: 'inherit',
                          fontSize: 11.5,
                          borderColor: on ? 'var(--acc)' : undefined,
                          color: on ? 'var(--acc)' : undefined,
                        }}
                      >
                        {e.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={submit}
              disabled={pending || name.trim() === '' || url.trim() === '' || selected.length === 0}
              style={{ ...primaryButtonStyle, fontFamily: 'inherit' }}
            >
              {pending ? 'Connecting…' : 'Connect'}
            </button>
            <button
              type="button"
              onClick={reset}
              style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

const labelStyle = {
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
} as const
