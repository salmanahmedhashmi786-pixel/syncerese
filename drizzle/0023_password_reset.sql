-- ---------------------------------------------------------------------------
-- Syncrese — password reset.
--
-- The flow a SaaS cannot ship without: a person who forgets their password
-- currently has no route back in short of database surgery, which is a support
-- ticket every day forever.
--
-- IT IS ALSO THE CLASSIC PLACE TO GET SECURITY WRONG, so the decisions are
-- written down here rather than inferred from the code:
--
-- 1. TOKENS ARE HASHED. A reset token is a bearer credential that grants
--    account takeover. A database backup, a read replica or an over-broad
--    SELECT must not contain a list of live ones.
--
-- 2. SINGLE USE, ONE HOUR. Long enough to walk to a laptop, short enough that a
--    link sitting in a mailbox for a month is not a standing key. `consumed_at`
--    is set in the same statement that reads it, so two racing requests cannot
--    both spend it.
--
-- 3. NO USER ENUMERATION. The request endpoint answers identically whether or
--    not the address exists. That is enforced in the service, but the schema
--    supports it: a row is only ever created for a real user, and the caller is
--    told nothing either way.
--
-- 4. A RESET REVOKES EXISTING SESSIONS. This is `credentials_changed_at` below,
--    and it is the part most implementations miss.
--
-- 5. IT DOES NOT BYPASS MFA. Nothing here touches the second factor. Somebody
--    who has taken over a mailbox still has to produce a TOTP code, which is
--    the entire reason the second factor exists.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  /** Peppered hash, never the token. See note 1 above. */
  token_hash  text NOT NULL UNIQUE,

  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,

  /**
   * Hashed, for the same reason the throttle tables hash it: an IP address tied
   * to a named person is personal data, and this table has no need to hold one
   * in the clear. Kept at all so an administrator investigating a suspicious
   * reset can correlate it with the access log.
   */
  requested_ip_hash text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON public.password_reset_tokens (user_id, created_at DESC);

-- NO GRANT TO THE APPLICATION ROLE, and RLS with no policy — the same treatment
-- `signin_attempts` and `signup_attempts` get, for the same reason.
--
-- `users` is global, so there is no tenant column to scope by; without this the
-- table would simply be readable. A bug or an injection in application code
-- must not be able to enumerate live reset tokens, and it cannot, because the
-- app role has no privilege on this table at all. Every access goes through the
-- SECURITY DEFINER functions below.
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_tokens FORCE ROW LEVEL SECURITY;

-- ===========================================================================
-- Session revocation
-- ===========================================================================
-- Sessions here are JWTs, which cannot be deleted server-side. Without a marker
-- like this one, a password reset after an account compromise leaves the
-- attacker signed in for the remaining life of their token — up to twelve
-- hours. The auth callback compares the token's issued-at against this column
-- and refuses anything older.
--
-- Set by a reset, and it should be set by any future change that ought to end
-- other sessions: a password change from the security panel, or disabling MFA.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS credentials_changed_at timestamptz;

-- ===========================================================================
-- Throttling
-- ===========================================================================
-- Its OWN counter, deliberately not `signin_attempts`. Sharing that table would
-- mean somebody probing reset requests locks out sign-in for everyone behind
-- the same office NAT — turning a rate limit into a denial of service against
-- the customer.

CREATE TABLE IF NOT EXISTS public.reset_attempts (
  ip_hash     text PRIMARY KEY,
  attempts    integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
);

