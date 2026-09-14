-- A commission lane is meaningful only when an order has at least one valid
-- manual/plan commission or qualifying product commission. Keep orders with
-- neither out of both the payable and tracked reporting lanes.

ALTER TABLE crm.sales_orders
  ALTER COLUMN commission_mode DROP NOT NULL,
  ALTER COLUMN commission_mode DROP DEFAULT,
  ALTER COLUMN commission_mode_captured_at DROP NOT NULL,
  ALTER COLUMN commission_mode_captured_at DROP DEFAULT;

-- Earlier releases permitted a few incomplete snapshots with an enabled flag
-- but no mode. Preserve those historical commissions in the legacy payable
-- lane, while disabled orders are intentionally cleared. The prior snapshot
-- trigger treated every update as immutable, so suspend it only while this
-- one-time repair brings rows into the new invariant.
ALTER TABLE crm.sales_orders
  DISABLE TRIGGER snapshot_sales_order_commission_mode;

UPDATE crm.sales_orders
SET
  commission_mode = CASE
    WHEN commission_enabled = false THEN NULL
    WHEN commission_mode IS NULL THEN 'payable'
    ELSE commission_mode
  END,
  commission_mode_captured_at = CASE
    WHEN commission_enabled = false THEN NULL
    ELSE COALESCE(commission_mode_captured_at, created_at, now())
  END
WHERE commission_enabled = false
  OR commission_mode IS NULL
  OR commission_mode_captured_at IS NULL;

ALTER TABLE crm.sales_orders
  ENABLE TRIGGER snapshot_sales_order_commission_mode;

ALTER TABLE crm.sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_commission_mode_check,
  ADD CONSTRAINT sales_orders_commission_mode_check
    CHECK (
      (commission_enabled = false AND commission_mode IS NULL AND commission_mode_captured_at IS NULL)
      OR (commission_enabled = true AND commission_mode IN ('payable', 'tracked') AND commission_mode_captured_at IS NOT NULL)
    );

DROP INDEX IF EXISTS crm.sales_orders_workspace_commission_mode_idx;
CREATE INDEX sales_orders_workspace_commission_mode_idx
  ON crm.sales_orders (workspace_id, commission_mode, created_at DESC)
  WHERE COALESCE(is_deleted, false) = false
    AND commission_mode IS NOT NULL;

-- Only an enabled order receives a workspace commission-mode snapshot. A
-- disabled order always has no lane. Re-enabling after all commission was
-- removed snapshots the workspace's current mode; otherwise an existing
-- commissionable order keeps its original immutable lane.
CREATE OR REPLACE FUNCTION private.snapshot_sales_order_commission_mode()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_workspace_mode text;
  v_workspace_mode_changed_at timestamptz;
  v_captured_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.commission_enabled = false THEN
    NEW.commission_mode := NULL;
    NEW.commission_mode_captured_at := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.commission_enabled = true
    AND OLD.commission_mode IN ('payable', 'tracked')
  THEN
    NEW.commission_mode := OLD.commission_mode;
    NEW.commission_mode_captured_at := COALESCE(OLD.commission_mode_captured_at, now());
    RETURN NEW;
  END IF;

  SELECT
    workspace.sales_agent_commission_mode,
    workspace.sales_agent_commission_mode_changed_at
  INTO v_workspace_mode, v_workspace_mode_changed_at
  FROM public.workspaces AS workspace
  WHERE workspace.id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales order workspace was not found'
      USING ERRCODE = '23503';
  END IF;

  -- A new disabled order is deliberately outside every commission lane.
  IF NEW.commission_enabled = false THEN
    NEW.commission_mode := NULL;
    NEW.commission_mode_captured_at := NULL;
    RETURN NEW;
  END IF;

  v_captured_at := COALESCE(NEW.commission_mode_captured_at, NEW.created_at, now());
  IF TG_OP = 'INSERT'
    AND NEW.commission_mode IN ('payable', 'tracked')
    AND NEW.commission_mode_captured_at IS NOT NULL
    AND NEW.commission_mode_captured_at < v_workspace_mode_changed_at
  THEN
    -- Preserve an offline snapshot captured before the last settings change.
    NEW.commission_mode := NEW.commission_mode;
  ELSE
    NEW.commission_mode := v_workspace_mode;
    v_captured_at := now();
  END IF;
  NEW.commission_mode_captured_at := v_captured_at;

  RETURN NEW;
END;
$function$;

