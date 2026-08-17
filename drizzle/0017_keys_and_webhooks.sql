-- ---------------------------------------------------------------------------
-- Syncrese — webhook signing secrets, and product keys.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Webhook signing secrets are ENCRYPTED, not only hashed
-- ===========================================================================
-- The decision this was blocked on.
--
-- A hash is enough to CHECK a secret somebody presents. It is not enough to
-- SIGN with, and signing is the entire job: every delivery computes
-- HMAC-SHA256 over `{timestamp}.{body}` with the endpoint's secret. Hash-only
-- storage means `drainDeliveries` can never obtain the plaintext, so no webhook
-- can ever be sent without first re-issuing the secret and breaking whatever
-- the customer has already built against it.
--
-- So the secret is encrypted at rest with AES-256-GCM (lib/crypto.ts), the same
-- treatment MFA secrets get, and can be revealed to somebody holding
-- `webhook.manage` — which is what Stripe and GitHub both do, and what a
-- customer who has lost their signing secret expects.
--
-- The trade-off, stated plainly: ENCRYPTION_KEY is now load-bearing for
-- webhooks too. Lose it and every endpoint must be re-issued.
--
-- `secret_hash` stays. It costs one column and it means a secret can still be
-- verified if the encrypted copy is ever unreadable.

ALTER TABLE public.webhook_endpoints
  ADD COLUMN IF NOT EXISTS secret_encrypted text;

-- ===========================================================================
-- 2. Product keys
-- ===========================================================================
-- The licensing path that does NOT go through Stripe: a key is issued by the
-- vendor, handed to a customer, and activated to grant a fixed period of
-- access. It is how an offline or invoice-paying customer is licensed, and how
-- the desktop app will be licensed when it ships.
--
-- `license_keys` already existed with the right shape. What it lacked was the
-- period a key grants and any record of it being used.

ALTER TABLE public.license_keys
  -- How long activating it grants. 3, 30 or 365 in the UI; the column takes any
  -- positive number so a bespoke term can be issued without a migration.
  ADD COLUMN IF NOT EXISTS duration_days integer,
  -- Seats the key grants. Null leaves the licence's existing count alone.
  ADD COLUMN IF NOT EXISTS seat_count    integer,
  ADD COLUMN IF NOT EXISTS plan          text,
  ADD COLUMN IF NOT EXISTS activated_at  timestamptz,
  ADD COLUMN IF NOT EXISTS activated_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- Who issued it and why, for support and for the audit.
  ADD COLUMN IF NOT EXISTS issued_by     uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS note          text,
  -- A key that is never activated should not stay redeemable for ever.
  ADD COLUMN IF NOT EXISTS expires_at    timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'license_keys_duration_positive') THEN
    ALTER TABLE public.license_keys
      ADD CONSTRAINT license_keys_duration_positive
      CHECK (duration_days IS NULL OR duration_days > 0);
  END IF;
END $$;

-- The lookup at activation is by hash, and it happens before any tenant scope
-- exists.
CREATE INDEX IF NOT EXISTS license_keys_hash_idx ON public.license_keys (key_hash);

-- ===========================================================================
-- 3. Platform administrators
-- ===========================================================================
-- Issuing a key means acting ACROSS tenants — listing every organization to
-- pick one. That is not a tenant capability and must not be reachable from a
-- tenant session, however carefully the application checks.
--
-- So the check lives in the DATABASE. Every cross-tenant function below takes
-- the caller's user id and returns NOTHING unless that user is in this table.
-- An application bug that forgets to gate the admin page therefore leaks
-- nothing: the functions simply answer empty.
--
-- Membership is granted from the command line (`npm run admin:grant`), never
-- from the web UI — a platform admin who can appoint another platform admin
-- through a browser is one XSS away from a compromise of every tenant.

CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  note       text
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admins FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_platform_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = p_user_id)
$$;

REVOKE ALL ON FUNCTION public.is_platform_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_platform_admin(uuid) TO syncrese_app;

/**
 * Every organization, for the key-issuing picker.
 *
 * Returns identity and licence state only — no financial data, no contacts.
 * Guarded by the admin check INSIDE the function, so this is safe to grant to
 * the application role.
 */
CREATE OR REPLACE FUNCTION public.platform_organizations(p_user_id uuid)
RETURNS TABLE (
  organization_id uuid,
  name            text,
  slug            text,
  plan            text,
  status          text,
  seat_count      integer,
  valid_until     timestamptz,
  seats_in_use    integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT o.id, o.name, o.slug, l.plan, l.status, l.seat_count, l.valid_until,
         (SELECT count(*)::int FROM memberships m
           WHERE m.organization_id = o.id AND m.status = 'active')
  FROM organizations o
  LEFT JOIN licenses l ON l.organization_id = o.id
  WHERE public.is_platform_admin(p_user_id)
    AND o.deleted_at IS NULL
  ORDER BY o.name
$$;

REVOKE ALL ON FUNCTION public.platform_organizations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_organizations(uuid) TO syncrese_app;

/** Issued keys across every tenant. Metadata only — never the hash. */
CREATE OR REPLACE FUNCTION public.platform_license_keys(p_user_id uuid)
RETURNS TABLE (
  key_id            uuid,
  organization_id   uuid,
  organization_name text,
  key_last4         text,
  status            text,
  plan              text,
  duration_days     integer,
  seat_count        integer,
  issued_at         timestamptz,
  expires_at        timestamptz,
  activated_at      timestamptz,
  revoked_at        timestamptz,
  note              text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.id, k.organization_id, o.name, k.key_last4, k.status, k.plan,
         k.duration_days, k.seat_count, k.issued_at, k.expires_at,
         k.activated_at, k.revoked_at, k.note
  FROM license_keys k
  JOIN organizations o ON o.id = k.organization_id
  WHERE public.is_platform_admin(p_user_id)
  ORDER BY k.issued_at DESC
$$;

REVOKE ALL ON FUNCTION public.platform_license_keys(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_license_keys(uuid) TO syncrese_app;

/**
 * Resolves a product key at activation time.
 *
 * Pre-tenant: the person typing a key may be in a different organization from
 * the one it was issued for, and which tenant it belongs to is what we are
 * resolving. Takes a HASH, never the key.
 */
CREATE OR REPLACE FUNCTION public.resolve_license_key(p_key_hash text)
RETURNS TABLE (
  key_id          uuid,
  organization_id uuid,
  license_id      uuid,
  status          text,
  plan            text,
  duration_days   integer,
  seat_count      integer,
  expired         boolean,
  activated       boolean,
  revoked         boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.id, k.organization_id, k.license_id, k.status, k.plan,
         k.duration_days, k.seat_count,
         (k.expires_at IS NOT NULL AND k.expires_at < now()),
         (k.activated_at IS NOT NULL),
         (k.revoked_at IS NOT NULL)
  FROM license_keys k
  WHERE k.key_hash = p_key_hash
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.resolve_license_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_license_key(text) TO syncrese_app;
