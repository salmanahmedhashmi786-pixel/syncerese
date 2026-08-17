-- ---------------------------------------------------------------------------
-- Syncrese — pruning the event outbox.
--
-- THE PROBLEM
--
-- `events` is append-only: drizzle/0009 puts a BEFORE UPDATE OR DELETE trigger
-- on it that raises unconditionally, and the application role has no DELETE
-- grant. That is right — an event records that something happened, and a
-- delivered webhook must never be able to disagree with the event that produced
-- it — but it also means the table grows for ever. On a busy workspace it
-- becomes the largest thing in the database, holding rows whose only remaining
-- purpose was to be dispatched, and which were dispatched months ago.
--
-- THE FIX, AND WHAT IT DELIBERATELY DOES NOT LOOSEN
--
-- The trigger still refuses every DELETE, with one exception: a transaction that
-- has set `app.prune_outbox` to 'on'. That flag is set inside the SECURITY
-- DEFINER function below and nowhere else, and it is transaction-local, so it
-- cannot leak into the next statement on a pooled connection.
--
-- The application role STILL has no DELETE grant on `events`, so both barriers
-- would have to fail together. Application code cannot delete an event whether
-- or not it sets the flag; the flag only distinguishes the sanctioned prune
-- path from a bug inside the definer role itself.
--
-- Nothing about UPDATE changes. An event still cannot be rewritten.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.block_event_rewrite() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The one sanctioned path: prune_outbox_events() sets this transaction-local
    -- flag immediately before deleting and it expires with the transaction.
    IF coalesce(current_setting('app.prune_outbox', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
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

/**
 * Removes dispatched events that nothing is still waiting on.
 *
 * THREE CONDITIONS, and each one is a way this goes wrong without it:
 *
 *   1. DISPATCHED. An event the fan-out has not processed is still owed to
 *      somebody's webhook endpoint.
 *
 *   2. NO DELIVERY STILL PENDING OR FAILED. `webhook_deliveries.event_id`
 *      cascades, so deleting an event would silently drop a retry that was
 *      still owed — a customer's webhook would simply never arrive, with no
 *      error anywhere.
 *
 *   3. BEHIND EVERY ENABLED CHAT INTEGRATION'S CURSOR. Slack and Teams delivery
 *      reads forward through this table; deleting rows in front of a cursor
 *      makes those messages vanish without ever being sent.
 *
 * The floor is enforced here rather than only in TypeScript, because this
 * function is reachable by anything holding the app role and a limit that lives
 * only in the application is one the next caller forgets.
 *
 * Note that the cascade is intentional for SUCCEEDED and ABANDONED deliveries:
 * they are the same generation of operational data as the event itself, and
 * keeping a delivery record whose event has gone would leave a row referring to
 * something nobody can look up.
 */
CREATE OR REPLACE FUNCTION public.prune_outbox_events(
  p_organization_id uuid,
  p_older_than_days integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  IF p_older_than_days IS NULL OR p_older_than_days < 7 THEN
    RAISE EXCEPTION 'Outbox retention cannot be shorter than 7 days (got %)',
      p_older_than_days USING ERRCODE = 'check_violation';
  END IF;

  -- Transaction-local: the third argument to set_config. It expires when this
  -- transaction ends, so it cannot survive into the next statement served by a
  -- pooled connection.
  PERFORM set_config('app.prune_outbox', 'on', true);

  DELETE FROM events e
   WHERE e.organization_id = p_organization_id
     AND e.dispatched_at IS NOT NULL
     AND e.occurred_at < now() - make_interval(days => p_older_than_days)
     AND NOT EXISTS (
       SELECT 1 FROM webhook_deliveries d
        WHERE d.event_id = e.id AND d.status IN ('pending', 'failed')
     )
     AND NOT EXISTS (
       SELECT 1 FROM chat_integrations i
        WHERE i.organization_id = e.organization_id
          AND i.enabled
          AND (
            i.cursor_at IS NULL
            OR e.occurred_at > i.cursor_at
            OR (e.occurred_at = i.cursor_at AND e.id > i.cursor_event_id)
          )
     );

  GET DIAGNOSTICS removed = ROW_COUNT;

  -- Cleared explicitly rather than left to transaction end, so a caller that
  -- goes on to do other work in the same transaction cannot delete an event by
  -- accident.
  PERFORM set_config('app.prune_outbox', 'off', true);

  RETURN removed;
END $$;

REVOKE ALL ON FUNCTION public.prune_outbox_events(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_outbox_events(uuid, integer) TO syncrese_app;

/** Counts what a prune would remove, without removing it — the same predicate,
 *  so the preview cannot disagree with the sweep. */
CREATE OR REPLACE FUNCTION public.count_prunable_events(
  p_organization_id uuid,
  p_older_than_days integer
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int
    FROM events e
   WHERE e.organization_id = p_organization_id
     AND e.dispatched_at IS NOT NULL
     AND e.occurred_at < now() - make_interval(days => p_older_than_days)
     AND NOT EXISTS (
       SELECT 1 FROM webhook_deliveries d
        WHERE d.event_id = e.id AND d.status IN ('pending', 'failed')
     )
     AND NOT EXISTS (
       SELECT 1 FROM chat_integrations i
        WHERE i.organization_id = e.organization_id
          AND i.enabled
          AND (
            i.cursor_at IS NULL
            OR e.occurred_at > i.cursor_at
            OR (e.occurred_at = i.cursor_at AND e.id > i.cursor_event_id)
          )
     )
$$;

REVOKE ALL ON FUNCTION public.count_prunable_events(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_prunable_events(uuid, integer) TO syncrese_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_definer') THEN
    GRANT CREATE ON SCHEMA public TO syncrese_definer;
    ALTER FUNCTION public.prune_outbox_events(uuid, integer) OWNER TO syncrese_definer;
    ALTER FUNCTION public.count_prunable_events(uuid, integer) OWNER TO syncrese_definer;
    REVOKE CREATE ON SCHEMA public FROM syncrese_definer;
  END IF;
END $$;
