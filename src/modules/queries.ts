import { sql, type SQL } from 'drizzle-orm'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { containsPattern } from '@/lib/like'
import { compileFilter, type Filter } from './filters'
import type { ModuleId } from './registry'
import { excludeCreditNotes, isCreditNote, outstanding, signedBaseTotal } from '@/finance/invoice-sql'

/**
 * Server-side list queries.
 *
 * MUST DO #17: filtering, sorting, search and pagination all happen in SQL.
 * The prototype does this client-side over fixed arrays for demo purposes;
 * production must never load a tenant's whole dataset into the client. A
 * customer with 80,000 invoices is not an edge case.
 *
 * Every query is tenant-scoped twice over: RLS filters rows regardless, and the
 * SQL carries the predicate anyway so the query plan uses the tenant index.
 */

export type ListParams = {
  q?: string
  status?: string
  sort?: string
  dir?: 'asc' | 'desc'
  page?: number
  pageSize?: number
  /** Structured filter from a saved view or the filter drawer. Compiles to
   *  SQL through the allowlist in `filters.ts` — never interpolated. */
  filter?: Filter
}

export type ListResult = {
  rows: Record<string, unknown>[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  /** Counts per status value, for the filter chips. Computed over the search
   *  result but BEFORE the status filter, so the chips keep their counts when
   *  one is selected. */
  statusCounts: Record<string, number>
}

const PAGE_SIZE_DEFAULT = 50
const PAGE_SIZE_MAX = 200

/**
 * Sortable columns are an allowlist per module, not free text.
 *
 * A sort key goes into the SQL as an identifier, which cannot be a bind
 * parameter — so it must never come straight from the query string. This maps a
 * caller-supplied key to a known-safe expression.
 */
const SORTABLE: Record<ModuleId, Record<string, string>> = {
  dashboard: {},
  reports: {},
  settings: {},
  analytics: {},
  chat: {},
  invoices: {
    invoiceNo: 'i.invoice_no',
    partnerName: 'bp.name',
    direction: 'i.direction',
    status: 'i.status',
    subtotalMinor: 'i.subtotal_minor',
    taxTotalMinor: 'i.tax_total_minor',
    totalMinor: 'i.total_minor',
    outstandingMinor: '(i.total_minor - i.amount_paid_minor - i.credited_minor)',
    issueDate: 'i.issue_date',
    dueDate: 'i.due_date',
    aging: 'i.due_date',
  },
  journal: {
    entryNo: 'je.entry_no',
    entryDate: 'je.entry_date',
    description: 'je.description',
    sourceType: 'je.source_type',
    status: 'je.status',
  },
  banking: {
    valueDate: 'bt.value_date',
    description: 'bt.description',
    counterpartyName: 'bt.counterparty_name',
    reconciliationStatus: 'bt.reconciliation_status',
    amountMinor: 'bt.amount_minor',
    counterpartyIban: 'bt.counterparty_iban',
  },
  customers: {
    partnerNo: 'bp.partner_no',
    name: 'bp.name',
    countryCode: 'bp.country_code',
    taxId: 'bp.tax_id',
    creditLimitMinor: 'bp.credit_limit_minor',
    paymentTermsDays: 'bp.payment_terms_days',
  },
  'sales-orders': {
    orderNo: 'so.order_no',
    partnerName: 'bp.name',
    status: 'so.status',
    subtotalMinor: 'so.subtotal_minor',
    totalMinor: 'so.total_minor',
    orderDate: 'so.order_date',
    requestedDeliveryDate: 'so.requested_delivery_date',
  },
  deals: {
    dealNo: 'd.deal_no',
    name: 'd.name',
    status: 'd.status',
    amountMinor: 'd.amount_minor',
    expectedCloseDate: 'd.expected_close_date',
    source: 'd.source',
    stageName: 'ps.name',
  },
  products: {
    sku: 'p.sku',
    name: 'p.name',
    type: 'p.type',
    reorderPoint: 'p.reorder_point',
    salesPriceMinor: 'p.sales_price_minor',
  },
  'purchase-orders': {
    poNo: 'po.po_no',
    supplierName: 'bp.name',
    status: 'po.status',
    subtotalMinor: 'po.subtotal_minor',
    totalMinor: 'po.total_minor',
    orderDate: 'po.order_date',
    expectedDate: 'po.expected_date',
  },
}

function orderBy(module: ModuleId, sort: string | undefined, dir: string | undefined, fallback: string): SQL {
  const allowed = SORTABLE[module]
  const expr = sort ? allowed[sort] : undefined
  const direction = dir === 'asc' ? 'asc' : 'desc'
  return sql.raw(`${expr ?? fallback} ${direction} nulls last`)
}

function paging(params: ListParams) {
  const pageSize = Math.min(Math.max(Number(params.pageSize) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX)
  const page = Math.max(Number(params.page) || 1, 1)
  return { pageSize, offset: (page - 1) * pageSize, page }
}

const rowsOf = <T>(res: unknown): T[] => (res as { rows: T[] }).rows

/**
 * Free-text search matches ALL columns of the module including hidden ones,
 * per the handoff's interaction spec. Implemented as an ILIKE across a
 * concatenated expression — adequate to six figures of rows, and the point at
 * which it stops being adequate is the point to add a tsvector column, not to
 * move filtering into the client.
 */
const like = (q: string) => containsPattern(q)

export async function listModule(
  tx: TenantTx,
  organizationId: string,
  module: ModuleId,
  params: ListParams,
  today: string,
): Promise<ListResult> {
  switch (module) {
    case 'invoices':
      return listInvoices(tx, organizationId, params, today)
    case 'journal':
      return listJournal(tx, organizationId, params)
    case 'banking':
      return listBanking(tx, organizationId, params)
    case 'customers':
      return listPartners(tx, organizationId, params)
    case 'sales-orders':
      return listSalesOrders(tx, organizationId, params)
    case 'purchase-orders':
      return listPurchaseOrders(tx, organizationId, params)
    case 'products':
      return listProducts(tx, organizationId, params)
    case 'deals':
      return listDeals(tx, organizationId, params)
    default:
      throw new AppError('NOT_FOUND', `Module "${module}" has no list view`)
  }
}

/** Shared shape for the status-counted list modules. */
function assemble(
  rows: Record<string, unknown>[],
  counts: { status: string; n: string }[],
  params: ListParams,
  pageSize: number,
  page: number,
): ListResult {
  const total =
    params.status && params.status !== 'all'
      ? Number(counts.find((c) => c.status === params.status)?.n ?? 0)
      : counts.reduce((s, c) => s + Number(c.n), 0)
  return {
    rows,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    statusCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
  }
}

async function listSalesOrders(
  tx: TenantTx,
  organizationId: string,
  params: ListParams,
): Promise<ListResult> {
  const { pageSize, offset, page } = paging(params)
  const search = params.q?.trim()
    ? sql`and (lower(so.order_no) like ${like(params.q)}
              or lower(bp.name) like ${like(params.q)}
              or lower(coalesce(so.customer_reference, '')) like ${like(params.q)})`
    : sql``
  const statusFilter =
    params.status && params.status !== 'all' ? sql`and so.status = ${params.status}` : sql``

  const base = sql`
    from sales_orders so
    join business_partners bp on bp.id = so.business_partner_id
    where so.organization_id = ${organizationId}
      ${search}
      ${compileFilter('sales-orders', params.filter, { customFieldsColumn: 'so.custom_fields' })}
  `

  const counts = rowsOf<{ status: string; n: string }>(
    await tx.execute(sql`select so.status as status, count(*)::int as n ${base} group by so.status`),
  )

  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select
        so.id,
        so.order_no                as "orderNo",
        bp.name                    as "partnerName",
        so.status,
        so.subtotal_minor          as "subtotalMinor",
        so.total_minor             as "totalMinor",
        so.currency_code           as "currencyCode",
        so.order_date              as "orderDate",
        so.requested_delivery_date as "requestedDeliveryDate",
        (select u.name from users u where u.id = so.owner_user_id) as "ownerName",
        (select count(*)::int from sales_order_lines l where l.sales_order_id = so.id) as "lineCount",
        coalesce((
          select round(100.0 * sum(l.qty_delivered) / nullif(sum(l.quantity), 0))
          from sales_order_lines l where l.sales_order_id = so.id
        ), 0) as "fulfilmentPct"
      ${base} ${statusFilter}
      order by ${orderBy('sales-orders', params.sort, params.dir, 'so.order_date')}
      limit ${pageSize} offset ${offset}
    `),
  ).map((r) => ({ ...r, fulfilment: `${r.fulfilmentPct ?? 0}%` }))

  return assemble(rows, counts, params, pageSize, page)
}

async function listPurchaseOrders(
  tx: TenantTx,
  organizationId: string,
  params: ListParams,
): Promise<ListResult> {
  const { pageSize, offset, page } = paging(params)
  const search = params.q?.trim()
    ? sql`and (lower(po.po_no) like ${like(params.q)} or lower(bp.name) like ${like(params.q)})`
    : sql``
  const statusFilter =
    params.status && params.status !== 'all' ? sql`and po.status = ${params.status}` : sql``

  const base = sql`
    from purchase_orders po
    join business_partners bp on bp.id = po.supplier_id
    where po.organization_id = ${organizationId}
      ${search}
      ${compileFilter('purchase-orders', params.filter, { customFieldsColumn: 'po.custom_fields' })}
  `

  const counts = rowsOf<{ status: string; n: string }>(
    await tx.execute(sql`select po.status as status, count(*)::int as n ${base} group by po.status`),
  )

  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select
        po.id,
        po.po_no          as "poNo",
        bp.name           as "supplierName",
        po.status,
        po.subtotal_minor as "subtotalMinor",
        po.total_minor    as "totalMinor",
        po.currency_code  as "currencyCode",
        po.order_date     as "orderDate",
        po.expected_date  as "expectedDate",
        (select u.name from users u where u.id = po.buyer_user_id) as "buyerName",
        (select count(*)::int from purchase_order_lines l where l.purchase_order_id = po.id) as "lineCount",
        coalesce((
          select round(100.0 * sum(l.qty_received) / nullif(sum(l.quantity), 0))
          from purchase_order_lines l where l.purchase_order_id = po.id
        ), 0) as "fulfilmentPct"
      ${base} ${statusFilter}
      order by ${orderBy('purchase-orders', params.sort, params.dir, 'po.order_date')}
      limit ${pageSize} offset ${offset}
    `),
  ).map((r) => ({ ...r, fulfilment: `${r.fulfilmentPct ?? 0}%` }))

  return assemble(rows, counts, params, pageSize, page)
}

