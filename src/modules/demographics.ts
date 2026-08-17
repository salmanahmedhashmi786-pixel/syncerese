import { sql } from 'drizzle-orm'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { excludeCreditNotes, outstanding, signedBaseTotal } from '@/finance/invoice-sql'

/**
 * Business demographics (MUST DO #11).
 *
 * "Segmenting customers and revenue by useful cuts — industry, company size,
 * region/country, acquisition source, currency, customer lifetime value,
 * churn/at-risk flags", with the data model built "so new segments can be added
 * without a rewrite".
 *
 * That last clause is why dimensions are a REGISTRY rather than a set of
 * hand-written reports. `country` reads a column; `industry` and `size` read
 * tags by category; anything a tenant invents as a custom field becomes a
 * dimension automatically. Adding "segment by acquisition channel" is a tag
 * category, not a migration and not a new endpoint.
 */

export type DimensionKind = 'column' | 'tag' | 'custom_field'

export type Dimension = {
  key: string
  label: string
  kind: DimensionKind
  /** SQL expression yielding the segment label, for `column` dimensions. */
  expr?: string
  /** Tag category, for `tag` dimensions. */
  tagCategory?: string
  /** Custom field key, for `custom_field` dimensions. */
  fieldKey?: string
}

/** Built-in cuts. Tenant tag categories and custom fields extend this at
 *  runtime — see `availableDimensions`. */
export const BUILT_IN_DIMENSIONS: Dimension[] = [
  { key: 'country', label: 'Country', kind: 'column', expr: `coalesce(bp.country_code, '—')` },
  {
    key: 'currency',
    label: 'Currency',
    kind: 'column',
    expr: `coalesce(bp.currency_code, (select base_currency from organizations o where o.id = bp.organization_id))`,
  },
  {
    key: 'role',
    label: 'Relationship',
    kind: 'column',
    expr: `case when bp.is_customer and bp.is_supplier then 'Customer & supplier'
                when bp.is_customer then 'Customer'
                when bp.is_supplier then 'Supplier'
                else 'Prospect' end`,
  },
  {
    key: 'payment_terms',
    label: 'Payment terms',
    kind: 'column',
    expr: `'NET ' || bp.payment_terms_days::text`,
  },
  {
    key: 'acquisition_source',
    label: 'Acquisition source',
    kind: 'column',
    expr: `coalesce((select d.source from deals d
                      where d.business_partner_id = bp.id and d.source is not null
                      order by d.created_at limit 1), 'Unknown')`,
  },
]

export async function availableDimensions(
  tx: TenantTx,
  organizationId: string,
): Promise<Dimension[]> {
  const tagCats = (
    await tx.execute(sql`
      select distinct category from tags
       where organization_id = ${organizationId} and category is not null
       order by category
    `)
  ) as unknown as { rows: { category: string }[] }

  const custom = (
    await tx.execute(sql`
      select key, label from custom_field_defs
       where organization_id = ${organizationId}
         and entity_type = 'business_partner'
         and archived_at is null
         and field_type in ('text','select')
       order by position, label
    `)
  ) as unknown as { rows: { key: string; label: string }[] }

  return [
    ...BUILT_IN_DIMENSIONS,
    ...tagCats.rows.map((r) => ({
      key: `tag:${r.category}`,
      label: r.category.charAt(0).toUpperCase() + r.category.slice(1),
      kind: 'tag' as const,
      tagCategory: r.category,
    })),
    ...custom.rows.map((r) => ({
      key: `custom:${r.key}`,
      label: r.label,
      kind: 'custom_field' as const,
      fieldKey: r.key,
    })),
  ]
}

const SLUG = /^[a-z][a-z0-9_]{0,48}$/

/** Resolves a dimension key to the SQL expression producing its label. */
function segmentExpr(dimension: Dimension): string {
  switch (dimension.kind) {
    case 'column':
      return dimension.expr!
    case 'tag':
      if (!SLUG.test(dimension.tagCategory ?? '')) {
        throw new AppError('VALIDATION_FAILED', 'Invalid tag category')
      }
      // A partner may carry several tags in a category; the first alphabetically
      // is used so a row lands in exactly one segment and totals still sum.
      return `coalesce((
        select t.name from taggings tg
        join tags t on t.id = tg.tag_id
        where tg.entity_type = 'business_partner' and tg.entity_id = bp.id
          and t.category = '${dimension.tagCategory}'
        order by t.name limit 1
      ), 'Unclassified')`
    case 'custom_field':
      if (!SLUG.test(dimension.fieldKey ?? '')) {
        throw new AppError('VALIDATION_FAILED', 'Invalid custom field key')
      }
      return `coalesce(nullif(bp.custom_fields ->> '${dimension.fieldKey}', ''), 'Unclassified')`
  }
}

export type Segment = {
  segment: string
  customerCount: number
  revenueMinor: number
  outstandingMinor: number
  /** Lifetime value: everything ever invoiced to partners in this segment. */
  lifetimeValueMinor: number
  averageValueMinor: number
  /** Customers with no invoice in the last 180 days but activity before that. */
  atRiskCount: number
}

export type DemographicsResult = {
  dimensionKey: string
  dimensionLabel: string
  range: { from: string; to: string }
  segments: Segment[]
  totals: {
    customers: number
    revenueMinor: number
    outstandingMinor: number
    lifetimeValueMinor: number
    atRiskCount: number
  }
}

/**
 * Revenue and customer counts by segment.
 *
 * `revenueMinor` is bounded by the range; `lifetimeValueMinor` deliberately is
 * not — lifetime value that resets each January is not lifetime value.
 */
