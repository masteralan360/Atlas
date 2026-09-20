-- Surface a readable storage name in the marketplace delivery stock error.
-- The client maps the stable error sentence through i18next, so UUIDs must
-- never be included in its product or storage placeholders.
DO $migration$
DECLARE
  definition text;
  updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.transition_marketplace_order(uuid,text,text)'::regprocedure
  )
  INTO definition;

  IF definition IS NULL THEN
    RAISE EXCEPTION 'Marketplace delivery procedure was not found; inventory error localization was not applied.';
  END IF;

  -- A direct repair may already have installed this exact error lookup before
  -- its migration history is reconciled.
  IF position('storage.id = v_resolved_storage_id' IN definition) > 0
    AND position('Insufficient inventory for % in storage %' IN definition) > 0
  THEN
    RETURN;
  END IF;

  updated_definition := regexp_replace(
    definition,
    -- pg_get_functiondef normalizes whitespace, casts, and JSON operators.
    -- Replace this unique validation statement as a whole so the repair works
    -- across every deployed form of the marketplace delivery procedure.
    $regex$RAISE EXCEPTION 'Insufficient inventory for % in storage %',[\s\S]*?;$regex$,
    $replacement$RAISE EXCEPTION 'Insufficient inventory for % in storage %',
          COALESCE(NULLIF(v_item->>'name', ''), v_product_id::text),
          COALESCE((
            SELECT NULLIF(trim(storage.name), '')
            FROM public.storages AS storage
            WHERE storage.id = v_resolved_storage_id
              AND storage.workspace_id = v_order.workspace_id
              AND COALESCE(storage.is_deleted, false) = false
          ), 'Unknown storage')
          USING ERRCODE = '23514';$replacement$,
    'n'
  );

  IF updated_definition IS NOT DISTINCT FROM definition THEN
    RAISE EXCEPTION 'Marketplace delivery inventory error could not be updated to show the storage name.';
  END IF;

  EXECUTE updated_definition;
END;
$migration$;
