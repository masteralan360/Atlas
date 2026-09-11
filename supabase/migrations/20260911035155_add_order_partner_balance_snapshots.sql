-- The snapshot is a historical print/audit value captured by the order
-- posting workflow. It intentionally remains nullable for legacy and draft
-- records; they must not be backfilled from a later live balance.
ALTER TABLE crm.sales_orders
  ADD COLUMN IF NOT EXISTS partner_balance_snapshot jsonb NULL;

ALTER TABLE crm.purchase_orders
  ADD COLUMN IF NOT EXISTS partner_balance_snapshot jsonb NULL;

CREATE OR REPLACE FUNCTION crm.prevent_order_partner_balance_snapshot_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.partner_balance_snapshot IS NOT NULL
    AND NEW.partner_balance_snapshot IS DISTINCT FROM OLD.partner_balance_snapshot THEN
    RAISE EXCEPTION 'Order partner balance snapshot is immutable';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_orders_partner_balance_snapshot_immutable ON crm.sales_orders;
CREATE TRIGGER sales_orders_partner_balance_snapshot_immutable
  BEFORE UPDATE ON crm.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION crm.prevent_order_partner_balance_snapshot_change();

DROP TRIGGER IF EXISTS purchase_orders_partner_balance_snapshot_immutable ON crm.purchase_orders;
CREATE TRIGGER purchase_orders_partner_balance_snapshot_immutable
  BEFORE UPDATE ON crm.purchase_orders
  FOR EACH ROW
  EXECUTE FUNCTION crm.prevent_order_partner_balance_snapshot_change();
