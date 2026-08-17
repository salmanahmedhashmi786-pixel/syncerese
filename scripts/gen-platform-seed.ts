import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { PERMISSIONS, ROLE_GRANTS, ROLE_KEYS } from '../src/auth/permissions'

/**
 * Emits drizzle/0003_platform_seed.sql from the TypeScript permission
 * catalogue.
 *
 * Roles and permissions are platform reference data, like `currencies`: they
 * carry no tenant column, every tenant shares them, and the application role
 * has no business inserting them — RLS correctly refuses. So they are seeded by
 * a migration running as the schema owner.
 *
 * Generated rather than hand-written so the SQL cannot drift from
 * `src/auth/permissions.ts`. `tests/platform-seed.test.ts` asserts the two
 * still agree, which is what catches "edited the TypeScript, forgot to
 * regenerate".
 *
 *   npm run gen:platform-seed
 */

const esc = (v: string) => v.replace(/'/g, "''")

const permissionRows = Object.entries(PERMISSIONS)
  .map(([key, description]) => `  ('${esc(key)}', '${esc(description)}')`)
  .join(',\n')

const roleBlocks = ROLE_KEYS.map((key) => {
  const grants = ROLE_GRANTS[key]
    .map((p) => `    ('${esc(key)}', '${esc(p)}')`)
    .join(',\n')
  return `-- ${key}\n${grants}`
}).join(',\n')

const sql = `-- ---------------------------------------------------------------------------
-- Syncrese — platform reference data: system roles and the permission
-- catalogue.
--
-- GENERATED FILE. Do not edit by hand.
-- Source: src/auth/permissions.ts · Regenerate: npm run gen:platform-seed
--
-- These rows have no organization_id: every tenant shares them, and the
-- application role cannot insert them (the RLS WITH CHECK on \`roles\` requires
-- a tenant, which system roles deliberately do not have). Seeding them here,
-- as the schema owner, is the correct place.
-- ---------------------------------------------------------------------------

INSERT INTO permissions (key, description) VALUES
${permissionRows}
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- ---------------------------------------------------------------------------
-- FORCE is lifted for the seed below, and restored immediately after.
--
-- \`roles\` carries WITH CHECK (organization_id = current_org_id()). A system
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
${ROLE_KEYS.map(
  (k) =>
    `  ('${k}', '${k.charAt(0).toUpperCase() + k.slice(1)}', '${esc(describeRole(k))}')`,
).join(',\n')}
) AS v(key, name, description)
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.key = v.key AND r.organization_id IS NULL
);

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, g.permission_key
FROM (VALUES
${roleBlocks}
) AS g(role_key, permission_key)
JOIN roles r ON r.key = g.role_key AND r.organization_id IS NULL
ON CONFLICT DO NOTHING;

ALTER TABLE roles            FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
`

function describeRole(key: string): string {
  switch (key) {
    case 'owner':
      return 'Full control, including deleting the organization.'
    case 'admin':
      return 'Runs the business day to day; cannot delete the organization.'
    case 'finance':
      return 'Posts to the ledger, issues invoices, records payments.'
    case 'sales':
      return 'Manages accounts, deals and sales documents.'
    case 'readonly':
      return 'Can view, cannot change anything.'
    default:
      return ''
  }
}

const out = path.resolve(process.cwd(), 'drizzle', '0003_platform_seed.sql')
writeFileSync(out, sql, 'utf8')
console.log(`wrote ${out}`)
console.log(
  `  ${Object.keys(PERMISSIONS).length} permissions, ${ROLE_KEYS.length} roles, ` +
    `${ROLE_KEYS.reduce((n, k) => n + ROLE_GRANTS[k].length, 0)} grants`,
)
