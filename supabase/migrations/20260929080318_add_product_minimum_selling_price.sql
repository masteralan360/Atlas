ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS minimum_selling_price numeric NULL
  CHECK (minimum_selling_price IS NULL OR minimum_selling_price >= 0);

COMMENT ON COLUMN public.products.minimum_selling_price IS
  'Optional staff-only minimum selling price in the product selling-price currency.';

CREATE OR REPLACE FUNCTION public.validate_staff_minimum_selling_prices(
  p_workspace_id uuid,
  p_items jsonb
)
RETURNS TABLE (
  line_index integer,
  product_id uuid,
  product_name text,
  minimum_selling_price numeric,
  validation_error text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'minimum_selling_price_authentication_required';
  END IF;

  IF p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'minimum_selling_price_workspace_mismatch';
  END IF;

  IF public.current_user_role() <> 'staff' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    (item.ordinality - 1)::integer,
    product.id,
    product.name::text,
    product.minimum_selling_price,
    CASE
      WHEN lower(COALESCE(item.value->>'currency', product.currency::text))
        IS DISTINCT FROM lower(product.currency::text)
        THEN 'currency_unavailable'
      ELSE NULL
    END
  FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
  JOIN public.products AS product
    ON product.id = (item.value->>'product_id')::uuid
   AND product.workspace_id = p_workspace_id
  WHERE product.minimum_selling_price IS NOT NULL
    AND (
      lower(COALESCE(item.value->>'currency', product.currency::text))
        IS DISTINCT FROM lower(product.currency::text)
      OR NULLIF(item.value->>'effective_selling_price', '')::numeric
        < product.minimum_selling_price * CASE
          WHEN COALESCE(NULLIF(item.value->>'unit_factor', '')::numeric, 1) > 0
            THEN COALESCE(NULLIF(item.value->>'unit_factor', '')::numeric, 1)
          ELSE 1
        END
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_staff_minimum_selling_prices(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_staff_minimum_selling_prices(uuid, jsonb) TO authenticated;

-- Enforce the same staff-only rule inside the existing atomic POS transaction.
-- The application calls the validation RPC first for localized feedback; this
-- guard also checks the actual complete_sale payload before any writes occur.
CREATE OR REPLACE FUNCTION public.complete_sale(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_sale_id uuid;
  v_workspace_id uuid;
  v_existing record;
  v_validation_items jsonb;
  v_minimum_price_message text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_sale_id := NULLIF(pg_catalog.btrim(payload->>'id'), '')::uuid;
    v_workspace_id := NULLIF(pg_catalog.btrim(payload->>'workspace_id'), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Sale or workspace id is invalid' USING ERRCODE = '22023';
  END;

  IF v_sale_id IS NOT NULL THEN
    SELECT id, sequence_id, system_verified, system_review_status, system_review_reason
    INTO v_existing
    FROM public.sales
    WHERE id = v_sale_id;

    IF FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'sale_id', v_existing.id,
        'sequence_id', v_existing.sequence_id,
        'system_verified', v_existing.system_verified,
        'system_review_status', v_existing.system_review_status,
        'system_review_reason', v_existing.system_review_reason,
        'already_applied', true
      );
    END IF;
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'product_id', item.value->>'product_id',
      'effective_selling_price', item.value->>'unit_price',
      'unit_factor', COALESCE(item.value->>'unit_factor', '1'),
      'currency', product.currency
    ) ORDER BY item.ordinality),
    '[]'::jsonb
  )
  INTO v_validation_items
  FROM pg_catalog.jsonb_array_elements(COALESCE(payload->'items', '[]'::jsonb))
       WITH ORDINALITY AS item(value, ordinality)
  JOIN public.products AS product
    ON product.id = NULLIF(item.value->>'product_id', '')::uuid
   AND product.workspace_id = v_workspace_id
  WHERE lower(COALESCE(item.value->>'original_currency', 'usd'))
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

  BEGIN
    RETURN private.complete_sale_once(payload);
  EXCEPTION
    WHEN unique_violation THEN
      IF v_sale_id IS NULL THEN
        RAISE;
      END IF;

      SELECT id, sequence_id, system_verified, system_review_status, system_review_reason
      INTO v_existing
      FROM public.sales
      WHERE id = v_sale_id;

      IF NOT FOUND THEN
        RAISE;
      END IF;

      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'sale_id', v_existing.id,
        'sequence_id', v_existing.sequence_id,
        'system_verified', v_existing.system_verified,
        'system_review_status', v_existing.system_review_status,
        'system_review_reason', v_existing.system_review_reason,
        'already_applied', true
      );
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_sale(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_sale(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.complete_sale(jsonb) IS
  'Idempotent POS checkout wrapper with a staff-only minimum selling price check before writes.';

-- Preserve the existing atomic Quick Order implementation in a private
-- function and place the same lightweight role/product check before it.
ALTER FUNCTION public.complete_quick_sales_order(jsonb) SET SCHEMA private;
ALTER FUNCTION private.complete_quick_sales_order(jsonb) RENAME TO complete_quick_sales_order_once;
ALTER FUNCTION private.complete_quick_sales_order_once(jsonb) SET search_path = '';
REVOKE ALL ON FUNCTION private.complete_quick_sales_order_once(jsonb) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.complete_quick_sales_order_once(jsonb) TO authenticated, service_role;

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
    v_workspace_id := NULLIF(pg_catalog.btrim(v_order_payload->>'workspaceId'), '')::uuid;
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
