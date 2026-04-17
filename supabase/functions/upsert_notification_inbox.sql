CREATE OR REPLACE FUNCTION public.upsert_notification_inbox(p_event_id uuid, p_workspace_id uuid, p_user_id uuid, p_notification_type text, p_scope text DEFAULT 'user'::text, p_priority text DEFAULT 'normal'::text, p_dedupe_key text DEFAULT NULL::text, p_title text DEFAULT ''::text, p_body text DEFAULT NULL::text, p_action_url text DEFAULT NULL::text, p_action_label text DEFAULT NULL::text, p_payload jsonb DEFAULT '{}'::jsonb, p_created_at timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, notifications
AS $function$
DECLARE
  v_notification_id uuid;
BEGIN
  INSERT INTO notifications.inbox (
    event_id,
    workspace_id,
    user_id,
    notification_type,
    scope,
    priority,
    dedupe_key,
    title,
    body,
    action_url,
    action_label,
    payload,
    push_status,
    push_sent_at,
    push_last_attempt_at,
    push_error,
    push_attempt_count,
    created_at
  )
  VALUES (
    p_event_id,
    p_workspace_id,
    p_user_id,
    p_notification_type,
    COALESCE(NULLIF(TRIM(COALESCE(p_scope, '')), ''), 'user'),
    COALESCE(NULLIF(TRIM(COALESCE(p_priority, '')), ''), 'normal'),
    NULLIF(TRIM(COALESCE(p_dedupe_key, '')), ''),
    COALESCE(NULLIF(TRIM(COALESCE(p_title, '')), ''), 'Notification'),
    NULLIF(TRIM(COALESCE(p_body, '')), ''),
    NULLIF(TRIM(COALESCE(p_action_url, '')), ''),
    NULLIF(TRIM(COALESCE(p_action_label, '')), ''),
    COALESCE(p_payload, '{}'::jsonb),
    'pending',
    NULL,
    NULL,
    NULL,
    0,
    COALESCE(p_created_at, now())
  )
  ON CONFLICT (event_id) DO UPDATE
  SET
    workspace_id = EXCLUDED.workspace_id,
    user_id = EXCLUDED.user_id,
    notification_type = EXCLUDED.notification_type,
    scope = EXCLUDED.scope,
    priority = EXCLUDED.priority,
    dedupe_key = COALESCE(EXCLUDED.dedupe_key, notifications.inbox.dedupe_key),
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    action_url = EXCLUDED.action_url,
    action_label = EXCLUDED.action_label,
    payload = EXCLUDED.payload,
    push_status = 'pending',
    push_sent_at = NULL,
    push_last_attempt_at = NULL,
    push_error = NULL,
    push_attempt_count = 0,
    created_at = LEAST(notifications.inbox.created_at, EXCLUDED.created_at),
    updated_at = now()
  RETURNING id INTO v_notification_id;

  RETURN v_notification_id;
END;
$function$;
