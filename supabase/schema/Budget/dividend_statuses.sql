CREATE TABLE budget.dividend_statuses (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  workspace_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  month text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  snoozed_until timestamp with time zone NULL,
  snoozed_indefinite boolean NOT NULL DEFAULT false,
  snooze_count integer NOT NULL DEFAULT 0,
  paid_at timestamp with time zone NULL,
  is_locked boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  sync_status text NULL DEFAULT 'synced'::text,
  last_synced_at timestamp with time zone NULL,
  PRIMARY KEY (id)
);
