ALTER TABLE crm.sales_orders
  ADD COLUMN IF NOT EXISTS is_locked boolean;

UPDATE crm.sales_orders
SET is_locked = COALESCE(is_locked, false);

ALTER TABLE crm.sales_orders
  ALTER COLUMN is_locked SET DEFAULT false;

ALTER TABLE crm.sales_orders
  ALTER COLUMN is_locked SET NOT NULL;
