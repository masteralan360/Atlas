CREATE TABLE budget.budget_allocations (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL,
  month text NOT NULL,
  currency text NOT NULL DEFAULT 'usd'::text,
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  allocation_type text NULL DEFAULT 'fixed'::text,
  allocation_value numeric NULL DEFAULT 0,
  sync_status text NULL DEFAULT 'synced'::text,
  last_synced_at timestamp with time zone NULL,
  PRIMARY KEY (id)
);
