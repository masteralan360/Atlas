CREATE OR REPLACE FUNCTION public.mark_all_notifications_inbox_read()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, notifications
AS $function$
DECLARE
  v_updated_count integer := 0;
BEGIN
  WITH updated_rows AS (
    UPDATE notifications.inbox
    SET read_at = COALESCE(read_at, now()),
        updated_at = now()
    WHERE user_id = auth.uid()
      AND workspace_id = public.current_workspace_id()
      AND archived_at IS NULL
      AND read_at IS NULL
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated_count
  FROM updated_rows;

  RETURN COALESCE(v_updated_count, 0);
END;
$function$
