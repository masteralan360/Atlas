-- An INSERT ... ON CONFLICT request fires the BEFORE INSERT trigger before
-- PostgreSQL chooses its conflict-update path. Permit that replay only when
-- the persisted row already has this exact id, workspace, and creator. This
-- preserves the creator validation for new rows and attribution changes.
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

  IF TG_OP = 'INSERT'
    AND EXISTS (
      SELECT 1
      FROM crm.sales_orders AS existing_order
      WHERE existing_order.id = NEW.id
        AND existing_order.workspace_id IS NOT DISTINCT FROM NEW.workspace_id
        AND existing_order.created_by IS NOT DISTINCT FROM NEW.created_by
    )
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
