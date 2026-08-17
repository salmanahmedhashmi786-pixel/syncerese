'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Badge, chipButtonStyle, inputStyle, panelStyle, primaryButtonStyle } from '@/components/ui/primitives'
import { useToast } from '@/components/shell/Toaster'
import {
  retentionOverviewAction,
  runRetentionNowAction,
  setRetentionPolicyAction,
} from '@/app/actions/retention'
import type { PolicyView } from '@/gdpr/retention'

/**
 * Data retention (GDPR Art. 5(1)(e)).
 *
 * The one part of the privacy tooling that destroys data by working correctly,
 * so the panel is built to be read before it is used: every category is off
 * until switched on, each shows how many rows would go if a sweep ran now, and
 * the number is visible BEFORE the switch, not after.
 *
 * It also states plainly what this cannot reach. Somebody arriving here to
 * satisfy an auditor needs to know that invoices and the audit trail are
 * excluded by design, and to be able to say why.
 */
export function RetentionPanel({ canManage }: { canManage: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [policies, setPolicies] = useState<PolicyView[] | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!canManage) return
    void retentionOverviewAction().then((r) => {
      if (r.ok) setPolicies(r.data)
    })
  }, [canManage])

  if (!canManage) return null

  const reload = () =>
    retentionOverviewAction().then((r) => {
      if (r.ok) setPolicies(r.data)
    })

  const save = (category: string, retainDays: number | null, legalHold?: boolean) =>
    startTransition(async () => {
      const result = await setRetentionPolicyAction({ category, retainDays, legalHold })
      if (result.ok) {
        await reload()
        router.refresh()
      } else {
        toast(result.error, 'err')
      }
    })

  const runNow = () =>
    startTransition(async () => {
      const result = await runRetentionNowAction()
      if (result.ok) {
        const removed = result.data.reduce((n, r) => n + r.removed, 0)
        toast(removed === 0 ? 'Nothing was old enough to remove' : `Removed ${removed} record(s)`)
        await reload()
        router.refresh()
      } else {
        toast(result.error, 'err')
      }
    })

  const anyConfigured = policies?.some((p) => p.retainDays !== null) ?? false

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>Data retention</div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 6, lineHeight: 1.55 }}>
        Storage limitation: keep personal data no longer than you need it. Everything that
        holds your own records is off until you switch it on, and nothing is removed until
        the number below says it would be. The one exception is marked <em>Default</em>: the
        event outbox is our dispatch queue rather than your data, and it clears itself.
      </div>
      <div
        style={{
          fontSize: 11.5,
          color: 'var(--mut)',
          lineHeight: 1.6,
          padding: '9px 11px',
          borderRadius: 6,
          background: 'var(--bg2)',
          marginBottom: 16,
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>What this can never remove:</strong> invoices,
        journal entries, payments, customers, products or the audit trail. Statutory
        accounting retention — ten years under §147 AO, with an equivalent in every EU member
        state — overrides an erasure request, and GDPR Art. 17(3)(b) says so explicitly. Those
        records are not on the list this job works from, and no setting adds them.
      </div>

      {policies === null && (
        <div style={{ color: 'var(--mut)', fontSize: 12 }}>Loading…</div>
      )}

      {policies?.map((p) => {
        const value = draft[p.category] ?? (p.retainDays === null ? '' : String(p.retainDays))
        return (
          <div
            key={p.category}
            style={{ padding: '12px 0', borderBottom: '1px solid var(--bd)', fontSize: 12.5 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
              <span style={{ fontWeight: 600 }}>{p.label}</span>
              {p.retainDays === null ? (
                <Badge color="var(--mut)">Off</Badge>
              ) : (
                <Badge color="var(--pos)">{p.retainDays} days</Badge>
              )}
              {p.isDefault && <Badge color="var(--mut)">Default</Badge>}
              {p.legalHold && <Badge color="var(--warn)">Legal hold</Badge>}
              {p.dueNow !== null && p.dueNow > 0 && !p.legalHold && (
                <Badge color="var(--warn)">{p.dueNow} due to go</Badge>
              )}
            </div>
            <div style={{ color: 'var(--mut)', fontSize: 11.5, lineHeight: 1.5, marginBottom: 8 }}>
              {p.description}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <input
                type="number"
                min={p.minimumDays}
                placeholder={`min ${p.minimumDays}`}
                value={value}
                onChange={(e) => setDraft((d) => ({ ...d, [p.category]: e.target.value }))}
                style={{ ...inputStyle, width: 90 }}
              />
              <span style={{ color: 'var(--mut)', fontSize: 11.5 }}>days</span>
              <button
                type="button"
                disabled={pending}
                onClick={() => save(p.category, value.trim() === '' ? null : Number(value))}
                style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
              >
                Save
              </button>
              {p.retainDays !== null && (
                <>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setDraft((d) => ({ ...d, [p.category]: '' }))
                      save(p.category, null)
                    }}
                    style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
                  >
                    Turn off
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => save(p.category, p.retainDays, !p.legalHold)}
                    style={{
                      ...chipButtonStyle,
                      fontFamily: 'inherit',
                      color: p.legalHold ? 'var(--warn)' : undefined,
                    }}
                  >
                    {p.legalHold ? 'Lift legal hold' : 'Legal hold'}
                  </button>
                </>
              )}
              <span style={{ color: 'var(--mut)', fontSize: 11 }}>
                suggested {p.suggestedDays}
              </span>
            </div>

            {p.legalHold && (
              <div style={{ color: 'var(--warn)', fontSize: 11, marginTop: 6 }}>
                Paused. Litigation, a tax audit or an investigation imposes a duty to preserve
                that outranks retention. The setting is kept — lifting the hold resumes it.
                {p.legalHoldNote ? ` (${p.legalHoldNote})` : ''}
              </div>
            )}
            {p.lastSweptAt && (
              <div style={{ color: 'var(--mut)', fontSize: 11, marginTop: 6 }}>
                Last run {new Date(p.lastSweptAt).toLocaleDateString()} · removed{' '}
                {p.lastRemoved ?? 0}
              </div>
            )}
          </div>
        )
      })}

      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={runNow}
          disabled={pending || !anyConfigured}
          style={{ ...primaryButtonStyle, fontFamily: 'inherit', opacity: anyConfigured ? 1 : 0.5 }}
        >
          {pending ? 'Running…' : 'Run now'}
        </button>
        <span style={{ color: 'var(--mut)', fontSize: 11.5 }}>
          Otherwise this runs once a day. Every run is written to the audit trail, including
          the ones that removed nothing.
        </span>
      </div>
    </section>
  )
}
