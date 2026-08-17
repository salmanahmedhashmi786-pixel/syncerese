'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Donut, RankedBars, StatSparkline } from '@/components/charts'
import { Badge, inputStyle, panelStyle } from '@/components/ui/primitives'
import { formatMoneyClient } from '@/components/table/format'
import type { customerValue, demographics, availableDimensions } from '@/modules/demographics'

type Dimensions = Awaited<ReturnType<typeof availableDimensions>>
type Result = Awaited<ReturnType<typeof demographics>>
type Customers = Awaited<ReturnType<typeof customerValue>>

/**
 * Business demographics (MUST DO #11).
 *
 * The dimension picker is populated at runtime from built-in cuts, tenant tag
 * categories and tenant custom fields — so a tenant that tags accounts by
 * industry gets "segment by industry" without anyone shipping code for it.
 */
export function AnalyticsView({
  dimensions,
  result,
  customers,
  currency,
  locale,
  from,
  to,
}: {
  dimensions: Dimensions
  result: Result
  customers: Customers
  currency: string
  locale: string
  from: string
  to: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  const money = (v: number) => formatMoneyClient(v, currency, locale)

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k)
      else next.set(k, v)
    }
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  const top = result.segments.slice(0, 8)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Controls */}
      <div
        style={{
          ...panelStyle,
          padding: '11px 13px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <label
          style={{
            font: '500 9.5px var(--font-mono), monospace',
            letterSpacing: '.08em',
            color: 'var(--mut)',
          }}
        >
          SEGMENT BY
        </label>
        <select
          value={result.dimensionKey}
          onChange={(e) => setParam({ dim: e.target.value })}
          style={{ ...inputStyle, width: 'auto', minWidth: 190 }}
        >
          {dimensions.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>

        <div style={{ width: 12 }} />

        <label
          style={{
            font: '500 9.5px var(--font-mono), monospace',
            letterSpacing: '.08em',
            color: 'var(--mut)',
          }}
        >
          PERIOD
        </label>
        <input
          type="date"
          value={from}
          onChange={(e) => setParam({ from: e.target.value })}
          style={{ ...inputStyle, width: 'auto' }}
        />
        <span style={{ color: 'var(--mut)' }}>→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setParam({ to: e.target.value })}
          style={{ ...inputStyle, width: 'auto' }}
        />

        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'var(--mut)' }}>
          {result.totals.customers} customers · {result.segments.length} segments
        </span>
      </div>

      {/* Headline figures */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 12 }}>
        <StatSparkline
          title="Revenue in period"
          note={`${from} → ${to}`}
          span={3}
          value={money(result.totals.revenueMinor)}
          series={top.map((s) => s.revenueMinor)}
          up
        />
        <StatSparkline
          title="Lifetime value"
          note="all time, all customers"
          span={3}
          value={money(result.totals.lifetimeValueMinor)}
          series={top.map((s) => s.lifetimeValueMinor)}
          up
        />
        <StatSparkline
          title="Outstanding"
          note="unpaid receivables"
          span={3}
          value={money(result.totals.outstandingMinor)}
          series={top.map((s) => s.outstandingMinor)}
          up={result.totals.outstandingMinor === 0}
        />
        <StatSparkline
          title="At risk"
          note="no invoice in 180 days"
          span={3}
          value={String(result.totals.atRiskCount)}
          series={top.map((s) => s.atRiskCount)}
          up={result.totals.atRiskCount === 0}
        />

        <RankedBars
          title={`Revenue by ${result.dimensionLabel.toLowerCase()}`}
          note={`${from} → ${to}`}
          span={7}
          data={top.map((s) => ({ label: s.segment, value: s.revenueMinor }))}
          format={money}
          multicolor
        />

        <Donut
          title="Customers by segment"
          note={result.dimensionLabel}
          span={5}
          data={top.map((s) => ({ label: s.segment, value: s.customerCount }))}
          centerValue={String(result.totals.customers)}
          centerLabel="CUSTOMERS"
        />
      </div>

      {/* Segment table */}
      <section style={panelStyle}>
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--bd)',
            fontWeight: 600,
            fontSize: 12.5,
          }}
        >
          {result.dimensionLabel} breakdown
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead>
              <tr>
                {['Segment', 'Customers', 'Revenue', 'Outstanding', 'Lifetime value', 'Avg / customer', 'At risk'].map(
                  (h, i) => (
                    <th
                      key={h}
                      style={{
                        textAlign: i === 0 ? 'left' : 'right',
                        padding: '8px 10px',
                        font: '500 9.5px var(--font-mono), monospace',
                        letterSpacing: '.07em',
                        color: 'var(--mut)',
                        textTransform: 'uppercase',
                        borderBottom: '1px solid var(--bd)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {result.segments.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: '24px 12px', color: 'var(--mut)', fontSize: 12 }}>
                    No customer revenue in this period.
                  </td>
                </tr>
              )}
              {result.segments.map((s) => (
                <tr key={s.segment} style={{ borderBottom: '1px solid rgba(0,0,0,.045)' }}>
                  <Cell left>{s.segment}</Cell>
                  <Cell>{s.customerCount}</Cell>
                  <Cell>{money(s.revenueMinor)}</Cell>
                  <Cell>{money(s.outstandingMinor)}</Cell>
                  <Cell>{money(s.lifetimeValueMinor)}</Cell>
                  <Cell>{money(s.averageValueMinor)}</Cell>
                  <Cell>
                    {s.atRiskCount > 0 ? (
                      <Badge color="#b45309">{s.atRiskCount}</Badge>
                    ) : (
                      <span style={{ color: 'var(--mut)' }}>—</span>
                    )}
                  </Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Customer value */}
      <section style={panelStyle}>
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--bd)',
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12.5 }}>Customer lifetime value</div>
          <div style={{ font: '400 10px var(--font-mono), monospace', color: 'var(--mut)' }}>
            top 25 · at-risk = no invoice in 180 days
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
            <thead>
              <tr>
                {['Customer', 'Country', 'Invoices', 'Lifetime value', 'Last invoiced', 'Days since'].map(
                  (h, i) => (
                    <th
                      key={h}
                      style={{
                        textAlign: i === 0 || i === 1 ? 'left' : 'right',
                        padding: '8px 10px',
                        font: '500 9.5px var(--font-mono), monospace',
                        letterSpacing: '.07em',
                        color: 'var(--mut)',
                        textTransform: 'uppercase',
                        borderBottom: '1px solid var(--bd)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid rgba(0,0,0,.045)' }}>
                  <Cell left>
                    {c.name}
                    {c.atRisk && (
                      <span style={{ marginLeft: 7 }}>
                        <Badge color="#b45309">At risk</Badge>
                      </span>
                    )}
                  </Cell>
                  <Cell left>{c.country ?? '—'}</Cell>
                  <Cell>{c.invoiceCount}</Cell>
                  <Cell>{money(c.lifetimeValueMinor)}</Cell>
                  <Cell>{c.lastInvoiceDate ?? '—'}</Cell>
                  <Cell>{c.daysSinceLast ?? '—'}</Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p style={{ fontSize: 11, color: 'var(--mut)', margin: '2px 2px 0' }}>
        &ldquo;At risk&rdquo; is a fact, not a prediction: it means nobody has invoiced this
        customer in 180 days. It is not a churn model.
      </p>
    </div>
  )
}

function Cell({ children, left }: { children: React.ReactNode; left?: boolean }) {
  return (
    <td
      style={{
        padding: '7px 10px',
        textAlign: left ? 'left' : 'right',
        fontSize: 12,
        fontFamily: left ? 'inherit' : 'var(--font-mono), monospace',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </td>
  )
}
