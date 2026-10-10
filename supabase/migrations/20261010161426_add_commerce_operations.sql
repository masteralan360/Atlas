CREATE TABLE IF NOT EXISTS public.commerce_operations_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (record_type IN (
    'order_details', 'ad_spend', 'dm_funnel', 'city_market', 'competitor', 'coach_profile'
  )),
  record_date timestamptz NOT NULL DEFAULT now(),
  title text NOT NULL,
  related_order_id uuid,
  related_partner_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  is_deleted boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS commerce_operations_records_workspace_kind_date_idx
  ON public.commerce_operations_records (workspace_id, record_type, record_date DESC)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS commerce_operations_records_workspace_order_idx
  ON public.commerce_operations_records (workspace_id, related_order_id)
  WHERE related_order_id IS NOT NULL;

ALTER TABLE public.commerce_operations_records ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.commerce_operations_records FROM anon, authenticated;

DROP POLICY IF EXISTS commerce_operations_records_select ON public.commerce_operations_records;
CREATE POLICY commerce_operations_records_select
  ON public.commerce_operations_records FOR SELECT TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT plan::text FROM public.workspaces WHERE id = workspace_id),
      'commerce_operations'
    )
  );

DROP POLICY IF EXISTS commerce_operations_records_insert ON public.commerce_operations_records;
CREATE POLICY commerce_operations_records_insert
  ON public.commerce_operations_records FOR INSERT TO authenticated
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT plan::text FROM public.workspaces WHERE id = workspace_id),
      'commerce_operations'
    )
  );

DROP POLICY IF EXISTS commerce_operations_records_update ON public.commerce_operations_records;
CREATE POLICY commerce_operations_records_update
  ON public.commerce_operations_records FOR UPDATE TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT plan::text FROM public.workspaces WHERE id = workspace_id),
      'commerce_operations'
    )
  )
  WITH CHECK (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() IN ('admin', 'staff')
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT plan::text FROM public.workspaces WHERE id = workspace_id),
      'commerce_operations'
    )
  );

DROP POLICY IF EXISTS commerce_operations_records_delete ON public.commerce_operations_records;
CREATE POLICY commerce_operations_records_delete
  ON public.commerce_operations_records FOR DELETE TO authenticated
  USING (
    workspace_id = public.current_workspace_id()
    AND public.current_user_role() = 'admin'
    AND public.workspace_module_allowed(
      workspace_id,
      (SELECT plan::text FROM public.workspaces WHERE id = workspace_id),
      'commerce_operations'
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.commerce_operations_records TO authenticated;

