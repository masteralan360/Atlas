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
  -- These UI-only locations are not inventory positions. Treat them as absent
  -- before UUID casts so older clients cannot turn them into Postgres errors.
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'productId',position.product_id,'storageId',position.storage_id,'onHand',COALESCE(inventory.quantity,0),
    'reserved',private.reserved_stock(p_workspace_id,position.product_id,position.storage_id,p_exclude_order_id),
    'available',GREATEST(COALESCE(inventory.quantity,0)-private.reserved_stock(p_workspace_id,position.product_id,position.storage_id,p_exclude_order_id),0))), '[]'::jsonb)
  INTO result
  FROM (SELECT DISTINCT
      CASE WHEN item->>'productId' IN ('__atlas_services__','__atlas_activities__') THEN NULL
        ELSE NULLIF(item->>'productId','')::uuid END product_id,
      CASE WHEN item->>'storageId' IN ('__atlas_services__','__atlas_activities__') THEN NULL
        ELSE NULLIF(item->>'storageId','')::uuid END storage_id
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
