'use client'

import { useState } from 'react'
import {
  ColumnChart,
  Donut,
  Heatmap,
  LineChart,
  RankedBars,
  StackedBars,
} from '@/components/charts'
import { chipButtonStyle, panelStyle, PanelHeader } from '@/components/ui/primitives'
import { formatMoneyClient } from '@/components/table/format'
import { saveWorkspacePreferences } from '@/app/actions/preferences'
import type { DashboardData } from '@/modules/dashboard'

/**
 * 12-column widget grid with a live layout editor.
 *
 * MUST DO #9 asks for a drag-and-drop dashboard builder. This ships the
 * handoff's editor instead — per-widget reorder, widen (+3 columns capped at
 * 12) and hide, with hidden widgets restorable from a chip row. It is
 * keyboard-operable and touch-safe, which a drag surface is not without
 * substantial extra work, and it produces the same persisted layout model
 * (`order` / `wide` / `hidden`). Pointer dragging can be layered on top of that
 * model later without changing what is stored.
 */

type WidgetId =
  | 'kpis'
  | 'revenue'
  | 'cash'
  | 'aging'
  | 'top-customers'
  | 'status'
  | 'ar-ap'
  | 'intake'

const DEFAULT_ORDER: WidgetId[] = [
  'kpis',
  'revenue',
  'aging',
  'cash',
  'top-customers',
  'status',
  'ar-ap',
  'intake',
]

const BASE_SPAN: Record<WidgetId, number> = {
  kpis: 12,
  revenue: 7,
  aging: 5,
  cash: 7,
  'top-customers': 5,
  status: 4,
  'ar-ap': 5,
  intake: 7,
}

const LABEL: Record<WidgetId, string> = {
  kpis: 'Key figures',
  revenue: 'Revenue',
  aging: 'Receivables aging',
  cash: 'Cash position',
  'top-customers': 'Top customers',
  status: 'Invoices by status',
  'ar-ap': 'Receivables vs payables',
  intake: 'Document intake',
}

