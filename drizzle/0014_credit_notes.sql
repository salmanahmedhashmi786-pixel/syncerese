-- ---------------------------------------------------------------------------
-- Syncrese — credit notes.
--
-- An issued invoice is immutable: the ledger entry behind it is posted and the
-- document is a legal record. So "I invoiced the wrong amount" has exactly one
-- correct answer — issue a credit note — and until now the product had no way
-- to do that. The schema already anticipated it (`document_type_code` 381,
-- status 'credited'); this is the rest.
--
-- A credit note is an INVOICE ROW, not a separate table. It has lines, tax,
-- a partner, a currency, a ledger entry and a document number, and every report
-- that walks invoices must see it. A parallel table would mean two of
-- everything and one of them would drift.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Columns
-- ===========================================================================

-- Which invoice this credit note credits. Null on ordinary invoices.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS credits_invoice_id uuid
    REFERENCES public.invoices(id) ON DELETE RESTRICT;

-- How much of THIS invoice has been credited away. Outstanding is
-- total - paid - credited; leaving credits out of that is how a fully credited
-- invoice keeps appearing on an aging report and in a dunning run.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS credited_minor bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS invoices_credits_idx
  ON public.invoices (organization_id, credits_invoice_id)
  WHERE credits_invoice_id IS NOT NULL;

-- ===========================================================================
-- 2. Constraints
-- ===========================================================================

DO $$
BEGIN
  -- You cannot credit away more than you invoiced. Note this is NOT
  -- `credited + paid <= total`: an invoice that was paid in full and is then
  -- credited in full is a refund owed to the customer, which is a real
  -- situation and must remain expressible.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_credited_within_total'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_credited_within_total
      CHECK (credited_minor >= 0 AND credited_minor <= total_minor);
  END IF;

  -- UNTDID 1001. The column had a default but nothing stopped a typo, and a
  -- document type the posting code does not recognise would post with the
  -- wrong sign.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_document_type_code'
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_document_type_code
      CHECK (document_type_code IN ('380', '381'));
  END IF;
END $$;

-- ===========================================================================
-- 3. A credit note must credit something creditable
-- ===========================================================================
-- Cross-row, so a CHECK cannot express it.
--
-- The cases this stops are all quiet ones: a credit note against another credit
-- note (which would post a second reversal and double the correction), against
-- another tenant's invoice, against a different customer (crediting Alice's
-- balance for Bob's invoice), or in a different currency (where the amounts
-- would be arithmetically meaningless against each other).

CREATE OR REPLACE FUNCTION public.enforce_credit_note_link() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  src RECORD;
BEGIN
  IF NEW.document_type_code = '380' THEN
    IF NEW.credits_invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'SYNC_CREDIT_LINK (an ordinary invoice cannot credit another document)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.credits_invoice_id IS NULL THEN
    RAISE EXCEPTION 'SYNC_CREDIT_LINK (a credit note must reference the invoice it credits)'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT organization_id, direction, business_partner_id, currency_code, document_type_code
    INTO src
    FROM invoices
   WHERE id = NEW.credits_invoice_id;

  IF src IS NULL THEN
    RAISE EXCEPTION 'SYNC_CREDIT_LINK (the credited invoice does not exist)'
      USING ERRCODE = 'check_violation';
  END IF;

  IF src.document_type_code <> '380' THEN
    RAISE EXCEPTION 'SYNC_CREDIT_LINK (a credit note cannot credit another credit note)'
      USING ERRCODE = 'check_violation';
  END IF;

  IF src.organization_id <> NEW.organization_id
     OR src.direction <> NEW.direction
     OR src.business_partner_id <> NEW.business_partner_id
     OR src.currency_code <> NEW.currency_code THEN
    RAISE EXCEPTION 'SYNC_CREDIT_LINK (organization, direction, partner and currency must match the credited invoice)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS invoices_credit_note_link ON public.invoices;
CREATE TRIGGER invoices_credit_note_link
  BEFORE INSERT OR UPDATE OF credits_invoice_id, document_type_code ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_credit_note_link();

-- ===========================================================================
-- 4. Document numbering
-- ===========================================================================
-- Credit notes get their own gap-free series. Sharing the invoice series would
-- interleave the two, and most jurisdictions want credit notes numbered
-- separately so the invoice series stays continuous.
--
-- Backfilled for every EXISTING tenant, not just added to the provisioning code
-- for new ones — `next_document_number` raises SYNC_SEQUENCE_MISSING when the
-- row is absent, so without this the first credit note in every existing
-- organization would fail.
--
-- FORCE is lifted for the two statements and restored immediately. Both tables
-- are tenant-policed, and this runs as the schema owner with no tenant scope
-- set: the SELECT over `organizations` would return zero rows and the INSERT
-- would fail its WITH CHECK. FORCE deliberately subjects the owner to the
-- policy, which is right everywhere except a cross-tenant migration like this
-- one. The whole file is one transaction, and tests/migrate-as-owner asserts
-- FORCE is back on when the migrations finish.

ALTER TABLE public.organizations      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_sequences NO FORCE ROW LEVEL SECURITY;

INSERT INTO public.document_sequences (organization_id, sequence_key, prefix, padding, next_value)
SELECT o.id, s.key, s.prefix, 5, 1
FROM public.organizations o
CROSS JOIN (VALUES ('credit_note_ar', 'CN-'), ('credit_note_ap', 'VCN-')) AS s(key, prefix)
ON CONFLICT (organization_id, sequence_key) DO NOTHING;

ALTER TABLE public.organizations      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.document_sequences FORCE ROW LEVEL SECURITY;
