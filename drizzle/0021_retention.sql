-- ---------------------------------------------------------------------------
-- Syncrese — data retention (MUST DO #15, GDPR Art. 5(1)(e)).
--
-- "Kept in a form which permits identification of data subjects for no longer
-- than is necessary." Every other part of the GDPR tooling here answers a
-- REQUEST — a subject asks, the controller responds. Storage limitation is the
-- obligation nobody asks about, which is exactly why it needs a job rather than
-- a button.
--
-- THE TENSION, AND WHICH SIDE WINS
--
-- Statutory accounting retention OVERRIDES an erasure request: §147 AO requires
-- ten years in Germany and every EU member state has an equivalent. GDPR Art.
-- 17(3)(b) carves out processing required for compliance with a legal
-- obligation. That is why erasure PSEUDONYMISES the audit trail rather than
-- deleting it — and it is why this job can never be allowed near a financial
-- record.
--
-- So the expirable categories are a CLOSED LIST in
-- src/gdpr/retention.ts. Invoices, journal entries, payments and the audit log
-- are not on it and there is no configuration that puts them there. A customer
-- who sets every retention period to its minimum still cannot use this feature
-- to breach their own accounting law.
--
-- WHY THE AUDIT LOG IS NOT MERELY OMITTED
--
-- drizzle/0001 puts a BEFORE UPDATE OR DELETE trigger on `audit_log` that
-- raises unconditionally. Not a grant — a trigger, so it binds the owner too.
-- Even a bug in this file cannot prune it. `access_log` has no such trigger but
-- also no DELETE grant to the application role, which is deliberate: it is the
-- "who accessed what" trail for breach reconstruction and application code has
-- no business deleting from it. Pruning it therefore goes through a SECURITY
-- DEFINER function, below, which is the one audited path.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.retention_policies (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  /** A key from the catalogue in src/gdpr/retention.ts. Not a table name: the
   *  mapping from category to statement lives in reviewed code, so nothing
   *  here can name a table the job was never meant to touch. */
  category        text NOT NULL,

  /** Days to keep. NULL means keep indefinitely, which is the default for
   *  every category — this feature does nothing at all until somebody
   *  deliberately turns a category on. A retention job that starts deleting
   *  the moment it ships is a data-loss incident, not a compliance feature. */
  retain_days     integer,

  /**
   * Suspends expiry for this category.
   *
   * Litigation, a tax audit, a regulatory investigation: all of them impose a
   * duty to preserve that outranks storage limitation. Without a switch, the
   * only way to honour that is to remember to turn every policy off one by
   * one, at exactly the moment everyone is busy.
   */
  legal_hold      boolean     NOT NULL DEFAULT false,
  legal_hold_note text,

  /** Gates the sweep to once a day per category, so calling the endpoint more
   *  often than that is harmless rather than expensive. */
  last_swept_at   timestamptz,
  /** What the last sweep removed, for the panel and for answering "what
   *  happened to that record". */
  last_removed    integer,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  updated_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,

  CONSTRAINT retention_policies_days CHECK (retain_days IS NULL OR retain_days >= 1)
);

-- One policy per category per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS retention_policies_org_category_uq
  ON public.retention_policies (organization_id, category);

ALTER TABLE public.retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.retention_policies;
CREATE POLICY tenant_isolation ON public.retention_policies
  USING (organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.retention_policies TO syncrese_app;

-- ===========================================================================
-- Pruning the access log
-- ===========================================================================
-- The application role has SELECT and INSERT on access_log and nothing else,
-- so it cannot do this itself. That restriction is worth keeping: it is what
-- makes "application code cannot quietly erase the access trail" true. The
-- exception is therefore narrow, named, and does exactly one thing.
--
-- Note what it does NOT accept: a table name, a predicate, or an unbounded
-- cutoff. It takes an organization and a number of days, it enforces its own
-- floor, and it returns a count. There is no shape of argument that makes it
-- delete something else.

CREATE OR REPLACE FUNCTION public.prune_access_log(
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
  -- The floor is enforced HERE as well as in the application, because this
  -- function is reachable by anything holding the app role and a floor that
  -- only exists in TypeScript is a floor that a future caller forgets.
  --
  -- Ninety days: GDPR Art. 33 gives 72 hours to REPORT a breach, but
  -- reconstructing one routinely reaches back further, and an access trail
  -- that has already been pruned cannot answer the question the regulator asks.
  IF p_older_than_days IS NULL OR p_older_than_days < 90 THEN
    RAISE EXCEPTION 'Access log retention cannot be shorter than 90 days (got %)',
      p_older_than_days USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM access_log
   WHERE organization_id = p_organization_id
     AND occurred_at < now() - make_interval(days => p_older_than_days);

  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

REVOKE ALL ON FUNCTION public.prune_access_log(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_access_log(uuid, integer) TO syncrese_app;

-- Migration 0019 gave the definer role SELECT and INSERT on the append-only
-- pair — correct then, and this is the one narrow exception to it. DELETE on
-- access_log only; audit_log deliberately keeps its append-only grants AND its
-- trigger.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_definer') THEN
    GRANT DELETE ON public.access_log TO syncrese_definer;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.retention_policies TO syncrese_definer;
    DROP POLICY IF EXISTS definer_access ON public.retention_policies;
    CREATE POLICY definer_access ON public.retention_policies
      TO syncrese_definer USING (true) WITH CHECK (true);
  END IF;
END $$;

-- The function must be owned by the definer role for the same reason as
-- everything else in 0019: FORCE ROW LEVEL SECURITY subjects the owner to the
-- policies, and access_log's policy is tenant-scoped. Guarded so this migration
-- still applies on a database where 0019's role could not be created.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'syncrese_definer') THEN
    GRANT CREATE ON SCHEMA public TO syncrese_definer;
    ALTER FUNCTION public.prune_access_log(uuid, integer) OWNER TO syncrese_definer;
    REVOKE CREATE ON SCHEMA public FROM syncrese_definer;
  END IF;
END $$;
