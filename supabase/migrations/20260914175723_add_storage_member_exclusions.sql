CREATE TABLE IF NOT EXISTS public.storage_member_exclusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  storage_id uuid NOT NULL REFERENCES public.storages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sync_status text NOT NULL DEFAULT 'synced',
  version bigint NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT storage_member_exclusions_workspace_storage_user_key
    UNIQUE (workspace_id, storage_id, user_id)
);

CREATE INDEX IF NOT EXISTS storage_member_exclusions_workspace_storage_idx
  ON public.storage_member_exclusions (workspace_id, storage_id)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS storage_member_exclusions_workspace_user_idx
  ON public.storage_member_exclusions (workspace_id, user_id)
  WHERE is_deleted = false;

DROP TRIGGER IF EXISTS update_storage_member_exclusions_updated_at ON public.storage_member_exclusions;
CREATE TRIGGER update_storage_member_exclusions_updated_at
  BEFORE UPDATE ON public.storage_member_exclusions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- This lookup is deliberately isolated from policies on the tables it
-- protects, avoiding recursive RLS evaluation while never trusting JWT
-- user metadata for authorization.
CREATE OR REPLACE FUNCTION public.current_user_can_access_storage(
  p_workspace_id uuid,
  p_storage_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    p_workspace_id = public.current_workspace_id()
    AND (
      public.current_user_role() = 'admin'
      OR NOT EXISTS (
        SELECT 1
        FROM public.storage_member_exclusions exclusion
        WHERE exclusion.workspace_id = p_workspace_id
          AND exclusion.storage_id = p_storage_id
          AND exclusion.user_id = auth.uid()
          AND exclusion.is_deleted = false
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.enforce_storage_member_exclusion_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.storages storage
    WHERE storage.id = NEW.storage_id
      AND storage.workspace_id = NEW.workspace_id
      AND COALESCE(storage.is_deleted, false) = false
  ) THEN
    RAISE EXCEPTION 'Storage exclusion must target a storage in the same workspace'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles profile
    WHERE profile.id = NEW.user_id
      AND profile.workspace_id = NEW.workspace_id
      AND profile.role <> 'admin'
  ) THEN
    RAISE EXCEPTION 'Storage exclusions can only target non-admin workspace members'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_storage_member_exclusion_scope ON public.storage_member_exclusions;
CREATE TRIGGER enforce_storage_member_exclusion_scope
  BEFORE INSERT OR UPDATE OF workspace_id, storage_id, user_id
  ON public.storage_member_exclusions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_storage_member_exclusion_scope();

ALTER TABLE public.storage_member_exclusions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS storage_member_exclusions_select ON public.storage_member_exclusions;
CREATE POLICY storage_member_exclusions_select
  ON public.storage_member_exclusions
  FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (public.current_user_role() = 'admin' OR user_id = auth.uid())
  );

DROP POLICY IF EXISTS storage_member_exclusions_insert ON public.storage_member_exclusions;
CREATE POLICY storage_member_exclusions_insert
  ON public.storage_member_exclusions
  FOR INSERT TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() = 'admin'
  );

DROP POLICY IF EXISTS storage_member_exclusions_update ON public.storage_member_exclusions;
CREATE POLICY storage_member_exclusions_update
  ON public.storage_member_exclusions
  FOR UPDATE TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() = 'admin'
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() = 'admin'
  );

DROP POLICY IF EXISTS storage_member_exclusions_delete ON public.storage_member_exclusions;
CREATE POLICY storage_member_exclusions_delete
  ON public.storage_member_exclusions
  FOR DELETE TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() = 'admin'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.storage_member_exclusions TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.current_user_can_access_storage(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_can_access_storage(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_storage_member_exclusion_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_storage_member_exclusion_scope() TO authenticated, service_role;

-- Replace the generic workspace-only policies with storage-aware policies.
-- A member may still work with every other storage by default; only a matching
-- exclusion removes rows from this scope.
DROP POLICY IF EXISTS storages_select ON public.storages;
DROP POLICY IF EXISTS storages_insert ON public.storages;
DROP POLICY IF EXISTS storages_update ON public.storages;
DROP POLICY IF EXISTS storages_delete ON public.storages;
CREATE POLICY storages_select ON public.storages FOR SELECT TO authenticated
  USING (public.current_user_can_access_storage(workspace_id, id));
CREATE POLICY storages_insert ON public.storages FOR INSERT TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );
CREATE POLICY storages_update ON public.storages FOR UPDATE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, id)
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );
CREATE POLICY storages_delete ON public.storages FOR DELETE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, id)
  );

