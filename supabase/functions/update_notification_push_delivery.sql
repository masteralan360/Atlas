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
