ALTER TABLE public.sale_items
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

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
  v_result jsonb;
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

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(COALESCE(payload->'items', '[]'::jsonb)) AS item(value)
    JOIN public.products AS product
      ON product.id = NULLIF(item.value->>'product_id', '')::uuid
     AND product.workspace_id = v_workspace_id
     AND COALESCE(product.is_service, false)
    WHERE item.value->'metadata'->'posServiceName' IS NOT NULL
      AND (
        pg_catalog.jsonb_typeof(item.value->'metadata'->'posServiceName') IS DISTINCT FROM 'object'
        OR pg_catalog.jsonb_typeof(item.value->'metadata'->'posServiceName'->'baseNameSnapshot') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(item.value->'metadata'->'posServiceName'->'suffix') IS DISTINCT FROM 'string'
        OR pg_catalog.jsonb_typeof(item.value->'metadata'->'posServiceName'->'displayNameSnapshot') IS DISTINCT FROM 'string'
        OR NULLIF(pg_catalog.btrim(item.value->'metadata'->'posServiceName'->>'baseNameSnapshot'), '') IS NULL
        OR NULLIF(pg_catalog.btrim(item.value->'metadata'->'posServiceName'->>'suffix'), '') IS NULL
        OR pg_catalog.length(pg_catalog.btrim(item.value->'metadata'->'posServiceName'->>'suffix')) > 120
        OR item.value->'metadata'->'posServiceName'->>'displayNameSnapshot'
          IS DISTINCT FROM pg_catalog.btrim(item.value->'metadata'->'posServiceName'->>'baseNameSnapshot')
            || ' - ' || pg_catalog.btrim(item.value->'metadata'->'posServiceName'->>'suffix')
      )
  ) THEN
    RAISE EXCEPTION 'Service name details are invalid' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT NULLIF(item.value->>'product_id', '')::uuid
    FROM pg_catalog.jsonb_array_elements(COALESCE(payload->'items', '[]'::jsonb)) AS item(value)
    JOIN public.products AS product
      ON product.id = NULLIF(item.value->>'product_id', '')::uuid
     AND product.workspace_id = v_workspace_id
     AND COALESCE(product.is_service, false)
    GROUP BY NULLIF(item.value->>'product_id', '')::uuid
    HAVING pg_catalog.count(*) > 1
      AND pg_catalog.bool_or(item.value->'metadata'->'posServiceName' IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'A named service can only appear once in a POS cart' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_result := private.complete_sale_once(payload);

    UPDATE public.sale_items AS sale_item
    SET metadata = COALESCE(sale_item.metadata, '{}'::jsonb)
          || pg_catalog.jsonb_build_object(
            'posServiceName',
            pg_catalog.jsonb_build_object(
              'baseNameSnapshot', pg_catalog.btrim(product.name),
              'suffix', pg_catalog.btrim(item.value->'metadata'->'posServiceName'->>'suffix'),
              'displayNameSnapshot', pg_catalog.btrim(product.name) || ' - ' || pg_catalog.btrim(item.value->'metadata'->'posServiceName'->>'suffix')
            )
          )
    FROM pg_catalog.jsonb_array_elements(COALESCE(payload->'items', '[]'::jsonb)) AS item(value)
    JOIN public.products AS product
      ON product.id = NULLIF(item.value->>'product_id', '')::uuid
     AND product.workspace_id = v_workspace_id
     AND COALESCE(product.is_service, false)
    WHERE sale_item.sale_id = v_sale_id
      AND sale_item.product_id = product.id
      AND item.value->'metadata'->'posServiceName' IS NOT NULL;

    RETURN v_result;
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

COMMENT ON COLUMN public.sale_items.metadata IS
  'Immutable POS line metadata, including per-sale service-name snapshots.';
