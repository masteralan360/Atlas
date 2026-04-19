ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS adjustment_reason text NULL;

ALTER TABLE public.inventory_transactions
  DROP CONSTRAINT IF EXISTS inventory_transactions_adjustment_reason_check;

ALTER TABLE public.inventory_transactions
  ADD CONSTRAINT inventory_transactions_adjustment_reason_check
  CHECK (
    adjustment_reason IS NULL
    OR adjustment_reason IN ('purchase', 'return', 'correction', 'damage', 'theft', 'expired', 'production', 'other')
  );

DELETE FROM public.inventory_transactions AS it
USING public.stock_adjustments AS sa
WHERE it.transaction_type = 'stock_adjustment'
  AND it.reference_id = sa.id::text
  AND it.id <> sa.id;

INSERT INTO public.inventory_transactions (
  id,
  workspace_id,
  product_id,
  storage_id,
  transaction_type,
  quantity_delta,
  previous_quantity,
  new_quantity,
  adjustment_reason,
  reference_id,
  reference_type,
  notes,
  created_by,
  created_at,
  updated_at,
  version,
  is_deleted
)
SELECT
  sa.id,
  sa.workspace_id,
  sa.product_id,
  sa.storage_id,
  'stock_adjustment',
  CASE
    WHEN sa.adjustment_type = 'increase' THEN sa.quantity
    ELSE -sa.quantity
  END,
  sa.previous_quantity,
  sa.new_quantity,
  sa.reason,
  sa.id::text,
  'stock_adjustment',
  sa.notes,
  sa.created_by,
  sa.created_at,
  sa.updated_at,
  sa.version,
  sa.is_deleted
FROM public.stock_adjustments AS sa
ON CONFLICT (id) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  product_id = EXCLUDED.product_id,
  storage_id = EXCLUDED.storage_id,
  transaction_type = EXCLUDED.transaction_type,
  quantity_delta = EXCLUDED.quantity_delta,
  previous_quantity = EXCLUDED.previous_quantity,
  new_quantity = EXCLUDED.new_quantity,
  adjustment_reason = EXCLUDED.adjustment_reason,
  reference_id = EXCLUDED.reference_id,
  reference_type = EXCLUDED.reference_type,
  notes = EXCLUDED.notes,
  created_by = EXCLUDED.created_by,
  created_at = EXCLUDED.created_at,
  updated_at = EXCLUDED.updated_at,
  version = EXCLUDED.version,
  is_deleted = EXCLUDED.is_deleted;

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_workspace_adjustment_reason
  ON public.inventory_transactions (workspace_id, adjustment_reason)
  WHERE transaction_type = 'stock_adjustment';

DROP TABLE IF EXISTS public.stock_adjustments;