async function listProducts(
  tx: TenantTx,
  organizationId: string,
  params: ListParams,
): Promise<ListResult> {
  const { pageSize, offset, page } = paging(params)
  const search = params.q?.trim()
    ? sql`and (lower(p.sku) like ${like(params.q)}
              or lower(p.name) like ${like(params.q)}
              or lower(coalesce(p.barcode, '')) like ${like(params.q)})`
    : sql``
  const statusFilter =
    params.status && params.status !== 'all' ? sql`and p.type = ${params.status}` : sql``

  const base = sql`
    from products p
    where p.organization_id = ${organizationId}
      and p.archived_at is null
      ${search}
      ${compileFilter('products', params.filter, { customFieldsColumn: 'p.custom_fields' })}
  `

  const counts = rowsOf<{ status: string; n: string }>(
    await tx.execute(sql`select p.type as status, count(*)::int as n ${base} group by p.type`),
  )

  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select
        p.id,
        p.sku,
        p.name,
        p.type,
        p.reorder_point      as "reorderPoint",
        p.sales_price_minor  as "salesPriceMinor",
        coalesce(p.currency_code,
          (select base_currency from organizations where id = p.organization_id)) as "currencyCode",
        coalesce((select sum(sl.qty_on_hand) from stock_levels sl where sl.product_id = p.id), 0)
          as "qtyOnHandRaw",
        coalesce((
          select round(sum(sl.qty_on_hand * sl.avg_cost_minor) / nullif(sum(sl.qty_on_hand), 0))
          from stock_levels sl where sl.product_id = p.id
        ), p.cost_minor)::bigint as "avgCostMinor",
        coalesce((
          select round(sum(sl.qty_on_hand * sl.avg_cost_minor))
          from stock_levels sl where sl.product_id = p.id
        ), 0)::bigint as "stockValueMinor"
      ${base} ${statusFilter}
      order by ${orderBy('products', params.sort, params.dir, 'p.sku')}
      limit ${pageSize} offset ${offset}
    `),
  ).map((r) => {
    const onHand = Number(r.qtyOnHandRaw ?? 0)
    const reorder = r.reorderPoint === null ? null : Number(r.reorderPoint)
    // Replenishment signal is derived, not stored — it changes with every
    // movement and there is no event to write when it crosses the line.
    const signal =
      r.type !== 'stock'
        ? '—'
        : reorder === null
          ? 'Not tracked'
          : onHand <= 0
            ? 'Out of stock'
            : onHand <= reorder
              ? 'Reorder'
              : 'OK'
    // Postgres returns numeric(18,4) as a zero-padded string ("40.0000").
    // Quantities are whole units far more often than not, so trim the noise
    // rather than showing four decimals on every row.
    return { ...r, qtyOnHand: onHand, reorderPoint: reorder, signal }
  })

  return assemble(rows, counts, params, pageSize, page)
}

async function listDeals(
  tx: TenantTx,
  organizationId: string,
  params: ListParams,
): Promise<ListResult> {
  const { pageSize, offset, page } = paging(params)
  const search = params.q?.trim()
    ? sql`and (lower(d.name) like ${like(params.q)}
              or lower(d.deal_no) like ${like(params.q)}
              or lower(coalesce(d.source, '')) like ${like(params.q)}
              or lower(coalesce(bp.name, '')) like ${like(params.q)})`
    : sql``
  const statusFilter =
    params.status && params.status !== 'all' ? sql`and d.status = ${params.status}` : sql``

  const base = sql`
    from deals d
    left join business_partners bp on bp.id = d.business_partner_id
    join pipeline_stages ps on ps.id = d.stage_id
    where d.organization_id = ${organizationId}
      ${search}
      ${compileFilter('deals', params.filter, { customFieldsColumn: 'd.custom_fields' })}
  `

  const counts = rowsOf<{ status: string; n: string }>(
    await tx.execute(sql`select d.status as status, count(*)::int as n ${base} group by d.status`),
  )

  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select
        d.id,
        d.deal_no             as "dealNo",
        d.name,
        bp.name               as "partnerName",
        ps.name               as "stageName",
        ps.probability_pct    as "probabilityPct",
        d.status,
        d.amount_minor        as "amountMinor",
        round(d.amount_minor * ps.probability_pct / 100.0)::bigint as "weightedMinor",
        d.currency_code       as "currencyCode",
        d.expected_close_date as "expectedCloseDate",
        d.source
      ${base} ${statusFilter}
      order by ${orderBy('deals', params.sort, params.dir, 'd.expected_close_date')}
      limit ${pageSize} offset ${offset}
    `),
  )

  return assemble(rows, counts, params, pageSize, page)
}

