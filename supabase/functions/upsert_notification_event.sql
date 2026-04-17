CREATE OR REPLACE FUNCTION public.upsert_notification_event(
  p_workspace_id uuid,
  p_user_id uuid,
  p_entity_type text,
  p_entity_id text,
  p_due_date date,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_event_id uuid;
BEGIN
  INSERT INTO notifications.events (
    workspace_id,
    user_id,
    entity_type,
    entity_id,
    due_date,
    payload,
    status,
    attempt_count,
    last_attempt_at,
    error
  )
  VALUES (
    p_workspace_id,
    p_user_id,
    p_entity_type,
    p_entity_id,
    p_due_date,
    COALESCE(p_payload, '{}'::jsonb),
    'pending',
    0,
    NULL,
    NULL
  )
  ON CONFLICT (user_id, entity_type, entity_id, due_date) DO UPDATE
  SET
    workspace_id = EXCLUDED.workspace_id,
    payload = EXCLUDED.payload,
    status = 'pending',
    attempt_count = 0,
    last_attempt_at = NULL,
    error = NULL,
    updated_at = now()
  WHERE notifications.events.workspace_id IS DISTINCT FROM EXCLUDED.workspace_id
     OR notifications.events.payload IS DISTINCT FROM EXCLUDED.payload
     OR notifications.events.status IN ('failed', 'pending')
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    SELECT e.id
    INTO v_event_id
    FROM notifications.events e
    WHERE e.user_id = p_user_id
      AND e.entity_type = p_entity_type
      AND e.entity_id = p_entity_id
      AND e.due_date = p_due_date;
  END IF;

  RETURN v_event_id;
END;
$function$;
