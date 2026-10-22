-- Product-to-storage membership is independent from current stock.  Inventory
-- snapshots may clear products.storage_id when a position reaches zero, while
-- this relation preserves the catalog's storage boundary.
CREATE TABLE IF NOT EXISTS public.product_storage_assignments (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  storage_id uuid NOT NULL REFERENCES public.storages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT product_storage_assignments_workspace_product_storage_key
    UNIQUE (workspace_id, product_id, storage_id),
  CONSTRAINT product_storage_assignments_id_matches_pair
    CHECK (id = product_id::text || ':' || storage_id::text)
);

CREATE INDEX IF NOT EXISTS idx_product_storage_assignments_workspace_product
  ON public.product_storage_assignments (workspace_id, product_id)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_product_storage_assignments_workspace_storage
  ON public.product_storage_assignments (workspace_id, storage_id)
  WHERE is_deleted = false;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS storage_scope text NOT NULL DEFAULT 'unresolved';

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_storage_scope_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_storage_scope_check
  CHECK (storage_scope IN ('workspace', 'storage', 'unresolved'));

-- Seed current stock locations and retained zero-stock positions. A last
-- transfer_out means the position was moved away; all other tombstones remain
-- assignments. When old records have no movement ledger, retain their
-- association conservatively rather than making the product workspace-wide.
WITH latest_position_movement AS (
  SELECT DISTINCT ON (transaction_row.workspace_id, transaction_row.product_id, transaction_row.storage_id)
    transaction_row.workspace_id,
    transaction_row.product_id,
    transaction_row.storage_id,
    transaction_row.transaction_type
  FROM public.inventory_transactions AS transaction_row
  WHERE COALESCE(transaction_row.is_deleted, false) = false
  ORDER BY transaction_row.workspace_id,
           transaction_row.product_id,
           transaction_row.storage_id,
           transaction_row.created_at DESC,
           transaction_row.id DESC
),
assignment_candidates AS (
  SELECT product.workspace_id, product.id AS product_id, product.storage_id
  FROM public.products AS product
  WHERE product.storage_id IS NOT NULL
    AND COALESCE(product.is_service, false) = false
  UNION
  SELECT inventory_row.workspace_id, inventory_row.product_id, inventory_row.storage_id
  FROM public.inventory AS inventory_row
  INNER JOIN public.products AS product
    ON product.id = inventory_row.product_id
   AND product.workspace_id = inventory_row.workspace_id
  LEFT JOIN latest_position_movement AS latest_movement
    ON latest_movement.workspace_id = inventory_row.workspace_id
   AND latest_movement.product_id = inventory_row.product_id
   AND latest_movement.storage_id = inventory_row.storage_id
  WHERE COALESCE(product.is_service, false) = false
    AND (
      COALESCE(inventory_row.is_deleted, false) = false
      OR latest_movement.transaction_type IS DISTINCT FROM 'transfer_out'
    )
  UNION
  SELECT latest_movement.workspace_id, latest_movement.product_id, latest_movement.storage_id
  FROM latest_position_movement AS latest_movement
  INNER JOIN public.products AS product
    ON product.id = latest_movement.product_id
   AND product.workspace_id = latest_movement.workspace_id
  WHERE COALESCE(product.is_service, false) = false
    AND latest_movement.transaction_type IS DISTINCT FROM 'transfer_out'
)
INSERT INTO public.product_storage_assignments (
  id, workspace_id, product_id, storage_id, created_at, updated_at, version, is_deleted
)
SELECT DISTINCT
  candidate.product_id::text || ':' || candidate.storage_id::text,
  candidate.workspace_id,
  candidate.product_id,
  candidate.storage_id,
  timezone('utc', now()),
  timezone('utc', now()),
  1,
  false
FROM assignment_candidates AS candidate
INNER JOIN public.storages AS storage
  ON storage.id = candidate.storage_id
 AND storage.workspace_id = candidate.workspace_id
ON CONFLICT (workspace_id, product_id, storage_id) DO NOTHING;

UPDATE public.products AS product
SET storage_scope = CASE
  WHEN COALESCE(product.is_service, false) THEN 'workspace'
  WHEN EXISTS (
    SELECT 1
    FROM public.product_storage_assignments AS assignment
    WHERE assignment.workspace_id = product.workspace_id
      AND assignment.product_id = product.id
      AND assignment.is_deleted = false
  ) THEN 'storage'
  ELSE 'unresolved'
