CREATE TABLE IF NOT EXISTS notifications.device_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'android'::text,
  device_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

ALTER TABLE notifications.device_tokens
  ALTER COLUMN platform SET DEFAULT 'android'::text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'notifications_device_tokens_platform_check'
      AND conrelid = 'notifications.device_tokens'::regclass
  ) THEN
    ALTER TABLE notifications.device_tokens
      ADD CONSTRAINT notifications_device_tokens_platform_check
      CHECK (platform IN ('android', 'web'));
  END IF;
END $$;

WITH ranked_tokens AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY device_token
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS row_number
  FROM notifications.device_tokens
)
DELETE FROM notifications.device_tokens d
USING ranked_tokens r
WHERE d.id = r.id
  AND r.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_notifications_device_tokens_token
  ON notifications.device_tokens (device_token);

CREATE INDEX IF NOT EXISTS idx_notifications_device_tokens_user_updated_at
  ON notifications.device_tokens (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_device_tokens_workspace_updated_at
  ON notifications.device_tokens (workspace_id, updated_at DESC);

DROP TRIGGER IF EXISTS set_notifications_device_tokens_updated_at ON notifications.device_tokens;
CREATE TRIGGER set_notifications_device_tokens_updated_at
BEFORE UPDATE ON notifications.device_tokens
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE notifications.device_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_device_tokens_select ON notifications.device_tokens;
CREATE POLICY notifications_device_tokens_select
  ON notifications.device_tokens
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND workspace_id = public.current_workspace_id()
  );

REVOKE ALL ON TABLE notifications.device_tokens FROM anon;
REVOKE ALL ON TABLE notifications.device_tokens FROM authenticated;
GRANT SELECT ON TABLE notifications.device_tokens TO authenticated;
GRANT ALL ON TABLE notifications.device_tokens TO service_role;

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

REVOKE ALL ON FUNCTION public.upsert_device_token(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_device_token(uuid, text, text, uuid) TO service_role;
