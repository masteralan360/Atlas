-- Prevent direct clients, including older builds, from moving a purchase
-- order into or out of a received state without the atomic receipt RPC.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE OR REPLACE FUNCTION private.guard_purchase_order_receipt_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_previous_status text;
  v_receipt_order_id text := pg_catalog.current_setting(
    'atlas.purchase_receipt_order_id',
    true
  );
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_previous_status := OLD.status;
  ELSE
    -- PostgreSQL runs BEFORE INSERT triggers for an UPSERT before resolving
    -- its conflict. Read the existing row so ordinary updates to an already
    -- received order can still use the existing generic upsert path.
    SELECT purchase_order.status
    INTO v_previous_status
    FROM crm.purchase_orders AS purchase_order
    WHERE purchase_order.id = NEW.id;
  END IF;

  IF NEW.status IS DISTINCT FROM v_previous_status
    AND (
      NEW.status IN ('received', 'completed')
      OR v_previous_status IN ('received', 'completed')
    )
    AND v_receipt_order_id IS DISTINCT FROM NEW.id::text
  THEN
    RAISE EXCEPTION 'Purchase receipt status must be changed through the atomic receipt operation'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION private.guard_purchase_order_receipt_status()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS purchase_orders_require_atomic_receipt
  ON crm.purchase_orders;
CREATE TRIGGER purchase_orders_require_atomic_receipt
BEFORE INSERT OR UPDATE OF status ON crm.purchase_orders
FOR EACH ROW
EXECUTE FUNCTION private.guard_purchase_order_receipt_status();

CREATE OR REPLACE FUNCTION public.receive_purchase_order(
  p_order_id uuid,
  p_target_status text DEFAULT 'received',
  p_batches jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM pg_catalog.set_config(
    'atlas.purchase_receipt_order_id',
    COALESCE(p_order_id::text, ''),
    true
  );
  RETURN private.receive_purchase_order(p_order_id, p_target_status, p_batches);
END;
$function$;

REVOKE ALL ON FUNCTION private.receive_purchase_order(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.receive_purchase_order(uuid, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_purchase_order(uuid, text, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION private.guard_purchase_order_receipt_status() IS
  'Rejects purchase-order receipt status transitions unless the secured receipt RPC bound the current transaction to that order.';
