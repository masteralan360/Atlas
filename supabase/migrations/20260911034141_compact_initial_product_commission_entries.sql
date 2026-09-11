-- Product commission must be part of the first payable commission snapshot.
-- The previous wrapper created a provisional whole-order accrual and then
-- balanced it with one or more automatic adjustments. Those rows had not been
-- committed or paid yet, so preserve the immutable ledger boundary by folding
-- only those transaction-local provisional rows before the RPC returns.

CREATE TABLE IF NOT EXISTS private.agent_commission_entry_compaction_context (
  entry_id uuid PRIMARY KEY REFERENCES crm.agent_commission_entries(id) ON DELETE CASCADE,
  transaction_id bigint NOT NULL
);

ALTER TABLE private.agent_commission_entry_compaction_context ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.agent_commission_entry_compaction_context FROM PUBLIC, anon, authenticated;

-- Commission rows remain immutable once committed. The context table is only
-- populated by the private compactor below, within the same transaction that
-- created the provisional rows; it cannot be written by API roles.
DO $block$
DECLARE
  v_definition text;
  v_original text;
BEGIN
  SELECT pg_get_functiondef('private.enforce_agent_commission_entry_row()'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');
  v_original := v_definition;

  IF position('agent_commission_entry_compaction_context' IN v_definition) = 0 THEN
    v_definition := replace(
      v_definition,
      E'  IF TG_OP = ''UPDATE'' THEN\n    IF NEW IS DISTINCT FROM OLD THEN\n      RAISE EXCEPTION ''Commission ledger entries are immutable''\n        USING ERRCODE = ''23514'';\n    END IF;\n    RETURN OLD;\n  END IF;',
      E'  IF TG_OP = ''UPDATE'' THEN\n    IF EXISTS (\n      SELECT 1\n      FROM private.agent_commission_entry_compaction_context AS context\n      WHERE context.entry_id = OLD.id\n        AND context.transaction_id = pg_catalog.txid_current()\n    ) THEN\n      RETURN NEW;\n    END IF;\n    IF NEW IS DISTINCT FROM OLD THEN\n      RAISE EXCEPTION ''Commission ledger entries are immutable''\n        USING ERRCODE = ''23514'';\n    END IF;\n    RETURN OLD;\n  END IF;'
    );
    IF v_definition = v_original THEN
      RAISE EXCEPTION 'Could not permit transaction-local product commission compaction';
    END IF;
    EXECUTE v_definition;
  END IF;
END;
$block$;

CREATE OR REPLACE FUNCTION private.prevent_agent_commission_entry_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM private.agent_commission_entry_compaction_context AS context
    WHERE context.entry_id = OLD.id
      AND context.transaction_id = pg_catalog.txid_current()
  ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Commission ledger entries are immutable'
    USING ERRCODE = '23514';
END;
$function$;

CREATE OR REPLACE FUNCTION private.compact_initial_product_commission_entries(
  p_order_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order crm.sales_orders%ROWTYPE;
  v_accrual crm.agent_commission_entries%ROWTYPE;
  v_adjustment_ids uuid[];
  v_adjustment_total numeric;
  v_has_product_snapshot boolean;
  v_product_total numeric;
  v_final_amount numeric;
  v_changed integer := 0;
BEGIN
  SELECT *
  INTO v_order
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.id = p_order_id
  FOR UPDATE;

  IF NOT FOUND
    OR (SELECT auth.uid()) IS NULL
    OR public.current_workspace_id() IS DISTINCT FROM v_order.workspace_id
  THEN
    RAISE EXCEPTION 'Sales order is not available for product commission compaction'
      USING ERRCODE = '42501';
  END IF;

  FOR v_accrual IN
    SELECT entry.*
    FROM crm.agent_commission_entries AS entry
    WHERE entry.workspace_id = v_order.workspace_id
      AND entry.order_id = v_order.id
      AND entry.kind = 'accrual'
      AND entry.created_at = pg_catalog.transaction_timestamp()
      AND entry.is_deleted = false
    FOR UPDATE
  LOOP
    SELECT
      array_agg(entry.id ORDER BY entry.created_at, entry.id),
      COALESCE(sum(entry.amount), 0)
    INTO v_adjustment_ids, v_adjustment_total
    FROM crm.agent_commission_entries AS entry
    WHERE entry.workspace_id = v_order.workspace_id
      AND entry.order_id = v_order.id
      AND entry.assignment_id = v_accrual.assignment_id
      AND entry.related_entry_id = v_accrual.id
      AND entry.kind = 'adjustment'
      AND entry.order_return_id IS NULL
      AND entry.created_at = pg_catalog.transaction_timestamp()
      AND entry.is_deleted = false;

    SELECT count(*) > 0, COALESCE(sum(entry.amount), 0)
    INTO v_has_product_snapshot, v_product_total
    FROM crm.agent_product_commission_entries AS entry
    WHERE entry.workspace_id = v_order.workspace_id
      AND entry.order_id = v_order.id
      AND entry.assignment_id = v_accrual.assignment_id
      AND entry.is_deleted = false;

    -- No product snapshot means these are ordinary ledger adjustments. Never
    -- compact them, and never compact a negative/invalid payable target.
    CONTINUE WHEN NOT v_has_product_snapshot;
    v_final_amount := round(v_accrual.amount + v_adjustment_total, 6);
    CONTINUE WHEN v_final_amount < v_product_total - 0.000001;

    INSERT INTO private.agent_commission_entry_compaction_context (entry_id, transaction_id)
    SELECT entry_id, pg_catalog.txid_current()
    FROM unnest(array_append(COALESCE(v_adjustment_ids, ARRAY[]::uuid[]), v_accrual.id)) AS candidate(entry_id)
    ON CONFLICT (entry_id) DO UPDATE
      SET transaction_id = EXCLUDED.transaction_id;

    UPDATE crm.agent_commission_entries
    SET
      amount = v_final_amount,
      plan_commission_amount = round(v_final_amount - v_product_total, 6),
      product_commission_amount = round(v_product_total, 6),
      notes = 'Product commission accrued from committed sales order state'
    WHERE id = v_accrual.id;

    DELETE FROM crm.agent_commission_entries
    WHERE id = ANY(v_adjustment_ids);

    DELETE FROM private.agent_commission_entry_compaction_context
    WHERE entry_id = v_accrual.id;

    v_changed := v_changed + 1;
  END LOOP;

  RETURN v_changed;
END;
$function$;

-- The normal reconciliation remains responsible for computing the final
-- target. Compaction runs immediately afterward, before any commission payout
-- can be recorded, so a new product-commission order has one earned entry.
CREATE OR REPLACE FUNCTION public.reconcile_sales_agent_commission(
  p_order_id uuid,
  p_order_return_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_changed integer := 0;
BEGIN
  v_changed := public.reconcile_sales_agent_commission_core(p_order_id, p_order_return_id);
  v_changed := v_changed + private.ensure_order_creator_product_commission_assignment(p_order_id);
  v_changed := v_changed + private.reconcile_product_sales_agent_commission(p_order_id, p_order_return_id);
  v_changed := v_changed + private.compact_initial_product_commission_entries(p_order_id);
  RETURN v_changed;
END;
$function$;

REVOKE ALL ON FUNCTION private.compact_initial_product_commission_entries(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.prevent_agent_commission_entry_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_agent_commission_entry_row() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_sales_agent_commission(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
