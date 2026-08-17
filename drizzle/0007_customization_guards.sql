-- ---------------------------------------------------------------------------
-- Syncrese — customization guards: custom fields, saved views, tags, workflows.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'custom_field_defs', 'saved_views', 'tags', 'taggings',
    'workflow_rules', 'workflow_runs'
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
-- Custom-field values are queried by key, so the jsonb columns need GIN
-- indexes. Without them, "customers whose industry is manufacturing" becomes a
-- sequential scan of every row in the tenant.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS business_partners_custom_fields_idx
  ON public.business_partners USING gin (custom_fields jsonb_path_ops);
CREATE INDEX IF NOT EXISTS products_custom_fields_idx
  ON public.products USING gin (custom_fields jsonb_path_ops);
CREATE INDEX IF NOT EXISTS deals_custom_fields_idx
  ON public.deals USING gin (custom_fields jsonb_path_ops);
CREATE INDEX IF NOT EXISTS invoices_custom_fields_idx
  ON public.invoices USING gin (custom_fields jsonb_path_ops);
CREATE INDEX IF NOT EXISTS sales_orders_custom_fields_idx
  ON public.sales_orders USING gin (custom_fields jsonb_path_ops);

-- ===========================================================================
-- A custom field's KEY is immutable.
--
-- Values are stored under that key in each record's jsonb. Renaming the
-- definition would orphan every value already written — the field would appear
-- empty on every existing record, silently, with the data still present but
-- unreachable. Changing the label is fine; changing the key is not.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.block_custom_field_key_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.key <> OLD.key THEN
    RAISE EXCEPTION 'SYNC_FIELD_KEY_IMMUTABLE (% cannot be renamed to %; archive it and add a new field)',
      OLD.key, NEW.key USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.entity_type <> OLD.entity_type THEN
    RAISE EXCEPTION 'SYNC_FIELD_ENTITY_IMMUTABLE (% cannot move between entity types)', OLD.key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS custom_field_defs_key_immutable ON public.custom_field_defs;
CREATE TRIGGER custom_field_defs_key_immutable
  BEFORE UPDATE ON public.custom_field_defs
  FOR EACH ROW EXECUTE FUNCTION public.block_custom_field_key_change();

-- ===========================================================================
-- At most one default saved view per (user, module).
-- ===========================================================================

CREATE UNIQUE INDEX IF NOT EXISTS saved_views_one_default_uq
  ON public.saved_views (organization_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), module)
  WHERE is_default;

-- ===========================================================================
-- Workflow runs are append-only history.
--
-- "Why did this customer receive a reminder?" is unanswerable if the run log
-- can be edited, and automation nobody can explain is automation nobody trusts.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.block_workflow_run_rewrite() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- A run may be completed (pending -> outcome) but never re-opened or edited
  -- after it has finished.
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'SYNC_APPEND_ONLY: a finished workflow run cannot be % ed', lower(TG_OP)
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SYNC_APPEND_ONLY: workflow runs cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS workflow_runs_append_only ON public.workflow_runs;
CREATE TRIGGER workflow_runs_append_only
  BEFORE UPDATE OR DELETE ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.block_workflow_run_rewrite();

-- ===========================================================================
-- Global search support.
--
-- Trigram indexes rather than tsvector: ERP search is dominated by partial
-- identifiers and company names ("vogel", "INV-004", "DE811"), which a
-- word-stemming full-text index handles poorly and a trigram index handles
-- well.
--
-- Created only where pg_trgm exists. It ships with managed Postgres (Neon,
-- Supabase, RDS) but NOT with the embedded PGlite build used for local
-- development and tests. These indexes are purely an optimisation — the search
-- queries use ILIKE and return identical results without them — so the schema
-- must not become undeployable on a Postgres that lacks the extension.
-- ===========================================================================

DO $$
DECLARE
  spec text;
  index_specs text[] := ARRAY[
    'business_partners_name_trgm_idx ON public.business_partners USING gin (lower(name) gin_trgm_ops)',
    'products_name_trgm_idx ON public.products USING gin (lower(name) gin_trgm_ops)',
    'products_sku_trgm_idx ON public.products USING gin (lower(sku) gin_trgm_ops)',
    'invoices_no_trgm_idx ON public.invoices USING gin (lower(invoice_no) gin_trgm_ops)',
    'sales_orders_no_trgm_idx ON public.sales_orders USING gin (lower(order_no) gin_trgm_ops)',
    'purchase_orders_no_trgm_idx ON public.purchase_orders USING gin (lower(po_no) gin_trgm_ops)',
    'deals_name_trgm_idx ON public.deals USING gin (lower(name) gin_trgm_ops)'
  ];
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable — global search will work without trigram indexes';
    RETURN;
  END;

  FOREACH spec IN ARRAY index_specs LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %s', spec);
  END LOOP;
END $$;
