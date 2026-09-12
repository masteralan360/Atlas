-- Tracked commissions preserve the complete sales-agent calculation trail
-- without creating a payable, payment, ledger, or partner-balance obligation.
-- Existing workspaces, orders, and commission entries remain payable.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS sales_agent_commission_mode text NOT NULL DEFAULT 'payable',
  ADD COLUMN IF NOT EXISTS sales_agent_commission_mode_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS sales_agent_commission_mode_changed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_sales_agent_commission_mode_check,
  ADD CONSTRAINT workspaces_sales_agent_commission_mode_check
    CHECK (sales_agent_commission_mode IN ('payable', 'tracked'));

ALTER TABLE crm.sales_orders
  ADD COLUMN IF NOT EXISTS commission_mode text NOT NULL DEFAULT 'payable',
  -- Adding the non-null default initializes legacy rows as part of the schema
  -- change. Do not issue an UPDATE here: that would invoke unrelated order
  -- validation triggers for every historical sales order.
  ADD COLUMN IF NOT EXISTS commission_mode_captured_at timestamptz NOT NULL DEFAULT now();

-- Some SQL runners may have committed the earlier nullable ADD COLUMN before
-- the old backfill failed. Repair that partial state through DDL, which does
-- not fire sales-order row triggers, before enforcing NOT NULL below.
DO $repair_partial_commission_mode_snapshot$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM crm.sales_orders
    WHERE commission_mode_captured_at IS NULL
  ) THEN
    ALTER TABLE crm.sales_orders
      ALTER COLUMN commission_mode_captured_at TYPE timestamptz
      USING COALESCE(commission_mode_captured_at, created_at, now());
  END IF;
END;
$repair_partial_commission_mode_snapshot$;

ALTER TABLE crm.sales_orders
  ALTER COLUMN commission_mode_captured_at SET DEFAULT now(),
  ALTER COLUMN commission_mode_captured_at SET NOT NULL,
  DROP CONSTRAINT IF EXISTS sales_orders_commission_mode_check,
  ADD CONSTRAINT sales_orders_commission_mode_check
    CHECK (commission_mode IN ('payable', 'tracked'));

ALTER TABLE crm.agent_commission_entries
  ADD COLUMN IF NOT EXISTS commission_mode text NOT NULL DEFAULT 'payable';

ALTER TABLE crm.agent_commission_entries
  DROP CONSTRAINT IF EXISTS agent_commission_entries_commission_mode_check,
  ADD CONSTRAINT agent_commission_entries_commission_mode_check
    CHECK (commission_mode IN ('payable', 'tracked')),
  DROP CONSTRAINT IF EXISTS agent_commission_entries_tracked_nonfinancial_check,
  ADD CONSTRAINT agent_commission_entries_tracked_nonfinancial_check
    CHECK (commission_mode = 'payable' OR kind NOT IN ('approval', 'payout', 'recovery'));

ALTER TABLE crm.agent_product_commission_entries
  ADD COLUMN IF NOT EXISTS commission_mode text NOT NULL DEFAULT 'payable';

ALTER TABLE crm.agent_product_commission_entries
  DROP CONSTRAINT IF EXISTS agent_product_commission_entries_commission_mode_check,
  ADD CONSTRAINT agent_product_commission_entries_commission_mode_check
    CHECK (commission_mode IN ('payable', 'tracked'));

CREATE INDEX IF NOT EXISTS sales_orders_workspace_commission_mode_idx
  ON crm.sales_orders (workspace_id, commission_mode, created_at DESC)
  WHERE COALESCE(is_deleted, false) = false;

CREATE INDEX IF NOT EXISTS agent_commission_entries_workspace_mode_agent_idx
  ON crm.agent_commission_entries (workspace_id, commission_mode, agent_id, occurred_at DESC)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS agent_product_commission_entries_workspace_mode_agent_idx
  ON crm.agent_product_commission_entries (workspace_id, commission_mode, agent_id, occurred_at DESC)
  WHERE is_deleted = false;

