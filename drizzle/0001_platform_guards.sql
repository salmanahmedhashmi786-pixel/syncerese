-- ---------------------------------------------------------------------------
-- Syncrese — tenant isolation, immutability and seat enforcement.
--
-- This file is the security foundation. Everything here is enforced by the
-- DATABASE, not by application code, because a trigger or a policy cannot be
-- forgotten by a new code path, skipped by a bulk import, bypassed by a direct
-- API call, or defeated by a tampered desktop client.
--
-- Run as the schema OWNER. The application role must never be able to execute
-- this file's statements.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Roles
-- ===========================================================================
-- The application connects as syncrese_app: NOT the table owner, and crucially
-- NOT a superuser and without BYPASSRLS. A superuser connection silently
-- defeats every policy below and nothing else in the stack would notice.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_app') THEN
    CREATE ROLE syncrese_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO syncrese_app;

-- ===========================================================================
-- 2. Tenant resolution
-- ===========================================================================
-- Reads the transaction-local setting published by withTenant().
--
-- nullif() matters: an unset or blank setting must yield NULL, not raise on the
-- cast. NULL then makes every `organization_id = current_org_id()` comparison
-- NULL, which the policy treats as false — so a query that forgot to establish
-- tenant scope returns ZERO rows rather than erroring out or, far worse,
-- returning everything.

CREATE OR REPLACE FUNCTION public.current_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = public
AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION public.current_actor_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = public
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION public.current_org_id() TO syncrese_app;
GRANT EXECUTE ON FUNCTION public.current_actor_id() TO syncrese_app;

-- ===========================================================================
-- 3. Row level security
-- ===========================================================================
-- Driven from an explicit list so adding a table is a deliberate act. The CI
-- guard in tests/rls-coverage.test.ts independently walks pg_class and fails
-- the build if a table carrying organization_id is missing from this list —
-- belt and braces, because this list is exactly the kind of thing that gets
-- forgotten in month six.
--
-- FORCE matters as much as ENABLE: without it the table OWNER bypasses the
-- policy, which would make every migration-time or admin-tool query
-- cross-tenant.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'module_settings',
    'invitations',
    'memberships',
    'workspace_preferences',
    'licenses',
    'license_keys',
    'license_events',
    'device_activations',
    'audit_log',
    'access_log',
    'erasure_requests',
    'export_jobs',
    'consent_records'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I
         USING (organization_id = public.current_org_id())
         WITH CHECK (organization_id = public.current_org_id())', t);
  END LOOP;
END $$;

-- --- organizations: the tenant root itself -------------------------------
-- Scoped on `id`, not `organization_id`. A tenant sees exactly its own row.
--
-- Signup works because ids are generated application-side (UUIDv7): the app
-- sets app.org_id to the new id, then inserts, so WITH CHECK is satisfied.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.organizations;
CREATE POLICY tenant_isolation ON public.organizations
  USING (id = public.current_org_id())
  WITH CHECK (id = public.current_org_id());

