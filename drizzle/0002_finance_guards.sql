-- ---------------------------------------------------------------------------
-- Syncrese — finance guards.
--
-- The double-entry ledger's correctness is enforced by the DATABASE. Not by the
-- posting service, not by validation in a route handler. A service can be
-- bypassed by a script, a background job, a data fix run at 2am, or the next
-- feature someone writes without reading the posting engine. A trigger cannot.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Row level security for the finance tables
-- ===========================================================================

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'accounts',
    'fiscal_periods',
    'tax_rates',
    'journal_entries',
    'journal_lines',
    'document_sequences',
    'business_partners',
    'partner_addresses',
    'partner_contacts',
    'invoices',
    'invoice_lines',
    'bank_accounts',
    'payments',
    'payment_allocations',
    'bank_import_batches',
    'bank_transactions'
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
  END LOOP;
END $$;

-- exchange_rates: organization_id NULL means a shared system feed rate, which
-- every tenant may read. A tenant's own contractual rate overrides it and stays
-- private. Same shape as `roles`.
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.exchange_rates;
CREATE POLICY tenant_isolation ON public.exchange_rates
  USING (organization_id IS NULL OR organization_id = public.current_org_id())
  WITH CHECK (organization_id = public.current_org_id());

-- ===========================================================================
-- 2. GUARANTEE 1 — entries balance
-- ===========================================================================
-- DEFERRABLE INITIALLY DEFERRED so the check runs at COMMIT, not per statement.
-- Lines are inserted one at a time; an entry is only ever unbalanced *during*
-- the transaction that builds it. A per-statement check would make it
-- impossible to write a two-sided entry at all.
--
-- Only the BASE currency is required to balance. Settling a EUR payable from a
-- USD bank account deliberately does NOT balance in either transaction
-- currency — the difference is the FX gain or loss, and requiring per-currency
-- balance would make correct multi-currency entries unpostable.

CREATE OR REPLACE FUNCTION public.assert_entry_balanced() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  eid uuid;
  total_debit  bigint;
  total_credit bigint;
  line_count   int;
BEGIN
  eid := coalesce(NEW.journal_entry_id, OLD.journal_entry_id);

  -- The entry itself may have been deleted in this transaction (cascade); there
  -- is then nothing left to balance.
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = eid) THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(base_debit_minor), 0),
         coalesce(sum(base_credit_minor), 0),
         count(*)
    INTO total_debit, total_credit, line_count
    FROM journal_lines
   WHERE journal_entry_id = eid;

  -- A single-sided entry balances trivially at zero but is meaningless.
  IF line_count < 2 THEN
    RAISE EXCEPTION 'SYNC_UNBALANCED_ENTRY (entry has % line(s); at least 2 required)', line_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'SYNC_UNBALANCED_ENTRY (debits % vs credits %)', total_debit, total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS journal_lines_balanced ON public.journal_lines;
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_entry_balanced();

-- ===========================================================================
-- 3. GUARANTEE 2 — posted entries are immutable
-- ===========================================================================
-- Corrections are made by posting a REVERSING entry, never by editing history.
-- This is what auditors expect and what makes the ledger evidence rather than
-- an opinion.
--
-- Exactly one transition is permitted on a posted entry: marking it reversed
-- and recording which entry reversed it. Every other column must be unchanged.

CREATE OR REPLACE FUNCTION public.block_posted_entry_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('posted', 'reversed') THEN
      RAISE EXCEPTION 'SYNC_POSTED_IMMUTABLE (entry % is posted and cannot be deleted)', OLD.entry_no
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('posted', 'reversed') THEN
    IF OLD.status = 'posted'
       AND NEW.status = 'reversed'
       AND NEW.organization_id = OLD.organization_id
       AND NEW.entry_no        = OLD.entry_no
       AND NEW.entry_date      = OLD.entry_date
       AND NEW.source_type     = OLD.source_type
       AND NEW.fiscal_period_id IS NOT DISTINCT FROM OLD.fiscal_period_id
       AND NEW.description     IS NOT DISTINCT FROM OLD.description
       AND NEW.posted_at       IS NOT DISTINCT FROM OLD.posted_at
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'SYNC_POSTED_IMMUTABLE (entry % is posted; post a reversing entry instead)', OLD.entry_no
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_entries_immutable ON public.journal_entries;
CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.block_posted_entry_change();

-- Lines of a posted entry are equally immutable. Without this, history could be
-- rewritten by editing the lines while leaving the header untouched.
CREATE OR REPLACE FUNCTION public.block_posted_line_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  entry_status text;
  eid uuid;
