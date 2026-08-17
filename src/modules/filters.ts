import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { AppError } from '@/lib/errors'
import { containsPattern, startsWithPattern } from '@/lib/like'
import type { ModuleId } from './registry'

/**
 * Structured filters (MUST DO #11).
 *
 * Filters are DATA, not SQL fragments: a saved view stores this shape, the
 * workflow engine evaluates the same shape in memory, and the list queries
 * compile it to SQL. One vocabulary, three consumers — so "amount over 5000"
 * means the same thing in a saved view, a filter chip and an automation rule.
 *
 * Compilation is allowlist-driven. A field name reaches SQL as an identifier
 * and can never be a bind parameter, so it is looked up in a per-module map
 * rather than interpolated. Values always bind.
 */

export const OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'starts_with',
  'in',
  'between',
  'is_empty',
  'is_not_empty',
] as const

export type Operator = (typeof OPERATORS)[number]

export const conditionSchema = z.object({
  field: z.string().min(1).max(64),
  op: z.enum(OPERATORS),
  value: z.unknown().optional(),
})

export const filterSchema = z.object({
  conditions: z.array(conditionSchema).max(20).default([]),
})

export type Condition = z.infer<typeof conditionSchema>
export type Filter = z.infer<typeof filterSchema>

type FieldKind = 'text' | 'number' | 'date' | 'money' | 'bool' | 'uuid'

type FieldDef = { sql: string; kind: FieldKind }

/**
 * Filterable fields per module.
 *
 * Deliberately separate from the sort allowlist: some fields make sense to
 * filter on but not to sort by, and a shared list would force one to inherit
 * the other's mistakes.
 */
export const FILTERABLE: Record<ModuleId, Record<string, FieldDef>> = {
  // Non-table modules have no list to filter. Kept as explicit empty entries so
  // the Record stays exhaustive and a new module cannot be added without a
  // deliberate decision about what is filterable on it.
  dashboard: {},
  reports: {},
  settings: {},
  analytics: {},
  chat: {},
  invoices: {
    id: { sql: 'i.id', kind: 'uuid' },
    invoiceNo: { sql: 'i.invoice_no', kind: 'text' },
    partnerName: { sql: 'bp.name', kind: 'text' },
    partnerId: { sql: 'i.business_partner_id', kind: 'uuid' },
    direction: { sql: 'i.direction', kind: 'text' },
    status: { sql: 'i.status', kind: 'text' },
    totalMinor: { sql: 'i.total_minor', kind: 'money' },
    outstandingMinor: { sql: '(i.total_minor - i.amount_paid_minor - i.credited_minor)', kind: 'money' },
    issueDate: { sql: 'i.issue_date', kind: 'date' },
    dueDate: { sql: 'i.due_date', kind: 'date' },
    currencyCode: { sql: 'i.currency_code', kind: 'text' },
    countryCode: { sql: 'bp.country_code', kind: 'text' },
  },
  journal: {
    id: { sql: 'je.id', kind: 'uuid' },
    entryNo: { sql: 'je.entry_no', kind: 'number' },
    entryDate: { sql: 'je.entry_date', kind: 'date' },
    description: { sql: 'je.description', kind: 'text' },
    sourceType: { sql: 'je.source_type', kind: 'text' },
    status: { sql: 'je.status', kind: 'text' },
  },
  banking: {
    id: { sql: 'bt.id', kind: 'uuid' },
    valueDate: { sql: 'bt.value_date', kind: 'date' },
    description: { sql: 'bt.description', kind: 'text' },
    counterpartyName: { sql: 'bt.counterparty_name', kind: 'text' },
    reconciliationStatus: { sql: 'bt.reconciliation_status', kind: 'text' },
    amountMinor: { sql: 'bt.amount_minor', kind: 'money' },
  },
  customers: {
    id: { sql: 'bp.id', kind: 'uuid' },
    partnerNo: { sql: 'bp.partner_no', kind: 'text' },
    name: { sql: 'bp.name', kind: 'text' },
    countryCode: { sql: 'bp.country_code', kind: 'text' },
    taxId: { sql: 'bp.tax_id', kind: 'text' },
    isCustomer: { sql: 'bp.is_customer', kind: 'bool' },
    isSupplier: { sql: 'bp.is_supplier', kind: 'bool' },
    isProspect: { sql: 'bp.is_prospect', kind: 'bool' },
    creditLimitMinor: { sql: 'bp.credit_limit_minor', kind: 'money' },
    paymentTermsDays: { sql: 'bp.payment_terms_days', kind: 'number' },
    createdAt: { sql: 'bp.created_at', kind: 'date' },
  },
  'sales-orders': {
    id: { sql: 'so.id', kind: 'uuid' },
    orderNo: { sql: 'so.order_no', kind: 'text' },
    partnerName: { sql: 'bp.name', kind: 'text' },
    partnerId: { sql: 'so.business_partner_id', kind: 'uuid' },
    status: { sql: 'so.status', kind: 'text' },
    totalMinor: { sql: 'so.total_minor', kind: 'money' },
    orderDate: { sql: 'so.order_date', kind: 'date' },
    ownerUserId: { sql: 'so.owner_user_id', kind: 'uuid' },
    countryCode: { sql: 'bp.country_code', kind: 'text' },
  },
  'purchase-orders': {
    id: { sql: 'po.id', kind: 'uuid' },
    poNo: { sql: 'po.po_no', kind: 'text' },
    supplierName: { sql: 'bp.name', kind: 'text' },
    status: { sql: 'po.status', kind: 'text' },
    totalMinor: { sql: 'po.total_minor', kind: 'money' },
    orderDate: { sql: 'po.order_date', kind: 'date' },
    buyerUserId: { sql: 'po.buyer_user_id', kind: 'uuid' },
  },
  products: {
    id: { sql: 'p.id', kind: 'uuid' },
    sku: { sql: 'p.sku', kind: 'text' },
    name: { sql: 'p.name', kind: 'text' },
    type: { sql: 'p.type', kind: 'text' },
    salesPriceMinor: { sql: 'p.sales_price_minor', kind: 'money' },
    isTracked: { sql: 'p.is_tracked', kind: 'bool' },
  },
  deals: {
    id: { sql: 'd.id', kind: 'uuid' },
    dealNo: { sql: 'd.deal_no', kind: 'text' },
    name: { sql: 'd.name', kind: 'text' },
    status: { sql: 'd.status', kind: 'text' },
    amountMinor: { sql: 'd.amount_minor', kind: 'money' },
    expectedCloseDate: { sql: 'd.expected_close_date', kind: 'date' },
    source: { sql: 'd.source', kind: 'text' },
    ownerUserId: { sql: 'd.owner_user_id', kind: 'uuid' },
    partnerId: { sql: 'd.business_partner_id', kind: 'uuid' },
    stageName: { sql: 'ps.name', kind: 'text' },
  },
}

