-- Hard-delete exactly the two purchase orders after the complete order rows
-- were backed up to the user's Downloads folder.
-- Keep their payment, inventory, stock-batch, and loan records as audit history.
DO $hard_delete_purchase_orders$
DECLARE
  v_order_ids uuid[];
  v_order_numbers text[];
  v_deleted_count integer;
BEGIN
  WITH target_orders AS MATERIALIZED (
    SELECT purchase_order.id, purchase_order.order_number
    FROM crm.purchase_orders AS purchase_order
    WHERE purchase_order.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
      AND purchase_order.order_number = ANY (
        ARRAY['PO-2026-00037', 'PO-2026-00038']::text[]
      )
    FOR UPDATE
  )
  SELECT
    COALESCE(
      array_agg(target_orders.id ORDER BY target_orders.order_number, target_orders.id),
      ARRAY[]::uuid[]
    ),
    COALESCE(
      array_agg(target_orders.order_number ORDER BY target_orders.order_number, target_orders.id),
      ARRAY[]::text[]
    )
  INTO v_order_ids, v_order_numbers
  FROM target_orders;

  IF v_order_numbers IS DISTINCT FROM ARRAY['PO-2026-00037', 'PO-2026-00038']::text[] THEN
    RAISE EXCEPTION
      'Expected exactly PO-2026-00037 and PO-2026-00038 in workspace 0b342f6c-bcdc-45a9-bcda-9d21360ff3c9; found %',
      array_to_string(v_order_numbers, ', ');
  END IF;

  DELETE FROM crm.purchase_orders AS purchase_order
  WHERE purchase_order.id = ANY (v_order_ids)
    AND purchase_order.workspace_id = '0b342f6c-bcdc-45a9-bcda-9d21360ff3c9'::uuid
    AND purchase_order.order_number = ANY (
      ARRAY['PO-2026-00037', 'PO-2026-00038']::text[]
    );

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  IF v_deleted_count <> 2 THEN
    RAISE EXCEPTION 'Expected to hard-delete 2 purchase orders; deleted %', v_deleted_count;
  END IF;
END
$hard_delete_purchase_orders$;
