/**
 * Default SME chart of accounts.
 *
 * Fully customisable per tenant — but the SUBTYPES are what the posting engine
 * resolves against, never the codes. A tenant can renumber 1200 to 11500 and
 * every automatic posting keeps working, because the engine asks for
 * `accounts_receivable`, not for "1200".
 *
 * Numbering follows the common Anglo-American SME block layout:
 *   1000–1999 assets · 2000–2999 liabilities · 3000–3999 equity
 *   4000–4999 income · 5000–5999 cost of sales · 6000–6999 expenses
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

/**
 * Subtypes the posting engine depends on. Marked `system` accounts cannot be
 * deleted while documents reference them — losing the AR control account
 * mid-year would orphan every receivable.
 */
export type AccountSubtype =
  | 'bank'
  | 'cash'
  | 'accounts_receivable'
  | 'inventory'
  | 'prepaid'
  | 'vat_receivable'
  | 'fixed_asset'
  | 'accumulated_depreciation'
  | 'other_current_asset'
  | 'accounts_payable'
  | 'vat_payable'
  | 'gr_ir_clearing'
  | 'accrual'
  | 'loan'
  | 'other_current_liability'
  | 'share_capital'
  | 'retained_earnings'
  | 'current_year_earnings'
  | 'revenue'
  | 'other_income'
  | 'cogs'
  | 'purchase_price_variance'
  | 'operating_expense'
  | 'payroll_expense'
  | 'depreciation'
  | 'fx_gain_loss'

export type AccountTemplate = {
  code: string
  name: string
  type: AccountType
  subtype?: AccountSubtype
  isPostable?: boolean
  isSystem?: boolean
  parentCode?: string
  description?: string
}

