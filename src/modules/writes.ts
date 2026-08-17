import { z } from 'zod'
import type { Permission } from '@/auth/permissions'
import type { ModuleId } from './registry'

/**
 * The write registry.
 *
 * Declares, per module, what may be created, what may be edited in place, and
 * which document actions are available. Everything a write can touch is
 * enumerated here — the generic endpoints refuse anything absent from this
 * file, so a new writable field is a deliberate entry rather than an accident
 * of what the client happened to send.
 *
 * This is the counterpart to `filters.ts`: that allowlists what can be READ by,
 * this allowlists what can be WRITTEN.
 */

export type FieldKind =
  | 'text'
  | 'longtext'
  | 'number'
  | 'money'
  | 'date'
  | 'boolean'
  | 'select'
  | 'partner'
  | 'product'
  | 'account'
  | 'taxRate'
  | 'warehouse'
  | 'bankAccount'

export type WriteField = {
  key: string
  label: string
  kind: FieldKind
  required?: boolean
  /** Options for `select`. */
  options?: { value: string; label: string }[]
  placeholder?: string
  help?: string
  /** Spans both columns in the two-column form. */
  wide?: boolean
  default?: string | number | boolean
}

export type LineSpec = {
  label: string
  /** Minimum number of lines a document needs to be valid. */
  min: number
  fields: WriteField[]
}

export type DocumentAction = {
  key: string
  label: string
  /** Shown as the primary button in the record drawer. */
  primary?: boolean
  permission: Permission
  /** Only offered when the record is in one of these statuses. */
  whenStatus?: string[]
  /** Extra input the action needs, collected in a small dialog. */
  fields?: WriteField[]
  confirm?: string
}

export type ModuleWrites = {
  createPermission: Permission
  updatePermission: Permission
  /** Fields on the create form. */
  create: WriteField[]
  /** Line items, for documents that have them. */
  lines?: LineSpec
  /**
   * Fields editable in place, and the statuses in which editing is allowed.
   *
   * A posted document is immutable — that is enforced by database trigger, but
   * declaring it here means the UI never offers an edit that would be refused.
   */
  editable: { key: string; kind: FieldKind; whenStatus?: string[] }[]
  actions?: DocumentAction[]
}

const DIRECTION_OPTIONS = [
  { value: 'ar', label: 'Sales invoice (customer owes us)' },
  { value: 'ap', label: 'Purchase bill (we owe supplier)' },
]

