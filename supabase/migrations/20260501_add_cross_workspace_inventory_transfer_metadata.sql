ALTER TABLE public.inventory_transfer_transactions
  ADD COLUMN IF NOT EXISTS source_workspace_id uuid NULL REFERENCES public.workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS destination_workspace_id uuid NULL REFERENCES public.workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_workspace_name text NULL,
  ADD COLUMN IF NOT EXISTS destination_workspace_name text NULL,
  ADD COLUMN IF NOT EXISTS source_storage_name text NULL,
  ADD COLUMN IF NOT EXISTS destination_storage_name text NULL;
