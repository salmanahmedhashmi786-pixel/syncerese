'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, chipButtonStyle, inputStyle, panelStyle, primaryButtonStyle } from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import { activateKeyAction, openBillingPortalAction, startCheckoutAction } from '@/app/actions/billing'
import { isWellFormed } from '@/licensing/key-format'
import type { BillingState } from '@/billing/service'

/**
 * Plan, seats and renewal.
 *
 * Everything money-related happens at Stripe: this panel only ever sends the
 * customer there. No card field, no amount, no price — which is what keeps the
 * PCI surface out of this application entirely and lets the desktop app consume
 * a licence without ever being a payment terminal.
 */

export type PlanOption = {
  key: string
  name: string
  tagline: string
  minSeats: number
  maxSeats: number | null
  features: string[]
  /** From Stripe, never hard-coded. Null when the price could not be read. */
  price: { amountMinor: number; currencyCode: string; interval: string } | null
}

const STATUS_COLOR: Record<string, string> = {
  trial: '#b45309',
  active: '#0d9488',
  past_due: '#dc2626',
  suspended: '#dc2626',
  cancelled: '#6b7382',
}

const STATUS_LABEL: Record<string, string> = {
  trial: 'Trial',
  active: 'Active',
  past_due: 'Payment failed',
  suspended: 'Suspended',
  cancelled: 'Cancelled',
}

function formatPrice(price: PlanOption['price']): string {
  if (!price) return '—'
  const amount = (price.amountMinor / 100).toLocaleString(undefined, {
    style: 'currency',
    currency: price.currencyCode,
    maximumFractionDigits: price.amountMinor % 100 === 0 ? 0 : 2,
  })
  return `${amount} per seat / ${price.interval}`
}

