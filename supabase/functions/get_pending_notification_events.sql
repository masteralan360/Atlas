DROP FUNCTION IF EXISTS public.get_pending_notification_events();

CREATE OR REPLACE FUNCTION public.get_pending_notification_events()
 RETURNS TABLE(id uuid, workspace_id uuid, user_id uuid, status text, entity_type text, entity_id text, attempt_count integer, payload jsonb, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'notifications', 'public'
AS $function$
BEGIN
    RETURN QUERY
    SELECT e.id, e.workspace_id, e.user_id, e.status::TEXT, e.entity_type::TEXT, e.entity_id, e.attempt_count, e.payload, e.created_at
    FROM notifications.events e
    WHERE e.status = 'pending'
    ORDER BY e.created_at ASC
    LIMIT 100;
END;
$function$
