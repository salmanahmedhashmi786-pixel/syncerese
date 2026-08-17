import { eq, sql } from 'drizzle-orm'
import {
  accounts,
  currencies,
  documentSequences,
  fiscalPeriods,
  organizations,
  taxRates,
} from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import { DEFAULT_CHART } from './chart-of-accounts'
import type { PostingActor } from './ledger'

/** ISO 4217 seed. Global reference data, not tenant-scoped. */
export const SEED_CURRENCIES = [
  { code: 'EUR', name: 'Euro', minorUnit: 2, symbol: '€' },
  { code: 'USD', name: 'US Dollar', minorUnit: 2, symbol: '$' },
  { code: 'GBP', name: 'Pound Sterling', minorUnit: 2, symbol: '£' },
  { code: 'CHF', name: 'Swiss Franc', minorUnit: 2, symbol: 'CHF' },
  { code: 'SEK', name: 'Swedish Krona', minorUnit: 2, symbol: 'kr' },
  { code: 'PLN', name: 'Polish Złoty', minorUnit: 2, symbol: 'zł' },
  { code: 'DKK', name: 'Danish Krone', minorUnit: 2, symbol: 'kr' },
  { code: 'NOK', name: 'Norwegian Krone', minorUnit: 2, symbol: 'kr' },
  { code: 'CZK', name: 'Czech Koruna', minorUnit: 2, symbol: 'Kč' },
  { code: 'CAD', name: 'Canadian Dollar', minorUnit: 2, symbol: '$' },
  { code: 'AUD', name: 'Australian Dollar', minorUnit: 2, symbol: '$' },
  // Zero-decimal — present from day one so the minor-unit handling is exercised
  // rather than assumed.
  { code: 'JPY', name: 'Japanese Yen', minorUnit: 0, symbol: '¥' },
]

export async function seedCurrencies(tx: TenantTx): Promise<void> {
  await tx.insert(currencies).values(SEED_CURRENCIES).onConflictDoNothing()
}

const SEQUENCES = [
  { key: 'journal_entry', prefix: '', padding: 1 },
  { key: 'invoice_ar', prefix: 'INV-', padding: 5 },
  { key: 'invoice_ap', prefix: 'BILL-', padding: 5 },
  // Credit notes get their own gap-free series. Sharing the invoice series
  // would interleave the two, and most jurisdictions want the invoice series
  // continuous on its own.
  { key: 'credit_note_ar', prefix: 'CN-', padding: 5 },
  { key: 'credit_note_ap', prefix: 'VCN-', padding: 5 },
  { key: 'payment', prefix: 'PAY-', padding: 5 },
  { key: 'partner', prefix: 'BP-', padding: 5 },
  // Operations documents.
  { key: 'quote', prefix: 'QT-', padding: 5 },
  { key: 'sales_order', prefix: 'SO-', padding: 5 },
  { key: 'delivery', prefix: 'DN-', padding: 5 },
  { key: 'requisition', prefix: 'REQ-', padding: 5 },
  { key: 'purchase_order', prefix: 'PO-', padding: 5 },
  { key: 'goods_receipt', prefix: 'GR-', padding: 5 },
  { key: 'stock_transfer', prefix: 'TR-', padding: 5 },
  { key: 'deal', prefix: 'DL-', padding: 5 },
  { key: 'product', prefix: 'SKU-', padding: 5 },
]

/** Default VAT rates. Deliberately minimal — a tenant configures their own; the
 *  point is that a fresh organization can issue a compliant invoice without
 *  first having to understand tax category codes. */
function defaultTaxRates(countryCode: string | null) {
  const standard = { DE: 0.19, NL: 0.21, FR: 0.2, IT: 0.22, ES: 0.21, PL: 0.23, GB: 0.2 }[
    countryCode ?? ''
  ]
  const rows = [
    {
      code: 'ZERO',
      name: 'Zero rated',
      rate: '0',
      category: 'zero',
      en16931Category: 'Z',
      isDefault: false,
    },
    {
      code: 'EXEMPT',
      name: 'Exempt',
      rate: '0',
      category: 'exempt',
      en16931Category: 'E',
      isDefault: false,
    },
    {
      code: 'RC',
      name: 'Reverse charge',
      rate: '0',
      category: 'reverse_charge',
      en16931Category: 'AE',
      isDefault: false,
    },
    {
      code: 'IC',
      name: 'Intra-community supply',
      rate: '0',
      category: 'intra_community',
      en16931Category: 'K',
      isDefault: false,
    },
  ]
  if (standard !== undefined) {
    rows.unshift({
      code: 'STD',
      name: `Standard rate ${(standard * 100).toFixed(0)}%`,
      rate: String(standard),
      category: 'standard',
      en16931Category: 'S',
      isDefault: true,
    })
  }
  return rows
}

