-- ---------------------------------------------------------------------------
-- Syncrese — Slack and Microsoft Teams notifications (MUST DO #14).
--
-- INCOMING WEBHOOKS, not OAuth apps.
--
-- Both products let you create a URL that accepts a POST and posts the result
-- into one channel. That needs no OAuth app, no bot token, no app-store review
-- and no client secret in this deployment's configuration — the customer
-- creates the URL in their own workspace and pastes it in. An OAuth
-- integration would be prettier (pick a channel from a dropdown) and would put
-- a Slack app review between this product and its first customer.
--
-- CURSOR, NOT A DELIVERY TABLE.
--
-- Customer webhooks get a row per delivery because each one is a contractual
-- obligation with its own retry schedule. A chat notification is not: if it
-- fails, the right behaviour is to try again on the next tick and keep trying
-- until the URL works or is clearly dead. So each integration remembers how far
-- through the event stream it has got, and a failure simply does not advance
-- it. No row explosion, no backoff table, and nothing is lost across a deploy.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.chat_integrations (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  /** 'slack' or 'teams'. They take different payload shapes. */
  kind            text NOT NULL,
  /** What the customer calls it — "#finance", "Ops channel". */
  name            text NOT NULL,

  /**
   * The incoming-webhook URL, ENCRYPTED.
   *
   * Anyone holding it can post into the customer's channel as though they were
   * us, so it is a credential and gets the same treatment as a webhook signing
   * secret and a TOTP secret. `url_hint` is the host plus a few characters, so
   * the UI can show which one this is without revealing it.
   */
  target_url_encrypted text NOT NULL,
  url_hint             text NOT NULL,

  /** Event types to post. '*' means everything. */
  events          text[] NOT NULL DEFAULT '{}'::text[],

  enabled         boolean     NOT NULL DEFAULT true,

  /**
   * How far through this organization's event stream we have got.
   *
   * Ordered by (occurred_at, id) — the id breaks ties, because Postgres `now()`
   * is transaction-start time and several events emitted in one transaction
   * share a timestamp exactly. Ordering on the timestamp alone would silently
   * skip events, which is the same bug the team chat had.
   */
  cursor_at       timestamptz,
  cursor_event_id uuid,

  /** Consecutive failures. Enough of them disables the integration rather than
   *  retrying a dead URL for ever. */
  failure_count   integer     NOT NULL DEFAULT 0,
  last_error      text,
  last_error_at   timestamptz,
  last_success_at timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at      timestamptz,

  CONSTRAINT chat_integrations_kind CHECK (kind IN ('slack', 'teams')),

  -- Both halves of the cursor move together or not at all. Half a cursor makes
  -- the comparison below return NULL for every candidate row, which reads as
  -- "no work" — an integration that goes permanently, silently quiet.
  CONSTRAINT chat_integrations_cursor_whole
    CHECK ((cursor_at IS NULL) = (cursor_event_id IS NULL))
);

CREATE INDEX IF NOT EXISTS chat_integrations_org_idx
  ON public.chat_integrations (organization_id);

-- The dispatch tick asks "which organizations have work?", so the enabled ones
-- need to be findable without scanning every tenant.
CREATE INDEX IF NOT EXISTS chat_integrations_enabled_idx
  ON public.chat_integrations (enabled) WHERE enabled;

ALTER TABLE public.chat_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.chat_integrations;
CREATE POLICY tenant_isolation ON public.chat_integrations
  USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_integrations TO syncrese_app;

/**
 * Which organizations have chat work waiting.
 *
 * Pre-tenant by nature: the dispatch tick runs for the whole installation and
 * has to find the tenants with something to send before it can scope to one.
 * Same shape as the existing webhook dispatch query, and it returns only
 * organization ids — no event content, no URLs.
 */
CREATE OR REPLACE FUNCTION public.organizations_with_chat_work()
RETURNS TABLE (organization_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT i.organization_id
  FROM chat_integrations i
  WHERE i.enabled
    AND EXISTS (
      SELECT 1 FROM events e
      WHERE e.organization_id = i.organization_id
        AND (
          i.cursor_at IS NULL
          OR e.occurred_at > i.cursor_at
          OR (e.occurred_at = i.cursor_at AND e.id > i.cursor_event_id)
        )
    )
$$;

REVOKE ALL ON FUNCTION public.organizations_with_chat_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.organizations_with_chat_work() TO syncrese_app;
