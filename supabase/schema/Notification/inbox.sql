CREATE TABLE notifications.inbox (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NULL UNIQUE REFERENCES notifications.events(id) ON DELETE SET NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  notification_type text NOT NULL,
  scope text NOT NULL DEFAULT 'user'::text,
  priority text NOT NULL DEFAULT 'normal'::text,
  dedupe_key text NULL,
  title text NOT NULL,
  body text NULL,
  action_url text NULL,
  action_label text NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  push_status text NOT NULL DEFAULT 'pending'::text,
  push_sent_at timestamptz NULL,
  push_last_attempt_at timestamptz NULL,
  push_error text NULL,
  push_attempt_count integer NOT NULL DEFAULT 0,
  read_at timestamptz NULL,
  archived_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_inbox_scope_check CHECK (scope IN ('user', 'workspace', 'system')),
  CONSTRAINT notifications_inbox_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT notifications_inbox_push_status_check CHECK (push_status IN ('pending', 'sent', 'failed', 'skipped'))
);

CREATE INDEX idx_notifications_inbox_user_created_at
  ON notifications.inbox (user_id, created_at DESC);

CREATE INDEX idx_notifications_inbox_user_active_created_at
  ON notifications.inbox (user_id, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX idx_notifications_inbox_user_unread_created_at
  ON notifications.inbox (user_id, created_at DESC)
  WHERE archived_at IS NULL
    AND read_at IS NULL;

CREATE INDEX idx_notifications_inbox_workspace_created_at
  ON notifications.inbox (workspace_id, created_at DESC);

CREATE INDEX idx_notifications_inbox_notification_type_created_at
  ON notifications.inbox (notification_type, created_at DESC);

CREATE INDEX idx_notifications_inbox_user_dedupe_key
  ON notifications.inbox (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX idx_notifications_inbox_push_status_created_at
  ON notifications.inbox (push_status, created_at ASC)
  WHERE archived_at IS NULL;
