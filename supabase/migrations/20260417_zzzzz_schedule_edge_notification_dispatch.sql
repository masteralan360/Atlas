CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
-- Supabase Vault is accessed via the `vault` schema and dashboard/SQL helpers.
-- Do not attempt `CREATE EXTENSION vault` here; hosted projects expose it separately.

DROP FUNCTION IF EXISTS public.request_dispatch_notifications();
DROP FUNCTION IF EXISTS public.get_pending_push_notification_targets(integer);

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


REVOKE ALL ON FUNCTION public.request_dispatch_notifications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_dispatch_notifications(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_pending_push_notification_targets(
  p_limit integer DEFAULT 100,
  p_workspace_id uuid DEFAULT NULL
)
RETURNS TABLE(
  notification_id uuid,
  workspace_id uuid,
  user_id uuid,
  notification_type text,
  title text,
  body text,
  action_url text,
  payload jsonb,
  created_at timestamptz,
  token_id uuid,
  device_token text,
  platform text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
  WITH pending_notifications AS (
    SELECT
      n.id,
      n.workspace_id,
      n.user_id,
      n.notification_type,
      n.title,
      n.body,
      n.action_url,
      n.payload,
      n.created_at
    FROM notifications.inbox n
    WHERE n.push_status = 'pending'
      AND n.archived_at IS NULL
      AND (p_workspace_id IS NULL OR n.workspace_id = p_workspace_id)
    ORDER BY n.created_at ASC, n.id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  )
  SELECT
    pn.id,
    pn.workspace_id,
    pn.user_id,
    pn.notification_type,
    pn.title,
    pn.body,
    pn.action_url,
    pn.payload,
    pn.created_at,
    dt.id,
    dt.device_token,
    dt.platform
  FROM pending_notifications pn
  LEFT JOIN notifications.device_tokens dt
    ON dt.user_id = pn.user_id
   AND dt.workspace_id = pn.workspace_id
  ORDER BY pn.created_at ASC, pn.id ASC, dt.updated_at DESC NULLS LAST, dt.id ASC;
$function$;


REVOKE ALL ON FUNCTION public.get_pending_push_notification_targets(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pending_push_notification_targets(integer, uuid) TO service_role;

DO $do$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'detect-and-dispatch-notifications'
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;
END;
$do$;

SELECT cron.schedule(
  'detect-and-dispatch-notifications',
  '*/5 * * * *',
  $$SELECT public.request_dispatch_notifications(NULL);$$
);
