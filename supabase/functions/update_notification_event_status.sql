CREATE OR REPLACE FUNCTION public.update_notification_event_status(p_event_id uuid, p_status text, p_error text DEFAULT NULL::text, p_attempt_count integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'notifications', 'public'
AS $function$
BEGIN
    UPDATE notifications.events
    SET 
        status = p_status,
        last_attempt_at = NOW(),
        attempt_count = COALESCE(p_attempt_count, attempt_count + 1),
        error = p_error,
        updated_at = NOW()
    WHERE id = p_event_id;
END;
$function$
