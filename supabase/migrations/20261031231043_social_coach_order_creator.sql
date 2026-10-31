-- A social Coach order may be created on behalf of a linked Seller agent.
-- Resolve that attribution again inside the atomic Quick Order transaction so
-- the authoritative creator cannot be replaced by the signed-in operator.
CREATE OR REPLACE FUNCTION public.resolve_social_order_agent_creator(
  p_workspace_id uuid,
  p_agent_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_linked_user_id uuid;
BEGIN
  IF auth.uid() IS NULL
    OR p_workspace_id IS NULL
    OR p_agent_id IS NULL
    OR p_workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR COALESCE(public.current_user_role(), '') NOT IN ('admin', 'staff')
    OR NOT COALESCE(public.current_user_can_access_sales_orders(p_workspace_id), false)
  THEN
    RAISE EXCEPTION 'social_order_agent_creator_unauthorized'
      USING ERRCODE = '42501';
  END IF;

  SELECT agent.linked_user_id
    INTO v_linked_user_id
  FROM crm.agents AS agent
  WHERE agent.id = p_agent_id
    AND agent.workspace_id = p_workspace_id
    AND agent.agent_type = 'seller'
    AND COALESCE(agent.is_deleted, false) = false
    AND agent.linked_user_id IS NOT NULL;

  IF v_linked_user_id IS NULL THEN
    RAISE EXCEPTION 'social_order_agent_creator_invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN v_linked_user_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_social_order_agent_creator(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_social_order_agent_creator(uuid, uuid) TO authenticated;

-- Preserve the existing atomic Quick Order implementation and its transaction
-- boundary. The public wrapper continues to call this helper; only the helper's
-- optional creator attribution is extended for social Coach orders.
DO $patch_quick_order_creator$
DECLARE
  function_sql text;
  old_declarations constant text := $old_declarations$
  v_paid_amount numeric := COALESCE(NULLIF(v_order_payload->>'paid_amount', '')::numeric, 0);
BEGIN$old_declarations$;
  new_declarations constant text := $new_declarations$
  v_paid_amount numeric := COALESCE(NULLIF(v_order_payload->>'paid_amount', '')::numeric, 0);
  v_creator_agent_id uuid;
  v_creator_user_id uuid;
BEGIN$new_declarations$;
  creator_validation constant text := $creator_validation$
  BEGIN
    v_creator_agent_id := NULLIF(pg_catalog.btrim(payload->>'creator_agent_id'), '')::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Social order agent id is invalid' USING ERRCODE = '22023';
  END;

  IF v_creator_agent_id IS NULL THEN
    -- Ordinary Quick Orders keep their existing actor attribution.
    v_order_payload := v_order_payload || pg_catalog.jsonb_build_object('created_by', auth.uid());
  ELSE
    IF COALESCE(public.current_user_role(), '') NOT IN ('admin', 'staff')
      OR NOT COALESCE(public.current_user_can_access_sales_orders(v_workspace_id), false)
    THEN
      RAISE EXCEPTION 'social_order_agent_creator_unauthorized' USING ERRCODE = '42501';
    END IF;

    SELECT agent.linked_user_id
      INTO v_creator_user_id
    FROM crm.agents AS agent
    WHERE agent.id = v_creator_agent_id
      AND agent.workspace_id = v_workspace_id
      AND agent.agent_type = 'seller'
      AND COALESCE(agent.is_deleted, false) = false
      AND agent.linked_user_id IS NOT NULL;

    IF v_creator_user_id IS NULL THEN
      RAISE EXCEPTION 'social_order_agent_creator_invalid' USING ERRCODE = '23514';
    END IF;

    -- Ignore the client-supplied creator snapshot and use the linked user read
    -- from the selected Seller agent in this same database transaction.
    v_order_payload := v_order_payload || pg_catalog.jsonb_build_object('created_by', v_creator_user_id);
  END IF;

$creator_validation$;
  old_validation_marker constant text := $old_validation_marker$
  IF jsonb_typeof(v_order_payload->'items') <> 'array'
    OR jsonb_array_length(v_order_payload->'items') = 0 THEN$old_validation_marker$;
  old_creator_value constant text := $old_creator_value$
    v_paid_amount,
    0,
    false,
    0,
    NULL,
    NULL,
    NULL,
    auth.uid(),
    0,$old_creator_value$;
  new_creator_value constant text := $new_creator_value$
    v_paid_amount,
    0,
    false,
    0,
    NULL,
    NULL,
    NULL,
    COALESCE(NULLIF(v_order_payload->>'created_by', '')::uuid, auth.uid()),
    0,$new_creator_value$;
  first_position integer;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('private.complete_quick_sales_order_once(jsonb)'::regprocedure)
  INTO function_sql;
  function_sql := pg_catalog.replace(function_sql, E'\r\n', E'\n');

  IF pg_catalog.strpos(function_sql, old_declarations) = 0
    OR pg_catalog.strpos(function_sql, old_validation_marker) = 0
    OR pg_catalog.strpos(function_sql, old_creator_value) = 0
  THEN
    RAISE EXCEPTION 'Quick Order creator patch did not match the expected function';
  END IF;

  first_position := pg_catalog.strpos(function_sql, old_creator_value);
  IF pg_catalog.strpos(
    pg_catalog.substr(function_sql, first_position + pg_catalog.length(old_creator_value)),
    old_creator_value
  ) > 0 THEN
    RAISE EXCEPTION 'Quick Order creator value matched more than once';
  END IF;

  function_sql := pg_catalog.replace(function_sql, old_declarations, new_declarations);
  function_sql := pg_catalog.replace(
    function_sql,
    old_validation_marker,
    creator_validation || old_validation_marker
  );
  function_sql := pg_catalog.replace(function_sql, old_creator_value, new_creator_value);

  IF pg_catalog.strpos(function_sql, 'v_creator_agent_id uuid;') = 0
    OR pg_catalog.strpos(function_sql, 'agent.agent_type = ''seller''') = 0
    OR pg_catalog.strpos(
      function_sql,
      'COALESCE(NULLIF(v_order_payload->>''created_by'', '''')::uuid, auth.uid())'
    ) = 0
  THEN
    RAISE EXCEPTION 'Quick Order creator patch failed its preservation checks';
  END IF;

  EXECUTE function_sql;
END;
$patch_quick_order_creator$;