-- Only a workspace administrator may change the mode. The database owns the
-- audit fields so a client cannot forge who made the change or when it happened.
CREATE OR REPLACE FUNCTION private.enforce_sales_agent_commission_mode_setting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.sales_agent_commission_mode IS DISTINCT FROM 'payable' THEN
      IF v_actor IS NOT NULL AND public.current_user_role() IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Only workspace administrators can enable tracked commissions'
          USING ERRCODE = '42501';
      END IF;
      NEW.sales_agent_commission_mode_changed_at := now();
      NEW.sales_agent_commission_mode_changed_by := v_actor;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.sales_agent_commission_mode IS DISTINCT FROM OLD.sales_agent_commission_mode THEN
    IF v_actor IS NOT NULL AND public.current_user_role() IS DISTINCT FROM 'admin' THEN
      RAISE EXCEPTION 'Only workspace administrators can change commission tracking mode'
        USING ERRCODE = '42501';
    END IF;
    NEW.sales_agent_commission_mode_changed_at := now();
    NEW.sales_agent_commission_mode_changed_by := v_actor;
  ELSE
    NEW.sales_agent_commission_mode_changed_at := OLD.sales_agent_commission_mode_changed_at;
    NEW.sales_agent_commission_mode_changed_by := OLD.sales_agent_commission_mode_changed_by;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS enforce_sales_agent_commission_mode_setting ON public.workspaces;
CREATE TRIGGER enforce_sales_agent_commission_mode_setting
  BEFORE INSERT OR UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION private.enforce_sales_agent_commission_mode_setting();

-- A new online order uses the workspace's current mode. An order first created
-- offline retains its captured mode if the workspace setting changed while it
-- was offline. Once inserted, an order's snapshot can never be changed.
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
  IF TG_OP = 'UPDATE' THEN
    NEW.commission_mode := OLD.commission_mode;
    NEW.commission_mode_captured_at := OLD.commission_mode_captured_at;
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

  v_captured_at := COALESCE(NEW.commission_mode_captured_at, NEW.created_at, now());
  IF NEW.commission_mode IN ('payable', 'tracked')
    AND NEW.commission_mode_captured_at IS NOT NULL
    AND NEW.commission_mode_captured_at < v_workspace_mode_changed_at
  THEN
    -- Preserve a valid snapshot captured before the most recent setting change.
    NEW.commission_mode := NEW.commission_mode;
  ELSE
    NEW.commission_mode := v_workspace_mode;
    v_captured_at := now();
  END IF;
  NEW.commission_mode_captured_at := v_captured_at;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS snapshot_sales_order_commission_mode ON crm.sales_orders;
CREATE TRIGGER snapshot_sales_order_commission_mode
  BEFORE INSERT OR UPDATE ON crm.sales_orders
  FOR EACH ROW EXECUTE FUNCTION private.snapshot_sales_order_commission_mode();

-- Commission calculation functions continue to create their normal immutable
-- events. These triggers attach the order lane and reject every financial event
-- for a tracked order, including direct and stale-client writes.
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

  NEW.commission_mode := v_order_mode;
  IF v_order_mode = 'tracked' AND NEW.kind IN ('approval', 'payout', 'recovery') THEN
    RAISE EXCEPTION 'Tracked commission is nonpayable and cannot be settled'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS assign_agent_commission_entry_mode ON crm.agent_commission_entries;
CREATE TRIGGER assign_agent_commission_entry_mode
  BEFORE INSERT OR UPDATE ON crm.agent_commission_entries
  FOR EACH ROW EXECUTE FUNCTION private.enforce_agent_commission_entry_mode();

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

  NEW.commission_mode := v_order_mode;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS assign_agent_product_commission_entry_mode ON crm.agent_product_commission_entries;
CREATE TRIGGER assign_agent_product_commission_entry_mode
  BEFORE INSERT OR UPDATE ON crm.agent_product_commission_entries
  FOR EACH ROW EXECUTE FUNCTION private.enforce_agent_product_commission_entry_mode();

