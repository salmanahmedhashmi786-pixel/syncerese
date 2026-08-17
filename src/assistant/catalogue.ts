import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { TenantTx } from '@/db/tenant'
import { type RequestContext, can } from '@/server/context'
import type { Permission } from '@/auth/permissions'
import { excludeCreditNotes, outstanding, signedBaseTotal } from '@/finance/invoice-sql'
import { containsPattern } from '@/lib/like'

/**
 * What the assistant is allowed to look up (MUST DO #12).
 *
 * A CLOSED CATALOGUE, NOT TEXT-TO-SQL.
 *
 * The obvious design is to let the model write SQL and run it under RLS. It is
 * the wrong one for a finance product, for a reason that has nothing to do with
 * injection: a model that writes a subtly wrong query — the wrong join, a
 * missing status filter, credit notes counted as revenue — returns a number
 * that is wrong and looks completely plausible. Row level security does not
 * help, because the query is legitimate and scoped correctly. It is simply not
 * the number the customer's accountant would arrive at.
 *
 * So the model does not write queries. It chooses a NAME from this file and
 * fills in typed parameters. Every statement here is code we wrote, reviewed
 * and tested, and each one reuses the same SQL fragments as the rest of the
 * application — `outstanding()`, `signedBaseTotal()` — so the assistant cannot
 * disagree with the invoice list about what a customer owes. An assistant whose
 * arithmetic differs from the screen next to it is worse than no assistant.
 *
 * Each entry declares:
 *   - the permission the ASKING USER needs. The assistant has no data path of
 *     its own; it runs in the user's tenant transaction under the user's role.
 *   - a hard row cap, so no question can pull the whole ledger into a prompt.
 *   - `numericFields`, which the grounding check uses to decide whether a figure
 *     in the drafted answer actually came from the data. See grounding.ts.
 */

export type CatalogueRow = Record<string, unknown>

export type CatalogueEntry = {
  name: string
  /** Shown to the model. Written for a reader deciding whether this is the
   *  right lookup, not as marketing copy. */
  description: string
  permission: Permission
  params: z.ZodTypeAny
  /** JSON Schema handed to the model's tool definition. Written by hand rather
   *  than generated: it is a prompt as much as a contract, and the descriptions
   *  are what stop the model passing a customer name where a number goes. */
  schema: Record<string, unknown>
  /** Columns whose values are real figures from the tenant's data. Anything the
   *  answer states as a number must trace back to one of these. */
  numericFields: string[]
  /**
   * The subset of those that it is meaningful to ADD UP across rows.
   *
   * Amounts, yes. Not `daysOverdue`: totalling two invoices that are 12 and 5
   * days late gives 17, which is a fact about nothing — and admitting it lets
   * the assistant state "17" and be believed. Every column listed here widens
   * what the grounding check will accept, so it stays as short as it can be.
   */
  sumFields: string[]
  run: (tx: TenantTx, ctx: RequestContext, params: never) => Promise<CatalogueRow[]>
}

/** No single lookup may return more than this. A question is a question, not an
 *  export — and an unbounded result set is both a cost problem and a way to
 *  push the actual answer out of the model's context. */
const MAX_ROWS = 50

const rowsOf = (res: unknown): CatalogueRow[] => (res as { rows: CatalogueRow[] }).rows

// ---------------------------------------------------------------------------