END
WHERE product.storage_scope IS DISTINCT FROM CASE
  WHEN COALESCE(product.is_service, false) THEN 'workspace'
  WHEN EXISTS (
    SELECT 1
    FROM public.product_storage_assignments AS assignment
    WHERE assignment.workspace_id = product.workspace_id
      AND assignment.product_id = product.id
      AND assignment.is_deleted = false
  ) THEN 'storage'
  ELSE 'unresolved'
END;

ALTER TABLE public.product_storage_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_storage_assignments FROM anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.product_storage_assignments TO authenticated;
GRANT ALL ON TABLE public.product_storage_assignments TO service_role;

DROP POLICY IF EXISTS product_storage_assignments_select ON public.product_storage_assignments;
CREATE POLICY product_storage_assignments_select
  ON public.product_storage_assignments FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND is_deleted = false
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  );

DROP POLICY IF EXISTS product_storage_assignments_insert ON public.product_storage_assignments;
CREATE POLICY product_storage_assignments_insert
  ON public.product_storage_assignments FOR INSERT TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND is_deleted = false
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
    AND EXISTS (
      SELECT 1
      FROM public.products AS product
      WHERE product.id = product_storage_assignments.product_id
        AND product.workspace_id = product_storage_assignments.workspace_id
        AND COALESCE(product.is_deleted, false) = false
        AND COALESCE(product.is_service, false) = false
    )
  );

DROP POLICY IF EXISTS product_storage_assignments_update ON public.product_storage_assignments;
CREATE POLICY product_storage_assignments_update
  ON public.product_storage_assignments FOR UPDATE TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
    AND EXISTS (
      SELECT 1
      FROM public.products AS product
      WHERE product.id = product_storage_assignments.product_id
        AND product.workspace_id = product_storage_assignments.workspace_id
        AND COALESCE(product.is_deleted, false) = false
        AND COALESCE(product.is_service, false) = false
    )
  );

CREATE OR REPLACE FUNCTION public.ensure_product_storage_assignment_from_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  INSERT INTO public.product_storage_assignments (
    id, workspace_id, product_id, storage_id, created_at, updated_at, version, is_deleted
  )
  SELECT
    NEW.product_id::text || ':' || NEW.storage_id::text,
    NEW.workspace_id,
    NEW.product_id,
    NEW.storage_id,
    timezone('utc', now()),
    timezone('utc', now()),
    1,
    false
  FROM public.products AS product
  WHERE product.id = NEW.product_id
    AND product.workspace_id = NEW.workspace_id
    AND COALESCE(product.is_service, false) = false
  ON CONFLICT (workspace_id, product_id, storage_id)
  DO UPDATE SET
    is_deleted = false,
    updated_at = timezone('utc', now()),
    version = product_storage_assignments.version + 1
  WHERE public.product_storage_assignments.is_deleted = true;

  UPDATE public.products AS product
  SET storage_scope = 'storage'
  WHERE product.id = NEW.product_id
    AND product.workspace_id = NEW.workspace_id
    AND COALESCE(product.is_service, false) = false
    AND product.storage_scope IS DISTINCT FROM 'storage';

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_product_storage_assignment_from_inventory() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_inventory_ensure_product_storage_assignment ON public.inventory;
CREATE TRIGGER trg_inventory_ensure_product_storage_assignment
AFTER INSERT OR UPDATE OF workspace_id, product_id, storage_id ON public.inventory
FOR EACH ROW
EXECUTE FUNCTION public.ensure_product_storage_assignment_from_inventory();

CREATE OR REPLACE FUNCTION public.enforce_product_storage_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.storage_scope NOT IN ('workspace', 'storage', 'unresolved') THEN
    RAISE EXCEPTION 'Product storage scope is invalid' USING ERRCODE = '23514';
  END IF;

  IF COALESCE(NEW.is_service, false) THEN
    NEW.storage_scope := 'workspace';
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_storage_assignments AS assignment
    WHERE assignment.workspace_id = NEW.workspace_id
      AND assignment.product_id = NEW.id
      AND assignment.is_deleted = false
  ) THEN
    NEW.storage_scope := 'storage';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_product_storage_scope ON public.products;
CREATE TRIGGER trg_enforce_product_storage_scope
BEFORE INSERT OR UPDATE OF storage_scope, is_service, workspace_id ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.enforce_product_storage_scope();

