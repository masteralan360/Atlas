CREATE TABLE public.partner_settlement_operations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  partner_name_snapshot text NOT NULL,
  direction text NOT NULL,
  paid_at timestamp with time zone NOT NULL,
  payment_method text NOT NULL,
  note text NULL,
  created_by uuid NULL,
  account_id uuid NULL,
  account_name_snapshot text NULL,
  status text NOT NULL DEFAULT 'in_progress'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id)
);

CREATE INDEX partner_settlement_operations_workspace_partner_time_idx
  ON public.partner_settlement_operations (workspace_id, partner_id, paid_at DESC);

ALTER TABLE public.partner_settlement_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY partner_settlement_operations_select
  ON public.partner_settlement_operations
  FOR SELECT
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

CREATE POLICY partner_settlement_operations_insert
  ON public.partner_settlement_operations
  FOR INSERT
  TO authenticated
  WITH CHECK (workspace_id = public.current_workspace_id());

CREATE POLICY partner_settlement_operations_update
  ON public.partner_settlement_operations
  FOR UPDATE
  TO authenticated
  USING (workspace_id = public.current_workspace_id())
  WITH CHECK (workspace_id = public.current_workspace_id());

CREATE POLICY partner_settlement_operations_delete
  ON public.partner_settlement_operations
  FOR DELETE
  TO authenticated
  USING (workspace_id = public.current_workspace_id());

REVOKE ALL ON TABLE public.partner_settlement_operations FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.partner_settlement_operations TO authenticated, service_role;
