CREATE SCHEMA IF NOT EXISTS notifications;

REVOKE ALL ON SCHEMA notifications FROM anon;
GRANT USAGE ON SCHEMA notifications TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS notifications.inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NULL UNIQUE REFERENCES notifications.events(id) ON DELETE SET NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  notification_type text NOT NULL,
  scope text NOT NULL DEFAULT 'user',
  priority text NOT NULL DEFAULT 'normal',
  dedupe_key text NULL,
  title text NOT NULL,
  body text NULL,
  action_url text NULL,
  action_label text NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  push_status text NOT NULL DEFAULT 'pending',
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

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_user_created_at
  ON notifications.inbox (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_user_active_created_at
  ON notifications.inbox (user_id, created_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_user_unread_created_at
  ON notifications.inbox (user_id, created_at DESC)
  WHERE archived_at IS NULL
    AND read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_workspace_created_at
  ON notifications.inbox (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_notification_type_created_at
  ON notifications.inbox (notification_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_user_dedupe_key
  ON notifications.inbox (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_push_status_created_at
  ON notifications.inbox (push_status, created_at ASC)
  WHERE archived_at IS NULL;

DROP TRIGGER IF EXISTS set_notifications_inbox_updated_at ON notifications.inbox;
CREATE TRIGGER set_notifications_inbox_updated_at
BEFORE UPDATE ON notifications.inbox
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE notifications.inbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_inbox_select ON notifications.inbox;
CREATE POLICY notifications_inbox_select
  ON notifications.inbox
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND workspace_id = public.current_workspace_id()
  );

REVOKE ALL ON TABLE notifications.inbox FROM anon;
REVOKE ALL ON TABLE notifications.inbox FROM authenticated;
GRANT SELECT ON TABLE notifications.inbox TO authenticated;
GRANT ALL ON TABLE notifications.inbox TO service_role;

DROP FUNCTION IF EXISTS public.get_pending_notification_events();

CREATE OR REPLACE FUNCTION public.get_pending_notification_events()
RETURNS TABLE(
  id uuid,
  workspace_id uuid,
  user_id uuid,
  status text,
  entity_type text,
  entity_id text,
  attempt_count integer,
  payload jsonb,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'notifications', 'public'
AS $function$
BEGIN
    RETURN QUERY
    SELECT
      e.id,
      e.workspace_id,
      e.user_id,
      e.status::TEXT,
      e.entity_type::TEXT,
      e.entity_id,
      e.attempt_count,
      e.payload,
      e.created_at
    FROM notifications.events e
    WHERE e.status = 'pending'
    ORDER BY e.created_at ASC
    LIMIT 100;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_pending_notification_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pending_notification_events() TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_notification_inbox(p_event_id uuid, p_workspace_id uuid, p_user_id uuid, p_notification_type text, p_scope text DEFAULT 'user'::text, p_priority text DEFAULT 'normal'::text, p_dedupe_key text DEFAULT NULL::text, p_title text DEFAULT ''::text, p_body text DEFAULT NULL::text, p_action_url text DEFAULT NULL::text, p_action_label text DEFAULT NULL::text, p_payload jsonb DEFAULT '{}'::jsonb, p_created_at timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, notifications
AS $function$
DECLARE
  v_notification_id uuid;
BEGIN
  INSERT INTO notifications.inbox (
    event_id,
    workspace_id,
    user_id,
    notification_type,
    scope,
    priority,
    dedupe_key,
    title,
    body,
    action_url,
    action_label,
    payload,
    push_status,
    push_sent_at,
    push_last_attempt_at,
    push_error,
    push_attempt_count,
    created_at
  )
  VALUES (
    p_event_id,
    p_workspace_id,
    p_user_id,
    p_notification_type,
    COALESCE(NULLIF(TRIM(COALESCE(p_scope, '')), ''), 'user'),
    COALESCE(NULLIF(TRIM(COALESCE(p_priority, '')), ''), 'normal'),
    NULLIF(TRIM(COALESCE(p_dedupe_key, '')), ''),
    COALESCE(NULLIF(TRIM(COALESCE(p_title, '')), ''), 'Notification'),
    NULLIF(TRIM(COALESCE(p_body, '')), ''),
    NULLIF(TRIM(COALESCE(p_action_url, '')), ''),
    NULLIF(TRIM(COALESCE(p_action_label, '')), ''),
    COALESCE(p_payload, '{}'::jsonb),
    'pending',
    NULL,
    NULL,
    NULL,
    0,
    COALESCE(p_created_at, now())
  )
  ON CONFLICT (event_id) DO UPDATE
  SET
    workspace_id = EXCLUDED.workspace_id,
    user_id = EXCLUDED.user_id,
    notification_type = EXCLUDED.notification_type,
    scope = EXCLUDED.scope,
    priority = EXCLUDED.priority,
    dedupe_key = COALESCE(EXCLUDED.dedupe_key, notifications.inbox.dedupe_key),
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    action_url = EXCLUDED.action_url,
    action_label = EXCLUDED.action_label,
    payload = EXCLUDED.payload,
    push_status = 'pending',
    push_sent_at = NULL,
    push_last_attempt_at = NULL,
    push_error = NULL,
    push_attempt_count = 0,
    created_at = LEAST(notifications.inbox.created_at, EXCLUDED.created_at),
    updated_at = now()
  RETURNING id INTO v_notification_id;

  RETURN v_notification_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_notification_inbox(uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_notification_inbox(uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.dispatch_notification_events()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_event record;
  v_payload jsonb;
  v_processed integer := 0;
  v_batch_processed integer;
  v_title text;
  v_body text;
  v_action_url text;
  v_action_label text;
  v_scope text;
  v_priority text;
  v_dedupe_key text;
  v_due_date text;
  v_order_id text;
  v_order_number text;
  v_customer_name text;
  v_item_count integer;
  v_amount numeric;
  v_currency text;
BEGIN
  LOOP
    v_batch_processed := 0;

    FOR v_event IN
      SELECT *
      FROM public.get_pending_notification_events()
    LOOP
      BEGIN
        v_payload := COALESCE(v_event.payload, '{}'::jsonb);
        v_due_date := NULLIF(BTRIM(COALESCE(v_payload ->> 'due_date', '')), '');
        v_title := NULLIF(BTRIM(COALESCE(v_payload ->> 'title', '')), '');
        v_body := COALESCE(
          NULLIF(BTRIM(COALESCE(v_payload ->> 'body', '')), ''),
          NULLIF(BTRIM(COALESCE(v_payload ->> 'preview', '')), ''),
          NULLIF(BTRIM(COALESCE(v_payload ->> 'summary', '')), '')
        );
        v_action_url := NULLIF(BTRIM(COALESCE(v_payload ->> 'route', '')), '');
        v_action_label := NULLIF(BTRIM(COALESCE(v_payload ->> 'action_label', '')), '');
        v_scope := NULLIF(BTRIM(COALESCE(v_payload ->> 'scope', '')), '');
        v_priority := NULLIF(BTRIM(COALESCE(v_payload ->> 'priority', '')), '');

        v_scope := CASE
          WHEN v_scope IN ('user', 'workspace', 'system') THEN v_scope
          WHEN v_event.entity_type = 'marketplace_order_pending' THEN 'workspace'
          ELSE 'user'
        END;

        v_priority := CASE
          WHEN v_priority IN ('low', 'normal', 'high', 'urgent') THEN v_priority
          ELSE 'normal'
        END;

        v_dedupe_key := concat_ws(
          ':',
          v_event.user_id::text,
          v_event.entity_type,
          v_event.entity_id,
          COALESCE(v_due_date, to_char(v_event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
        );

        IF v_event.entity_type = 'marketplace_order_pending' THEN
          v_order_id := COALESCE(NULLIF(BTRIM(COALESCE(v_payload ->> 'order_id', '')), ''), v_event.entity_id);
          v_order_number := NULLIF(BTRIM(COALESCE(v_payload ->> 'order_number', '')), '');
          v_customer_name := NULLIF(BTRIM(COALESCE(v_payload ->> 'customer_name', '')), '');

          v_item_count := CASE
            WHEN COALESCE(v_payload ->> 'item_count', '') ~ '^-?\d+$' THEN (v_payload ->> 'item_count')::integer
            ELSE NULL
          END;

          v_amount := CASE
            WHEN COALESCE(v_payload ->> 'amount', '') ~ '^-?\d+(\.\d+)?$' THEN (v_payload ->> 'amount')::numeric
            ELSE NULL
          END;

          v_currency := UPPER(NULLIF(BTRIM(COALESCE(v_payload ->> 'currency', '')), ''));
          v_title := COALESCE(
            v_title,
            CASE
              WHEN v_order_number IS NOT NULL THEN format('Pending marketplace order %s', v_order_number)
              ELSE 'Pending marketplace order'
            END
          );

          IF v_body IS NULL THEN
            v_body := concat_ws(
              ' | ',
              v_customer_name,
              CASE
                WHEN v_item_count IS NOT NULL AND v_item_count > 0
                  THEN format('%s item%s', v_item_count, CASE WHEN v_item_count = 1 THEN '' ELSE 's' END)
                ELSE NULL
              END,
              CASE
                WHEN v_amount IS NOT NULL
                  THEN concat_ws(' ', trim(to_char(v_amount, 'FM999999999990.##')), NULLIF(v_currency, ''))
                ELSE NULL
              END
            );
          END IF;

          v_action_url := COALESCE(v_action_url, CASE WHEN v_order_id IS NOT NULL THEN format('/ecommerce/%s', v_order_id) ELSE '/ecommerce' END);
          v_action_label := COALESCE(v_action_label, 'Open order');
        ELSE
          v_title := COALESCE(
            v_title,
            INITCAP(REPLACE(REPLACE(v_event.entity_type, '_', ' '), '-', ' '))
          );
          v_body := COALESCE(
            v_body,
            NULLIF(BTRIM(COALESCE(v_payload ->> 'content', '')), ''),
            NULLIF(BTRIM(COALESCE(v_payload ->> 'message', '')), '')
          );
        END IF;

        PERFORM public.upsert_notification_inbox(
          p_event_id => v_event.id,
          p_workspace_id => v_event.workspace_id,
          p_user_id => v_event.user_id,
          p_notification_type => v_event.entity_type,
          p_scope => v_scope,
          p_priority => v_priority,
          p_dedupe_key => v_dedupe_key,
          p_title => v_title,
          p_body => v_body,
          p_action_url => v_action_url,
          p_action_label => v_action_label,
          p_payload => v_payload,
          p_created_at => v_event.created_at
        );

        PERFORM public.update_notification_event_status(
          v_event.id,
          'sent'::text,
          NULL::text,
          NULL::integer
        );
      EXCEPTION
        WHEN OTHERS THEN
          PERFORM public.update_notification_event_status(
            v_event.id,
            'failed'::text,
            SQLERRM::text,
            NULL::integer
          );
      END;

      v_processed := v_processed + 1;
      v_batch_processed := v_batch_processed + 1;
    END LOOP;

    EXIT WHEN v_batch_processed = 0;
  END LOOP;

  RETURN v_processed;
END;
$function$;


REVOKE ALL ON FUNCTION public.dispatch_notification_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_notification_events() TO service_role;

CREATE OR REPLACE FUNCTION public.list_notifications_inbox(p_limit integer DEFAULT 200)
RETURNS TABLE(
  id uuid,
  event_id uuid,
  workspace_id uuid,
  user_id uuid,
  notification_type text,
  scope text,
  priority text,
  dedupe_key text,
  title text,
  body text,
  action_url text,
  action_label text,
  payload jsonb,
  read_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
  SELECT
    n.id,
    n.event_id,
    n.workspace_id,
    n.user_id,
    n.notification_type,
    n.scope,
    n.priority,
    n.dedupe_key,
    n.title,
    n.body,
    n.action_url,
    n.action_label,
    n.payload,
    n.read_at,
    n.archived_at,
    n.created_at,
    n.updated_at
  FROM notifications.inbox n
  WHERE n.user_id = auth.uid()
    AND n.workspace_id = public.current_workspace_id()
  ORDER BY n.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$function$;

REVOKE ALL ON FUNCTION public.list_notifications_inbox(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_notifications_inbox(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_notification_inbox_read(
  p_notification_id uuid,
  p_read boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
BEGIN
  UPDATE notifications.inbox
  SET read_at = CASE
      WHEN COALESCE(p_read, true) THEN COALESCE(read_at, now())
      ELSE NULL
    END,
    updated_at = now()
  WHERE id = p_notification_id
    AND user_id = auth.uid()
    AND workspace_id = public.current_workspace_id();

  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_notification_inbox_read(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notification_inbox_read(uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_notification_inbox_archived(
  p_notification_id uuid,
  p_archived boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
BEGIN
  UPDATE notifications.inbox
  SET archived_at = CASE
      WHEN COALESCE(p_archived, true) THEN COALESCE(archived_at, now())
      ELSE NULL
    END,
    updated_at = now()
  WHERE id = p_notification_id
    AND user_id = auth.uid()
    AND workspace_id = public.current_workspace_id();

  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_notification_inbox_archived(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notification_inbox_archived(uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_inbox_read()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_updated_count integer := 0;
BEGIN
  WITH updated_rows AS (
    UPDATE notifications.inbox
    SET read_at = COALESCE(read_at, now()),
        updated_at = now()
    WHERE user_id = auth.uid()
      AND workspace_id = public.current_workspace_id()
      AND archived_at IS NULL
      AND read_at IS NULL
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated_count
  FROM updated_rows;

  RETURN COALESCE(v_updated_count, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_all_notifications_inbox_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_inbox_read() TO authenticated, service_role;

DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'notifications'
      AND tablename = 'inbox'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE notifications.inbox';
  END IF;
END;
$block$;
