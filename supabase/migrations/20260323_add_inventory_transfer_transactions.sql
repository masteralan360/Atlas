CREATE TABLE IF NOT EXISTS public.inventory_transfer_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  product_id uuid NOT NULL,
  source_storage_id uuid NOT NULL,
  destination_storage_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  transfer_type text NOT NULL,
  reorder_rule_id uuid NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  CONSTRAINT inventory_transfer_transactions_transfer_type_check
    CHECK (transfer_type IN ('manual', 'automation'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_transfer_transactions_workspace
  ON public.inventory_transfer_transactions (workspace_id);

CREATE INDEX IF NOT EXISTS idx_inventory_transfer_transactions_workspace_created
  ON public.inventory_transfer_transactions (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_transfer_transactions_workspace_product
  ON public.inventory_transfer_transactions (workspace_id, product_id);

CREATE INDEX IF NOT EXISTS idx_inventory_transfer_transactions_workspace_type
  ON public.inventory_transfer_transactions (workspace_id, transfer_type);

CREATE OR REPLACE FUNCTION public.prevent_inventory_transfer_transaction_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory transfer transactions cannot be deleted';
  END IF;

  IF NEW.is_deleted IS TRUE AND OLD.is_deleted IS DISTINCT FROM NEW.is_deleted THEN
    RAISE EXCEPTION 'inventory transfer transactions cannot be soft-deleted';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inventory_transfer_transactions_prevent_delete
  ON public.inventory_transfer_transactions;

CREATE TRIGGER trg_inventory_transfer_transactions_prevent_delete
  BEFORE DELETE OR UPDATE OF is_deleted
  ON public.inventory_transfer_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_inventory_transfer_transaction_delete();
