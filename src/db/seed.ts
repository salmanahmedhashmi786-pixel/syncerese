import 'dotenv/config'
import { eq, sql } from 'drizzle-orm'
import { db } from './index'
import {
  bankAccounts,
  businessPartners,
  deals,
  licenses,
  memberships,
  moduleSettings,
  organizations,
  partnerAddresses,
  pipelineStages,
  pipelines,
  products,
  roles,
  taxRates,
  users,
  warehouses,
} from './schema'
import { asPlatformAdmin, withoutTenantScope, withTenant } from './tenant'
import { newId } from '@/lib/ids'
import { hashPassword } from '@/auth/password'
import { accountBySubtype, nextDocumentNumber } from '@/finance/ledger'
import { provisionFinance, seedCurrencies } from '@/finance/setup'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { recordPayment } from '@/finance/payments'
import { importBankCsv } from '@/finance/bank-import'
import {
  confirmSalesOrder,
  createSalesOrder,
  deliverSalesOrder,
  invoiceSalesOrder,
} from '@/sales/orders'
import {
  approvePurchaseOrder,
  createPurchaseOrder,
  matchSupplierInvoice,
  receiveGoods,
} from '@/purchasing/orders'
import { createChannel, openDirectMessage, postMessage } from '@/chat/service'

/**
 * Development seed: one tenant with a real, self-consistent set of books.
 *
 * Every figure the UI shows comes from posted journal entries — invoices are
 * genuinely issued, payments genuinely allocated, the trial balance genuinely
 * balances. Inserting plausible-looking rows straight into the tables would
 * produce a demo that looks right and a ledger that is wrong, which is exactly
 * the failure mode this product exists to avoid.
 *
 * Idempotent: re-running it does nothing if the organization already exists.
 */

const DEMO_EMAIL = 'owner@syncrese.test'
const DEMO_PASSWORD = 'syncrese-demo-2026'

const PARTNERS = [
  { name: 'Brauhaus Vogel GmbH', country: 'DE', tax: 'DE811234567', customer: true, terms: 30 },
  { name: 'Rotterdam Marine BV', country: 'NL', tax: 'NL803456789B01', customer: true, terms: 45 },
  { name: 'Atelier Lyonnais SAS', country: 'FR', tax: 'FR32123456789', customer: true, terms: 30 },
  { name: 'Nordwind Logistik AG', country: 'DE', tax: 'DE815556677', customer: true, terms: 60 },
  { name: 'Milano Impianti Srl', country: 'IT', tax: 'IT01234567890', customer: true, terms: 45 },
  { name: 'Helsinki Kone Oy', country: 'FI', tax: 'FI12345678', customer: true, terms: 30 },
  { name: 'Steinmetz Metallwerke', country: 'DE', tax: 'DE812223334', supplier: true, terms: 14 },
  { name: 'Baltic Steel UAB', country: 'LT', tax: 'LT100001234567', supplier: true, terms: 30 },
  { name: 'Rhône Composites SA', country: 'FR', tax: 'FR64987654321', supplier: true, terms: 21 },
  { name: 'Kraków Tooling Sp.', country: 'PL', tax: 'PL5252445997', supplier: true, terms: 30 },
]

const SERVICES = [
  'Consulting engagement',
  'Systems integration',
  'Maintenance contract',
  'Licence renewal',
  'Installation services',
  'Support retainer',
]
const SUPPLIES = ['Steel sections', 'Machined components', 'Electrical parts', 'Freight & duty', 'Subcontract labour']

/** Deterministic pseudo-random, so re-seeding a fresh database gives the same
 *  demo every time and screenshots stay comparable. */
function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

