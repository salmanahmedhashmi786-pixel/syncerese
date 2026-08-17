import { and, eq, sql } from 'drizzle-orm'
import { businessPartners, deals, invoices, products } from '@/db/schema'
import type { TenantTx } from '@/db/tenant'
import { AppError } from '@/lib/errors'
import { newId } from '@/lib/ids'
import { writeAudit } from '@/lib/audit'
import type { RequestContext } from '@/server/context'
import { can } from '@/server/context'
import { parseMoney } from '@/finance/money'
import { baseCurrencyOf, nextDocumentNumber, type PostingActor } from '@/finance/ledger'
import { createInvoice, issueInvoice } from '@/finance/invoices'
import { createCreditNote } from '@/finance/credit-notes'
import { recordPayment } from '@/finance/payments'
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
import { validateCustomFields } from './custom-fields'
import type { ModuleId } from './registry'
import { writesFor, type FieldKind } from './writes'

/**
 * Executes writes declared in the write registry.
 *
 * Everything routes through the SAME services the API and the seed use — an
 * invoice raised from the UI posts to the ledger under identical double-entry
 * rules. Nothing here writes a business table directly except the simple master
 * records that have no posting logic of their own.
 */

const actorOf = (ctx: RequestContext): PostingActor => ({
  organizationId: ctx.organizationId,
  userId: ctx.userId,
  requestId: ctx.requestId,
  ip: ctx.ip,
})

/** Coerces a form value to what the service expects. */
async function coerce(
  tx: TenantTx,
  organizationId: string,
  kind: FieldKind,
  value: unknown,
  currency?: string,
): Promise<unknown> {
  if (value === null || value === undefined || value === '') return null

  switch (kind) {
    case 'money': {
      // Users type "1.234,56", services want integer minor units.
      const base = currency ?? (await baseCurrencyOf(tx, organizationId))
      return parseMoney(String(value), base)
    }
    case 'number': {
      const n = Number(String(value).replace(',', '.'))
      if (!Number.isFinite(n)) throw new AppError('VALIDATION_FAILED', `"${value}" is not a number`)
      return n
    }
    case 'boolean':
      return value === true || value === 'true'
    case 'date': {
      const s = String(value)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        throw new AppError('VALIDATION_FAILED', `"${s}" is not a date (expected YYYY-MM-DD)`)
      }
      return s
    }
    default:
      return String(value)
  }
}

