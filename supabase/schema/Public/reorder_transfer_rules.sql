CREATE TABLE public.reorder_transfer_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  product_id uuid NOT NULL,
  source_storage_id uuid NOT NULL,
  destination_storage_id uuid NOT NULL,
  min_stock_level integer NOT NULL DEFAULT 0,
  transfer_quantity integer NOT NULL DEFAULT 1,
  expires_on date NULL,
  is_indefinite boolean NOT NULL DEFAULT false,
  last_triggered_at timestamp with time zone NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_reorder_transfer_rules_workspace
  ON public.reorder_transfer_rules (workspace_id);

CREATE INDEX IF NOT EXISTS idx_reorder_transfer_rules_workspace_product
  ON public.reorder_transfer_rules (workspace_id, product_id);

CREATE INDEX IF NOT EXISTS idx_reorder_transfer_rules_workspace_destination
  ON public.reorder_transfer_rules (workspace_id, destination_storage_id);

CREATE INDEX IF NOT EXISTS idx_reorder_transfer_rules_workspace_expiry
  ON public.reorder_transfer_rules (workspace_id, expires_on);
