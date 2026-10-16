-- Resolve the linked workspace user for Coach-platform social orders on the
-- server. RLS on crm.agents still limits the row to this workspace and the
-- Agents module.
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

-- Orders attributed to someone other than the authenticated actor must use a
-- current, non-deleted agent link in the same workspace. The RPC above
-- resolves the selected agent; this trigger closes the gap between lookup and
-- persistence and prevents clients from bypassing the check by changing the
-- source channel.
CREATE OR REPLACE FUNCTION private.validate_sales_order_creator_agent_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id
    AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
  THEN
    RETURN NEW;
  END IF;

  IF NEW.created_by IS NULL OR NEW.created_by = auth.uid()
  THEN
    RETURN NEW;
  END IF;

  IF NEW.workspace_id IS DISTINCT FROM public.current_workspace_id()
    OR NOT EXISTS (
      SELECT 1
      FROM crm.agents AS agent
      WHERE agent.workspace_id = NEW.workspace_id
        AND agent.linked_user_id = NEW.created_by
        AND COALESCE(agent.is_deleted, false) = false
    )
  THEN
    RAISE EXCEPTION 'social_order_agent_creator_invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS validate_sales_order_creator_agent_link ON crm.sales_orders;
CREATE TRIGGER validate_sales_order_creator_agent_link
  BEFORE INSERT OR UPDATE OF workspace_id, created_by
  ON crm.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION private.validate_sales_order_creator_agent_link();