async function coerceAll(
  tx: TenantTx,
  organizationId: string,
  fields: { key: string; kind: FieldKind }[],
  raw: Record<string, unknown>,
  currency?: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (!(field.key in raw)) continue
    out[field.key] = await coerce(tx, organizationId, field.kind, raw[field.key], currency)
  }
  return out
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createRecord(
  tx: TenantTx,
  ctx: RequestContext,
  module: ModuleId,
  input: Record<string, unknown>,
): Promise<{ id: string; label: string }> {
  const spec = writesFor(module)
  if (!spec) throw new AppError('VALIDATION_FAILED', `${module} does not support creating records`)
  if (!can(ctx, spec.createPermission)) {
    throw new AppError('FORBIDDEN', `Your role cannot create ${module}`)
  }

  const currency = (input.currencyCode as string) || undefined
  const data = await coerceAll(tx, ctx.organizationId, spec.create, input, currency)

  for (const field of spec.create) {
    if (field.required && (data[field.key] === null || data[field.key] === undefined)) {
      throw new AppError('VALIDATION_FAILED', `${field.label} is required`)
    }
  }

  const rawLines = Array.isArray(input.lines) ? (input.lines as Record<string, unknown>[]) : []
  const lines: Record<string, unknown>[] = []
  if (spec.lines) {
    for (const raw of rawLines) {
      const line = await coerceAll(tx, ctx.organizationId, spec.lines.fields, raw, currency)
      // Ignore rows the user added but never filled in.
      const meaningful = spec.lines.fields.some(
        (f) => f.required && line[f.key] !== null && line[f.key] !== undefined,
      )
      if (meaningful) lines.push(line)
    }
    if (lines.length < spec.lines.min) {
      throw new AppError('VALIDATION_FAILED', `At least ${spec.lines.min} line is required`)
    }
  }

  const actor = actorOf(ctx)

  switch (module) {
    case 'customers': {
      const role = String(data.role ?? 'customer')
      const id = newId()
      const partnerNo = await nextDocumentNumber(tx, ctx.organizationId, 'partner')
      await tx.insert(businessPartners).values({
        id,
        organizationId: ctx.organizationId,
        partnerNo,
        name: String(data.name),
        legalName: (data.legalName as string) ?? null,
        isCustomer: role === 'customer' || role === 'both',
        isSupplier: role === 'supplier' || role === 'both',
        isProspect: role === 'prospect',
        countryCode: (data.countryCode as string)?.toUpperCase() ?? null,
        taxId: (data.taxId as string) ?? null,
        paymentTermsDays: (data.paymentTermsDays as number) ?? 30,
        creditLimitMinor: (data.creditLimitMinor as number) ?? null,
        currencyCode: (data.currencyCode as string)?.toUpperCase() ?? null,
        customFields: await validateCustomFields(
          tx,
          ctx.organizationId,
          'business_partner',
          (input.customFields as Record<string, unknown>) ?? {},
        ),
        createdBy: ctx.userId,
      })
      await audit(tx, ctx, 'business_partner.created', 'business_partner', id, {
        partnerNo,
        name: data.name,
      })
      return { id, label: `${partnerNo} · ${data.name}` }
    }

    case 'products': {
      const id = newId()
      await tx.insert(products).values({
        id,
        organizationId: ctx.organizationId,
        sku: String(data.sku),
        name: String(data.name),
        description: (data.description as string) ?? null,
        type: String(data.type ?? 'stock'),
        salesPriceMinor: (data.salesPriceMinor as number) ?? 0,
        costMinor: (data.costMinor as number) ?? 0,
        reorderPoint: data.reorderPoint === null ? null : String(data.reorderPoint),
        taxRateId: (data.taxRateId as string) ?? null,
        isTracked: String(data.type ?? 'stock') === 'stock',
        customFields: await validateCustomFields(
          tx,
          ctx.organizationId,
          'product',
          (input.customFields as Record<string, unknown>) ?? {},
        ),
        createdBy: ctx.userId,
      })
      await audit(tx, ctx, 'product.created', 'product', id, { sku: data.sku, name: data.name })
      return { id, label: `${data.sku} · ${data.name}` }
    }

    case 'deals': {
      const stage = (
        await tx.execute(sql`
          select ps.id, ps.pipeline_id as "pipelineId"
            from pipeline_stages ps
            join pipelines p on p.id = ps.pipeline_id
           where ps.organization_id = ${ctx.organizationId}
             and not ps.is_won and not ps.is_lost
           order by p.is_default desc, ps.position
           limit 1
        `)
      ) as unknown as { rows: { id: string; pipelineId: string }[] }

      if (!stage.rows[0]) {
        throw new AppError(
          'VALIDATION_FAILED',
          'No pipeline is configured yet. Create one before adding deals.',
        )
      }

      const id = newId()
      const dealNo = await nextDocumentNumber(tx, ctx.organizationId, 'deal')
      await tx.insert(deals).values({
        id,
        organizationId: ctx.organizationId,
        dealNo,
        name: String(data.name),
        businessPartnerId: (data.businessPartnerId as string) ?? null,
        pipelineId: stage.rows[0].pipelineId,
        stageId: stage.rows[0].id,
        amountMinor: (data.amountMinor as number) ?? 0,
        currencyCode: await baseCurrencyOf(tx, ctx.organizationId),
        expectedCloseDate: (data.expectedCloseDate as string) ?? null,
        ownerUserId: ctx.userId,
        source: (data.source as string) ?? null,
        customFields: await validateCustomFields(
          tx,
          ctx.organizationId,
          'deal',
          (input.customFields as Record<string, unknown>) ?? {},
        ),
        createdBy: ctx.userId,
      })
      await audit(tx, ctx, 'deal.created', 'deal', id, { dealNo, name: data.name })
      return { id, label: `${dealNo} · ${data.name}` }
    }

    case 'invoices': {
      const created = await createInvoice(tx, actor, {
        direction: data.direction as 'ar' | 'ap',
        businessPartnerId: String(data.businessPartnerId),
        issueDate: String(data.issueDate),
        dueDate: (data.dueDate as string) ?? undefined,
        currencyCode: (data.currencyCode as string) ?? undefined,
        fxRate: (data.fxRate as number) ?? undefined,
        notes: (data.notes as string) ?? null,
        lines: lines.map((l) => ({
          description: String(l.description),
          quantity: (l.quantity as number) ?? 1,
          unitPriceMinor: (l.unitPriceMinor as number) ?? 0,
          taxRateId: (l.taxRateId as string) ?? null,
        })),
      })
      return { id: created.id, label: created.invoiceNo }
    }

    case 'sales-orders': {
      const created = await createSalesOrder(tx, actor, {
        businessPartnerId: String(data.businessPartnerId),
        orderDate: String(data.orderDate),
        requestedDeliveryDate: (data.requestedDeliveryDate as string) ?? null,
        warehouseId: (data.warehouseId as string) ?? null,
        customerReference: (data.customerReference as string) ?? null,
        lines: lines.map((l) => ({
          productId: (l.productId as string) ?? null,
          description: (l.description as string) ?? undefined,
          quantity: (l.quantity as number) ?? 1,
          unitPriceMinor: (l.unitPriceMinor as number) ?? undefined,
          taxRateId: (l.taxRateId as string) ?? null,
        })),
      })
      return { id: created.id, label: created.orderNo }
    }

    case 'purchase-orders': {
      const created = await createPurchaseOrder(tx, actor, {
        supplierId: String(data.supplierId),
        orderDate: String(data.orderDate),
        expectedDate: (data.expectedDate as string) ?? null,
        shipToWarehouseId: (data.shipToWarehouseId as string) ?? null,
        lines: lines.map((l) => ({
          productId: (l.productId as string) ?? null,
          description: String(l.description),
          quantity: (l.quantity as number) ?? 1,
          unitPriceMinor: (l.unitPriceMinor as number) ?? 0,
          taxRateId: (l.taxRateId as string) ?? null,
        })),
      })
      return { id: created.id, label: created.poNo }
    }

    default:
      throw new AppError('VALIDATION_FAILED', `${module} does not support creating records`)
  }
}