BEGIN
  eid := coalesce(NEW.journal_entry_id, OLD.journal_entry_id);
  SELECT status INTO entry_status FROM journal_entries WHERE id = eid;

  -- Entry already gone (cascade from a draft deletion).
  IF entry_status IS NULL THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  IF entry_status <> 'draft' THEN
    RAISE EXCEPTION 'SYNC_POSTED_IMMUTABLE (cannot % a line on a % entry)',
      lower(TG_OP), entry_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN coalesce(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS journal_lines_immutable ON public.journal_lines;
CREATE TRIGGER journal_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.block_posted_line_change();

-- ===========================================================================
-- 4. GUARANTEE 3 — closed periods stay closed
-- ===========================================================================
-- A filed VAT return or a signed-off year must not move underneath the filing.

CREATE OR REPLACE FUNCTION public.assert_period_open() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  period_status text;
BEGIN
  IF NEW.status <> 'posted' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    RETURN NEW;
  END IF;

  SELECT fp.status INTO period_status
    FROM fiscal_periods fp
   WHERE fp.organization_id = NEW.organization_id
     AND NEW.entry_date BETWEEN fp.starts_on AND fp.ends_on
   LIMIT 1;

  -- No period defined for the date is allowed: a tenant that has not set up a
  -- fiscal calendar can still keep books. Only an explicitly closed period
  -- blocks.
  IF period_status IN ('closed', 'locked') THEN
    RAISE EXCEPTION 'SYNC_PERIOD_CLOSED (% falls in a % period)', NEW.entry_date, period_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_entries_period_open ON public.journal_entries;
CREATE TRIGGER journal_entries_period_open
  BEFORE INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.assert_period_open();

-- ===========================================================================
-- 5. Postings only hit postable accounts
-- ===========================================================================
-- Header accounts group their children; posting to one makes the account tree
-- lie about where money is.

CREATE OR REPLACE FUNCTION public.assert_account_postable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  postable boolean;
  archived timestamptz;
  acct_code text;
BEGIN
  SELECT a.is_postable, a.archived_at, a.code
    INTO postable, archived, acct_code
    FROM accounts a WHERE a.id = NEW.account_id;

  IF postable IS NULL THEN
    RAISE EXCEPTION 'SYNC_ACCOUNT_NOT_FOUND' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT postable THEN
    RAISE EXCEPTION 'SYNC_ACCOUNT_NOT_POSTABLE (% is a header account)', acct_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'SYNC_ACCOUNT_ARCHIVED (%)', acct_code USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS journal_lines_postable_account ON public.journal_lines;
CREATE TRIGGER journal_lines_postable_account
  BEFORE INSERT OR UPDATE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.assert_account_postable();

-- ===========================================================================
-- 6. Gap-free document numbering
-- ===========================================================================
-- A Postgres sequence would be wrong here: sequences deliberately leak numbers
-- on rollback, and many jurisdictions require invoice numbering to be
-- gap-free. FOR UPDATE serialises concurrent allocation instead.

CREATE OR REPLACE FUNCTION public.next_sequence_value(p_org uuid, p_key text)
RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_next int;
BEGIN
  UPDATE document_sequences
     SET next_value = next_value + 1
   WHERE organization_id = p_org AND sequence_key = p_key
  RETURNING next_value - 1 INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'SYNC_SEQUENCE_MISSING (%)', p_key USING ERRCODE = 'check_violation';
  END IF;

  RETURN v_next;
END $$;

CREATE OR REPLACE FUNCTION public.next_document_number(p_org uuid, p_key text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_next    int;
  v_prefix  text;
  v_padding smallint;
BEGIN
  v_next := public.next_sequence_value(p_org, p_key);

  SELECT prefix, padding INTO v_prefix, v_padding
    FROM document_sequences
   WHERE organization_id = p_org AND sequence_key = p_key;

  RETURN v_prefix || lpad(v_next::text, v_padding, '0');
END $$;

GRANT EXECUTE ON FUNCTION public.next_sequence_value(uuid, text)  TO syncrese_app;
GRANT EXECUTE ON FUNCTION public.next_document_number(uuid, text) TO syncrese_app;

-- ===========================================================================
-- 7. Grants
-- ===========================================================================

DO $$
DECLARE
  t text;
  rw_tables text[] := ARRAY[
    'currencies', 'exchange_rates', 'accounts', 'fiscal_periods', 'tax_rates',
    'journal_entries', 'journal_lines', 'document_sequences',
    'business_partners', 'partner_addresses', 'partner_contacts',
    'invoices', 'invoice_lines', 'bank_accounts',
    'payments', 'payment_allocations',
    'bank_import_batches', 'bank_transactions'
  ];
BEGIN
  FOREACH t IN ARRAY rw_tables LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO syncrese_app', t);
  END LOOP;
END $$;

-- updated_at triggers for the tables added in this migration.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.attname = 'updated_at' AND NOT a.attisdropped
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_touch_updated_at', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()',
      t || '_touch_updated_at', t);
  END LOOP;
END $$;
