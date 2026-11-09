ALTER TABLE notifications.workspace_disabled_types
  DROP CONSTRAINT IF EXISTS notifications_workspace_disabled_types_type_check;

ALTER TABLE notifications.workspace_disabled_types
  ADD CONSTRAINT notifications_workspace_disabled_types_type_check CHECK (notification_type IN (
    'marketplace_order_pending',
    'commerce_order_created',
    'order_approval_request',
    'order_approval_approved',
    'loan_installment_overdue',
    'expense_item_overdue',
    'payroll_overdue',
    'inventory_low_stock',
    'garden_job_assigned',
    'garden_job_rescheduled',
    'garden_job_completed',
    'beauty3_appointment_reminder'
  ));

CREATE OR REPLACE FUNCTION public.set_workspace_notification_type_disabled(
  p_notification_type text,
  p_disabled boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_workspace_id uuid := public.current_workspace_id();
  v_notification_type text := NULLIF(BTRIM(COALESCE(p_notification_type, '')), '');
BEGIN
  IF v_workspace_id IS NULL OR public.current_user_role() <> 'admin' THEN
    RAISE EXCEPTION 'notification_settings_admin_required' USING ERRCODE = '42501';
  END IF;

  IF v_notification_type NOT IN (
    'marketplace_order_pending',
    'commerce_order_created',
    'order_approval_request',
    'order_approval_approved',
    'loan_installment_overdue',
    'expense_item_overdue',
    'payroll_overdue',
    'inventory_low_stock',
    'garden_job_assigned',
    'garden_job_rescheduled',
    'garden_job_completed',
    'beauty3_appointment_reminder'
  ) THEN
    RAISE EXCEPTION 'unsupported_notification_type' USING ERRCODE = '22023';
  END IF;

  IF COALESCE(p_disabled, true) THEN
    INSERT INTO notifications.workspace_disabled_types (workspace_id, notification_type, disabled_by)
    VALUES (v_workspace_id, v_notification_type, auth.uid())
    ON CONFLICT (workspace_id, notification_type) DO UPDATE
      SET disabled_by = EXCLUDED.disabled_by, updated_at = now();
  ELSE
    DELETE FROM notifications.workspace_disabled_types
    WHERE workspace_id = v_workspace_id
      AND notification_type = v_notification_type;
  END IF;

  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.queue_beauty3_appointment_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, notifications, clinics
AS $function$
DECLARE
  v_local_date date := (now() AT TIME ZONE 'Asia/Baghdad')::date;
  v_appointment record;
  v_queued integer := 0;
BEGIN
  FOR v_appointment IN
    SELECT
      appointment.workspace_id,
      appointment.id,
      appointment.procedure_date,
      recipient.id AS user_id
    FROM clinics.beauty3_appointments AS appointment
    JOIN public.profiles AS recipient
      ON recipient.id = appointment.created_by
     AND recipient.workspace_id = appointment.workspace_id
    WHERE appointment.is_deleted = false
      AND appointment.procedure_place = 'sulaymaniyah'
      AND appointment.procedure_date = v_local_date + 3
      AND NOT EXISTS (
        SELECT 1
        FROM notifications.workspace_disabled_types AS disabled_type
        WHERE disabled_type.workspace_id = appointment.workspace_id
          AND disabled_type.notification_type = 'beauty3_appointment_reminder'
      )
  LOOP
    PERFORM public.upsert_notification_event(
      v_appointment.workspace_id,
      v_appointment.user_id,
      'beauty3_appointment_reminder',
      v_appointment.id::text,
      v_appointment.procedure_date,
      jsonb_build_object(
        'entity_type', 'beauty3_appointment_reminder',
        'appointment_id', v_appointment.id,
        'procedure_date', v_appointment.procedure_date::text,
        'due_date', v_appointment.procedure_date::text,
        'title', 'Upcoming Appointment Reminder',
        'body', format(
          'Your appointment in Sulaymaniyah is coming up in 3 days. Your procedure is scheduled for %s.',
          to_char(v_appointment.procedure_date, 'YYYY-MM-DD')
        ),
        'route', format('/clinical-appointments/%s/edit', v_appointment.id),
        'action_label', 'Open appointments',
        'scope', 'user',
        'priority', 'normal'
      )
    );

    v_queued := v_queued + 1;
  END LOOP;

  RETURN v_queued;
END;
$function$;

REVOKE ALL ON FUNCTION public.queue_beauty3_appointment_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_beauty3_appointment_reminders() TO service_role;

DO $do$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'queue-beauty3-appointment-reminders'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END;
$do$;

SELECT cron.schedule(
  'queue-beauty3-appointment-reminders',
  '*/5 * * * *',
  $$SELECT public.queue_beauty3_appointment_reminders();$$
);
