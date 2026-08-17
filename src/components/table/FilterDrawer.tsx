'use client'

import { useState } from 'react'
import type { ColumnDef, ModuleDef } from '@/modules/registry'
import type { Condition, Operator } from '@/modules/filters'
import {
  chipButtonStyle,
  iconButtonStyle,
  inputStyle,
  primaryButtonStyle,
} from '@/components/ui/primitives'

/**
 * Structured filter builder.
 *
 * Emits exactly the shape `compileFilter` consumes, so what the user assembles
 * here, what a saved view stores, and what a workflow rule evaluates are all
 * the same vocabulary — "amount over 5000" cannot mean three different things.
 */

const OPERATOR_LABELS: Record<Operator, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  starts_with: 'starts with',
  in: 'is any of',
  between: 'is between',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
}

/** Which operators make sense for a column, so the UI never offers
 *  "starts with" on a money field. */
function operatorsFor(column: ColumnDef): Operator[] {
  if (column.money || column.key.endsWith('Minor')) {
    return ['eq', 'gt', 'gte', 'lt', 'lte', 'between']
  }
  if (column.badge) return ['eq', 'neq', 'in']
  if (/date/i.test(column.key)) return ['eq', 'gt', 'gte', 'lt', 'lte', 'between']
  return ['contains', 'starts_with', 'eq', 'neq', 'is_empty', 'is_not_empty']
}

const NO_VALUE: Operator[] = ['is_empty', 'is_not_empty']

export type CustomFieldOption = { key: string; label: string }

