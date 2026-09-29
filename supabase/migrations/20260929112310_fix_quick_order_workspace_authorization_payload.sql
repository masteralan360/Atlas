-- The atomic Quick Order payload is sanitized to snake_case at the order
-- level. Read the serialized workspace key before enforcing the authenticated
-- workspace check. Keep the camelCase fallback for older direct callers;
-- either spelling remains bound to current_workspace_id().
CREATE OR REPLACE FUNCTION public.complete_quick_sales_order(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order_payload jsonb := COALESCE(payload->'order', '{}'::jsonb);
  v_workspace_id uuid;
  v_order_id uuid;
  v_validation_items jsonb;
  v_minimum_price_message text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_workspace_id := NULLIF(pg_catalog.btrim(COALESCE(
      v_order_payload->>'workspace_id',
      v_order_payload->>'workspaceId'
    )), '')::uuid;
    v_order_id := NULLIF(pg_catalog.btrim(v_order_payload->>'id'), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Sales order or workspace id is invalid' USING ERRCODE = '22023';
  END;

  IF v_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;

  -- A retry of an already committed order must return its existing result even
  -- if an administrator changed the floor after the first response was lost.
  IF v_order_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM crm.sales_orders AS saved_order
    WHERE saved_order.id = v_order_id
      AND saved_order.workspace_id = v_workspace_id
  ) THEN
    RETURN private.complete_quick_sales_order_once(payload);
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'product_id', item.value->>'productId',
      'effective_selling_price', item.value->>'originalUnitPrice',
      'unit_factor', COALESCE(item.value->>'unitFactor', '1'),
      'currency', product.currency
    ) ORDER BY item.ordinality),
    '[]'::jsonb
  )
  INTO v_validation_items
  FROM pg_catalog.jsonb_array_elements(COALESCE(v_order_payload->'items', '[]'::jsonb))
       WITH ORDINALITY AS item(value, ordinality)
  JOIN public.products AS product
    ON product.id = NULLIF(item.value->>'productId', '')::uuid
   AND product.workspace_id = v_workspace_id
  WHERE lower(COALESCE(item.value->>'originalCurrency', product.currency::text))
    = lower(product.currency::text);

  SELECT pg_catalog.format(
    'Price for %s cannot be lower than the minimum selling price of %s.',
    violation.product_name,
    violation.minimum_selling_price
  )
  INTO v_minimum_price_message
  FROM public.validate_staff_minimum_selling_prices(v_workspace_id, v_validation_items) AS violation
  ORDER BY violation.line_index
  LIMIT 1;

  IF v_minimum_price_message IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = v_minimum_price_message;
  END IF;

  RETURN private.complete_quick_sales_order_once(payload);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_quick_sales_order(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_quick_sales_order(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_quick_sales_order(jsonb) IS
  'Atomic Quick Order wrapper with a staff-only minimum selling price check before writes.';
