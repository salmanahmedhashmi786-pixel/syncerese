import { sql } from 'drizzle-orm'
import type { TenantTx } from '@/db/tenant'
import { naturalBalance, type AccountType } from './chart-of-accounts'
import { excludeCreditNotes } from './invoice-sql'

/**
 * Financial reports.
 *
 * Every figure here is derived from `journal_lines` — the ledger is the single
 * source of truth. No report reads an invoice total or a cached balance,
 * because the moment a report and the ledger can disagree, one of them is
 * lying and nobody knows which.
 *
 * All amounts are BASE-currency minor units. Only posted entries count;
 * reversed entries stay in the ledger with their reversal, so the two cancel
 * naturally without special-casing.
 */

export type PeriodRange = { from: string; to: string }

type RawBalance = {
  account_id: string
  code: string
  name: string
  type: AccountType
  subtype: string | null
  debit: string
  credit: string
}

async function balances(
  tx: TenantTx,
  organizationId: string,
  opts: { from?: string; to: string },
): Promise<
  {
    accountId: string
    code: string
    name: string
    type: AccountType
    subtype: string | null
    debitMinor: number
    creditMinor: number
    balanceMinor: number
  }[]
> {
  /**
   * The period filter lives in a SUBQUERY, not in a join condition.
   *
   * An earlier version put the date and status predicates on a LEFT JOIN to
   * `journal_entries` while summing columns from `journal_lines`. Because the
   * line row still matched its own join, an out-of-period line contributed its
   * amount anyway and every period report silently returned all-time totals.
   * The subquery makes the filter apply to the rows being summed, which is the
   * only place it can be correct.
   *
   * Still a LEFT JOIN from `accounts` so an account with no movement in the
   * period appears with a zero balance rather than vanishing from the report.
   */
  const res = await tx.execute(sql`
    select
      a.id      as account_id,
      a.code    as code,
      a.name    as name,
      a.type    as type,
      a.subtype as subtype,
      coalesce(sum(x.debit),  0) as debit,
      coalesce(sum(x.credit), 0) as credit
    from accounts a
    left join (
      select
        jl.account_id             as account_id,
        jl.base_debit_minor       as debit,
        jl.base_credit_minor      as credit
      from journal_lines jl
      join journal_entries je on je.id = jl.journal_entry_id
      where jl.organization_id = ${organizationId}
        and je.status in ('posted', 'reversed')
        and je.entry_date <= ${opts.to}
        ${opts.from ? sql`and je.entry_date >= ${opts.from}` : sql``}
    ) x on x.account_id = a.id
    where a.organization_id = ${organizationId}
      and a.is_postable = true
    group by a.id, a.code, a.name, a.type, a.subtype
    order by a.code
  `)

  const rows = (res as unknown as { rows: RawBalance[] }).rows
  return rows.map((r) => {
    const debitMinor = Number(r.debit)
    const creditMinor = Number(r.credit)
    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      debitMinor,
      creditMinor,
      balanceMinor: naturalBalance(r.type, debitMinor, creditMinor),
    }
  })
}

/**
 * Trial balance. The fundamental check: total debits must equal total credits
 * across every account. If `inBalance` is ever false, something has bypassed
 * the ledger's guards and nothing downstream can be trusted.
 */
export async function trialBalance(
  tx: TenantTx,
  organizationId: string,
  range: PeriodRange,
) {
  const rows = await balances(tx, organizationId, { from: range.from, to: range.to })
  const totalDebit = rows.reduce((s, r) => s + r.debitMinor, 0)
  const totalCredit = rows.reduce((s, r) => s + r.creditMinor, 0)

  return {
    range,
    rows: rows.filter((r) => r.debitMinor !== 0 || r.creditMinor !== 0),
    totalDebitMinor: totalDebit,
    totalCreditMinor: totalCredit,
    inBalance: totalDebit === totalCredit,
  }
}

/** Profit and loss for a period. Income and expenses are flow accounts, so this
 *  is always bounded by a date range — never cumulative. */
export async function profitAndLoss(
  tx: TenantTx,
  organizationId: string,
  range: PeriodRange,
) {
  const rows = await balances(tx, organizationId, { from: range.from, to: range.to })

  const income = rows.filter((r) => r.type === 'income' && r.balanceMinor !== 0)
  const expense = rows.filter((r) => r.type === 'expense' && r.balanceMinor !== 0)

  const cogs = expense.filter((r) => r.subtype === 'cogs' || r.subtype === 'purchase_price_variance')
  const opex = expense.filter((r) => r.subtype !== 'cogs' && r.subtype !== 'purchase_price_variance')

  const totalIncome = income.reduce((s, r) => s + r.balanceMinor, 0)
  const totalCogs = cogs.reduce((s, r) => s + r.balanceMinor, 0)
  const totalOpex = opex.reduce((s, r) => s + r.balanceMinor, 0)
  const grossProfit = totalIncome - totalCogs

  return {
    range,
    income,
    costOfSales: cogs,
    operatingExpenses: opex,
    totalIncomeMinor: totalIncome,
    totalCostOfSalesMinor: totalCogs,
    grossProfitMinor: grossProfit,
    grossMarginPct: totalIncome === 0 ? null : (grossProfit / totalIncome) * 100,
    totalOperatingExpensesMinor: totalOpex,
    netProfitMinor: grossProfit - totalOpex,
  }
}

