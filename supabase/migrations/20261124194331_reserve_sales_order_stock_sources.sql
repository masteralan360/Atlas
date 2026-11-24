-- Keep Sales Order commitments attached to the source selected by the user.
-- The existing position-level reservation remains authoritative for total stock;
-- this projection makes batch and regular-stock availability source-aware.
CREATE TABLE private.sales_order_stock_source_reservations (
  order_id uuid NOT NULL REFERENCES crm.sales_orders(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  product_id uuid NOT NULL,
  storage_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('regular','batch')),
  batch_id uuid NULL REFERENCES public.stock_batches(id) ON DELETE RESTRICT,
  quantity numeric NOT NULL CHECK (quantity > 0 AND quantity::text NOT IN ('NaN','Infinity','-Infinity')),
  CHECK ((source_type='batch' AND batch_id IS NOT NULL) OR (source_type='regular' AND batch_id IS NULL))
);
CREATE UNIQUE INDEX sales_order_stock_source_reservation_key
  ON private.sales_order_stock_source_reservations(order_id,product_id,storage_id,source_type,batch_id) NULLS NOT DISTINCT;
CREATE INDEX sales_order_stock_source_reservation_lookup
  ON private.sales_order_stock_source_reservations(workspace_id,product_id,storage_id,source_type,batch_id);
CREATE INDEX sales_order_stock_source_reservation_batch
  ON private.sales_order_stock_source_reservations(batch_id);
ALTER TABLE private.sales_order_stock_source_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.sales_order_stock_source_reservations FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.order_stock_source_demands(p_items jsonb,p_storage_id uuid)
RETURNS TABLE(product_id uuid,storage_id uuid,source_type text,batch_id uuid,quantity numeric)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $function$
  WITH lines AS (
    SELECT ordinal,
      NULLIF(item->>'productId','')::uuid product_id,
      COALESCE(NULLIF(item->>'storageId','')::uuid,p_storage_id) storage_id,
      pg_catalog.round(
        COALESCE(NULLIF(item->>'inventoryQuantity','')::numeric,
          COALESCE(NULLIF(item->>'quantity','')::numeric,0)*COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
        + COALESCE(NULLIF(item->>'freeBonusInventoryQuantity','')::numeric,
          COALESCE(NULLIF(COALESCE(item->>'freeBonusQuantity',item->>'freeQuantity'),'')::numeric,0)
            * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1)),6) line_quantity,
      item,
      COALESCE(pg_catalog.jsonb_typeof(item->'batchAllocations')='array',false) has_allocations
    FROM pg_catalog.jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) WITH ORDINALITY entry(item,ordinal)
  ), allocations AS (
    SELECT lines.ordinal, NULLIF(allocation->>'batchId','')::uuid batch_id,
      pg_catalog.round(COALESCE(NULLIF(allocation->>'quantity','')::numeric,0),6) quantity
    FROM lines
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      CASE WHEN lines.has_allocations THEN lines.item->'batchAllocations' ELSE '[]'::jsonb END
    ) allocation
    WHERE NULLIF(allocation->>'batchId','') IS NOT NULL
      AND COALESCE(NULLIF(allocation->>'quantity','')::numeric,0)>0
  ), batch_demands AS (
    SELECT lines.product_id,lines.storage_id,'batch'::text source_type,allocations.batch_id,
      pg_catalog.round(SUM(allocations.quantity),6) quantity
    FROM allocations JOIN lines USING (ordinal)
    WHERE lines.has_allocations OR (lines.item->>'stockSourceType'='batch' AND NULLIF(lines.item->>'stockSourceBatchId','') IS NOT NULL)
    GROUP BY lines.product_id,lines.storage_id,allocations.batch_id
    UNION ALL
    SELECT lines.product_id,lines.storage_id,'batch'::text,NULLIF(lines.item->>'stockSourceBatchId','')::uuid,
      pg_catalog.round(lines.line_quantity,6)
    FROM lines
    WHERE NOT lines.has_allocations AND lines.item->>'stockSourceType'='batch'
      AND NULLIF(lines.item->>'stockSourceBatchId','') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM allocations WHERE allocations.ordinal=lines.ordinal)
  ), regular_demands AS (
    SELECT lines.product_id,lines.storage_id,'regular'::text source_type,NULL::uuid batch_id,
      pg_catalog.round(SUM(GREATEST(lines.line_quantity-COALESCE(selected.quantity,0),0)),6) quantity
    FROM lines
    LEFT JOIN LATERAL (
      SELECT SUM(allocations.quantity) quantity FROM allocations WHERE allocations.ordinal=lines.ordinal
    ) selected ON true
    WHERE lines.has_allocations OR (NOT lines.has_allocations AND lines.item->>'stockSourceType'='regular')
    GROUP BY lines.product_id,lines.storage_id
    HAVING SUM(GREATEST(lines.line_quantity-COALESCE(selected.quantity,0),0))>0
  )
  SELECT product_id,storage_id,source_type,batch_id,pg_catalog.round(SUM(quantity),6)
  FROM (SELECT * FROM batch_demands UNION ALL SELECT * FROM regular_demands) source_demands
  WHERE product_id IS NOT NULL AND quantity>0
  GROUP BY product_id,storage_id,source_type,batch_id;
