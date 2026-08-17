import { sql } from 'drizzle-orm'
import { getPreferences, getSession, tenantQuery } from '@/server/session'
import { loadDashboard } from '@/modules/dashboard'
import { DashboardGrid } from './DashboardGrid'

export const metadata = { title: 'Executive dashboard' }
export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const { ctx } = await getSession()
  if (!ctx) return null

  const today = new Date().toISOString().slice(0, 10)

  const { data, currency, locale } = await tenantQuery(async (tx) => {
    const orgRes = await tx.execute(sql`
      select base_currency, locale from organizations where id = ${ctx.organizationId}
    `)
    const org = (orgRes as unknown as { rows: { base_currency: string; locale: string }[] })
      .rows[0]!
    const data = await loadDashboard(tx, ctx.organizationId, org.base_currency, today)
    return { data, currency: org.base_currency, locale: org.locale }
  })

  // The saved widget arrangement is read on the SERVER so the first paint is
  // already the user's layout. Persisting it without loading it — which is what
  // step 4 shipped — meant the editor appeared to work and silently reset on
  // every navigation.
  const prefs = await getPreferences()

  return (
    <DashboardGrid
      data={data}
      currency={currency}
      locale={locale}
      savedLayout={prefs.dashboardLayout}
    />
  )
}