DROP POLICY IF EXISTS inventory_select ON public.inventory;
DROP POLICY IF EXISTS inventory_insert ON public.inventory;
DROP POLICY IF EXISTS inventory_update ON public.inventory;
DROP POLICY IF EXISTS inventory_delete ON public.inventory;
CREATE POLICY inventory_select ON public.inventory FOR SELECT TO authenticated
  USING (public.current_user_can_access_storage(workspace_id, storage_id));
CREATE POLICY inventory_insert ON public.inventory FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  );
CREATE POLICY inventory_update ON public.inventory FOR UPDATE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  )
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  );
CREATE POLICY inventory_delete ON public.inventory FOR DELETE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  );

DROP POLICY IF EXISTS stock_batches_select ON public.stock_batches;
DROP POLICY IF EXISTS stock_batches_insert ON public.stock_batches;
DROP POLICY IF EXISTS stock_batches_update ON public.stock_batches;
DROP POLICY IF EXISTS stock_batches_delete ON public.stock_batches;
CREATE POLICY stock_batches_select ON public.stock_batches FOR SELECT TO authenticated
  USING (public.current_user_can_access_storage(workspace_id, storage_id));
CREATE POLICY stock_batches_insert ON public.stock_batches FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  );
CREATE POLICY stock_batches_update ON public.stock_batches FOR UPDATE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  )
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  );
CREATE POLICY stock_batches_delete ON public.stock_batches FOR DELETE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  );

DROP POLICY IF EXISTS inventory_transactions_select ON public.inventory_transactions;
DROP POLICY IF EXISTS inventory_transactions_insert ON public.inventory_transactions;
DROP POLICY IF EXISTS inventory_transactions_update ON public.inventory_transactions;
DROP POLICY IF EXISTS inventory_transactions_delete ON public.inventory_transactions;
CREATE POLICY inventory_transactions_select ON public.inventory_transactions FOR SELECT TO authenticated
  USING (public.current_user_can_access_storage(workspace_id, storage_id));
CREATE POLICY inventory_transactions_insert ON public.inventory_transactions FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND transaction_type = 'stock_adjustment'
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  );
CREATE POLICY inventory_transactions_update ON public.inventory_transactions FOR UPDATE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND transaction_type = 'stock_adjustment'
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  )
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND transaction_type = 'stock_adjustment'
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  );
CREATE POLICY inventory_transactions_delete ON public.inventory_transactions FOR DELETE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND transaction_type = 'stock_adjustment'
    AND public.current_user_can_access_storage(workspace_id, storage_id)
  );

DROP POLICY IF EXISTS products_select ON public.products;
DROP POLICY IF EXISTS products_insert ON public.products;
DROP POLICY IF EXISTS products_update ON public.products;
DROP POLICY IF EXISTS products_delete ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
    AND (
      COALESCE(is_service, false)
      OR storage_id IS NULL
      OR public.current_user_can_access_storage(workspace_id, storage_id)
      OR EXISTS (
        SELECT 1
        FROM public.inventory inventory_row
        WHERE inventory_row.workspace_id = products.workspace_id
          AND inventory_row.product_id = products.id
          AND COALESCE(inventory_row.is_deleted, false) = false
          AND public.current_user_can_access_storage(inventory_row.workspace_id, inventory_row.storage_id)
      )
    )
  );
CREATE POLICY products_insert ON public.products FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND workspace_id = public.current_workspace_id()
    AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
    AND (storage_id IS NULL OR public.current_user_can_access_storage(workspace_id, storage_id))
  );
CREATE POLICY products_update ON public.products FOR UPDATE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND workspace_id = public.current_workspace_id()
    AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
    AND (
      COALESCE(is_service, false)
      OR storage_id IS NULL
      OR public.current_user_can_access_storage(workspace_id, storage_id)
      OR EXISTS (
        SELECT 1
        FROM public.inventory inventory_row
        WHERE inventory_row.workspace_id = products.workspace_id
          AND inventory_row.product_id = products.id
          AND COALESCE(inventory_row.is_deleted, false) = false
          AND public.current_user_can_access_storage(inventory_row.workspace_id, inventory_row.storage_id)
      )
    )
  )
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND workspace_id = public.current_workspace_id()
    AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
    AND (
      storage_id IS NULL
      OR public.current_user_can_access_storage(workspace_id, storage_id)
      OR EXISTS (
        SELECT 1
        FROM public.inventory inventory_row
        WHERE inventory_row.workspace_id = products.workspace_id
          AND inventory_row.product_id = products.id
          AND COALESCE(inventory_row.is_deleted, false) = false
          AND public.current_user_can_access_storage(inventory_row.workspace_id, inventory_row.storage_id)
      )
    )
  );
