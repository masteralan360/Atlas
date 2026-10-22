CREATE OR REPLACE FUNCTION private.current_user_has_workspace_permission(
  p_workspace_id uuid,
  p_permission_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (SELECT auth.uid()) IS NOT NULL
    AND p_workspace_id = (SELECT public.current_workspace_id())
    AND EXISTS (
      SELECT 1
      FROM public.workspace_permissions AS permission
      WHERE permission.workspace_id = p_workspace_id
        AND permission.user_uuid = (SELECT auth.uid())
        AND permission.key = p_permission_key
    );
$function$;

REVOKE ALL ON FUNCTION private.current_user_has_workspace_permission(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.current_user_has_workspace_permission(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION private.current_user_has_workspace_permission(uuid, text) TO authenticated, service_role;

DO $move_helper_private$
DECLARE
  v_trigger_definition text;
  v_updated_trigger_definition text;
  v_policy record;
  v_updated_qual text;
  v_updated_check text;
  v_updated_policy_count integer := 0;
BEGIN
  SELECT pg_get_functiondef('public.enforce_crm_agent_custom_type()'::regprocedure)
    INTO v_trigger_definition;

  v_updated_trigger_definition := replace(
    v_trigger_definition,
    'public.current_user_has_workspace_permission(',
    'private.current_user_has_workspace_permission('
  );

  IF v_updated_trigger_definition = v_trigger_definition THEN
    RAISE EXCEPTION 'Custom agent type trigger does not reference the public permission helper';
  END IF;

  EXECUTE v_updated_trigger_definition;

  FOR v_policy IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'crm'
      AND tablename = 'agent_types'
  LOOP
    v_updated_qual := CASE
      WHEN v_policy.qual IS NULL THEN NULL
      ELSE replace(
        replace(
          v_policy.qual,
          'public.current_user_has_workspace_permission(',
          'current_user_has_workspace_permission('
        ),
        'current_user_has_workspace_permission(',
        'private.current_user_has_workspace_permission('
      )
    END;
    v_updated_check := CASE
      WHEN v_policy.with_check IS NULL THEN NULL
      ELSE replace(
        replace(
          v_policy.with_check,
          'public.current_user_has_workspace_permission(',
          'current_user_has_workspace_permission('
        ),
        'current_user_has_workspace_permission(',
        'private.current_user_has_workspace_permission('
      )
    END;

    IF v_updated_qual IS NOT DISTINCT FROM v_policy.qual
      AND v_updated_check IS NOT DISTINCT FROM v_policy.with_check
    THEN
      RAISE EXCEPTION 'Agent type policy % does not reference the workspace permission helper', v_policy.policyname;
    END IF;

    IF v_updated_qual IS NULL THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I WITH CHECK (%s)',
        v_policy.policyname,
        v_policy.schemaname,
        v_policy.tablename,
        v_updated_check
      );
    ELSIF v_updated_check IS NULL THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I USING (%s)',
        v_policy.policyname,
        v_policy.schemaname,
        v_policy.tablename,
        v_updated_qual
      );
    ELSE
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)',
        v_policy.policyname,
        v_policy.schemaname,
        v_policy.tablename,
        v_updated_qual,
        v_updated_check
      );
    END IF;

    v_updated_policy_count := v_updated_policy_count + 1;
  END LOOP;

  IF v_updated_policy_count <> 4 THEN
    RAISE EXCEPTION 'Expected to update 4 agent type policies, updated %', v_updated_policy_count;
  END IF;
END;
$move_helper_private$;

DROP FUNCTION public.current_user_has_workspace_permission(uuid, text);

NOTIFY pgrst, 'reload schema';
