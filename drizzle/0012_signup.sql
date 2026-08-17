-- ---------------------------------------------------------------------------
-- Syncrese — self-service signup support.
--
-- Signup is PRE-TENANT: at the moment we pick a slug there is no organization
-- yet, so `app.org_id` is unset and the `organizations` policy
-- (USING id = current_org_id()) filters the lookup to zero rows.
--
-- That made the uniqueness check in onboarding.ts always answer "free". The
-- first tenant would sign up fine; the second one whose name slugified the
-- same way would hit `organizations_slug_key` and get a 500 on the very first
-- screen a customer sees.
--
-- Same shape as `user_organizations` and `resolve_api_key`: one narrow
-- SECURITY DEFINER function that answers a single boolean, rather than
-- weakening the policy or handing the request path an unscoped connection.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.organization_slug_taken(p_slug text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Returns a boolean and nothing else. It cannot be coaxed into revealing a
  -- name, an id or a row count: the caller learns only whether one specific
  -- string is available, which is the same thing the unique index would tell
  -- them by rejecting an insert.
  SELECT EXISTS (SELECT 1 FROM organizations WHERE slug = p_slug)
$$;

REVOKE ALL ON FUNCTION public.organization_slug_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.organization_slug_taken(text) TO syncrese_app;

-- ===========================================================================
-- Signup throttle
-- ===========================================================================
-- Signup is unauthenticated and expensive: one call runs argon2, provisions a
-- chart of accounts and writes several hundred rows. Left open it is a free
-- denial-of-service primitive and a way to fill the tenant table with junk.
--
-- In the database rather than in process memory for the same reason the login
-- lockout is: an in-process counter resets on every deploy, and is per-instance
-- the moment the app runs on more than one.
--
-- The caller stores a HASH of the address, never the address. This table is
-- abuse-prevention state, not a visitor log — there is nothing here to hand
-- over in a subject access request, and nothing worth stealing.

CREATE TABLE IF NOT EXISTS public.signup_attempts (
  ip_hash      text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts     integer     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS signup_attempts_window_idx
  ON public.signup_attempts (window_start);

-- Deliberately NOT granted to syncrese_app: the app reaches this only through
-- the function below, so it can neither read the table nor reset its own
-- counter.
ALTER TABLE public.signup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_attempts FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_signup_attempt(
  p_ip_hash text,
  p_limit   integer,
  p_window  interval
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempts integer;
BEGIN
  -- Expired rows are dropped opportunistically. A separate cleanup job for a
  -- table this small would be more moving parts than it is worth.
  DELETE FROM signup_attempts WHERE window_start < now() - p_window;

  INSERT INTO signup_attempts (ip_hash, window_start, attempts)
  VALUES (p_ip_hash, now(), 1)
  ON CONFLICT (ip_hash) DO UPDATE
    SET attempts = CASE
          WHEN signup_attempts.window_start < now() - p_window THEN 1
          ELSE signup_attempts.attempts + 1
        END,
        window_start = CASE
          WHEN signup_attempts.window_start < now() - p_window THEN now()
          ELSE signup_attempts.window_start
        END
  RETURNING attempts INTO v_attempts;

  RETURN v_attempts <= p_limit;
END $$;

REVOKE ALL ON FUNCTION public.consume_signup_attempt(text, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_signup_attempt(text, integer, interval) TO syncrese_app;

-- ===========================================================================
-- Health check
-- ===========================================================================
-- /api/health reports how many migrations the database it is actually talking
-- to has applied — zero is how you find out a container was pointed at the
-- wrong database, which is otherwise indistinguishable from a fresh install.
--
-- The bookkeeping table is created by the migration RUNNER, not by a migration,
-- so it is absent when the test harness applies these files directly. Guarded
-- rather than assumed: an unconditional GRANT here would fail every test.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = '__drizzle_migrations'
  ) THEN
    EXECUTE 'GRANT SELECT ON public.__drizzle_migrations TO syncrese_app';
  END IF;
END $$;
