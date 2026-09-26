-- Keep the integrity audit queues transaction-scoped while satisfying the
-- hosted database's safe-update requirement for every DELETE statement.
DO $repair_inventory_integrity_queue_cleanup$
DECLARE
  function_definition text;
  transaction_delete constant text := 'DELETE FROM private.inventory_transaction_integrity_queue;';
  transaction_delete_scoped constant text :=
    'DELETE FROM private.inventory_transaction_integrity_queue WHERE transaction_id IS NOT NULL;';
  movement_delete constant text := 'DELETE FROM private.inventory_movement_audit_queue;';
  movement_delete_scoped constant text :=
    'DELETE FROM private.inventory_movement_audit_queue WHERE event_id IS NOT NULL;';
  changed boolean := false;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'private.flush_inventory_movement_audit()'::regprocedure
  )
  INTO function_definition;

  IF pg_catalog.strpos(function_definition, transaction_delete) > 0 THEN
    function_definition := pg_catalog.replace(
      function_definition,
      transaction_delete,
      transaction_delete_scoped
    );
    changed := true;
  ELSIF pg_catalog.strpos(function_definition, transaction_delete_scoped) = 0 THEN
    RAISE EXCEPTION 'Inventory transaction integrity queue cleanup did not match';
  END IF;

  IF pg_catalog.strpos(function_definition, movement_delete) > 0 THEN
    function_definition := pg_catalog.replace(
      function_definition,
      movement_delete,
      movement_delete_scoped
    );
    changed := true;
  ELSIF pg_catalog.strpos(function_definition, movement_delete_scoped) = 0 THEN
    RAISE EXCEPTION 'Inventory movement audit queue cleanup did not match';
  END IF;

  IF changed THEN
    EXECUTE function_definition;
  END IF;
END;
$repair_inventory_integrity_queue_cleanup$;