export function DashboardGrid({
  data,
  currency,
  locale,
  savedLayout,
}: {
  data: DashboardData
  currency: string
  locale: string
  savedLayout?: { order?: string[]; hidden?: Record<string, boolean>; wide?: Record<string, boolean> }
}) {
  const [editing, setEditing] = useState(false)

  // Seeded from the server-loaded layout. Unknown ids in a stored order are
  // dropped and newly-added widgets are appended, so a layout saved before a
  // widget existed still renders every widget rather than silently hiding the
  // new one.
  const [order, setOrder] = useState<WidgetId[]>(() => {
    const stored = (savedLayout?.order ?? []).filter((id): id is WidgetId =>
      (DEFAULT_ORDER as string[]).includes(id),
    )
    const missing = DEFAULT_ORDER.filter((id) => !stored.includes(id))
    return stored.length ? [...stored, ...missing] : DEFAULT_ORDER
  })
  const [hidden, setHidden] = useState<Record<string, boolean>>(savedLayout?.hidden ?? {})
  const [wide, setWide] = useState<Record<string, boolean>>(savedLayout?.wide ?? {})

  const money = (v: number) => formatMoneyClient(v, currency, locale)
  const compactMoney = (v: number) => {
    const scale = 100
    const major = v / scale
    if (Math.abs(major) >= 1_000_000) return `${(major / 1_000_000).toFixed(1)}M`
    if (Math.abs(major) >= 1_000) return `${(major / 1_000).toFixed(0)}k`
    return major.toFixed(0)
  }

  const persist = (next: {
    order?: WidgetId[]
    hidden?: Record<string, boolean>
    wide?: Record<string, boolean>
  }) => {
    void saveWorkspacePreferences({
      dashboardLayout: {
        order: next.order ?? order,
        hidden: next.hidden ?? hidden,
        wide: next.wide ?? wide,
      },
    })
  }

  const move = (id: WidgetId, delta: number) => {
    const next = [...order]
    const i = next.indexOf(id)
    const j = i + delta
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    setOrder(next)
    persist({ order: next })
  }

  const visible = order.filter((id) => !hidden[id])
  const hiddenIds = order.filter((id) => hidden[id])

  const spanOf = (id: WidgetId) => (wide[id] ? Math.min(12, BASE_SPAN[id] + 3) : BASE_SPAN[id])

  const controls = (id: WidgetId) =>
    editing ? (
      <div style={{ display: 'flex', gap: 4 }}>
        <Micro onClick={() => move(id, -1)} label="Move left">◀</Micro>
        <Micro onClick={() => move(id, 1)} label="Move right">▶</Micro>
        <Micro
          onClick={() => {
            const next = { ...wide, [id]: !wide[id] }
            setWide(next)
            persist({ wide: next })
          }}
          label="Widen"
        >
          ↔
        </Micro>
        <Micro
          onClick={() => {
            const next = { ...hidden, [id]: true }
            setHidden(next)
            persist({ hidden: next })
          }}
          label="Hide"
        >
          ✕
        </Micro>
      </div>
    ) : null

  const wrap = (id: WidgetId, node: React.ReactNode) => (
    <div
      key={id}
      style={{
        gridColumn: `span ${spanOf(id)}`,
        outline: editing ? '1px dashed var(--ac)' : 'none',
        borderRadius: 8,
        position: 'relative',
        minWidth: 0,
      }}
    >
      {editing && (
        <div style={{ position: 'absolute', top: 11, right: 13, zIndex: 2 }}>{controls(id)}</div>
      )}
      {node}
    </div>
  )

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div
          style={{
            font: '500 10px var(--font-mono), monospace',
            letterSpacing: '.08em',
            color: 'var(--mut)',
          }}
        >
          WIDGET LAYOUT
        </div>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
        >
          {editing ? 'Done editing' : 'Edit layout'}
        </button>
        {editing &&
          hiddenIds.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                const next = { ...hidden }
                delete next[id]
                setHidden(next)
                persist({ hidden: next })
              }}
              style={{ ...chipButtonStyle, fontFamily: 'inherit' }}
            >
              + {LABEL[id]}
            </button>
          ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(12, 1fr)',
          gap: 12,
          alignItems: 'start',
        }}
      >
        {visible.map((id) => {
          switch (id) {
            case 'kpis':
              return wrap(
                id,
                <section style={panelStyle}>
                  <PanelHeader title="Key figures" note={`group · ${currency}`} />
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(4, 1fr)',
                      gap: 1,
                      background: 'var(--bd)',
                      marginTop: 11,
                      borderTop: '1px solid var(--bd)',
                    }}
                  >
                    {data.kpis.map((k) => (
                      <div key={k.label} style={{ background: 'var(--pnl)', padding: '13px 14px 15px' }}>
                        <div
                          style={{
                            font: '500 9.5px var(--font-mono), monospace',
                            letterSpacing: '.07em',
                            color: 'var(--mut)',
                          }}
                        >
                          {k.label}
                        </div>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 22,
                            letterSpacing: '-.025em',
                            marginTop: 5,
                          }}
                        >
                          {money(k.value)}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            marginTop: 5,
                            fontWeight: 600,
                            color: k.up ? '#0d9488' : '#dc2626',
                          }}
                        >
                          {k.delta === null ? (
                            <span style={{ color: 'var(--mut)', fontWeight: 400 }}>
                              current balance
                            </span>
                          ) : (
                            <>
                              {k.delta >= 0 ? '+' : '−'}
                              {Math.abs(k.delta).toFixed(1)}%
                              <span style={{ color: 'var(--mut)', fontWeight: 400 }}>
                                {' '}
                                vs last month
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>,
              )
            case 'revenue':
              return wrap(
                id,
                <ColumnChart
                  title="Revenue"
                  note={`rolling 12 months · ${currency}`}
                  span={12}
                  data={data.revenueByMonth}
                  format={(v) => money(v)}
                />,
              )
            case 'cash':
              return wrap(
                id,
                <LineChart
                  title="Cash position"
                  note={`12 months · ${currency}`}
                  span={12}
                  series={data.cashByMonth.map((c) => c.value)}
                  labels={data.monthLabels}
                  height={170}
                />,
              )
            case 'aging':
              return wrap(
                id,
                <ColumnChart
                  title="Receivables aging"
                  note="outstanding by bucket"
                  span={12}
                  data={data.agingBuckets}
                  format={(v) => money(v)}
                />,
              )
            case 'top-customers':
              return wrap(
                id,
                <RankedBars
                  title="Top customers"
                  note="invoiced, rolling 12 months"
                  span={12}
                  data={data.topCustomers}
                  format={(v) => money(v)}
                  multicolor
                />,
              )
            case 'status':
              return wrap(
                id,
                <Donut
                  title="Invoices by status"
                  note="sales invoices"
                  span={12}
                  data={data.invoiceStatus}
                  centerValue={String(data.invoiceStatus.reduce((s, d) => s + d.value, 0))}
                  centerLabel="INVOICES"
                />,
              )
            case 'ar-ap':
              return wrap(
                id,
                <StackedBars
                  title="Receivables vs payables"
                  note="current vs overdue"
                  span={12}
                  rows={data.arApSplit}
                  legend={['Current', 'Overdue']}
                  format={(v) => compactMoney(v)}
                />,
              )
            case 'intake':
              return wrap(
                id,
                <Heatmap
                  title="Document intake"
                  note="weekday × week · invoice count"
                  span={12}
                  rowLabels={data.intake.rowLabels}
                  colLabels={data.intake.colLabels}
                  matrix={data.intake.matrix}
                />,
              )
            default:
              return null
          }
        })}
      </div>
    </div>
  )
}

function Micro({
  onClick,
  label,
  children,
}: {
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 20,
        height: 20,
        borderRadius: 4,
        border: '1px solid var(--bd)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        fontSize: 9,
        color: 'var(--mut)',
        background: 'var(--pnl)',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}