/**
 * Provisions a new organization's books: chart of accounts, document
 * sequences, tax rates and the current fiscal year.
 *
 * Idempotent — re-running it on an organization that already has a chart is a
 * no-op rather than a duplicate-key error, because provisioning is exactly the
 * kind of step that gets retried after a partial failure.
 */
export async function provisionFinance(
  tx: TenantTx,
  actor: PostingActor,
  opts: { fiscalYear?: number } = {},
): Promise<{ accountsCreated: number; periodsCreated: number }> {
  const { organizationId } = actor

  const existing = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId))

  if ((existing[0]?.n ?? 0) > 0) {
    return { accountsCreated: 0, periodsCreated: 0 }
  }

  const org = (
    await tx
      .select({
        countryCode: organizations.countryCode,
        fiscalYearStartMonth: organizations.fiscalYearStartMonth,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)
  )[0]

  // --- chart of accounts, parents first so parentId can be resolved ---------
  const idByCode = new Map<string, string>()
  for (const t of DEFAULT_CHART) idByCode.set(t.code, newId())

  await tx.insert(accounts).values(
    DEFAULT_CHART.map((t) => ({
      id: idByCode.get(t.code)!,
      organizationId,
      code: t.code,
      name: t.name,
      type: t.type,
      subtype: t.subtype ?? null,
      parentId: t.parentCode ? (idByCode.get(t.parentCode) ?? null) : null,
      isPostable: t.isPostable ?? true,
      isSystem: t.isSystem ?? false,
      description: t.description ?? null,
    })),
  )

  // --- document sequences --------------------------------------------------
  await tx
    .insert(documentSequences)
    .values(
      SEQUENCES.map((s) => ({
        organizationId,
        sequenceKey: s.key,
        prefix: s.prefix,
        padding: s.padding,
        nextValue: 1,
      })),
    )
    .onConflictDoNothing()

  // --- tax rates -----------------------------------------------------------
  const vatPayable = idByCode.get('2200')!
  const vatReceivable = idByCode.get('1500')!
  await tx.insert(taxRates).values(
    defaultTaxRates(org?.countryCode ?? null).map((r) => ({
      id: newId(),
      organizationId,
      code: r.code,
      name: r.name,
      rate: r.rate,
      countryCode: org?.countryCode ?? null,
      category: r.category,
      en16931Category: r.en16931Category,
      salesAccountId: vatPayable,
      purchaseAccountId: vatReceivable,
      isDefault: r.isDefault,
    })),
  )

  // --- fiscal calendar: twelve monthly periods -----------------------------
  const startMonth = org?.fiscalYearStartMonth ?? 1
  const year = opts.fiscalYear ?? new Date().getUTCFullYear()
  const periods = Array.from({ length: 12 }, (_, i) => {
    const monthIndex = startMonth - 1 + i
    const y = year + Math.floor(monthIndex / 12)
    const m = monthIndex % 12
    const starts = new Date(Date.UTC(y, m, 1))
    const ends = new Date(Date.UTC(y, m + 1, 0))
    return {
      id: newId(),
      organizationId,
      fiscalYear: year,
      periodNo: i + 1,
      startsOn: starts.toISOString().slice(0, 10),
      endsOn: ends.toISOString().slice(0, 10),
      status: 'open',
    }
  })
  await tx.insert(fiscalPeriods).values(periods)

  await writeAudit(tx, {
    organizationId,
    actorUserId: actor.userId,
    actorType: actor.userId ? 'user' : 'system',
    action: 'finance.provisioned',
    entityType: 'organization',
    entityId: organizationId,
    after: { accounts: DEFAULT_CHART.length, periods: periods.length, fiscalYear: year },
    requestId: actor.requestId,
  })

  return { accountsCreated: DEFAULT_CHART.length, periodsCreated: periods.length }
}
