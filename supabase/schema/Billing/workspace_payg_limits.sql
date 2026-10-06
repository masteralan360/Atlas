CREATE TABLE billing.workspace_payg_limits (
  workspace_id uuid NOT NULL,
  metric text NOT NULL DEFAULT 'accrued_charge'::text,
  threshold numeric(20, 6) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT workspace_payg_limits_pkey PRIMARY KEY (workspace_id),
  CONSTRAINT workspace_payg_limits_metric_check
    CHECK (metric = ANY (ARRAY['accrued_charge'::text, 'changed_usage'::text])),
  CONSTRAINT workspace_payg_limits_threshold_check
    CHECK (threshold > 0::numeric AND threshold <> 'NaN'::numeric),
  CONSTRAINT workspace_payg_limits_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE
);
