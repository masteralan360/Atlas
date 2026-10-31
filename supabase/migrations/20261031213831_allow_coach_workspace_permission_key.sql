ALTER TABLE public.workspace_permissions
  DROP CONSTRAINT IF EXISTS workspace_permissions_key_format_check;

ALTER TABLE public.workspace_permissions
  ADD CONSTRAINT workspace_permissions_key_format_check CHECK (
    key = 'coach'
    OR key ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
  );

CREATE OR REPLACE FUNCTION public.enforce_workspace_permissions_plan_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_plan text;
BEGIN
  -- Coach is an admin-granted permission for the Coach Data module.
  IF NEW.key = 'coach' THEN
    RETURN NEW;
  END IF;

  SELECT plan INTO v_plan
  FROM public.workspaces
  WHERE id = NEW.workspace_id
    AND deleted_at IS NULL;

  IF v_plan IS NULL OR NOT public.workspace_capability_allowed(NEW.workspace_id, v_plan, 'workspaceManagementPermissions') THEN
    RAISE EXCEPTION 'Workspace management permissions are not included in the current workspace plan'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.module IN ('currencyExchange', 'currencyExchangeFeeRules')
    AND NOT public.workspace_module_allowed(NEW.workspace_id, v_plan, 'currency_exchange')
  THEN
    RAISE EXCEPTION 'Currency Exchange Service is not enabled for this workspace'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.module IN ('agents', 'fleet')
    AND NOT public.workspace_module_allowed(NEW.workspace_id, v_plan, 'agents')
  THEN
    RAISE EXCEPTION 'Agents module is not enabled for this workspace'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.module = 'salesAgentCommissions'
    AND NOT public.workspace_module_allowed(NEW.workspace_id, v_plan, 'sales_agent_commissions')
  THEN
    RAISE EXCEPTION 'Sales Agent Commissions is not enabled for this workspace'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;
