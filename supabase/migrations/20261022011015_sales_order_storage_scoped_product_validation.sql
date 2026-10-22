-- Sales Order lines may refer to a product that is visible through an
-- accessible storage even when the product's raw row is hidden by the stricter
-- products RLS policy (for example, stock in both an excluded Main storage
-- and an accessible Reserve storage). Validate product metadata through the
-- existing safe, redacted snapshot RPC instead of selecting public.products
-- directly from this SECURITY INVOKER trigger.
DO $patch_sales_order_product_visibility$
DECLARE
  function_sql text;
  function_is_security_definer boolean;
  old_product_declaration constant text := '  v_product public.products%ROWTYPE;';
  new_product_declaration constant text := '  v_product record;';
  old_product_lookup constant text := $old_lookup$
    SELECT product.* INTO v_product
    FROM public.products AS product
    WHERE product.id = v_product_id AND product.workspace_id = NEW.workspace_id AND NOT product.is_deleted;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order item product is unavailable' USING ERRCODE = '23503';
    END IF;
$old_lookup$;
  new_product_lookup constant text := $new_lookup$
    IF auth.uid() IS NULL THEN
      -- Trusted server-side jobs have no end-user storage scope and retain the
      -- existing direct lookup behavior.
      SELECT product.is_service, product.cost_price, product.minimum_selling_price
      INTO v_product
      FROM public.products AS product
      WHERE product.id = v_product_id
        AND product.workspace_id = NEW.workspace_id
        AND NOT product.is_deleted;
    ELSE
      -- This RPC applies the same partial-storage visibility rules as the
      -- Products and autocomplete flows, and redacts global stock and a
      -- restricted primary storage before returning product metadata.
      SELECT
        COALESCE(NULLIF(visible.product ->> 'is_service', '')::boolean, false) AS is_service,
        NULLIF(visible.product ->> 'cost_price', '')::numeric AS cost_price,
        NULLIF(visible.product ->> 'minimum_selling_price', '')::numeric AS minimum_selling_price
      INTO v_product
      FROM public.get_visible_products_for_current_user(
        NEW.workspace_id,
        ARRAY[v_product_id],
        0,
        1
      ) AS visible
      WHERE visible.id = v_product_id;
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Order item product is unavailable' USING ERRCODE = '23503';
    END IF;

    -- The safe product snapshot RPC enforces the service module but does not
    -- filter service categories. Keep the service-category RLS guarantee
    -- explicit for this trigger path.
    IF auth.uid() IS NOT NULL
      AND v_product.is_service
      AND NOT public.can_access_service(auth.uid(), v_product_id)
    THEN
      RAISE EXCEPTION 'Order item product is unavailable' USING ERRCODE = '23503';
    END IF;
$new_lookup$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(validation_proc.oid), validation_proc.prosecdef
  INTO function_sql, function_is_security_definer
  FROM pg_catalog.pg_proc AS validation_proc
  WHERE validation_proc.oid = 'private.validate_order_unit_items()'::regprocedure;

  IF function_sql IS NULL THEN
    RAISE EXCEPTION 'Order item UoM validation function was not found';
  END IF;
  IF function_is_security_definer THEN
    RAISE EXCEPTION 'Order item UoM validator must remain SECURITY INVOKER';
  END IF;

  -- Existing function source has Windows line endings in the live database;
  -- normalize the DDL text so the guarded replacement matches either form.
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  function_sql := pg_catalog.replace(function_sql, E'\r', E'\n');

  IF pg_catalog.strpos(function_sql, new_product_lookup) > 0
    AND pg_catalog.strpos(function_sql, new_product_declaration) > 0
  THEN
    RETURN;
  END IF;

  IF pg_catalog.strpos(function_sql, old_product_declaration) = 0
    OR pg_catalog.strpos(function_sql, old_product_lookup) = 0
  THEN
    RAISE EXCEPTION 'Order item product lookup did not match the expected invoker validator';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_product_declaration, new_product_declaration);
  function_sql := pg_catalog.replace(function_sql, old_product_lookup, new_product_lookup);

  IF function_is_security_definer
    OR pg_catalog.strpos(function_sql, 'get_visible_products_for_current_user') = 0
    OR pg_catalog.strpos(function_sql, 'can_access_service') = 0
  THEN
    RAISE EXCEPTION 'Order item product visibility patch did not preserve the expected security checks';
  END IF;

  EXECUTE function_sql;
END;
$patch_sales_order_product_visibility$;

NOTIFY pgrst, 'reload schema';
