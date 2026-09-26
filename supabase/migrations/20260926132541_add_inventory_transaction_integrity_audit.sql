-- Check each newly submitted inventory transaction against the authoritative
-- inventory movement captured in the same server transaction. Mismatches are
-- retained privately for administrator review; this is forward-only and does
-- not inspect or rewrite historical rows.

CREATE TABLE IF NOT EXISTS private.inventory_transaction_integrity_mismatches (
  mismatch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  inventory_event_id uuid,
  inventory_transaction_id uuid,
  product_id uuid NOT NULL,
  storage_id uuid NOT NULL,
  mismatch_kind text NOT NULL CHECK (
    mismatch_kind IN (
      'movement_snapshot_mismatch',
      'transaction_without_inventory_change'
    )
  ),
  expected_snapshot jsonb,
  actual_snapshot jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  review_status text NOT NULL DEFAULT 'open' CHECK (
    review_status IN ('open', 'reviewed', 'dismissed')
  ),
  reviewed_at timestamptz,
  reviewed_by text,
  review_notes text
);

CREATE INDEX IF NOT EXISTS inventory_transaction_integrity_mismatches_open_idx
  ON private.inventory_transaction_integrity_mismatches (detected_at DESC)
  WHERE review_status = 'open';

CREATE INDEX IF NOT EXISTS inventory_transaction_integrity_mismatches_workspace_idx
  ON private.inventory_transaction_integrity_mismatches (
    workspace_id, detected_at DESC
  );

COMMENT ON TABLE private.inventory_transaction_integrity_mismatches IS
  'Forward-only audit of newly submitted inventory transaction rows that do not match an inventory movement in the same server transaction.';

ALTER TABLE private.inventory_transaction_integrity_mismatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.inventory_transaction_integrity_mismatches
  FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.inventory_transaction_integrity_queue (
  transaction_id uuid PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  is_matched boolean NOT NULL DEFAULT false
);

ALTER TABLE private.inventory_transaction_integrity_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.inventory_transaction_integrity_queue
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.capture_inventory_transaction_integrity_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  -- The movement-audit fallback inserts canonical rows when a direct
  -- inventory writer did not submit a transaction row of its own. Those rows
  -- are generated from the authoritative stock transition and are not client
  -- submissions that need a second check.
  IF pg_catalog.current_setting(
    'atlas.inventory_integrity_generated', true
  ) = 'true' THEN
    RETURN NEW;
  END IF;

  INSERT INTO private.inventory_transaction_integrity_queue (transaction_id)
  VALUES (NEW.id)
  ON CONFLICT (transaction_id) DO NOTHING;

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
  v_submission_id uuid;
  v_transaction public.inventory_transactions%ROWTYPE;
  v_previous_generated_setting text;
  v_expected jsonb;