const outstandingInvoices: CatalogueEntry = {
  name: 'invoices.outstanding',
  description:
    'Unpaid and part-paid invoices, oldest due first. Use for "who owes us", ' +
    '"what is overdue", "outstanding receivables". direction "ar" is money owed ' +
    'TO the workspace; "ap" is money the workspace owes its suppliers.',
  permission: 'invoice.read',
  params: z.object({
    // 'ar' and 'ap', matching the column's own check constraint. Inventing
    // friendlier values here would mean the query silently matches nothing —
    // which it did, and produced a confident €0.00 next to a dashboard showing
    // €123,702.88 outstanding.
    direction: z.enum(['ar', 'ap']).default('ar'),
    onlyOverdue: z.boolean().default(false),
    partnerName: z.string().trim().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(MAX_ROWS).default(20),
  }),
  schema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['ar', 'ap'],
        description: 'ar = customers owe us (receivable); ap = we owe suppliers (payable)',
      },
      onlyOverdue: { type: 'boolean', description: 'Only invoices past their due date' },
      partnerName: { type: 'string', description: 'Restrict to one customer or supplier by name' },
      limit: { type: 'integer', description: '1-50, default 20' },
    },
  },
  numericFields: ['totalMinor', 'amountPaidMinor', 'outstandingMinor', 'daysOverdue'],
  // daysOverdue deliberately absent: a sum of ages is not a quantity.
  sumFields: ['totalMinor', 'amountPaidMinor', 'outstandingMinor'],
  run: async (tx, ctx, p: z.infer<typeof outstandingInvoicesParams>) => {
    const res = await tx.execute(sql`
      select i.invoice_no as "invoiceNo",
             coalesce(bp.name, i.partner_snapshot->>'name') as "partnerName",
             i.issue_date as "issueDate",
             i.due_date as "dueDate",
             i.currency_code as "currencyCode",
             i.total_minor as "totalMinor",
             i.amount_paid_minor as "amountPaidMinor",
             ${sql.raw(outstanding('i'))} as "outstandingMinor",
             greatest(0, current_date - i.due_date) as "daysOverdue",
             i.status
        from invoices i
        left join business_partners bp on bp.id = i.business_partner_id
       where i.organization_id = ${ctx.organizationId}
         and i.direction = ${p.direction}
         and i.deleted_at is null
         and i.status in ('issued', 'partially_paid')
         and ${sql.raw(excludeCreditNotes('i'))}
         and ${sql.raw(outstanding('i'))} > 0
         and (${!p.onlyOverdue} or i.due_date < current_date)
         and (${p.partnerName === undefined} or bp.name ilike ${containsPattern(p.partnerName ?? '')})
       order by i.due_date, i.invoice_no
       limit ${p.limit}
    `)
    return rowsOf(res)
  },
}
// Referenced once, through `typeof` on line 107, which no-unused-vars does
// not count as a use.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const outstandingInvoicesParams = outstandingInvoices.params as z.ZodObject<z.ZodRawShape>

// ---------------------------------------------------------------------------

const receivablesSummary: CatalogueEntry = {
  name: 'receivables.summary',
  description:
    'One row of totals: how much is outstanding in the base currency, how much of ' +
    'it is overdue, and how many invoices that is. Use for "how much are we owed" ' +
    'when no invoice-by-invoice list is needed.',
  permission: 'invoice.read',
  params: z.object({ direction: z.enum(['ar', 'ap']).default('ar') }),
  schema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['ar', 'ap'],
        description: 'ar = owed to us; ap = owed by us',
      },
    },
  },
  numericFields: [
    'invoiceCount',
    'overdueCount',
    'outstandingBaseMinor',
    'overdueBaseMinor',
  ],
  // One row, so summing changes nothing — stated explicitly rather than left
  // to coincidence.
  sumFields: [],
  run: async (tx, ctx, p: { direction: 'ar' | 'ap' }) => {
    // Converted to the base currency with each invoice's own fx_rate, because
    // summing mixed currencies is the classic way to produce a confident,
    // meaningless total.
    const res = await tx.execute(sql`
      select count(*)::int as "invoiceCount",
             count(*) filter (where i.due_date < current_date)::int as "overdueCount",
             coalesce(sum(round(${sql.raw(outstanding('i'))} * i.fx_rate)), 0)::bigint
               as "outstandingBaseMinor",
             coalesce(sum(round(${sql.raw(outstanding('i'))} * i.fx_rate))
               filter (where i.due_date < current_date), 0)::bigint as "overdueBaseMinor",
             (select base_currency from organizations where id = ${ctx.organizationId})
               as "baseCurrency"
        from invoices i
       where i.organization_id = ${ctx.organizationId}
         and i.direction = ${p.direction}
         and i.deleted_at is null
         and i.status in ('issued', 'partially_paid')
         and ${sql.raw(excludeCreditNotes('i'))}
         and ${sql.raw(outstanding('i'))} > 0
    `)
    return rowsOf(res)
  },
}

// ---------------------------------------------------------------------------

