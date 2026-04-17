ALTER TABLE notifications.inbox
  ADD COLUMN IF NOT EXISTS push_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS push_sent_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS push_last_attempt_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS push_error text NULL,
  ADD COLUMN IF NOT EXISTS push_attempt_count integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notifications_inbox_push_status_check'
      AND conrelid = 'notifications.inbox'::regclass
  ) THEN
    ALTER TABLE notifications.inbox
      ADD CONSTRAINT notifications_inbox_push_status_check
      CHECK (push_status IN ('pending', 'sent', 'failed', 'skipped'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_push_status_created_at
  ON notifications.inbox (push_status, created_at ASC)
  WHERE archived_at IS NULL;

UPDATE notifications.inbox
SET push_status = 'skipped',
    push_sent_at = NULL,
    push_last_attempt_at = now(),
    push_error = 'Push delivery enabled after this notification was created',
    push_attempt_count = 0
WHERE push_sent_at IS NULL
  AND push_last_attempt_at IS NULL
  AND push_attempt_count = 0;

CREATE OR REPLACE FUNCTION public.get_pending_push_notification_targets(p_limit integer DEFAULT 100)
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

REVOKE ALL ON FUNCTION public.get_pending_push_notification_targets(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pending_push_notification_targets(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.update_notification_push_delivery(
  p_notification_id uuid,
  p_status text,
  p_error text DEFAULT NULL,
  p_attempt_delta integer DEFAULT 1
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_status text := lower(trim(COALESCE(p_status, '')));
  v_error text := NULLIF(trim(COALESCE(p_error, '')), '');
  v_attempt_delta integer := GREATEST(COALESCE(p_attempt_delta, 1), 0);
BEGIN
  IF v_status NOT IN ('pending', 'sent', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'Unsupported push status: %', COALESCE(v_status, '<null>');
  END IF;

  UPDATE notifications.inbox
  SET
    push_status = v_status,
    push_sent_at = CASE
      WHEN v_status = 'sent' THEN COALESCE(push_sent_at, now())
      WHEN v_status = 'pending' THEN NULL
      ELSE push_sent_at
    END,
    push_last_attempt_at = CASE
      WHEN v_status = 'pending' THEN NULL
      ELSE now()
    END,
    push_error = CASE
      WHEN v_status IN ('sent', 'pending') THEN NULL
      ELSE v_error
    END,
    push_attempt_count = CASE
      WHEN v_status = 'pending' THEN 0
      ELSE push_attempt_count + v_attempt_delta
    END,
    updated_at = now()
  WHERE id = p_notification_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_notification_push_delivery(uuid, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_notification_push_delivery(uuid, text, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_device_token(p_token_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_deleted integer := 0;
BEGIN
  DELETE FROM notifications.device_tokens
  WHERE id = p_token_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_device_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_device_token(uuid) TO service_role;

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