BEGIN
  -- Both queue types are transaction-local and are removed here. The first
  -- deferred trigger invocation sees the complete submission, regardless of
  -- whether the inventory or transaction row was written first.
  IF NOT EXISTS (SELECT 1 FROM private.inventory_movement_audit_queue)
    AND NOT EXISTS (
      SELECT 1 FROM private.inventory_transaction_integrity_queue
    )
  THEN
    RETURN NULL;
  END IF;

  -- First pair exact quantity transitions. Doing exact matches before
  -- classifying same-position candidates prevents a valid transaction for a
  -- later transition from being mistaken for a malformed earlier one.
  FOR v_event IN
    SELECT *
    FROM private.inventory_movement_audit_queue
    ORDER BY created_at, event_id
  LOOP
    SELECT submission.transaction_id
      INTO v_submission_id
    FROM private.inventory_transaction_integrity_queue AS submission
    JOIN public.inventory_transactions AS transaction_row
      ON transaction_row.id = submission.transaction_id
    WHERE NOT submission.is_matched
      AND transaction_row.workspace_id = v_event.workspace_id
      AND transaction_row.product_id = v_event.product_id
      AND transaction_row.storage_id = v_event.storage_id
      AND transaction_row.quantity_delta = v_event.quantity_delta
      AND transaction_row.previous_quantity = v_event.previous_quantity
      AND transaction_row.new_quantity = v_event.new_quantity
      AND COALESCE(transaction_row.is_deleted, false) = false
    ORDER BY submission.queued_at, submission.transaction_id
    LIMIT 1;

    IF FOUND THEN
      UPDATE private.inventory_transaction_integrity_queue
      SET is_matched = true
      WHERE transaction_id = v_submission_id;
    END IF;
  END LOOP;

  -- Any remaining submitted transaction for the same inventory position is
  -- a parity mismatch. Keep the submitted row intact and record both versions
  -- for review; do not append a second quantity row that could double-count it.
  FOR v_event IN
    SELECT event_row.*
    FROM private.inventory_movement_audit_queue AS event_row
    WHERE EXISTS (
      SELECT 1
      FROM private.inventory_transaction_integrity_queue AS submission
      JOIN public.inventory_transactions AS transaction_row
        ON transaction_row.id = submission.transaction_id
      WHERE NOT submission.is_matched
        AND transaction_row.workspace_id = event_row.workspace_id
        AND transaction_row.product_id = event_row.product_id
        AND transaction_row.storage_id = event_row.storage_id
    )
    ORDER BY event_row.created_at, event_row.event_id
  LOOP
    SELECT submission.transaction_id
      INTO v_submission_id
    FROM private.inventory_transaction_integrity_queue AS submission
    JOIN public.inventory_transactions AS transaction_row
      ON transaction_row.id = submission.transaction_id
    WHERE NOT submission.is_matched
      AND transaction_row.workspace_id = v_event.workspace_id
      AND transaction_row.product_id = v_event.product_id
      AND transaction_row.storage_id = v_event.storage_id
    ORDER BY submission.queued_at, submission.transaction_id
    LIMIT 1;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_transaction
    FROM public.inventory_transactions
    WHERE id = v_submission_id;

    v_expected := pg_catalog.jsonb_build_object(
      'event_id', v_event.event_id,
      'workspace_id', v_event.workspace_id,
      'product_id', v_event.product_id,
      'storage_id', v_event.storage_id,
      'transaction_type', v_event.transaction_type,
      'quantity_delta', v_event.quantity_delta,
      'previous_quantity', v_event.previous_quantity,
      'new_quantity', v_event.new_quantity,
      'reference_id', v_event.reference_id,
      'reference_type', v_event.reference_type
    );

    INSERT INTO private.inventory_transaction_integrity_mismatches (
      workspace_id,
      inventory_event_id,
      inventory_transaction_id,
      product_id,
      storage_id,
      mismatch_kind,
      expected_snapshot,
      actual_snapshot
    )
    VALUES (
      v_event.workspace_id,
      v_event.event_id,
      v_transaction.id,
      v_event.product_id,
      v_event.storage_id,
      'movement_snapshot_mismatch',
      v_expected,
      pg_catalog.to_jsonb(v_transaction)
    );

    UPDATE private.inventory_transaction_integrity_queue
    SET is_matched = true
    WHERE transaction_id = v_submission_id;
  END LOOP;

  -- Inventory changed without a transaction submission: retain the existing
  -- canonical fallback so the movement is still recorded. This is not a
  -- mismatch in a submitted transaction because no transaction was submitted.
  FOR v_event IN
    SELECT event_row.*
    FROM private.inventory_movement_audit_queue AS event_row
    WHERE NOT EXISTS (
      SELECT 1
      FROM private.inventory_transaction_integrity_queue AS submission
      JOIN public.inventory_transactions AS transaction_row
        ON transaction_row.id = submission.transaction_id
      WHERE transaction_row.workspace_id = event_row.workspace_id
        AND transaction_row.product_id = event_row.product_id
        AND transaction_row.storage_id = event_row.storage_id
        AND transaction_row.quantity_delta = event_row.quantity_delta
        AND transaction_row.previous_quantity = event_row.previous_quantity
        AND transaction_row.new_quantity = event_row.new_quantity
        AND COALESCE(transaction_row.is_deleted, false) = false
    )
    AND NOT EXISTS (
      SELECT 1
      FROM private.inventory_transaction_integrity_mismatches AS mismatch
      WHERE mismatch.inventory_event_id = event_row.event_id
    )
    ORDER BY event_row.created_at, event_row.event_id
  LOOP
    -- A same-position submitted mismatch was already logged above; leave it
    -- for administrator review rather than generating a duplicate movement.
    IF EXISTS (
      SELECT 1
      FROM private.inventory_transaction_integrity_queue AS submission
      JOIN public.inventory_transactions AS transaction_row
        ON transaction_row.id = submission.transaction_id
      WHERE NOT submission.is_matched
        AND transaction_row.workspace_id = v_event.workspace_id
        AND transaction_row.product_id = v_event.product_id
        AND transaction_row.storage_id = v_event.storage_id
    ) THEN
      CONTINUE;
    END IF;

    v_previous_generated_setting := pg_catalog.current_setting(
      'atlas.inventory_integrity_generated', true
    );
    PERFORM pg_catalog.set_config(
      'atlas.inventory_integrity_generated', 'true', true
    );

    INSERT INTO public.inventory_transactions (
      id, workspace_id, product_id, storage_id, transaction_type,
      quantity_delta, previous_quantity, new_quantity,
      reference_id, reference_type, notes, created_by,
      created_at, updated_at, version, is_deleted, adjustment_reason
    )
    VALUES (
      v_event.event_id, v_event.workspace_id, v_event.product_id,
      v_event.storage_id, v_event.transaction_type,
      v_event.quantity_delta, v_event.previous_quantity, v_event.new_quantity,
      v_event.reference_id, v_event.reference_type, v_event.notes,
      v_event.created_by, v_event.created_at, v_event.created_at,
      1, false, NULL
    )
    ON CONFLICT (id) DO NOTHING;

    PERFORM pg_catalog.set_config(
      'atlas.inventory_integrity_generated',
      COALESCE(v_previous_generated_setting, ''),
      true
    );
  END LOOP;

  -- A newly submitted ledger row without any inventory movement is also a
  -- parity mismatch, including a submitted soft-delete of a transaction row.
  FOR v_submission_id IN
    SELECT transaction_id
    FROM private.inventory_transaction_integrity_queue
    WHERE NOT is_matched
    ORDER BY queued_at, transaction_id
  LOOP
    SELECT * INTO v_transaction
    FROM public.inventory_transactions
    WHERE id = v_submission_id;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    INSERT INTO private.inventory_transaction_integrity_mismatches (
      workspace_id,
      inventory_transaction_id,
      product_id,
      storage_id,
      mismatch_kind,
      expected_snapshot,
      actual_snapshot
    )
    VALUES (
      v_transaction.workspace_id,
      v_transaction.id,
      v_transaction.product_id,
      v_transaction.storage_id,
      'transaction_without_inventory_change',
      NULL,
      pg_catalog.to_jsonb(v_transaction)
    );
  END LOOP;

  DELETE FROM private.inventory_transaction_integrity_queue;
  DELETE FROM private.inventory_movement_audit_queue;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION private.capture_inventory_transaction_integrity_submission()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.flush_inventory_movement_audit()
  FROM PUBLIC, anon, authenticated;