$function$;
REVOKE ALL ON FUNCTION private.order_stock_source_demands(jsonb,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.order_stock_auto_source_demands(p_items jsonb,p_storage_id uuid)
RETURNS TABLE(product_id uuid,storage_id uuid,quantity numeric)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $function$
  SELECT NULLIF(item->>'productId','')::uuid,
    COALESCE(NULLIF(item->>'storageId','')::uuid,p_storage_id),
    pg_catalog.round(SUM(
      COALESCE(NULLIF(item->>'inventoryQuantity','')::numeric,
        COALESCE(NULLIF(item->>'quantity','')::numeric,0)*COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
      + COALESCE(NULLIF(item->>'freeBonusInventoryQuantity','')::numeric,
        COALESCE(NULLIF(COALESCE(item->>'freeBonusQuantity',item->>'freeQuantity'),'')::numeric,0)
          * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
    ),6)
  FROM pg_catalog.jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) item
  WHERE COALESCE(pg_catalog.jsonb_typeof(item->'batchAllocations'),'null')<>'array'
    AND COALESCE(item->>'stockSourceType','') NOT IN ('regular','batch')
  GROUP BY 1,2 HAVING SUM(
    COALESCE(NULLIF(item->>'inventoryQuantity','')::numeric,
      COALESCE(NULLIF(item->>'quantity','')::numeric,0)*COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
    + COALESCE(NULLIF(item->>'freeBonusInventoryQuantity','')::numeric,
      COALESCE(NULLIF(COALESCE(item->>'freeBonusQuantity',item->>'freeQuantity'),'')::numeric,0)
        * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1)))>0;
$function$;
REVOKE ALL ON FUNCTION private.order_stock_auto_source_demands(jsonb,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.reserved_stock_source(
  p_workspace uuid,p_product uuid,p_storage uuid,p_source_type text,p_batch uuid,p_exclude uuid DEFAULT NULL)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(SUM(quantity),0) FROM private.sales_order_stock_source_reservations
  WHERE workspace_id=p_workspace AND product_id=p_product AND storage_id=p_storage
    AND source_type=p_source_type AND batch_id IS NOT DISTINCT FROM p_batch
    AND (p_exclude IS NULL OR order_id<>p_exclude);
$function$;
REVOKE ALL ON FUNCTION private.reserved_stock_source(uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.rebuild_sales_order_stock_source_reservations(
  p_order_id uuid,p_workspace_id uuid,p_status text,p_is_deleted boolean,p_items jsonb,p_source_storage_id uuid,p_skip_validation boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE demand record; batch record; own_reserved numeric; other_reserved numeric; capacity numeric;
  remaining numeric; allocated numeric; regular_on_hand numeric; regular_reserved numeric;
BEGIN
  IF p_status='pending' AND NOT COALESCE(p_is_deleted,false) THEN
    FOR demand IN
      SELECT required.* FROM private.order_stock_source_demands(p_items,p_source_storage_id) required
      JOIN public.products product ON product.id=required.product_id AND product.workspace_id=p_workspace_id
      WHERE NOT COALESCE(product.is_service,false)
    LOOP
      IF demand.storage_id IS NULL THEN
        IF p_skip_validation THEN CONTINUE; END IF;
        RAISE EXCEPTION 'source_storage_required' USING ERRCODE='23514';
      END IF;
      SELECT COALESCE(SUM(quantity),0) INTO own_reserved FROM private.sales_order_stock_source_reservations
        WHERE order_id=p_order_id AND product_id=demand.product_id AND storage_id=demand.storage_id
          AND source_type=demand.source_type AND batch_id IS NOT DISTINCT FROM demand.batch_id;
      IF demand.source_type='batch' THEN
        SELECT CASE WHEN NOT COALESCE(stock_batch.is_deleted,false) THEN stock_batch.quantity ELSE 0 END
          INTO capacity FROM public.stock_batches stock_batch
          WHERE stock_batch.id=demand.batch_id AND stock_batch.workspace_id=p_workspace_id
            AND stock_batch.product_id=demand.product_id AND stock_batch.storage_id=demand.storage_id;
        capacity := COALESCE(capacity,0);
      ELSE
        SELECT GREATEST(COALESCE(inventory.quantity,0)-COALESCE(SUM(stock_batch.quantity)
          FILTER (WHERE NOT COALESCE(stock_batch.is_deleted,false)),0),0)
          INTO capacity FROM public.inventory inventory
          LEFT JOIN public.stock_batches stock_batch ON stock_batch.workspace_id=p_workspace_id
            AND stock_batch.product_id=demand.product_id AND stock_batch.storage_id=demand.storage_id
          WHERE inventory.workspace_id=p_workspace_id AND inventory.product_id=demand.product_id
            AND inventory.storage_id=demand.storage_id AND NOT COALESCE(inventory.is_deleted,false)
          GROUP BY inventory.quantity;
        capacity := COALESCE(capacity,0);
      END IF;
      other_reserved := private.reserved_stock_source(p_workspace_id,demand.product_id,demand.storage_id,
        demand.source_type,demand.batch_id,p_order_id);
      IF NOT p_skip_validation AND demand.quantity>own_reserved+GREATEST(capacity-other_reserved,0)+0.0000005 THEN
        RAISE EXCEPTION 'stock_reserved' USING ERRCODE='23514', DETAIL=pg_catalog.jsonb_build_object(
          'workspaceId',p_workspace_id,'productId',demand.product_id,'storageId',demand.storage_id,
          'batchId',demand.batch_id,'sourceType',demand.source_type,'onHand',capacity,
          'reserved',other_reserved,'required',demand.quantity,'available',GREATEST(capacity-other_reserved,0))::text;
      END IF;
    END LOOP;
  END IF;

  DELETE FROM private.sales_order_stock_source_reservations WHERE order_id=p_order_id;
  IF p_status<>'pending' OR COALESCE(p_is_deleted,false) THEN RETURN; END IF;

  INSERT INTO private.sales_order_stock_source_reservations(order_id,workspace_id,product_id,storage_id,source_type,batch_id,quantity)
  SELECT p_order_id,p_workspace_id,source_demand.product_id,source_demand.storage_id,source_demand.source_type,source_demand.batch_id,source_demand.quantity
  FROM private.order_stock_source_demands(p_items,p_source_storage_id) source_demand
  JOIN public.products product ON product.id=source_demand.product_id AND product.workspace_id=p_workspace_id
  WHERE NOT COALESCE(product.is_service,false) AND source_demand.storage_id IS NOT NULL
    AND (source_demand.source_type='regular' OR EXISTS (
      SELECT 1 FROM public.stock_batches stock_batch_row
      WHERE stock_batch_row.id=source_demand.batch_id AND stock_batch_row.workspace_id=p_workspace_id
        AND stock_batch_row.product_id=source_demand.product_id AND stock_batch_row.storage_id=source_demand.storage_id));

  FOR demand IN
    SELECT required.* FROM private.order_stock_auto_source_demands(p_items,p_source_storage_id) required
    JOIN public.products product ON product.id=required.product_id AND product.workspace_id=p_workspace_id
    WHERE NOT COALESCE(product.is_service,false)
  LOOP
    IF demand.storage_id IS NULL THEN
      IF p_skip_validation THEN CONTINUE; END IF;
      RAISE EXCEPTION 'source_storage_required' USING ERRCODE='23514';
    END IF;
    remaining := demand.quantity;
    FOR batch IN
      SELECT stock_batch.id,stock_batch.quantity,stock_batch.batch_number
      FROM public.stock_batches stock_batch
      WHERE stock_batch.workspace_id=p_workspace_id AND stock_batch.product_id=demand.product_id
        AND stock_batch.storage_id=demand.storage_id AND NOT COALESCE(stock_batch.is_deleted,false)
      ORDER BY stock_batch.expiry_date NULLS LAST,stock_batch.manufacturing_date NULLS LAST,
        stock_batch.created_at,stock_batch.batch_number,stock_batch.id
    LOOP
      EXIT WHEN remaining<=0.0000005;
      other_reserved := private.reserved_stock_source(p_workspace_id,demand.product_id,demand.storage_id,'batch',batch.id,NULL);
      allocated := LEAST(remaining,GREATEST(batch.quantity-other_reserved,0));
      IF allocated>0.0000005 THEN
        INSERT INTO private.sales_order_stock_source_reservations(order_id,workspace_id,product_id,storage_id,source_type,batch_id,quantity)
        VALUES (p_order_id,p_workspace_id,demand.product_id,demand.storage_id,'batch',batch.id,allocated);
        remaining := GREATEST(remaining-allocated,0);
      END IF;
    END LOOP;

    SELECT GREATEST(COALESCE(inventory.quantity,0)-COALESCE(SUM(stock_batch.quantity)
      FILTER (WHERE NOT COALESCE(stock_batch.is_deleted,false)),0),0)
      INTO regular_on_hand FROM public.inventory inventory
      LEFT JOIN public.stock_batches stock_batch ON stock_batch.workspace_id=p_workspace_id
        AND stock_batch.product_id=demand.product_id AND stock_batch.storage_id=demand.storage_id
      WHERE inventory.workspace_id=p_workspace_id AND inventory.product_id=demand.product_id
        AND inventory.storage_id=demand.storage_id AND NOT COALESCE(inventory.is_deleted,false)
      GROUP BY inventory.quantity;
    regular_reserved := private.reserved_stock_source(p_workspace_id,demand.product_id,demand.storage_id,'regular',NULL,NULL);
    allocated := LEAST(remaining,GREATEST(COALESCE(regular_on_hand,0)-regular_reserved,0));
    remaining := GREATEST(remaining-allocated,0);
    IF remaining>0.0000005 AND NOT p_skip_validation THEN
      RAISE EXCEPTION 'stock_reserved' USING ERRCODE='23514', DETAIL=pg_catalog.jsonb_build_object(
        'workspaceId',p_workspace_id,'productId',demand.product_id,'storageId',demand.storage_id,
        'sourceType','auto','onHand',demand.quantity,'reserved',demand.quantity-remaining,
        'required',demand.quantity,'available',demand.quantity-remaining)::text;
    END IF;
    IF allocated>0.0000005 OR (remaining>0.0000005 AND p_skip_validation) THEN
      INSERT INTO private.sales_order_stock_source_reservations(order_id,workspace_id,product_id,storage_id,source_type,batch_id,quantity)
      VALUES (p_order_id,p_workspace_id,demand.product_id,demand.storage_id,'regular',NULL,allocated+CASE WHEN p_skip_validation THEN remaining ELSE 0 END)
      ON CONFLICT (order_id,product_id,storage_id,source_type,batch_id)
      DO UPDATE SET quantity=private.sales_order_stock_source_reservations.quantity+EXCLUDED.quantity;
    END IF;
  END LOOP;
  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION private.synchronize_sales_order_stock_source_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE skip_validation boolean := COALESCE(pg_catalog.current_setting('atlas.stock_source_backfill',true),'false')='true';
BEGIN
  IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.items IS NOT DISTINCT FROM OLD.items AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted
    AND NEW.source_storage_id IS NOT DISTINCT FROM OLD.source_storage_id
    AND (skip_validation OR EXISTS (SELECT 1 FROM private.sales_order_stock_source_reservations WHERE order_id=NEW.id))
  THEN RETURN NEW; END IF;
  PERFORM private.rebuild_sales_order_stock_source_reservations(
    NEW.id,NEW.workspace_id,NEW.status,NEW.is_deleted,NEW.items,NEW.source_storage_id,skip_validation);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.rebuild_sales_order_stock_source_reservations(uuid,uuid,text,boolean,jsonb,uuid,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.synchronize_sales_order_stock_source_reservations() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER sales_order_stock_source_reservations AFTER INSERT OR UPDATE OF status,items,is_deleted,source_storage_id ON crm.sales_orders
FOR EACH ROW EXECUTE FUNCTION private.synchronize_sales_order_stock_source_reservations();

-- Preload exact source choices first, then deterministically project legacy
-- orders whose items predate explicit source snapshots.
INSERT INTO private.sales_order_stock_source_reservations(order_id,workspace_id,product_id,storage_id,source_type,batch_id,quantity)
SELECT orders.id,orders.workspace_id,demand.product_id,demand.storage_id,demand.source_type,demand.batch_id,demand.quantity
FROM crm.sales_orders orders
CROSS JOIN LATERAL private.order_stock_source_demands(orders.items,orders.source_storage_id) demand
JOIN public.products product ON product.id=demand.product_id AND product.workspace_id=orders.workspace_id
WHERE orders.status='pending' AND NOT COALESCE(orders.is_deleted,false)
  AND NOT COALESCE(product.is_service,false) AND demand.storage_id IS NOT NULL
  AND (demand.source_type='regular' OR EXISTS (
    SELECT 1 FROM public.stock_batches batch
    WHERE batch.id=demand.batch_id AND batch.workspace_id=orders.workspace_id
      AND batch.product_id=demand.product_id AND batch.storage_id=demand.storage_id))
ON CONFLICT (order_id,product_id,storage_id,source_type,batch_id) DO UPDATE SET quantity=EXCLUDED.quantity;

DO $migration$
DECLARE pending_order record;
BEGIN
  FOR pending_order IN
    SELECT id,workspace_id,status,is_deleted,items,source_storage_id
    FROM crm.sales_orders WHERE status='pending' AND NOT COALESCE(is_deleted,false)
    ORDER BY created_at,id
  LOOP
    PERFORM private.rebuild_sales_order_stock_source_reservations(
      pending_order.id,pending_order.workspace_id,pending_order.status,pending_order.is_deleted,
      pending_order.items,pending_order.source_storage_id,true);
  END LOOP;
END;
$migration$;

CREATE OR REPLACE FUNCTION private.protect_reserved_stock_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE next_quantity numeric; previous_quantity numeric; reserved numeric; own_order uuid;
  movement text := pg_catalog.current_setting('atlas.inventory_transaction_type',true);
BEGIN
  previous_quantity := CASE WHEN COALESCE(OLD.is_deleted,false) THEN 0 ELSE OLD.quantity END;
  next_quantity := CASE WHEN TG_OP='DELETE' OR COALESCE(NEW.is_deleted,false) THEN 0 ELSE NEW.quantity END;
  IF TG_OP='UPDATE' AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
    AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted
    AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
    AND NEW.storage_id IS NOT DISTINCT FROM OLD.storage_id
  THEN RETURN NEW; END IF;
  PERFORM 1 FROM public.inventory inventory
  WHERE inventory.workspace_id=OLD.workspace_id AND (
    (inventory.product_id=OLD.product_id AND inventory.storage_id=OLD.storage_id)
    OR (TG_OP='UPDATE' AND inventory.product_id=NEW.product_id AND inventory.storage_id=NEW.storage_id))
  ORDER BY inventory.id FOR UPDATE;
  IF TG_OP='UPDATE' AND (NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.storage_id IS DISTINCT FROM OLD.storage_id)
    AND private.reserved_stock_source(OLD.workspace_id,OLD.product_id,OLD.storage_id,'batch',OLD.id,NULL)>0
  THEN RAISE EXCEPTION 'stock_batch_reserved' USING ERRCODE='23514'; END IF;
  IF next_quantity>=previous_quantity-0.0000005 THEN RETURN COALESCE(NEW,OLD); END IF;
  own_order := NULLIF(pg_catalog.current_setting('atlas.reservation_fulfillment_order_id',true),'')::uuid;
  IF own_order IS NULL AND movement IN ('stock_adjustment','inventory_change')
    AND COALESCE(pg_catalog.current_setting('atlas.inventory_reference_type',true),'')<>'sales_order_completion'
  THEN RETURN COALESCE(NEW,OLD); END IF;
  reserved := private.reserved_stock_source(OLD.workspace_id,OLD.product_id,OLD.storage_id,'batch',OLD.id,own_order);
  IF reserved>next_quantity+0.0000005 THEN
    RAISE EXCEPTION 'stock_reserved' USING ERRCODE='23514', DETAIL=pg_catalog.jsonb_build_object(
      'workspaceId',OLD.workspace_id,'productId',OLD.product_id,'storageId',OLD.storage_id,
      'batchId',OLD.id,'sourceType','batch','onHand',previous_quantity,'reserved',reserved,
      'required',previous_quantity-next_quantity,'available',GREATEST(previous_quantity-reserved,0))::text;
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$function$;
REVOKE ALL ON FUNCTION private.protect_reserved_stock_batch() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER stock_batches_protect_source_reservations
BEFORE UPDATE OF quantity,is_deleted,product_id,storage_id OR DELETE ON public.stock_batches
FOR EACH ROW EXECUTE FUNCTION private.protect_reserved_stock_batch();

CREATE OR REPLACE FUNCTION public.get_stock_batch_source_availability(
  p_workspace_id uuid,p_positions jsonb,p_exclude_order_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE result jsonb;
BEGIN
  IF p_workspace_id IS DISTINCT FROM public.current_workspace_id() THEN
    RAISE EXCEPTION 'workspace_access_denied' USING ERRCODE='42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_positions)<>'array' OR pg_catalog.jsonb_array_length(p_positions)>200 THEN
    RAISE EXCEPTION 'invalid_stock_positions' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'productId',position.product_id,'storageId',position.storage_id,
    'regularQuantity',GREATEST(COALESCE(inventory.quantity,0)-COALESCE(batch_totals.quantity,0),0),
    'regularReserved',private.reserved_stock_source(p_workspace_id,position.product_id,position.storage_id,'regular',NULL,p_exclude_order_id),
    'regularAvailable',GREATEST(
      GREATEST(COALESCE(inventory.quantity,0)-COALESCE(batch_totals.quantity,0),0)
        - private.reserved_stock_source(p_workspace_id,position.product_id,position.storage_id,'regular',NULL,p_exclude_order_id),0),
    'batches',COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'batchId',stock_batch.id,
        'quantity',stock_batch.quantity,
        'reserved',private.reserved_stock_source(p_workspace_id,position.product_id,position.storage_id,'batch',stock_batch.id,p_exclude_order_id),
        'available',GREATEST(stock_batch.quantity-private.reserved_stock_source(
          p_workspace_id,position.product_id,position.storage_id,'batch',stock_batch.id,p_exclude_order_id),0)
      ) ORDER BY stock_batch.expiry_date NULLS LAST,stock_batch.manufacturing_date NULLS LAST,
        stock_batch.created_at,stock_batch.batch_number,stock_batch.id)
      FROM public.stock_batches stock_batch
      WHERE stock_batch.workspace_id=p_workspace_id AND stock_batch.product_id=position.product_id
        AND stock_batch.storage_id=position.storage_id AND NOT COALESCE(stock_batch.is_deleted,false)
    ),'[]'::jsonb)
  )), '[]'::jsonb)
  INTO result
  FROM (SELECT DISTINCT NULLIF(item->>'productId','')::uuid product_id,NULLIF(item->>'storageId','')::uuid storage_id
    FROM pg_catalog.jsonb_array_elements(p_positions) item) position
  JOIN public.products product ON product.id=position.product_id AND product.workspace_id=p_workspace_id
    AND NOT COALESCE(product.is_deleted,false) AND NOT COALESCE(product.is_service,false)
  LEFT JOIN public.inventory inventory ON inventory.product_id=position.product_id AND inventory.storage_id=position.storage_id
    AND inventory.workspace_id=p_workspace_id AND NOT COALESCE(inventory.is_deleted,false)
  LEFT JOIN LATERAL (
    SELECT SUM(stock_batch.quantity) quantity FROM public.stock_batches stock_batch
    WHERE stock_batch.workspace_id=p_workspace_id AND stock_batch.product_id=position.product_id
      AND stock_batch.storage_id=position.storage_id AND NOT COALESCE(stock_batch.is_deleted,false)
  ) batch_totals ON true
  WHERE public.current_user_can_access_storage(p_workspace_id,position.storage_id)
    AND private.current_user_can_access_any_product_storage(p_workspace_id,product.id,product.storage_id);
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_stock_batch_source_availability(uuid,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_stock_batch_source_availability(uuid,jsonb,uuid) TO authenticated;
