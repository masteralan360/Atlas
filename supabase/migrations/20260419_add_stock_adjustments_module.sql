ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS stock_adjustments boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.stock_adjustments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  product_id uuid NOT NULL,
  storage_id uuid NOT NULL,
  adjustment_type text NOT NULL,
  quantity integer NOT NULL,
  previous_quantity integer NOT NULL DEFAULT 0,
  new_quantity integer NOT NULL DEFAULT 0,
  reason text NOT NULL,
  notes text NULL,
  created_by text NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  CONSTRAINT stock_adjustments_type_check CHECK (adjustment_type IN ('increase', 'decrease')),
  CONSTRAINT stock_adjustments_reason_check CHECK (reason IN ('purchase', 'return', 'correction', 'damage', 'theft', 'expired', 'production', 'other')),
  CONSTRAINT stock_adjustments_quantity_check CHECK (quantity > 0),
  CONSTRAINT stock_adjustments_previous_quantity_check CHECK (previous_quantity >= 0),
  CONSTRAINT stock_adjustments_new_quantity_check CHECK (new_quantity >= 0)
);

CREATE TABLE IF NOT EXISTS public.inventory_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  product_id uuid NOT NULL,
  storage_id uuid NOT NULL,
  transaction_type text NOT NULL,
  quantity_delta integer NOT NULL,
  previous_quantity integer NOT NULL DEFAULT 0,
  new_quantity integer NOT NULL DEFAULT 0,
  reference_id text NULL,
  reference_type text NULL,
  notes text NULL,
  created_by text NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  CONSTRAINT inventory_transactions_type_check CHECK (transaction_type IN ('stock_adjustment', 'transfer_in', 'transfer_out', 'sale', 'return', 'initial_stock')),
  CONSTRAINT inventory_transactions_delta_check CHECK (quantity_delta <> 0),
  CONSTRAINT inventory_transactions_previous_quantity_check CHECK (previous_quantity >= 0),
  CONSTRAINT inventory_transactions_new_quantity_check CHECK (new_quantity >= 0)
);

CREATE TABLE IF NOT EXISTS public.stock_batches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  product_id uuid NOT NULL,
  storage_id uuid NOT NULL,
  batch_number text NOT NULL,
  quantity integer NOT NULL,
  expiry_date date NULL,
  manufacturing_date date NULL,
  notes text NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  CONSTRAINT stock_batches_quantity_check CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_workspace_product
  ON public.stock_adjustments (workspace_id, product_id);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_workspace_created
  ON public.stock_adjustments (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_workspace_reason
  ON public.stock_adjustments (workspace_id, reason);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_workspace_product
  ON public.inventory_transactions (workspace_id, product_id);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_workspace_created
  ON public.inventory_transactions (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_workspace_type
  ON public.inventory_transactions (workspace_id, transaction_type);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_reference
  ON public.inventory_transactions (reference_id);

CREATE INDEX IF NOT EXISTS idx_stock_batches_workspace_product
  ON public.stock_batches (workspace_id, product_id);

CREATE INDEX IF NOT EXISTS idx_stock_batches_product_storage
  ON public.stock_batches (product_id, storage_id);

CREATE INDEX IF NOT EXISTS idx_stock_batches_expiry_date
  ON public.stock_batches (expiry_date);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_batches_active_number
  ON public.stock_batches (workspace_id, product_id, storage_id, lower(batch_number))
  WHERE is_deleted = false;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'stock_adjustments',
    'inventory_transactions',
    'stock_batches'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_select', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (workspace_id = public.current_workspace_id())',
      table_name || '_select',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_insert', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff''))',
      table_name || '_insert',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_update', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff'')) WITH CHECK (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff''))',
      table_name || '_update',
      table_name
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_delete', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (workspace_id = public.current_workspace_id() AND public.current_user_role() IN (''admin'', ''staff''))',
      table_name || '_delete',
      table_name
    );
  END LOOP;
END $$;
