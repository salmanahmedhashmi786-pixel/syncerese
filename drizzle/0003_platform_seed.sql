-- ---------------------------------------------------------------------------
-- Syncrese — platform reference data: system roles and the permission
-- catalogue.
--
-- GENERATED FILE. Do not edit by hand.
-- Source: src/auth/permissions.ts · Regenerate: npm run gen:platform-seed
--
-- These rows have no organization_id: every tenant shares them, and the
-- application role cannot insert them (the RLS WITH CHECK on `roles` requires
-- a tenant, which system roles deliberately do not have). Seeding them here,
-- as the schema owner, is the correct place.
-- ---------------------------------------------------------------------------

INSERT INTO permissions (key, description) VALUES
  ('org.read', 'View organization settings'),
  ('org.update', 'Change organization settings and branding'),
  ('org.delete', 'Delete the organization and all its data'),
  ('member.read', 'View members and seat usage'),
  ('member.invite', 'Invite a new user (consumes a licensed seat)'),
  ('member.update', 'Change a member’s role'),
  ('member.deactivate', 'Deactivate a member and free their seat'),
  ('license.read', 'View licence and seat usage'),
  ('license.manage', 'Activate, renew or change the product key'),
  ('ledger.read', 'View the general ledger and financial reports'),
  ('ledger.post', 'Post journal entries'),
  ('account.manage', 'Create and edit the chart of accounts'),
  ('invoice.read', 'View invoices'),
  ('invoice.create', 'Create invoices'),
  ('invoice.update', 'Edit draft invoices'),
  ('invoice.issue', 'Issue an invoice (posts to the ledger)'),
  ('payment.record', 'Record and allocate payments'),
  ('bank.manage', 'Manage bank accounts and import statements'),
  ('sales.read', 'View quotes and sales orders'),
  ('sales.write', 'Create and edit quotes and sales orders'),
  ('purchase.read', 'View requisitions and purchase orders'),
  ('purchase.write', 'Create requisitions and purchase orders'),
  ('purchase.approve', 'Approve requisitions and purchase orders'),
  ('crm.read', 'View accounts, contacts and deals'),
  ('crm.write', 'Create and edit accounts, contacts and deals'),
  ('inventory.read', 'View products and stock'),
  ('inventory.write', 'Adjust stock, receive and transfer goods'),
  ('audit.read', 'View the audit trail'),
  ('gdpr.manage', 'Run data exports and erasure requests'),
  ('apikey.manage', 'Create and revoke API keys'),
  ('webhook.manage', 'Configure webhooks'),
  ('integration.manage', 'Connect Slack and Microsoft Teams'),
  ('workflow.manage', 'Create and edit automation rules'),
  ('customfield.manage', 'Define custom fields')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- ---------------------------------------------------------------------------
-- FORCE is lifted for the seed below, and restored immediately after.
--
-- `roles` carries WITH CHECK (organization_id = current_org_id()). A system
-- role has organization_id NULL, so that check evaluates to NULL, which a
-- policy treats as false — and FORCE means the table OWNER is subject to it
-- too. In development this went unnoticed for a long time because the embedded
-- database connects as a superuser, and superusers bypass RLS unconditionally.
-- Against a real Postgres, where the owner is deliberately NOT a superuser,
-- this file failed and the deployment could not proceed past it.
--
-- Loosening the policy to permit NULL would be the wrong fix: the application
-- role would then be able to mint system roles visible to every tenant.
--
-- Each migration runs in one transaction, so a failure between these two
-- statements rolls the lift back with everything else. tests/migrate-as-owner
-- asserts FORCE is on everywhere once the migrations finish.
-- ---------------------------------------------------------------------------

ALTER TABLE roles            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions NO FORCE ROW LEVEL SECURITY;

