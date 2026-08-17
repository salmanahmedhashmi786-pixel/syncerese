-- ---------------------------------------------------------------------------
-- Syncrese — authentication hardening (MUST DO #18).
--
-- Three things: somewhere to remember which TOTP code was last used, a
-- per-address throttle on sign-in, and an organization policy that can require
-- MFA of its administrators.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. TOTP replay protection
-- ===========================================================================
-- A TOTP code is valid for up to 90 seconds once clock skew is allowed for.
-- That is ample time for somebody who read it over a shoulder, or captured it
-- in a phishing proxy, to use it again on their own device.
--
-- Storing the last counter accepted makes each code single-use. Not a
-- substitute for the code expiring, but it closes the window that expiry
-- leaves open.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS mfa_last_counter bigint;

-- ===========================================================================
-- 2. Sign-in throttle
-- ===========================================================================
-- The existing lockout is PER ACCOUNT: eight failures locks that user for
-- fifteen minutes. That stops somebody grinding one password and does nothing
-- about the opposite attack — one common password tried against thousands of
-- addresses, which never trips a per-account counter because no account sees
-- more than one failure.
--
-- Same shape as the signup throttle: keyed by a salted hash of the caller's
-- address, in the database so it survives a deploy and holds across instances,
-- and reachable only through a SECURITY DEFINER function so the application
-- cannot clear its own counter.

CREATE TABLE IF NOT EXISTS public.signin_attempts (
  ip_hash      text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts     integer     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS signin_attempts_window_idx
  ON public.signin_attempts (window_start);

ALTER TABLE public.signin_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signin_attempts FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_signin_attempt(
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
  DELETE FROM signin_attempts WHERE window_start < now() - p_window;

  INSERT INTO signin_attempts (ip_hash, window_start, attempts)
  VALUES (p_ip_hash, now(), 1)
  ON CONFLICT (ip_hash) DO UPDATE
    SET attempts = CASE
          WHEN signin_attempts.window_start < now() - p_window THEN 1
          ELSE signin_attempts.attempts + 1
        END,
        window_start = CASE
          WHEN signin_attempts.window_start < now() - p_window THEN now()
          ELSE signin_attempts.window_start
        END
  RETURNING attempts INTO v_attempts;

  RETURN v_attempts <= p_limit;
END $$;

REVOKE ALL ON FUNCTION public.consume_signin_attempt(text, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_signin_attempt(text, integer, interval) TO syncrese_app;

/**
 * Clears the counter after a successful sign-in.
 *
 * Without this an office behind one NAT address locks itself out on an ordinary
 * Monday morning: twenty people, a few typos each, and the shared address is
 * over the limit while every one of them is legitimate.
 */
CREATE OR REPLACE FUNCTION public.clear_signin_attempts(p_ip_hash text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM signin_attempts WHERE ip_hash = p_ip_hash
$$;

REVOKE ALL ON FUNCTION public.clear_signin_attempts(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_signin_attempts(text) TO syncrese_app;

-- ===========================================================================
-- 3. Organization MFA policy
-- ===========================================================================
-- MUST DO #18 asks for MFA to be strongly recommended for Owner and Admin. A
-- recommendation nobody can enforce is a line in a document, so this makes it a
-- setting the organization controls.
--
-- Enforced at the point of USE rather than at sign-in: somebody who has not
-- enrolled yet must still be able to get in far enough to enrol, or turning the
-- policy on locks out the person who turned it on.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS require_mfa_for_admins boolean NOT NULL DEFAULT false;