CREATE OR REPLACE FUNCTION public.current_user_can_access_product_storage(
  p_workspace_id uuid,
  p_product_id uuid,
  p_storage_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p_workspace_id = public.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM public.products AS product
      WHERE product.id = p_product_id
        AND product.workspace_id = p_workspace_id
        AND COALESCE(product.is_deleted, false) = false
        AND (
          public.current_user_role() = 'admin'
          OR (
            product.storage_scope = 'workspace'
            AND (
              p_storage_id IS NULL
              OR public.current_user_can_access_storage(p_workspace_id, p_storage_id)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.inventory AS inventory_row
              WHERE inventory_row.workspace_id = p_workspace_id
                AND inventory_row.product_id = p_product_id
                AND COALESCE(inventory_row.is_deleted, false) = false
                AND NOT public.current_user_can_access_storage(p_workspace_id, inventory_row.storage_id)
            )
          )
          OR (
            product.storage_scope = 'storage'
            AND (
              EXISTS (
                SELECT 1
                FROM public.product_storage_assignments AS assignment
                WHERE assignment.workspace_id = p_workspace_id
                  AND assignment.product_id = p_product_id
                  AND assignment.is_deleted = false
              )
              OR (
                p_storage_id IS NOT NULL
                AND public.current_user_can_access_storage(p_workspace_id, p_storage_id)
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.product_storage_assignments AS assignment
              WHERE assignment.workspace_id = p_workspace_id
                AND assignment.product_id = p_product_id
                AND assignment.is_deleted = false
                AND NOT public.current_user_can_access_storage(p_workspace_id, assignment.storage_id)
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.inventory AS inventory_row
              WHERE inventory_row.workspace_id = p_workspace_id
                AND inventory_row.product_id = p_product_id
                AND COALESCE(inventory_row.is_deleted, false) = false
                AND NOT public.current_user_can_access_storage(p_workspace_id, inventory_row.storage_id)
            )
          )
        )
    );
$function$;

REVOKE ALL ON FUNCTION public.current_user_can_access_product_storage(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_can_access_product_storage(uuid, uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
    AND (
      COALESCE(is_service, false)
      OR public.current_user_can_access_product_storage(workspace_id, id, storage_id)
    )
  );

-- Make catalog storage filters independent of the stock snapshot and return
-- assignments with the server-paged rows so zero-stock products retain their
-- storage labels and filter membership in the UI.
DO $catalog_page$
DECLARE
  v_definition text;
  v_storage_filter constant text := $old_filter$
      AND (COALESCE(cardinality(p_storage_ids), 0) = 0 OR product.storage_id = ANY(p_storage_ids))
  $old_filter$;
  v_assignment_filter constant text := $new_filter$
      AND (
        COALESCE(cardinality(p_storage_ids), 0) = 0
        OR EXISTS (
          SELECT 1
          FROM public.product_storage_assignments AS assignment
          WHERE assignment.workspace_id = product.workspace_id
            AND assignment.product_id = product.id
            AND assignment.storage_id = ANY(p_storage_ids)
            AND assignment.is_deleted = false
        )
      )
  $new_filter$;
BEGIN
  SELECT pg_get_functiondef(
    'public.get_products_catalog_page(text,text,uuid[],uuid[],uuid[],text[],numeric,numeric,numeric,numeric,text,integer,integer)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL OR position(v_storage_filter IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected product catalog storage filter was not found';
  END IF;

  v_definition := replace(v_definition, v_storage_filter, v_assignment_filter);
  v_definition := replace(
    v_definition,
    $inventory_anchor$    'inventory', COALESCE(($inventory_anchor$,
    $assignment_output$    'product_storage_assignments', COALESCE((
      SELECT JSONB_AGG(TO_JSONB(assignment) ORDER BY assignment.product_id, assignment.storage_id)
      FROM public.product_storage_assignments AS assignment
      WHERE assignment.workspace_id = public.current_workspace_id()
        AND assignment.is_deleted = false
        AND EXISTS (
          SELECT 1 FROM response_products
          WHERE response_products.id = assignment.product_id
        )
    ), '[]'::jsonb),
    'inventory', COALESCE(($assignment_output$
  );

  IF position('product_storage_assignments' IN v_definition) = 0
    OR position(v_storage_filter IN v_definition) > 0 THEN
    RAISE EXCEPTION 'Product catalog storage assignment rewrite was incomplete';
  END IF;
  EXECUTE v_definition;
END;
$catalog_page$;

-- Storage-scoped autocomplete is SECURITY DEFINER, so it must apply the same
-- full product boundary explicitly instead of trusting product.storage_id.
DO $storage_autocomplete$
DECLARE
  v_definition text;
  v_product_storage_filter constant text := $old_product_filter$
              NOT normalized.require_positive_stock
              AND product.storage_id::text = normalized.required_storage_id
              AND public.current_user_can_access_storage(product.workspace_id, product.storage_id)
  $old_product_filter$;
  v_response_storage_filter constant text := $old_response_filter$
              NOT normalized.require_positive_stock
              AND response_rows.storage_id::text = normalized.required_storage_id
              AND public.current_user_can_access_storage(response_rows.workspace_id, response_rows.storage_id)
  $old_response_filter$;
  v_new_product_storage_filter constant text := $new_product_filter$
              NOT normalized.require_positive_stock
              AND (
                product.storage_scope = 'workspace'
                OR EXISTS (
                  SELECT 1
                  FROM public.product_storage_assignments AS assignment
                  WHERE assignment.workspace_id = product.workspace_id
                    AND assignment.product_id = product.id
                    AND assignment.storage_id::text = normalized.required_storage_id
                    AND assignment.is_deleted = false
                    AND public.current_user_can_access_storage(assignment.workspace_id, assignment.storage_id)
                )
                OR (
                  product.storage_id::text = normalized.required_storage_id
                  AND public.current_user_can_access_storage(product.workspace_id, product.storage_id)
                )
              )
  $new_product_filter$;
  v_new_response_storage_filter constant text := replace(
    replace(v_new_product_storage_filter, 'product.storage_scope', 'response_rows.storage_scope'),
    'product.', 'response_rows.'
  );
  v_access_anchor constant text := $access_anchor$
    FROM response_rows
    CROSS JOIN normalized
    WHERE (
  $access_anchor$;
  v_access_replacement constant text := $access_replacement$
    FROM response_rows
    CROSS JOIN normalized
    WHERE public.current_user_can_access_product_storage(
        response_rows.workspace_id,
        response_rows.id,
        response_rows.storage_id
      )
      AND (
  $access_replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'public.search_products_for_autocomplete_in_storage(uuid,text,text,boolean,uuid[],uuid[],integer)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL
    OR position(v_product_storage_filter IN v_definition) = 0
    OR position(v_response_storage_filter IN v_definition) = 0
    OR position(v_access_anchor IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected storage-scoped autocomplete filters were not found';
  END IF;

  v_definition := replace(v_definition, v_product_storage_filter, v_new_product_storage_filter);
  v_definition := replace(v_definition, v_response_storage_filter, v_new_response_storage_filter);
  v_definition := replace(v_definition, v_access_anchor, v_access_replacement);

  IF position('current_user_can_access_product_storage' IN v_definition) = 0
    OR position(v_product_storage_filter IN v_definition) > 0
    OR position(v_response_storage_filter IN v_definition) > 0 THEN
    RAISE EXCEPTION 'Storage-scoped autocomplete assignment rewrite was incomplete';
  END IF;
  EXECUTE v_definition;
END;
$storage_autocomplete$;

-- The unscoped autocomplete is also SECURITY DEFINER and is used by shared
-- product selectors. Keep it from surfacing a product that belongs to an
-- inaccessible storage, including products with no remaining stock row.
DO $product_autocomplete$
DECLARE
  v_definition text;
  v_anchor constant text := $anchor$
    FROM response_rows
    CROSS JOIN normalized
    ORDER BY
  $anchor$;
  v_replacement constant text := $replacement$
    FROM response_rows
    CROSS JOIN normalized
    WHERE public.current_user_can_access_product_storage(
      response_rows.workspace_id,
      response_rows.id,
      response_rows.storage_id
    )
    ORDER BY
  $replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'public.search_products_for_autocomplete(uuid,text,uuid[],uuid[],integer)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL OR position(v_anchor IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Expected product autocomplete response filter was not found';
  END IF;
  v_definition := replace(v_definition, v_anchor, v_replacement);
  IF position('current_user_can_access_product_storage' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Product autocomplete storage assignment rewrite was incomplete';
  END IF;
  EXECUTE v_definition;
END;
$product_autocomplete$;