-- A ledger update that changes its movement fields is a new submission for
-- integrity purposes. Metadata-only sync updates do not enqueue a check.
DROP TRIGGER IF EXISTS inventory_transaction_clear_audit_queue
  ON public.inventory_transactions;
DROP TRIGGER IF EXISTS inventory_transaction_integrity_capture_insert
  ON public.inventory_transactions;
CREATE TRIGGER inventory_transaction_integrity_capture_insert
AFTER INSERT ON public.inventory_transactions
FOR EACH ROW
EXECUTE FUNCTION private.capture_inventory_transaction_integrity_submission();

DROP TRIGGER IF EXISTS inventory_transaction_integrity_capture_update
  ON public.inventory_transactions;
CREATE TRIGGER inventory_transaction_integrity_capture_update
AFTER UPDATE OF
  workspace_id, product_id, storage_id, transaction_type,
  quantity_delta, previous_quantity, new_quantity, is_deleted
ON public.inventory_transactions
FOR EACH ROW
WHEN (
  OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
  OR OLD.product_id IS DISTINCT FROM NEW.product_id
  OR OLD.storage_id IS DISTINCT FROM NEW.storage_id
  OR OLD.transaction_type IS DISTINCT FROM NEW.transaction_type
  OR OLD.quantity_delta IS DISTINCT FROM NEW.quantity_delta
  OR OLD.previous_quantity IS DISTINCT FROM NEW.previous_quantity
  OR OLD.new_quantity IS DISTINCT FROM NEW.new_quantity
  OR OLD.is_deleted IS DISTINCT FROM NEW.is_deleted
)
EXECUTE FUNCTION private.capture_inventory_transaction_integrity_submission();

DROP TRIGGER IF EXISTS inventory_transaction_integrity_check
  ON private.inventory_transaction_integrity_queue;
CREATE CONSTRAINT TRIGGER inventory_transaction_integrity_check
AFTER INSERT ON private.inventory_transaction_integrity_queue
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION private.flush_inventory_movement_audit();

-- The Admin backend uses its service-role connection for this restricted RPC;
-- private tables remain unavailable to workspace clients and the Data API.
CREATE OR REPLACE FUNCTION public.admin_list_inventory_transaction_integrity_mismatches(
  p_workspace_id uuid DEFAULT NULL,
  p_review_status text DEFAULT 'open',
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  mismatch_id uuid,
  workspace_id uuid,
  inventory_event_id uuid,
  inventory_transaction_id uuid,
  product_id uuid,
  storage_id uuid,
  mismatch_kind text,
  expected_snapshot jsonb,
  actual_snapshot jsonb,
  detected_at timestamptz,
  review_status text,
  reviewed_at timestamptz,
  reviewed_by text,
  review_notes text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT
    mismatch.mismatch_id,
    mismatch.workspace_id,
    mismatch.inventory_event_id,
    mismatch.inventory_transaction_id,
    mismatch.product_id,
    mismatch.storage_id,
    mismatch.mismatch_kind,
    mismatch.expected_snapshot,
    mismatch.actual_snapshot,
    mismatch.detected_at,
    mismatch.review_status,
    mismatch.reviewed_at,
    mismatch.reviewed_by,
    mismatch.review_notes
  FROM private.inventory_transaction_integrity_mismatches AS mismatch
  WHERE (p_workspace_id IS NULL OR mismatch.workspace_id = p_workspace_id)
    AND (p_review_status IS NULL OR mismatch.review_status = p_review_status)
  ORDER BY mismatch.detected_at DESC, mismatch.mismatch_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$function$;

REVOKE ALL ON FUNCTION public.admin_list_inventory_transaction_integrity_mismatches(
  uuid, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_inventory_transaction_integrity_mismatches(
  uuid, text, integer
) TO service_role;

COMMENT ON FUNCTION public.admin_list_inventory_transaction_integrity_mismatches(
  uuid, text, integer
) IS 'Service-role-only Admin backend reader for private inventory transaction parity mismatches.';

NOTIFY pgrst, 'reload schema';