async function listInvoices(
  tx: TenantTx,
  organizationId: string,
  params: ListParams,
  today: string,
): Promise<ListResult> {
  const { pageSize, offset, page } = paging(params)
  const search = params.q?.trim()
    ? sql`and (lower(i.invoice_no) like ${like(params.q)}
              or lower(bp.name) like ${like(params.q)}
              or lower(coalesce(i.notes, '')) like ${like(params.q)}
              or lower(coalesce(bp.tax_id, '')) like ${like(params.q)}
              or i.total_minor::text like ${like(params.q)})`
    : sql``

  const statusFilter =
    params.status && params.status !== 'all' ? sql`and i.status = ${params.status}` : sql``

  const base = sql`
    from invoices i
    join business_partners bp on bp.id = i.business_partner_id
    where i.organization_id = ${organizationId}
      and i.deleted_at is null
      ${search}
      ${compileFilter('invoices', params.filter, { customFieldsColumn: 'i.custom_fields' })}
  `

  const counts = rowsOf<{ status: string; n: string }>(
    await tx.execute(sql`select i.status as status, count(*)::int as n ${base} group by i.status`),
  )

  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select
        i.id,
        i.invoice_no                             as "invoiceNo",
        bp.name                                  as "partnerName",
        i.business_partner_id                    as "partnerId",
        case
          when ${sql.raw(isCreditNote('i'))} and i.direction = 'ar' then 'Credit note'
          when ${sql.raw(isCreditNote('i'))} then 'Supplier credit'
          when i.direction = 'ar' then 'Sales invoice'
          else 'Purchase bill'
        end as direction,
        i.status,
        i.subtotal_minor                         as "subtotalMinor",
        i.tax_total_minor                        as "taxTotalMinor",
        i.total_minor                            as "totalMinor",
        (i.total_minor - i.amount_paid_minor - i.credited_minor) as "outstandingMinor",
        i.currency_code                          as "currencyCode",
        i.issue_date                             as "issueDate",
        i.due_date                               as "dueDate",
        case
          when i.status in ('paid','cancelled','credited') then null
          when ${today}::date > i.due_date then (${today}::date - i.due_date)
          else 0
        end                                      as "agingDays"
      ${base} ${statusFilter}
      order by ${orderBy('invoices', params.sort, params.dir, 'i.issue_date')}
      limit ${pageSize} offset ${offset}
    `),
  )

  const total = params.status && params.status !== 'all'
    ? Number(counts.find((c) => c.status === params.status)?.n ?? 0)
    : counts.reduce((s, c) => s + Number(c.n), 0)

  return {
    rows: rows.map((r) => ({
      ...r,
      // Overdue is a derived presentation state, not a stored one — an invoice
      // becomes overdue by the passage of time, with no event to write.
      status:
        r.agingDays && Number(r.agingDays) > 0 && r.status !== 'paid' ? 'overdue' : r.status,
      aging: r.agingDays == null ? '—' : Number(r.agingDays) > 0 ? `${r.agingDays} d` : '—',
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    statusCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
  }
}

async function listJournal(
  tx: TenantTx,
  organizationId: string,
  params: ListParams,
): Promise<ListResult> {
  const { pageSize, offset, page } = paging(params)
  const search = params.q?.trim()
    ? sql`and (lower(coalesce(je.description, '')) like ${like(params.q)}
              or je.entry_no::text like ${like(params.q)}
              or lower(je.source_type) like ${like(params.q)})`
    : sql``
  const statusFilter =
    params.status && params.status !== 'all' ? sql`and je.status = ${params.status}` : sql``

  const base = sql`
    from journal_entries je
    where je.organization_id = ${organizationId}
      ${search}
      ${compileFilter('journal', params.filter)}
  `

  const counts = rowsOf<{ status: string; n: string }>(
    await tx.execute(sql`select je.status as status, count(*)::int as n ${base} group by je.status`),
  )

  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select
        je.id,
        je.entry_no      as "entryNo",
        je.entry_date    as "entryDate",
        je.description,
        je.source_type   as "sourceType",
        je.status,
        (select count(*)::int from journal_lines jl where jl.journal_entry_id = je.id) as "lineCount",
        (select coalesce(sum(jl.base_debit_minor), 0)::bigint
           from journal_lines jl where jl.journal_entry_id = je.id) as "totalMinor"
      ${base} ${statusFilter}
      order by ${orderBy('journal', params.sort, params.dir, 'je.entry_no')}
      limit ${pageSize} offset ${offset}
    `),
  )

  const total = params.status && params.status !== 'all'
    ? Number(counts.find((c) => c.status === params.status)?.n ?? 0)
    : counts.reduce((s, c) => s + Number(c.n), 0)

  return {
    rows,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    statusCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
  }
}