-- System roles. gen_random_uuid() is acceptable here (unlike business rows,
-- which use application-side UUIDv7) because these are seeded once, in one
-- transaction, and are never sorted by id.
INSERT INTO roles (id, organization_id, key, name, description, is_system)
SELECT gen_random_uuid(), NULL, v.key, v.name, v.description, true
FROM (VALUES
  ('owner', 'Owner', 'Full control, including deleting the organization.'),
  ('admin', 'Admin', 'Runs the business day to day; cannot delete the organization.'),
  ('finance', 'Finance', 'Posts to the ledger, issues invoices, records payments.'),
  ('sales', 'Sales', 'Manages accounts, deals and sales documents.'),
  ('readonly', 'Readonly', 'Can view, cannot change anything.')
) AS v(key, name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.key = v.key AND r.organization_id IS NULL
);

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.permission_key
FROM (VALUES
-- owner
    ('owner', 'org.read'),
    ('owner', 'org.update'),
    ('owner', 'org.delete'),
    ('owner', 'member.read'),
    ('owner', 'member.invite'),
    ('owner', 'member.update'),
    ('owner', 'member.deactivate'),
    ('owner', 'license.read'),
    ('owner', 'license.manage'),
    ('owner', 'ledger.read'),
    ('owner', 'ledger.post'),
    ('owner', 'account.manage'),
    ('owner', 'invoice.read'),
    ('owner', 'invoice.create'),
    ('owner', 'invoice.update'),
    ('owner', 'invoice.issue'),
    ('owner', 'payment.record'),
    ('owner', 'bank.manage'),
    ('owner', 'sales.read'),
    ('owner', 'sales.write'),
    ('owner', 'purchase.read'),
    ('owner', 'purchase.write'),
    ('owner', 'purchase.approve'),
    ('owner', 'crm.read'),
    ('owner', 'crm.write'),
    ('owner', 'inventory.read'),
    ('owner', 'inventory.write'),
    ('owner', 'audit.read'),
    ('owner', 'gdpr.manage'),
    ('owner', 'apikey.manage'),
    ('owner', 'webhook.manage'),
    ('owner', 'integration.manage'),
    ('owner', 'workflow.manage'),
    ('owner', 'customfield.manage'),
-- admin
    ('admin', 'org.read'),
    ('admin', 'org.update'),
    ('admin', 'member.read'),
    ('admin', 'member.invite'),
    ('admin', 'member.update'),
    ('admin', 'member.deactivate'),
    ('admin', 'license.read'),
    ('admin', 'license.manage'),
    ('admin', 'ledger.read'),
    ('admin', 'ledger.post'),
    ('admin', 'account.manage'),
    ('admin', 'invoice.read'),
    ('admin', 'invoice.create'),
    ('admin', 'invoice.update'),
    ('admin', 'invoice.issue'),
    ('admin', 'payment.record'),
    ('admin', 'bank.manage'),
    ('admin', 'sales.read'),
    ('admin', 'sales.write'),
    ('admin', 'purchase.read'),
    ('admin', 'purchase.write'),
    ('admin', 'purchase.approve'),
    ('admin', 'crm.read'),
    ('admin', 'crm.write'),
    ('admin', 'inventory.read'),
    ('admin', 'inventory.write'),
    ('admin', 'audit.read'),
    ('admin', 'gdpr.manage'),
    ('admin', 'apikey.manage'),
    ('admin', 'webhook.manage'),
    ('admin', 'integration.manage'),
    ('admin', 'workflow.manage'),
    ('admin', 'customfield.manage'),
-- finance
    ('finance', 'org.read'),
    ('finance', 'member.read'),
    ('finance', 'license.read'),
    ('finance', 'ledger.read'),
    ('finance', 'invoice.read'),
    ('finance', 'sales.read'),
    ('finance', 'purchase.read'),
    ('finance', 'crm.read'),
    ('finance', 'inventory.read'),
    ('finance', 'ledger.post'),
    ('finance', 'account.manage'),
    ('finance', 'invoice.create'),
    ('finance', 'invoice.update'),
    ('finance', 'invoice.issue'),
    ('finance', 'payment.record'),
    ('finance', 'bank.manage'),
    ('finance', 'purchase.approve'),
    ('finance', 'audit.read'),
-- sales
    ('sales', 'org.read'),
    ('sales', 'member.read'),
    ('sales', 'license.read'),
    ('sales', 'ledger.read'),
    ('sales', 'invoice.read'),
    ('sales', 'sales.read'),
    ('sales', 'purchase.read'),
    ('sales', 'crm.read'),
    ('sales', 'inventory.read'),
    ('sales', 'sales.write'),
    ('sales', 'crm.write'),
    ('sales', 'invoice.create'),
    ('sales', 'invoice.update'),
    ('sales', 'purchase.write'),
-- readonly
    ('readonly', 'org.read'),
    ('readonly', 'member.read'),
    ('readonly', 'license.read'),
    ('readonly', 'ledger.read'),
    ('readonly', 'invoice.read'),
    ('readonly', 'sales.read'),
    ('readonly', 'purchase.read'),
    ('readonly', 'crm.read'),
    ('readonly', 'inventory.read')
) AS g(role_key, permission_key)
JOIN roles r ON r.key = g.role_key AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

ALTER TABLE roles            FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