// ---------------------------------------------------------------------------
// Inline update
// ---------------------------------------------------------------------------

const TABLE_FOR: Partial<Record<ModuleId, { table: string; status?: string }>> = {
  customers: { table: 'business_partners' },
  products: { table: 'products' },
  deals: { table: 'deals', status: 'status' },
  invoices: { table: 'invoices', status: 'status' },
  'sales-orders': { table: 'sales_orders', status: 'status' },
  'purchase-orders': { table: 'purchase_orders', status: 'status' },
  banking: { table: 'bank_transactions' },
}

/** Camel to snake, for the small set of allowlisted column names. */
const columnFor = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

export async function updateField(
  tx: TenantTx,
  ctx: RequestContext,
  module: ModuleId,
  recordId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const spec = writesFor(module)
  const target = TABLE_FOR[module]
  if (!spec || !target) {
    throw new AppError('VALIDATION_FAILED', `${module} does not support editing`)
  }
  if (!can(ctx, spec.updatePermission)) {
    throw new AppError('FORBIDDEN', 'Your role cannot edit these records')
  }

  // The field must be declared editable. Anything else is refused rather than
  // written — this is the allowlist that stops a crafted request from setting
  // an invoice total or a posted status.
  const field = spec.editable.find((f) => f.key === key)
  if (!field) throw new AppError('FORBIDDEN', `"${key}" is not editable`)

  const before = (
    (await tx.execute(sql`
      select * from ${sql.raw(target.table)}
       where id = ${recordId} and organization_id = ${ctx.organizationId}
       limit 1
    `)) as unknown as { rows: Record<string, unknown>[] }
  ).rows[0]

  if (!before) throw new AppError('NOT_FOUND', 'Record not found')

  if (field.whenStatus && target.status) {
    const status = String(before[target.status])
    if (!field.whenStatus.includes(status)) {
      throw new AppError(
        'CONFLICT',
        `This record is ${status.replace(/_/g, ' ')} and can no longer be edited.`,
      )
    }
  }

  const currency = (before.currency_code as string) ?? undefined
  const coerced = await coerce(tx, ctx.organizationId, field.kind, value, currency)
  const column = columnFor(key)

  await tx.execute(sql`
    update ${sql.raw(target.table)}
       set ${sql.raw(column)} = ${coerced}
     where id = ${recordId} and organization_id = ${ctx.organizationId}
  `)

  await audit(tx, ctx, `${module}.updated`, module, recordId, {
    field: key,
    from: before[column] ?? null,
    to: coerced,
  })
}

