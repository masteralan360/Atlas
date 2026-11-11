CREATE OR REPLACE FUNCTION public.get_beauty3_appointment_reminder_notification(
  p_notification_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, notifications
AS $function$
  SELECT to_jsonb(n) || jsonb_build_object(
    'client_name', appointment.name,
    'client_phone', appointment.phone_number
  )
  FROM notifications.inbox AS n
  LEFT JOIN clinics.beauty3_appointments AS appointment
    ON appointment.workspace_id = n.workspace_id
   AND appointment.id::text = (n.payload ->> 'appointment_id')
  WHERE n.id = p_notification_id
    AND n.user_id = auth.uid()
    AND n.workspace_id = public.current_workspace_id()
    AND n.notification_type = 'beauty3_appointment_reminder'
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.get_beauty3_appointment_reminder_notification(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_beauty3_appointment_reminder_notification(uuid)
  TO authenticated, service_role;
