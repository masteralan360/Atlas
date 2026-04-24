ALTER TABLE notifications.device_tokens
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';

UPDATE notifications.device_tokens
SET language = CASE
  WHEN lower(trim(coalesce(language, ''))) = 'ar' OR lower(trim(coalesce(language, ''))) LIKE 'ar-%' THEN 'ar'
  WHEN lower(trim(coalesce(language, ''))) IN ('ku', 'ckb') OR lower(trim(coalesce(language, ''))) LIKE 'ku-%' OR lower(trim(coalesce(language, ''))) LIKE 'ckb-%' THEN 'ku'
  ELSE 'en'
END;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notifications_device_tokens_language_check'
      AND conrelid = 'notifications.device_tokens'::regclass
  ) THEN
    ALTER TABLE notifications.device_tokens
      DROP CONSTRAINT notifications_device_tokens_language_check;
  END IF;
END $$;

ALTER TABLE notifications.device_tokens
  ADD CONSTRAINT notifications_device_tokens_language_check
  CHECK (language IN ('en', 'ar', 'ku'));

DROP FUNCTION IF EXISTS public.upsert_device_token(uuid, text, text, uuid);
DROP FUNCTION IF EXISTS public.upsert_device_token(uuid, text, text, uuid, text);

CREATE OR REPLACE FUNCTION public.upsert_device_token(
  p_user_id uuid,
  p_platform text,
  p_device_token text,
  p_workspace_id uuid DEFAULT NULL,
  p_language text DEFAULT 'en'
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
  v_language text;
  v_device_token_id uuid;
BEGIN
  v_platform := lower(trim(COALESCE(p_platform, '')));
  v_device_token := trim(COALESCE(p_device_token, ''));
  v_language := lower(trim(COALESCE(p_language, 'en')));

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

  IF v_language = 'ar' OR v_language LIKE 'ar-%' THEN
    v_language := 'ar';
  ELSIF v_language = 'ku' OR v_language = 'ckb' OR v_language LIKE 'ku-%' OR v_language LIKE 'ckb-%' THEN
    v_language := 'ku';
  ELSE
    v_language := 'en';
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
    device_token,
    language
  )
  VALUES (
    p_user_id,
    v_workspace_id,
    v_platform,
    v_device_token,
    v_language
  )
  ON CONFLICT (device_token) DO UPDATE
  SET
    user_id = EXCLUDED.user_id,
    workspace_id = EXCLUDED.workspace_id,
    platform = EXCLUDED.platform,
    language = EXCLUDED.language,
    updated_at = now()
  RETURNING id INTO v_device_token_id;

  RETURN v_device_token_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_device_token(uuid, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_device_token(uuid, text, text, uuid, text) TO service_role;

DROP FUNCTION IF EXISTS public.get_pending_push_notification_targets(integer, uuid);

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
  platform text,
  language text
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
    dt.platform,
    dt.language
  FROM pending_notifications pn
  LEFT JOIN notifications.device_tokens dt
    ON dt.user_id = pn.user_id
   AND dt.workspace_id = pn.workspace_id
  ORDER BY pn.created_at ASC, pn.id ASC, dt.updated_at DESC NULLS LAST, dt.id ASC;
$function$;

REVOKE ALL ON FUNCTION public.get_pending_push_notification_targets(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pending_push_notification_targets(integer, uuid) TO service_role;
