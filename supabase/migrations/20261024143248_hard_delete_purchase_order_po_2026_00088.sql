-- Hard-delete the one purchase order explicitly identified by the user.
-- Leave payment and inventory ledger records intact as audit history.
DO $hard_delete_purchase_order$
DECLARE
  v_order_ids uuid[];
BEGIN
  WITH target_orders AS MATERIALIZED (
    SELECT purchase_order.id
    FROM crm.purchase_orders AS purchase_order
    WHERE purchase_order.workspace_id = 'd408be58-3c62-4c57-b8e6-1ab56955da97'::uuid
      AND purchase_order.order_number = 'PO-2026-00088'
    FOR UPDATE
  )
  SELECT COALESCE(array_agg(target_orders.id), ARRAY[]::uuid[])
  INTO v_order_ids
  FROM target_orders;

  IF cardinality(v_order_ids) > 1 THEN
    RAISE EXCEPTION
      'Expected at most one purchase order PO-2026-00088 in workspace d408be58-3c62-4c57-b8e6-1ab56955da97; found %',
      cardinality(v_order_ids);
  END IF;

  IF cardinality(v_order_ids) = 1 THEN
    DELETE FROM crm.purchase_orders AS purchase_order
    WHERE purchase_order.id = v_order_ids[1]
      AND purchase_order.workspace_id = 'd408be58-3c62-4c57-b8e6-1ab56955da97'::uuid
      AND purchase_order.order_number = 'PO-2026-00088';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase order PO-2026-00088 changed while the hard-delete migration was running';
    END IF;
  END IF;
END
$hard_delete_purchase_order$;
