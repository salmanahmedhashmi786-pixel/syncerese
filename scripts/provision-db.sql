-- ---------------------------------------------------------------------------
-- Syncrese — one-time database provisioning for a MANAGED Postgres.
--
-- Run this ONCE, as the provider's administrative role, before the first
-- `npm run db:migrate`. It is the managed-hosting equivalent of
-- docker/init-roles.sh.
--
--   psql "$ADMIN_URL" -v owner_password="'…'" -v app_password="'…'" \
--        -f scripts/provision-db.sql
--
-- Replace the two passwords with generated values (`openssl rand -base64 24`).
-- Do NOT commit them, and do not paste them into a shell that keeps history —
-- `psql -v` reads them from the command line, so prefer a `.pgpass` or an
-- editor buffer you close.
--
-- WHY THREE ROLES
--
-- The application connects as `syncrese_app`. That role does not own the
-- tables, cannot alter a policy, and does not have BYPASSRLS. Every tenant
-- isolation guarantee in this system rests on that being true — a superuser or
-- BYPASSRLS connection silently returns every tenant's rows to every query and
-- nothing else in the stack notices. This file is where that gets set up
-- correctly, and `npm run db:verify` is how you confirm it stayed that way.
--
-- PROVIDER NOTES
--
--   Neon      the default `neondb_owner` can create roles. Run as that.
--   Supabase  run as `postgres`. Supabase's own `supabase_admin` owns some
--             extensions; leave them alone — only `public` matters here.
--   RDS       the master user is not a true superuser but does have
--             CREATEROLE, which is all this needs.
--
-- If your provider does not allow CREATE ROLE at all, you cannot run this
-- application safely on it. There is no application-level substitute for a
-- non-privileged connection.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- --- 1. The roles ----------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_owner') THEN
    CREATE ROLE syncrese_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_app') THEN
    CREATE ROLE syncrese_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

DO $$
BEGIN
  -- Owns the SECURITY DEFINER functions. See drizzle/0019 for why this role
  -- has to exist: without it every pre-tenant lookup silently reads nothing —
  -- sign-in, API keys, invitations, Stripe webhooks, product keys — because a
  -- definer function runs as its owner and FORCE ROW LEVEL SECURITY subjects
  -- the table owner to the policies. NOLOGIN: nothing ever connects as it.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_definer') THEN
    CREATE ROLE syncrese_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT syncrese_definer TO syncrese_owner;

ALTER ROLE syncrese_owner PASSWORD :owner_password;
ALTER ROLE syncrese_app   PASSWORD :app_password;

-- Explicit even where it is already the default. A role restored from a dump
-- or created by an earlier version of this file may carry either attribute,
-- and both defeat every RLS policy in the schema.
ALTER ROLE syncrese_app     NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
ALTER ROLE syncrese_owner   NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;
ALTER ROLE syncrese_definer NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB;

-- --- 2. Schema ownership ---------------------------------------------------
-- Migrations run as the owner and create tables in `public`.

ALTER SCHEMA public OWNER TO syncrese_owner;

-- --- 3. Lock down the schema ----------------------------------------------
-- Postgres 15+ does this by default; restored dumps and older clusters do not.
-- Without it the application role could create a table shadowing one that a
-- SECURITY DEFINER function trusts, and take that function's privileges with
-- it.

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL   ON SCHEMA public FROM syncrese_app;
GRANT  USAGE ON SCHEMA public TO   syncrese_app;

-- --- 4. Extensions ---------------------------------------------------------
-- Created here, as the admin, because the owner role usually may not. Both are
-- optional: pgcrypto is used for gen_random_uuid() defaults, pg_trgm for
-- search. The migrations degrade gracefully if pg_trgm is unavailable.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- --- 5. Confirm ------------------------------------------------------------

SELECT rolname            AS role,
       rolsuper           AS is_superuser,
       rolbypassrls       AS bypasses_rls,
       rolcreaterole      AS can_create_roles
FROM pg_roles
WHERE rolname IN ('syncrese_owner', 'syncrese_app', 'syncrese_definer')
ORDER BY rolname;

-- All three rows must read false, false, false.
--
-- Next:
--   DATABASE_MIGRATION_URL=postgresql://syncrese_owner:…@host/db npm run db:migrate
--   DATABASE_URL=postgresql://syncrese_app:…@host/db           npm run db:verify
