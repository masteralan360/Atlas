-- Marketplace order items can be increased or reduced before shipment.
-- Keep the existing item identity, unit-price, status, discount, and metadata
-- guards in edit_marketplace_order_items; remove only the original-quantity cap.
DO $marketplace_item_quantity_increase$
DECLARE
  v_definition text;
  v_updated text;
  v_old text := $old$          v_original_qty := COALESCE(NULLIF(v_original->>'quantity', '')::integer, 0);

          IF v_qty > v_original_qty THEN
            RAISE EXCEPTION 'Quantity for %s cannot exceed the originally ordered quantity', COALESCE(NULLIF(v_original->>'name', ''), 'Item');
          END IF;
$old$;
BEGIN
  SELECT pg_get_functiondef(
    'public.edit_marketplace_order_items(uuid,jsonb)'::regprocedure
  ) INTO v_definition;

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Marketplace item-edit function was not found';
  END IF;

  v_definition := replace(v_definition, chr(13), '');
  v_old := replace(v_old, chr(13), '');

  IF position('Quantity for %s cannot exceed the originally ordered quantity' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Marketplace item-edit function is not in the expected quantity-limited state';
  END IF;

  v_updated := replace(v_definition, v_old, '');
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Original-quantity limit could not be removed from marketplace item edits';
  END IF;

  v_definition := v_updated;
  v_updated := replace(v_definition, E'  v_original_qty integer;\n', '');
  IF v_updated IS NOT DISTINCT FROM v_definition THEN
    RAISE EXCEPTION 'Original quantity variable could not be removed from marketplace item edits';
  END IF;

  IF position('Quantity for %s cannot exceed the originally ordered quantity' IN v_updated) > 0 THEN
    RAISE EXCEPTION 'Original-quantity limit remains in marketplace item edits';
  END IF;

  IF position('v_original_qty' IN v_updated) > 0 THEN
    RAISE EXCEPTION 'Original quantity variable remains in marketplace item edits';
  END IF;

  EXECUTE v_updated;
END;
$marketplace_item_quantity_increase$;
