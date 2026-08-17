import { and, eq } from 'drizzle-orm'
import { accounts, bankAccounts, businessPartners, taxRates } from '@/db/schema'
import { withTenant, type TenantTx } from '@/db/tenant'
import { newId } from '@/lib/ids'
import { provisionFinance, seedCurrencies } from '@/finance/setup'
import { accountBySubtype, nextDocumentNumber, type PostingActor } from '@/finance/ledger'
import { createTestDb, seedOrg, type TestDb } from './db'

export type FinanceFixture = {
  t: TestDb
  orgId: string
  actor: PostingActor
  /** Runs `fn` inside a tenant-scoped transaction for this fixture's org. */
  tx: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>
  accountId: (subtype: string) => Promise<string>
  bankAccountId: string
  customerId: string
  supplierId: string
  vatRateId: string
}

export async function createFinanceFixture(
  opts: { baseCurrency?: string; countryCode?: string } = {},
): Promise<FinanceFixture> {
  const t = await createTestDb()
  const org = await seedOrg(t, {
    name: 'Vogel Handel GmbH',
    slug: 'vogel',
    seats: 10,
    currency: opts.baseCurrency ?? 'EUR',
  })

  await t.sudo(
    `update organizations set country_code = '${opts.countryCode ?? 'DE'}' where id = '${org.orgId}'`,
  )

  const actor: PostingActor = { organizationId: org.orgId, userId: org.ownerUserId }
  const tx = <T>(fn: (tx: TenantTx) => Promise<T>) =>
    withTenant(t.db, { organizationId: org.orgId, userId: org.ownerUserId }, fn)

  await tx(async (trx) => {
    await seedCurrencies(trx)
    await provisionFinance(trx, actor, { fiscalYear: 2026 })
  })

  const accountId = (subtype: string) =>
    tx((trx) => accountBySubtype(trx, org.orgId, subtype as never))

  const { bankId, customerId, supplierId, vatRateId } = await tx(async (trx) => {
    const bankGl = await accountBySubtype(trx, org.orgId, 'bank')

    const bankId = newId()
    await trx.insert(bankAccounts).values({
      id: bankId,
      organizationId: org.orgId,
      name: 'Main current account',
      iban: 'DE89370400440532013000',
      currencyCode: opts.baseCurrency ?? 'EUR',
      glAccountId: bankGl,
      isDefault: true,
    })

    const customerId = newId()
    const supplierId = newId()
    // Numbers MUST come from the document sequence. Hardcoding them leaves the
    // sequence at 1, so the first partner a user creates collides on the unique
    // constraint — which is exactly the bug this fixture used to hide.
    const customerNo = await nextDocumentNumber(trx, org.orgId, 'partner')
    const supplierNo = await nextDocumentNumber(trx, org.orgId, 'partner')
    await trx.insert(businessPartners).values([
      {
        id: customerId,
        organizationId: org.orgId,
        partnerNo: customerNo,
        name: 'Brauhaus Vogel GmbH',
        isCustomer: true,
        countryCode: 'DE',
        taxId: 'DE123456789',
        paymentTermsDays: 30,
      },
      {
        id: supplierId,
        organizationId: org.orgId,
        partnerNo: supplierNo,
        name: 'Steinmetz Metallwerke',
        isSupplier: true,
        countryCode: 'DE',
        taxId: 'DE987654321',
        paymentTermsDays: 14,
      },
    ])

    const std = await trx
      .select({ id: taxRates.id })
      .from(taxRates)
      .where(and(eq(taxRates.organizationId, org.orgId), eq(taxRates.code, 'STD')))
      .limit(1)

    return { bankId, customerId, supplierId, vatRateId: std[0]!.id }
  })

  return {
    t,
    orgId: org.orgId,
    actor,
    tx,
    accountId,
    bankAccountId: bankId,
    customerId,
    supplierId,
    vatRateId,
  }
}

/** Looks up an account id by its code, for tests that assert on a specific
 *  account rather than a role. */
export async function accountByCode(f: FinanceFixture, code: string): Promise<string> {
  return f.tx(async (trx) => {
    const rows = await trx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.organizationId, f.orgId), eq(accounts.code, code)))
      .limit(1)
    if (!rows[0]) throw new Error(`no account ${code}`)
    return rows[0].id
  })
}
