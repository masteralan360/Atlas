CREATE OR REPLACE FUNCTION public.upsert_device_token(
  p_user_id uuid,
  p_platform text,
  p_device_token text,
  p_workspace_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_workspace_id uuid;
  v_platform text;
  v_device_token text;
  v_device_token_id uuid;
BEGIN
  v_platform := lower(trim(COALESCE(p_platform, '')));
  v_device_token := trim(COALESCE(p_device_token, ''));

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'User id is required';
  END IF;

  IF v_platform NOT IN ('android', 'web') THEN
    RAISE EXCEPTION 'Unsupported platform: %', COALESCE(v_platform, '<null>');
  END IF;

  IF v_device_token = '' THEN
    RAISE EXCEPTION 'Device token is required';
  END IF;

  IF length(v_device_token) > 4096 THEN
    RAISE EXCEPTION 'Device token is too long';
  END IF;

  v_workspace_id := p_workspace_id;
  IF v_workspace_id IS NULL THEN
    SELECT p.workspace_id
    INTO v_workspace_id
    FROM public.profiles p
    WHERE p.id = p_user_id;
  END IF;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Workspace not found for user %', p_user_id;
  END IF;

  INSERT INTO notifications.device_tokens (
    user_id,
    workspace_id,
    platform,
    device_token
  )
  VALUES (
    p_user_id,
    v_workspace_id,
    v_platform,
    v_device_token
  )
  ON CONFLICT (device_token) DO UPDATE
  SET
    user_id = EXCLUDED.user_id,
    workspace_id = EXCLUDED.workspace_id,
    platform = EXCLUDED.platform,
    updated_at = now()
  RETURNING id INTO v_device_token_id;

  RETURN v_device_token_id;
END;
$function$;