-- --- roles: system roles are shared, custom roles are not ----------------
-- organization_id IS NULL identifies a built-in role visible to every tenant.
-- Getting this wrong in either direction is a bug: too strict and nobody can
-- resolve their own role, too loose and one tenant reads another's custom roles.
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.roles;
CREATE POLICY tenant_isolation ON public.roles
  USING (organization_id IS NULL OR organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

-- --- role_permissions: inherits scope from roles --------------------------
-- No organization_id of its own. The EXISTS subquery is itself subject to the
-- roles policy above, so this needs no tenant predicate — it simply cannot see
-- a role row it is not allowed to see.
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.role_permissions;
CREATE POLICY tenant_isolation ON public.role_permissions
  USING (EXISTS (SELECT 1 FROM public.roles r WHERE r.id = role_permissions.role_id));

-- ===========================================================================
-- 4. Controlled RLS bypass: the organization switcher
-- ===========================================================================
-- Listing which organizations a user belongs to is genuinely pre-tenant — there
-- is no app.org_id yet, and the policies above correctly return nothing.
--
-- Rather than weaken those policies, this is ONE small SECURITY DEFINER
-- function: a single reviewable bypass with a fixed search_path (without which
-- a caller could shadow `memberships` with their own table and hijack the
-- definer's privileges). It returns only the user's own memberships.

CREATE OR REPLACE FUNCTION public.user_organizations(p_user_id uuid)
RETURNS TABLE (
  organization_id uuid,
  organization_name text,
  organization_slug text,
  role_key text,
  membership_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.name, o.slug, r.key, m.id
  FROM memberships m
  JOIN organizations o ON o.id = m.organization_id
  JOIN roles r ON r.id = m.role_id
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND o.deleted_at IS NULL
    AND o.status = 'active'
  ORDER BY o.name
$$;

REVOKE ALL ON FUNCTION public.user_organizations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_organizations(uuid) TO syncrese_app;

-- ===========================================================================
-- 5. Seat enforcement  (MUST DO #16)
-- ===========================================================================
-- SECURITY DEFINER deliberately: the count must be TRUE regardless of the
-- caller's row visibility. If RLS hid even one active membership the count
-- would come out low and the seat limit could be undercounted — the trigger has
-- to see the whole tenant to enforce the whole tenant.
--
-- FOR UPDATE on the licence row serialises concurrent invitation accepts. Two
-- admins accepting the last seat simultaneously both pass a naive count; the
-- lock makes the second wait and then fail correctly.

CREATE OR REPLACE FUNCTION public.enforce_seat_limit() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  active_seats   int;
  licensed_seats int;
BEGIN
  -- Only a row that consumes a seat is interesting.
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  -- Already active and staying active: role changes must not re-check.
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN
    RETURN NEW;
  END IF;

  SELECT seat_count INTO licensed_seats
  FROM licenses
  WHERE organization_id = NEW.organization_id
    AND status IN ('trial', 'active')
  FOR UPDATE;

  IF licensed_seats IS NULL THEN
    RAISE EXCEPTION 'SYNC_NO_LICENSE' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO active_seats
  FROM memberships
  WHERE organization_id = NEW.organization_id
    AND status = 'active'
    AND id <> NEW.id;

  IF active_seats + 1 > licensed_seats THEN
    RAISE EXCEPTION 'SYNC_SEAT_LIMIT_REACHED (% of % seats used)',
      active_seats, licensed_seats
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS memberships_seat_limit ON public.memberships;
CREATE TRIGGER memberships_seat_limit
  BEFORE INSERT OR UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.enforce_seat_limit();

-- ===========================================================================
-- 6. Audit immutability  (MUST DO #3)
-- ===========================================================================
-- Immutability is a GRANT, not a convention. With UPDATE and DELETE never
-- granted, application code physically cannot rewrite history — including code
-- written years from now by someone who has not read this file.
--
-- GDPR erasure pseudonymises instead of deleting (confirmed decision): that
-- runs as the OWNER through a dedicated, audited path, not through the app role.

GRANT SELECT, INSERT ON public.audit_log  TO syncrese_app;
GRANT SELECT, INSERT ON public.access_log TO syncrese_app;

CREATE OR REPLACE FUNCTION public.block_mutation() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SYNC_APPEND_ONLY: % is append-only and cannot be % ed',
    TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS audit_log_append_only ON public.audit_log;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.block_mutation();

-- ===========================================================================
-- 7. Grants
-- ===========================================================================
-- Everything except the append-only tables granted above. Deliberately
-- enumerated rather than "ALL TABLES IN SCHEMA": a blanket grant would silently
-- re-grant UPDATE/DELETE on audit_log the next time it ran.

DO $$
DECLARE
  t text;
  rw_tables text[] := ARRAY[
    'organizations', 'module_settings',
    'users', 'roles', 'permissions', 'role_permissions',
    'memberships', 'invitations',
    'auth_accounts', 'sessions', 'verification_tokens',
    'user_preferences', 'workspace_preferences',
    'licenses', 'license_keys', 'license_events', 'device_activations',
    'erasure_requests', 'export_jobs', 'consent_records'
  ];
BEGIN
  FOREACH t IN ARRAY rw_tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO syncrese_app', t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO syncrese_app;

-- ===========================================================================
-- 8. updated_at
-- ===========================================================================
-- Set by the database so a forgotten assignment in application code cannot
-- leave a stale timestamp on an audited record.

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'updated_at'
      AND NOT a.attisdropped
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_touch_updated_at', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
      t || '_touch_updated_at', t);
  END LOOP;
END $$;
