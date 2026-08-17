import { sql } from 'drizzle-orm'
import { getSession, tenantQuery } from '@/server/session'
import { balanceSheet, cashFlow, profitAndLoss, trialBalance } from '@/finance/reports'
import { ReportsView } from './ReportsView'

export const metadata = { title: 'Reports & analytics' }
export const dynamic = 'force-dynamic'

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { ctx } = await getSession()
  if (!ctx) return null

  const sp = await searchParams
  const today = new Date().toISOString().slice(0, 10)
  const year = today.slice(0, 4)
  const from = (Array.isArray(sp.from) ? sp.from[0] : sp.from) ?? `${year}-01-01`
  const to = (Array.isArray(sp.to) ? sp.to[0] : sp.to) ?? today

  const data = await tenantQuery(async (tx) => {
    const orgRes = await tx.execute(sql`
      select base_currency, locale, fiscal_year_start_month
        from organizations where id = ${ctx.organizationId}
    `)
    const org = (
      orgRes as unknown as {
        rows: { base_currency: string; locale: string; fiscal_year_start_month: number }[]
      }
    ).rows[0]!

    // The fiscal year containing `to` — not simply January, since a tenant may
    // run an April–March or July–June year.
    const startMonth = Number(org.fiscal_year_start_month) || 1
    const toDate = new Date(`${to}T00:00:00Z`)
    const fyYear =
      toDate.getUTCMonth() + 1 >= startMonth
        ? toDate.getUTCFullYear()
        : toDate.getUTCFullYear() - 1
    const fiscalYearStart = `${fyYear}-${String(startMonth).padStart(2, '0')}-01`

    const [pl, bs, cf, tb] = await Promise.all([
      profitAndLoss(tx, ctx.organizationId, { from, to }),
      balanceSheet(tx, ctx.organizationId, to, { fiscalYearStart }),
      cashFlow(tx, ctx.organizationId, { from, to }),
      trialBalance(tx, ctx.organizationId, { from, to }),
    ])

    return { pl, bs, cf, tb, currency: org.base_currency, locale: org.locale }
  })

  return <ReportsView {...data} from={from} to={to} />
}
