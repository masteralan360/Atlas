CREATE TABLE budget.budget_settings (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL,
  start_month text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  last_synced_at timestamp with time zone NULL,
  PRIMARY KEY (id)
);
