/**
 * Module registry.
 *
 * One config drives the sidebar, the table screen, the detail drawer and the
 * create modal — exactly the pattern the design prototype uses, where seven
 * modules share a single table screen driven by per-module column definitions.
 * Adding a module is a registry entry plus a query, not a new screen.
 *
 * The module set is the Syncrèse one, not the prototype's manufacturer nav:
 * no Manufacturing, no HR/payroll. Sales orders, Inventory and Purchase orders
 * join in step 5 when their tables exist — they are deliberately absent rather
 * than present-but-dead.
 */

export type ColumnDef = {
  key: string
  label: string
  /** Column width in px. Columns wider than 180 span both cells in the create
   *  form, per the handoff. */
  width: number
  align?: 'left' | 'right'
  /** Render in IBM Plex Mono at 0.94em — ids, numbers, dates. */
  mono?: boolean
  /** Money: mono, right-aligned, formatted with the record's currency. */
  money?: boolean
  /** Status badge, colour-coded. Also drives the filter chips. */
  badge?: boolean
  /** Inline double-click-to-edit. Carries a dashed right hairline as the
   *  affordance. */
  editable?: boolean
  /** Excluded from the create form (system-generated). */
  readOnly?: boolean
}

export type ModuleId =
  | 'dashboard'
  | 'reports'
  | 'invoices'
  | 'banking'
  | 'journal'
  | 'customers'
  | 'analytics'
  | 'sales-orders'
  | 'deals'
  | 'products'
  | 'purchase-orders'
  | 'chat'
  | 'settings'

export type ModuleDef = {
  id: ModuleId
  /** Two-letter chip in the sidebar. */
  code: string
  label: string
  group: string
  /** Header title and mono subtitle. */
  title: string
  subtitle: string
  /** Singular noun for the drawer kicker, modal title and toasts. */
  noun: string
  kind: 'dashboard' | 'reports' | 'table' | 'settings' | 'analytics' | 'chat'
  columns: ColumnDef[]
  /** Permission required to see the module at all. */
  permission: string
  /** Which status values the filter chips offer, in display order. */
  statuses?: string[]
}

