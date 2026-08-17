-- ---------------------------------------------------------------------------
-- Syncrese — make the SECURITY DEFINER functions work on a real database.
--
-- THE BUG THIS FIXES
--
-- Row level security applies to whoever the CURRENT USER is at query time. In a
-- SECURITY DEFINER function that is the function's OWNER — and every migration
-- here runs as `syncrese_owner`, so the owner is who these functions ran as.
-- FORCE ROW LEVEL SECURITY exists precisely to subject the table owner to the
-- policies. Put those two together and every pre-tenant lookup in this codebase
-- returned ZERO ROWS on a real deployment:
--
--   user_organizations        → nobody could sign in, at all
--   resolve_api_key           → every API request 401
--   resolve_invitation        → every invitation link "not valid"
--   resolve_billing_customer  → every Stripe webhook silently dropped
--   resolve_license_key       → every product key "not valid"
--   organization_slug_taken   → signup slug collisions
--   claim_billing_event       → webhook idempotency broken
--   consume_signup_attempt    → signup throttle broken
--   enforce_seat_limit        → the seat limit stops counting
--
-- None of it showed in the test suite, because PGlite connects as a superuser:
-- the functions end up owned by one, and a superuser bypasses RLS
-- unconditionally. tests/migrate-as-owner.test.ts proved the migrations APPLY
-- as a non-superuser owner but never called a function afterwards. It does now.
--
-- THE FIX
--
-- One dedicated role, `syncrese_definer`, owns every SECURITY DEFINER function,
-- and each policed table carries one extra PERMISSIVE policy naming that role.
-- Permissive policies are OR'd, so this exempts exactly that role and nothing
-- else — the application role stays as confined as it ever was.
--
-- Deliberately NOT `BYPASSRLS`, which would do the same job: granting it
-- requires a superuser, and neither Neon's `neondb_owner` nor an RDS master
-- user is one. A policy the table owner can write needs no superuser anywhere,
-- which is what makes this deployable on managed Postgres at all.
--
-- The role is NOLOGIN. Nothing connects as it; it exists only to own about
-- twenty small, individually reviewed functions.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. The role
-- ===========================================================================
-- Guarded, because provisioning creates it on a real deployment (the migration
-- role has NOCREATEROLE there). This branch is what makes tests and the
-- embedded development database work.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_definer') THEN
    CREATE ROLE syncrese_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'syncrese_definer does not exist and this role cannot create it. '
    'Run scripts/provision-db.ts (npm run db:provision) against this database first.';
END $$;

-- Reassigning a function's owner requires membership of the target role.
-- Provisioning grants this on a real deployment; this covers everywhere else.
DO $$
BEGIN
  EXECUTE format('GRANT syncrese_definer TO %I', current_user);
EXCEPTION WHEN OTHERS THEN
  -- Already a member, or already granted by provisioning. Either is fine.
  NULL;
END $$;

-- ===========================================================================
-- 2. Privileges
-- ===========================================================================
-- The definer functions read and write ordinary tenant tables. The append-only
-- pair keep their append-only shape even here: nothing in a SECURITY DEFINER
-- function rewrites history, and not granting it means nothing ever can.

DO $$
DECLARE
  t text;
BEGIN
  GRANT USAGE ON SCHEMA public TO syncrese_definer;

  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('audit_log', 'access_log')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO syncrese_definer', t);
  END LOOP;

  FOR t IN SELECT unnest(ARRAY['audit_log', 'access_log']) LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('GRANT SELECT, INSERT ON public.%I TO syncrese_definer', t);
    END IF;
  END LOOP;

  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO syncrese_definer';
END $$;

-- ===========================================================================
-- 3. The exemption policy
-- ===========================================================================
-- One permissive policy per policed table, scoped TO syncrese_definer. Applied
-- to every table that has RLS enabled, found from the catalogue rather than a
-- list — a list is what gets forgotten when table twenty-nine is added.

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS definer_access ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY definer_access ON public.%I TO syncrese_definer USING (true) WITH CHECK (true)',
      t);
  END LOOP;
END $$;

-- ===========================================================================
-- 4. Hand every SECURITY DEFINER function to that role
-- ===========================================================================
-- Driven from `pg_proc.prosecdef` rather than a hand-written list, so a
-- function added in a later migration is picked up by re-running this logic —
-- and so nothing was missed today. There are around twenty of them.

DO $$
DECLARE
  fn record;
BEGIN
  -- Reassigning a function requires the incoming owner to hold CREATE on the
  -- schema that contains it. Granted only for the length of this loop and taken
  -- straight back: a role with CREATE on `public` can define a table that
  -- shadows one a SECURITY DEFINER function trusts, which is the exact
  -- privilege every other role here is denied.
  GRANT CREATE ON SCHEMA public TO syncrese_definer;

  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO syncrese_definer', fn.signature);
  END LOOP;

  REVOKE CREATE ON SCHEMA public FROM syncrese_definer;
END $$;
