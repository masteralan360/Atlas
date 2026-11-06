CREATE INDEX IF NOT EXISTS idx_notifications_inbox_workspace_user_state_counts
  ON notifications.inbox (workspace_id, user_id)
  INCLUDE (archived_at, read_at);

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_workspace_user_active_page
  ON notifications.inbox (workspace_id, user_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_workspace_user_unread_page
  ON notifications.inbox (workspace_id, user_id, created_at DESC, id DESC)
  WHERE archived_at IS NULL AND read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_workspace_user_archived_page
  ON notifications.inbox (workspace_id, user_id, created_at DESC, id DESC)
  WHERE archived_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.list_notifications_inbox_page(
  p_tab text DEFAULT 'all',
  p_limit integer DEFAULT 10,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, notifications
AS $function$
DECLARE
  v_tab text := lower(btrim(coalesce(p_tab, 'all')));
  v_user_id uuid := auth.uid();
  v_workspace_id uuid := public.current_workspace_id();
  v_total_count bigint := 0;
  v_active_count bigint := 0;
  v_unread_count bigint := 0;
  v_archived_count bigint := 0;
  v_items jsonb := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL OR v_workspace_id IS NULL THEN
    RETURN jsonb_build_object(
      'items', v_items,
      'totalCount', v_total_count,
      'activeCount', v_active_count,
      'unreadCount', v_unread_count,
      'archivedCount', v_archived_count
    );
  END IF;

  IF v_tab NOT IN ('all', 'unread', 'archived') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid notification inbox tab';
  END IF;

  SELECT
    count(*) FILTER (WHERE n.archived_at IS NULL),
    count(*) FILTER (WHERE n.archived_at IS NULL AND n.read_at IS NULL),
    count(*) FILTER (WHERE n.archived_at IS NOT NULL)
  INTO v_active_count, v_unread_count, v_archived_count
  FROM notifications.inbox n
  WHERE n.user_id = v_user_id
    AND n.workspace_id = v_workspace_id;

  v_total_count := CASE v_tab
    WHEN 'unread' THEN v_unread_count
    WHEN 'archived' THEN v_archived_count
    ELSE v_active_count
  END;

  IF v_tab = 'all' THEN
    SELECT coalesce(
      jsonb_agg(to_jsonb(page_row) ORDER BY page_row.created_at DESC, page_row.id DESC),
      '[]'::jsonb
    )
    INTO v_items
    FROM (
      SELECT
        n.id, n.event_id, n.workspace_id, n.user_id, n.notification_type,
        n.scope, n.priority, n.dedupe_key, n.title, n.body, n.action_url,
        n.action_label, n.payload, n.read_at, n.archived_at, n.created_at, n.updated_at
      FROM notifications.inbox n
      WHERE n.user_id = v_user_id
        AND n.workspace_id = v_workspace_id
        AND n.archived_at IS NULL
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT LEAST(GREATEST(coalesce(p_limit, 10), 1), 100)
      OFFSET GREATEST(coalesce(p_offset, 0), 0)
    ) AS page_row;
  ELSIF v_tab = 'unread' THEN
    SELECT coalesce(
      jsonb_agg(to_jsonb(page_row) ORDER BY page_row.created_at DESC, page_row.id DESC),
      '[]'::jsonb
    )
    INTO v_items
    FROM (
      SELECT
        n.id, n.event_id, n.workspace_id, n.user_id, n.notification_type,
        n.scope, n.priority, n.dedupe_key, n.title, n.body, n.action_url,
        n.action_label, n.payload, n.read_at, n.archived_at, n.created_at, n.updated_at
      FROM notifications.inbox n
      WHERE n.user_id = v_user_id
        AND n.workspace_id = v_workspace_id
        AND n.archived_at IS NULL
        AND n.read_at IS NULL
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT LEAST(GREATEST(coalesce(p_limit, 10), 1), 100)
      OFFSET GREATEST(coalesce(p_offset, 0), 0)
    ) AS page_row;
  ELSE
    SELECT coalesce(
      jsonb_agg(to_jsonb(page_row) ORDER BY page_row.created_at DESC, page_row.id DESC),
      '[]'::jsonb
    )
    INTO v_items
    FROM (
      SELECT
        n.id, n.event_id, n.workspace_id, n.user_id, n.notification_type,
        n.scope, n.priority, n.dedupe_key, n.title, n.body, n.action_url,
        n.action_label, n.payload, n.read_at, n.archived_at, n.created_at, n.updated_at
      FROM notifications.inbox n
      WHERE n.user_id = v_user_id
        AND n.workspace_id = v_workspace_id
        AND n.archived_at IS NOT NULL
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT LEAST(GREATEST(coalesce(p_limit, 10), 1), 100)
      OFFSET GREATEST(coalesce(p_offset, 0), 0)
    ) AS page_row;
  END IF;

  RETURN jsonb_build_object(
    'items', v_items,
    'totalCount', v_total_count,
    'activeCount', v_active_count,
    'unreadCount', v_unread_count,
    'archivedCount', v_archived_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_notifications_inbox_page(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_notifications_inbox_page(text, integer, integer) TO authenticated, service_role;