export const MODULES: ModuleDef[] = [
  {
    id: 'dashboard',
    code: 'DB',
    label: 'Executive dashboard',
    group: 'OVERVIEW',
    title: 'Executive dashboard',
    subtitle: '',
    noun: 'Widget',
    kind: 'dashboard',
    columns: [],
    permission: 'ledger.read',
  },
  {
    id: 'reports',
    code: 'RP',
    label: 'Reports & analytics',
    group: 'OVERVIEW',
    title: 'Reports & analytics',
    subtitle: 'BI · financial statements',
    noun: 'Report',
    kind: 'reports',
    columns: [],
    permission: 'ledger.read',
  },
  {
    id: 'analytics',
    code: 'AN',
    label: 'Business analytics',
    group: 'OVERVIEW',
    title: 'Business analytics',
    subtitle: 'demographics · segments · lifetime value',
    noun: 'Segment',
    kind: 'analytics',
    columns: [],
    permission: 'crm.read',
  },
  {
    id: 'invoices',
    code: 'FI',
    label: 'Invoices & bills',
    group: 'FINANCE',
    title: 'Invoices & bills',
    subtitle: 'AR · AP · VAT-compliant',
    noun: 'Invoice',
    kind: 'table',
    permission: 'invoice.read',
    statuses: ['draft', 'issued', 'partially_paid', 'paid', 'cancelled', 'credited'],
    columns: [
      { key: 'invoiceNo', label: 'Document', width: 118, mono: true, readOnly: true },
      { key: 'partnerName', label: 'Business partner', width: 214 },
      { key: 'direction', label: 'Type', width: 90 },
      { key: 'status', label: 'Status', width: 124, badge: true },
      { key: 'subtotalMinor', label: 'Net', width: 118, align: 'right', money: true },
      { key: 'taxTotalMinor', label: 'VAT', width: 100, align: 'right', money: true },
      { key: 'totalMinor', label: 'Total', width: 124, align: 'right', money: true },
      { key: 'outstandingMinor', label: 'Outstanding', width: 124, align: 'right', money: true },
      { key: 'issueDate', label: 'Issued', width: 110, mono: true },
      { key: 'dueDate', label: 'Due date', width: 110, mono: true },
      { key: 'aging', label: 'Aging', width: 90, mono: true, align: 'right', readOnly: true },
    ],
  },
  {
    id: 'journal',
    code: 'GL',
    label: 'General ledger',
    group: 'FINANCE',
    title: 'General ledger',
    subtitle: 'double-entry · posted journals',
    noun: 'Journal entry',
    kind: 'table',
    permission: 'ledger.read',
    statuses: ['draft', 'posted', 'reversed'],
    columns: [
      { key: 'entryNo', label: 'Entry', width: 90, mono: true, align: 'right', readOnly: true },
      { key: 'entryDate', label: 'Date', width: 110, mono: true },
      { key: 'description', label: 'Description', width: 260 },
      { key: 'sourceType', label: 'Source', width: 120 },
      { key: 'status', label: 'Status', width: 110, badge: true },
      { key: 'lineCount', label: 'Lines', width: 74, align: 'right', mono: true, readOnly: true },
      { key: 'totalMinor', label: 'Amount', width: 130, align: 'right', money: true, readOnly: true },
    ],
  },
  {
    id: 'banking',
    code: 'BK',
    label: 'Bank transactions',
    group: 'FINANCE',
    title: 'Bank transactions',
    subtitle: 'statements · reconciliation',
    noun: 'Bank transaction',
    kind: 'table',
    permission: 'bank.manage',
    statuses: ['unreconciled', 'matched', 'reconciled', 'ignored'],
    columns: [
      { key: 'valueDate', label: 'Value date', width: 112, mono: true },
      { key: 'description', label: 'Description', width: 260 },
      { key: 'counterpartyName', label: 'Counterparty', width: 200 },
      { key: 'reconciliationStatus', label: 'Status', width: 130, badge: true },
      { key: 'amountMinor', label: 'Amount', width: 130, align: 'right', money: true },
      { key: 'bankAccountName', label: 'Account', width: 170, readOnly: true },
      { key: 'counterpartyIban', label: 'IBAN', width: 190, mono: true },
    ],
  },
  {
    id: 'customers',
    code: 'CU',
    label: 'Customers & suppliers',
    group: 'COMMERCIAL',
    title: 'Customers & suppliers',
    subtitle: 'accounts · credit exposure',
    noun: 'Business partner',
    kind: 'table',
    permission: 'crm.read',
    statuses: ['customer', 'supplier', 'prospect'],
    columns: [
      { key: 'partnerNo', label: 'Account', width: 110, mono: true, readOnly: true },
      { key: 'name', label: 'Name', width: 230 },
      { key: 'countryCode', label: 'Country', width: 88 },
      { key: 'role', label: 'Role', width: 118, badge: true, readOnly: true },
      { key: 'taxId', label: 'VAT number', width: 150, mono: true },
      { key: 'revenueMinor', label: 'Revenue YTD', width: 140, align: 'right', money: true, readOnly: true },
      { key: 'outstandingMinor', label: 'Outstanding', width: 130, align: 'right', money: true, readOnly: true },
      { key: 'creditLimitMinor', label: 'Credit limit', width: 130, align: 'right', money: true, editable: true },
      { key: 'paymentTermsDays', label: 'Terms', width: 92, mono: true, align: 'right', editable: true },
    ],
  },
  {
    id: 'sales-orders',
    code: 'SO',
    label: 'Sales orders',
    group: 'COMMERCIAL',
    title: 'Sales orders',
    subtitle: 'order-to-cash · quote → ship → invoice',
    noun: 'Sales order',
    kind: 'table',
    permission: 'sales.read',
    statuses: ['draft', 'confirmed', 'partially_delivered', 'delivered', 'invoiced', 'cancelled'],
    columns: [
      { key: 'orderNo', label: 'Order', width: 110, mono: true, readOnly: true },
      { key: 'partnerName', label: 'Customer', width: 220 },
      { key: 'status', label: 'Status', width: 140, badge: true },
      { key: 'lineCount', label: 'Lines', width: 74, align: 'right', mono: true, readOnly: true },
      { key: 'subtotalMinor', label: 'Net', width: 120, align: 'right', money: true },
      { key: 'totalMinor', label: 'Total', width: 126, align: 'right', money: true },
      { key: 'fulfilment', label: 'Shipped', width: 100, align: 'right', mono: true, readOnly: true },
      { key: 'orderDate', label: 'Ordered', width: 110, mono: true },
      { key: 'requestedDeliveryDate', label: 'Requested', width: 112, mono: true },
      { key: 'ownerName', label: 'Owner', width: 140, readOnly: true },
    ],
  },
  {
    id: 'deals',
    code: 'DL',
    label: 'Deals',
    group: 'COMMERCIAL',
    title: 'Deals',
    subtitle: 'CRM · pipeline',
    noun: 'Deal',
    kind: 'table',
    permission: 'crm.read',
    statuses: ['open', 'won', 'lost'],
    columns: [
      { key: 'dealNo', label: 'Deal', width: 100, mono: true, readOnly: true },
      { key: 'name', label: 'Name', width: 230 },
      { key: 'partnerName', label: 'Account', width: 200, readOnly: true },
      { key: 'stageName', label: 'Stage', width: 140, readOnly: true },
      { key: 'status', label: 'Status', width: 100, badge: true },
      { key: 'amountMinor', label: 'Value', width: 130, align: 'right', money: true },
      { key: 'probabilityPct', label: 'Prob.', width: 80, align: 'right', mono: true, readOnly: true },
      { key: 'weightedMinor', label: 'Weighted', width: 130, align: 'right', money: true, readOnly: true },
      { key: 'expectedCloseDate', label: 'Expected close', width: 130, mono: true },
      { key: 'source', label: 'Source', width: 130 },
    ],
  },
  {
    id: 'products',
    code: 'IN',
    label: 'Products & stock',
    group: 'OPERATIONS',
    title: 'Products & stock',
    subtitle: 'catalogue · live valuation',
    noun: 'Product',
    kind: 'table',
    permission: 'inventory.read',
    statuses: ['stock', 'service', 'non_stock'],
    columns: [
      { key: 'sku', label: 'SKU', width: 130, mono: true },
      { key: 'name', label: 'Product', width: 240 },
      { key: 'type', label: 'Type', width: 110, badge: true },
      { key: 'signal', label: 'Signal', width: 110, readOnly: true },
      { key: 'qtyOnHand', label: 'On hand', width: 96, align: 'right', mono: true, readOnly: true },
      { key: 'reorderPoint', label: 'Reorder pt', width: 104, align: 'right', mono: true, editable: true },
      { key: 'avgCostMinor', label: 'Avg cost', width: 118, align: 'right', money: true, readOnly: true },
      { key: 'stockValueMinor', label: 'Stock value', width: 130, align: 'right', money: true, readOnly: true },
      { key: 'salesPriceMinor', label: 'Sales price', width: 122, align: 'right', money: true, editable: true },
    ],
  },
  {
    id: 'purchase-orders',
    code: 'PO',
    label: 'Purchase orders',
    group: 'OPERATIONS',
    title: 'Purchase orders',
    subtitle: 'procure-to-pay · three-way match',
    noun: 'Purchase order',
    kind: 'table',
    permission: 'purchase.read',
    statuses: [
      'draft',
      'awaiting_approval',
      'approved',
      'partially_received',
      'received',
      'closed',
      'cancelled',
    ],
    columns: [
      { key: 'poNo', label: 'PO', width: 110, mono: true, readOnly: true },
      { key: 'supplierName', label: 'Supplier', width: 220 },
      { key: 'status', label: 'Status', width: 150, badge: true },
      { key: 'lineCount', label: 'Lines', width: 74, align: 'right', mono: true, readOnly: true },
      { key: 'subtotalMinor', label: 'Net', width: 120, align: 'right', money: true },
      { key: 'totalMinor', label: 'Total', width: 126, align: 'right', money: true },
      { key: 'fulfilment', label: 'Received', width: 100, align: 'right', mono: true, readOnly: true },
      { key: 'orderDate', label: 'Ordered', width: 110, mono: true },
      { key: 'expectedDate', label: 'Expected', width: 110, mono: true },
      { key: 'buyerName', label: 'Buyer', width: 140, readOnly: true },
    ],
  },
  {
    id: 'chat',
    code: 'CH',
    label: 'Team chat',
    group: 'SYSTEM',
    title: 'Team chat',
    subtitle: 'channels · direct messages · record links',
    noun: 'Message',
    kind: 'chat',
    columns: [],
    // Everyone in the organization can talk to their colleagues; the
    // authorization that matters is channel membership.
    permission: 'org.read',
  },
  {
    id: 'settings',
    code: 'ST',
    label: 'Settings',
    group: 'SYSTEM',
    title: 'Settings',
    subtitle: 'Workspace configuration',
    noun: 'Setting',
    kind: 'settings',
    columns: [],
    permission: 'org.read',
  },
]