-- Same treatment: no grant, no policy. The application cannot read the counters
-- or reset its own.
ALTER TABLE public.reset_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reset_attempts FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_reset_attempt(
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
  current_attempts integer;
BEGIN
  INSERT INTO reset_attempts (ip_hash, attempts, window_start)
  VALUES (p_ip_hash, 1, now())
  ON CONFLICT (ip_hash) DO UPDATE
    SET attempts = CASE
          WHEN reset_attempts.window_start < now() - p_window THEN 1
          ELSE reset_attempts.attempts + 1
        END,
        window_start = CASE
          WHEN reset_attempts.window_start < now() - p_window THEN now()
          ELSE reset_attempts.window_start
        END
  RETURNING attempts INTO current_attempts;

  RETURN current_attempts <= p_limit;
END $$;

REVOKE ALL ON FUNCTION public.consume_reset_attempt(text, integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_reset_attempt(text, integer, interval) TO syncrese_app;

/**
 * Issues a token.
 *
 * A function rather than an INSERT, because the application role has no
 * privilege on the table. It also enforces the one-hour lifetime here rather
 * than trusting a caller-supplied expiry — a lifetime that only exists in
 * TypeScript is one a later caller forgets.
 */
CREATE OR REPLACE FUNCTION public.issue_password_reset(
  p_id         uuid,
  p_user_id    uuid,
  p_token_hash text,
  p_ip_hash    text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, requested_ip_hash)
  VALUES (p_id, p_user_id, p_token_hash, now() + interval '1 hour', p_ip_hash)
$$;

REVOKE ALL ON FUNCTION public.issue_password_reset(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_password_reset(uuid, uuid, text, text) TO syncrese_app;

/**
 * Whether a token could be spent, without spending it — so the page can say
 * "this link has expired" before asking somebody to type a password twice.
 * Returns a boolean and nothing else: not the user, not the expiry.
 */
CREATE OR REPLACE FUNCTION public.password_reset_valid(p_token_hash text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM password_reset_tokens
     WHERE token_hash = p_token_hash
       AND consumed_at IS NULL
       AND expires_at > now()
  )
$$;

REVOKE ALL ON FUNCTION public.password_reset_valid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.password_reset_valid(text) TO syncrese_app;

/** Invalidates every outstanding token for an account, which a completed reset
 *  does so a second link left in a mailbox is not a spare key. */
CREATE OR REPLACE FUNCTION public.invalidate_password_resets(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE password_reset_tokens SET consumed_at = now()
   WHERE user_id = p_user_id AND consumed_at IS NULL
$$;

REVOKE ALL ON FUNCTION public.invalidate_password_resets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invalidate_password_resets(uuid) TO syncrese_app;

-- ===========================================================================
-- Redeeming a token
-- ===========================================================================
-- Pre-tenant by nature: somebody resetting a password has no session and no
-- organization. One statement claims the token, so two racing requests cannot
-- both spend it — the loser gets no row rather than a second reset.
--
-- Returns the user id, or NULL for expired, already-used and never-existed
-- alike. The caller is unauthenticated and must not be able to tell those apart.

CREATE OR REPLACE FUNCTION public.consume_password_reset(p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid;
BEGIN
  UPDATE password_reset_tokens
     SET consumed_at = now()
   WHERE token_hash = p_token_hash
     AND consumed_at IS NULL
     AND expires_at > now()
  RETURNING user_id INTO v_user;

  RETURN v_user;
END $$;

REVOKE ALL ON FUNCTION public.consume_password_reset(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_password_reset(text) TO syncrese_app;

/**
 * Finds the account a reset was asked for.
 *
 * Pre-tenant, and returns only what the caller needs to send an email. A
 * deactivated or erased account resolves to nothing: an erased user's tombstone
 * address is `@erased.invalid` and must never receive a working reset link.
 */
CREATE OR REPLACE FUNCTION public.resolve_reset_recipient(p_email text)
RETURNS TABLE (user_id uuid, email text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.email, u.name
  FROM users u
  WHERE lower(u.email) = lower(p_email)
    AND u.status = 'active'
    AND u.deleted_at IS NULL
    -- Password sign-in has to be set up already. An account that only ever used
    -- Google or Microsoft has no password to reset, and issuing a token would
    -- silently create one — a way to convert an SSO account into a
    -- password account by holding the mailbox.
    AND u.password_hash IS NOT NULL
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.resolve_reset_recipient(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_reset_recipient(text) TO syncrese_app;

-- Migration 0019's treatment: these are SECURITY DEFINER functions reading
-- tables the app role reaches under FORCE row level security elsewhere.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_definer') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.password_reset_tokens TO syncrese_definer;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.reset_attempts TO syncrese_definer;

    -- FORCE row level security subjects the owner to the policies, and these
    -- two tables have none — so the definer needs its own exemption, exactly as
    -- 0019 gives every other policed table.
    DROP POLICY IF EXISTS definer_access ON public.password_reset_tokens;
    CREATE POLICY definer_access ON public.password_reset_tokens
      TO syncrese_definer USING (true) WITH CHECK (true);
    DROP POLICY IF EXISTS definer_access ON public.reset_attempts;
    CREATE POLICY definer_access ON public.reset_attempts
      TO syncrese_definer USING (true) WITH CHECK (true);

    GRANT CREATE ON SCHEMA public TO syncrese_definer;
    ALTER FUNCTION public.consume_reset_attempt(text, integer, interval)
      OWNER TO syncrese_definer;
    ALTER FUNCTION public.consume_password_reset(text) OWNER TO syncrese_definer;
    ALTER FUNCTION public.resolve_reset_recipient(text) OWNER TO syncrese_definer;
    ALTER FUNCTION public.issue_password_reset(uuid, uuid, text, text)
      OWNER TO syncrese_definer;
    ALTER FUNCTION public.password_reset_valid(text) OWNER TO syncrese_definer;
    ALTER FUNCTION public.invalidate_password_resets(uuid) OWNER TO syncrese_definer;
    REVOKE CREATE ON SCHEMA public FROM syncrese_definer;
  END IF;
END $$;
