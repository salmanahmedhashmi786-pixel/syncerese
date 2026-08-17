import { sql } from 'drizzle-orm'
import type { TenantTx } from '@/db/tenant'
import { agingReport, cashFlow, profitAndLoss } from '@/finance/reports'
import { excludeCreditNotes, signedBaseTotal } from '@/finance/invoice-sql'

/**
 * Dashboard aggregates.
 *
 * Every series is computed in SQL over the tenant's real ledger — the design
 * prototype's hardcoded arrays exist only to communicate visual intent. A
 * dashboard that shows plausible fiction is worse than an empty one, because
 * nobody can tell which numbers are real.
 */

const rowsOf = <T>(res: unknown): T[] => (res as { rows: T[] }).rows

export type DashboardData = {
  kpis: { label: string; value: number; currency: string; delta: number | null; up: boolean }[]
  revenueByMonth: { label: string; value: number }[]
  cashByMonth: { label: string; value: number }[]
  agingBuckets: { label: string; value: number; color?: string }[]
  topCustomers: { label: string; value: number }[]
  invoiceStatus: { label: string; value: number; color?: string }[]
  arApSplit: { label: string; parts: number[] }[]
  intake: { rowLabels: string[]; colLabels: string[]; matrix: number[][] }
  currency: string
  monthLabels: string[]
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The trailing 12 months ending with `today`, oldest first. */
function trailingMonths(today: string): { key: string; label: string }[] {
  const end = new Date(`${today}T00:00:00Z`)
  const out: { key: string; label: string }[] = []
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1))
    out.push({
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      label: MONTH_NAMES[d.getUTCMonth()]!,
    })
  }
  return out
}

