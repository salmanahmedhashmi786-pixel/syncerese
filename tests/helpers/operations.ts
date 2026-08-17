import { sql } from 'drizzle-orm'
import { moduleSettings, products, warehouses } from '@/db/schema'
import { newId } from '@/lib/ids'
import { accountBySubtype } from '@/finance/ledger'
import { createFinanceFixture, type FinanceFixture } from './finance'

export type OpsFixture = FinanceFixture & {
  warehouseId: string
  warehouse2Id: string
  widgetId: string
  gadgetId: string
  serviceId: string
}

/** Finance fixture plus two warehouses and a small product catalogue. */
export async function createOpsFixture(): Promise<OpsFixture> {
  const f = await createFinanceFixture()

  const ids = await f.tx(async (tx) => {
    const income = await accountBySubtype(tx, f.orgId, 'revenue')
    const expense = await accountBySubtype(tx, f.orgId, 'operating_expense')
    const inventory = await accountBySubtype(tx, f.orgId, 'inventory')

    const warehouseId = newId()
    const warehouse2Id = newId()
    await tx.insert(warehouses).values([
      {
        id: warehouseId,
        organizationId: f.orgId,
        code: 'MUC',
        name: 'Munich DC',
        countryCode: 'DE',
        isDefault: true,
      },
      {
        id: warehouse2Id,
        organizationId: f.orgId,
        code: 'RTM',
        name: 'Rotterdam',
        countryCode: 'NL',
      },
    ])

    const widgetId = newId()
    const gadgetId = newId()
    const serviceId = newId()
    await tx.insert(products).values([
      {
        id: widgetId,
        organizationId: f.orgId,
        sku: 'WIDGET-01',
        name: 'Precision widget',
        type: 'stock',
        salesPriceMinor: 100_00,
        costMinor: 40_00,
        currencyCode: 'EUR',
        incomeAccountId: income,
        expenseAccountId: expense,
        inventoryAccountId: inventory,
        taxRateId: f.vatRateId,
        isTracked: true,
      },
      {
        id: gadgetId,
        organizationId: f.orgId,
        sku: 'GADGET-01',
        name: 'Industrial gadget',
        type: 'stock',
        salesPriceMinor: 250_00,
        costMinor: 120_00,
        currencyCode: 'EUR',
        incomeAccountId: income,
        expenseAccountId: expense,
        inventoryAccountId: inventory,
        isTracked: true,
      },
      {
        id: serviceId,
        organizationId: f.orgId,
        sku: 'SVC-01',
        name: 'Installation service',
        type: 'service',
        salesPriceMinor: 500_00,
        costMinor: 0,
        currencyCode: 'EUR',
        incomeAccountId: income,
        isTracked: false,
      },
    ])

    return { warehouseId, warehouse2Id, widgetId, gadgetId, serviceId }
  })

  return { ...f, ...ids }
}

/** Sets the purchasing module's approval threshold and match tolerances. */
export async function setPurchasingSettings(
  f: FinanceFixture,
  settings: {
    requisitionApprovalThresholdMinor?: number
    priceToleranceMinor?: number
    priceTolerancePct?: number
  },
): Promise<void> {
  await f.tx(async (tx) => {
    await tx
      .insert(moduleSettings)
      .values({
        id: newId(),
        organizationId: f.orgId,
        moduleKey: 'purchasing',
        enabled: true,
        settings,
      })
      .onConflictDoNothing()
    await tx
      .update(moduleSettings)
      .set({ settings })
      .where(
        sql`${moduleSettings.organizationId} = ${f.orgId} and ${moduleSettings.moduleKey} = 'purchasing'`,
      )
  })
}

/** Signed base-currency movement on one account, for asserting postings. */
export async function accountMovement(f: FinanceFixture, subtype: string): Promise<number> {
  return f.tx(async (tx) => {
    const accountId = await accountBySubtype(tx, f.orgId, subtype as never)
    const res = await tx.execute(sql`
      select coalesce(sum(jl.base_debit_minor - jl.base_credit_minor), 0) as v
      from journal_lines jl
      join journal_entries je on je.id = jl.journal_entry_id
      where jl.organization_id = ${f.orgId}
        and jl.account_id = ${accountId}
        and je.status in ('posted','reversed')
    `)
    return Number((res as unknown as { rows: { v: string }[] }).rows[0]!.v)
  })
}