const topPartners: CatalogueEntry = {
  name: 'partners.top_by_revenue',
  description:
    'Customers ranked by what they have been invoiced over a period, credit notes ' +
    'subtracted. Use for "biggest customers", "who do we sell most to".',
  permission: 'invoice.read',
  params: z.object({
    months: z.number().int().min(1).max(60).default(12),
    limit: z.number().int().min(1).max(MAX_ROWS).default(10),
  }),
  schema: {
    type: 'object',
    properties: {
      months: { type: 'integer', description: 'How many months back, 1-60, default 12' },
      limit: { type: 'integer', description: '1-50, default 10' },
    },
  },
  numericFields: ['revenueBaseMinor', 'invoiceCount'],
  sumFields: ['revenueBaseMinor', 'invoiceCount'],
  run: async (tx, ctx, p: { months: number; limit: number }) => {
    // signedBaseTotal, not base_total_minor: credit notes are stored as
    // positive rows discriminated by document type, so a plain sum would ADD
    // a customer's credit notes to their revenue.
    const res = await tx.execute(sql`
      select coalesce(bp.name, i.partner_snapshot->>'name') as "partnerName",
             sum(${sql.raw(signedBaseTotal('i'))})::bigint as "revenueBaseMinor",
             count(*)::int as "invoiceCount",
             (select base_currency from organizations where id = ${ctx.organizationId})
               as "baseCurrency"
        from invoices i
        left join business_partners bp on bp.id = i.business_partner_id
       where i.organization_id = ${ctx.organizationId}
         and i.direction = 'ar'
         and i.deleted_at is null
         and i.status in ('issued', 'partially_paid', 'paid', 'credited')
         and i.issue_date >= (current_date - make_interval(months => ${p.months}))
       group by 1
       order by 2 desc
       limit ${p.limit}
    `)
    return rowsOf(res)
  },
}

// ---------------------------------------------------------------------------

const findInvoice: CatalogueEntry = {
  name: 'invoices.find',
  description:
    'Look up specific invoices by number or by customer name. Use when the ' +
    'question names a document ("what happened to INV-2026-0042") or asks for ' +
    'one partner\'s invoices regardless of whether they are paid.',
  permission: 'invoice.read',
  params: z.object({
    invoiceNo: z.string().trim().min(1).max(60).optional(),
    partnerName: z.string().trim().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(MAX_ROWS).default(20),
  }),
  schema: {
    type: 'object',
    properties: {
      invoiceNo: { type: 'string', description: 'Full or partial invoice number' },
      partnerName: { type: 'string', description: 'Full or partial customer/supplier name' },
      limit: { type: 'integer', description: '1-50, default 20' },
    },
  },
  numericFields: ['totalMinor', 'amountPaidMinor', 'outstandingMinor'],
  sumFields: ['totalMinor', 'amountPaidMinor', 'outstandingMinor'],
  run: async (tx, ctx, p: { invoiceNo?: string; partnerName?: string; limit: number }) => {
    const res = await tx.execute(sql`
      select i.invoice_no as "invoiceNo",
             coalesce(bp.name, i.partner_snapshot->>'name') as "partnerName",
             i.direction, i.issue_date as "issueDate", i.due_date as "dueDate",
             i.currency_code as "currencyCode",
             i.total_minor as "totalMinor",
             i.amount_paid_minor as "amountPaidMinor",
             ${sql.raw(outstanding('i'))} as "outstandingMinor",
             i.status,
             (i.document_type_code = '381') as "isCreditNote"
        from invoices i
        left join business_partners bp on bp.id = i.business_partner_id
       where i.organization_id = ${ctx.organizationId}
         and i.deleted_at is null
         and (${p.invoiceNo === undefined} or i.invoice_no ilike ${containsPattern(p.invoiceNo ?? '')})
         and (${p.partnerName === undefined} or bp.name ilike ${containsPattern(p.partnerName ?? '')})
       order by i.issue_date desc, i.invoice_no
       limit ${p.limit}
    `)
    return rowsOf(res)
  },
}

// ---------------------------------------------------------------------------

const findPartner: CatalogueEntry = {
  name: 'partners.find',
  description:
    'Look up a customer or supplier: their number, country, payment terms and ' +
    'whether they are a customer, a supplier or both.',
  permission: 'crm.read',
  params: z.object({
    name: z.string().trim().min(1).max(120),
    limit: z.number().int().min(1).max(MAX_ROWS).default(10),
  }),
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Full or partial name' },
      limit: { type: 'integer', description: '1-50, default 10' },
    },
    required: ['name'],
  },
  numericFields: ['paymentTermsDays', 'creditLimitMinor'],
  // Neither totals to anything: payment terms are per-partner settings, and a
  // combined credit limit across partners is not a figure anyone uses.
  sumFields: [],
  run: async (tx, ctx, p: { name: string; limit: number }) => {
    const res = await tx.execute(sql`
      select partner_no as "partnerNo", name, country_code as "countryCode",
             is_customer as "isCustomer", is_supplier as "isSupplier",
             payment_terms_days as "paymentTermsDays",
             credit_limit_minor as "creditLimitMinor",
             currency_code as "currencyCode"
        from business_partners
       where organization_id = ${ctx.organizationId}
         and archived_at is null
         and name ilike ${containsPattern(p.name)}
       order by name
       limit ${p.limit}
    `)
    return rowsOf(res)
  },
}

// ---------------------------------------------------------------------------