async function main() {
  const handle = await db()

  // asPlatformAdmin, not withoutTenantScope: `organizations` is RLS-protected,
  // and there is no tenant scope to establish when the question is literally
  // "does this tenant exist yet?". Through the app role this check always
  // returned nothing, which made the idempotency guard below dead code and
  // turned a second `db:seed` into a duplicate-slug crash.
  const existing = await asPlatformAdmin(handle, async (tx) => {
    const rows = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, 'demo'))
      .limit(1)
    return rows[0]
  })

  if (existing) {
    console.log('[seed] demo organization already exists — nothing to do')
    console.log(`[seed] sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`)
    return
  }

  const orgId = newId()
  const userId = newId()

  // --- platform: org, owner, licence ---------------------------------------
  // System roles and permissions are NOT seeded here: they carry no tenant, so
  // the application role cannot insert them (RLS refuses, correctly). They are
  // seeded by drizzle/0003_platform_seed.sql as the schema owner.
  await withoutTenantScope(handle, async (tx) => {
    await tx.insert(users).values({
      id: userId,
      email: DEMO_EMAIL,
      name: 'Demo Owner',
      passwordHash: await hashPassword(DEMO_PASSWORD),
      emailVerifiedAt: new Date(),
      status: 'active',
    })
  })

  // The organization row must be inserted with app.org_id already set to its own
  // id — that is how the RLS WITH CHECK on `organizations` is satisfied at
  // signup, and the reason ids are generated application-side.
  await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
    await tx.insert(organizations).values({
      id: orgId,
      slug: 'demo',
      name: 'Vogel Handel GmbH',
      legalName: 'Vogel Handel GmbH',
      region: 'eu-central',
      baseCurrency: 'EUR',
      locale: 'de-DE',
      countryCode: 'DE',
      taxId: 'DE811111111',
      accent: 'syncrese',
      status: 'active',
    })

    await tx.insert(licenses).values({
      id: newId(),
      organizationId: orgId,
      plan: 'starter',
      seatCount: 10,
      status: 'active',
    })
  })

  const ownerRoleId = await withoutTenantScope(handle, async (tx) => {
    const rows = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(sql`${roles.key} = 'owner' and ${roles.organizationId} is null`)
      .limit(1)
    return rows[0]!.id
  })

  await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
    await tx.insert(memberships).values({
      id: newId(),
      organizationId: orgId,
      userId,
      roleId: ownerRoleId,
      status: 'active',
    })
  })

  console.log('[seed] organization and owner created')

  // --- finance: chart of accounts, tax, periods ---------------------------
  const actor = { organizationId: orgId, userId }

  await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
    await seedCurrencies(tx)
    await provisionFinance(tx, actor, { fiscalYear: new Date().getUTCFullYear() })
  })
  console.log('[seed] chart of accounts provisioned')

  // --- partners and bank account ------------------------------------------
  const partnerIds = await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
    const ids: { id: string; customer: boolean }[] = []
    for (const p of PARTNERS) {
      const id = newId()
      // Drawn from the document sequence, not hardcoded — otherwise the
      // sequence stays at 1 and the first partner created in the UI collides.
      const partnerNo = await nextDocumentNumber(tx, orgId, 'partner')
      await tx.insert(businessPartners).values({
        id,
        organizationId: orgId,
        partnerNo,
        name: p.name,
        legalName: p.name,
        isCustomer: !!p.customer,
        isSupplier: !!p.supplier,
        countryCode: p.country,
        taxId: p.tax,
        paymentTermsDays: p.terms,
        creditLimitMinor: p.customer ? 50_000_00 : null,
        currencyCode: 'EUR',
      })
      await tx.insert(partnerAddresses).values({
        id: newId(),
        organizationId: orgId,
        partnerId: id,
        type: 'billing',
        street: 'Hauptstraße 1',
        city: p.country === 'DE' ? 'München' : 'Rotterdam',
        postcode: '80331',
        countryCode: p.country,
        isDefault: true,
      })
      ids.push({ id, customer: !!p.customer })
    }

    const bankGl = await accountBySubtype(tx, orgId, 'bank')
    await tx.insert(bankAccounts).values({
      id: newId(),
      organizationId: orgId,
      name: 'Commerzbank current account',
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
      currencyCode: 'EUR',
      glAccountId: bankGl,
      isDefault: true,
    })

    return ids
  })
  console.log(`[seed] ${partnerIds.length} business partners created`)

  // --- twelve months of invoices and payments -----------------------------
  const rand = rng(20260810)
  const today = new Date()
  const customers = partnerIds.filter((p) => p.customer)
  const suppliers = partnerIds.filter((p) => !p.customer)

  const vatRateId = await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
    const rows = await tx
      .select({ id: taxRates.id })
      .from(taxRates)
      .where(sql`${taxRates.organizationId} = ${orgId} and ${taxRates.code} = 'STD'`)
      .limit(1)
    return rows[0]?.id ?? null
  })

  let issued = 0
  let paid = 0

  for (let monthsBack = 11; monthsBack >= 0; monthsBack--) {
    const month = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 1),
    )
    const salesCount = 3 + Math.floor(rand() * 4)

    for (let n = 0; n < salesCount; n++) {
      const day = 1 + Math.floor(rand() * 26)
      const issueDate = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day))
        .toISOString()
        .slice(0, 10)
      if (issueDate > today.toISOString().slice(0, 10)) continue

      const partner = customers[Math.floor(rand() * customers.length)]!
      const lineCount = 1 + Math.floor(rand() * 3)
      const lines = Array.from({ length: lineCount }, () => ({
        description: SERVICES[Math.floor(rand() * SERVICES.length)]!,
        quantity: 1 + Math.floor(rand() * 8),
        unitPriceMinor: (250 + Math.floor(rand() * 40) * 50) * 100,
        taxRateId: vatRateId,
      }))

      const created = await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
        createInvoice(tx, actor, {
          direction: 'ar',
          businessPartnerId: partner.id,
          issueDate,
          lines,
        }),
      )
      await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
        issueInvoice(tx, actor, created.id),
      )
      issued++

      // Most invoices get paid; the recent ones increasingly do not, so the
      // aging report has something real to show.
      const paysProbability = monthsBack > 2 ? 0.92 : 0.45
      if (rand() < paysProbability) {
        const payDay = new Date(
          Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(28, day + 12)),
        )
          .toISOString()
          .slice(0, 10)
        if (payDay <= today.toISOString().slice(0, 10)) {
          const bank = await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
            const rows = await tx.select({ id: bankAccounts.id }).from(bankAccounts).limit(1)
            return rows[0]!.id
          })
          await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
            recordPayment(tx, actor, {
              direction: 'in',
              paymentDate: payDay,
              bankAccountId: bank,
              amountMinor: created.totalMinor,
              allocations: [{ invoiceId: created.id, amountMinor: created.totalMinor }],
            }),
          )
          paid++
        }
      }
    }

    // A couple of supplier bills a month, most of them settled.
    for (let n = 0; n < 2; n++) {
      const day = 3 + Math.floor(rand() * 22)
      const issueDate = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day))
        .toISOString()
        .slice(0, 10)
      if (issueDate > today.toISOString().slice(0, 10)) continue

      const supplier = suppliers[Math.floor(rand() * suppliers.length)]!
      const created = await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
        createInvoice(tx, actor, {
          direction: 'ap',
          businessPartnerId: supplier.id,
          issueDate,
          lines: [
            {
              description: SUPPLIES[Math.floor(rand() * SUPPLIES.length)]!,
              quantity: 1,
              unitPriceMinor: (400 + Math.floor(rand() * 30) * 60) * 100,
              taxRateId: vatRateId,
            },
          ],
        }),
      )
      await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
        issueInvoice(tx, actor, created.id),
      )
      issued++

      if (rand() < 0.85) {
        const payDay = new Date(
          Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(28, day + 9)),
        )
          .toISOString()
          .slice(0, 10)
        if (payDay <= today.toISOString().slice(0, 10)) {
          const bank = await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
            const rows = await tx.select({ id: bankAccounts.id }).from(bankAccounts).limit(1)
            return rows[0]!.id
          })
          await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
            recordPayment(tx, actor, {
              direction: 'out',
              paymentDate: payDay,
              bankAccountId: bank,
              amountMinor: created.totalMinor,
              allocations: [{ invoiceId: created.id, amountMinor: created.totalMinor }],
            }),
          )
          paid++
        }
      }
    }
  }

  console.log(`[seed] ${issued} invoices issued, ${paid} settled`)

  // --- a bank statement to reconcile --------------------------------------
  await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
    const bank = (await tx.select({ id: bankAccounts.id }).from(bankAccounts).limit(1))[0]!
    const rows = ['date,amount,description,counterparty']
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1 + i))
        .toISOString()
        .slice(0, 10)
      const amount = (rand() < 0.6 ? 1 : -1) * (200 + Math.floor(rand() * 4000))
      rows.push(
        `${d},${amount}.00,${rand() < 0.5 ? 'Customer transfer' : 'Supplier payment'},${
          PARTNERS[Math.floor(rand() * PARTNERS.length)]!.name
        }`,
      )
    }
    await importBankCsv(tx, actor, {
      bankAccountId: bank.id,
      csv: rows.join('\n'),
      filename: 'statement.csv',
      columnMap: {
        date: 'date',
        amount: 'amount',
        description: 'description',
        counterpartyName: 'counterparty',
      },
    })
  })
  console.log('[seed] bank statement imported')

  // --- operations: warehouses, catalogue, orders, pipeline ----------------
  const ops = await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
    const income = await accountBySubtype(tx, orgId, 'revenue')
    const expense = await accountBySubtype(tx, orgId, 'operating_expense')
    const inventoryAcct = await accountBySubtype(tx, orgId, 'inventory')

    const munich = newId()
    const rotterdam = newId()
    await tx.insert(warehouses).values([
      { id: munich, organizationId: orgId, code: 'MUC', name: 'Munich DC', countryCode: 'DE', isDefault: true },
      { id: rotterdam, organizationId: orgId, code: 'RTM', name: 'Rotterdam', countryCode: 'NL' },
    ])

    const catalogue = [
      { sku: 'SRV-3500', name: 'Servo drive 3.5 kW', price: 1_450_00, cost: 890_00, reorder: 40 },
      { sku: 'ALU-4040', name: 'Aluminium profile 40×40', price: 38_00, cost: 17_50, reorder: 800 },
      { sku: 'BRG-SKF', name: 'Bearing housing SKF', price: 212_00, cost: 106_00, reorder: 120 },
      { sku: 'CAB-IP66', name: 'Control cabinet IP66', price: 1_980_00, cost: 1_120_00, reorder: 30 },
      { sku: 'PLC-1616', name: 'PLC module 16DI/16DO', price: 720_00, cost: 395_00, reorder: 75 },
      { sku: 'HMI-12', name: 'Touch panel 12" HMI', price: 1_150_00, cost: 640_00, reorder: 25 },
    ]
    const productIdBySku = new Map<string, string>()
    for (const c of catalogue) {
      const id = newId()
      productIdBySku.set(c.sku, id)
      await tx.insert(products).values({
        id,
        organizationId: orgId,
        sku: c.sku,
        name: c.name,
        type: 'stock',
        salesPriceMinor: c.price,
        costMinor: c.cost,
        currencyCode: 'EUR',
        incomeAccountId: income,
        expenseAccountId: expense,
        inventoryAccountId: inventoryAcct,
        taxRateId: vatRateId,
        isTracked: true,
        reorderPoint: String(c.reorder),
      })
    }

    await tx.insert(products).values({
      id: newId(),
      organizationId: orgId,
      sku: 'SVC-INSTALL',
      name: 'On-site installation',
      type: 'service',
      salesPriceMinor: 950_00,
      currencyCode: 'EUR',
      incomeAccountId: income,
      taxRateId: vatRateId,
      isTracked: false,
    })

    // A CRM pipeline with realistic stages.
    const pipelineId = newId()
    await tx.insert(pipelines).values({
      id: pipelineId,
      organizationId: orgId,
      name: 'New business',
      isDefault: true,
    })
    const stageDefs = [
      { name: 'Qualification', prob: 10 },
      { name: 'Proposal', prob: 35 },
      { name: 'Negotiation', prob: 65 },
      { name: 'Won', prob: 100, won: true },
      { name: 'Lost', prob: 0, lost: true },
    ]
    const stageIds: string[] = []
    for (const [i, s] of stageDefs.entries()) {
      const id = newId()
      stageIds.push(id)
      await tx.insert(pipelineStages).values({
        id,
        organizationId: orgId,
        pipelineId,
        name: s.name,
        position: i + 1,
        probabilityPct: s.prob,
        isWon: !!s.won,
        isLost: !!s.lost,
      })
    }

    await tx
      .insert(moduleSettings)
      .values({
        id: newId(),
        organizationId: orgId,
        moduleKey: 'purchasing',
        enabled: true,
        settings: {
          requisitionApprovalThresholdMinor: 2_500_00,
          priceToleranceMinor: 25_00,
          priceTolerancePct: 2,
        },
      })
      .onConflictDoNothing()

    return { munich, rotterdam, productIdBySku, pipelineId, stageIds }
  })

  // Stock the shelves through real purchase orders, so inventory value ties to
  // the ledger rather than appearing from nowhere.
  const skus = [...ops.productIdBySku.entries()]
  for (const [i, [, productId]] of skus.entries()) {
    const po = await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
      createPurchaseOrder(tx, actor, {
        supplierId: partnerIds.filter((p) => !p.customer)[i % 4]!.id,
        orderDate: '2026-01-12',
        expectedDate: '2026-01-26',
        shipToWarehouseId: ops.munich,
        lines: [
          {
            productId,
            description: 'Stock replenishment',
            quantity: 60 + i * 40,
            unitPriceMinor: (200 + i * 130) * 100,
            taxRateId: vatRateId,
          },
        ],
      }),
    )
    await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
      approvePurchaseOrder(tx, actor, po.id),
    )
    // Leave the last one only partially received so the module shows a live
    // GR/IR balance and a partially_received order.
    if (i < skus.length - 1) {
      await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
        receiveGoods(tx, actor, { purchaseOrderId: po.id, receiptDate: '2026-01-26' }),
      )
      await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
        matchSupplierInvoice(tx, actor, { purchaseOrderId: po.id, issueDate: '2026-02-02' }),
      )
    }
  }
  console.log(`[seed] ${skus.length} purchase orders raised, stock received`)

  // Sales orders across the year, at varying stages of fulfilment.
  let soCount = 0
  for (let i = 0; i < 14; i++) {
    const monthsBack = 11 - Math.floor((i / 14) * 11)
    const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 1))
    const orderDate = new Date(
      Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 2 + Math.floor(rand() * 20)),
    )
      .toISOString()
      .slice(0, 10)
    if (orderDate > today.toISOString().slice(0, 10)) continue

    // Only sell what was actually received. The final PO is deliberately left
    // un-received so the module shows a live GR/IR balance, which means that
    // product has no stock to ship.
    const sellable = skus.slice(0, -1)
    const productId = sellable[i % sellable.length]![1]
    const order = await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
      createSalesOrder(tx, actor, {
        businessPartnerId: customers[i % customers.length]!.id,
        orderDate,
        warehouseId: ops.munich,
        lines: [
          { productId, quantity: 2 + Math.floor(rand() * 6), taxRateId: vatRateId },
        ],
      }),
    )
    soCount++

    // Roughly: a fifth stay draft, the rest confirm; most of those ship; most
    // of those invoice. That spread is what makes the status chips meaningful.
    if (rand() < 0.8) {
      await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
        confirmSalesOrder(tx, actor, order.id),
      )
      if (rand() < 0.8) {
        const shipDate = new Date(new Date(`${orderDate}T00:00:00Z`).getTime() + 6 * 86400000)
          .toISOString()
          .slice(0, 10)
        if (shipDate <= today.toISOString().slice(0, 10)) {
          await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
            deliverSalesOrder(tx, actor, { salesOrderId: order.id, deliveryDate: shipDate }),
          )
          if (rand() < 0.75) {
            const billDate = new Date(new Date(`${shipDate}T00:00:00Z`).getTime() + 2 * 86400000)
              .toISOString()
              .slice(0, 10)
            if (billDate <= today.toISOString().slice(0, 10)) {
              await withTenant(handle, { organizationId: orgId, userId }, (tx) =>
                invoiceSalesOrder(tx, actor, order.id, { issueDate: billDate }),
              )
            }
          }
        }
      }
    }
  }
  console.log(`[seed] ${soCount} sales orders created across the year`)

  // Deals across the pipeline.
  await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
    const sources = ['Referral', 'Trade show', 'Inbound', 'Outbound', 'Partner']
    for (let i = 0; i < 12; i++) {
      const stageIndex = Math.floor(rand() * ops.stageIds.length)
      const stageId = ops.stageIds[stageIndex]!
      const status = stageIndex === 3 ? 'won' : stageIndex === 4 ? 'lost' : 'open'
      const close = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + Math.floor(rand() * 4), 15),
      )
        .toISOString()
        .slice(0, 10)

      await tx.insert(deals).values({
        id: newId(),
        organizationId: orgId,
        dealNo: `DL-${String(i + 1).padStart(5, '0')}`,
        name: `${['Line upgrade', 'Retrofit project', 'Framework agreement', 'Spare parts contract'][i % 4]} · ${PARTNERS.filter((p) => p.customer)[i % 6]!.name}`,
        businessPartnerId: customers[i % customers.length]!.id,
        pipelineId: ops.pipelineId,
        stageId,
        amountMinor: (5_000 + Math.floor(rand() * 60) * 1_000) * 100,
        currencyCode: 'EUR',
        expectedCloseDate: close,
        ownerUserId: userId,
        status,
        source: sources[i % sources.length]!,
        closedAt: status === 'open' ? null : new Date(),
      })
    }
  })
  console.log('[seed] 12 deals created')

  // --- team chat: a colleague, a channel, a DM, a linked record ------------
  const colleagueId = newId()
  await withoutTenantScope(handle, async (tx) => {
    await tx.insert(users).values({
      id: colleagueId,
      email: 'sarah@syncrese.test',
      name: 'Sarah Klein',
      passwordHash: await hashPassword(DEMO_PASSWORD),
      emailVerifiedAt: new Date(),
      status: 'active',
    })
  })

  const financeRoleId = await asPlatformAdmin(handle, async (tx) => {
    const rows = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(sql`${roles.key} = 'finance' and ${roles.organizationId} is null`)
      .limit(1)
    return rows[0]!.id
  })

  await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
    await tx.insert(memberships).values({
      id: newId(),
      organizationId: orgId,
      userId: colleagueId,
      roleId: financeRoleId,
      status: 'active',
    })
  })

  const chatCtx = {
    userId,
    organizationId: orgId,
    membershipId: 'seed',
    role: 'owner' as const,
    permissions: new Set<never>(),
    requestId: null,
    ip: null,
    userAgent: null,
  }

  const overdueInvoiceNo = await withTenant(
    handle,
    { organizationId: orgId, userId },
    async (tx) => {
      const res = await tx.execute(sql`
        select invoice_no from invoices
         where organization_id = ${orgId} and direction = 'ar'
           and status in ('issued','partially_paid')
         order by due_date
         limit 1
      `)
      return (res as unknown as { rows: { invoice_no: string }[] }).rows[0]?.invoice_no
    },
  )

  await withTenant(handle, { organizationId: orgId, userId }, async (tx) => {
    const finance = await createChannel(tx, chatCtx as never, {
      name: 'finance',
      topic: 'Month end, collections, anything AR',
      memberIds: [colleagueId],
    })

    await postMessage(tx, chatCtx as never, {
      channelId: finance.id,
      body: 'Morning — starting the month-end close today.',
    })
    if (overdueInvoiceNo) {
      await postMessage(tx, chatCtx as never, {
        channelId: finance.id,
        body: `@sarah could you chase ${overdueInvoiceNo}? It is the oldest one open.`,
      })
    }

    const dm = await openDirectMessage(tx, chatCtx as never, colleagueId)
    await postMessage(tx, chatCtx as never, {
      channelId: dm.id,
      body: 'Also — do you have five minutes to look at the VAT return?',
    })
  })
  console.log('[seed] team chat: 1 channel, 1 DM, colleague sarah@syncrese.test')

  console.log('')
  console.log('  Seed complete.')
  console.log(`  Sign in at /sign-in as  ${DEMO_EMAIL}  /  ${DEMO_PASSWORD}`)
  console.log('')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
