-- ---------------------------------------------------------------------------
-- Syncrese — operations guards: order-to-cash, CRM, inventory, procure-to-pay.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Row level security
-- ===========================================================================

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'products', 'warehouses', 'bin_locations', 'stock_levels', 'stock_movements',
    'stock_transfers', 'stock_transfer_lines',
    'quotes', 'quote_lines', 'sales_orders', 'sales_order_lines',
    'deliveries', 'delivery_lines',
    'purchase_requisitions', 'purchase_requisition_lines',
    'purchase_orders', 'purchase_order_lines',
    'goods_receipts', 'goods_receipt_lines',
    'pipelines', 'pipeline_stages', 'deals', 'activities'
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
-- 2. Negative stock
-- ===========================================================================
-- Weighted-average cost is undefined on a negative quantity: there is no
-- meaningful "average cost of minus three units". A site that genuinely needs
-- to ship ahead of receiving must opt in explicitly, and accepts that its
-- valuation is approximate until the receipt lands.

CREATE OR REPLACE FUNCTION public.assert_stock_not_negative() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  allows boolean;
  sku    text;
BEGIN
  IF NEW.qty_on_hand >= 0 THEN
    RETURN NEW;
  END IF;

  SELECT w.allows_negative_stock INTO allows
    FROM warehouses w WHERE w.id = NEW.warehouse_id;

  IF coalesce(allows, false) THEN
    RETURN NEW;
  END IF;

  SELECT p.sku INTO sku FROM products p WHERE p.id = NEW.product_id;

  RAISE EXCEPTION 'SYNC_NEGATIVE_STOCK (% would go to %)', coalesce(sku, NEW.product_id::text), NEW.qty_on_hand
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS stock_levels_not_negative ON public.stock_levels;
CREATE TRIGGER stock_levels_not_negative
  BEFORE INSERT OR UPDATE ON public.stock_levels
  FOR EACH ROW EXECUTE FUNCTION public.assert_stock_not_negative();

-- ===========================================================================
-- 3. Over-receipt and over-delivery
-- ===========================================================================
-- Receiving more than was ordered, or shipping more than was sold, is almost
-- always a data-entry error rather than an intention. Catching it at the
-- database means no code path can create an order whose fulfilled quantity
-- exceeds what it promised.

CREATE OR REPLACE FUNCTION public.assert_po_line_not_over_received() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.qty_received > NEW.quantity THEN
    RAISE EXCEPTION 'SYNC_OVER_RECEIPT (line % ordered %, receiving %)',
      NEW.line_no, NEW.quantity, NEW.qty_received
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.qty_invoiced > NEW.quantity THEN
    RAISE EXCEPTION 'SYNC_OVER_INVOICED (line % ordered %, invoicing %)',
      NEW.line_no, NEW.quantity, NEW.qty_invoiced
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS purchase_order_lines_fulfilment ON public.purchase_order_lines;
CREATE TRIGGER purchase_order_lines_fulfilment
  BEFORE INSERT OR UPDATE ON public.purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.assert_po_line_not_over_received();

CREATE OR REPLACE FUNCTION public.assert_so_line_not_over_delivered() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.qty_delivered > NEW.quantity THEN
    RAISE EXCEPTION 'SYNC_OVER_DELIVERY (line % ordered %, delivering %)',
      NEW.line_no, NEW.quantity, NEW.qty_delivered
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.qty_invoiced > NEW.quantity THEN
    RAISE EXCEPTION 'SYNC_OVER_INVOICED (line % ordered %, invoicing %)',
      NEW.line_no, NEW.quantity, NEW.qty_invoiced
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sales_order_lines_fulfilment ON public.sales_order_lines;
CREATE TRIGGER sales_order_lines_fulfilment
  BEFORE INSERT OR UPDATE ON public.sales_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.assert_so_line_not_over_delivered();

-- ===========================================================================
-- 4. Posted documents are immutable
-- ===========================================================================
-- A goods receipt and a delivery each move inventory AND post to the ledger.
-- Editing one after posting would desynchronise stock from the general ledger
-- with nothing to reconcile against. Corrections are made by reversing.

CREATE OR REPLACE FUNCTION public.block_posted_document_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  locked_states text[] := ARRAY['posted', 'shipped', 'reversed'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = ANY(locked_states) THEN
      RAISE EXCEPTION 'SYNC_DOCUMENT_POSTED (% is % and cannot be deleted)',
        TG_TABLE_NAME, OLD.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = ANY(locked_states) AND NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'SYNC_DOCUMENT_POSTED (% is %; reverse it instead)',
      TG_TABLE_NAME, OLD.status USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS goods_receipts_immutable ON public.goods_receipts;
CREATE TRIGGER goods_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.goods_receipts
  FOR EACH ROW EXECUTE FUNCTION public.block_posted_document_change();

DROP TRIGGER IF EXISTS deliveries_immutable ON public.deliveries;
CREATE TRIGGER deliveries_immutable
  BEFORE UPDATE OR DELETE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.block_posted_document_change();

-- ===========================================================================
-- 5. Stock movements are append-only
-- ===========================================================================
-- The movement history is what makes weighted-average cost auditable and is the
-- data a future FIFO migration would replay. Editing it retroactively would
-- invalidate every avg_cost_after_minor recorded since.

CREATE OR REPLACE FUNCTION public.block_stock_movement_change() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SYNC_APPEND_ONLY: stock_movements cannot be % ed', lower(TG_OP)
    USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS stock_movements_append_only ON public.stock_movements;
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.block_stock_movement_change();

REVOKE UPDATE, DELETE ON public.stock_movements FROM syncrese_app;

-- ===========================================================================
-- 6. Document sequences for the new document types
-- ===========================================================================
-- Backfilled for organizations provisioned before this migration; new tenants
-- get them from provisionFinance().

INSERT INTO document_sequences (organization_id, sequence_key, prefix, padding, next_value)
SELECT o.id, v.key, v.prefix, v.padding, 1
FROM organizations o
CROSS JOIN (VALUES
  ('quote',        'QT-',   5),
  ('sales_order',  'SO-',   5),
  ('delivery',     'DN-',   5),
  ('requisition',  'REQ-',  5),
  ('purchase_order','PO-',  5),
  ('goods_receipt','GR-',   5),
  ('stock_transfer','TR-',  5),
  ('deal',         'DL-',   5),
  ('product',      'SKU-',  5)
) AS v(key, prefix, padding)
ON CONFLICT DO NOTHING;
