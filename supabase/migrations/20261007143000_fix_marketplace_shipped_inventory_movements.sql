-- Marketplace shipment inventory deductions must be traceable to the CRM Sales
-- Order created by the same transition. Without this context, the deferred
-- inventory audit records a generic movement that the Sales Order integrity
-- audit cannot associate with its order.
DO $migration$
DECLARE
  v_definition text;
  v_updated text;
  v_shipping_branch text;
  v_branch_start integer;
  v_branch_end integer;
  v_shipping_marker text := $marker$  IF v_next_status = 'shipped' THEN$marker$;
  v_delivery_marker text := $marker$  IF v_next_status = 'delivered' THEN$marker$;
  v_inventory_marker text := $marker$  IF NOT COALESCE(v_order.inventory_deducted, false) THEN$marker$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.transition_marketplace_order(uuid,text,text)'::regprocedure
  )
  INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Marketplace order transition procedure was not found';
  END IF;

  v_definition := replace(v_definition, chr(13), '');

  IF position('v_create_sales_order boolean := false;' IN v_definition) > 0
    AND position('atlas.inventory_reference_type' IN v_definition) > 0
    AND position(E'      id,\n      order_number,' IN v_definition) > 0
  THEN
    RETURN;
  END IF;

  IF position('v_shipment_timestamp timestamp with time zone := timezone(''utc'', now());' IN v_definition) = 0
    OR position(v_shipping_marker IN v_definition) = 0
    OR position(v_delivery_marker IN v_definition) = 0
  THEN
    RAISE EXCEPTION 'Expected shipped marketplace transition revision is not installed';
  END IF;

  v_updated := replace(
    v_definition,
    E'  v_shipped_actor_name text;\n  v_shipment_timestamp timestamp with time zone := timezone(''utc'', now());',
    E'  v_shipped_actor_name text;\n  v_shipment_timestamp timestamp with time zone := timezone(''utc'', now());\n  v_create_sales_order boolean := false;'
  );
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Marketplace shipment Sales Order creation flag could not be declared';
  END IF;
  v_definition := v_updated;

  v_branch_start := strpos(v_definition, v_shipping_marker);
  v_branch_end := strpos(substring(v_definition FROM v_branch_start + length(v_shipping_marker)), v_delivery_marker)
    + v_branch_start + length(v_shipping_marker) - 1;
  IF v_branch_start = 0 OR v_branch_end <= v_branch_start THEN
    RAISE EXCEPTION 'Marketplace shipment branch could not be isolated';
  END IF;

  v_shipping_branch := substring(v_definition FROM v_branch_start FOR v_branch_end - v_branch_start);
  IF position(v_inventory_marker IN v_shipping_branch) = 0
    OR position('UPDATE public.inventory' IN v_shipping_branch) = 0
  THEN
    RAISE EXCEPTION 'Marketplace shipment inventory deduction could not be found';
  END IF;

  v_updated := replace(
    v_shipping_branch,
    v_inventory_marker,
    E'  v_sales_order_id := v_order.sales_order_id;\n'
      || E'  v_create_sales_order := v_sales_order_id IS NULL;\n'
      || E'  IF v_create_sales_order THEN\n'
      || E'    v_sales_order_id := gen_random_uuid();\n'
      || E'  END IF;\n\n'
      || v_inventory_marker
  );
  IF v_updated IS NOT DISTINCT FROM v_shipping_branch THEN
    RAISE EXCEPTION 'Marketplace shipment Sales Order id could not be prepared before inventory deduction';
  END IF;
  v_shipping_branch := v_updated;

  v_updated := replace(
    v_shipping_branch,
    'UPDATE public.inventory',
    E'PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'', ''sale'', true);\n'
      || E'      PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', v_sales_order_id::text, true);\n'
      || E'      PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'', ''sales_order'', true);\n'
      || E'      PERFORM pg_catalog.set_config(''atlas.inventory_created_by'', COALESCE(v_shipped_actor_id::text, ''''), true);\n'
      || 'UPDATE public.inventory'
  );
  IF v_updated IS NOT DISTINCT FROM v_shipping_branch THEN
    RAISE EXCEPTION 'Marketplace shipment inventory audit context could not be added';
  END IF;
  v_shipping_branch := v_updated;

  v_updated := replace(
    v_shipping_branch,
    E'  v_sales_order_id := v_order.sales_order_id;\n\n  IF v_sales_order_id IS NULL THEN',
    E'  v_sales_order_id := COALESCE(v_order.sales_order_id, v_sales_order_id);\n\n  IF v_create_sales_order THEN'
  );
  IF v_updated IS NOT DISTINCT FROM v_shipping_branch THEN
    RAISE EXCEPTION 'Marketplace shipment Sales Order creation guard could not be updated';
  END IF;
  v_shipping_branch := v_updated;

  v_updated := replace(
    v_shipping_branch,
    E'    INSERT INTO crm.sales_orders (\n      order_number,',
    E'    INSERT INTO crm.sales_orders (\n      id,\n      order_number,'
  );
  IF v_updated IS NOT DISTINCT FROM v_shipping_branch THEN
    RAISE EXCEPTION 'Marketplace Sales Order id could not be included in the insert';
  END IF;
  v_shipping_branch := v_updated;

  v_updated := replace(
    v_shipping_branch,
    E'    VALUES (\n      '''',\n      v_order.workspace_id,',
    E'    VALUES (\n      v_sales_order_id,\n      '''',\n      v_order.workspace_id,'
  );
  IF v_updated IS NOT DISTINCT FROM v_shipping_branch THEN
    RAISE EXCEPTION 'Marketplace Sales Order id could not be used in the insert';
  END IF;
  v_shipping_branch := v_updated;

  v_updated := substring(v_definition FROM 1 FOR v_branch_start - 1)
    || v_shipping_branch
    || substring(v_definition FROM v_branch_end);

  IF position('v_create_sales_order' IN v_updated) = 0
    OR position('atlas.inventory_reference_id' IN v_updated) = 0
    OR position('atlas.inventory_reference_type' IN v_updated) = 0
    OR position(E'      id,\n      order_number,' IN v_updated) = 0
  THEN
    RAISE EXCEPTION 'Marketplace shipment inventory movement linkage was not installed';
  END IF;

  EXECUTE v_updated;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
