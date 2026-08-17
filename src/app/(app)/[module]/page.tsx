import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { moduleById, type ModuleId } from '@/modules/registry'
import { listModule } from '@/modules/queries'
import { parseFilter } from '@/modules/filters'
import { listCustomFields, listSavedViews } from '@/modules/custom-fields'
import { formOptions } from '@/modules/write-service'

/** Which custom-field entity a module's records belong to. Modules absent from
 *  this map simply offer no custom fields in the filter builder. */
const CUSTOM_FIELD_ENTITY: Partial<Record<ModuleId, string>> = {
  invoices: 'invoice',
  customers: 'business_partner',
  products: 'product',
  deals: 'deal',
  'sales-orders': 'sales_order',
  'purchase-orders': 'purchase_order',
}
import { getPreferences, getSession, tenantQuery } from '@/server/session'
import { TableModule, type TableRow } from '@/components/table/TableModule'
import { can } from '@/server/context'

export const dynamic = 'force-dynamic'

type Params = { module: string }
type Search = Record<string, string | string[] | undefined>

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v

export async function generateMetadata({ params }: { params: Promise<Params> }) {
  const { module } = await params
  return { title: moduleById(module)?.title ?? 'Not found' }
}

export default async function ModulePage({
  params,
  searchParams,
}: {
  params: Promise<Params>
  searchParams: Promise<Search>
}) {
  const { module: moduleId } = await params
  const sp = await searchParams

  const module = moduleById(moduleId)
  if (!module || module.kind !== 'table') notFound()

  const { ctx } = await getSession()
  if (!ctx) return null

  // Server-side authorisation. Hiding a nav item is a UX affordance; this is
  // the control — a user who types the URL directly still gets nothing.
  if (!can(ctx, module.permission as never)) notFound()

  const prefs = await getPreferences()
  const today = new Date().toISOString().slice(0, 10)

  // The filter arrives as JSON in the query string and is untrusted: parseFilter
  // validates its shape, and compileFilter resolves every field name through a
  // per-module allowlist before any of it reaches SQL.
  let filter
  try {
    const raw = one(sp.filter)
    filter = raw ? parseFilter(JSON.parse(raw)) : undefined
  } catch {
    filter = undefined
  }

  const { result, currency, locale, views, fields, pinned, options } = await tenantQuery(async (tx) => {
    const orgRes = await tx.execute(sql`
      select base_currency, locale from organizations where id = ${ctx.organizationId}
    `)
    const org = (orgRes as unknown as { rows: { base_currency: string; locale: string }[] })
      .rows[0]!

    const result = await listModule(
      tx,
      ctx.organizationId,
      module.id,
      {
        q: one(sp.q),
        status: one(sp.status),
        sort: one(sp.sort),
        dir: one(sp.dir) === 'asc' ? 'asc' : 'desc',
        page: Number(one(sp.page) ?? 1),
        filter,
      },
      today,
    )

    // A deep link — from team chat, the command palette, or a shared URL —
    // must open the record even when it is not on the current page. Without
    // this, `?record=…` silently does nothing for anything past row 50, which
    // is most of the dataset.
    const requestedRecord = one(sp.record)
    let pinned: Record<string, unknown> | undefined
    if (requestedRecord && !result.rows.some((r) => r.id === requestedRecord)) {
      const found = await listModule(
        tx,
        ctx.organizationId,
        module.id,
        {
          filter: { conditions: [{ field: 'id', op: 'eq', value: requestedRecord }] },
          pageSize: 1,
        },
        today,
      )
      pinned = found.rows[0]
    }

    const views = await listSavedViews(tx, ctx.organizationId, module.id, ctx.userId)
    const entityType = CUSTOM_FIELD_ENTITY[module.id]
    const fields = entityType
      ? await listCustomFields(tx, ctx.organizationId, entityType)
      : []

    // Dropdown data for the create form and the action dialogs.
    const options = await formOptions(tx, ctx.organizationId)

    return { result, currency: org.base_currency, locale: org.locale, views, fields, pinned, options }
  })

  return (
    <TableModule
      module={module}
      rows={result.rows as TableRow[]}
      pinnedRecord={(pinned as TableRow | undefined) ?? null}
      total={result.total}
      page={result.page}
      pageCount={result.pageCount}
      statusCounts={result.statusCounts}
      hiddenColumns={prefs.columnVisibility[module.id] ?? {}}
      locale={locale}
      baseCurrency={currency}
      canEdit={can(ctx, 'invoice.update')}
      savedViews={views.map((v) => ({
        id: v.id,
        name: v.name,
        filters: v.filters,
        isDefault: v.isDefault,
        shared: v.shared,
      }))}
      customFields={fields.map((f) => ({ key: f.key, label: f.label }))}
      formOptions={options}
    />
  )
}
