-- Pending Sales Orders own reservations. This private, indexed projection is
-- rebuilt without changing historical orders or their financial records.
LOCK TABLE crm.sales_orders IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE private.sales_order_stock_reservations (
  order_id uuid NOT NULL REFERENCES crm.sales_orders(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  product_id uuid NOT NULL,
  storage_id uuid,
  quantity numeric NOT NULL CHECK (quantity > 0 AND quantity::text NOT IN ('NaN','Infinity','-Infinity'))
);
CREATE UNIQUE INDEX sales_order_stock_reservation_position
  ON private.sales_order_stock_reservations(order_id, product_id, storage_id) NULLS NOT DISTINCT;
CREATE INDEX sales_order_stock_reservation_lookup
  ON private.sales_order_stock_reservations(workspace_id, product_id, storage_id);
ALTER TABLE private.sales_order_stock_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.sales_order_stock_reservations FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.order_stock_requirements(p_items jsonb, p_storage_id uuid)
RETURNS TABLE(product_id uuid, storage_id uuid, quantity numeric)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $function$
  SELECT NULLIF(item->>'productId','')::uuid,
    COALESCE(NULLIF(item->>'storageId','')::uuid, p_storage_id),
    pg_catalog.round(SUM(
      COALESCE(NULLIF(item->>'inventoryQuantity','')::numeric,
        COALESCE(NULLIF(item->>'quantity','')::numeric,0) * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
      + COALESCE(NULLIF(item->>'freeBonusInventoryQuantity','')::numeric,
        COALESCE(NULLIF(COALESCE(item->>'freeBonusQuantity',item->>'freeQuantity'),'')::numeric,0)
          * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
    ),6)
  FROM pg_catalog.jsonb_array_elements(COALESCE(p_items,'[]'::jsonb)) item
  GROUP BY 1,2 HAVING SUM(
    COALESCE(NULLIF(item->>'inventoryQuantity','')::numeric,
      COALESCE(NULLIF(item->>'quantity','')::numeric,0) * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
    + COALESCE(NULLIF(item->>'freeBonusInventoryQuantity','')::numeric,
      COALESCE(NULLIF(COALESCE(item->>'freeBonusQuantity',item->>'freeQuantity'),'')::numeric,0)
        * COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))) > 0;
$function$;
REVOKE ALL ON FUNCTION private.order_stock_requirements(jsonb,uuid) FROM PUBLIC,anon,authenticated;

INSERT INTO private.sales_order_stock_reservations
SELECT orders.id, orders.workspace_id, requirement.product_id, requirement.storage_id, requirement.quantity
FROM crm.sales_orders orders
CROSS JOIN LATERAL private.order_stock_requirements(orders.items,orders.source_storage_id) requirement
JOIN public.products product ON product.id=requirement.product_id AND product.workspace_id=orders.workspace_id
WHERE orders.status='pending' AND NOT COALESCE(orders.is_deleted,false) AND NOT COALESCE(product.is_service,false);

CREATE OR REPLACE FUNCTION private.reserved_stock(p_workspace uuid,p_product uuid,p_storage uuid,p_exclude uuid DEFAULT NULL)
RETURNS numeric LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT COALESCE(SUM(quantity),0) FROM private.sales_order_stock_reservations
  WHERE workspace_id=p_workspace AND product_id=p_product
    AND (storage_id=p_storage OR storage_id IS NULL)
    AND (p_exclude IS NULL OR order_id<>p_exclude);
$function$;
REVOKE ALL ON FUNCTION private.reserved_stock(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.raise_stock_reservation_conflict(
  p_workspace uuid,p_product uuid,p_storage uuid,p_on_hand numeric,p_reserved numeric,p_required numeric)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  RAISE EXCEPTION 'stock_reserved' USING ERRCODE='23514', DETAIL=pg_catalog.jsonb_build_object(
    'workspaceId',p_workspace,'productId',p_product,'storageId',p_storage,
    'onHand',p_on_hand,'reserved',p_reserved,'required',p_required,'available',GREATEST(p_on_hand-p_reserved,0))::text;
END;
$function$;
REVOKE ALL ON FUNCTION private.raise_stock_reservation_conflict(uuid,uuid,uuid,numeric,numeric,numeric) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION private.synchronize_sales_order_stock_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE position record; on_hand numeric; reserved numeric; old_reserved numeric;
BEGIN
  IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.items IS NOT DISTINCT FROM OLD.items AND NEW.is_deleted IS NOT DISTINCT FROM OLD.is_deleted
    AND NEW.source_storage_id IS NOT DISTINCT FROM OLD.source_storage_id THEN RETURN NEW; END IF;
  -- Lock inventory positions before publishing a reservation. A sale takes the
  -- same row locks, so it cannot commit against an earlier reservation total.
  FOR position IN
    SELECT DISTINCT inventory.id FROM public.inventory inventory
    JOIN (SELECT product_id,storage_id FROM private.order_stock_requirements(NEW.items,NEW.source_storage_id)
      UNION SELECT product_id,storage_id FROM private.sales_order_stock_reservations WHERE order_id=NEW.id) wanted
      ON wanted.product_id=inventory.product_id AND (wanted.storage_id=inventory.storage_id OR wanted.storage_id IS NULL)
    WHERE inventory.workspace_id=NEW.workspace_id ORDER BY inventory.id
  LOOP
    PERFORM 1 FROM public.inventory WHERE id=position.id FOR UPDATE;
  END LOOP;
  IF NEW.status='pending' AND NOT COALESCE(NEW.is_deleted,false) THEN
    FOR position IN
      SELECT requirement.* FROM private.order_stock_requirements(NEW.items,NEW.source_storage_id) requirement
      JOIN public.products product ON product.id=requirement.product_id AND product.workspace_id=NEW.workspace_id
      WHERE NOT COALESCE(product.is_service,false)
    LOOP
      IF position.storage_id IS NULL THEN RAISE EXCEPTION 'source_storage_required' USING ERRCODE='23514'; END IF;
      SELECT COALESCE(SUM(quantity),0) INTO old_reserved FROM private.sales_order_stock_reservations
        WHERE order_id=NEW.id AND product_id=position.product_id AND storage_id=position.storage_id;
      -- Existing overcommitments remain visible. Only new/increased commitments are rejected.
      IF position.quantity>old_reserved+0.0000005 THEN
        SELECT COALESCE(MAX(CASE WHEN NOT COALESCE(is_deleted,false) THEN quantity ELSE 0 END),0) INTO on_hand
          FROM public.inventory WHERE workspace_id=NEW.workspace_id AND product_id=position.product_id AND storage_id=position.storage_id;
        reserved := private.reserved_stock(NEW.workspace_id,position.product_id,position.storage_id,NEW.id);
        IF position.quantity>on_hand-reserved+0.0000005 THEN
          PERFORM private.raise_stock_reservation_conflict(NEW.workspace_id,position.product_id,position.storage_id,on_hand,reserved,position.quantity);
        END IF;
      END IF;
    END LOOP;
  END IF;
  DELETE FROM private.sales_order_stock_reservations WHERE order_id=NEW.id;
  IF NEW.status='pending' AND NOT COALESCE(NEW.is_deleted,false) THEN
    INSERT INTO private.sales_order_stock_reservations
    SELECT NEW.id,NEW.workspace_id,requirement.product_id,requirement.storage_id,requirement.quantity
    FROM private.order_stock_requirements(NEW.items,NEW.source_storage_id) requirement
    JOIN public.products product ON product.id=requirement.product_id AND product.workspace_id=NEW.workspace_id
    WHERE NOT COALESCE(product.is_service,false);
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION private.synchronize_sales_order_stock_reservations() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER sales_order_stock_reservations AFTER INSERT OR UPDATE OF status,items,is_deleted,source_storage_id ON crm.sales_orders
FOR EACH ROW EXECUTE FUNCTION private.synchronize_sales_order_stock_reservations();

CREATE OR REPLACE FUNCTION private.protect_reserved_inventory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE next_quantity numeric; previous_quantity numeric; reserved numeric; own_order uuid;
  movement text := pg_catalog.current_setting('atlas.inventory_transaction_type',true);
BEGIN
  previous_quantity := CASE WHEN COALESCE(OLD.is_deleted,false) THEN 0 ELSE OLD.quantity END;
  next_quantity := CASE WHEN TG_OP='DELETE' OR COALESCE(NEW.is_deleted,false) THEN 0 ELSE NEW.quantity END;
  IF next_quantity>=previous_quantity-0.0000005 THEN RETURN COALESCE(NEW,OLD); END IF;
  own_order := NULLIF(pg_catalog.current_setting('atlas.reservation_fulfillment_order_id',true),'')::uuid;
  -- Stock losses and physical corrections must still be recordable.
  IF own_order IS NULL AND movement IN ('stock_adjustment','inventory_change')
    AND COALESCE(pg_catalog.current_setting('atlas.inventory_reference_type',true),'')<>'sales_order_completion'
  THEN RETURN COALESCE(NEW,OLD); END IF;
  -- Audit references can originate in client snapshots. They never authorize
  -- consuming a reservation; only a validated fulfillment boundary sets owner.
  reserved := private.reserved_stock(OLD.workspace_id,OLD.product_id,OLD.storage_id,own_order);
  IF reserved>0 AND next_quantity<reserved-0.0000005 THEN
    PERFORM private.raise_stock_reservation_conflict(OLD.workspace_id,OLD.product_id,OLD.storage_id,
      previous_quantity,reserved,previous_quantity-next_quantity);
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$function$;
REVOKE ALL ON FUNCTION private.protect_reserved_inventory() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER inventory_protect_reservations BEFORE UPDATE OF quantity,is_deleted OR DELETE ON public.inventory
FOR EACH ROW EXECUTE FUNCTION private.protect_reserved_inventory();

-- Complete the owning order against its own reservation, using validated,
-- server-side identity rather than a caller-supplied exclusion flag.
DO $migration$
DECLARE definition text; marker text := 'v_stock_result := private.apply_inventory_snapshot_changes(';
BEGIN
  SELECT pg_catalog.pg_get_functiondef('private.complete_sales_order_with_inventory(uuid,uuid,bigint,uuid,jsonb,timestamptz,jsonb)'::regprocedure) INTO definition;
  IF pg_catalog.strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Sales order completion boundary changed'; END IF;
  definition := pg_catalog.replace(definition,marker,
    E'PERFORM pg_catalog.set_config(''atlas.reservation_fulfillment_order_id'',p_order_id::text,true);\n'
    || E'    PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'',''sales_order'',true);\n'
    || E'    PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'',p_order_id::text,true);\n'
    || E'    PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'',''sale'',true);\n    ' || marker);
  EXECUTE definition;
  IF pg_catalog.to_regprocedure('public.transition_marketplace_order(uuid,text,text)') IS NOT NULL THEN
    SELECT pg_catalog.pg_get_functiondef('public.transition_marketplace_order(uuid,text,text)'::regprocedure) INTO definition;
    marker := 'PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', v_sales_order_id::text, true);';
    IF pg_catalog.strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Marketplace fulfillment boundary changed'; END IF;
    EXECUTE pg_catalog.replace(definition,marker,marker || E'\n      PERFORM pg_catalog.set_config(''atlas.reservation_fulfillment_order_id'',v_sales_order_id::text,true);');
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.get_stock_reservation_availability(p_workspace_id uuid,p_positions jsonb,p_exclude_order_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE result jsonb;
BEGIN
  IF p_workspace_id IS DISTINCT FROM public.current_workspace_id() OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'workspace_access_denied' USING ERRCODE='42501';
  END IF;
  IF pg_catalog.jsonb_typeof(p_positions)<>'array' OR pg_catalog.jsonb_array_length(p_positions)>200 THEN
    RAISE EXCEPTION 'invalid_stock_positions' USING ERRCODE='22023';
  END IF;
  -- Exclusion is presentation-only; mutation guards never trust this argument.
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'productId',position.product_id,'storageId',position.storage_id,'onHand',COALESCE(inventory.quantity,0),
    'reserved',private.reserved_stock(p_workspace_id,position.product_id,position.storage_id,p_exclude_order_id),
    'available',GREATEST(COALESCE(inventory.quantity,0)-private.reserved_stock(p_workspace_id,position.product_id,position.storage_id,p_exclude_order_id),0))), '[]'::jsonb)
  INTO result
  FROM (SELECT DISTINCT NULLIF(item->>'productId','')::uuid product_id,NULLIF(item->>'storageId','')::uuid storage_id
    FROM pg_catalog.jsonb_array_elements(p_positions) item) position
  JOIN public.products product ON product.id=position.product_id AND product.workspace_id=p_workspace_id
    AND NOT COALESCE(product.is_deleted,false) AND NOT COALESCE(product.is_service,false)
  LEFT JOIN public.inventory inventory ON inventory.product_id=position.product_id AND inventory.storage_id=position.storage_id
    AND inventory.workspace_id=p_workspace_id AND NOT COALESCE(inventory.is_deleted,false)
  WHERE public.current_user_can_access_storage(p_workspace_id,position.storage_id)
    AND private.current_user_can_access_any_product_storage(p_workspace_id,product.id,product.storage_id);
  RETURN result;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_stock_reservation_availability(uuid,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_stock_reservation_availability(uuid,jsonb,uuid) TO authenticated;

-- SECURITY INVOKER deliberately preserves order RLS (including View Own).
CREATE OR REPLACE FUNCTION public.get_visible_stock_reservations(p_workspace_id uuid,p_product_id uuid,p_storage_id uuid,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $function$
  WITH matching AS (
    SELECT orders.id,orders.order_number,orders.created_at,pg_catalog.round(SUM(
      COALESCE(NULLIF(item->>'inventoryQuantity','')::numeric,COALESCE(NULLIF(item->>'quantity','')::numeric,0)*COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
      +COALESCE(NULLIF(item->>'freeBonusInventoryQuantity','')::numeric,COALESCE(NULLIF(COALESCE(item->>'freeBonusQuantity',item->>'freeQuantity'),'')::numeric,0)*COALESCE(NULLIF(item->>'unitFactor','')::numeric,1))
    ),6) quantity
    FROM crm.sales_orders orders CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(orders.items) item
    WHERE orders.workspace_id=p_workspace_id AND p_workspace_id=public.current_workspace_id()
      AND orders.status='pending' AND NOT COALESCE(orders.is_deleted,false)
      AND NULLIF(item->>'productId','')::uuid=p_product_id
      AND (COALESCE(NULLIF(item->>'storageId','')::uuid,orders.source_storage_id) IS NULL
        OR COALESCE(NULLIF(item->>'storageId','')::uuid,orders.source_storage_id)=p_storage_id)
      AND public.current_user_can_access_storage(p_workspace_id,p_storage_id)
    GROUP BY orders.id,orders.order_number,orders.created_at
  ), page AS (SELECT * FROM matching ORDER BY id OFFSET GREATEST(p_offset,0) LIMIT 20)
  SELECT pg_catalog.jsonb_build_object('total',(SELECT COUNT(*) FROM matching),'rows',COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(page)) FROM page),'[]'::jsonb));
$function$;
REVOKE ALL ON FUNCTION public.get_visible_stock_reservations(uuid,uuid,uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_visible_stock_reservations(uuid,uuid,uuid,integer) TO authenticated;

-- Only storefront gateways using the service role can read this workspace
-- aggregate. Public responses contain sellable quantities, never reservations.
CREATE OR REPLACE FUNCTION public.get_storefront_sellable_quantities(p_workspace_id uuid,p_product_ids uuid[],p_storage_ids uuid[])
RETURNS TABLE(product_id uuid,storage_id uuid,quantity numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT inventory.product_id,inventory.storage_id,
    GREATEST(inventory.quantity-private.reserved_stock(p_workspace_id,inventory.product_id,inventory.storage_id,NULL),0)
  FROM public.inventory inventory
  WHERE inventory.workspace_id=p_workspace_id AND inventory.product_id=ANY(p_product_ids)
    AND inventory.storage_id=ANY(p_storage_ids) AND NOT COALESCE(inventory.is_deleted,false)
    AND COALESCE(pg_catalog.array_length(p_product_ids,1),0)<=200;
$function$;
REVOKE ALL ON FUNCTION public.get_storefront_sellable_quantities(uuid,uuid[],uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_storefront_sellable_quantities(uuid,uuid[],uuid[]) TO service_role;
