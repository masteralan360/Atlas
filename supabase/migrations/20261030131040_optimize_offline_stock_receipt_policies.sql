-- Workspace and actor are constant for one statement. Cache these auth lookups
-- once while preserving the original receipt scope and executor-only writes.
ALTER POLICY offline_stock_receipts_read
  ON public.offline_stock_operation_receipts
  USING (
    workspace_id = (SELECT public.current_workspace_id())
    AND actor_id = (SELECT auth.uid())
  );

ALTER POLICY offline_stock_receipts_insert
  ON public.offline_stock_operation_receipts
  WITH CHECK (
    workspace_id = (SELECT public.current_workspace_id())
    AND actor_id = (SELECT auth.uid())
  );
