CREATE OR REPLACE FUNCTION public.get_pending_notification_events()
 RETURNS TABLE(id uuid, user_id uuid, status text, entity_type text, entity_id text, attempt_count integer, payload jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'notifications', 'public'
AS $function$
BEGIN
    RETURN QUERY
    SELECT e.id, e.user_id, e.status::TEXT, e.entity_type::TEXT, e.entity_id, e.attempt_count, e.payload
    FROM notifications.events e
    WHERE e.status = 'pending'
    ORDER BY e.created_at ASC
    LIMIT 100;
END;
$function$
