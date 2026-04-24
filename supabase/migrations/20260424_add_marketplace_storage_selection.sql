ALTER TABLE public.storages
  ADD COLUMN IF NOT EXISTS is_marketplace boolean NOT NULL DEFAULT false;

WITH ranked_storages AS (
  SELECT
    s.id,
    COALESCE(s.is_deleted, false) AS is_deleted,
    ROW_NUMBER() OVER (
      PARTITION BY s.workspace_id
      ORDER BY
        CASE
          WHEN COALESCE(s.is_deleted, false) = false AND COALESCE(s.is_marketplace, false) = true THEN 0
          WHEN COALESCE(s.is_deleted, false) = false AND COALESCE(s.is_primary, false) = true THEN 1
          WHEN COALESCE(s.is_deleted, false) = false AND s.is_system = true AND LOWER(s.name) = 'main' THEN 2
          WHEN COALESCE(s.is_deleted, false) = false THEN 3
          ELSE 4
        END,
        s.is_system DESC,
        s.is_protected DESC,
        s.created_at NULLS LAST,
        s.id
    ) AS storage_rank
  FROM public.storages s
),
normalized_storages AS (
  SELECT
    id,
    CASE
      WHEN is_deleted THEN false
      ELSE storage_rank = 1
    END AS should_be_marketplace
  FROM ranked_storages
)
UPDATE public.storages s
SET is_marketplace = normalized_storages.should_be_marketplace
FROM normalized_storages
WHERE s.id = normalized_storages.id
  AND COALESCE(s.is_marketplace, false) IS DISTINCT FROM normalized_storages.should_be_marketplace;

CREATE UNIQUE INDEX IF NOT EXISTS storages_workspace_active_marketplace_key
  ON public.storages (workspace_id)
  WHERE is_marketplace = true AND COALESCE(is_deleted, false) = false;