/** Custom fields are addressed as `custom.<key>` and resolve to a jsonb path.
 *  The key is validated against the same slug rule the column enforces. */
const CUSTOM_PREFIX = 'custom.'
const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]{0,48}$/

function resolveField(
  module: ModuleId,
  field: string,
  customFieldsColumn?: string,
): FieldDef {
  if (field.startsWith(CUSTOM_PREFIX)) {
    const key = field.slice(CUSTOM_PREFIX.length)
    if (!CUSTOM_KEY_RE.test(key)) {
      throw new AppError('VALIDATION_FAILED', `Invalid custom field key: ${key}`)
    }
    if (!customFieldsColumn) {
      throw new AppError('VALIDATION_FAILED', `${module} does not support custom fields`)
    }
    // Key is slug-validated above, so this interpolation cannot inject.
    return { sql: `(${customFieldsColumn} ->> '${key}')`, kind: 'text' }
  }

  const def = FILTERABLE[module]?.[field]
  if (!def) {
    throw new AppError('VALIDATION_FAILED', `Cannot filter ${module} by "${field}"`)
  }
  return def
}

function coerce(kind: FieldKind, value: unknown): unknown {
  switch (kind) {
    case 'number':
    case 'money': {
      const n = Number(value)
      if (!Number.isFinite(n)) {
        throw new AppError('VALIDATION_FAILED', `"${String(value)}" is not a number`)
      }
      return n
    }
    case 'bool':
      return value === true || value === 'true'
    case 'date': {
      const s = String(value)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        throw new AppError('VALIDATION_FAILED', `"${s}" is not a date (expected YYYY-MM-DD)`)
      }
      return s
    }
    case 'uuid': {
      const s = String(value)
      if (!/^[0-9a-f-]{36}$/i.test(s)) {
        throw new AppError('VALIDATION_FAILED', 'Invalid id')
      }
      return s
    }
    default:
      return String(value)
  }
}

/**
 * Compiles a filter to a SQL fragment.
 *
 * Returns an empty fragment for an empty filter so callers can interpolate it
 * unconditionally.
 */