-- Defense in depth for RPC calls: reject a tracked order before calculating a
-- balance or attempting to insert either side of a payment transaction.
CREATE OR REPLACE FUNCTION private.reject_tracked_sales_agent_commission_settlement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.kind IN ('payout', 'recovery') AND EXISTS (
    SELECT 1
    FROM crm.sales_orders AS sales_order
    WHERE sales_order.id = NEW.order_id
      AND sales_order.workspace_id = NEW.workspace_id
      AND sales_order.commission_mode = 'tracked'
  ) THEN
    RAISE EXCEPTION 'Tracked commission is nonpayable and cannot be settled'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS block_tracked_agent_commission_settlement ON crm.agent_commission_entries;
CREATE TRIGGER block_tracked_agent_commission_settlement
  BEFORE INSERT OR UPDATE ON crm.agent_commission_entries
  FOR EACH ROW EXECUTE FUNCTION private.reject_tracked_sales_agent_commission_settlement();

-- The settlement RPC is the supported writer, but payment_transactions also
-- accepts ordinary workspace-scoped inserts. Reject a crafted or replayed
-- commission payment whenever either its commission entry or order identifies
-- the nonfinancial lane.
CREATE OR REPLACE FUNCTION private.reject_tracked_agent_commission_payment_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.source_type IN ('agent_commission_payout', 'agent_commission_recovery')
    AND (
      EXISTS (
        SELECT 1
        FROM crm.agent_commission_entries AS entry
        WHERE entry.id = NEW.source_subrecord_id
          AND entry.workspace_id = NEW.workspace_id
          AND entry.commission_mode = 'tracked'
      )
      OR EXISTS (
        SELECT 1
        FROM crm.sales_orders AS sales_order
        WHERE sales_order.id::text = COALESCE(NEW.metadata ->> 'orderId', '')
          AND sales_order.workspace_id = NEW.workspace_id
          AND sales_order.commission_mode = 'tracked'
      )
    )
  THEN
    RAISE EXCEPTION 'Tracked commission is nonpayable and cannot create a payment transaction'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS block_tracked_agent_commission_payment
  ON public.payment_transactions;
CREATE TRIGGER block_tracked_agent_commission_payment
  BEFORE INSERT OR UPDATE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION private.reject_tracked_agent_commission_payment_transaction();

-- Read-only lane views make accidental financial consumption less likely while
-- retaining the established RLS of the underlying security-invoker tables.
CREATE OR REPLACE VIEW crm.agent_tracked_commission_entries
WITH (security_invoker = true)
AS
SELECT *
FROM crm.agent_commission_entries
WHERE commission_mode = 'tracked';

CREATE OR REPLACE VIEW crm.agent_tracked_product_commission_entries
WITH (security_invoker = true)
AS
SELECT *
FROM crm.agent_product_commission_entries
WHERE commission_mode = 'tracked';

REVOKE ALL ON TABLE crm.agent_tracked_commission_entries FROM PUBLIC, anon;
REVOKE ALL ON TABLE crm.agent_tracked_product_commission_entries FROM PUBLIC, anon;
GRANT SELECT ON TABLE crm.agent_tracked_commission_entries TO authenticated, service_role;
GRANT SELECT ON TABLE crm.agent_tracked_product_commission_entries TO authenticated, service_role;

COMMENT ON COLUMN public.workspaces.sales_agent_commission_mode IS
  'Future sales orders snapshot payable or tracked commission behavior.';
COMMENT ON COLUMN crm.sales_orders.commission_mode IS
  'Immutable order snapshot. Tracked commissions are calculation-only and never financial.';
COMMENT ON COLUMN crm.agent_commission_entries.commission_mode IS
  'Inherited from the sales order. Only payable entries may create settlements.';
COMMENT ON VIEW crm.agent_tracked_commission_entries IS
  'Read-only nonfinancial sales-agent commission event lane.';

REVOKE ALL ON FUNCTION private.enforce_sales_agent_commission_mode_setting() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.snapshot_sales_order_commission_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_agent_commission_entry_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.enforce_agent_product_commission_entry_mode() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.reject_tracked_sales_agent_commission_settlement() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.reject_tracked_agent_commission_payment_transaction() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
