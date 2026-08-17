'use client'

import { panelStyle } from '@/components/ui/primitives'
import { formatMoneyClient } from '@/components/table/format'
import type { balanceSheet, cashFlow, profitAndLoss, trialBalance } from '@/finance/reports'

type PL = Awaited<ReturnType<typeof profitAndLoss>>
type BS = Awaited<ReturnType<typeof balanceSheet>>
type CF = Awaited<ReturnType<typeof cashFlow>>
type TB = Awaited<ReturnType<typeof trialBalance>>

/**
 * P&L, balance sheet, cash flow and trial balance.
 *
 * The balance-sheet and trial-balance checks are shown to the USER, not hidden
 * in a test. If either ever fails, the person looking at the numbers should be
 * the first to know — silently rendering an unbalanced balance sheet is how a
 * finance product loses trust permanently.
 */
export function ReportsView({
  pl,
  bs,
  cf,
  tb,
  currency,
  locale,
  from,
  to,
}: {
  pl: PL
  bs: BS
  cf: CF
  tb: TB
  currency: string
  locale: string
  from: string
  to: string
}) {
  const money = (v: number) => formatMoneyClient(v, currency, locale)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 12, alignItems: 'start' }}>
      {!bs.balances && (
        <div
          style={{
            gridColumn: 'span 12',
            ...panelStyle,
            borderColor: '#dc2626',
            padding: '12px 14px',
            color: '#dc2626',
            fontSize: 12.5,
          }}
        >
          <strong>Balance sheet does not balance.</strong> Assets differ from liabilities plus
          equity by {money(bs.differenceMinor)}. This indicates a ledger problem — do not rely on
          these figures until it is resolved.
        </div>
      )}

      <Panel title="Profit &amp; loss" note={`${from} → ${to}`} span={7}>
        <Rows>
          {pl.income.map((r) => (
            <Row key={r.accountId} label={`${r.code} ${r.name}`} value={money(r.balanceMinor)} />
          ))}
          <Row label="Total income" value={money(pl.totalIncomeMinor)} strong />
          <Spacer />
          {pl.costOfSales.map((r) => (
            <Row key={r.accountId} label={`${r.code} ${r.name}`} value={money(r.balanceMinor)} />
          ))}
          <Row label="Gross profit" value={money(pl.grossProfitMinor)} strong />
          {pl.grossMarginPct !== null && (
            <Row label="Gross margin" value={`${pl.grossMarginPct.toFixed(1)}%`} muted />
          )}
          <Spacer />
          {pl.operatingExpenses.map((r) => (
            <Row key={r.accountId} label={`${r.code} ${r.name}`} value={money(r.balanceMinor)} />
          ))}
          <Row
            label="Total operating expenses"
            value={money(pl.totalOperatingExpensesMinor)}
            strong
          />
          <Spacer />
          <Row label="Net profit" value={money(pl.netProfitMinor)} strong accent />
        </Rows>
      </Panel>

      <Panel title="Balance sheet" note={`as at ${to}`} span={5}>
        <Rows>
          <Section>Assets</Section>
          {bs.assets.map((r) => (
            <Row key={r.accountId} label={`${r.code} ${r.name}`} value={money(r.balanceMinor)} />
          ))}
          <Row label="Total assets" value={money(bs.totalAssetsMinor)} strong />
          <Spacer />
          <Section>Liabilities</Section>
          {bs.liabilities.map((r) => (
            <Row key={r.accountId} label={`${r.code} ${r.name}`} value={money(r.balanceMinor)} />
          ))}
          <Row label="Total liabilities" value={money(bs.totalLiabilitiesMinor)} strong />
          <Spacer />
          <Section>Equity</Section>
          {bs.equity.map((r) => (
            <Row key={r.accountId} label={`${r.code} ${r.name}`} value={money(r.balanceMinor)} />
          ))}
          {bs.retainedEarningsMinor !== 0 && (
            <Row
              label="Retained earnings (prior years)"
              value={money(bs.retainedEarningsMinor)}
              muted
            />
          )}
          <Row
            label={`Current year earnings (from ${bs.fiscalYearStart})`}
            value={money(bs.currentYearEarningsMinor)}
            muted
          />
          <Row label="Total equity" value={money(bs.totalEquityMinor)} strong />
          <Spacer />
          <Row
            label="Assets − (liabilities + equity)"
            value={money(bs.differenceMinor)}
            accent={bs.balances}
            strong
          />
        </Rows>
      </Panel>

      <Panel title="Cash flow" note={`${from} → ${to}`} span={7}>
        <Rows>
          <Row label="Opening cash" value={money(cf.openingCashMinor)} />
          <Row label="Cash in" value={money(cf.inflowMinor)} />
          <Row label="Cash out" value={money(-cf.outflowMinor)} />
          <Row label="Net movement" value={money(cf.netMovementMinor)} strong />
          <Row label="Closing cash" value={money(cf.closingCashMinor)} strong accent />
          <Spacer />
          <Section>Where the cash came from</Section>
          {cf.counterparts.length === 0 && <Row label="No movement in this period" value="—" muted />}
          {cf.counterparts.map((c) => (
            <Row
              key={`${c.type}-${c.subtype}`}
              label={(c.subtype ?? c.type).replace(/_/g, ' ')}
              value={money(c.netCashMinor)}
            />
          ))}
        </Rows>
      </Panel>

      <Panel
        title="Trial balance"
        note={tb.inBalance ? 'in balance' : 'OUT OF BALANCE'}
        span={5}
      >
        <Rows>
          {tb.rows.map((r) => (
            <Row
              key={r.accountId}
              label={`${r.code} ${r.name}`}
              value={`${money(r.debitMinor)} / ${money(r.creditMinor)}`}
            />
          ))}
          <Spacer />
          <Row
            label="Totals (debit / credit)"
            value={`${money(tb.totalDebitMinor)} / ${money(tb.totalCreditMinor)}`}
            strong
            accent={tb.inBalance}
          />
        </Rows>
      </Panel>
    </div>
  )
}

function Panel({
  title,
  note,
  span,
  children,
}: {
  title: string
  note?: string
  span: number
  children: React.ReactNode
}) {
  return (
    <section style={{ ...panelStyle, gridColumn: `span ${span}`, minWidth: 0 }}>
      <div
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid var(--bd)',
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{title}</div>
        {note && (
          <div style={{ font: '400 10px var(--font-mono), monospace', color: 'var(--mut)' }}>
            {note}
          </div>
        )}
      </div>
      <div style={{ padding: '10px 14px 14px' }}>{children}</div>
    </section>
  )
}

const Rows = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
)

const Spacer = () => <div style={{ height: 10 }} />

const Section = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      font: '500 9.5px var(--font-mono), monospace',
      letterSpacing: '.08em',
      color: 'var(--mut)',
      margin: '6px 0 4px',
    }}
  >
    {String(children).toUpperCase()}
  </div>
)

function Row({
  label,
  value,
  strong,
  muted,
  accent,
}: {
  label: string
  value: string
  strong?: boolean
  muted?: boolean
  accent?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '4px 0',
        fontSize: 12,
        fontWeight: strong ? 600 : 400,
        color: accent ? 'var(--ac)' : muted ? 'var(--mut)' : 'var(--fg)',
        borderTop: strong ? '1px solid var(--bd)' : 'none',
      }}
    >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span
        style={{
          fontFamily: 'var(--font-mono), monospace',
          fontSize: '.94em',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  )
}