/**
 * Balance sheet as at a date. Cumulative from the beginning of time, not for a
 * range.
 *
 * Current-year earnings are computed rather than stored: income less expenses
 * to date. Without that line the sheet cannot balance, because profit has not
 * yet been closed to retained earnings — this is the single most common reason
 * a hand-rolled balance sheet is out.
 */
export async function balanceSheet(
  tx: TenantTx,
  organizationId: string,
  asOf: string,
  opts: { fiscalYearStart?: string } = {},
) {
  const rows = await balances(tx, organizationId, { to: asOf })

  const assets = rows.filter((r) => r.type === 'asset' && r.balanceMinor !== 0)
  const liabilities = rows.filter((r) => r.type === 'liability' && r.balanceMinor !== 0)
  const equity = rows.filter((r) => r.type === 'equity' && r.balanceMinor !== 0)

  // All-time result: everything the business has ever earned, less what it has
  // spent. Because no year-end closing entry is posted yet, none of this has
  // been moved into a retained-earnings account.
  const accumulated =
    rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.balanceMinor, 0) -
    rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.balanceMinor, 0)

  // Split it at the fiscal year boundary. Reporting the whole accumulated
  // figure as "current year earnings" makes the balance sheet disagree with the
  // P&L for the same date — internally consistent, but wrong on its face to
  // anyone who reads both.
  const fyStart = opts.fiscalYearStart ?? `${asOf.slice(0, 4)}-01-01`
  const currentYear = await balances(tx, organizationId, { from: fyStart, to: asOf })
  const currentYearEarnings =
    currentYear.filter((r) => r.type === 'income').reduce((s, r) => s + r.balanceMinor, 0) -
    currentYear.filter((r) => r.type === 'expense').reduce((s, r) => s + r.balanceMinor, 0)

  const retainedEarnings = accumulated - currentYearEarnings

  const totalAssets = assets.reduce((s, r) => s + r.balanceMinor, 0)
  const totalLiabilities = liabilities.reduce((s, r) => s + r.balanceMinor, 0)
  const totalEquity =
    equity.reduce((s, r) => s + r.balanceMinor, 0) + retainedEarnings + currentYearEarnings

  return {
    asOf,
    fiscalYearStart: fyStart,
    assets,
    liabilities,
    equity,
    /** Prior-year results not yet closed to a retained-earnings account. */
    retainedEarningsMinor: retainedEarnings,
    /** Result for the current fiscal year — ties to the P&L for the same range. */
    currentYearEarningsMinor: currentYearEarnings,
    totalAssetsMinor: totalAssets,
    totalLiabilitiesMinor: totalLiabilities,
    totalEquityMinor: totalEquity,
    /** Assets = liabilities + equity. False means the ledger is broken. */
    balances: totalAssets === totalLiabilities + totalEquity,
    differenceMinor: totalAssets - (totalLiabilities + totalEquity),
  }
}

type CashRow = { subtype: string | null; type: AccountType; debit: string; credit: string }

/**
 * Basic cash flow, direct method.
 *
 * Takes the movement on cash and bank accounts for the period and classifies it
 * by what sat on the OTHER side of each entry — which is the honest way to say
 * where cash came from without a full indirect-method reconciliation.
 */