export const DEFAULT_CHART: AccountTemplate[] = [
  // ---- Assets -----------------------------------------------------------
  { code: '1000', name: 'Assets', type: 'asset', isPostable: false },
  { code: '1010', name: 'Bank', type: 'asset', subtype: 'bank', parentCode: '1000', isSystem: true },
  { code: '1020', name: 'Cash on hand', type: 'asset', subtype: 'cash', parentCode: '1000' },
  {
    code: '1200',
    name: 'Accounts receivable',
    type: 'asset',
    subtype: 'accounts_receivable',
    parentCode: '1000',
    isSystem: true,
    description: 'Control account. Every AR invoice debits this on issue.',
  },
  { code: '1300', name: 'Inventory', type: 'asset', subtype: 'inventory', parentCode: '1000', isSystem: true },
  { code: '1400', name: 'Prepaid expenses', type: 'asset', subtype: 'prepaid', parentCode: '1000' },
  {
    code: '1500',
    name: 'VAT receivable (input tax)',
    type: 'asset',
    subtype: 'vat_receivable',
    parentCode: '1000',
    isSystem: true,
    description: 'Recoverable input tax on purchases.',
  },
  { code: '1700', name: 'Fixed assets', type: 'asset', subtype: 'fixed_asset', parentCode: '1000' },
  {
    code: '1790',
    name: 'Accumulated depreciation',
    type: 'asset',
    subtype: 'accumulated_depreciation',
    parentCode: '1000',
    description: 'Contra-asset: carries a credit balance.',
  },

  // ---- Liabilities ------------------------------------------------------
  { code: '2000', name: 'Liabilities', type: 'liability', isPostable: false },
  {
    code: '2100',
    name: 'Accounts payable',
    type: 'liability',
    subtype: 'accounts_payable',
    parentCode: '2000',
    isSystem: true,
    description: 'Control account. Every AP invoice credits this on issue.',
  },
  {
    code: '2150',
    name: 'Goods received / invoice received',
    type: 'liability',
    subtype: 'gr_ir_clearing',
    parentCode: '2000',
    isSystem: true,
    description:
      'GR/IR clearing. A goods receipt credits it; the vendor invoice debits it. ' +
      'The balance is "received but not yet invoiced" — a figure auditors ask for ' +
      'and one you cannot produce if receipts post straight to AP.',
  },
  {
    code: '2200',
    name: 'VAT payable (output tax)',
    type: 'liability',
    subtype: 'vat_payable',
    parentCode: '2000',
    isSystem: true,
    description: 'Output tax charged on sales, owed to the tax authority.',
  },
  { code: '2300', name: 'Accrued liabilities', type: 'liability', subtype: 'accrual', parentCode: '2000' },
  { code: '2600', name: 'Loans payable', type: 'liability', subtype: 'loan', parentCode: '2000' },

  // ---- Equity -----------------------------------------------------------
  { code: '3000', name: 'Equity', type: 'equity', isPostable: false },
  { code: '3100', name: 'Share capital', type: 'equity', subtype: 'share_capital', parentCode: '3000' },
  {
    code: '3200',
    name: 'Retained earnings',
    type: 'equity',
    subtype: 'retained_earnings',
    parentCode: '3000',
    isSystem: true,
    description: 'Accumulated prior-year results. Year-end close posts here.',
  },

  // ---- Income -----------------------------------------------------------
  { code: '4000', name: 'Income', type: 'income', isPostable: false },
  {
    code: '4100',
    name: 'Sales revenue',
    type: 'income',
    subtype: 'revenue',
    parentCode: '4000',
    isSystem: true,
    description: 'Default revenue account for AR invoice lines.',
  },
  { code: '4200', name: 'Service revenue', type: 'income', subtype: 'revenue', parentCode: '4000' },
  { code: '4900', name: 'Other income', type: 'income', subtype: 'other_income', parentCode: '4000' },

  // ---- Cost of sales ----------------------------------------------------
  { code: '5000', name: 'Cost of sales', type: 'expense', isPostable: false },
  {
    code: '5100',
    name: 'Cost of goods sold',
    type: 'expense',
    subtype: 'cogs',
    parentCode: '5000',
    isSystem: true,
    description: 'Posted at delivery, not at invoice — see the delivery document.',
  },
  {
    code: '5200',
    name: 'Purchase price variance',
    type: 'expense',
    subtype: 'purchase_price_variance',
    parentCode: '5000',
    isSystem: true,
    description: 'Three-way match differences within tolerance land here.',
  },

  // ---- Operating expenses ----------------------------------------------
  { code: '6000', name: 'Operating expenses', type: 'expense', isPostable: false },
  {
    code: '6100',
    name: 'General expenses',
    type: 'expense',
    subtype: 'operating_expense',
    parentCode: '6000',
    isSystem: true,
    description: 'Default expense account for AP invoice lines.',
  },
  { code: '6200', name: 'Salaries and wages', type: 'expense', subtype: 'payroll_expense', parentCode: '6000' },
  { code: '6300', name: 'Rent and utilities', type: 'expense', subtype: 'operating_expense', parentCode: '6000' },
  { code: '6400', name: 'Professional fees', type: 'expense', subtype: 'operating_expense', parentCode: '6000' },
  { code: '6500', name: 'Depreciation', type: 'expense', subtype: 'depreciation', parentCode: '6000' },
  {
    code: '6900',
    name: 'Foreign exchange gain / loss',
    type: 'expense',
    subtype: 'fx_gain_loss',
    parentCode: '6000',
    isSystem: true,
    description:
      'Realised FX difference when a foreign-currency invoice settles at a ' +
      'rate other than the one it was booked at.',
  },
]

/** Whether a normal balance on this type is a debit. Assets and expenses
 *  increase by debit; liabilities, equity and income increase by credit. */
export const isDebitNormal = (type: AccountType): boolean =>
  type === 'asset' || type === 'expense'

/** Signed balance in the direction natural for the account type, so a report
 *  never shows revenue as a negative number. */
export function naturalBalance(
  type: AccountType,
  debitMinor: number,
  creditMinor: number,
): number {
  return isDebitNormal(type) ? debitMinor - creditMinor : creditMinor - debitMinor
}
