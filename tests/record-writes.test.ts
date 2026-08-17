import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { grantsFor } from '@/auth/permissions'
import { createRecord, runAction, updateField } from '@/modules/write-service'
import { listModule } from '@/modules/queries'
import { trialBalance } from '@/finance/reports'
import { stockLevel } from '@/inventory/valuation'
import type { RequestContext } from '@/server/context'
import { createOpsFixture, accountMovement, type OpsFixture } from './helpers/operations'
import { FULL_ACCESS } from '@/billing/access'

const YEAR = { from: '2026-01-01', to: '2026-12-31' }
const TODAY = '2026-06-15'

const ctxFor = (
  f: OpsFixture,
  role: 'owner' | 'sales' | 'finance' | 'readonly' = 'owner',
): RequestContext => ({
  userId: f.actor.userId!,
  organizationId: f.orgId,
  membershipId: 'test',
  role,
  permissions: grantsFor(role),
  requestId: null,
  ip: null,
  userAgent: null,
  // These fixtures build a context by hand rather than through resolveContext.
  // A licensed, in-date tenant is the right default: nothing here is testing
  // billing, and an unlicensed default would make every unrelated write fail.
  licence: FULL_ACCESS,
})

describe('record writes', () => {
  let f: OpsFixture

  beforeEach(async () => {
    f = await createOpsFixture()
  })

  afterEach(async () => {
    await f.t.close()
  })

  describe('creating master data', () => {
    it('creates a business partner with a generated number', async () => {
      const created = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'customers', {
          name: 'Neue Kunde GmbH',
          role: 'customer',
          countryCode: 'de',
          paymentTermsDays: '45',
          creditLimitMinor: '25000.00',
        }),
      )
      expect(created.label).toMatch(/BP-\d+ · Neue Kunde GmbH/)

      const rows = await f.tx((tx) =>
        listModule(tx, f.orgId, 'customers', { q: 'Neue Kunde' }, TODAY),
      )
      expect(rows.rows).toHaveLength(1)
      // Money typed as "25000.00" must land as integer minor units.
      expect(rows.rows[0]!.creditLimitMinor).toBe(2500000)
      expect(rows.rows[0]!.countryCode).toBe('DE')
    })

    it('creates a product', async () => {
      await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'products', {
          sku: 'NEW-01',
          name: 'New widget',
          type: 'stock',
          salesPriceMinor: '199.99',
          reorderPoint: '25',
        }),
      )
      const rows = await f.tx((tx) => listModule(tx, f.orgId, 'products', { q: 'NEW-01' }, TODAY))
      expect(rows.rows[0]!.salesPriceMinor).toBe(19999)
    })

    it('never collides with numbers already in use', async () => {
      // Any code that inserts a partner must draw from the document sequence.
      // Hardcoding a number leaves the sequence behind the data, and the first
      // record a user creates fails on the unique constraint — which is what
      // both the seed and this fixture used to do.
      const created: string[] = []
      for (let i = 0; i < 5; i++) {
        const record = await f.tx((tx) =>
          createRecord(tx, ctxFor(f), 'customers', { name: `Sequential ${i}`, role: 'customer' }),
        )
        created.push(record.label.split(' · ')[0]!)
      }
      expect(new Set(created).size).toBe(5)

      const total = await f.tx(async (tx) => {
        const res = await tx.execute(
          sql`select count(distinct partner_no)::int as n, count(*)::int as total
                from business_partners where organization_id = ${f.orgId}`,
        )
        return (res as unknown as { rows: { n: number; total: number }[] }).rows[0]!
      })
      expect(Number(total.n)).toBe(Number(total.total))
    })

    it('rejects a missing required field', async () => {
      await expect(
        f.tx((tx) => createRecord(tx, ctxFor(f), 'customers', { role: 'customer' })),
      ).rejects.toThrow(/Name is required/)
    })

    it('rejects a malformed money value rather than storing zero', async () => {
      await expect(
        f.tx((tx) =>
          createRecord(tx, ctxFor(f), 'customers', {
            name: 'X',
            role: 'customer',
            creditLimitMinor: 'about five thousand',
          }),
        ),
      ).rejects.toThrow(/not a valid amount/)
    })

    it('refuses a role that lacks the create permission', async () => {
      await expect(
        f.tx((tx) =>
          createRecord(tx, ctxFor(f, 'readonly'), 'customers', { name: 'X', role: 'customer' }),
        ),
      ).rejects.toThrow(/cannot create/)
    })
  })

  describe('creating documents', () => {
    it('creates an invoice with lines and posts it on issue', async () => {
      const created = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'invoices', {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-06-01',
          lines: [
            { description: 'Consulting', quantity: '10', unitPriceMinor: '100.00', taxRateId: f.vatRateId },
          ],
        }),
      )

      // Draft: nothing in the ledger yet.
      expect(await accountMovement(f, 'accounts_receivable')).toBe(0)

      await f.tx((tx) => runAction(tx, ctxFor(f), 'invoices', created.id, 'invoice.issue'))

      expect(await accountMovement(f, 'accounts_receivable')).toBe(119000)
      expect(await accountMovement(f, 'revenue')).toBe(-100000)

      const tb = await f.tx((tx) => trialBalance(tx, f.orgId, YEAR))
      expect(tb.inBalance).toBe(true)
    })

    it('derives the due date from the partner’s payment terms when left blank', async () => {
      await f.t.sudo(
        `update business_partners set payment_terms_days = 45 where id = '${f.customerId}'`,
      )
      const created = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'invoices', {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-06-01',
          lines: [{ description: 'Goods', quantity: '1', unitPriceMinor: '100.00' }],
        }),
      )

      const row = await f.tx(async (tx) => {
        const res = await tx.execute(
          sql`select issue_date, due_date from invoices where id = ${created.id}`,
        )
        return (res as unknown as { rows: { issue_date: string; due_date: string }[] }).rows[0]!
      })
      expect(row.issue_date).toBe('2026-06-01')
      expect(row.due_date).toBe('2026-07-16') // +45 days
    })

    it('rejects a document with no usable lines', async () => {
      await expect(
        f.tx((tx) =>
          createRecord(tx, ctxFor(f), 'invoices', {
            direction: 'ar',
            businessPartnerId: f.customerId,
            issueDate: '2026-06-01',
            lines: [{ description: '', unitPriceMinor: '' }],
          }),
        ),
      ).rejects.toThrow(/At least 1 line is required/)
    })

    it('records a payment against an issued invoice', async () => {
      const created = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'invoices', {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-06-01',
          lines: [{ description: 'Goods', quantity: '1', unitPriceMinor: '1000.00' }],
        }),
      )
      await f.tx((tx) => runAction(tx, ctxFor(f), 'invoices', created.id, 'invoice.issue'))

      const result = await f.tx((tx) =>
        runAction(tx, ctxFor(f), 'invoices', created.id, 'invoice.pay', {
          paymentDate: '2026-06-10',
          bankAccountId: f.bankAccountId,
        }),
      )
      expect(result.message).toMatch(/Payment PAY-\d+ recorded/)

      // Defaulting to the full outstanding amount closes the invoice.
      expect(await accountMovement(f, 'accounts_receivable')).toBe(0)
      expect(await accountMovement(f, 'bank')).toBe(100000)
    })
  })

  describe('inline editing', () => {
    it('updates an allowlisted field and coerces money', async () => {
      const created = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'customers', { name: 'Editable Co', role: 'customer' }),
      )
      await f.tx((tx) =>
        updateField(tx, ctxFor(f), 'customers', created.id, 'creditLimitMinor', '12500.50'),
      )

      const rows = await f.tx((tx) =>
        listModule(tx, f.orgId, 'customers', { q: 'Editable Co' }, TODAY),
      )
      expect(rows.rows[0]!.creditLimitMinor).toBe(1250050)
    })

    it('REFUSES a field that is not on the allowlist', async () => {
      const created = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'customers', { name: 'Locked Co', role: 'customer' }),
      )
      // partner_no is a real column, but it is not declared editable — the
      // allowlist is what stops a crafted request from rewriting it.
      await expect(
        f.tx((tx) => updateField(tx, ctxFor(f), 'customers', created.id, 'partnerNo', 'BP-99999')),
      ).rejects.toThrow(/not editable/)

      await expect(
        f.tx((tx) => updateField(tx, ctxFor(f), 'customers', created.id, 'isCustomer', 'false')),
      ).rejects.toThrow(/not editable/)
    })

    it('REFUSES to edit an issued invoice', async () => {
      const created = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'invoices', {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-06-01',
          lines: [{ description: 'Goods', quantity: '1', unitPriceMinor: '100.00' }],
        }),
      )

      // Editable while draft…
      await expect(
        f.tx((tx) => updateField(tx, ctxFor(f), 'invoices', created.id, 'dueDate', '2026-07-15')),
      ).resolves.not.toThrow()

      await f.tx((tx) => runAction(tx, ctxFor(f), 'invoices', created.id, 'invoice.issue'))

      // …and immutable once posted.
      await expect(
        f.tx((tx) => updateField(tx, ctxFor(f), 'invoices', created.id, 'dueDate', '2026-08-15')),
      ).rejects.toThrow(/can no longer be edited/)
    })

    it('refuses a role without the update permission', async () => {
      const created = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'customers', { name: 'X Co', role: 'customer' }),
      )
      await expect(
        f.tx((tx) => updateField(tx, ctxFor(f, 'readonly'), 'customers', created.id, 'name', 'Y')),
      ).rejects.toThrow(/cannot edit/)
    })

    it('writes an audit entry with before and after', async () => {
      const created = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'customers', { name: 'Audited Co', role: 'customer' }),
      )
      await f.tx((tx) =>
        updateField(tx, ctxFor(f), 'customers', created.id, 'paymentTermsDays', '60'),
      )

      const entries = await f.tx(async (tx) => {
        const res = await tx.execute(sql`
          select action, after from audit_log
           where organization_id = ${f.orgId} and entity_id = ${created.id}
           order by occurred_at
        `)
        return (res as unknown as { rows: { action: string; after: Record<string, unknown> }[] })
          .rows
      })
      const update = entries.find((e) => e.action === 'customers.updated')!
      expect(update.after).toMatchObject({ field: 'paymentTermsDays', from: 30, to: 60 })
    })
  })

  describe('document actions', () => {
    it('runs the full sales order flow from the UI layer', async () => {
      await f.t.sudo(`
        insert into stock_levels (organization_id, product_id, warehouse_id, qty_on_hand, avg_cost_minor)
        values ('${f.orgId}', '${f.widgetId}', '${f.warehouseId}', 100, 4000)
      `)

      const order = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'sales-orders', {
          businessPartnerId: f.customerId,
          orderDate: '2026-06-01',
          warehouseId: f.warehouseId,
          lines: [{ productId: f.widgetId, quantity: '10', unitPriceMinor: '100.00' }],
        }),
      )

      await f.tx((tx) =>
        runAction(tx, ctxFor(f), 'sales-orders', order.id, 'sales_order.confirm'),
      )
      const shipped = await f.tx((tx) =>
        runAction(tx, ctxFor(f), 'sales-orders', order.id, 'sales_order.deliver', {
          deliveryDate: '2026-06-05',
        }),
      )
      expect(shipped.message).toMatch(/Shipped · DN-/)

      // COGS posted at the weighted average, stock reduced.
      expect(await accountMovement(f, 'cogs')).toBe(40000)
      expect(
        (await f.tx((tx) => stockLevel(tx, f.orgId, f.widgetId, f.warehouseId))).qtyOnHand,
      ).toBe(90)

      const invoiced = await f.tx((tx) =>
        runAction(tx, ctxFor(f), 'sales-orders', order.id, 'sales_order.invoice', {
          issueDate: '2026-06-06',
        }),
      )
      expect(invoiced.message).toMatch(/Invoiced · INV-/)
      expect(await accountMovement(f, 'revenue')).toBe(-100000)

      const tb = await f.tx((tx) => trialBalance(tx, f.orgId, YEAR))
      expect(tb.inBalance).toBe(true)
    })

    it('runs the purchase order flow and clears GR/IR', async () => {
      const po = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'purchase-orders', {
          supplierId: f.supplierId,
          orderDate: '2026-06-01',
          shipToWarehouseId: f.warehouseId,
          lines: [
            { productId: f.widgetId, description: 'Widgets', quantity: '10', unitPriceMinor: '40.00' },
          ],
        }),
      )

      await f.tx((tx) =>
        runAction(tx, ctxFor(f), 'purchase-orders', po.id, 'purchase_order.approve'),
      )
      await f.tx((tx) =>
        runAction(tx, ctxFor(f), 'purchase-orders', po.id, 'purchase_order.receive', {
          receiptDate: '2026-06-05',
        }),
      )
      expect(await accountMovement(f, 'gr_ir_clearing')).toBe(-40000)

      await f.tx((tx) =>
        runAction(tx, ctxFor(f), 'purchase-orders', po.id, 'purchase_order.bill', {
          issueDate: '2026-06-08',
        }),
      )
      expect(await accountMovement(f, 'gr_ir_clearing')).toBe(0)
      expect(await accountMovement(f, 'accounts_payable')).toBe(-40000)
    })

    it('refuses an action the role lacks permission for', async () => {
      const created = await f.tx((tx) =>
        createRecord(tx, ctxFor(f), 'invoices', {
          direction: 'ar',
          businessPartnerId: f.customerId,
          issueDate: '2026-06-01',
          lines: [{ description: 'Goods', quantity: '1', unitPriceMinor: '100.00' }],
        }),
      )
      // Sales can create an invoice but not issue it to the ledger.
      await expect(
        f.tx((tx) => runAction(tx, ctxFor(f, 'sales'), 'invoices', created.id, 'invoice.issue')),
      ).rejects.toThrow(/cannot issue/i)
    })

    it('rejects an unknown action', async () => {
      await expect(
        f.tx((tx) =>
          runAction(tx, ctxFor(f), 'invoices', '00000000-0000-4000-8000-000000000001', 'invoice.nuke'),
        ),
      ).rejects.toThrow(/Unknown action/)
    })
  })
})
