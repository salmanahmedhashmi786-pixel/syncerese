import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { ThemeRoot } from '@/components/shell/ThemeRoot'
import { Toaster } from '@/components/shell/Toaster'
import { Sidebar } from '@/components/shell/Sidebar'
import { AppFrame } from '@/components/shell/AppFrame'
import { getPreferences, getSession, tenantQuery } from '@/server/session'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { ctx, organizations } = await getSession()
  if (!ctx) redirect('/sign-in')

  const prefs = await getPreferences()
  const org = organizations.find((o) => o.organizationId === ctx.organizationId)

  // Nav badges: counts a user would want to act on, not vanity metrics.
  const { badges, locale, currency } = await tenantQuery(async (tx) => {
    const res = await tx.execute(sql`
      select
        (select count(*)::int from invoices
          where organization_id = ${ctx.organizationId}
            and status in ('issued','partially_paid')
            and due_date < current_date) as overdue,
        (select count(*)::int from bank_transactions
          where organization_id = ${ctx.organizationId}
            and reconciliation_status = 'unreconciled') as unreconciled,
        (select locale from organizations where id = ${ctx.organizationId}) as locale,
        (select base_currency from organizations where id = ${ctx.organizationId}) as currency
    `)
    const row = (
      res as unknown as {
        rows: { overdue: number; unreconciled: number; locale: string; currency: string }[]
      }
    ).rows[0]!
    return {
      badges: { invoices: Number(row.overdue), banking: Number(row.unreconciled) },
      locale: row.locale,
      currency: row.currency,
    }
  })

  const initials =
    (org?.organizationName ?? 'SY')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || 'SY'

  return (
    <ThemeRoot
      initial={{
        theme: prefs.theme,
        accent: prefs.accent,
        density: prefs.density,
        fontScale: prefs.fontScale,
        sidebarCollapsed: prefs.sidebarCollapsed,
      }}
    >
      <Toaster>
        <Sidebar organizationName={org?.organizationName ?? ''} badges={badges} />
        <AppFrame
          userInitials={initials}
          organizationName={org?.organizationName ?? ''}
          locale={locale}
          currency={currency}
        >
          {children}
        </AppFrame>
      </Toaster>
    </ThemeRoot>
  )
}
