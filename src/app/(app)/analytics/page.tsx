import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getSession, tenantQuery } from '@/server/session'
import { can } from '@/server/context'
import { availableDimensions, customerValue, demographics } from '@/modules/demographics'
import { AnalyticsView } from './AnalyticsView'

export const metadata = { title: 'Business analytics' }
export const dynamic = 'force-dynamic'

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { ctx } = await getSession()
  if (!ctx) return null
  if (!can(ctx, 'crm.read')) notFound()

  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

  const today = new Date().toISOString().slice(0, 10)
  const from = one(sp.from) ?? `${today.slice(0, 4)}-01-01`
  const to = one(sp.to) ?? today
  const dimensionKey = one(sp.dim) ?? 'country'

  const data = await tenantQuery(async (tx) => {
    const orgRes = await tx.execute(sql`
      select base_currency, locale from organizations where id = ${ctx.organizationId}
    `)
    const org = (orgRes as unknown as { rows: { base_currency: string; locale: string }[] })
      .rows[0]!

    const [dimensions, result, customers] = await Promise.all([
      availableDimensions(tx, ctx.organizationId),
      demographics(tx, ctx.organizationId, { dimensionKey, from, to, asOf: today }),
      customerValue(tx, ctx.organizationId, { asOf: today, limit: 25 }),
    ])

    return {
      dimensions,
      result,
      customers,
      currency: org.base_currency,
      locale: org.locale,
    }
  })

  return <AnalyticsView {...data} from={from} to={to} />
}