async function listBanking(
  tx: TenantTx,
  organizationId: string,
  params: ListParams,
): Promise<ListResult> {
  const { pageSize, offset, page } = paging(params)
  const search = params.q?.trim()
    ? sql`and (lower(coalesce(bt.description, '')) like ${like(params.q)}
              or lower(coalesce(bt.counterparty_name, '')) like ${like(params.q)}
              or lower(coalesce(bt.counterparty_iban, '')) like ${like(params.q)})`
    : sql``
  const statusFilter =
    params.status && params.status !== 'all'
      ? sql`and bt.reconciliation_status = ${params.status}`
      : sql``

  const base = sql`
    from bank_transactions bt
    join bank_accounts ba on ba.id = bt.bank_account_id
    where bt.organization_id = ${organizationId}
      ${search}
      ${compileFilter('banking', params.filter)}
  `

  const counts = rowsOf<{ status: string; n: string }>(
    await tx.execute(
      sql`select bt.reconciliation_status as status, count(*)::int as n ${base} group by bt.reconciliation_status`,
    ),
  )

  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select
        bt.id,
        bt.value_date             as "valueDate",
        bt.description,
        bt.counterparty_name      as "counterpartyName",
        bt.counterparty_iban      as "counterpartyIban",
        bt.reconciliation_status  as "reconciliationStatus",
        bt.amount_minor           as "amountMinor",
        bt.currency_code          as "currencyCode",
        ba.name                   as "bankAccountName"
      ${base} ${statusFilter}
      order by ${orderBy('banking', params.sort, params.dir, 'bt.value_date')}
      limit ${pageSize} offset ${offset}
    `),
  )

  const total = params.status && params.status !== 'all'
    ? Number(counts.find((c) => c.status === params.status)?.n ?? 0)
    : counts.reduce((s, c) => s + Number(c.n), 0)

  return {
    rows,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    statusCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
  }
}

async function listPartners(
  tx: TenantTx,
  organizationId: string,
  params: ListParams,
): Promise<ListResult> {
  const { pageSize, offset, page } = paging(params)
  const search = params.q?.trim()
    ? sql`and (lower(bp.name) like ${like(params.q)}
              or lower(bp.partner_no) like ${like(params.q)}
              or lower(coalesce(bp.tax_id, '')) like ${like(params.q)}
              or lower(coalesce(bp.country_code, '')) like ${like(params.q)})`
    : sql``

  const roleFilter =
    params.status === 'customer'
      ? sql`and bp.is_customer`
      : params.status === 'supplier'
        ? sql`and bp.is_supplier`
        : params.status === 'prospect'
          ? sql`and bp.is_prospect`
          : sql``

  const base = sql`
    from business_partners bp
    where bp.organization_id = ${organizationId}
      and bp.archived_at is null
      ${search}
      ${compileFilter('customers', params.filter, { customFieldsColumn: 'bp.custom_fields' })}
  `

  const counts = rowsOf<{ customer: string; supplier: string; prospect: string }>(
    await tx.execute(sql`
      select
        count(*) filter (where bp.is_customer)::int as customer,
        count(*) filter (where bp.is_supplier)::int as supplier,
        count(*) filter (where bp.is_prospect)::int as prospect
      ${base}
    `),
  )[0]!

  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select
        bp.id,
        bp.partner_no          as "partnerNo",
        bp.name,
        bp.country_code        as "countryCode",
        bp.tax_id              as "taxId",
        bp.credit_limit_minor  as "creditLimitMinor",
        bp.payment_terms_days  as "paymentTermsDays",
        coalesce(
          bp.currency_code,
          (select base_currency from organizations where id = bp.organization_id)
        ) as "currencyCode",
        case
          when bp.is_customer and bp.is_supplier then 'both'
          when bp.is_customer then 'customer'
          when bp.is_supplier then 'supplier'
          else 'prospect'
        end as role,
        coalesce((
          -- Signed: a customer invoiced 10,000 and credited 2,000 has revenue
          -- of 8,000, which is the figure they will check against their own
          -- records.
          select sum(${sql.raw(signedBaseTotal('i'))}) from invoices i
          where i.business_partner_id = bp.id and i.direction = 'ar'
            and i.status in ('issued','partially_paid','paid','credited')
        ), 0)::bigint as "revenueMinor",
        coalesce((
          select sum(${sql.raw(outstanding('i'))}) from invoices i
          where i.business_partner_id = bp.id
            and i.status in ('issued','partially_paid')
            -- The credit is already inside the credited invoice's outstanding;
            -- counting the credit note as its own receivable too would subtract
            -- it twice.
            and ${sql.raw(excludeCreditNotes('i'))}
        ), 0)::bigint as "outstandingMinor"
      ${base} ${roleFilter}
      order by ${orderBy('customers', params.sort, params.dir, 'bp.name')}
      limit ${pageSize} offset ${offset}
    `),
  )

  const totalRes = rowsOf<{ n: string }>(
    await tx.execute(sql`select count(*)::int as n ${base} ${roleFilter}`),
  )[0]!

  return {
    rows,
    total: Number(totalRes.n),
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(Number(totalRes.n) / pageSize)),
    statusCounts: {
      customer: Number(counts.customer),
      supplier: Number(counts.supplier),
      prospect: Number(counts.prospect),
    },
  }
}
