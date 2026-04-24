CREATE TABLE notifications.device_tokens (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'android'::text,
  device_token text NOT NULL,
  language text NOT NULL DEFAULT 'en'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT notifications_device_tokens_platform_check CHECK (platform IN ('android', 'web')),
  CONSTRAINT notifications_device_tokens_language_check CHECK (language IN ('en', 'ar', 'ku'))
);

CREATE UNIQUE INDEX uniq_notifications_device_tokens_token
  ON notifications.device_tokens (device_token);

CREATE INDEX idx_notifications_device_tokens_user_updated_at
  ON notifications.device_tokens (user_id, updated_at DESC);

CREATE INDEX idx_notifications_device_tokens_workspace_updated_at
  ON notifications.device_tokens (workspace_id, updated_at DESC);
