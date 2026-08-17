-- ---------------------------------------------------------------------------
-- Syncrese — API layer guards: keys, outbox, webhook endpoints and deliveries.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'api_keys', 'events', 'webhook_endpoints', 'webhook_deliveries'
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO syncrese_app', t);
  END LOOP;
END $$;

-- ===========================================================================
-- API key authentication is PRE-TENANT.
--
-- A request arrives carrying only a bearer token; which organization it belongs
-- to is precisely what we are trying to determine, so the RLS policy above
-- would filter the lookup to zero rows. This is the same shape as
-- `user_organizations` for sign-in: one small, reviewable SECURITY DEFINER
-- function rather than weakening the policy.
--
-- It takes a HASH, never a plaintext key, and returns only what the caller
-- needs to build a request context.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_api_key(p_key_hash text)
RETURNS TABLE (
  api_key_id      uuid,
  organization_id uuid,
  scopes          text[],
  rate_limit      int,
  revoked         boolean,
  expired         boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    k.id,
    k.organization_id,
    k.scopes,
    k.rate_limit_per_minute,
    (k.revoked_at IS NOT NULL),
    (k.expires_at IS NOT NULL AND k.expires_at < now())
  FROM api_keys k
  WHERE k.key_hash = p_key_hash
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_api_key(text) TO syncrese_app;

-- ===========================================================================
-- Fixed-window rate limiting, counted in the database.
--
-- An in-process counter would be per-instance: two app servers would each
-- allow the full quota, and a restart would reset it. Doing the increment and
-- the check in one atomic statement also removes the read-then-write race that
-- lets a burst slip through.
--
-- Returns the request count within the current window; the caller rejects when
-- it exceeds the limit.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.consume_rate_limit(p_key_id uuid)
RETURNS TABLE (allowed boolean, used int, limit_per_minute int, resets_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now      timestamptz := now();
  v_start    timestamptz;
  v_count    int;
  v_limit    int;
BEGIN
  UPDATE api_keys k
     SET window_started_at = CASE
           WHEN k.window_started_at IS NULL OR k.window_started_at < v_now - interval '1 minute'
             THEN v_now
           ELSE k.window_started_at
         END,
         window_count = CASE
           WHEN k.window_started_at IS NULL OR k.window_started_at < v_now - interval '1 minute'
             THEN 1
           ELSE k.window_count + 1
         END,
         last_used_at = v_now
   WHERE k.id = p_key_id
  RETURNING k.window_started_at, k.window_count, k.rate_limit_per_minute
       INTO v_start, v_count, v_limit;

  IF v_start IS NULL THEN
    RETURN QUERY SELECT false, 0, 0, v_now;
    RETURN;
  END IF;

  RETURN QUERY SELECT (v_count <= v_limit), v_count, v_limit, v_start + interval '1 minute';
END $$;

REVOKE ALL ON FUNCTION public.consume_rate_limit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(uuid) TO syncrese_app;

-- ===========================================================================
-- The outbox is append-only history.
--
-- An event records that something happened. Editing one after the fact would
-- let a delivered webhook disagree with the event that produced it, and there
-- would be no way to tell which was true. Marking an event dispatched is the
-- one permitted update.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.block_event_rewrite() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SYNC_APPEND_ONLY: events cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.type          IS DISTINCT FROM OLD.type
     OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id   IS DISTINCT FROM OLD.entity_id
     OR NEW.payload     IS DISTINCT FROM OLD.payload
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
  THEN
    RAISE EXCEPTION 'SYNC_APPEND_ONLY: an event cannot be rewritten (only dispatched_at may change)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS events_append_only ON public.events;
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.block_event_rewrite();

REVOKE DELETE ON public.events FROM syncrese_app;
