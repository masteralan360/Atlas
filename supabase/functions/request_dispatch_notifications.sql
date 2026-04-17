CREATE OR REPLACE FUNCTION public.request_dispatch_notifications(p_target_workspace_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_project_url text;
  v_cron_secret text;
  v_request_id bigint;
BEGIN
  SELECT decrypted_secret
  INTO v_project_url
  FROM vault.decrypted_secrets
  WHERE name = 'project_url';

  SELECT decrypted_secret
  INTO v_cron_secret
  FROM vault.decrypted_secrets
  WHERE name = 'notification_cron_secret';

  IF COALESCE(v_project_url, '') = '' THEN
    RAISE EXCEPTION 'Vault secret project_url is required';
  END IF;

  IF COALESCE(v_cron_secret, '') = '' THEN
    RAISE EXCEPTION 'Vault secret notification_cron_secret is required';
  END IF;

  SELECT net.http_post(
    url := v_project_url || '/functions/v1/dispatch-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', v_cron_secret
    ),
    body := jsonb_build_object('workspace_id', p_target_workspace_id)
  )
  INTO v_request_id;

  RETURN v_request_id;
END;
$function$;
