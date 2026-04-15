CREATE OR REPLACE FUNCTION public.sync_branch_workspace_status_from_source()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE public.workspaces AS branch_workspace
  SET
    locked_workspace = NEW.locked_workspace,
    subscription_expires_at = NEW.subscription_expires_at
  WHERE branch_workspace.id IN (
      SELECT wb.branch_workspace_id
      FROM public.workspace_branches wb
      WHERE wb.source_workspace_id = NEW.id
    )
    AND (
      branch_workspace.locked_workspace IS DISTINCT FROM NEW.locked_workspace
      OR branch_workspace.subscription_expires_at IS DISTINCT FROM NEW.subscription_expires_at
    );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_branch_workspace_status_from_source ON public.workspaces;
CREATE TRIGGER trg_sync_branch_workspace_status_from_source
AFTER UPDATE OF locked_workspace, subscription_expires_at ON public.workspaces
FOR EACH ROW
WHEN (
  NEW.locked_workspace IS DISTINCT FROM OLD.locked_workspace
  OR NEW.subscription_expires_at IS DISTINCT FROM OLD.subscription_expires_at
)
EXECUTE FUNCTION public.sync_branch_workspace_status_from_source();

CREATE OR REPLACE FUNCTION public.sync_new_branch_workspace_status_from_source()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE public.workspaces AS branch_workspace
  SET
    locked_workspace = source_workspace.locked_workspace,
    subscription_expires_at = source_workspace.subscription_expires_at
  FROM public.workspaces AS source_workspace
  WHERE branch_workspace.id = NEW.branch_workspace_id
    AND source_workspace.id = NEW.source_workspace_id
    AND (
      branch_workspace.locked_workspace IS DISTINCT FROM source_workspace.locked_workspace
      OR branch_workspace.subscription_expires_at IS DISTINCT FROM source_workspace.subscription_expires_at
    );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_new_branch_workspace_status_from_source ON public.workspace_branches;
CREATE TRIGGER trg_sync_new_branch_workspace_status_from_source
AFTER INSERT ON public.workspace_branches
FOR EACH ROW
EXECUTE FUNCTION public.sync_new_branch_workspace_status_from_source();

UPDATE public.workspaces AS branch_workspace
SET
  locked_workspace = source_workspace.locked_workspace,
  subscription_expires_at = source_workspace.subscription_expires_at
FROM public.workspace_branches wb
JOIN public.workspaces AS source_workspace
  ON source_workspace.id = wb.source_workspace_id
WHERE branch_workspace.id = wb.branch_workspace_id
  AND (
    branch_workspace.locked_workspace IS DISTINCT FROM source_workspace.locked_workspace
    OR branch_workspace.subscription_expires_at IS DISTINCT FROM source_workspace.subscription_expires_at
  );
