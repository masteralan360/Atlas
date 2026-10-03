CREATE TABLE public.inventory_transfer_batches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  transfer_number text NOT NULL,
  source_workspace_id uuid NULL REFERENCES public.workspaces(id) ON DELETE SET NULL,
  source_workspace_name text NULL,
  source_storage_id uuid NULL REFERENCES public.storages(id) ON DELETE SET NULL,
  source_storage_name text NULL,
  destination_workspace_id uuid NULL REFERENCES public.workspaces(id) ON DELETE SET NULL,
  destination_workspace_name text NULL,
  destination_storage_id uuid NULL REFERENCES public.storages(id) ON DELETE SET NULL,
  destination_storage_name text NULL,
  performed_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  transferred_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'completed',
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT inventory_transfer_batches_transfer_number_check
    CHECK (transfer_number ~ '^TRF-[0-9]{5,}$'),
  CONSTRAINT inventory_transfer_batches_status_check
    CHECK (status IN ('completed', 'cancelled')),
  CONSTRAINT inventory_transfer_batches_source_storage_workspace_check
    CHECK (source_storage_id IS NULL OR source_workspace_id IS NOT NULL),
  CONSTRAINT inventory_transfer_batches_destination_storage_workspace_check
    CHECK (destination_storage_id IS NULL OR destination_workspace_id IS NOT NULL),
  CONSTRAINT inventory_transfer_batches_version_check CHECK (version > 0)
);

CREATE UNIQUE INDEX inventory_transfer_batches_workspace_number_idx
  ON public.inventory_transfer_batches (workspace_id, transfer_number);
CREATE INDEX inventory_transfer_batches_workspace_transferred_idx
  ON public.inventory_transfer_batches (workspace_id, transferred_at DESC);
CREATE INDEX inventory_transfer_batches_source_workspace_idx
  ON public.inventory_transfer_batches (source_workspace_id, transferred_at DESC);
CREATE INDEX inventory_transfer_batches_destination_workspace_idx
  ON public.inventory_transfer_batches (destination_workspace_id, transferred_at DESC);

ALTER TABLE public.inventory_transactions
  ADD COLUMN IF NOT EXISTS transfer_batch_id uuid NULL
    REFERENCES public.inventory_transfer_batches(id) ON DELETE SET NULL;

ALTER TABLE public.inventory_transactions
  ADD CONSTRAINT inventory_transactions_transfer_batch_type_check
  CHECK (
    transfer_batch_id IS NULL
    OR transaction_type IN ('transfer_in', 'transfer_out')
  );

CREATE INDEX IF NOT EXISTS inventory_transactions_transfer_batch_idx
  ON public.inventory_transactions (transfer_batch_id)
  WHERE transfer_batch_id IS NOT NULL;
