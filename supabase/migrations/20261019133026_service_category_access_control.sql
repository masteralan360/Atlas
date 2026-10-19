-- Many-to-many service access grants. The legacy flag preserves existing
-- workspace-wide service visibility until an administrator assigns categories.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS service_legacy_workspace_access boolean NOT NULL DEFAULT false;

UPDATE public.products
SET service_legacy_workspace_access = true
WHERE COALESCE(is_service, false) = true
  AND COALESCE(is_deleted, false) = false;

CREATE TABLE IF NOT EXISTS public.service_access_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS service_access_categories_workspace_name_unique
  ON public.service_access_categories (workspace_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.service_access_category_members (
  workspace_id uuid NOT NULL,
  category_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, category_id, user_id),
  FOREIGN KEY (workspace_id, category_id)
    REFERENCES public.service_access_categories(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS service_access_members_workspace_user_idx
  ON public.service_access_category_members (workspace_id, user_id, category_id);

CREATE TABLE IF NOT EXISTS public.service_access_category_services (
  workspace_id uuid NOT NULL,
  category_id uuid NOT NULL,
  service_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, category_id, service_id),
  FOREIGN KEY (workspace_id, category_id)
    REFERENCES public.service_access_categories(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS service_access_services_workspace_service_idx
  ON public.service_access_category_services (workspace_id, service_id, category_id);

ALTER TABLE public.service_access_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_access_category_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_access_category_services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_access_categories_select_admin ON public.service_access_categories;
CREATE POLICY service_access_categories_select_admin
  ON public.service_access_categories FOR SELECT TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin');
DROP POLICY IF EXISTS service_access_categories_insert_admin ON public.service_access_categories;
CREATE POLICY service_access_categories_insert_admin
  ON public.service_access_categories FOR INSERT TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin');
DROP POLICY IF EXISTS service_access_categories_update_admin ON public.service_access_categories;
CREATE POLICY service_access_categories_update_admin
  ON public.service_access_categories FOR UPDATE TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin')
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin');
DROP POLICY IF EXISTS service_access_categories_delete_admin ON public.service_access_categories;
CREATE POLICY service_access_categories_delete_admin
  ON public.service_access_categories FOR DELETE TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin');

DROP POLICY IF EXISTS service_access_category_members_select_admin ON public.service_access_category_members;
CREATE POLICY service_access_category_members_select_admin
  ON public.service_access_category_members FOR SELECT TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin');
DROP POLICY IF EXISTS service_access_category_members_insert_admin ON public.service_access_category_members;
CREATE POLICY service_access_category_members_insert_admin
  ON public.service_access_category_members FOR INSERT TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin');
DROP POLICY IF EXISTS service_access_category_members_delete_admin ON public.service_access_category_members;
CREATE POLICY service_access_category_members_delete_admin
  ON public.service_access_category_members FOR DELETE TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin');

DROP POLICY IF EXISTS service_access_category_services_select_admin ON public.service_access_category_services;
CREATE POLICY service_access_category_services_select_admin
  ON public.service_access_category_services FOR SELECT TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin');
DROP POLICY IF EXISTS service_access_category_services_insert_admin ON public.service_access_category_services;
CREATE POLICY service_access_category_services_insert_admin
  ON public.service_access_category_services FOR INSERT TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin');
DROP POLICY IF EXISTS service_access_category_services_delete_admin ON public.service_access_category_services;
CREATE POLICY service_access_category_services_delete_admin
  ON public.service_access_category_services FOR DELETE TO authenticated
  USING (workspace_id = public.current_workspace_id() AND public.current_user_role() = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_access_categories TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.service_access_category_members TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.service_access_category_services TO authenticated;

CREATE OR REPLACE FUNCTION public.service_access_user_in_workspace(
  p_user_id uuid,
  p_workspace_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    WHERE profile.id = p_user_id
      AND (
        profile.workspace_id = p_workspace_id
        OR profile.current_workspace = p_workspace_id
        OR EXISTS (
          SELECT 1
          FROM public.workspace_branches AS branch
          WHERE branch.source_workspace_id = profile.workspace_id
            AND branch.branch_workspace_id = p_workspace_id
            AND branch.archived_at IS NULL
        )
      )
  );
$function$;

REVOKE ALL ON FUNCTION public.service_access_user_in_workspace(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.service_access_user_in_workspace(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_service_access_category_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR public.current_user_role() IS DISTINCT FROM 'admin'
  THEN
    RAISE EXCEPTION 'Only a workspace administrator can manage service access members'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.service_access_user_in_workspace(NEW.user_id, NEW.workspace_id) THEN
    RAISE EXCEPTION 'The selected user is not a member of this workspace'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS service_access_category_member_workspace_guard
  ON public.service_access_category_members;
CREATE TRIGGER service_access_category_member_workspace_guard
  BEFORE INSERT OR UPDATE ON public.service_access_category_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_access_category_member();

CREATE OR REPLACE FUNCTION public.enforce_service_access_category_service()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR public.current_user_role() IS DISTINCT FROM 'admin'
  THEN
    RAISE EXCEPTION 'Only a workspace administrator can assign services to access categories'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.products AS product
    WHERE product.id = NEW.service_id
      AND product.workspace_id = NEW.workspace_id
      AND COALESCE(product.is_service, false) = true
  ) THEN
    RAISE EXCEPTION 'The selected service is not in this workspace'
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('atlas.service_access_internal', 'on', true);
  UPDATE public.products
  SET service_legacy_workspace_access = false
  WHERE id = NEW.service_id AND workspace_id = NEW.workspace_id;
  PERFORM set_config('atlas.service_access_internal', 'off', true);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS service_access_category_service_workspace_guard
  ON public.service_access_category_services;
CREATE TRIGGER service_access_category_service_workspace_guard
  BEFORE INSERT OR UPDATE ON public.service_access_category_services
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_access_category_service();

CREATE OR REPLACE FUNCTION public.can_access_service(
  p_user_id uuid,
  p_service_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    p_user_id = auth.uid()
    AND product.workspace_id = public.current_workspace_id()
    AND public.service_access_user_in_workspace(p_user_id, product.workspace_id)
    AND public.services_module_allowed(product.workspace_id)
    AND (
      public.current_user_role() = 'admin'
      OR product.service_legacy_workspace_access
      OR EXISTS (
        SELECT 1
        FROM public.service_access_category_services AS service_category
        INNER JOIN public.service_access_category_members AS category_member
          ON category_member.workspace_id = service_category.workspace_id
          AND category_member.category_id = service_category.category_id
        WHERE service_category.workspace_id = product.workspace_id
          AND service_category.service_id = product.id
          AND category_member.user_id = p_user_id
      )
    ),
    false
  )
  FROM public.products AS product
  WHERE product.id = p_service_id
    AND COALESCE(product.is_service, false) = true;
$function$;

REVOKE ALL ON FUNCTION public.can_access_service(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_access_service(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_accessible_service_ids(p_workspace_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  SELECT product.id
  FROM public.products AS product
  WHERE p_workspace_id = public.current_workspace_id()
    AND product.workspace_id = p_workspace_id
    AND COALESCE(product.is_service, false) = true
    AND COALESCE(product.is_deleted, false) = false
    AND public.can_access_service(auth.uid(), product.id);
$function$;

REVOKE ALL ON FUNCTION public.get_accessible_service_ids(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_accessible_service_ids(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_service_access_workspace_members(p_workspace_id uuid)
RETURNS TABLE(id uuid, name text, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT profile.id, COALESCE(profile.name, ''), COALESCE(profile.role::text, '')
  FROM public.profiles AS profile
  WHERE auth.uid() IS NOT NULL
    AND p_workspace_id = public.current_workspace_id()
    AND public.current_user_role() = 'admin'
    AND public.service_access_user_in_workspace(profile.id, p_workspace_id)
  ORDER BY lower(COALESCE(profile.name, '')), profile.id;
$function$;

REVOKE ALL ON FUNCTION public.get_service_access_workspace_members(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_service_access_workspace_members(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_service_access_settings(p_service_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_legacy_access boolean;
  v_category_ids uuid[];
BEGIN
  IF public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only a workspace administrator can view service access settings'
      USING ERRCODE = '42501';
  END IF;

  SELECT product.service_legacy_workspace_access
  INTO v_legacy_access
  FROM public.products AS product
  WHERE product.id = p_service_id
    AND product.workspace_id = v_workspace_id
    AND COALESCE(product.is_service, false) = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service not found in this workspace' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(array_agg(assignment.category_id ORDER BY assignment.category_id), ARRAY[]::uuid[])
  INTO v_category_ids
  FROM public.service_access_category_services AS assignment
  WHERE assignment.workspace_id = v_workspace_id
    AND assignment.service_id = p_service_id;

  RETURN jsonb_build_object(
    'category_ids', to_jsonb(v_category_ids),
    'legacy_workspace_access', v_legacy_access
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_service_access_settings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_service_access_settings(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_service_access_categories(
  p_service_id uuid,
  p_category_ids uuid[]
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_category_ids uuid[] := COALESCE(p_category_ids, ARRAY[]::uuid[]);
BEGIN
  IF auth.uid() IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only a workspace administrator can assign service access categories'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products AS product
    WHERE product.id = p_service_id
      AND product.workspace_id = v_workspace_id
      AND COALESCE(product.is_service, false) = true
  ) THEN
    RAISE EXCEPTION 'Service not found in this workspace' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_category_ids) AS requested(category_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.service_access_categories AS category
      WHERE category.id = requested.category_id
        AND category.workspace_id = v_workspace_id
    )
  ) THEN
    RAISE EXCEPTION 'One or more selected categories are unavailable in this workspace'
      USING ERRCODE = '23503';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT requested.category_id ORDER BY requested.category_id), ARRAY[]::uuid[])
  INTO v_category_ids
  FROM unnest(v_category_ids) AS requested(category_id);

  DELETE FROM public.service_access_category_services AS assignment
  WHERE assignment.workspace_id = v_workspace_id
    AND assignment.service_id = p_service_id
    AND NOT (assignment.category_id = ANY(v_category_ids));

  INSERT INTO public.service_access_category_services (workspace_id, category_id, service_id)
  SELECT v_workspace_id, requested.category_id, p_service_id
  FROM unnest(v_category_ids) AS requested(category_id)
  ON CONFLICT (workspace_id, category_id, service_id) DO NOTHING;

  IF cardinality(v_category_ids) > 0 THEN
    PERFORM set_config('atlas.service_access_internal', 'on', true);
    UPDATE public.products
    SET service_legacy_workspace_access = false
    WHERE id = p_service_id AND workspace_id = v_workspace_id;
    PERFORM set_config('atlas.service_access_internal', 'off', true);
  END IF;

  RETURN v_category_ids;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_service_access_categories(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_service_access_categories(uuid, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_service_access_category_members(
  p_category_id uuid,
  p_user_ids uuid[]
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_user_ids uuid[] := COALESCE(p_user_ids, ARRAY[]::uuid[]);
BEGIN
  IF auth.uid() IS NULL OR public.current_user_role() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only a workspace administrator can manage service access members'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_access_categories AS category
    WHERE category.id = p_category_id AND category.workspace_id = v_workspace_id
  ) THEN
    RAISE EXCEPTION 'Service access category not found in this workspace' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT requested.user_id ORDER BY requested.user_id), ARRAY[]::uuid[])
  INTO v_user_ids
  FROM unnest(v_user_ids) AS requested(user_id);

  IF EXISTS (
    SELECT 1 FROM unnest(v_user_ids) AS requested(user_id)
    WHERE NOT public.service_access_user_in_workspace(requested.user_id, v_workspace_id)
  ) THEN
    RAISE EXCEPTION 'One or more selected users are not members of this workspace'
      USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.service_access_category_members AS member
  WHERE member.workspace_id = v_workspace_id
    AND member.category_id = p_category_id
    AND NOT (member.user_id = ANY(v_user_ids));

  INSERT INTO public.service_access_category_members (workspace_id, category_id, user_id)
  SELECT v_workspace_id, p_category_id, requested.user_id
  FROM unnest(v_user_ids) AS requested(user_id)
  ON CONFLICT (workspace_id, category_id, user_id) DO NOTHING;

  RETURN v_user_ids;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_service_access_category_members(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_service_access_category_members(uuid, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_service_legacy_access_policy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF current_setting('atlas.service_access_internal', true) IS DISTINCT FROM 'on' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.service_legacy_workspace_access := false;
    ELSE
      NEW.service_legacy_workspace_access := OLD.service_legacy_workspace_access;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS products_enforce_service_legacy_access ON public.products;
CREATE TRIGGER products_enforce_service_legacy_access
  BEFORE INSERT OR UPDATE OF service_legacy_workspace_access ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_legacy_access_policy();

DROP POLICY IF EXISTS products_service_category_access ON public.products;
CREATE POLICY products_service_category_access
  ON public.products AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    NOT COALESCE(is_service, false)
    OR public.can_access_service(auth.uid(), id)
  );

DROP POLICY IF EXISTS products_service_category_update ON public.products;
CREATE POLICY products_service_category_update
  ON public.products AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    NOT COALESCE(is_service, false)
    OR public.can_access_service(auth.uid(), id)
  )
  WITH CHECK (
    NOT COALESCE(is_service, false)
    OR public.can_access_service(auth.uid(), id)
  );

DROP POLICY IF EXISTS products_service_category_delete ON public.products;
CREATE POLICY products_service_category_delete
  ON public.products AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    NOT COALESCE(is_service, false)
    OR public.can_access_service(auth.uid(), id)
  );

CREATE OR REPLACE FUNCTION public.can_view_product_service_details(
  p_user_id uuid,
  p_workspace_id uuid,
  p_product_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    p_user_id = auth.uid()
    AND p_workspace_id = public.current_workspace_id()
    AND EXISTS (
      SELECT 1
      FROM public.products AS product
      WHERE product.id = p_product_id
        AND product.workspace_id = p_workspace_id
        AND (
          NOT COALESCE(product.is_service, false)
          OR public.can_access_service(p_user_id, product.id)
        )
    ),
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.can_view_product_service_details(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_view_product_service_details(uuid, uuid, uuid) TO authenticated, service_role;

-- Product-linked metadata has its own RLS table, so mirror service visibility
-- there instead of relying on clients to first read the parent product row.
DO $service_metadata_policies$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'product_barcodes',
    'product_images',
    'product_uoms',
    'product_unit_conversions',
    'price_book_items',
    'price_book_unit_prices',
    'product_discounts'
  ] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      v_table || '_service_category_access', v_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (public.can_view_product_service_details(auth.uid(), workspace_id, product_id))',
      v_table || '_service_category_access', v_table
    );
  END LOOP;
END;
$service_metadata_policies$;

DROP POLICY IF EXISTS product_commission_rules_service_category_access ON crm.product_commission_rules;
CREATE POLICY product_commission_rules_service_category_access
  ON crm.product_commission_rules AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.can_view_product_service_details(auth.uid(), workspace_id, product_id));

DROP POLICY IF EXISTS agent_product_commission_entries_service_category_access ON crm.agent_product_commission_entries;
CREATE POLICY agent_product_commission_entries_service_category_access
  ON crm.agent_product_commission_entries AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.can_view_product_service_details(auth.uid(), workspace_id, product_id));

DROP POLICY IF EXISTS sale_items_service_category_access ON public.sale_items;
CREATE POLICY sale_items_service_category_access
  ON public.sale_items AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.can_view_product_service_details(auth.uid(), workspace_id, product_id));

CREATE OR REPLACE FUNCTION public.sale_service_details_visible(
  p_user_id uuid,
  p_workspace_id uuid,
  p_sale_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    p_user_id = auth.uid()
    AND p_workspace_id = public.current_workspace_id()
    AND NOT EXISTS (
      SELECT 1
      FROM public.sale_items AS item
      INNER JOIN public.products AS product
        ON product.id = item.product_id
        AND product.workspace_id = item.workspace_id
      WHERE item.sale_id = p_sale_id
        AND item.workspace_id = p_workspace_id
        AND COALESCE(product.is_service, false) = true
        AND NOT public.can_access_service(p_user_id, product.id)
    ),
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.sale_service_details_visible(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sale_service_details_visible(uuid, uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS sales_service_category_access ON public.sales;
CREATE POLICY sales_service_category_access
  ON public.sales AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.sale_service_details_visible(auth.uid(), workspace_id, id));

CREATE OR REPLACE FUNCTION public.sales_order_service_details_visible(
  p_user_id uuid,
  p_workspace_id uuid,
  p_items jsonb
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT COALESCE(
    p_user_id = auth.uid()
    AND p_workspace_id = public.current_workspace_id()
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END
      ) AS order_item(value)
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN COALESCE(order_item.value->>'product_id', order_item.value->>'productId', '')
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN COALESCE(order_item.value->>'product_id', order_item.value->>'productId')::uuid
          ELSE NULL
        END AS product_id
      ) AS product_id
      INNER JOIN public.products AS product
        ON product.id = product_id.product_id
        AND product.workspace_id = p_workspace_id
      WHERE COALESCE(product.is_service, false) = true
        AND NOT public.can_access_service(p_user_id, product.id)
    ),
    false
  );
$function$;

REVOKE ALL ON FUNCTION public.sales_order_service_details_visible(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sales_order_service_details_visible(uuid, uuid, jsonb) TO authenticated, service_role;

-- SECURITY DEFINER sales reports bypass row policies. Keep their row-level
-- visibility aligned with the sales and sale-item policies above.
DO $service_report_visibility$
DECLARE
  v_signature text;
  v_definition text;
  v_date_filter constant text := 'AND (p_start_date IS NULL OR sale.created_at >= p_start_date)';
  v_service_filter constant text := 'AND (COALESCE(current_setting(''request.jwt.claim.role'', true), '''') = ''service_role'' OR public.sale_service_details_visible(auth.uid(), sale.workspace_id, sale.id))';
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.get_net_revenue(uuid,timestamp with time zone,timestamp with time zone)',
    'public.get_sales_summary(uuid,timestamp with time zone,timestamp with time zone)',
    'public.get_top_products(uuid,timestamp with time zone,timestamp with time zone,integer)',
    'public.get_team_performance(uuid,timestamp with time zone,timestamp with time zone)'
  ] LOOP
    SELECT pg_get_functiondef(to_regprocedure(v_signature)) INTO v_definition;
    IF v_definition IS NULL THEN
      RAISE EXCEPTION 'Expected sales report function % was not found', v_signature;
    END IF;

    IF position('public.sale_service_details_visible(auth.uid(), sale.workspace_id, sale.id)' IN v_definition) = 0 THEN
      IF position(v_date_filter IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Could not safely scope sales report function %', v_signature;
      END IF;
      v_definition := replace(v_definition, v_date_filter, v_service_filter || E'\n    ' || v_date_filter);
      EXECUTE v_definition;
    END IF;
  END LOOP;
END;
$service_report_visibility$;

DROP POLICY IF EXISTS crm_sales_orders_service_category_access ON crm.sales_orders;
CREATE POLICY crm_sales_orders_service_category_access
  ON crm.sales_orders AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.sales_order_service_details_visible(auth.uid(), workspace_id, items));

DROP POLICY IF EXISTS sale_returns_service_category_access ON public.sale_returns;
CREATE POLICY sale_returns_service_category_access
  ON public.sale_returns AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.sale_service_details_visible(auth.uid(), workspace_id, sale_id));

DROP POLICY IF EXISTS sale_return_items_service_category_access ON public.sale_return_items;
CREATE POLICY sale_return_items_service_category_access
  ON public.sale_return_items AS RESTRICTIVE FOR SELECT TO authenticated
  USING (public.sale_service_details_visible(auth.uid(), workspace_id, sale_id));

DROP POLICY IF EXISTS order_returns_service_category_access ON public.order_returns;
CREATE POLICY order_returns_service_category_access
  ON public.order_returns AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM crm.sales_orders AS sales_order
      WHERE sales_order.id = order_returns.order_id
        AND sales_order.workspace_id = order_returns.workspace_id
        AND public.sales_order_service_details_visible(auth.uid(), sales_order.workspace_id, sales_order.items)
    )
  );

DROP POLICY IF EXISTS order_return_items_service_category_access ON public.order_return_items;
CREATE POLICY order_return_items_service_category_access
  ON public.order_return_items AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM crm.sales_orders AS sales_order
      WHERE sales_order.id = order_return_items.order_id
        AND sales_order.workspace_id = order_return_items.workspace_id
        AND public.sales_order_service_details_visible(auth.uid(), sales_order.workspace_id, sales_order.items)
    )
  );

DROP POLICY IF EXISTS sale_product_exchanges_service_category_access ON public.sale_product_exchanges;
CREATE POLICY sale_product_exchanges_service_category_access
  ON public.sale_product_exchanges AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    public.can_view_product_service_details(auth.uid(), workspace_id, return_product_id)
    AND public.can_view_product_service_details(auth.uid(), workspace_id, replacement_product_id)
  );

CREATE OR REPLACE FUNCTION public.enforce_service_access_on_sale_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_id uuid;
  v_is_service boolean;
  v_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
BEGIN
  v_workspace_id := COALESCE(
    NEW.workspace_id,
    (SELECT sale.workspace_id FROM public.sales AS sale WHERE sale.id = NEW.sale_id)
  );

  SELECT COALESCE(product.is_service, false)
  INTO v_is_service
  FROM public.products AS product
  WHERE product.id = NEW.product_id
    AND product.workspace_id = v_workspace_id;

  IF COALESCE(v_is_service, false)
    AND v_role IS DISTINCT FROM 'service_role'
    AND NOT public.can_access_service(auth.uid(), NEW.product_id)
  THEN
    RAISE EXCEPTION 'You do not have access to this service'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS sale_items_enforce_service_access ON public.sale_items;
CREATE TRIGGER sale_items_enforce_service_access
  BEFORE INSERT OR UPDATE OF sale_id, product_id, workspace_id ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_access_on_sale_item();

CREATE OR REPLACE FUNCTION public.enforce_service_access_on_sale_return()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_sale_id uuid := COALESCE(NEW.sale_id, OLD.sale_id);
  v_workspace_id uuid := COALESCE(NEW.workspace_id, OLD.workspace_id);
  v_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
BEGIN
  IF v_role = 'service_role' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.sales AS sale
    WHERE sale.id = v_sale_id
      AND sale.workspace_id = v_workspace_id
      AND public.sale_service_details_visible(auth.uid(), v_workspace_id, sale.id)
  ) THEN
    RAISE EXCEPTION 'You do not have access to all services on this sale'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS sale_returns_enforce_service_access ON public.sale_returns;
CREATE TRIGGER sale_returns_enforce_service_access
  BEFORE INSERT OR UPDATE OR DELETE ON public.sale_returns
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_access_on_sale_return();

DROP TRIGGER IF EXISTS sale_return_items_enforce_service_access ON public.sale_return_items;
CREATE TRIGGER sale_return_items_enforce_service_access
  BEFORE INSERT OR UPDATE OR DELETE ON public.sale_return_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_access_on_sale_return();

CREATE OR REPLACE FUNCTION public.enforce_service_access_on_product_exchange()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
BEGIN
  IF v_role <> 'service_role'
    AND (
      NOT public.can_view_product_service_details(auth.uid(), NEW.workspace_id, NEW.return_product_id)
      OR NOT public.can_view_product_service_details(auth.uid(), NEW.workspace_id, NEW.replacement_product_id)
    )
  THEN
    RAISE EXCEPTION 'You do not have access to all services on this exchange'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS sale_product_exchanges_enforce_service_access ON public.sale_product_exchanges;
CREATE TRIGGER sale_product_exchanges_enforce_service_access
  BEFORE INSERT OR UPDATE ON public.sale_product_exchanges
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_access_on_product_exchange();

CREATE OR REPLACE FUNCTION crm.enforce_service_order_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, crm
AS $function$
DECLARE
  v_item jsonb;
  v_product_id uuid;
  v_is_service boolean;
  v_storage_id text;
  v_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.items, '[]'::jsonb)) LOOP
    v_product_id := NULLIF(COALESCE(v_item->>'productId', v_item->>'product_id'), '')::uuid;
    SELECT COALESCE(is_service, false) INTO v_is_service
    FROM public.products WHERE id = v_product_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Order item product is not in this workspace'; END IF;
    v_storage_id := COALESCE(v_item->>'storageId', v_item->>'storage_id', '');

    IF TG_TABLE_NAME = 'purchase_orders' AND v_is_service THEN
      RAISE EXCEPTION 'Services cannot be added to purchase orders.' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'sales_orders' AND v_is_service THEN
      IF NOT public.services_module_allowed(NEW.workspace_id) THEN
        RAISE EXCEPTION 'Services feature is not enabled for this workspace' USING ERRCODE = '42501';
      END IF;
      IF v_role IS DISTINCT FROM 'service_role'
        AND NOT public.can_access_service(auth.uid(), v_product_id)
      THEN
        RAISE EXCEPTION 'You do not have access to this service' USING ERRCODE = '42501';
      END IF;
      IF v_storage_id <> '' AND v_storage_id <> '__atlas_services__' THEN
        RAISE EXCEPTION 'Service order items must use the Services virtual location.' USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_service_access_on_order_return()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order_items jsonb;
  v_order_id uuid := COALESCE(NEW.order_id, OLD.order_id);
  v_workspace_id uuid := COALESCE(NEW.workspace_id, OLD.workspace_id);
  v_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
BEGIN
  IF v_role = 'service_role' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT sales_order.items
  INTO v_order_items
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.id = v_order_id
    AND sales_order.workspace_id = v_workspace_id;

  IF NOT FOUND
    OR NOT public.sales_order_service_details_visible(auth.uid(), v_workspace_id, v_order_items)
  THEN
    RAISE EXCEPTION 'You do not have access to all services on this order'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS order_returns_enforce_service_access ON public.order_returns;
CREATE TRIGGER order_returns_enforce_service_access
  BEFORE INSERT OR UPDATE OR DELETE ON public.order_returns
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_access_on_order_return();

DROP TRIGGER IF EXISTS order_return_items_enforce_service_access ON public.order_return_items;
CREATE TRIGGER order_return_items_enforce_service_access
  BEFORE INSERT OR UPDATE OR DELETE ON public.order_return_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_access_on_order_return();

-- The autocomplete RPC is SECURITY DEFINER to avoid repeating storage RLS work.
-- Keep that optimization while adding one EXISTS-based service grant filter to
-- its candidate and family-member scans.
DO $migration$
DECLARE
  v_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.search_products_for_autocomplete(uuid,text,uuid[],uuid[],integer)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Expected product autocomplete function was not found';
  END IF;

  v_definition := replace(
    v_definition,
    'AND COALESCE(product.is_deleted, false) = false',
    'AND COALESCE(product.is_deleted, false) = false' || E'\n        AND (NOT COALESCE(product.is_service, false) OR public.can_access_service(auth.uid(), product.id))'
  );

  IF (length(v_definition) - length(replace(v_definition, 'public.can_access_service(auth.uid(), product.id)', '')))
      / length('public.can_access_service(auth.uid(), product.id)') < 3
  THEN
    RAISE EXCEPTION 'Could not safely add service access filtering to product autocomplete';
  END IF;

  EXECUTE v_definition;
END;
$migration$;

COMMENT ON FUNCTION public.can_access_service(uuid, uuid) IS
  'Returns whether the authenticated user can access a service. Category assignments use OR semantics via one indexed EXISTS query.';