const accountBalances: CatalogueEntry = {
  name: 'ledger.account_balances',
  description:
    'Balances from the general ledger for posted entries, by account. Use for ' +
    '"what is our cash position", "what is the balance of account 1200".',
  permission: 'ledger.read',
  params: z.object({
    accountQuery: z.string().trim().min(1).max(80).optional(),
    limit: z.number().int().min(1).max(MAX_ROWS).default(20),
  }),
  schema: {
    type: 'object',
    properties: {
      accountQuery: {
        type: 'string',
        description: 'Account code or part of its name, e.g. "1200" or "cash"',
      },
      limit: { type: 'integer', description: '1-50, default 20' },
    },
  },
  numericFields: ['balanceBaseMinor', 'debitBaseMinor', 'creditBaseMinor'],
  // Summing balances across arbitrary accounts mixes assets with liabilities
  // and produces a number that means nothing. Debits and credits do total.
  sumFields: ['debitBaseMinor', 'creditBaseMinor'],
  run: async (tx, ctx, p: { accountQuery?: string; limit: number }) => {
    // Posted entries only. Draft journal entries are not the ledger, and a cash
    // position that quietly includes unposted drafts is a wrong number that
    // reconciles against nothing.
    const res = await tx.execute(sql`
      select a.code, a.name, a.type as "accountType",
             coalesce(sum(jl.base_debit_minor), 0)::bigint as "debitBaseMinor",
             coalesce(sum(jl.base_credit_minor), 0)::bigint as "creditBaseMinor",
             coalesce(sum(jl.base_debit_minor - jl.base_credit_minor), 0)::bigint
               as "balanceBaseMinor",
             (select base_currency from organizations where id = ${ctx.organizationId})
               as "baseCurrency"
        from accounts a
        left join journal_lines jl on jl.account_id = a.id
        left join journal_entries je
               on je.id = jl.journal_entry_id and je.status = 'posted'
       where a.organization_id = ${ctx.organizationId}
         and a.archived_at is null
         and (
           ${p.accountQuery === undefined}
           or a.code ilike ${containsPattern(p.accountQuery ?? '')}
           or a.name ilike ${containsPattern(p.accountQuery ?? '')}
         )
       group by a.id, a.code, a.name, a.type
       having ${p.accountQuery !== undefined}
           or coalesce(sum(jl.base_debit_minor - jl.base_credit_minor), 0) <> 0
       order by a.code
       limit ${p.limit}
    `)
    return rowsOf(res)
  },
}

// ---------------------------------------------------------------------------

const lowStock: CatalogueEntry = {
  name: 'inventory.low_stock',
  description:
    'Products at or below their reorder point. Use for "what needs reordering", ' +
    '"are we short of anything".',
  permission: 'inventory.read',
  params: z.object({ limit: z.number().int().min(1).max(MAX_ROWS).default(20) }),
  schema: {
    type: 'object',
    properties: { limit: { type: 'integer', description: '1-50, default 20' } },
  },
  numericFields: ['quantityOnHand', 'reorderPoint'],
  // Quantities of different products, in different units, do not add up.
  sumFields: [],
  run: async (tx, ctx, p: { limit: number }) => {
    const res = await tx.execute(sql`
      select p.sku, p.name,
             coalesce(sum(sl.qty_on_hand), 0)::numeric as "quantityOnHand",
             p.reorder_point as "reorderPoint",
             p.unit_code as "unitOfMeasure"
        from products p
        left join stock_levels sl on sl.product_id = p.id
       where p.organization_id = ${ctx.organizationId}
         and p.archived_at is null
         and p.reorder_point is not null
       group by p.id, p.sku, p.name, p.reorder_point, p.unit_code
      having coalesce(sum(sl.qty_on_hand), 0) <= p.reorder_point
       order by p.name
       limit ${p.limit}
    `)
    return rowsOf(res)
  },
}

// ---------------------------------------------------------------------------

export const CATALOGUE: readonly CatalogueEntry[] = [
  outstandingInvoices,
  receivablesSummary,
  topPartners,
  findInvoice,
  findPartner,
  accountBalances,
  lowStock,
]

export const entryByName = (name: string): CatalogueEntry | undefined =>
  CATALOGUE.find((e) => e.name === name)

/** What this particular user may ask about. Anything they cannot read is not
 *  offered to the model at all — a tool that is never described cannot be
 *  called, which is a stronger guarantee than refusing the call afterwards. */
export const catalogueFor = (ctx: RequestContext): CatalogueEntry[] =>
  CATALOGUE.filter((e) => can(ctx, e.permission))
