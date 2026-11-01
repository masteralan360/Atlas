-- Service lines use a UI-only Services selector. They are not inventory
-- positions and must never be cast to UUIDs by order reservation code.
CREATE OR REPLACE FUNCTION private.order_stock_requirements(p_items jsonb, p_storage_id uuid)
RETURNS TABLE(product_id uuid, storage_id uuid, quantity numeric)
LANGUAGE sql STABLE SET search_path = '' AS $function$
  WITH parsed_items AS (
    SELECT
      NULLIF(COALESCE(item->>'productId', item->>'product_id'), '')::uuid AS product_id,
      CASE
        WHEN COALESCE(product.is_service, false)
          OR COALESCE(item->>'storageId', item->>'storage_id')
            IN ('__atlas_services__', '__atlas_activities__')
          THEN NULL::uuid
        ELSE COALESCE(
          NULLIF(COALESCE(item->>'storageId', item->>'storage_id'), '')::uuid,
          p_storage_id
        )
      END AS storage_id,
      COALESCE(NULLIF(item->>'inventoryQuantity','')::numeric,
        COALESCE(NULLIF(item->>'quantity','')::numeric,0) * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
      + COALESCE(NULLIF(item->>'freeBonusInventoryQuantity','')::numeric,
        COALESCE(NULLIF(COALESCE(item->>'freeBonusQuantity',item->>'freeQuantity'),'')::numeric,0)
          * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1)) AS quantity,
      COALESCE(product.is_service, false) AS is_service
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) AS entry(item)
    LEFT JOIN public.products AS product
      ON product.id = NULLIF(COALESCE(item->>'productId', item->>'product_id'), '')::uuid
  )
  SELECT parsed.product_id, parsed.storage_id,
    pg_catalog.round(SUM(parsed.quantity), 6)
  FROM parsed_items AS parsed
  WHERE NOT parsed.is_service
  GROUP BY parsed.product_id, parsed.storage_id
  HAVING SUM(parsed.quantity) > 0;
$function$;
REVOKE ALL ON FUNCTION private.order_stock_requirements(jsonb,uuid) FROM PUBLIC,anon,authenticated;

-- The reservation detail RPC is a read path over the same JSON lines. Guard
-- virtual storage values before casting so legacy service orders remain safe.
CREATE OR REPLACE FUNCTION public.get_visible_stock_reservations(
  p_workspace_id uuid,
  p_product_id uuid,
  p_storage_id uuid,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $function$
  WITH matching AS (
    SELECT orders.id, orders.order_number, orders.created_at,
      pg_catalog.round(SUM(
        COALESCE(NULLIF(item->>'inventoryQuantity','')::numeric,
          COALESCE(NULLIF(item->>'quantity','')::numeric,0) * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
        + COALESCE(NULLIF(item->>'freeBonusInventoryQuantity','')::numeric,
          COALESCE(NULLIF(COALESCE(item->>'freeBonusQuantity',item->>'freeQuantity'),'')::numeric,0)
            * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
      ), 6) AS quantity
    FROM crm.sales_orders AS orders
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(orders.items) AS entry(item)
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN COALESCE(entry.item->>'storageId', entry.item->>'storage_id')
          IN ('__atlas_services__', '__atlas_activities__')
          THEN NULL::uuid
        ELSE COALESCE(
          NULLIF(COALESCE(entry.item->>'storageId', entry.item->>'storage_id'), '')::uuid,
          orders.source_storage_id
        )
      END AS storage_id
    ) AS parsed
    WHERE orders.workspace_id = p_workspace_id
      AND p_workspace_id = public.current_workspace_id()
      AND orders.status = 'pending'
      AND NOT COALESCE(orders.is_deleted, false)
      AND NULLIF(COALESCE(entry.item->>'productId', entry.item->>'product_id'), '')::uuid = p_product_id
      AND (parsed.storage_id IS NULL OR parsed.storage_id = p_storage_id)
      AND COALESCE(COALESCE(entry.item->>'storageId', entry.item->>'storage_id'), '')
        NOT IN ('__atlas_services__', '__atlas_activities__')
      AND public.current_user_can_access_storage(p_workspace_id, p_storage_id)
    GROUP BY orders.id, orders.order_number, orders.created_at
  ), page AS (
    SELECT * FROM matching ORDER BY id OFFSET GREATEST(p_offset, 0) LIMIT 20
  )
  SELECT pg_catalog.jsonb_build_object(
    'total', (SELECT COUNT(*) FROM matching),
    'rows', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page)) FROM page), '[]'::jsonb)
  );
$function$;
REVOKE ALL ON FUNCTION public.get_visible_stock_reservations(uuid,uuid,uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_visible_stock_reservations(uuid,uuid,uuid,integer) TO authenticated;

-- Idempotent Quick Order retries can load a previously saved order. Ignore
-- service lines in the replay inventory projection before parsing their
-- client-only storage selector as a UUID.
DO $patch_quick_order_replay_inventory$
DECLARE
  function_sql text;
  old_fragment text := $old$
      SELECT DISTINCT
        NULLIF(item->>'productId', '')::uuid AS product_id,
        COALESCE(
          NULLIF(item->>'storageId', '')::uuid,
          v_order.source_storage_id
        ) AS storage_id
      FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb)) AS item
$old$;
  new_fragment text := $new$
      SELECT DISTINCT
        NULLIF(item->>'productId', '')::uuid AS product_id,
        CASE
          WHEN COALESCE(product.is_service, false)
            OR COALESCE(item->>'storageId', item->>'storage_id')
              IN ('__atlas_services__', '__atlas_activities__')
            THEN NULL::uuid
          ELSE COALESCE(
            NULLIF(COALESCE(item->>'storageId', item->>'storage_id'), '')::uuid,
            v_order.source_storage_id
          )
        END AS storage_id
      FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb)) AS item
      LEFT JOIN public.products AS product
        ON product.id = NULLIF(item->>'productId', '')::uuid
       AND product.workspace_id = v_workspace_id
$new$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('private.complete_quick_sales_order_once(jsonb)'::regprocedure)
  INTO function_sql;

  IF function_sql IS NULL THEN
    RAISE EXCEPTION 'Quick Order completion function was not found';
  END IF;
  -- The migration runner and PostgreSQL may preserve different line endings.
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  function_sql := pg_catalog.replace(function_sql, E'\r', E'\n');
  old_fragment := pg_catalog.replace(old_fragment, E'\r\n', E'\n');
  old_fragment := pg_catalog.replace(old_fragment, E'\r', E'\n');
  new_fragment := pg_catalog.replace(new_fragment, E'\r\n', E'\n');
  new_fragment := pg_catalog.replace(new_fragment, E'\r', E'\n');
  IF pg_catalog.strpos(function_sql, new_fragment) > 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.strpos(function_sql, old_fragment) = 0 THEN
    RAISE EXCEPTION 'Quick Order replay inventory query did not match the expected definition';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_fragment, new_fragment);
  EXECUTE function_sql;
END;
$patch_quick_order_replay_inventory$;

NOTIFY pgrst, 'reload schema';