CREATE OR REPLACE FUNCTION public.ensure_marketplace_storage(p_workspace_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_marketplace_storage_id uuid;
BEGIN
  IF p_workspace_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id
  INTO v_marketplace_storage_id
  FROM public.storages
  WHERE workspace_id = p_workspace_id
    AND COALESCE(is_deleted, false) = false
    AND COALESCE(is_marketplace, false) = true
  ORDER BY is_primary DESC, is_system DESC, is_protected DESC, created_at NULLS LAST, id
  LIMIT 1;

  IF v_marketplace_storage_id IS NULL THEN
    SELECT id
    INTO v_marketplace_storage_id
    FROM public.storages
    WHERE workspace_id = p_workspace_id
      AND COALESCE(is_deleted, false) = false
      AND COALESCE(is_primary, false) = true
    ORDER BY is_system DESC, is_protected DESC, created_at NULLS LAST, id
    LIMIT 1;
  END IF;

  IF v_marketplace_storage_id IS NULL THEN
    SELECT id
    INTO v_marketplace_storage_id
    FROM public.storages
    WHERE workspace_id = p_workspace_id
      AND COALESCE(is_deleted, false) = false
    ORDER BY is_system DESC, is_protected DESC, created_at NULLS LAST, id
    LIMIT 1;
  END IF;

  IF v_marketplace_storage_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.storages
  SET
    is_marketplace = (id = v_marketplace_storage_id),
    updated_at = CASE
      WHEN COALESCE(is_marketplace, false) IS DISTINCT FROM (id = v_marketplace_storage_id)
        THEN timezone('utc', now())
      ELSE updated_at
    END
  WHERE workspace_id = p_workspace_id
    AND COALESCE(is_deleted, false) = false
    AND COALESCE(is_marketplace, false) IS DISTINCT FROM (id = v_marketplace_storage_id);

  RETURN v_marketplace_storage_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_marketplace_storage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_marketplace_storage(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.normalize_marketplace_storage_selection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF COALESCE(NEW.is_deleted, false) THEN
    NEW.is_marketplace := false;
  END IF;

  IF COALESCE(NEW.is_marketplace, false) THEN
    UPDATE public.storages
    SET
      is_marketplace = false,
      updated_at = CASE
        WHEN COALESCE(is_marketplace, false) = true THEN timezone('utc', now())
        ELSE updated_at
      END
    WHERE workspace_id = NEW.workspace_id
      AND id IS DISTINCT FROM NEW.id
      AND COALESCE(is_deleted, false) = false
      AND COALESCE(is_marketplace, false) = true;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS normalize_marketplace_storage_selection_on_storages ON public.storages;
CREATE TRIGGER normalize_marketplace_storage_selection_on_storages
BEFORE INSERT OR UPDATE OF is_marketplace, is_deleted, workspace_id ON public.storages
FOR EACH ROW
EXECUTE FUNCTION public.normalize_marketplace_storage_selection();

CREATE OR REPLACE FUNCTION public.ensure_workspace_marketplace_storage_selection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  v_old_workspace_id uuid := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.workspace_id END;
  v_new_workspace_id uuid := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.workspace_id END;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_old_workspace_id IS NOT NULL THEN
    PERFORM public.ensure_marketplace_storage(v_old_workspace_id);
  END IF;

  IF v_new_workspace_id IS NOT NULL AND v_new_workspace_id IS DISTINCT FROM v_old_workspace_id THEN
    PERFORM public.ensure_marketplace_storage(v_new_workspace_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS ensure_workspace_marketplace_storage_selection_on_storages ON public.storages;
CREATE TRIGGER ensure_workspace_marketplace_storage_selection_on_storages
AFTER INSERT OR UPDATE OF is_marketplace, is_deleted, workspace_id OR DELETE ON public.storages
FOR EACH ROW
EXECUTE FUNCTION public.ensure_workspace_marketplace_storage_selection();

CREATE OR REPLACE FUNCTION public.get_active_discounts_for_marketplace_storage(
  p_workspace_id uuid,
  p_storage_id uuid
)
RETURNS TABLE (
  product_id uuid,
  discount_type text,
  discount_value numeric,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  min_stock_threshold integer,
  source text,
  is_stock_ok boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_storage_id IS NULL THEN
    RETURN;
  END IF;

  IF auth.role() = 'authenticated' AND p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'Workspace access denied';
  END IF;

  RETURN QUERY
  WITH stock_totals AS (
    SELECT
      inventory.product_id,
      COALESCE(SUM(inventory.quantity), 0)::integer AS total_stock
    FROM public.inventory
    WHERE inventory.workspace_id = p_workspace_id
      AND inventory.storage_id = p_storage_id
      AND COALESCE(inventory.is_deleted, false) = false
    GROUP BY inventory.product_id
  ),
  active_product_discounts AS (
    SELECT
      pd.product_id,
      pd.discount_type,
      pd.discount_value,
      pd.starts_at,
      pd.ends_at,
      pd.min_stock_threshold,
      'product'::text AS source,
      ROW_NUMBER() OVER (
        PARTITION BY pd.product_id
        ORDER BY pd.starts_at DESC, pd.created_at DESC, pd.id DESC
      ) AS rn
    FROM public.product_discounts pd
    JOIN public.products p
      ON p.id = pd.product_id
     AND p.workspace_id = p_workspace_id
     AND COALESCE(p.is_deleted, false) = false
    WHERE pd.workspace_id = p_workspace_id
      AND COALESCE(pd.is_deleted, false) = false
      AND pd.is_active = true
      AND pd.starts_at <= timezone('utc', now())
      AND pd.ends_at >= timezone('utc', now())
  ),
  active_category_discounts AS (
    SELECT
      p.id AS product_id,
      cd.discount_type,
      cd.discount_value,
      cd.starts_at,
      cd.ends_at,
      cd.min_stock_threshold,
      'category'::text AS source,
      ROW_NUMBER() OVER (
        PARTITION BY p.id
        ORDER BY cd.starts_at DESC, cd.created_at DESC, cd.id DESC
      ) AS rn
    FROM public.category_discounts cd
    JOIN public.products p
      ON p.category_id = cd.category_id
     AND p.workspace_id = p_workspace_id
     AND COALESCE(p.is_deleted, false) = false
    WHERE cd.workspace_id = p_workspace_id
      AND COALESCE(cd.is_deleted, false) = false
      AND cd.is_active = true
      AND cd.starts_at <= timezone('utc', now())
      AND cd.ends_at >= timezone('utc', now())
  ),
  resolved_discounts AS (
    SELECT
      apd.product_id,
      apd.discount_type,
      apd.discount_value,
      apd.starts_at,
      apd.ends_at,
      apd.min_stock_threshold,
      apd.source
    FROM active_product_discounts apd
    WHERE apd.rn = 1

    UNION ALL

    SELECT
      acd.product_id,
      acd.discount_type,
      acd.discount_value,
      acd.starts_at,
      acd.ends_at,
      acd.min_stock_threshold,
      acd.source
    FROM active_category_discounts acd
    WHERE acd.rn = 1
      AND NOT EXISTS (
        SELECT 1
        FROM active_product_discounts apd
        WHERE apd.product_id = acd.product_id
          AND apd.rn = 1
      )
  )
  SELECT
    rd.product_id,
    rd.discount_type,
    rd.discount_value,
    rd.starts_at,
    rd.ends_at,
    rd.min_stock_threshold,
    rd.source,
    CASE
      WHEN rd.min_stock_threshold IS NULL THEN true
      ELSE COALESCE(st.total_stock, 0) >= rd.min_stock_threshold
    END AS is_stock_ok
  FROM resolved_discounts rd
  LEFT JOIN stock_totals st
    ON st.product_id = rd.product_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_active_discounts_for_marketplace_storage(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_discounts_for_marketplace_storage(uuid, uuid) TO authenticated, service_role;
