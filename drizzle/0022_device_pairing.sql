-- ---------------------------------------------------------------------------
-- Syncrese — pairing a desktop installation to a workspace.
--
-- WHY A PAIRING CODE AND NOT THE PRODUCT KEY
--
-- The desktop app is a shell around a webview pointing at the customer's own
-- instance. That webview is granted NO Tauri IPC — it cannot be, because
-- capabilities are static build-time configuration and a customer's instance
-- URL is only known at runtime. So the signed-in page has no way to hand the
-- native shell anything, and the shell has no way to read the session.
--
-- The obvious workaround is to have the shell POST the product key to an
-- unauthenticated endpoint. That is worse than it looks: it turns the product
-- key into a bearer credential travelling from every installation, and it needs
-- its own throttle or it becomes an oracle for guessing keys.
--
-- Instead the signed-in user asks the web UI for a short-lived pairing code and
-- types it into the desktop app. The code is single-use, expires in ten minutes,
-- and grants exactly one thing: a row in `device_activations` saying this
-- machine exists. It is NOT a credential — the user still signs in normally in
-- the webview afterwards, and every request is still authorised by that session.
--
-- WHAT DEVICE REGISTRATION IS AND IS NOT FOR
--
-- It answers "which machines is our ERP installed on" and "revoke the laptop
-- that was stolen". It is NOT the licence authority: the server already gates
-- every write on licence state through the session, and a desktop client that
-- lied about its fingerprint would gain nothing, because the fingerprint
-- authorises nothing. Stated here because the temptation to make the client
-- authoritative is exactly what the requirement warns against.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.device_pairing_codes (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  /**
   * Hashed, never stored in the clear.
   *
   * Short-lived and single-use, but it is still a secret typed by a human, and
   * a database backup should not contain a list of live ones. Peppered through
   * the same helper as API keys and product keys.
   */
  code_hash       text NOT NULL UNIQUE,
  /** The first few characters, so the issuing screen can show which code it
   *  is looking at without being able to reconstruct it. */
  code_prefix     text NOT NULL,

  issued_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  consumed_device uuid,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_pairing_codes_org_idx
  ON public.device_pairing_codes (organization_id, created_at DESC);

ALTER TABLE public.device_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_pairing_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.device_pairing_codes;
CREATE POLICY tenant_isolation ON public.device_pairing_codes
  USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_pairing_codes TO syncrese_app;

-- ===========================================================================
-- Redeeming a code
-- ===========================================================================
-- Pre-tenant by nature: the desktop app has no session and does not yet know
-- which organization it belongs to — finding that out is the point. So this is
-- a SECURITY DEFINER function, like every other pre-tenant lookup here.
--
-- It does the whole exchange in one statement so a code cannot be redeemed
-- twice by two racing callers: the UPDATE ... WHERE consumed_at IS NULL is the
-- lock, and a loser gets no row rather than a second device.
--
-- It returns the organization id and nothing else. Not the name, not the plan,
-- not the seat count — a redeemed code should not be a way to enumerate
-- anything about the workspace beyond the fact that pairing succeeded.

CREATE OR REPLACE FUNCTION public.redeem_device_pairing_code(
  p_code_hash         text,
  p_device_id         uuid,
  p_fingerprint_hash  text,
  p_platform          text,
  p_app_version       text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org uuid;
BEGIN
  UPDATE device_pairing_codes
     SET consumed_at = now(), consumed_device = p_device_id
   WHERE code_hash = p_code_hash
     AND consumed_at IS NULL
     AND expires_at > now()
  RETURNING organization_id INTO v_org;

  IF v_org IS NULL THEN
    RETURN NULL;
  END IF;

  -- Re-pairing the same machine updates the existing row rather than
  -- accumulating one per reinstall. The fingerprint is an identifier, not an
  -- authenticator: two machines that collide would merge, which costs a line in
  -- a list, whereas treating it as a secret would be a real mistake.
  INSERT INTO device_activations
    (id, organization_id, device_fingerprint_hash, platform, app_version)
  VALUES (p_device_id, v_org, p_fingerprint_hash, p_platform, p_app_version)
  ON CONFLICT (organization_id, device_fingerprint_hash) DO UPDATE
    SET last_seen_at = now(),
        platform     = excluded.platform,
        app_version  = excluded.app_version,
        revoked_at   = NULL;

  RETURN v_org;
END $$;

REVOKE ALL ON FUNCTION public.redeem_device_pairing_code(text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_device_pairing_code(text, uuid, text, text, text)
  TO syncrese_app;

-- One activation per machine per workspace, which the upsert above depends on.
CREATE UNIQUE INDEX IF NOT EXISTS device_activations_org_fingerprint_uq
  ON public.device_activations (organization_id, device_fingerprint_hash);

-- ===========================================================================
-- Heartbeat
-- ===========================================================================
-- The desktop app calls this on launch. It reports liveness and asks one
-- question: am I still allowed to run? An administrator who revokes a stolen
-- laptop needs that to take effect without the thief cooperating.
--
-- Returns false for a revoked or unknown device. It deliberately does NOT
-- distinguish the two: a caller probing device ids should not learn which ones
-- exist.

CREATE OR REPLACE FUNCTION public.touch_device_activation(
  p_device_id  uuid,
  p_app_version text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  ok boolean;
BEGIN
  UPDATE device_activations
     SET last_seen_at = now(),
         app_version  = coalesce(p_app_version, app_version)
   WHERE id = p_device_id
     AND revoked_at IS NULL
  RETURNING true INTO ok;

  RETURN coalesce(ok, false);
END $$;

REVOKE ALL ON FUNCTION public.touch_device_activation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_device_activation(uuid, text) TO syncrese_app;

-- Migration 0019's treatment for the two functions and the new table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_definer') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_pairing_codes TO syncrese_definer;
    DROP POLICY IF EXISTS definer_access ON public.device_pairing_codes;
    CREATE POLICY definer_access ON public.device_pairing_codes
      TO syncrese_definer USING (true) WITH CHECK (true);

    GRANT CREATE ON SCHEMA public TO syncrese_definer;
    ALTER FUNCTION public.redeem_device_pairing_code(text, uuid, text, text, text)
      OWNER TO syncrese_definer;
    ALTER FUNCTION public.touch_device_activation(uuid, text) OWNER TO syncrese_definer;
    REVOKE CREATE ON SCHEMA public FROM syncrese_definer;
  END IF;
END $$;
