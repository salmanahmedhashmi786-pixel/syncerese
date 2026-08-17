-- ---------------------------------------------------------------------------
-- Syncrese — members, invitations and the last-owner guard.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Accepting an invitation is PRE-TENANT
-- ===========================================================================
-- The recipient arrives holding only a token. Which organization it belongs to
-- is precisely what we are resolving, so `app.org_id` is unset and the
-- `invitations` tenant policy filters the lookup to zero rows — every invite
-- would read as invalid.
--
-- Same shape as `user_organizations` and `resolve_api_key`: one narrow
-- SECURITY DEFINER function rather than weakening the policy.
--
-- It takes a HASH, never the token itself, and returns only what the accept
-- screen needs: which organization, which email it was addressed to, which
-- role, and why it is unusable if it is. Nothing here is a secret to the person
-- holding the token — they were sent it.

CREATE OR REPLACE FUNCTION public.resolve_invitation(p_token_hash text)
RETURNS TABLE (
  invitation_id     uuid,
  organization_id   uuid,
  organization_name text,
  email             text,
  role_id           uuid,
  role_key          text,
  role_name         text,
  expired           boolean,
  accepted          boolean,
  revoked           boolean,
  user_exists       boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    i.id,
    i.organization_id,
    o.name,
    i.email,
    i.role_id,
    r.key,
    r.name,
    (i.expires_at < now()),
    (i.accepted_at IS NOT NULL),
    (i.revoked_at IS NOT NULL),
    -- Decides which screen the recipient sees: "set a password" for somebody
    -- new, or "sign in to join" for an existing account. Not a disclosure —
    -- the caller already knows this address was invited.
    EXISTS (SELECT 1 FROM users u WHERE u.email = i.email)
  FROM invitations i
  JOIN organizations o ON o.id = i.organization_id
  JOIN roles r         ON r.id = i.role_id
  WHERE i.token_hash = p_token_hash
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.resolve_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_invitation(text) TO syncrese_app;


-- ===========================================================================
-- 2. The tenant must never lose its last owner
-- ===========================================================================
-- An organization with no active owner cannot invite, cannot change a role,
-- cannot manage its licence and cannot delete itself. It is not recoverable
-- from inside the product — it needs someone with database access.
--
-- The two ways in are deactivating the last owner and demoting them, and both
-- are things an owner can plausibly do to themselves while tidying up. Enforced
-- here rather than in service code because there are three write paths into
-- this table already and there will be more.
--
-- UPDATE ONLY, deliberately. `memberships.organization_id` is ON DELETE
-- CASCADE, so deleting an organization deletes its memberships — including its
-- last owner. A trigger that also fired on DELETE would abort that cascade and
-- make `org.delete` permanently impossible, which GDPR erasure will need too.
-- The product never hard-deletes a membership on its own (offboarding sets
-- status='deactivated'), so DELETE reaching this table at all means the tenant
-- is going away and there is nothing left to administer.
--
-- SECURITY DEFINER for the same reason as the seat trigger: the count has to be
-- true for the whole tenant, and RLS hiding one row would make it wrong in the
-- dangerous direction.

CREATE OR REPLACE FUNCTION public.enforce_last_owner() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  was_owner      boolean;
  still_owner    boolean;
  other_owners   int;
BEGIN
  SELECT (r.key = 'owner') INTO was_owner
  FROM roles r WHERE r.id = OLD.role_id;

  -- Not an owner to begin with: nothing this row does can remove the last one.
  IF NOT COALESCE(was_owner, false) OR OLD.status <> 'active' THEN
    RETURN NEW;
  END IF;

  SELECT (r.key = 'owner' AND NEW.status = 'active') INTO still_owner
  FROM roles r WHERE r.id = NEW.role_id;

  IF COALESCE(still_owner, false) THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO other_owners
  FROM memberships m
  JOIN roles r ON r.id = m.role_id
  WHERE m.organization_id = OLD.organization_id
    AND m.status = 'active'
    AND r.key = 'owner'
    AND m.id <> OLD.id;

  IF other_owners = 0 THEN
    RAISE EXCEPTION 'SYNC_LAST_OWNER' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS memberships_last_owner ON public.memberships;
CREATE TRIGGER memberships_last_owner
  BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.enforce_last_owner();


-- ===========================================================================
-- 3. One live invitation per address per tenant
-- ===========================================================================
-- Without this, "invite" clicked twice leaves two valid tokens for the same
-- person: revoking the one you can see does not revoke the other. Partial, so
-- accepted and revoked rows accumulate freely as history.

CREATE UNIQUE INDEX IF NOT EXISTS invitations_live_uq
  ON public.invitations (organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Looking an invitation up by its token must not degrade into a scan as the
-- history grows.
CREATE INDEX IF NOT EXISTS invitations_token_idx ON public.invitations (token_hash);