export const NAV_GROUPS = ['OVERVIEW', 'FINANCE', 'COMMERCIAL', 'OPERATIONS', 'SYSTEM'] as const

export const moduleById = (id: string): ModuleDef | undefined =>
  MODULES.find((m) => m.id === id)

/**
 * Status badge colours from the handoff, keyed by the value the API returns.
 * Badges always carry text as well as colour — the spec flags teal-vs-blue as
 * the colour-blindness risk, so colour alone never signals state.
 */
export const STATUS_COLOR: Record<string, string> = {
  // invoices
  draft: '#64748b',
  issued: '#2563eb',
  partially_paid: '#b45309',
  paid: '#0d9488',
  cancelled: '#64748b',
  credited: '#7c3aed',
  overdue: '#dc2626',
  // journal
  posted: '#0891b2',
  reversed: '#7c3aed',
  // banking
  unreconciled: '#b45309',
  matched: '#2563eb',
  reconciled: '#0d9488',
  ignored: '#64748b',
  // partners
  customer: '#0d9488',
  supplier: '#2563eb',
  prospect: '#b45309',
  both: '#7c3aed',
  // sales orders
  confirmed: '#0d9488',
  partially_delivered: '#b45309',
  delivered: '#0891b2',
  invoiced: '#0d9488',
  // purchase orders
  awaiting_approval: '#b45309',
  approved: '#0d9488',
  partially_received: '#b45309',
  received: '#0891b2',
  closed: '#64748b',
  // deals
  open: '#2563eb',
  won: '#0d9488',
  lost: '#dc2626',
  // products
  stock: '#2563eb',
  service: '#7c3aed',
  non_stock: '#64748b',
}

export const STATUS_LABEL: Record<string, string> = {
  partially_paid: 'Partly paid',
  unreconciled: 'Unreconciled',
}

export const statusLabel = (v: string): string =>
  STATUS_LABEL[v] ?? v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ')