export const WRITES: Partial<Record<ModuleId, ModuleWrites>> = {
  customers: {
    createPermission: 'crm.write',
    updatePermission: 'crm.write',
    create: [
      { key: 'name', label: 'Name', kind: 'text', required: true, wide: true },
      { key: 'legalName', label: 'Legal name', kind: 'text', wide: true },
      { key: 'countryCode', label: 'Country', kind: 'text', placeholder: 'DE' },
      { key: 'taxId', label: 'VAT number', kind: 'text', placeholder: 'DE123456789' },
      {
        key: 'role',
        label: 'Relationship',
        kind: 'select',
        required: true,
        default: 'customer',
        options: [
          { value: 'customer', label: 'Customer' },
          { value: 'supplier', label: 'Supplier' },
          { value: 'both', label: 'Customer & supplier' },
          { value: 'prospect', label: 'Prospect' },
        ],
      },
      { key: 'paymentTermsDays', label: 'Payment terms (days)', kind: 'number', default: 30 },
      { key: 'creditLimitMinor', label: 'Credit limit', kind: 'money' },
      { key: 'currencyCode', label: 'Currency', kind: 'text', placeholder: 'EUR' },
    ],
    editable: [
      { key: 'name', kind: 'text' },
      { key: 'countryCode', kind: 'text' },
      { key: 'taxId', kind: 'text' },
      { key: 'creditLimitMinor', kind: 'money' },
      { key: 'paymentTermsDays', kind: 'number' },
    ],
  },

  products: {
    createPermission: 'inventory.write',
    updatePermission: 'inventory.write',
    create: [
      { key: 'sku', label: 'SKU', kind: 'text', required: true },
      {
        key: 'type',
        label: 'Type',
        kind: 'select',
        required: true,
        default: 'stock',
        options: [
          { value: 'stock', label: 'Stocked item' },
          { value: 'service', label: 'Service' },
          { value: 'non_stock', label: 'Non-stocked item' },
        ],
      },
      { key: 'name', label: 'Product name', kind: 'text', required: true, wide: true },
      { key: 'description', label: 'Description', kind: 'longtext', wide: true },
      { key: 'salesPriceMinor', label: 'Sales price', kind: 'money' },
      { key: 'costMinor', label: 'Cost', kind: 'money', help: 'Used for the first receipt only; after that the weighted average takes over.' },
      { key: 'reorderPoint', label: 'Reorder point', kind: 'number' },
      { key: 'taxRateId', label: 'Default tax rate', kind: 'taxRate' },
    ],
    editable: [
      { key: 'name', kind: 'text' },
      { key: 'salesPriceMinor', kind: 'money' },
      { key: 'reorderPoint', kind: 'number' },
    ],
  },

  deals: {
    createPermission: 'crm.write',
    updatePermission: 'crm.write',
    create: [
      { key: 'name', label: 'Deal name', kind: 'text', required: true, wide: true },
      { key: 'businessPartnerId', label: 'Account', kind: 'partner' },
      { key: 'amountMinor', label: 'Value', kind: 'money', required: true },
      { key: 'expectedCloseDate', label: 'Expected close', kind: 'date' },
      { key: 'source', label: 'Source', kind: 'text', placeholder: 'Referral, trade show…' },
    ],
    editable: [
      { key: 'name', kind: 'text' },
      { key: 'amountMinor', kind: 'money' },
      { key: 'expectedCloseDate', kind: 'date' },
      { key: 'source', kind: 'text' },
    ],
    actions: [
      {
        key: 'deal.won',
        label: 'Mark won',
        primary: true,
        permission: 'crm.write',
        whenStatus: ['open'],
      },
      {
        key: 'deal.lost',
        label: 'Mark lost',
        permission: 'crm.write',
        whenStatus: ['open'],
        fields: [{ key: 'lostReason', label: 'Reason', kind: 'text', wide: true }],
      },
    ],
  },

  invoices: {
    createPermission: 'invoice.create',
    updatePermission: 'invoice.update',
    create: [
      {
        key: 'direction',
        label: 'Type',
        kind: 'select',
        required: true,
        default: 'ar',
        options: DIRECTION_OPTIONS,
        wide: true,
      },
      { key: 'businessPartnerId', label: 'Business partner', kind: 'partner', required: true, wide: true },
      { key: 'issueDate', label: 'Issue date', kind: 'date', required: true },
      { key: 'dueDate', label: 'Due date', kind: 'date', help: 'Defaults to the partner’s payment terms.' },
      { key: 'currencyCode', label: 'Currency', kind: 'text', placeholder: 'EUR' },
      { key: 'fxRate', label: 'Exchange rate', kind: 'number', help: 'Required only when the currency differs from your base currency.' },
      { key: 'notes', label: 'Notes', kind: 'longtext', wide: true },
    ],
    lines: {
      label: 'Invoice lines',
      min: 1,
      fields: [
        { key: 'description', label: 'Description', kind: 'text', required: true },
        { key: 'quantity', label: 'Qty', kind: 'number', default: 1 },
        { key: 'unitPriceMinor', label: 'Unit price', kind: 'money', required: true },
        { key: 'taxRateId', label: 'Tax', kind: 'taxRate' },
      ],
    },
    // Only a DRAFT is editable. Once issued the document is immutable — the
    // ledger trigger enforces it, and offering the edit here would just produce
    // an error the user cannot act on.
    editable: [
      { key: 'dueDate', kind: 'date', whenStatus: ['draft'] },
      { key: 'notes', kind: 'text', whenStatus: ['draft'] },
    ],
    actions: [
      {
        key: 'invoice.issue',
        label: 'Issue',
        primary: true,
        permission: 'invoice.issue',
        whenStatus: ['draft'],
        confirm: 'Issuing posts this invoice to the general ledger. It cannot be edited afterwards — corrections are made with a credit note.',
      },
      {
        key: 'invoice.pay',
        label: 'Record payment',
        permission: 'payment.record',
        whenStatus: ['issued', 'partially_paid', 'overdue'],
        fields: [
          { key: 'paymentDate', label: 'Payment date', kind: 'date', required: true },
          { key: 'bankAccountId', label: 'Bank account', kind: 'bankAccount', required: true },
          { key: 'amountMinor', label: 'Amount', kind: 'money', required: true },
          { key: 'reference', label: 'Reference', kind: 'text', wide: true },
        ],
      },
      {
        // The only way to correct an issued invoice. The document is immutable
        // and the ledger entry behind it is posted, so the correction is a new
        // document rather than an edit.
        //
        // Available on a PAID invoice too: crediting something already settled
        // is a refund owed to the customer, which is an ordinary thing to need.
        key: 'invoice.credit',
        label: 'Credit note',
        permission: 'invoice.create',
        whenStatus: ['issued', 'partially_paid', 'paid', 'overdue'],
        fields: [
          { key: 'issueDate', label: 'Credit note date', kind: 'date', required: true },
          {
            key: 'reason',
            label: 'Reason',
            kind: 'longtext',
            required: true,
            wide: true,
            help: 'Appears on the credit note and in the audit trail. An auditor will ask.',
          },
        ],
        confirm:
          'This drafts a credit note for the full value of the invoice, copying its lines. ' +
          'Nothing is posted until you issue it.',
      },
    ],
  },

  'sales-orders': {
    createPermission: 'sales.write',
    updatePermission: 'sales.write',
    create: [
      { key: 'businessPartnerId', label: 'Customer', kind: 'partner', required: true, wide: true },
      { key: 'orderDate', label: 'Order date', kind: 'date', required: true },
      { key: 'requestedDeliveryDate', label: 'Requested delivery', kind: 'date' },
      { key: 'warehouseId', label: 'Ship from', kind: 'warehouse' },
      { key: 'customerReference', label: 'Customer reference', kind: 'text' },
    ],
    lines: {
      label: 'Order lines',
      min: 1,
      fields: [
        { key: 'productId', label: 'Product', kind: 'product' },
        { key: 'description', label: 'Description', kind: 'text' },
        { key: 'quantity', label: 'Qty', kind: 'number', required: true, default: 1 },
        { key: 'unitPriceMinor', label: 'Unit price', kind: 'money' },
        { key: 'taxRateId', label: 'Tax', kind: 'taxRate' },
      ],
    },
    editable: [
      { key: 'requestedDeliveryDate', kind: 'date', whenStatus: ['draft', 'confirmed'] },
      { key: 'customerReference', kind: 'text', whenStatus: ['draft', 'confirmed'] },
    ],
    actions: [
      {
        key: 'sales_order.confirm',
        label: 'Confirm',
        primary: true,
        permission: 'sales.write',
        whenStatus: ['draft'],
      },
      {
        key: 'sales_order.deliver',
        label: 'Ship',
        primary: true,
        permission: 'inventory.write',
        whenStatus: ['confirmed', 'partially_delivered'],
        fields: [{ key: 'deliveryDate', label: 'Delivery date', kind: 'date', required: true }],
        confirm: 'Shipping posts cost of goods sold at the current weighted-average cost.',
      },
      {
        key: 'sales_order.invoice',
        label: 'Invoice',
        primary: true,
        permission: 'invoice.create',
        whenStatus: ['partially_delivered', 'delivered'],
        fields: [{ key: 'issueDate', label: 'Invoice date', kind: 'date', required: true }],
        confirm: 'Invoices everything delivered but not yet billed, and posts it to the ledger.',
      },
    ],
  },

  'purchase-orders': {
    createPermission: 'purchase.write',
    updatePermission: 'purchase.write',
    create: [
      { key: 'supplierId', label: 'Supplier', kind: 'partner', required: true, wide: true },
      { key: 'orderDate', label: 'Order date', kind: 'date', required: true },
      { key: 'expectedDate', label: 'Expected', kind: 'date' },
      { key: 'shipToWarehouseId', label: 'Deliver to', kind: 'warehouse' },
    ],
    lines: {
      label: 'Order lines',
      min: 1,
      fields: [
        { key: 'productId', label: 'Product', kind: 'product' },
        { key: 'description', label: 'Description', kind: 'text', required: true },
        { key: 'quantity', label: 'Qty', kind: 'number', required: true, default: 1 },
        { key: 'unitPriceMinor', label: 'Unit price', kind: 'money', required: true },
        { key: 'taxRateId', label: 'Tax', kind: 'taxRate' },
      ],
    },
    editable: [{ key: 'expectedDate', kind: 'date', whenStatus: ['draft', 'approved'] }],
    actions: [
      {
        key: 'purchase_order.approve',
        label: 'Approve',
        primary: true,
        permission: 'purchase.approve',
        whenStatus: ['draft', 'awaiting_approval'],
      },
      {
        key: 'purchase_order.receive',
        label: 'Receive goods',
        primary: true,
        permission: 'inventory.write',
        whenStatus: ['approved', 'partially_received'],
        fields: [{ key: 'receiptDate', label: 'Receipt date', kind: 'date', required: true }],
        confirm: 'Receiving adds stock at the order price and credits GR/IR clearing.',
      },
      {
        key: 'purchase_order.bill',
        label: 'Enter supplier invoice',
        permission: 'invoice.create',
        whenStatus: ['partially_received', 'received'],
        fields: [
          { key: 'issueDate', label: 'Invoice date', kind: 'date', required: true },
          { key: 'supplierInvoiceRef', label: 'Their invoice number', kind: 'text' },
          {
            key: 'billedNetMinor',
            label: 'Net amount billed',
            kind: 'money',
            help: 'Leave blank to accept the order price. A difference beyond tolerance is refused.',
          },
        ],
      },
    ],
  },

  banking: {
    createPermission: 'bank.manage',
    updatePermission: 'bank.manage',
    create: [],
    editable: [
      { key: 'description', kind: 'text' },
      { key: 'counterpartyName', kind: 'text' },
    ],
  },
}

export const writesFor = (module: ModuleId): ModuleWrites | undefined => WRITES[module]

/** Money arrives from the UI as a human string ("1.234,56"); everything else
 *  is coerced to the shape the services expect. */
export const fieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
