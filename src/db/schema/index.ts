/**
 * Schema barrel.
 *
 * Step 2 covers the security and multi-tenancy foundation only: tenancy,
 * identity, RBAC, licensing and audit. Finance, sales, CRM, inventory and
 * purchasing land in step 3 onward, per docs/01-database-schema.md.
 *
 * RULE: every table added here that carries `organization_id` MUST also be
 * listed in drizzle/0001_rls.sql. tests/rls-coverage.test.ts fails the build
 * otherwise — that guard is what stops a table added months from now from
 * quietly becoming a cross-tenant leak.
 */
export * from './organizations'
export * from './identity'
export * from './licensing'
export * from './audit'

// Step 3 — Finance: the system of record.
export * from './finance'
export * from './partners'
export * from './billing'

// Step 5 — Operations: order-to-cash, CRM, inventory, procure-to-pay.
export * from './inventory'
export * from './sales'
export * from './purchasing'
export * from './crm'

// Step 6 — Customization: custom fields, saved views, tags, workflow rules.
export * from './customization'

// API layer — keys, transactional outbox, webhook endpoints and deliveries.
export * from './api'

// Internal team chat — channels, messages, mentions, record links.
export * from './chat'

// AI assistant — conversations, and the retrieval audit trail behind every
// figure it states.
export * from './assistant'
