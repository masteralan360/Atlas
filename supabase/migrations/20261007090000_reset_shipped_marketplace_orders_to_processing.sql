-- Reset pre-existing shipped marketplace orders before the next migration
-- adds shipping actor columns and moves Sales Order creation to shipment.
UPDATE public.marketplace_orders
SET
  status = 'processing',
  shipped_at = NULL,
  updated_at = timezone('utc', now()),
  version = COALESCE(version, 0) + 1
WHERE status = 'shipped';
