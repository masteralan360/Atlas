-- Service lines carry no physical storage. The desktop form used a temporary
-- `__atlas_services__` selector value before this migration, so validate the
-- product kind before attempting to cast a line storage value to UUID.
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
  item_product_id uuid;
  item_is_service boolean;
  item_storage_id uuid;
  item_storage_value text;
BEGIN
  -- Server-side/system workflows do not carry an end-user JWT. Their own
  -- privileged RPCs retain responsibility for validating their input.
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    item_product_id := NULLIF(
      COALESCE(item ->> 'productId', item ->> 'product_id'),
      ''
    )::uuid;

    SELECT COALESCE(product.is_service, false)
    INTO item_is_service
    FROM public.products AS product
    WHERE product.id = item_product_id
      AND product.workspace_id = p_workspace_id;

    -- Services intentionally have no storage and may carry the virtual
    -- selector from a queued pre-fix desktop mutation.
    IF COALESCE(item_is_service, false) THEN
      CONTINUE;
    END IF;

    item_storage_value := COALESCE(item ->> 'storageId', item ->> 'storage_id');
    IF item_storage_value = '__atlas_services__' THEN
      RAISE EXCEPTION 'The Services location can only be used for service order lines'
        USING ERRCODE = '23514';
    END IF;

    item_storage_id := COALESCE(
      NULLIF(item_storage_value, '')::uuid,
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

NOTIFY pgrst, 'reload schema';