export function compileFilter(
  module: ModuleId,
  filter: Filter | undefined,
  opts: { customFieldsColumn?: string } = {},
): SQL {
  if (!filter?.conditions?.length) return sql``

  const parts: SQL[] = []

  for (const condition of filter.conditions) {
    const def = resolveField(module, condition.field, opts.customFieldsColumn)
    const col = sql.raw(def.sql)
    const v = condition.value

    switch (condition.op) {
      case 'eq':
        parts.push(sql`${col} = ${coerce(def.kind, v)}`)
        break
      case 'neq':
        // NULL <> x is NULL, which would silently drop rows with no value.
        parts.push(sql`(${col} is distinct from ${coerce(def.kind, v)})`)
        break
      case 'gt':
        parts.push(sql`${col} > ${coerce(def.kind, v)}`)
        break
      case 'gte':
        parts.push(sql`${col} >= ${coerce(def.kind, v)}`)
        break
      case 'lt':
        parts.push(sql`${col} < ${coerce(def.kind, v)}`)
        break
      case 'lte':
        parts.push(sql`${col} <= ${coerce(def.kind, v)}`)
        break
      // LIKE metacharacters in the value are escaped — otherwise a filter of
      // "%" matches every row.
      case 'contains':
        parts.push(sql`lower(${col}::text) like ${containsPattern(String(v))} escape '\\'`)
        break
      case 'starts_with':
        parts.push(sql`lower(${col}::text) like ${startsWithPattern(String(v))} escape '\\'`)
        break
      case 'in': {
        const list = Array.isArray(v) ? v : [v]
        if (list.length === 0) {
          // An empty IN must match nothing, not everything.
          parts.push(sql`false`)
          break
        }
        if (list.length > 200) {
          throw new AppError('VALIDATION_FAILED', 'Too many values in an "in" filter')
        }
        const values = list.map((item) => sql`${coerce(def.kind, item)}`)
        parts.push(sql`${col} in (${sql.join(values, sql`, `)})`)
        break
      }
      case 'between': {
        const range = Array.isArray(v) ? v : []
        if (range.length !== 2) {
          throw new AppError('VALIDATION_FAILED', '"between" needs exactly two values')
        }
        parts.push(
          sql`${col} between ${coerce(def.kind, range[0])} and ${coerce(def.kind, range[1])}`,
        )
        break
      }
      case 'is_empty':
        parts.push(sql`(${col} is null or ${col}::text = '')`)
        break
      case 'is_not_empty':
        parts.push(sql`(${col} is not null and ${col}::text <> '')`)
        break
    }
  }

  return sql` and (${sql.join(parts, sql` and `)})`
}

/**
 * Evaluates the same filter shape in memory, for the workflow engine.
 *
 * Sharing the vocabulary with the SQL compiler is the point: a rule that says
 * "amount over 5000" behaves identically whether it is filtering a list or
 * gating an automation.
 */
export function evaluateConditions(
  conditions: Condition[],
  record: Record<string, unknown>,
): boolean {
  return conditions.every((c) => {
    const actual = c.field.startsWith(CUSTOM_PREFIX)
      ? (record.customFields as Record<string, unknown> | undefined)?.[
          c.field.slice(CUSTOM_PREFIX.length)
        ]
      : record[c.field]

    const expected = c.value

    switch (c.op) {
      case 'eq':
        return String(actual) === String(expected)
      case 'neq':
        return String(actual) !== String(expected)
      case 'gt':
        return Number(actual) > Number(expected)
      case 'gte':
        return Number(actual) >= Number(expected)
      case 'lt':
        return Number(actual) < Number(expected)
      case 'lte':
        return Number(actual) <= Number(expected)
      case 'contains':
        return String(actual ?? '').toLowerCase().includes(String(expected).toLowerCase())
      case 'starts_with':
        return String(actual ?? '').toLowerCase().startsWith(String(expected).toLowerCase())
      case 'in':
        return (Array.isArray(expected) ? expected : [expected]).some(
          (x) => String(x) === String(actual),
        )
      case 'between': {
        const range = Array.isArray(expected) ? expected : []
        return Number(actual) >= Number(range[0]) && Number(actual) <= Number(range[1])
      }
      case 'is_empty':
        return actual === null || actual === undefined || actual === ''
      case 'is_not_empty':
        return actual !== null && actual !== undefined && actual !== ''
      default:
        return false
    }
  })
}

/** Parses an untrusted filter payload (query string, saved view, API body). */
export function parseFilter(input: unknown): Filter | undefined {
  if (input === undefined || input === null) return undefined
  const parsed = filterSchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid filter', parsed.error.issues)
  }
  return parsed.data
}
