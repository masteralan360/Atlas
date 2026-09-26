-- Keep stale-order and inventory compare-and-set conflicts out of PostgreSQL
-- error logs. The completion RPC returns bounded conflict envelopes instead.
DO $sales_order_completion_conflict_envelopes$
DECLARE
  function_definition text;
  marker_position integer;
  marker_parts text[];
  return_parts text[];
  guard_start integer;
  guard_end_offset integer;
  success_return_start integer;
  function_end_start integer;
  guard_block text;
  guard_marker constant text := $guard_marker$IF COALESCE(v_order.version, 0)::bigint IS DISTINCT FROM p_expected_order_version THEN$guard_marker$;
  success_marker constant text := $success_marker$'already_applied', false$success_marker$;
  order_version_conflict constant text := $order_version_conflict$
  IF COALESCE(v_order.version, 0)::bigint IS DISTINCT FROM p_expected_order_version THEN
    RETURN pg_catalog.jsonb_build_object(
      'conflict', true,
      'conflict_reason', 'sales_order_version',
      'retry_after_ms', 5000,
      'current_order_version', COALESCE(v_order.version, 0)
    );
  END IF;
$order_version_conflict$;
  conflict_return constant text := $conflict_return$RETURN pg_catalog.jsonb_build_object(
    'order', pg_catalog.to_jsonb(v_order),
    'inventory', COALESCE(v_inventory_rows, '[]'::jsonb),
    'inventory_transactions', v_transaction_rows,
    'already_applied', false
  );
  EXCEPTION
    WHEN serialization_failure THEN
      RETURN pg_catalog.jsonb_build_object(
        'operation_id', p_operation_id,
        'inventory', NULL,
        'already_applied', false,
        'conflict', true,
        'conflict_reason', 'inventory_version',
        'retry_after_ms', 5000
      );
$conflict_return$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'private.complete_sales_order_with_inventory(uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb)'::regprocedure
  )
  INTO function_definition;

  guard_start := pg_catalog.strpos(function_definition, guard_marker);
  IF guard_start = 0 THEN
    RAISE EXCEPTION 'Sales order completion version guard marker was not found';
  END IF;

  guard_end_offset := pg_catalog.strpos(
    pg_catalog.substr(function_definition, guard_start),
    'END IF;'
  );
  IF guard_end_offset = 0 THEN
    RAISE EXCEPTION 'Sales order completion version guard end was not found';
  END IF;

  guard_block := pg_catalog.substr(
    function_definition,
    guard_start,
    guard_end_offset + pg_catalog.char_length('END IF;') - 1
  );
  IF pg_catalog.strpos(guard_block, 'Sales order changed on another device; refresh and retry') = 0
     OR pg_catalog.strpos(guard_block, 'ERRCODE = ''40001''') = 0 THEN
    RAISE EXCEPTION 'Sales order completion version guard was not the expected stale-version guard';
  END IF;

  function_definition :=
    pg_catalog.substr(function_definition, 1, guard_start - 1)
    || order_version_conflict
    || pg_catalog.substr(
      function_definition,
      guard_start + guard_end_offset + pg_catalog.char_length('END IF;') - 1
    );

  -- Locate the final success return using its distinctive marker, then locate
  -- the preceding jsonb return without depending on pg_get_functiondef spacing.
  marker_parts := pg_catalog.regexp_match(
    function_definition,
    '(?s)^(.*)' || success_marker
  );
  IF marker_parts IS NULL THEN
    RAISE EXCEPTION 'Sales order completion success marker was not found';
  END IF;
  marker_position := pg_catalog.char_length(marker_parts[1]) + 1;

  return_parts := pg_catalog.regexp_match(
    pg_catalog.substr(function_definition, 1, marker_position),
    '(?s)^(.*)(RETURN pg_catalog[.]jsonb_build_object\()'
  );
  IF return_parts IS NULL THEN
    RAISE EXCEPTION 'Sales order completion success return was not found';
  END IF;
  success_return_start := pg_catalog.char_length(return_parts[1]) + 1;

  IF pg_catalog.strpos(
       pg_catalog.substr(function_definition, success_return_start, marker_position - success_return_start + pg_catalog.char_length(success_marker)),
       '''order'', pg_catalog.to_jsonb(v_order)'
     ) = 0
     OR pg_catalog.strpos(
       pg_catalog.substr(function_definition, success_return_start, marker_position - success_return_start + pg_catalog.char_length(success_marker)),
       '''inventory_transactions'', v_transaction_rows'
     ) = 0 THEN
    RAISE EXCEPTION 'Sales order completion success return was not the expected final result';
  END IF;

  function_end_start := marker_position + pg_catalog.strpos(
    pg_catalog.substr(function_definition, marker_position),
    'END;'
  ) - 1;
  IF function_end_start < marker_position THEN
    RAISE EXCEPTION 'Sales order completion function end was not found';
  END IF;

  function_definition :=
    pg_catalog.substr(function_definition, 1, success_return_start - 1)
    || conflict_return
    || pg_catalog.substr(function_definition, function_end_start);

  EXECUTE function_definition;
END;
$sales_order_completion_conflict_envelopes$;

COMMENT ON FUNCTION private.complete_sales_order_with_inventory(
  uuid, uuid, bigint, uuid, jsonb, timestamptz, jsonb
) IS 'Atomically completes a pending sales order; stale order and inventory versions return bounded conflict envelopes.';

NOTIFY pgrst, 'reload schema';