-- A disabled order cannot receive fresh commission ledger entries. Existing
-- entries remain immutable audit history and are reversed by reconciliation.
CREATE OR REPLACE FUNCTION private.enforce_agent_commission_entry_mode()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order_mode text;
BEGIN
  IF NEW.order_id IS NULL THEN
    NEW.commission_mode := 'payable';
    RETURN NEW;
  END IF;

  SELECT sales_order.commission_mode
  INTO v_order_mode
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.id = NEW.order_id
    AND sales_order.workspace_id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission entry order must belong to the same workspace'
      USING ERRCODE = '23514';
  END IF;
  IF v_order_mode IS NULL THEN
    RAISE EXCEPTION 'Commission entries require an enabled sales order'
      USING ERRCODE = '23514';
  END IF;

  NEW.commission_mode := v_order_mode;
  IF v_order_mode = 'tracked' AND NEW.kind IN ('approval', 'payout', 'recovery') THEN
    RAISE EXCEPTION 'Tracked commission is nonpayable and cannot be settled'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION private.enforce_agent_product_commission_entry_mode()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_order_mode text;
BEGIN
  SELECT sales_order.commission_mode
  INTO v_order_mode
  FROM crm.sales_orders AS sales_order
  WHERE sales_order.id = NEW.order_id
    AND sales_order.workspace_id = NEW.workspace_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product commission entry order must belong to the same workspace'
      USING ERRCODE = '23514';
  END IF;
  IF v_order_mode IS NULL THEN
    RAISE EXCEPTION 'Product commission entries require an enabled sales order'
      USING ERRCODE = '23514';
  END IF;

  NEW.commission_mode := v_order_mode;
  RETURN NEW;
END;
$function$;

-- Reconciliation must produce zero targets for a disabled order, allowing any
-- earlier accrual to be countered by the normal immutable reversal flow.
DO $block$
DECLARE
  v_definition text;
  v_replaced text;
  v_function regprocedure;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'private.calculate_sales_agent_commission_order_target(uuid,uuid,uuid,text,boolean,boolean,numeric)'::regprocedure,
    'private.calculate_manual_sales_agent_commission_order_target(uuid,uuid,uuid)'::regprocedure
  ] LOOP
    SELECT pg_get_functiondef(v_function) INTO v_definition;
    v_definition := replace(v_definition, chr(13), '');
    IF position('COALESCE(sales_order.commission_enabled, true)' IN v_definition) = 0 THEN
      v_replaced := replace(
        v_definition,
        'COALESCE(sales_order.is_deleted, false) = false AND sales_order.status <> ''cancelled''',
        'COALESCE(sales_order.is_deleted, false) = false AND sales_order.status <> ''cancelled'' AND COALESCE(sales_order.commission_enabled, true)'
      );
      IF v_replaced = v_definition THEN
        RAISE EXCEPTION 'Could not scope commission eligibility to enabled sales orders for %', v_function;
      END IF;
      EXECUTE v_replaced;
    END IF;
  END LOOP;

  SELECT pg_get_functiondef('private.reconcile_product_sales_agent_commission(uuid, uuid)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');
  IF position('COALESCE(v_order.commission_enabled, true)' IN v_definition) = 0 THEN
    v_replaced := regexp_replace(
      v_definition,
      'v_eligible[[:space:]]*:=[^;]+;',
      'v_eligible := COALESCE(v_order.commission_enabled, true) AND COALESCE(v_order.is_deleted, false) = false AND v_order.status <> ''cancelled'' AND COALESCE(v_order.return_status, ''none'') <> ''full'';'
    );
    IF v_replaced = v_definition THEN
      RAISE EXCEPTION 'Could not scope product commission reconciliation to enabled sales orders';
    END IF;
    EXECUTE v_replaced;
  END IF;
END;
$block$;

-- A creator-derived product assignment is only appropriate when product
-- commission qualified the order before it was saved as commissionable.
DO $block$
DECLARE
  v_definition text;
  v_replaced text;
BEGIN
  SELECT pg_get_functiondef('private.ensure_order_creator_product_commission_assignment(uuid)'::regprocedure)
  INTO v_definition;
  v_definition := replace(v_definition, chr(13), '');
  IF position('COALESCE(v_order.commission_enabled, true) = false' IN v_definition) = 0 THEN
    v_replaced := replace(
      v_definition,
      E'    OR COALESCE(v_order.is_deleted, false)\n  THEN',
      E'    OR COALESCE(v_order.is_deleted, false)\n    OR COALESCE(v_order.commission_enabled, true) = false\n  THEN'
    );
    IF v_replaced = v_definition THEN
      RAISE EXCEPTION 'Could not prevent product attribution for disabled sales orders';
    END IF;
    EXECUTE v_replaced;
  END IF;
END;
$block$;

REVOKE ALL ON FUNCTION private.snapshot_sales_order_commission_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_agent_commission_entry_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_agent_product_commission_entry_mode() FROM PUBLIC;

COMMENT ON COLUMN crm.sales_orders.commission_mode IS
  'Workspace-mode snapshot only for commissionable orders; null when no manual, plan, or qualifying product commission exists.';

NOTIFY pgrst, 'reload schema';
