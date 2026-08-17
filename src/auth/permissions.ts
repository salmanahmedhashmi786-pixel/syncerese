/**
 * Permission catalogue and the built-in role grants (MUST DO #2).
 *
 * Permissions are checked SERVER-SIDE on every mutation. Hiding a button is a
 * UX affordance, never a security control — the API must refuse the call even
 * when it arrives from a modified desktop client or straight from curl.
 */
export const PERMISSIONS = {
  // organization & members
  'org.read': 'View organization settings',
  'org.update': 'Change organization settings and branding',
  'org.delete': 'Delete the organization and all its data',
  'member.read': 'View members and seat usage',
  'member.invite': 'Invite a new user (consumes a licensed seat)',
  'member.update': 'Change a member’s role',
  'member.deactivate': 'Deactivate a member and free their seat',

  // licensing
  'license.read': 'View licence and seat usage',
  'license.manage': 'Activate, renew or change the product key',

  // finance
  'ledger.read': 'View the general ledger and financial reports',
  'ledger.post': 'Post journal entries',
  'account.manage': 'Create and edit the chart of accounts',
  'invoice.read': 'View invoices',
  'invoice.create': 'Create invoices',
  'invoice.update': 'Edit draft invoices',
  'invoice.issue': 'Issue an invoice (posts to the ledger)',
  'payment.record': 'Record and allocate payments',
  'bank.manage': 'Manage bank accounts and import statements',

  // commercial
  'sales.read': 'View quotes and sales orders',
  'sales.write': 'Create and edit quotes and sales orders',
  'purchase.read': 'View requisitions and purchase orders',
  'purchase.write': 'Create requisitions and purchase orders',
  'purchase.approve': 'Approve requisitions and purchase orders',
  'crm.read': 'View accounts, contacts and deals',
  'crm.write': 'Create and edit accounts, contacts and deals',
  'inventory.read': 'View products and stock',
  'inventory.write': 'Adjust stock, receive and transfer goods',

  // platform
  'audit.read': 'View the audit trail',
  'gdpr.manage': 'Run data exports and erasure requests',
  'apikey.manage': 'Create and revoke API keys',
  'webhook.manage': 'Configure webhooks',
  'integration.manage': 'Connect Slack and Microsoft Teams',
  'workflow.manage': 'Create and edit automation rules',
  'customfield.manage': 'Define custom fields',
} as const

export type Permission = keyof typeof PERMISSIONS

export const ROLE_KEYS = ['owner', 'admin', 'finance', 'sales', 'readonly'] as const
export type RoleKey = (typeof ROLE_KEYS)[number]

const ALL = Object.keys(PERMISSIONS) as Permission[]

const READ_ONLY: Permission[] = [
  'org.read',
  'member.read',
  'license.read',
  'ledger.read',
  'invoice.read',
  'sales.read',
  'purchase.read',
  'crm.read',
  'inventory.read',
]

/**
 * Built-in role grants.
 *
 * Only Owner and Admin can invite members — MUST DO #16 requires that user
 * provisioning is admin-gated, because every new user consumes a paid seat.
 * Note that `org.delete` is Owner-only: an Admin can run the business but
 * cannot destroy it.
 */
export const ROLE_GRANTS: Record<RoleKey, Permission[]> = {
  owner: ALL,

  admin: ALL.filter((p) => p !== 'org.delete'),

  finance: [
    ...READ_ONLY,
    'ledger.post',
    'account.manage',
    'invoice.create',
    'invoice.update',
    'invoice.issue',
    'payment.record',
    'bank.manage',
    'purchase.approve',
    'audit.read',
  ],

  sales: [
    ...READ_ONLY,
    'sales.write',
    'crm.write',
    'invoice.create',
    'invoice.update',
    'purchase.write',
  ],

  readonly: READ_ONLY,
}

export function grantsFor(role: RoleKey): ReadonlySet<Permission> {
  return new Set(ROLE_GRANTS[role])
}
