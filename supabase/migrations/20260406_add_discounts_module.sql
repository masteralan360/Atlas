ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS discounts boolean;

UPDATE public.workspaces
SET discounts = COALESCE(discounts, true);

ALTER TABLE public.workspaces
  ALTER COLUMN discounts SET DEFAULT true;

ALTER TABLE public.workspaces
  ALTER COLUMN discounts SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.product_discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  discount_type text NOT NULL,
  discount_value numeric NOT NULL,
  starts_at timestamp with time zone NOT NULL,
  ends_at timestamp with time zone NOT NULL,
  min_stock_threshold integer NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT product_discounts_discount_type_check
    CHECK (discount_type IN ('percentage', 'fixed_amount')),
  CONSTRAINT product_discounts_discount_value_check
    CHECK (discount_value > 0),
  CONSTRAINT product_discounts_date_range_check
    CHECK (ends_at > starts_at),
  CONSTRAINT product_discounts_min_stock_threshold_check
    CHECK (min_stock_threshold IS NULL OR min_stock_threshold >= 0)
);

CREATE TABLE IF NOT EXISTS public.category_discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  discount_type text NOT NULL,
  discount_value numeric NOT NULL,
  starts_at timestamp with time zone NOT NULL,
  ends_at timestamp with time zone NOT NULL,
  min_stock_threshold integer NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT category_discounts_discount_type_check
    CHECK (discount_type IN ('percentage', 'fixed_amount')),
  CONSTRAINT category_discounts_discount_value_check
    CHECK (discount_value > 0),
  CONSTRAINT category_discounts_date_range_check
    CHECK (ends_at > starts_at),
  CONSTRAINT category_discounts_min_stock_threshold_check
    CHECK (min_stock_threshold IS NULL OR min_stock_threshold >= 0)
);

CREATE INDEX IF NOT EXISTS idx_product_discounts_workspace
  ON public.product_discounts (workspace_id);

CREATE INDEX IF NOT EXISTS idx_product_discounts_workspace_product
  ON public.product_discounts (workspace_id, product_id);

CREATE INDEX IF NOT EXISTS idx_product_discounts_workspace_updated
  ON public.product_discounts (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_category_discounts_workspace
  ON public.category_discounts (workspace_id);

CREATE INDEX IF NOT EXISTS idx_category_discounts_workspace_category
  ON public.category_discounts (workspace_id, category_id);

CREATE INDEX IF NOT EXISTS idx_category_discounts_workspace_updated
  ON public.category_discounts (workspace_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_discounts_active_product
  ON public.product_discounts (product_id)
  WHERE is_active = true
    AND is_deleted = false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_category_discounts_active_category
  ON public.category_discounts (category_id)
  WHERE is_active = true
    AND is_deleted = false;

DROP TRIGGER IF EXISTS update_product_discounts_updated_at ON public.product_discounts;
CREATE TRIGGER update_product_discounts_updated_at
BEFORE UPDATE ON public.product_discounts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_category_discounts_updated_at ON public.category_discounts;
CREATE TRIGGER update_category_discounts_updated_at
BEFORE UPDATE ON public.category_discounts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.product_discounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.category_discounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_discounts_select ON public.product_discounts;
CREATE POLICY product_discounts_select
  ON public.product_discounts
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS product_discounts_insert ON public.product_discounts;
CREATE POLICY product_discounts_insert
  ON public.product_discounts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS product_discounts_update ON public.product_discounts;
CREATE POLICY product_discounts_update
  ON public.product_discounts
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS product_discounts_delete ON public.product_discounts;
CREATE POLICY product_discounts_delete
  ON public.product_discounts
  FOR DELETE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS category_discounts_select ON public.category_discounts;
CREATE POLICY category_discounts_select
  ON public.category_discounts
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

DROP POLICY IF EXISTS category_discounts_insert ON public.category_discounts;
CREATE POLICY category_discounts_insert
  ON public.category_discounts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS category_discounts_update ON public.category_discounts;
CREATE POLICY category_discounts_update
  ON public.category_discounts
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS category_discounts_delete ON public.category_discounts;
CREATE POLICY category_discounts_delete
  ON public.category_discounts
  FOR DELETE
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );

CREATE OR REPLACE FUNCTION public.get_active_discounts_for_workspace(p_workspace_id uuid)
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
  IF p_workspace_id IS NULL THEN
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

REVOKE ALL ON FUNCTION public.get_active_discounts_for_workspace(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_discounts_for_workspace(uuid) TO authenticated, service_role;
