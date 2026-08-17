-- ---------------------------------------------------------------------------
-- Syncrese — Stripe billing.
--
-- Billing lives on the WEB, never inside the desktop app (MUST DO #16): the app
-- consumes a licence, it never takes a card. Stripe holds the payment
-- instrument, the subscription and the prices; this schema holds only the
-- references needed to tie a Stripe subscription to a tenant's licence.
--
-- Nothing here is trusted from a client. The licence is changed by the webhook
-- handler acting on Stripe's signed events, never by the browser reporting what
-- it thinks it bought.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Stripe references on the licence
-- ===========================================================================

ALTER TABLE public.licenses
  ADD COLUMN IF NOT EXISTS stripe_customer_id     text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  -- When the current paid period ends. Distinct from valid_until, which is what
  -- ACCESS is judged against — they differ during the grace window after a
  -- failed payment.
  ADD COLUMN IF NOT EXISTS current_period_end     timestamptz,
  -- Cancelled but still paid up. The tenant keeps full access until the period
  -- ends; showing them as already cancelled would be wrong and alarming.
  ADD COLUMN IF NOT EXISTS cancel_at_period_end   boolean NOT NULL DEFAULT false;

-- One Stripe customer and one subscription may back only one tenant. Without
-- this, a mis-routed webhook could quietly point two organizations at the same
-- subscription and both would be billed once for two sets of seats.
CREATE UNIQUE INDEX IF NOT EXISTS licenses_stripe_customer_uq
  ON public.licenses (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS licenses_stripe_subscription_uq
  ON public.licenses (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- ===========================================================================
-- 2. Webhook idempotency
-- ===========================================================================
-- Stripe guarantees AT LEAST ONCE delivery, retries for days on any non-2xx,
-- and does not guarantee order. A handler that applies an event twice can
-- double a seat count; one that applies a stale event can resurrect a cancelled
-- subscription.
--
-- This table is the record of what has already been applied. The PRIMARY KEY on
-- the Stripe event id is the actual mechanism: a duplicate insert conflicts,
-- and the handler answers 200 without doing the work again.
--
-- NOT tenant-scoped: an event arrives before we know which tenant it belongs to
-- — that is what the handler resolves — and some events never map to one.

CREATE TABLE IF NOT EXISTS public.billing_events (
  stripe_event_id text PRIMARY KEY,
  type            text        NOT NULL,
  organization_id uuid        REFERENCES public.organizations(id) ON DELETE SET NULL,
  -- Stripe's own creation time, not ours. Used to discard an event that arrives
  -- after a newer one has already been applied.
  event_created   timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS billing_events_org_idx
  ON public.billing_events (organization_id, event_created DESC);

-- Reached only through the SECURITY DEFINER functions below — nothing is
-- granted to syncrese_app, so the application can neither read other tenants'
-- billing payloads nor clear its own idempotency record.
--
-- The policy is belt and braces on top of that. It carries organization_id, and
-- the rule in this codebase is that ANY table carrying that column is tenant
-- isolated; tests/rls-coverage enforces it and caught this table when it was
-- first written without one. Relying on "we never granted it" would be one
-- forgotten GRANT away from a cross-tenant read.
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.billing_events;
CREATE POLICY tenant_isolation ON public.billing_events
  USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

/**
 * Claims a Stripe event.
 *
 * Returns true when this call is the first to see it and the caller should do
 * the work; false when it has already been applied and the caller should just
 * answer 200.
 *
 * ON CONFLICT DO NOTHING rather than a SELECT-then-INSERT: two concurrent
 * deliveries of the same event would both pass the SELECT and both do the work.
 */
CREATE OR REPLACE FUNCTION public.claim_billing_event(
  p_event_id text,
  p_type     text,
  p_created  timestamptz,
  p_payload  jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_claimed boolean;
BEGIN
  INSERT INTO billing_events (stripe_event_id, type, event_created, payload)
  VALUES (p_event_id, p_type, p_created, p_payload)
  ON CONFLICT (stripe_event_id) DO NOTHING
  RETURNING true INTO v_claimed;

  RETURN COALESCE(v_claimed, false);
END $$;

REVOKE ALL ON FUNCTION public.claim_billing_event(text, text, timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_billing_event(text, text, timestamptz, jsonb)
  TO syncrese_app;

/** Records which tenant an event turned out to belong to, once resolved. */
CREATE OR REPLACE FUNCTION public.attribute_billing_event(p_event_id text, p_org uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE billing_events SET organization_id = p_org WHERE stripe_event_id = p_event_id
$$;

REVOKE ALL ON FUNCTION public.attribute_billing_event(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attribute_billing_event(text, uuid) TO syncrese_app;

/**
 * Has a NEWER event already been applied to this tenant?
 *
 * Stripe does not guarantee ordering. Without this, a `subscription.updated`
 * that was delayed in the network can land after the `subscription.deleted`
 * that followed it and silently reinstate a cancelled subscription.
 */
CREATE OR REPLACE FUNCTION public.billing_event_is_stale(
  p_org     uuid,
  p_created timestamptz,
  p_event_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM billing_events
    WHERE organization_id = p_org
      AND stripe_event_id <> p_event_id
      AND event_created > p_created
  )
$$;

REVOKE ALL ON FUNCTION public.billing_event_is_stale(uuid, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_event_is_stale(uuid, timestamptz, text) TO syncrese_app;

-- ===========================================================================
-- 3. Resolving a Stripe customer to a tenant is PRE-TENANT
-- ===========================================================================
-- A webhook arrives carrying a Stripe customer id and nothing else. Which
-- organization it belongs to is exactly what we are trying to determine, so the
-- `licenses` tenant policy would filter the lookup to zero rows and every
-- payment event would be silently dropped.
--
-- Same shape as resolve_api_key and resolve_invitation: one narrow function
-- returning only what the handler needs.

CREATE OR REPLACE FUNCTION public.resolve_billing_customer(p_customer_id text)
RETURNS TABLE (organization_id uuid, license_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT l.organization_id, l.id
  FROM licenses l
  WHERE l.stripe_customer_id = p_customer_id
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.resolve_billing_customer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_billing_customer(text) TO syncrese_app;
