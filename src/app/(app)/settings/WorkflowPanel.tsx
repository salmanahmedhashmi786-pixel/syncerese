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
import { addWorkflowRule, deleteWorkflowRule, setRuleActive } from '@/app/actions/admin'

export type WorkflowRuleRow = {
  id: string
  name: string
  isActive: boolean
  triggerType: string
  triggerConfig: Record<string, unknown>
  conditions: unknown[]
  actions: { type: string }[]
  runCount: number
  lastRunAt: string | null
}

const TRIGGERS = [
  { value: 'record.created', label: 'When a record is created' },
  { value: 'field.changed', label: 'When a field changes' },
  { value: 'invoice.overdue', label: 'When an invoice becomes overdue' },
]

const ENTITIES = ['invoice', 'deal', 'sales_order', 'purchase_order', 'business_partner', 'product']

const ACTIONS = [
  { value: 'activity.create', label: 'Create a note or task' },
  { value: 'notify.user', label: 'Notify a user' },
  { value: 'record.tag', label: 'Tag the record' },
  { value: 'record.set_field', label: 'Set a custom field' },
  { value: 'webhook.send', label: 'Send a webhook' },
]

/**
 * Trigger → condition → action, kept deliberately flat.
 *
 * No branches, no loops, no wait states — an explicit AVOID in the brief. This
 * covers the automations SMEs actually ask for without becoming a workflow
 * product in its own right.
 */
export function WorkflowPanel({
  rules,
  canManage,
}: {
  rules: WorkflowRuleRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [adding, setAdding] = useState(false)

  const [name, setName] = useState('')
  const [triggerType, setTriggerType] = useState('record.created')
  const [entityType, setEntityType] = useState('invoice')
  const [field, setField] = useState('status')
  const [to, setTo] = useState('')
  const [daysOverdue, setDaysOverdue] = useState('7')
  const [actionType, setActionType] = useState('activity.create')
  const [subject, setSubject] = useState('')
  const [tag, setTag] = useState('')

  const submit = () => {
    if (!name.trim()) {
      toast('Give the rule a name', 'err')
      return
    }

    const triggerConfig: Record<string, unknown> =
      triggerType === 'invoice.overdue'
        ? { daysOverdue: Number(daysOverdue) || 7 }
        : triggerType === 'field.changed'
          ? { entityType, field, ...(to ? { to } : {}) }
          : { entityType }

    const config: Record<string, unknown> =
      actionType === 'record.tag'
        ? { tag: tag.trim() }
        : actionType === 'webhook.send'
          ? { url: subject.trim() }
          : { subject: subject.trim() || name.trim() }

    startTransition(async () => {
      const result = await addWorkflowRule({
        name: name.trim(),
        triggerType,
        triggerConfig,
        conditions: [],
        actions: [{ type: actionType, config }],
      })
      if (result.ok) {
        toast(`Rule "${name.trim()}" created`)
        setName('')
        setSubject('')
        setTag('')
        setAdding(false)
        router.refresh()
      } else {
        toast(result.error, 'err')
      }
    })
  }

  const toggle = (rule: WorkflowRuleRow) => {
    startTransition(async () => {
      const result = await setRuleActive(rule.id, !rule.isActive)
      if (result.ok) {
        toast(`"${rule.name}" ${rule.isActive ? 'paused' : 'activated'}`)
        router.refresh()
      } else toast(result.error, 'err')
    })
  }

  const remove = (rule: WorkflowRuleRow) => {
    startTransition(async () => {
      const result = await deleteWorkflowRule(rule.id)
      if (result.ok) {
        toast(`"${rule.name}" deleted`, 'warn')
        router.refresh()
      } else toast(result.error, 'err')
    })
  }

  return (
    <section style={{ ...panelStyle, padding: '18px 20px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 3 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Automation rules</div>
        <div style={{ flex: 1 }} />
        {canManage && (
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
          >
            {adding ? 'Cancel' : '+ New rule'}
          </button>
        )}
      </div>
      <div style={{ color: 'var(--mut)', fontSize: 12, marginBottom: 16 }}>
        Trigger, then action. Every run is logged — including the ones that were skipped —
        so you can always answer &ldquo;why did that happen?&rdquo;
      </div>

      {rules.length === 0 && !adding && (
        <p style={{ fontSize: 12, color: 'var(--mut)' }}>No rules yet.</p>
      )}

      {rules.map((r) => (
        <div
          key={r.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '9px 0',
            borderBottom: '1px solid var(--bd)',
            fontSize: 12.5,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 500 }}>{r.name}</div>
            <div
              style={{
                font: '400 10.5px var(--font-mono), monospace',
                color: 'var(--mut)',
                marginTop: 2,
              }}
            >
              {r.triggerType}
              {r.triggerConfig?.entityType ? ` · ${r.triggerConfig.entityType}` : ''}
              {r.triggerConfig?.daysOverdue !== undefined
                ? ` · ${r.triggerConfig.daysOverdue} days`
                : ''}
              {' → '}
              {r.actions.map((a) => a.type).join(', ')}
            </div>
          </div>
          <span
            style={{ font: '400 10.5px var(--font-mono), monospace', color: 'var(--mut)' }}
          >
            {r.runCount} run{r.runCount === 1 ? '' : 's'}
          </span>
          <Badge color={r.isActive ? '#0d9488' : '#64748b'}>
            {r.isActive ? 'Active' : 'Paused'}
          </Badge>
          {canManage && (
            <>
              <button
                type="button"
                onClick={() => toggle(r)}
                disabled={pending}
                style={{ ...chipButtonStyle, height: 22, fontFamily: 'inherit' }}
              >
                {r.isActive ? 'Pause' : 'Activate'}
              </button>
              <button
                type="button"
                onClick={() => remove(r)}
                disabled={pending}
                style={{ ...chipButtonStyle, height: 22, fontFamily: 'inherit' }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      ))}

      {adding && canManage && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--bd)' }}>
          <input
            placeholder="Rule name, e.g. Chase invoices at 7 days"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ ...inputStyle, marginBottom: 10 }}
          />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <select
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value)}
              style={inputStyle}
              aria-label="Trigger"
            >
              {TRIGGERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>

            {triggerType === 'invoice.overdue' ? (
              <input
                type="number"
                min={0}
                value={daysOverdue}
                onChange={(e) => setDaysOverdue(e.target.value)}
                aria-label="Days overdue"
                style={inputStyle}
              />
            ) : (
              <select
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
                style={inputStyle}
                aria-label="Record type"
              >
                {ENTITIES.map((e) => (
                  <option key={e} value={e}>
                    {e.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            )}

            {triggerType === 'field.changed' && (
              <>
                <input
                  placeholder="field, e.g. status"
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  style={inputStyle}
                />
                <input
                  placeholder="changes to, e.g. won (optional)"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  style={inputStyle}
                />
              </>
            )}

            <select
              value={actionType}
              onChange={(e) => setActionType(e.target.value)}
              style={inputStyle}
              aria-label="Action"
            >
              {ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>

            {actionType === 'record.tag' ? (
              <input
                placeholder="tag name"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                style={inputStyle}
              />
            ) : (
              <input
                placeholder={
                  actionType === 'webhook.send' ? 'https://…' : 'subject / note text'
                }
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={inputStyle}
              />
            )}
          </div>

          <div style={{ display: 'flex', marginTop: 12 }}>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              style={{ ...primaryButtonStyle, fontFamily: 'inherit', opacity: pending ? 0.6 : 1 }}
            >
              Create rule
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
