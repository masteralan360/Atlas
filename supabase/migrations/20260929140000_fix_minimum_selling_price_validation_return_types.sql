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
