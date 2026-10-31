-- When a catalog search finds one member of a product family, return the
-- remaining visible variants with the page so the Products list can show the
-- full family without loading the rest of the catalog.
DO $catalog_family_variants$
DECLARE
  v_definition text;
  v_support_start integer;
  v_response_start integer;
  v_support_cte constant text := $replacement$
  support_products AS (
    SELECT
      family_product.*,
      COALESCE(visible_inventory.visible_quantity, 0) AS visible_quantity,
      page_families.family_id,
      page_families.family_rank AS sort_rank
    FROM page_families
    INNER JOIN public.products AS family_product
      ON family_product.workspace_id = public.current_workspace_id()
      AND COALESCE(family_product.parent_product_id, family_product.id) = page_families.family_id
    LEFT JOIN LATERAL (
      SELECT SUM(COALESCE(inventory_row.quantity, 0)) AS visible_quantity
      FROM public.inventory AS inventory_row
      WHERE inventory_row.workspace_id = family_product.workspace_id
        AND inventory_row.product_id = family_product.id
        AND COALESCE(inventory_row.is_deleted, false) = false
        AND (public.current_user_role() = 'admin' OR public.current_user_can_access_storage(inventory_row.workspace_id, inventory_row.storage_id))
    ) AS visible_inventory ON true
    WHERE COALESCE(family_product.is_deleted, false) = false
      AND (NOT COALESCE(family_product.is_service, false) OR public.services_module_allowed(family_product.workspace_id))
      AND (COALESCE(family_product.is_service, false) OR private.current_user_can_access_any_product_storage(family_product.workspace_id, family_product.id, family_product.storage_id))
      AND NOT EXISTS (
        SELECT 1
        FROM page_match_ids
        WHERE page_match_ids.id = family_product.id
      )
  ),
$replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'public.get_products_catalog_page(text,text,uuid[],uuid[],uuid[],text[],numeric,numeric,numeric,numeric,text,integer,integer)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL
    OR position('SECURITY DEFINER' IN v_definition) = 0
    OR position('private.current_user_can_access_any_product_storage' IN v_definition) = 0
    OR position('product_storage_assignments' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'The product catalog page function no longer matches the expected safe definition';
  END IF;

  v_support_start := strpos(v_definition, '  support_products AS (');
  IF v_support_start = 0 THEN
    RAISE EXCEPTION 'The product catalog page support-products CTE was not found';
  END IF;

  v_response_start := v_support_start + strpos(
    substring(v_definition FROM v_support_start),
    '  response_products AS ('
  ) - 1;
  IF v_response_start < v_support_start THEN
    RAISE EXCEPTION 'The product catalog page response-products CTE was not found';
  END IF;

  v_definition := substring(v_definition FROM 1 FOR v_support_start - 1)
    || v_support_cte
    || substring(v_definition FROM v_response_start);

  IF position('COALESCE(family_product.parent_product_id, family_product.id)' IN v_definition) = 0
    OR position('public.current_user_can_access_storage(inventory_row.workspace_id, inventory_row.storage_id)' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'The product catalog family-variant rewrite was incomplete';
  END IF;

  EXECUTE v_definition;
END;
$catalog_family_variants$;

REVOKE ALL ON FUNCTION public.get_products_catalog_page(text,text,uuid[],uuid[],uuid[],text[],numeric,numeric,numeric,numeric,text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_products_catalog_page(text,text,uuid[],uuid[],uuid[],text[],numeric,numeric,numeric,numeric,text,integer,integer) TO authenticated;
