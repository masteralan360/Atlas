CREATE OR REPLACE FUNCTION public.list_beauty3_appointment_reminders_page(
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_start_at timestamptz DEFAULT NULL,
  p_end_before timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, notifications
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_workspace_id uuid := public.current_workspace_id();
  v_total_count bigint := 0;
  v_items jsonb := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL OR v_workspace_id IS NULL THEN
    RETURN jsonb_build_object('items', v_items, 'totalCount', v_total_count);
  END IF;

  SELECT count(*)
  INTO v_total_count
  FROM notifications.inbox n
  WHERE n.user_id = v_user_id
    AND n.workspace_id = v_workspace_id
    AND n.notification_type = 'beauty3_appointment_reminder'
    AND (p_start_at IS NULL OR n.created_at >= p_start_at)
    AND (p_end_before IS NULL OR n.created_at < p_end_before);

  SELECT coalesce(
    jsonb_agg(to_jsonb(page_row) ORDER BY page_row.created_at DESC, page_row.id DESC),
    '[]'::jsonb
  )
  INTO v_items
  FROM (
    SELECT
      n.id, n.event_id, n.workspace_id, n.user_id, n.notification_type,
      n.scope, n.priority, n.dedupe_key, n.title, n.body, n.action_url,
      n.action_label, n.payload, n.read_at, n.archived_at, n.created_at, n.updated_at,
      appointment.name AS client_name,
      appointment.phone_number AS client_phone
    FROM notifications.inbox n
    LEFT JOIN clinics.beauty3_appointments appointment
      ON appointment.workspace_id = n.workspace_id
     AND appointment.id::text = (n.payload ->> 'appointment_id')
    WHERE n.user_id = v_user_id
      AND n.workspace_id = v_workspace_id
      AND n.notification_type = 'beauty3_appointment_reminder'
      AND (p_start_at IS NULL OR n.created_at >= p_start_at)
      AND (p_end_before IS NULL OR n.created_at < p_end_before)
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT LEAST(GREATEST(coalesce(p_limit, 20), 1), 100)
    OFFSET GREATEST(coalesce(p_offset, 0), 0)
  ) AS page_row;

  RETURN jsonb_build_object('items', v_items, 'totalCount', v_total_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.list_beauty3_appointment_reminders_page(integer, integer, timestamptz, timestamptz)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_beauty3_appointment_reminders_page(integer, integer, timestamptz, timestamptz)
  TO authenticated, service_role;
