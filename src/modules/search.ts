import { sql } from 'drizzle-orm'
import type { TenantTx } from '@/db/tenant'
import type { RequestContext } from '@/server/context'
import { can } from '@/server/context'
import { containsPattern } from '@/lib/like'
import type { ModuleId } from './registry'

/**
 * Global search across core objects (MUST DO #11).
 *
 * PERMISSION-AWARE: each source is skipped entirely unless the caller holds the
 * module's read permission. A search box that returns a record the user cannot
 * open is a disclosure — the title and amount alone leak what was meant to be
 * hidden.
 *
 * Tenant scoping is inherited from RLS; the explicit predicate is there so the
 * planner uses the tenant index.
 */

export type SearchHit = {
  module: ModuleId
  id: string
  /** Document number or code — what the user actually typed to find it. */
  reference: string
  title: string
  subtitle: string | null
  status: string | null
  amountMinor: number | null
  currencyCode: string | null
  date: string | null
}

export type SearchResult = {
  query: string
  hits: SearchHit[]
  /** Per-module counts, so the UI can group without a second pass. */
  counts: Record<string, number>
  truncated: boolean
}

const PER_SOURCE = 8
const rowsOf = <T>(res: unknown): T[] => (res as { rows: T[] }).rows

export async function globalSearch(
  tx: TenantTx,
  ctx: RequestContext,
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchResult> {
  const raw = query.trim()
  if (raw.length < 2) {
    return { query: raw, hits: [], counts: {}, truncated: false }
  }

  // LIKE metacharacters escaped: without this, a user typing "%" matches every
  // row and the search box becomes a one-query export of the whole tenant.
  const needle = containsPattern(raw)
  const org = ctx.organizationId
  const perSource = Math.min(opts.limit ?? PER_SOURCE, 25)
  const hits: SearchHit[] = []

  if (can(ctx, 'invoice.read')) {
    const rows = rowsOf<Record<string, string | null>>(
      await tx.execute(sql`
        select i.id, i.invoice_no as reference, bp.name as title,
               i.direction as subtitle, i.status,
               i.total_minor as amount, i.currency_code, i.issue_date as date
        from invoices i
        join business_partners bp on bp.id = i.business_partner_id
        where i.organization_id = ${org} and i.deleted_at is null
          and (lower(i.invoice_no) like ${needle} or lower(bp.name) like ${needle})
        order by i.issue_date desc
        limit ${perSource}
      `),
    )
    hits.push(...rows.map((r) => toHit('invoices', r)))
  }

  if (can(ctx, 'crm.read')) {
    const rows = rowsOf<Record<string, string | null>>(
      await tx.execute(sql`
        select bp.id, bp.partner_no as reference, bp.name as title,
               bp.country_code as subtitle,
               case when bp.is_customer and bp.is_supplier then 'both'
                    when bp.is_customer then 'customer'
                    when bp.is_supplier then 'supplier' else 'prospect' end as status,
               null::bigint as amount, bp.currency_code, null::date as date
        from business_partners bp
        where bp.organization_id = ${org} and bp.archived_at is null
          and (lower(bp.name) like ${needle} or lower(bp.partner_no) like ${needle}
               or lower(coalesce(bp.tax_id,'')) like ${needle})
        order by bp.name
        limit ${perSource}
      `),
    )
    hits.push(...rows.map((r) => toHit('customers', r)))

    const dealRows = rowsOf<Record<string, string | null>>(
      await tx.execute(sql`
        select d.id, d.deal_no as reference, d.name as title,
               bp.name as subtitle, d.status,
               d.amount_minor as amount, d.currency_code, d.expected_close_date as date
        from deals d
        left join business_partners bp on bp.id = d.business_partner_id
        where d.organization_id = ${org}
          and (lower(d.name) like ${needle} or lower(d.deal_no) like ${needle})
        order by d.expected_close_date desc nulls last
        limit ${perSource}
      `),
    )
    hits.push(...dealRows.map((r) => toHit('deals', r)))
  }

  if (can(ctx, 'sales.read')) {
    const rows = rowsOf<Record<string, string | null>>(
      await tx.execute(sql`
        select so.id, so.order_no as reference, bp.name as title,
               so.customer_reference as subtitle, so.status,
               so.total_minor as amount, so.currency_code, so.order_date as date
        from sales_orders so
        join business_partners bp on bp.id = so.business_partner_id
        where so.organization_id = ${org}
          and (lower(so.order_no) like ${needle} or lower(bp.name) like ${needle}
               or lower(coalesce(so.customer_reference,'')) like ${needle})
        order by so.order_date desc
        limit ${perSource}
      `),
    )
    hits.push(...rows.map((r) => toHit('sales-orders', r)))
  }

  if (can(ctx, 'purchase.read')) {
    const rows = rowsOf<Record<string, string | null>>(
      await tx.execute(sql`
        select po.id, po.po_no as reference, bp.name as title,
               null::text as subtitle, po.status,
               po.total_minor as amount, po.currency_code, po.order_date as date
        from purchase_orders po
        join business_partners bp on bp.id = po.supplier_id
        where po.organization_id = ${org}
          and (lower(po.po_no) like ${needle} or lower(bp.name) like ${needle})
        order by po.order_date desc
        limit ${perSource}
      `),
    )
    hits.push(...rows.map((r) => toHit('purchase-orders', r)))
  }

  if (can(ctx, 'inventory.read')) {
    const rows = rowsOf<Record<string, string | null>>(
      await tx.execute(sql`
        select p.id, p.sku as reference, p.name as title,
               p.type as subtitle, p.type as status,
               p.sales_price_minor as amount, p.currency_code, null::date as date
        from products p
        where p.organization_id = ${org} and p.archived_at is null
          and (lower(p.sku) like ${needle} or lower(p.name) like ${needle}
               or lower(coalesce(p.barcode,'')) like ${needle})
        order by p.sku
        limit ${perSource}
      `),
    )
    hits.push(...rows.map((r) => toHit('products', r)))
  }

  // An exact reference match is almost always what was wanted — rank it first
  // rather than making the user scan for it.
  const exact = raw.toLowerCase()
  hits.sort((a, b) => {
    const aExact = a.reference.toLowerCase() === exact ? 0 : 1
    const bExact = b.reference.toLowerCase() === exact ? 0 : 1
    if (aExact !== bExact) return aExact - bExact
    const aStarts = a.reference.toLowerCase().startsWith(exact) ? 0 : 1
    const bStarts = b.reference.toLowerCase().startsWith(exact) ? 0 : 1
    return aStarts - bStarts
  })

  const counts: Record<string, number> = {}
  for (const h of hits) counts[h.module] = (counts[h.module] ?? 0) + 1

  return {
    query: raw,
    hits,
    counts,
    truncated: Object.values(counts).some((n) => n >= perSource),
  }
}

function toHit(module: ModuleId, r: Record<string, unknown>): SearchHit {
  return {
    module,
    id: String(r.id),
    reference: String(r.reference ?? ''),
    title: String(r.title ?? ''),
    subtitle: r.subtitle ? String(r.subtitle) : null,
    status: r.status ? String(r.status) : null,
    amountMinor: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    currencyCode: r.currency_code ? String(r.currency_code) : null,
    date: r.date ? String(r.date) : null,
  }
}