export function FilterDrawer({
  module,
  open,
  initial,
  customFields,
  onClose,
  onApply,
  onSave,
}: {
  module: ModuleDef
  open: boolean
  initial: Condition[]
  customFields: CustomFieldOption[]
  onClose: () => void
  onApply: (conditions: Condition[]) => void
  onSave: (name: string, conditions: Condition[], shared: boolean) => void
}) {
  const [conditions, setConditions] = useState<Condition[]>(initial)
  const [viewName, setViewName] = useState('')
  const [shared, setShared] = useState(false)

  if (!open) return null

  const fieldOptions: { key: string; label: string; column?: ColumnDef }[] = [
    ...module.columns.map((c) => ({ key: c.key, label: c.label, column: c })),
    ...customFields.map((f) => ({ key: `custom.${f.key}`, label: `${f.label} (custom)` })),
  ]

  const columnFor = (key: string): ColumnDef =>
    module.columns.find((c) => c.key === key) ?? { key, label: key, width: 160 }

  const update = (i: number, patch: Partial<Condition>) =>
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(8,11,17,.3)', zIndex: 80 }}
      />
      <aside
        role="dialog"
        aria-label="Filters"
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          width: 420,
          maxWidth: '95vw',
          background: 'var(--pnl)',
          borderLeft: '1px solid var(--bd)',
          zIndex: 90,
          display: 'flex',
          flexDirection: 'column',
          animation: 'slide-in .16s ease',
        }}
      >
        <header
          style={{
            flex: 'none',
            padding: '15px 18px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 14, letterSpacing: '-.02em' }}>Filters</div>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ ...iconButtonStyle, fontFamily: 'inherit' }}
          >
            ✕
          </button>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 24px' }}>
          {conditions.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--mut)', margin: '0 0 14px' }}>
              No filters yet. Add one to narrow this list — the result is computed on the server,
              so it works across every page of records, not just the ones on screen.
            </p>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {conditions.map((c, i) => {
              const column = columnFor(c.field)
              const ops = c.field.startsWith('custom.')
                ? (['contains', 'eq', 'neq', 'is_empty', 'is_not_empty'] as Operator[])
                : operatorsFor(column)
              const needsValue = !NO_VALUE.includes(c.op)

              return (
                <div
                  key={i}
                  style={{
                    border: '1px solid var(--bd)',
                    borderRadius: 8,
                    padding: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 7,
                  }}
                >
                  <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                    <select
                      value={c.field}
                      onChange={(e) => {
                        const nextField = e.target.value
                        const nextOps = nextField.startsWith('custom.')
                          ? (['contains'] as Operator[])
                          : operatorsFor(columnFor(nextField))
                        update(i, { field: nextField, op: nextOps[0]!, value: '' })
                      }}
                      style={{ ...inputStyle, flex: 1 }}
                    >
                      {fieldOptions.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      aria-label="Remove condition"
                      onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))}
                      style={{ ...iconButtonStyle, fontFamily: 'inherit' }}
                    >
                      ✕
                    </button>
                  </div>

                  <select
                    value={c.op}
                    onChange={(e) => update(i, { op: e.target.value as Operator, value: '' })}
                    style={inputStyle}
                  >
                    {ops.map((op) => (
                      <option key={op} value={op}>
                        {OPERATOR_LABELS[op]}
                      </option>
                    ))}
                  </select>

                  {needsValue && c.op === 'between' && (
                    <div style={{ display: 'flex', gap: 7 }}>
                      <input
                        placeholder="from"
                        value={Array.isArray(c.value) ? String(c.value[0] ?? '') : ''}
                        onChange={(e) =>
                          update(i, {
                            value: [
                              e.target.value,
                              Array.isArray(c.value) ? (c.value[1] ?? '') : '',
                            ],
                          })
                        }
                        style={inputStyle}
                      />
                      <input
                        placeholder="to"
                        value={Array.isArray(c.value) ? String(c.value[1] ?? '') : ''}
                        onChange={(e) =>
                          update(i, {
                            value: [
                              Array.isArray(c.value) ? (c.value[0] ?? '') : '',
                              e.target.value,
                            ],
                          })
                        }
                        style={inputStyle}
                      />
                    </div>
                  )}

                  {needsValue && c.op === 'in' && (
                    <input
                      placeholder="comma separated"
                      value={Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')}
                      onChange={(e) =>
                        update(i, {
                          value: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      style={inputStyle}
                    />
                  )}

                  {needsValue && c.op !== 'between' && c.op !== 'in' && (
                    <input
                      placeholder={
                        column.money
                          ? 'amount in minor units, e.g. 500000 for 5,000.00'
                          : /date/i.test(column.key)
                            ? 'YYYY-MM-DD'
                            : 'value'
                      }
                      value={String(c.value ?? '')}
                      onChange={(e) => update(i, { value: e.target.value })}
                      style={inputStyle}
                    />
                  )}
                </div>
              )
            })}
          </div>

          <button
            type="button"
            onClick={() =>
              setConditions((cs) => [
                ...cs,
                { field: fieldOptions[0]!.key, op: 'contains', value: '' },
              ])
            }
            style={{ ...chipButtonStyle, marginTop: 12, fontFamily: 'inherit' }}
          >
            + Add condition
          </button>

          <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--bd)' }}>
            <div
              style={{
                font: '500 9.5px var(--font-mono), monospace',
                letterSpacing: '.08em',
                color: 'var(--mut)',
                marginBottom: 8,
              }}
            >
              SAVE AS A VIEW
            </div>
            <input
              placeholder="e.g. Overdue over €5k"
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              style={{ ...inputStyle, marginBottom: 8 }}
            />
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5 }}
            >
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
                style={{ accentColor: 'var(--ac)' }}
              />
              Share with everyone in this organization
            </label>
          </div>
        </div>

        <footer
          style={{
            flex: 'none',
            padding: '12px 18px',
            borderTop: '1px solid var(--bd)',
            display: 'flex',
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={() => {
              setConditions([])
              onApply([])
            }}
            style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
          >
            Clear all
          </button>
          <div style={{ flex: 1 }} />
          {viewName.trim() && (
            <button
              type="button"
              onClick={() => onSave(viewName.trim(), conditions, shared)}
              style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
            >
              Save view
            </button>
          )}
          <button
            type="button"
            onClick={() => onApply(conditions)}
            style={{ ...primaryButtonStyle, fontFamily: 'inherit' }}
          >
            Apply
          </button>
        </footer>
      </aside>
    </>
  )
}
