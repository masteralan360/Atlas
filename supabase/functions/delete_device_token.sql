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
