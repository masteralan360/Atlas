CREATE OR REPLACE FUNCTION public.list_notifications_inbox(p_limit integer DEFAULT 200)
 RETURNS TABLE(id uuid, event_id uuid, workspace_id uuid, user_id uuid, notification_type text, scope text, priority text, dedupe_key text, title text, body text, action_url text, action_label text, payload jsonb, read_at timestamp with time zone, archived_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, notifications
AS $function$
  SELECT
    n.id,
    n.event_id,
    n.workspace_id,
    n.user_id,
    n.notification_type,
    n.scope,
    n.priority,
    n.dedupe_key,
    n.title,
    n.body,
    n.action_url,
    n.action_label,
    n.payload,
    n.read_at,
    n.archived_at,
    n.created_at,
    n.updated_at
  FROM notifications.inbox n
  WHERE n.user_id = auth.uid()
    AND n.workspace_id = public.current_workspace_id()
  ORDER BY n.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$function$
