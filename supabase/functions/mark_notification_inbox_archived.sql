CREATE OR REPLACE FUNCTION public.mark_notification_inbox_archived(p_notification_id uuid, p_archived boolean DEFAULT true)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, notifications
AS $function$
BEGIN
  UPDATE notifications.inbox
  SET archived_at = CASE
      WHEN COALESCE(p_archived, true) THEN COALESCE(archived_at, now())
      ELSE NULL
    END,
    updated_at = now()
  WHERE id = p_notification_id
    AND user_id = auth.uid()
    AND workspace_id = public.current_workspace_id();

  RETURN FOUND;
END;
$function$