CREATE POLICY products_delete ON public.products FOR DELETE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND workspace_id = public.current_workspace_id()
    AND (NOT COALESCE(is_service, false) OR public.services_module_allowed(workspace_id))
  );

DROP POLICY IF EXISTS sale_items_select ON public.sale_items;
DROP POLICY IF EXISTS sale_items_insert ON public.sale_items;
DROP POLICY IF EXISTS sale_items_update ON public.sale_items;
DROP POLICY IF EXISTS sale_items_delete ON public.sale_items;
CREATE POLICY sale_items_select ON public.sale_items FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND (storage_id IS NULL OR public.current_user_can_access_storage(workspace_id, storage_id))
    AND EXISTS (
      SELECT 1
      FROM public.sales AS sale
      WHERE sale.id = sale_items.sale_id
        AND sale.workspace_id = sale_items.workspace_id
        AND (
          NOT (SELECT public.current_user_has_view_own_permission('sales.view_own'))
          OR sale.cashier_id = (SELECT auth.uid())
        )
    )
  );
CREATE POLICY sale_items_insert ON public.sale_items FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND workspace_id = public.current_workspace_id()
    AND (storage_id IS NULL OR public.current_user_can_access_storage(workspace_id, storage_id))
  );
CREATE POLICY sale_items_update ON public.sale_items FOR UPDATE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND workspace_id = public.current_workspace_id()
    AND (storage_id IS NULL OR public.current_user_can_access_storage(workspace_id, storage_id))
  )
  WITH CHECK (
    public.current_user_role() IN ('admin', 'staff')
    AND workspace_id = public.current_workspace_id()
    AND (storage_id IS NULL OR public.current_user_can_access_storage(workspace_id, storage_id))
  );
CREATE POLICY sale_items_delete ON public.sale_items FOR DELETE TO authenticated
  USING (
    public.current_user_role() IN ('admin', 'staff')
    AND workspace_id = public.current_workspace_id()
    AND (storage_id IS NULL OR public.current_user_can_access_storage(workspace_id, storage_id))
  );

-- A stale client must not create or amend an order line for an excluded
-- storage, even when it bypasses the location selectors in the UI.
CREATE OR REPLACE FUNCTION public.assert_order_item_storage_access(
  p_workspace_id uuid,
  p_default_storage_id uuid,
  p_items jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  item jsonb;
  item_storage_id uuid;
BEGIN
  -- Server-side/system workflows do not carry an end-user JWT. Their own
  -- privileged RPCs retain responsibility for validating their input.
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    item_storage_id := COALESCE(
      NULLIF(item ->> 'storageId', '')::uuid,
      NULLIF(item ->> 'storage_id', '')::uuid,
      p_default_storage_id
    );
    IF item_storage_id IS NOT NULL
      AND NOT public.current_user_can_access_storage(p_workspace_id, item_storage_id) THEN
      RAISE EXCEPTION 'Storage access is denied for this order line'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_sales_order_storage_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_order_item_storage_access(
    NEW.workspace_id,
    NEW.source_storage_id,
    NEW.items
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_purchase_order_storage_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_order_item_storage_access(
    NEW.workspace_id,
    NEW.destination_storage_id,
    NEW.items
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_sales_order_storage_access ON crm.sales_orders;
CREATE TRIGGER enforce_sales_order_storage_access
  BEFORE INSERT OR UPDATE OF workspace_id, source_storage_id, items
  ON crm.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_order_storage_access();

DROP TRIGGER IF EXISTS enforce_purchase_order_storage_access ON crm.purchase_orders;
CREATE TRIGGER enforce_purchase_order_storage_access
  BEFORE INSERT OR UPDATE OF workspace_id, destination_storage_id, items
  ON crm.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_purchase_order_storage_access();

REVOKE ALL ON FUNCTION public.assert_order_item_storage_access(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_sales_order_storage_access() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_purchase_order_storage_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_order_item_storage_access(uuid, uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_sales_order_storage_access() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_purchase_order_storage_access() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