export async function demographics(
  tx: TenantTx,
  organizationId: string,
  opts: { dimensionKey: string; from: string; to: string; asOf?: string },
): Promise<DemographicsResult> {
  const dimensions = await availableDimensions(tx, organizationId)
  const dimension = dimensions.find((d) => d.key === opts.dimensionKey) ?? dimensions[0]!
  const expr = sql.raw(segmentExpr(dimension))
  const asOf = opts.asOf ?? opts.to

  const res = await tx.execute(sql`
    with partner_segment as (
      select bp.id as partner_id, ${expr} as segment
      from business_partners bp
      where bp.organization_id = ${organizationId}
        and bp.archived_at is null
        and bp.is_customer
    ),
    invoiced as (
      select i.business_partner_id as partner_id,
             sum(${sql.raw(signedBaseTotal('i'))}) filter (
               where i.issue_date between ${opts.from} and ${opts.to}
             ) as period_revenue,
             sum(${sql.raw(signedBaseTotal('i'))}) as lifetime_revenue,
             sum(${sql.raw(outstanding('i'))}) filter (
               where i.status in ('issued','partially_paid')
                 and ${sql.raw(excludeCreditNotes('i'))}
             ) as outstanding,
             max(i.issue_date) as last_invoice_date
      from invoices i
      where i.organization_id = ${organizationId}
        and i.direction = 'ar'
        -- 'credited' belongs here. The sum above is SIGNED, so dropping a fully
        -- credited invoice while keeping its credit note would leave the
        -- negative half on its own and report the customer's revenue as
        -- MINUS the invoice value.
        and i.status in ('issued','partially_paid','paid','credited')
        and i.deleted_at is null
      group by i.business_partner_id
    )
    select
      ps.segment                                             as segment,
      count(*)::int                                          as customer_count,
      coalesce(sum(inv.period_revenue), 0)::bigint           as revenue,
      coalesce(sum(inv.outstanding), 0)::bigint              as outstanding,
      coalesce(sum(inv.lifetime_revenue), 0)::bigint         as lifetime_value,
      count(*) filter (
        where inv.last_invoice_date is not null
          and inv.last_invoice_date < (${asOf}::date - interval '180 days')
      )::int                                                 as at_risk
    from partner_segment ps
    left join invoiced inv on inv.partner_id = ps.partner_id
    group by ps.segment
    order by 3 desc, 1
  `)

  const rows = (
    res as unknown as {
      rows: {
        segment: string
        customer_count: number
        revenue: string
        outstanding: string
        lifetime_value: string
        at_risk: number
      }[]
    }
  ).rows

  const segments: Segment[] = rows.map((r) => {
    const customers = Number(r.customer_count)
    const lifetime = Number(r.lifetime_value)
    return {
      segment: r.segment,
      customerCount: customers,
      revenueMinor: Number(r.revenue),
      outstandingMinor: Number(r.outstanding),
      lifetimeValueMinor: lifetime,
      averageValueMinor: customers === 0 ? 0 : Math.round(lifetime / customers),
      atRiskCount: Number(r.at_risk),
    }
  })

  return {
    dimensionKey: dimension.key,
    dimensionLabel: dimension.label,
    range: { from: opts.from, to: opts.to },
    segments,
    totals: {
      customers: segments.reduce((s, x) => s + x.customerCount, 0),
      revenueMinor: segments.reduce((s, x) => s + x.revenueMinor, 0),
      outstandingMinor: segments.reduce((s, x) => s + x.outstandingMinor, 0),
      lifetimeValueMinor: segments.reduce((s, x) => s + x.lifetimeValueMinor, 0),
      atRiskCount: segments.reduce((s, x) => s + x.atRiskCount, 0),
    },
  }
}

/** Customers ranked by lifetime value, with recency — the list behind the
 *  at-risk count. */
export async function customerValue(
  tx: TenantTx,
  organizationId: string,
  opts: { asOf: string; limit?: number },
) {
  const res = await tx.execute(sql`
    select
      bp.id, bp.name, bp.country_code as country,
      coalesce(sum(i.base_total_minor), 0)::bigint          as lifetime_value,
      coalesce(count(i.id), 0)::int                          as invoice_count,
      max(i.issue_date)                                      as last_invoice_date,
      (${opts.asOf}::date - max(i.issue_date))::int          as days_since_last
    from business_partners bp
    left join invoices i
      on i.business_partner_id = bp.id
     and i.direction = 'ar'
     and i.status in ('issued','partially_paid','paid','credited')
     and i.deleted_at is null
    where bp.organization_id = ${organizationId}
      and bp.archived_at is null
      and bp.is_customer
    group by bp.id, bp.name, bp.country_code
    order by 4 desc
    limit ${Math.min(opts.limit ?? 25, 200)}
  `)

  return (
    res as unknown as {
      rows: {
        id: string
        name: string
        country: string | null
        lifetime_value: string
        invoice_count: number
        last_invoice_date: string | null
        days_since_last: number | null
      }[]
    }
  ).rows.map((r) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    lifetimeValueMinor: Number(r.lifetime_value),
    invoiceCount: Number(r.invoice_count),
    lastInvoiceDate: r.last_invoice_date,
    daysSinceLast: r.days_since_last === null ? null : Number(r.days_since_last),
    // A flag, not a prediction. It says "nobody has invoiced this customer in
    // six months", which is a fact — not a churn model dressed up as one.
    atRisk: r.days_since_last !== null && Number(r.days_since_last) > 180,
  }))
}