// ---------------------------------------------------------------------------
// Document actions
// ---------------------------------------------------------------------------

export async function runAction(
  tx: TenantTx,
  ctx: RequestContext,
  module: ModuleId,
  recordId: string,
  actionKey: string,
  input: Record<string, unknown> = {},
): Promise<{ message: string }> {
  const spec = writesFor(module)
  const action = spec?.actions?.find((a) => a.key === actionKey)
  if (!action) throw new AppError('NOT_FOUND', 'Unknown action')
  if (!can(ctx, action.permission)) {
    throw new AppError('FORBIDDEN', `Your role cannot ${action.label.toLowerCase()}`)
  }

  const actor = actorOf(ctx)
  const args = await coerceAll(tx, ctx.organizationId, action.fields ?? [], input)
  const today = new Date().toISOString().slice(0, 10)

  switch (actionKey) {
    case 'invoice.issue': {
      const result = await issueInvoice(tx, actor, recordId)
      return { message: `Issued · journal entry ${result.entryNo}` }
    }

    case 'invoice.pay': {
      const invoice = (
        await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, recordId), eq(invoices.organizationId, ctx.organizationId)))
          .limit(1)
      )[0]
      if (!invoice) throw new AppError('NOT_FOUND', 'Invoice not found')

      const amount =
        (args.amountMinor as number) ??
        invoice.totalMinor - invoice.amountPaidMinor - invoice.creditedMinor

      const result = await recordPayment(tx, actor, {
        direction: invoice.direction === 'ar' ? 'in' : 'out',
        paymentDate: String(args.paymentDate ?? today),
        bankAccountId: String(args.bankAccountId),
        businessPartnerId: invoice.businessPartnerId,
        currencyCode: invoice.currencyCode,
        fxRate: invoice.fxRate,
        amountMinor: amount,
        reference: (args.reference as string) ?? null,
        allocations: [{ invoiceId: recordId, amountMinor: amount }],
      })
      return { message: `Payment ${result.paymentNo} recorded` }
    }

    case 'invoice.credit': {
      // Creates a DRAFT credit note. It is posted by the ordinary
      // `invoice.issue` action, so the person correcting a mistake gets to look
      // at the correction before it reaches the ledger.
      const result = await createCreditNote(tx, actor, {
        invoiceId: recordId,
        reason: String(args.reason ?? ''),
        issueDate: String(args.issueDate ?? today),
      })
      return { message: `Credit note ${result.invoiceNo} drafted — review it, then issue it` }
    }

    case 'sales_order.confirm':
      await confirmSalesOrder(tx, actor, recordId)
      return { message: 'Order confirmed' }

    case 'sales_order.deliver': {
      const result = await deliverSalesOrder(tx, actor, {
        salesOrderId: recordId,
        deliveryDate: String(args.deliveryDate ?? today),
      })
      return { message: `Shipped · ${result.deliveryNo}` }
    }

    case 'sales_order.invoice': {
      const result = await invoiceSalesOrder(tx, actor, recordId, {
        issueDate: String(args.issueDate ?? today),
      })
      return { message: `Invoiced · ${result.invoiceNo}` }
    }

    case 'purchase_order.approve':
      await approvePurchaseOrder(tx, actor, recordId)
      return { message: 'Purchase order approved' }

    case 'purchase_order.receive': {
      const result = await receiveGoods(tx, actor, {
        purchaseOrderId: recordId,
        receiptDate: String(args.receiptDate ?? today),
      })
      return { message: `Received · ${result.receiptNo}` }
    }

    case 'purchase_order.bill': {
      const result = await matchSupplierInvoice(tx, actor, {
        purchaseOrderId: recordId,
        issueDate: String(args.issueDate ?? today),
        supplierInvoiceRef: (args.supplierInvoiceRef as string) ?? null,
        billedNetMinor: (args.billedNetMinor as number) ?? undefined,
      })
      return {
        message:
          result.matchStatus === 'matched'
            ? `Bill ${result.invoiceNo} matched`
            : `Bill ${result.invoiceNo} posted with a price variance`,
      }
    }

    case 'deal.won':
    case 'deal.lost': {
      const won = actionKey === 'deal.won'
      const stage = (
        (await tx.execute(sql`
          select id from pipeline_stages
           where organization_id = ${ctx.organizationId}
             and ${sql.raw(won ? 'is_won' : 'is_lost')}
           limit 1
        `)) as unknown as { rows: { id: string }[] }
      ).rows[0]

      await tx
        .update(deals)
        .set({
          status: won ? 'won' : 'lost',
          stageId: stage?.id,
          lostReason: won ? null : ((args.lostReason as string) ?? null),
          closedAt: new Date(),
        })
        .where(and(eq(deals.id, recordId), eq(deals.organizationId, ctx.organizationId)))

      await audit(tx, ctx, won ? 'deal.won' : 'deal.lost', 'deal', recordId, {
        reason: args.lostReason,
      })
      return { message: won ? 'Deal marked won' : 'Deal marked lost' }
    }

    default:
      throw new AppError('NOT_FOUND', 'Unknown action')
  }
}