export async function loadDashboard(
  tx: TenantTx,
  organizationId: string,
  baseCurrency: string,
  today: string,
): Promise<DashboardData> {
  const months = trailingMonths(today)
  const from = `${months[0]!.key}-01`
  const monthStart = `${today.slice(0, 7)}-01`

  // --- revenue and cash, by month ------------------------------------------
  const revenueRows = rowsOf<{ m: string; v: string }>(
    await tx.execute(sql`
      select to_char(je.entry_date, 'YYYY-MM') as m,
             coalesce(sum(jl.base_credit_minor - jl.base_debit_minor), 0) as v
      from journal_lines jl
      join journal_entries je on je.id = jl.journal_entry_id
      join accounts a on a.id = jl.account_id
      where jl.organization_id = ${organizationId}
        and a.type = 'income'
        and je.status in ('posted','reversed')
        and je.entry_date >= ${from}
      group by 1
    `),
  )
  const revenueByMonth = months.map((m) => ({
    label: m.label,
    value: Number(revenueRows.find((r) => r.m === m.key)?.v ?? 0),
  }))

  const cashRows = rowsOf<{ m: string; v: string }>(
    await tx.execute(sql`
      select to_char(je.entry_date, 'YYYY-MM') as m,
             coalesce(sum(jl.base_debit_minor - jl.base_credit_minor), 0) as v
      from journal_lines jl
      join journal_entries je on je.id = jl.journal_entry_id
      join accounts a on a.id = jl.account_id
      where jl.organization_id = ${organizationId}
        and a.subtype in ('bank','cash')
        and je.status in ('posted','reversed')
        and je.entry_date >= ${from}
      group by 1
    `),
  )
  // Running cash balance rather than the month's movement — a balance is the
  // number a business owner actually looks for.
  let running = 0
  const cashByMonth = months.map((m) => {
    running += Number(cashRows.find((r) => r.m === m.key)?.v ?? 0)
    return { label: m.label, value: running }
  })

  // --- KPIs -----------------------------------------------------------------
  const pl = await profitAndLoss(tx, organizationId, { from: monthStart, to: today })
  const prevMonthEnd = new Date(`${monthStart}T00:00:00Z`)
  prevMonthEnd.setUTCDate(0)
  const prevMonthStart = `${prevMonthEnd.toISOString().slice(0, 7)}-01`
  const plPrev = await profitAndLoss(tx, organizationId, {
    from: prevMonthStart,
    to: prevMonthEnd.toISOString().slice(0, 10),
  })

  const ar = await agingReport(tx, organizationId, { direction: 'ar', asOf: today })
  const ap = await agingReport(tx, organizationId, { direction: 'ap', asOf: today })
  const cf = await cashFlow(tx, organizationId, { from: from, to: today })

  const overdue =
    ar.buckets.d1_30 + ar.buckets.d31_60 + ar.buckets.d61_90 + ar.buckets.d90plus

  const pct = (now: number, before: number): number | null =>
    before === 0 ? null : ((now - before) / Math.abs(before)) * 100

  const kpis = [
    {
      label: 'REVENUE MTD',
      value: pl.totalIncomeMinor,
      currency: baseCurrency,
      delta: pct(pl.totalIncomeMinor, plPrev.totalIncomeMinor),
      up: pl.totalIncomeMinor >= plPrev.totalIncomeMinor,
    },
    {
      label: 'CASH POSITION',
      value: cf.closingCashMinor,
      currency: baseCurrency,
      delta: null,
      up: cf.netMovementMinor >= 0,
    },
    {
      label: 'RECEIVABLES OPEN',
      value: ar.totalOutstandingMinor,
      currency: baseCurrency,
      delta: null,
      up: true,
    },
    {
      label: 'OVERDUE AR',
      value: overdue,
      currency: baseCurrency,
      delta: null,
      // Overdue rising is bad news, so "up" here means the healthy direction.
      up: overdue === 0,
    },
  ]

  // --- aging, top customers, status mix -------------------------------------
  const agingBuckets = [
    { label: 'Current', value: ar.buckets.current },
    { label: '1–30', value: ar.buckets.d1_30, color: '#b45309' },
    { label: '31–60', value: ar.buckets.d31_60, color: '#b45309' },
    { label: '61–90', value: ar.buckets.d61_90, color: '#dc2626' },
    { label: '90+', value: ar.buckets.d90plus, color: '#dc2626' },
  ]

  const topCustomers = rowsOf<{ name: string; v: string }>(
    await tx.execute(sql`
      select bp.name as name, coalesce(sum(${sql.raw(signedBaseTotal('i'))}), 0) as v
      from invoices i
      join business_partners bp on bp.id = i.business_partner_id
      where i.organization_id = ${organizationId}
        and i.direction = 'ar'
        and i.status in ('issued','partially_paid','paid','credited')
        and i.issue_date >= ${from}
      group by bp.name
      order by 2 desc
      limit 5
    `),
  ).map((r) => ({ label: r.name, value: Number(r.v) }))

  const statusRows = rowsOf<{ status: string; n: string }>(
    await tx.execute(sql`
      select i.status as status, count(*)::int as n
      from invoices i
      where i.organization_id = ${organizationId} and i.direction = 'ar' and i.deleted_at is null
        -- The widget counts SALES INVOICES by status. A credit note has its own
        -- lifecycle and would show up here as an extra "issued", overstating
        -- how much is out with customers.
        and ${sql.raw(excludeCreditNotes('i'))}
      group by 1
    `),
  )
  const STATUS_COLORS: Record<string, string> = {
    draft: '#64748b',
    issued: '#2563eb',
    partially_paid: '#b45309',
    paid: '#0d9488',
    cancelled: '#64748b',
    credited: '#7c3aed',
  }
  const invoiceStatus = statusRows.map((r) => ({
    label: r.status.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    value: Number(r.n),
    color: STATUS_COLORS[r.status],
  }))

  const arApSplit = [
    { label: 'Receivables', parts: [ar.buckets.current, overdue] },
    {
      label: 'Payables',
      parts: [
        ap.buckets.current,
        ap.buckets.d1_30 + ap.buckets.d31_60 + ap.buckets.d61_90 + ap.buckets.d90plus,
      ],
    },
  ]

  // --- document intake density: weekday × recent week ------------------------
  const intakeRows = rowsOf<{ dow: string; wk: string; n: string }>(
    await tx.execute(sql`
      select extract(isodow from i.issue_date)::int::text as dow,
             to_char(i.issue_date, 'IW') as wk,
             count(*)::int as n
      from invoices i
      where i.organization_id = ${organizationId}
        and i.issue_date >= (${today}::date - interval '8 weeks')
      group by 1, 2
    `),
  )
  const weeks = Array.from(new Set(intakeRows.map((r) => r.wk))).sort().slice(-8)
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
  const matrix = dayLabels.map((_, di) =>
    weeks.map((w) => {
      const hit = intakeRows.find((r) => Number(r.dow) === di + 1 && r.wk === w)
      return hit ? Number(hit.n) : 0
    }),
  )

  return {
    kpis,
    revenueByMonth,
    cashByMonth,
    agingBuckets,
    topCustomers,
    invoiceStatus,
    arApSplit,
    intake: {
      rowLabels: dayLabels,
      colLabels: weeks.map((w) => `W${w}`),
      matrix: weeks.length ? matrix : [],
    },
    currency: baseCurrency,
    monthLabels: months.map((m) => m.label),
  }
}