export async function cashFlow(tx: TenantTx, organizationId: string, range: PeriodRange) {
  const openingRes = await tx.execute(sql`
    select coalesce(sum(jl.base_debit_minor - jl.base_credit_minor), 0) as v
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    join accounts a on a.id = jl.account_id
    where jl.organization_id = ${organizationId}
      and a.subtype in ('bank', 'cash')
      and je.status in ('posted', 'reversed')
      and je.entry_date < ${range.from}
  `)
  const opening = Number((openingRes as unknown as { rows: { v: string }[] }).rows[0]!.v)

  // Counterpart classification: for every entry touching cash, look at the
  // non-cash lines in the same entry.
  const res = await tx.execute(sql`
    with cash_entries as (
      select distinct je.id
      from journal_entries je
      join journal_lines jl on jl.journal_entry_id = je.id
      join accounts a on a.id = jl.account_id
      where je.organization_id = ${organizationId}
        and je.status in ('posted', 'reversed')
        and je.entry_date between ${range.from} and ${range.to}
        and a.subtype in ('bank', 'cash')
    )
    select a.subtype as subtype, a.type as type,
           coalesce(sum(jl.base_debit_minor), 0)  as debit,
           coalesce(sum(jl.base_credit_minor), 0) as credit
    from journal_lines jl
    join accounts a on a.id = jl.account_id
    where jl.journal_entry_id in (select id from cash_entries)
      and jl.organization_id = ${organizationId}
      and (a.subtype is null or a.subtype not in ('bank', 'cash'))
    group by a.subtype, a.type
    order by a.type
  `)

  const counterparts = (res as unknown as { rows: CashRow[] }).rows.map((r) => ({
    subtype: r.subtype,
    type: r.type,
    // A credit on the counterpart side means cash came IN.
    netCashMinor: Number(r.credit) - Number(r.debit),
  }))

  const movementRes = await tx.execute(sql`
    select
      coalesce(sum(jl.base_debit_minor), 0)  as inflow,
      coalesce(sum(jl.base_credit_minor), 0) as outflow
    from journal_lines jl
    join journal_entries je on je.id = jl.journal_entry_id
    join accounts a on a.id = jl.account_id
    where jl.organization_id = ${organizationId}
      and a.subtype in ('bank', 'cash')
      and je.status in ('posted', 'reversed')
      and je.entry_date between ${range.from} and ${range.to}
  `)
  const mv = (movementRes as unknown as { rows: { inflow: string; outflow: string }[] }).rows[0]!
  const inflow = Number(mv.inflow)
  const outflow = Number(mv.outflow)

  return {
    range,
    openingCashMinor: opening,
    inflowMinor: inflow,
    outflowMinor: outflow,
    netMovementMinor: inflow - outflow,
    closingCashMinor: opening + inflow - outflow,
    counterparts,
  }
}

type AgingRow = {
  invoice_id: string
  invoice_no: string
  partner_name: string
  due_date: string
  currency_code: string
  outstanding: string
  base_outstanding: string
  days_overdue: string
}

/** AR / AP aging in the standard buckets. Driven by the invoice subledger with
 *  payments already allocated, so it ties back to the control account. */
export async function agingReport(
  tx: TenantTx,
  organizationId: string,
  opts: { direction: 'ar' | 'ap'; asOf: string },
) {
  const res = await tx.execute(sql`
    select
      i.id           as invoice_id,
      i.invoice_no   as invoice_no,
      bp.name        as partner_name,
      i.due_date     as due_date,
      i.currency_code as currency_code,
      (i.total_minor - i.amount_paid_minor - i.credited_minor) as outstanding,
      round((i.total_minor - i.amount_paid_minor - i.credited_minor) * i.fx_rate) as base_outstanding,
      greatest(0, (${opts.asOf}::date - i.due_date)) as days_overdue
    from invoices i
    join business_partners bp on bp.id = i.business_partner_id
    where i.organization_id = ${organizationId}
      and i.direction = ${opts.direction}
      and i.status in ('issued', 'partially_paid')
      and i.deleted_at is null
      and i.issue_date <= ${opts.asOf}
      and i.total_minor > i.amount_paid_minor + i.credited_minor
      -- Credit notes are excluded, not netted. Every credit note is applied to
      -- the invoice it credits at issue time, so its effect is already in that
      -- invoice's credited_minor above. Listing it again here would subtract
      -- the same credit twice.
      and ${sql.raw(excludeCreditNotes('i'))}
    order by i.due_date
  `)

  const rows = (res as unknown as { rows: AgingRow[] }).rows.map((r) => ({
    invoiceId: r.invoice_id,
    invoiceNo: r.invoice_no,
    partnerName: r.partner_name,
    dueDate: r.due_date,
    currencyCode: r.currency_code,
    outstandingMinor: Number(r.outstanding),
    baseOutstandingMinor: Number(r.base_outstanding),
    daysOverdue: Number(r.days_overdue),
  }))

  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 }
  for (const r of rows) {
    const v = r.baseOutstandingMinor
    if (r.daysOverdue <= 0) buckets.current += v
    else if (r.daysOverdue <= 30) buckets.d1_30 += v
    else if (r.daysOverdue <= 60) buckets.d31_60 += v
    else if (r.daysOverdue <= 90) buckets.d61_90 += v
    else buckets.d90plus += v
  }

  return {
    asOf: opts.asOf,
    direction: opts.direction,
    rows,
    buckets,
    totalOutstandingMinor: rows.reduce((s, r) => s + r.baseOutstandingMinor, 0),
  }
}
