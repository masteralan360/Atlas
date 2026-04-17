CREATE OR REPLACE FUNCTION public.get_pending_push_notification_targets(
  p_limit integer DEFAULT 100,
  p_workspace_id uuid DEFAULT NULL
)
RETURNS TABLE(
  notification_id uuid,
  workspace_id uuid,
  user_id uuid,
  notification_type text,
  title text,
  body text,
  action_url text,
  payload jsonb,
  created_at timestamptz,
  token_id uuid,
  device_token text,
  platform text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
  WITH pending_notifications AS (
    SELECT
      n.id,
      n.workspace_id,
      n.user_id,
      n.notification_type,
      n.title,
      n.body,
      n.action_url,
      n.payload,
      n.created_at
    FROM notifications.inbox n
    WHERE n.push_status = 'pending'
      AND n.archived_at IS NULL
      AND (p_workspace_id IS NULL OR n.workspace_id = p_workspace_id)
    ORDER BY n.created_at ASC, n.id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  )
  SELECT
    pn.id,
    pn.workspace_id,
    pn.user_id,
    pn.notification_type,
    pn.title,
    pn.body,
    pn.action_url,
    pn.payload,
    pn.created_at,
    dt.id,
    dt.device_token,
    dt.platform
  FROM pending_notifications pn
  LEFT JOIN notifications.device_tokens dt
    ON dt.user_id = pn.user_id
   AND dt.workspace_id = pn.workspace_id
  ORDER BY pn.created_at ASC, pn.id ASC, dt.updated_at DESC NULLS LAST, dt.id ASC;
$function$;