export function BillingPanel({
  state,
  plans,
  canManage,
}: {
  state: BillingState
  plans: PlanOption[]
  canManage: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [seats, setSeats] = useState(String(Math.max(state.seats, state.seatsInUse)))
  const [choosing, setChoosing] = useState<string | null>(null)
  const [productKey, setProductKey] = useState('')

  const redeem = () =>
    startTransition(async () => {
      const result = await activateKeyAction(productKey)
      if (result.ok && result.data) {
        setProductKey('')
        toast(
          `Licensed for ${result.data.durationDays} more days — until ` +
            new Date(result.data.validUntil).toLocaleDateString(),
        )
        router.refresh()
      } else if (!result.ok) {
        toast(result.error, 'err')
      }
    })

  const go = (fn: () => Promise<{ ok: boolean; data?: { url: string }; error?: string }>) =>
    startTransition(async () => {
      const result = await fn()
      if (result.ok && result.data?.url) {
        // A full navigation, not a router push: Stripe is a different origin.
        window.location.href = result.data.url
      } else {
        toast(result.error ?? 'Something went wrong.', 'err')
      }
    })

  const renews = state.currentPeriodEnd ?? state.validUntil

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Plan &amp; billing</div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16 }}>
        Payment, invoices and cancellation are handled by Stripe. Card details never touch
        Syncrèse.
      </div>

      {/* --- current state ------------------------------------------------ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
          border: '1px solid var(--bd)',
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, textTransform: 'capitalize' }}>
            {state.plan}{' '}
            <Badge color={STATUS_COLOR[state.status] ?? '#6b7382'}>
              {STATUS_LABEL[state.status] ?? state.status}
            </Badge>
          </div>
          <div style={{ color: 'var(--mut)', fontSize: 11.5, marginTop: 3 }}>
            {state.seatsInUse} of {state.seats} seats in use
            {renews &&
              ` · ${state.cancelAtPeriodEnd ? 'ends' : 'renews'} ${new Date(renews).toLocaleDateString()}`}
          </div>
        </div>

        {canManage && state.hasSubscription && state.configured && (
          <button
            type="button"
            disabled={pending}
            onClick={() => go(openBillingPortalAction)}
            style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
          >
            Manage billing
          </button>
        )}
      </div>

      {state.cancelAtPeriodEnd && renews && (
        <div style={{ color: '#b45309', fontSize: 11.5, marginBottom: 14 }}>
          This subscription is set to end on {new Date(renews).toLocaleDateString()}. You keep full
          access until then.
        </div>
      )}

      {/* --- product key ---------------------------------------------------- */}
      {canManage && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ ...labelStyle, marginBottom: 6 }}>HAVE A PRODUCT KEY?</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={productKey}
              onChange={(e) => setProductKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && redeem()}
              placeholder="SYNC-XXXXX-XXXXX-XXXXX-XXXXX"
              style={{
                ...inputStyle,
                flex: 1,
                fontFamily: 'var(--font-mono), monospace',
                letterSpacing: '.06em',
                // A key that fails its own check character is a typo, and
                // saying so before the round trip is the point of having one.
                borderColor:
                  productKey.trim().length > 8 && !isWellFormed(productKey)
                    ? '#b45309'
                    : 'var(--bd)',
              }}
            />
            <button
              type="button"
              disabled={pending || !isWellFormed(productKey)}
              onClick={redeem}
              style={{
                ...chipButtonStyle,
                fontFamily: 'inherit',
                opacity: pending || !isWellFormed(productKey) ? 0.5 : 1,
              }}
            >
              Activate
            </button>
          </div>
          <div style={{ color: 'var(--mut)', fontSize: 10.5, marginTop: 5 }}>
            {productKey.trim().length > 8 && !isWellFormed(productKey)
              ? 'That key does not check out — look for a mistyped or swapped character.'
              : 'Extends your licence from whichever is later: today, or your current expiry.'}
          </div>
        </div>
      )}

      {/* --- not configured ------------------------------------------------ */}
      {!state.configured ? (
        <div style={{ fontSize: 12.5, color: 'var(--mut)', lineHeight: 1.55 }}>
          Billing is not configured on this deployment — no Stripe keys are set, so there are no
          plans to buy. Self-hosted installations normally run without it. See{' '}
          <code>docs/05-billing.md</code>.
        </div>
      ) : !canManage ? (
        <div style={{ fontSize: 12.5, color: 'var(--mut)' }}>
          Only an owner or admin can change the plan.
        </div>
      ) : (
        <>
          <div style={{ ...labelStyle, marginBottom: 9 }}>
            {state.hasSubscription ? 'CHANGE PLAN' : 'CHOOSE A PLAN'}
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {plans.map((p) => {
              const selected = choosing === p.key
              const isCurrent = state.plan === p.key && state.hasSubscription
              return (
                <div
                  key={p.key}
                  style={{
                    border: `1px solid ${selected ? 'var(--ac)' : 'var(--bd)'}`,
                    background: selected ? 'var(--acs)' : 'transparent',
                    borderRadius: 8,
                    padding: '12px 14px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                    {isCurrent && <Badge color="#0d9488">current</Badge>}
                    <div style={{ flex: 1 }} />
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{formatPrice(p.price)}</div>
                  </div>
                  <div style={{ color: 'var(--mut)', fontSize: 11.5, marginTop: 3 }}>
                    {p.tagline}
                  </div>

                  <ul
                    style={{
                      margin: '8px 0 0',
                      paddingLeft: 16,
                      color: 'var(--mut)',
                      fontSize: 11.5,
                      lineHeight: 1.6,
                    }}
                  >
                    {p.features.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>

                  {selected ? (
                    <div style={{ display: 'flex', gap: 8, marginTop: 11, alignItems: 'center' }}>
                      <label style={{ ...labelStyle, alignSelf: 'center' }}>SEATS</label>
                      <input
                        type="number"
                        min={Math.max(p.minSeats, state.seatsInUse)}
                        max={p.maxSeats ?? undefined}
                        value={seats}
                        onChange={(e) => setSeats(e.target.value)}
                        style={{ ...inputStyle, width: 90 }}
                      />
                      <div style={{ color: 'var(--mut)', fontSize: 10.5, flex: 1 }}>
                        {/* Stated rather than silently corrected — a number that
                            changes itself after you type it reads as a bug. */}
                        Minimum {Math.max(p.minSeats, state.seatsInUse)}
                        {state.seatsInUse > p.minSeats ? ' — you have that many people' : ''}.
                      </div>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          go(() =>
                            startCheckoutAction({ planKey: p.key, seats: Number(seats) || p.minSeats }),
                          )
                        }
                        style={{ ...primaryButtonStyle, fontFamily: 'inherit', opacity: pending ? 0.6 : 1 }}
                      >
                        {pending ? 'Opening Stripe…' : 'Continue to payment'}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setChoosing(p.key)
                        setSeats(String(Math.max(p.minSeats, state.seatsInUse, state.seats)))
                      }}
                      style={{ ...chipButtonStyle, fontFamily: 'inherit', marginTop: 11 }}
                    >
                      {isCurrent ? 'Change seats' : `Choose ${p.name}`}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}

const labelStyle: React.CSSProperties = {
  font: '500 9.5px var(--font-mono), monospace',
  letterSpacing: '.07em',
  color: 'var(--mut)',
}
