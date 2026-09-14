-- Preserve the delivery actor on the marketplace order. The user ID supports
-- auditing while the name snapshot remains visible after that user is renamed
-- or removed.
ALTER TABLE public.marketplace_orders
  ADD COLUMN IF NOT EXISTS delivered_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivered_by_name text NULL;

COMMENT ON COLUMN public.marketplace_orders.delivered_by
  IS 'Authenticated Atlas user who marked the marketplace order as delivered';
COMMENT ON COLUMN public.marketplace_orders.delivered_by_name
  IS 'Delivery actor name snapshot captured when the marketplace order was delivered';

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_workspace_delivered_by
  ON public.marketplace_orders (workspace_id, delivered_by)
  WHERE delivered_by IS NOT NULL AND COALESCE(is_deleted, false) = false;

-- Update the installed delivery procedure rather than restoring an older
-- copy of it: it retains the later inventory safeguards while making the
-- delivery attribution and sales-order signature part of the same transaction.
DO $migration$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.transition_marketplace_order(uuid,text,text)'::regprocedure
  )
  INTO definition;

  IF definition IS NULL
    OR position('v_delivery_timestamp timestamp with time zone' IN definition) = 0
    OR position('INSERT INTO crm.sales_orders (' IN definition) = 0
    OR position('status = ''delivered''' IN definition) = 0
  THEN
    RAISE EXCEPTION
      'Expected marketplace delivery procedure revision is not installed; delivery attribution was not applied.';
  END IF;

  -- Permit a linked database that has already received this exact repair to
  -- record the migration without rewriting the procedure again.
  IF position('v_delivery_actor_id uuid := auth.uid();' IN definition) > 0
    AND position('delivered_by_name = COALESCE(NULLIF(delivered_by_name, ''''), v_delivery_actor_name)' IN definition) > 0
    AND position('created_by,' IN definition) > 0
  THEN
    RETURN;
  END IF;

  updated_definition := replace(
    definition,
    $old$  v_delivery_timestamp timestamp with time zone := timezone('utc', now());$old$,
    $new$  v_delivery_timestamp timestamp with time zone := timezone('utc', now());
  v_delivery_actor_id uuid := auth.uid();
  v_delivery_actor_name text;$new$
  );

  IF updated_definition IS NOT DISTINCT FROM definition THEN
    RAISE EXCEPTION
      'Marketplace delivery actor declaration could not be added.';
  END IF;

  definition := updated_definition;
  updated_definition := replace(
    definition,
    $old$  IF NOT COALESCE(v_order.inventory_deducted, false) THEN$old$,
    $new$  SELECT COALESCE(
    NULLIF(trim(p.name), ''),
    NULLIF(trim(u.email), ''),
    'Unknown'
  )
  INTO v_delivery_actor_name
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE u.id = v_delivery_actor_id;

  v_delivery_actor_name := COALESCE(v_delivery_actor_name, 'Unknown');

  IF NOT COALESCE(v_order.inventory_deducted, false) THEN$new$
  );

  IF updated_definition IS NOT DISTINCT FROM definition THEN
    RAISE EXCEPTION
      'Marketplace delivery actor snapshot could not be added.';
  END IF;

  definition := updated_definition;
  updated_definition := replace(
    definition,
    $old$      marketplace_order_id,
      created_at,$old$,
    $new$      marketplace_order_id,
      created_by,
      created_at,$new$
  );

  IF updated_definition IS NOT DISTINCT FROM definition THEN
    RAISE EXCEPTION
      'Marketplace sales order creator column could not be added.';
  END IF;

  definition := updated_definition;
  updated_definition := replace(
    definition,
    $old$      v_order.id,
      v_order.created_at,$old$,
    $new$      v_order.id,
      v_delivery_actor_id,
      v_order.created_at,$new$
  );

  IF updated_definition IS NOT DISTINCT FROM definition THEN
    RAISE EXCEPTION
      'Marketplace sales order creator value could not be added.';
  END IF;

  definition := updated_definition;
  updated_definition := replace(
    definition,
    $old$    delivered_at = COALESCE(delivered_at, v_delivery_timestamp),
    inventory_deducted =$old$,
    $new$    delivered_at = COALESCE(delivered_at, v_delivery_timestamp),
    delivered_by = COALESCE(delivered_by, v_delivery_actor_id),
    delivered_by_name = COALESCE(NULLIF(delivered_by_name, ''), v_delivery_actor_name),
    inventory_deducted =$new$
  );

  IF updated_definition IS NOT DISTINCT FROM definition THEN
    RAISE EXCEPTION
      'Marketplace delivery actor values could not be added.';
  END IF;

  EXECUTE updated_definition;
END;
$migration$;