/** Status of a record, so the UI can offer only the actions that apply. */
export async function statusOf(
  tx: TenantTx,
  organizationId: string,
  module: ModuleId,
  recordId: string,
): Promise<string | null> {
  const target = TABLE_FOR[module]
  if (!target?.status) return null
  const res = (await tx.execute(sql`
    select ${sql.raw(target.status)} as status from ${sql.raw(target.table)}
     where id = ${recordId} and organization_id = ${organizationId} limit 1
  `)) as unknown as { rows: { status: string }[] }
  return res.rows[0]?.status ?? null
}

async function audit(
  tx: TenantTx,
  ctx: RequestContext,
  action: string,
  entityType: string,
  entityId: string,
  after: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    action,
    entityType,
    entityId,
    after,
    requestId: ctx.requestId,
    ip: ctx.ip,
  })
}

/** Reference data the create form needs for its dropdowns. */
export async function formOptions(tx: TenantTx, organizationId: string) {
  const q = async <T>(text: ReturnType<typeof sql>) =>
    ((await tx.execute(text)) as unknown as { rows: T[] }).rows

  const [partners, productList, taxRates, warehouses, bankAccounts, accounts] = await Promise.all([
    q<{ id: string; label: string }>(sql`
      select id, partner_no || ' · ' || name as label from business_partners
       where organization_id = ${organizationId} and archived_at is null order by name limit 500`),
    q<{ id: string; label: string }>(sql`
      select id, sku || ' · ' || name as label from products
       where organization_id = ${organizationId} and archived_at is null order by sku limit 500`),
    q<{ id: string; label: string }>(sql`
      select id, name || ' (' || round(rate * 100) || '%)' as label from tax_rates
       where organization_id = ${organizationId} and archived_at is null order by is_default desc, code`),
    q<{ id: string; label: string }>(sql`
      select id, code || ' · ' || name as label from warehouses
       where organization_id = ${organizationId} and archived_at is null order by code`),
    q<{ id: string; label: string }>(sql`
      select id, name as label from bank_accounts
       where organization_id = ${organizationId} and archived_at is null order by is_default desc, name`),
    q<{ id: string; label: string }>(sql`
      select id, code || ' · ' || name as label from accounts
       where organization_id = ${organizationId} and is_postable and archived_at is null order by code`),
  ])

  return { partners, products: productList, taxRates, warehouses, bankAccounts, accounts }
}
