-- Record inventory movements atomically with every authoritative inventory
-- position change. This migration deliberately does not backfill historical
-- inventory activity; only changes committed after installation are audited.

ALTER TABLE public.inventory_transactions
  DROP CONSTRAINT IF EXISTS inventory_transactions_type_check;

ALTER TABLE public.inventory_transactions
  ADD CONSTRAINT inventory_transactions_type_check CHECK (
    transaction_type IN (
      'stock_adjustment', 'transfer_in', 'transfer_out', 'sale', 'return',
      'purchase', 'initial_stock', 'inventory_change'
    )
  );

CREATE TABLE IF NOT EXISTS private.inventory_movement_audit_queue (
  event_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  product_id uuid NOT NULL,
  storage_id uuid NOT NULL,
  inventory_version integer NOT NULL,
  transaction_type text NOT NULL,
  quantity_delta numeric NOT NULL,
  previous_quantity numeric NOT NULL,
  new_quantity numeric NOT NULL,
  reference_id text,
  reference_type text,
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS inventory_movement_audit_queue_position_idx
  ON private.inventory_movement_audit_queue (
    workspace_id, product_id, storage_id, created_at
  );

ALTER TABLE private.inventory_movement_audit_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.inventory_movement_audit_queue
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.capture_inventory_movement_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_previous_quantity numeric;
  v_new_quantity numeric;
  v_delta numeric;
  v_type text;
  v_reference_id text;
  v_reference_type text;
  v_event_id uuid;
BEGIN
  v_previous_quantity := CASE
    WHEN TG_OP = 'INSERT' OR COALESCE(OLD.is_deleted, false) THEN 0
    ELSE COALESCE(OLD.quantity, 0)
  END;
  v_new_quantity := CASE
    WHEN COALESCE(NEW.is_deleted, false) THEN 0
    ELSE COALESCE(NEW.quantity, 0)
  END;
  -- The ledger schema requires non-negative snapshots. Legacy deficit rows
  -- represent no available stock, so audit their transition from a zero floor.
  v_previous_quantity := GREATEST(v_previous_quantity, 0);
  v_new_quantity := GREATEST(v_new_quantity, 0);
  v_delta := pg_catalog.round(v_new_quantity - v_previous_quantity, 6);

  IF pg_catalog.abs(v_delta) <= 0.0000005 THEN
    RETURN NEW;
  END IF;

  v_type := NULLIF(pg_catalog.btrim(
    pg_catalog.current_setting('atlas.inventory_transaction_type', true)
  ), '');
  IF v_type = 'inventory_transfer' THEN
    v_type := CASE WHEN v_delta > 0 THEN 'transfer_in' ELSE 'transfer_out' END;
  END IF;
  IF v_type IS NULL THEN
    v_type := CASE WHEN TG_OP = 'INSERT' THEN 'initial_stock' ELSE 'inventory_change' END;
  END IF;
  IF v_type NOT IN (
    'stock_adjustment', 'transfer_in', 'transfer_out', 'sale', 'return',
    'purchase', 'initial_stock', 'inventory_change'
  ) THEN
    v_type := 'inventory_change';
  END IF;

  v_reference_id := NULLIF(pg_catalog.btrim(
    pg_catalog.current_setting('atlas.inventory_reference_id', true)
  ), '');
  v_reference_type := NULLIF(pg_catalog.btrim(
    pg_catalog.current_setting('atlas.inventory_reference_type', true)
  ), '');
  v_event_id := extensions.uuid_generate_v5(
    '8e2e489b-fb4a-48af-8b2a-9e1b0ab8690a'::uuid,
    NEW.workspace_id::text || ':' || NEW.product_id::text || ':'
      || NEW.storage_id::text || ':' || GREATEST(COALESCE(NEW.version, 1), 1)::text
  );

  INSERT INTO private.inventory_movement_audit_queue (
    event_id, workspace_id, product_id, storage_id, inventory_version,
    transaction_type, quantity_delta, previous_quantity, new_quantity,
    reference_id, reference_type, notes, created_by
  )
  VALUES (
    v_event_id, NEW.workspace_id, NEW.product_id, NEW.storage_id,
    GREATEST(COALESCE(NEW.version, 1), 1), v_type, v_delta,
    v_previous_quantity, v_new_quantity,
    v_reference_id, v_reference_type,
    NULLIF(pg_catalog.btrim(pg_catalog.current_setting('atlas.inventory_notes', true)), ''),
    COALESCE(
      NULLIF(pg_catalog.btrim(pg_catalog.current_setting('atlas.inventory_created_by', true)), ''),
      auth.uid()::text
    )
  )
  ON CONFLICT (event_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.flush_inventory_movement_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_event private.inventory_movement_audit_queue%ROWTYPE;
BEGIN
  SELECT * INTO v_event
  FROM private.inventory_movement_audit_queue
  WHERE event_id = NEW.event_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Existing authoritative RPCs already insert a transaction row after their
  -- inventory write. Reuse that row instead of duplicating it. The queue row
  -- can only be created in this transaction, so matching the full position
  -- transition is sufficient and leaves historical records untouched.
  IF EXISTS (
    SELECT 1
    FROM public.inventory_transactions AS transaction_row
    WHERE transaction_row.workspace_id = v_event.workspace_id
      AND transaction_row.product_id = v_event.product_id
      AND transaction_row.storage_id = v_event.storage_id
      AND transaction_row.quantity_delta = v_event.quantity_delta
      AND transaction_row.previous_quantity = v_event.previous_quantity
      AND transaction_row.new_quantity = v_event.new_quantity
      AND transaction_row.created_at >= pg_catalog.transaction_timestamp()
  ) THEN
    DELETE FROM private.inventory_movement_audit_queue
    WHERE event_id = v_event.event_id;
    RETURN NULL;
  END IF;

  INSERT INTO public.inventory_transactions (
    id, workspace_id, product_id, storage_id, transaction_type,
    quantity_delta, previous_quantity, new_quantity,
    reference_id, reference_type, notes, created_by,
    created_at, updated_at, version, is_deleted, adjustment_reason
  )
  VALUES (
    v_event.event_id, v_event.workspace_id, v_event.product_id, v_event.storage_id,
    v_event.transaction_type, v_event.quantity_delta,
    v_event.previous_quantity, v_event.new_quantity,
    v_event.reference_id, v_event.reference_type, v_event.notes, v_event.created_by,
    v_event.created_at, v_event.created_at, 1, false, NULL
  )
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM private.inventory_movement_audit_queue
  WHERE event_id = v_event.event_id;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION private.clear_inventory_movement_audit_queue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  -- This queue is transaction-scoped by construction: a pending audit row
  -- cannot survive commit. A matching explicit ledger insert therefore owns
  -- the same movement and clears the deferred fallback immediately.
  DELETE FROM private.inventory_movement_audit_queue AS queued
  WHERE queued.workspace_id = NEW.workspace_id
    AND queued.product_id = NEW.product_id
    AND queued.storage_id = NEW.storage_id
    AND queued.quantity_delta = NEW.quantity_delta
    AND queued.previous_quantity = NEW.previous_quantity
    AND queued.new_quantity = NEW.new_quantity;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.capture_inventory_movement_audit()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.flush_inventory_movement_audit()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.clear_inventory_movement_audit_queue()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inventory_capture_movement_audit ON public.inventory;
CREATE TRIGGER inventory_capture_movement_audit
AFTER INSERT OR UPDATE OF quantity, is_deleted ON public.inventory
FOR EACH ROW
EXECUTE FUNCTION private.capture_inventory_movement_audit();

DROP TRIGGER IF EXISTS inventory_movement_audit_flush ON private.inventory_movement_audit_queue;
CREATE CONSTRAINT TRIGGER inventory_movement_audit_flush
AFTER INSERT ON private.inventory_movement_audit_queue
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.flush_inventory_movement_audit();

DROP TRIGGER IF EXISTS inventory_transaction_clear_audit_queue ON public.inventory_transactions;
CREATE TRIGGER inventory_transaction_clear_audit_queue
AFTER INSERT ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION private.clear_inventory_movement_audit_queue();

-- Add transaction rows inside the CAS RPC itself so returned data and cached
-- inventory remain consistent. Sales Order completion retains its existing
-- explicit sale rows, which are written by the enclosing atomic RPC.
DO $patch_inventory_snapshot$
DECLARE
  function_sql text;
  before_update_marker text := E'    INSERT INTO public.inventory (\n';
  after_update_marker text := E'    RETURNING * INTO v_inventory;\n\n    v_rows :=';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'private.apply_inventory_snapshot_changes_once(uuid, uuid, text, jsonb)'::regprocedure
  ) INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');

  IF pg_catalog.strpos(function_sql, 'v_transaction_rows jsonb') > 0 THEN
    RETURN;
  END IF;

  IF pg_catalog.strpos(function_sql, 'v_rows jsonb := ''[]''::jsonb;') = 0
    OR pg_catalog.strpos(function_sql, before_update_marker) = 0
    OR pg_catalog.strpos(function_sql, after_update_marker) = 0
  THEN
    RAISE EXCEPTION 'Inventory snapshot implementation did not match the expected version';
  END IF;

  function_sql := pg_catalog.replace(
    function_sql,
    'v_rows jsonb := ''[]''::jsonb;',
    E'v_rows jsonb := ''[]''::jsonb;\n'
      || E'  v_transaction_rows jsonb := ''[]''::jsonb;\n'
      || E'  v_audit_transaction public.inventory_transactions%ROWTYPE;\n'
      || E'  v_audit_type text;\n'
      || E'  v_audit_reference_id text;\n'
      || E'  v_audit_reference_type text;\n'
      || E'  v_audit_notes text;\n'
      || E'  v_audit_created_by text;\n'
      || E'  v_audit_previous_quantity numeric;\n'
      || E'  v_audit_new_quantity numeric;'
  );

  function_sql := pg_catalog.replace(
    function_sql,
    before_update_marker,
    E'    v_audit_type := COALESCE(\n'
      || E'      NULLIF(pg_catalog.btrim(v_change->>''audit_transaction_type''), ''''),\n'
      || E'      CASE WHEN v_current_version = 0 THEN ''initial_stock'' ELSE ''inventory_change'' END\n'
      || E'    );\n'
      || E'    v_audit_reference_id := COALESCE(\n'
      || E'      NULLIF(pg_catalog.btrim(v_change->>''audit_reference_id''), ''''),\n'
      || E'      p_operation_id::text\n'
      || E'    );\n'
      || E'    v_audit_reference_type := COALESCE(\n'
      || E'      NULLIF(pg_catalog.btrim(v_change->>''audit_reference_type''), ''''),\n'
      || E'      p_operation_kind\n'
      || E'    );\n'
      || E'    v_audit_notes := NULLIF(pg_catalog.btrim(v_change->>''audit_notes''), '''');\n'
      || E'    v_audit_created_by := COALESCE(\n'
      || E'      NULLIF(pg_catalog.btrim(v_change->>''audit_created_by''), ''''),\n'
      || E'      auth.uid()::text\n'
      || E'    );\n'
      || E'    v_audit_previous_quantity := GREATEST(v_current_quantity, 0);\n'
      || E'    v_audit_new_quantity := GREATEST(v_next_quantity, 0);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'', v_audit_type, true);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', v_audit_reference_id, true);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'', v_audit_reference_type, true);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_notes'', COALESCE(v_audit_notes, ''''), true);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_created_by'', COALESCE(v_audit_created_by, ''''), true);\n\n'
      || before_update_marker
  );

  function_sql := pg_catalog.replace(
    function_sql,
    after_update_marker,
    E'    RETURNING * INTO v_inventory;\n\n'
      || E'    IF p_operation_kind <> ''sales_order_completion''\n'
      || E'      AND pg_catalog.abs(v_audit_new_quantity - v_audit_previous_quantity) > 0.0000005 THEN\n'
      || E'      INSERT INTO public.inventory_transactions (\n'
      || E'        id, workspace_id, product_id, storage_id, transaction_type,\n'
      || E'        quantity_delta, previous_quantity, new_quantity, reference_id,\n'
      || E'        reference_type, notes, created_by, created_at, updated_at,\n'
      || E'        version, is_deleted, adjustment_reason\n'
      || E'      ) VALUES (\n'
      || E'        extensions.uuid_generate_v5(\n'
      || E'          ''8e2e489b-fb4a-48af-8b2a-9e1b0ab8690a''::uuid,\n'
      || E'          p_workspace_id::text || '':'' || v_product_id::text || '':''\n'
      || E'            || v_storage_id::text || '':'' || GREATEST(COALESCE(v_inventory.version, 1), 1)::text\n'
      || E'        ),\n'
      || E'        p_workspace_id, v_product_id, v_storage_id, v_audit_type,\n'
      || E'        pg_catalog.round(v_audit_new_quantity - v_audit_previous_quantity, 6),\n'
      || E'        v_audit_previous_quantity, v_audit_new_quantity, v_audit_reference_id,\n'
      || E'        v_audit_reference_type, v_audit_notes, v_audit_created_by,\n'
      || E'        pg_catalog.now(), pg_catalog.now(), 1, false, NULL\n'
      || E'      ) RETURNING * INTO v_audit_transaction;\n'
      || E'      v_transaction_rows := v_transaction_rows\n'
      || E'        || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_audit_transaction));\n'
      || E'    END IF;\n\n'
      || E'    v_rows :='
  );

  function_sql := pg_catalog.replace(
    function_sql,
    '  RETURN v_result;',
    E'  v_result := v_result || pg_catalog.jsonb_build_object(\n'
      || E'    ''inventory_transactions'', v_transaction_rows\n'
      || E'  );\n\n  RETURN v_result;'
  );

  EXECUTE function_sql;
END;
$patch_inventory_snapshot$;

-- Source annotations for direct SQL inventory writers. The trigger remains
-- the safety net for any current or future writer that omits a context.
DO $patch_inventory_sources$
DECLARE
  function_sql text;
  marker text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'private.convert_single_unit_product_to_relationship(jsonb)'::regprocedure
  ) INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  marker := E'  UPDATE public.inventory\n  SET\n    quantity = 0,';
  IF pg_catalog.strpos(function_sql, marker) = 0 THEN
    RAISE EXCEPTION 'single-unit product conversion did not match its inventory reset';
  END IF;
  function_sql := pg_catalog.replace(
    function_sql,
    marker,
    E'  PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'', ''inventory_change'', true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', v_product_id::text, true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'', ''product_unit_conversion'', true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_created_by'', COALESCE(v_actor_id::text, ''''), true);\n'
      || marker
  );
  EXECUTE function_sql;

  SELECT pg_catalog.pg_get_functiondef(
    'public.convert_product_inventory_to_child_unit(uuid, numeric, text)'::regprocedure
  ) INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  marker := E'  UPDATE public.inventory\n  SET quantity = round(quantity * p_factor, 6),';
  IF pg_catalog.strpos(function_sql, marker) = 0 THEN
    RAISE EXCEPTION 'product unit normalization did not match its inventory update';
  END IF;
  function_sql := pg_catalog.replace(
    function_sql,
    marker,
    E'  PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'', ''inventory_change'', true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', p_product_id::text, true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'', ''product_unit_conversion'', true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_created_by'', COALESCE(auth.uid()::text, ''''), true);\n'
      || marker
  );
  EXECUTE function_sql;

  SELECT pg_catalog.pg_get_functiondef('public.complete_sale(jsonb)'::regprocedure)
  INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  marker := E'  BEGIN\n    RETURN private.complete_sale_once(payload);';
  IF pg_catalog.strpos(function_sql, marker) = 0 THEN
    RAISE EXCEPTION 'complete_sale did not match the expected wrapper';
  END IF;
  function_sql := pg_catalog.replace(
    function_sql,
    marker,
    E'  BEGIN\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'', ''sale'', true);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', COALESCE(v_sale_id::text, payload->>''id''), true);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'', ''pos_sale'', true);\n'
      || E'    PERFORM pg_catalog.set_config(''atlas.inventory_created_by'', COALESCE(auth.uid()::text, ''''), true);\n'
      || E'    RETURN private.complete_sale_once(payload);'
  );
  EXECUTE function_sql;

  SELECT pg_catalog.pg_get_functiondef(
    'public.process_sale_return(uuid, uuid, jsonb, text, text)'::regprocedure
  ) INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  marker := E'BEGIN\n  IF p_return_id IS NULL THEN';
  IF pg_catalog.strpos(function_sql, marker) = 0 THEN
    RAISE EXCEPTION 'process_sale_return did not match the expected body';
  END IF;
  function_sql := pg_catalog.replace(
    function_sql,
    marker,
    E'BEGIN\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'', ''return'', true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', p_return_id::text, true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'',\n'
      || E'    CASE WHEN pg_catalog.current_setting(''atlas.product_exchange'', true) = ''true''\n'
      || E'      THEN ''sale_product_exchange_return'' ELSE ''pos_return'' END, true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_notes'',\n'
      || E'    COALESCE(NULLIF(pg_catalog.current_setting(''atlas.inventory_notes'', true), ''''), p_return_reason, ''''), true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_created_by'', COALESCE(auth.uid()::text, ''''), true);\n'
      || E'  IF p_return_id IS NULL THEN'
  );
  EXECUTE function_sql;

  SELECT pg_catalog.pg_get_functiondef(
    'public.process_sale_product_exchange(uuid, uuid, uuid, uuid, numeric, uuid, uuid, numeric, numeric, text, text, text)'::regprocedure
  ) INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  marker := E'  UPDATE public.sale_returns\n  SET source = ''exchange'', refund_method = NULL, updated_at = timezone(''utc'', now())\n  WHERE id = p_return_id;\n\n  UPDATE public.inventory';
  IF pg_catalog.strpos(function_sql, marker) = 0 THEN
    RAISE EXCEPTION 'sale product exchange did not match the expected inventory update';
  END IF;
  function_sql := pg_catalog.replace(
    function_sql,
    marker,
    E'  UPDATE public.sale_returns\n  SET source = ''exchange'', refund_method = NULL, updated_at = timezone(''utc'', now())\n  WHERE id = p_return_id;\n\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'', ''sale'', true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', p_exchange_id::text, true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'', ''sale_product_exchange'', true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_notes'', COALESCE(v_reason, ''''), true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_created_by'', COALESCE(auth.uid()::text, ''''), true);\n\n'
      || E'  UPDATE public.inventory'
  );
  EXECUTE function_sql;

  SELECT pg_catalog.pg_get_functiondef('public.complete_quick_sales_order(jsonb)'::regprocedure)
  INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');
  -- Anchor to the top-level function block instead of an authorization check;
  -- deployed versions add validation before the order-id check.
  marker := E'\nBEGIN\n';
  IF pg_catalog.strpos(function_sql, marker) = 0 THEN
    RAISE EXCEPTION 'complete_quick_sales_order did not match the expected function body';
  END IF;
  function_sql := pg_catalog.replace(
    function_sql,
    marker,
    E'\nBEGIN\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_transaction_type'', ''sale'', true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_reference_id'', COALESCE(v_order_id::text, v_order_payload->>''id''), true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_reference_type'', ''sales_order'', true);\n'
      || E'  PERFORM pg_catalog.set_config(''atlas.inventory_created_by'', COALESCE(auth.uid()::text, ''''), true);\n'
  );
  EXECUTE function_sql;
END;
$patch_inventory_sources$;

NOTIFY pgrst, 'reload schema';
