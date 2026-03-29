ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS visibility text,
  ADD COLUMN IF NOT EXISTS store_slug text,
  ADD COLUMN IF NOT EXISTS store_description text,
  ADD COLUMN IF NOT EXISTS ecommerce boolean;

UPDATE public.workspaces
SET
  visibility = COALESCE(NULLIF(lower(trim(visibility)), ''), 'private'),
  store_slug = NULLIF(lower(trim(store_slug)), ''),
  store_description = NULLIF(trim(store_description), ''),
  ecommerce = COALESCE(ecommerce, false);

ALTER TABLE public.workspaces
  ALTER COLUMN visibility SET DEFAULT 'private';

ALTER TABLE public.workspaces
  ALTER COLUMN visibility SET NOT NULL;

ALTER TABLE public.workspaces
  ALTER COLUMN ecommerce SET DEFAULT false;

ALTER TABLE public.workspaces
  ALTER COLUMN ecommerce SET NOT NULL;

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_visibility_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_visibility_check
  CHECK (visibility IN ('private', 'public'));

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_store_slug_format_check;

ALTER TABLE public.workspaces
  ADD CONSTRAINT workspaces_store_slug_format_check
  CHECK (
    store_slug IS NULL
    OR store_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_store_slug_active
  ON public.workspaces (lower(store_slug))
  WHERE store_slug IS NOT NULL
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_visibility_public
  ON public.workspaces (visibility)
  WHERE visibility = 'public'
    AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_store_slug_lookup
  ON public.workspaces (store_slug)
  WHERE store_slug IS NOT NULL
    AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.normalize_marketplace_workspace_settings()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.visibility := COALESCE(NULLIF(lower(trim(COALESCE(NEW.visibility, 'private'))), ''), 'private');
  NEW.store_slug := NULLIF(lower(trim(COALESCE(NEW.store_slug, ''))), '');
  NEW.store_description := NULLIF(trim(COALESCE(NEW.store_description, '')), '');
  NEW.ecommerce := COALESCE(NEW.ecommerce, false);

  IF NEW.visibility NOT IN ('private', 'public') THEN
    RAISE EXCEPTION 'Workspace visibility must be private or public';
  END IF;

  IF NEW.visibility = 'public' AND NEW.deleted_at IS NULL THEN
    IF COALESCE(NEW.data_mode, 'cloud') = 'local' THEN
      RAISE EXCEPTION 'Local workspaces cannot be published to the marketplace';
    END IF;

    IF NEW.store_slug IS NULL THEN
      RAISE EXCEPTION 'A store slug is required before a workspace can be published';
    END IF;

    NEW.ecommerce := true;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS normalize_marketplace_workspace_settings_on_workspaces ON public.workspaces;
CREATE TRIGGER normalize_marketplace_workspace_settings_on_workspaces
BEFORE INSERT OR UPDATE ON public.workspaces
FOR EACH ROW
EXECUTE FUNCTION public.normalize_marketplace_workspace_settings();

CREATE TABLE IF NOT EXISTS public.marketplace_order_counters (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.marketplace_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  order_sequence bigint,
  order_number text NOT NULL,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  customer_email text,
  customer_address text,
  customer_city text,
  customer_notes text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'iqd',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled')),
  confirmed_at timestamp with time zone,
  processing_at timestamp with time zone,
  shipped_at timestamp with time zone,
  delivered_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  cancel_reason text,
  inventory_deducted boolean NOT NULL DEFAULT false,
  request_ip_hash text NOT NULL DEFAULT '',
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc', now()),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_orders_workspace_sequence
  ON public.marketplace_orders (workspace_id, order_sequence);

CREATE UNIQUE INDEX IF NOT EXISTS uq_marketplace_orders_workspace_number
  ON public.marketplace_orders (workspace_id, order_number);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_workspace_created
  ON public.marketplace_orders (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_workspace_status
  ON public.marketplace_orders (workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_request_ip
  ON public.marketplace_orders (request_ip_hash, created_at DESC);

CREATE OR REPLACE FUNCTION public.assign_marketplace_order_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  v_next_sequence bigint;
BEGIN
  IF NEW.workspace_id IS NULL THEN
    RAISE EXCEPTION 'Marketplace orders require a workspace';
  END IF;

  IF NEW.order_sequence IS NULL OR NEW.order_sequence <= 0 THEN
    INSERT INTO public.marketplace_order_counters AS counters (workspace_id, last_sequence, updated_at)
    VALUES (NEW.workspace_id, 1, timezone('utc', now()))
    ON CONFLICT (workspace_id)
    DO UPDATE SET
      last_sequence = counters.last_sequence + 1,
      updated_at = timezone('utc', now())
    RETURNING last_sequence INTO v_next_sequence;

    NEW.order_sequence := v_next_sequence;
  END IF;

  IF COALESCE(NULLIF(trim(COALESCE(NEW.order_number, '')), ''), '') = '' THEN
    NEW.order_number := format('MKT-%s', lpad(NEW.order_sequence::text, 5, '0'));
  END IF;

  NEW.request_ip_hash := COALESCE(NEW.request_ip_hash, '');
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS assign_marketplace_order_number_on_insert ON public.marketplace_orders;
CREATE TRIGGER assign_marketplace_order_number_on_insert
BEFORE INSERT ON public.marketplace_orders
FOR EACH ROW
EXECUTE FUNCTION public.assign_marketplace_order_number();

DROP TRIGGER IF EXISTS update_marketplace_orders_updated_at ON public.marketplace_orders;
CREATE TRIGGER update_marketplace_orders_updated_at
BEFORE UPDATE ON public.marketplace_orders
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.marketplace_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketplace_orders_select ON public.marketplace_orders;
CREATE POLICY marketplace_orders_select
  ON public.marketplace_orders
  FOR SELECT
  TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
  );

DROP POLICY IF EXISTS marketplace_orders_update ON public.marketplace_orders;

CREATE OR REPLACE FUNCTION public.check_store_slug_available(p_slug text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_slug text := NULLIF(lower(trim(COALESCE(p_slug, ''))), '');
BEGIN
  IF v_slug IS NULL THEN
    RETURN false;
  END IF;

  IF v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' THEN
    RETURN false;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1
    FROM public.workspaces
    WHERE deleted_at IS NULL
      AND lower(store_slug) = v_slug
      AND id IS DISTINCT FROM public.current_workspace_id()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.check_store_slug_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_store_slug_available(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.transition_marketplace_order(order_id uuid, next_status text, cancel_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_order public.marketplace_orders%ROWTYPE;
  v_next_status text := lower(trim(COALESCE(next_status, '')));
  v_cancel_reason text := NULLIF(trim(COALESCE(cancel_reason, '')), '');
  v_item jsonb;
  v_product_id uuid;
  v_requested_qty integer;
  v_declared_storage_id uuid;
  v_resolved_storage_id uuid;
  v_inventory_quantity integer;
  v_warning_messages text[] := ARRAY[]::text[];
  v_missing_storage_count integer := 0;
  v_inventory_completed boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF public.current_workspace_id() IS NULL THEN
    RAISE EXCEPTION 'Workspace context is missing';
  END IF;

  IF public.current_user_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'Only admins and staff can manage marketplace orders';
  END IF;

  IF v_next_status NOT IN ('confirmed', 'processing', 'shipped', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Unsupported marketplace order status';
  END IF;

  SELECT *
  INTO v_order
  FROM public.marketplace_orders
  WHERE id = order_id
    AND workspace_id = public.current_workspace_id()
    AND COALESCE(is_deleted, false) = false
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Marketplace order not found';
  END IF;

  IF v_order.status IN ('delivered', 'cancelled') THEN
    RAISE EXCEPTION 'This marketplace order is already finalized';
  END IF;

  CASE v_order.status
    WHEN 'pending' THEN
      IF v_next_status NOT IN ('confirmed', 'cancelled') THEN
        RAISE EXCEPTION 'Pending orders can only move to confirmed or cancelled';
      END IF;
    WHEN 'confirmed' THEN
      IF v_next_status NOT IN ('processing', 'cancelled') THEN
        RAISE EXCEPTION 'Confirmed orders can only move to processing or cancelled';
      END IF;
    WHEN 'processing' THEN
      IF v_next_status NOT IN ('shipped', 'cancelled') THEN
        RAISE EXCEPTION 'Processing orders can only move to shipped or cancelled';
      END IF;
    WHEN 'shipped' THEN
      IF v_next_status <> 'delivered' THEN
        RAISE EXCEPTION 'Shipped orders can only move to delivered';
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported current marketplace order status';
  END CASE;

  IF v_next_status = 'confirmed' THEN
    UPDATE public.marketplace_orders
    SET
      status = 'confirmed',
      confirmed_at = COALESCE(confirmed_at, timezone('utc', now())),
      version = COALESCE(version, 0) + 1
    WHERE id = v_order.id;

    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'confirmed',
      'inventory_deducted', v_order.inventory_deducted,
      'warning', NULL,
      'warnings', '[]'::jsonb
    );
  END IF;

  IF v_next_status = 'processing' THEN
    UPDATE public.marketplace_orders
    SET
      status = 'processing',
      processing_at = COALESCE(processing_at, timezone('utc', now())),
      version = COALESCE(version, 0) + 1
    WHERE id = v_order.id;

    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'processing',
      'inventory_deducted', v_order.inventory_deducted,
      'warning', NULL,
      'warnings', '[]'::jsonb
    );
  END IF;

  IF v_next_status = 'shipped' THEN
    UPDATE public.marketplace_orders
    SET
      status = 'shipped',
      shipped_at = COALESCE(shipped_at, timezone('utc', now())),
      version = COALESCE(version, 0) + 1
    WHERE id = v_order.id;

    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'shipped',
      'inventory_deducted', v_order.inventory_deducted,
      'warning', NULL,
      'warnings', '[]'::jsonb
    );
  END IF;

  IF v_next_status = 'cancelled' THEN
    UPDATE public.marketplace_orders
    SET
      status = 'cancelled',
      cancelled_at = COALESCE(cancelled_at, timezone('utc', now())),
      cancel_reason = v_cancel_reason,
      version = COALESCE(version, 0) + 1
    WHERE id = v_order.id;

    RETURN jsonb_build_object(
      'order_id', v_order.id,
      'status', 'cancelled',
      'inventory_deducted', v_order.inventory_deducted,
      'warning', NULL,
      'warnings', '[]'::jsonb
    );
  END IF;

  IF NOT COALESCE(v_order.inventory_deducted, false) THEN
    FOR v_item IN
      SELECT *
      FROM jsonb_array_elements(COALESCE(v_order.items, '[]'::jsonb))
    LOOP
      v_product_id := NULLIF(v_item->>'product_id', '')::uuid;
      v_requested_qty := COALESCE((v_item->>'quantity')::integer, 0);
      v_declared_storage_id := NULLIF(v_item->>'storage_id', '')::uuid;

      IF v_product_id IS NULL OR v_requested_qty <= 0 THEN
        CONTINUE;
      END IF;

      v_resolved_storage_id := v_declared_storage_id;

      IF v_resolved_storage_id IS NULL THEN
        SELECT CASE WHEN COUNT(*) = 1 THEN MIN(storage_id::text)::uuid ELSE NULL END
        INTO v_resolved_storage_id
        FROM public.inventory
        WHERE workspace_id = v_order.workspace_id
          AND product_id = v_product_id
          AND COALESCE(is_deleted, false) = false;
      END IF;

      IF v_resolved_storage_id IS NULL THEN
        SELECT storage_id
        INTO v_resolved_storage_id
        FROM public.products
        WHERE id = v_product_id
          AND workspace_id = v_order.workspace_id
          AND COALESCE(is_deleted, false) = false;
      END IF;

      IF v_resolved_storage_id IS NULL THEN
        v_missing_storage_count := v_missing_storage_count + 1;
        v_warning_messages := array_append(
          v_warning_messages,
          format('No storage could be resolved for %s', COALESCE(NULLIF(v_item->>'name', ''), v_product_id::text))
        );
        CONTINUE;
      END IF;

      SELECT quantity
      INTO v_inventory_quantity
      FROM public.inventory
      WHERE workspace_id = v_order.workspace_id
        AND product_id = v_product_id
        AND storage_id = v_resolved_storage_id
      LIMIT 1
      FOR UPDATE;

      IF COALESCE(v_inventory_quantity, 0) < v_requested_qty THEN
        v_warning_messages := array_append(
          v_warning_messages,
          format('Inventory for %s will go negative after delivery', COALESCE(NULLIF(v_item->>'name', ''), v_product_id::text))
        );
      END IF;

      INSERT INTO public.inventory (
        id,
        workspace_id,
        product_id,
        storage_id,
        quantity,
        created_at,
        updated_at,
        version,
        is_deleted
      )
      VALUES (
        gen_random_uuid(),
        v_order.workspace_id,
        v_product_id,
        v_resolved_storage_id,
        0 - v_requested_qty,
        timezone('utc', now()),
        timezone('utc', now()),
        1,
        false
      )
      ON CONFLICT (workspace_id, product_id, storage_id)
      DO UPDATE SET
        quantity = COALESCE(public.inventory.quantity, 0) + EXCLUDED.quantity,
        updated_at = timezone('utc', now()),
        version = COALESCE(public.inventory.version, 0) + 1,
        is_deleted = false;
    END LOOP;

    v_inventory_completed := v_missing_storage_count = 0;
  ELSE
    v_inventory_completed := true;
  END IF;

  IF v_missing_storage_count > 0 THEN
    v_warning_messages := array_append(
      v_warning_messages,
      'Inventory was not fully deducted because some items were missing a resolved storage.'
    );
  END IF;

  UPDATE public.marketplace_orders
  SET
    status = 'delivered',
    delivered_at = COALESCE(delivered_at, timezone('utc', now())),
    inventory_deducted = COALESCE(v_order.inventory_deducted, false) OR v_inventory_completed,
    version = COALESCE(version, 0) + 1
  WHERE id = v_order.id;

  RETURN jsonb_build_object(
    'order_id', v_order.id,
    'status', 'delivered',
    'inventory_deducted', COALESCE(v_order.inventory_deducted, false) OR v_inventory_completed,
    'warning',
      CASE
        WHEN COALESCE(array_length(v_warning_messages, 1), 0) > 0
          THEN array_to_string(v_warning_messages, '; ')
        ELSE NULL
      END,
    'warnings', to_jsonb(COALESCE(v_warning_messages, ARRAY[]::text[]))
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.transition_marketplace_order(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transition_marketplace_order(uuid, text, text) TO authenticated, service_role;
