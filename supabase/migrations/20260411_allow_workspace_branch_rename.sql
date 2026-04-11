DROP POLICY IF EXISTS workspace_branches_update ON public.workspace_branches;
CREATE POLICY workspace_branches_update
  ON public.workspace_branches
  FOR UPDATE
  TO authenticated
  USING (
    public.current_user_role() = 'admin'
    AND (
      source_workspace_id = public.current_workspace_id()
      OR branch_workspace_id = public.current_workspace_id()
    )
  )
  WITH CHECK (
    public.current_user_role() = 'admin'
    AND (
      source_workspace_id = public.current_workspace_id()
      OR branch_workspace_id = public.current_workspace_id()
    )
  );
