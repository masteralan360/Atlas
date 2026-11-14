ALTER TABLE notifications.inbox
  ADD COLUMN IF NOT EXISTS organization_id uuid;

ALTER TABLE notifications.inbox
  DROP CONSTRAINT IF EXISTS notifications_inbox_scope_check;

ALTER TABLE notifications.inbox
  ADD CONSTRAINT notifications_inbox_scope_check
  CHECK (scope IN ('user', 'workspace', 'system', 'organization'));

ALTER TABLE notifications.inbox
  ADD CONSTRAINT notifications_inbox_organization_scope_check
  CHECK (
    (scope = 'organization' AND organization_id IS NOT NULL)
    OR (scope <> 'organization' AND organization_id IS NULL)
  );

ALTER TABLE notifications.inbox
  ADD CONSTRAINT notifications_inbox_organization_workspace_fkey
  FOREIGN KEY (workspace_id, organization_id)
  REFERENCES public.postal_organizations (workspace_id, id);

CREATE INDEX IF NOT EXISTS idx_notifications_inbox_organization_page
  ON notifications.inbox (workspace_id, organization_id, user_id, created_at DESC, id DESC)
  WHERE scope = 'organization';

CREATE OR REPLACE FUNCTION postal_private.is_merchant_staff(
  p_workspace_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles AS profile
    JOIN public.workspace_permissions AS permission
      ON permission.workspace_id = profile.workspace_id
     AND permission.user_uuid = profile.id
     AND permission.key = 'postService.merchant'
    WHERE profile.id = p_user_id
      AND profile.workspace_id = p_workspace_id
      AND profile.role = 'staff'
      AND (
        auth.uid() IS NULL
        OR (p_user_id = auth.uid() AND p_workspace_id = public.current_workspace_id())
      )
  );
$function$;

CREATE OR REPLACE FUNCTION postal_private.notification_organization_access(
  p_workspace_id uuid,
  p_user_id uuid,
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p_organization_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.postal_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.user_id = p_user_id
      AND membership.organization_id = p_organization_id
      AND (
        auth.uid() IS NULL
        OR (p_user_id = auth.uid() AND p_workspace_id = public.current_workspace_id())
      )
  );
$function$;

REVOKE ALL ON FUNCTION postal_private.is_merchant_staff(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION postal_private.is_merchant_staff(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION postal_private.notification_organization_access(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION postal_private.notification_organization_access(uuid, uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.upsert_notification_inbox(
  p_event_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_notification_type text,
  p_scope text DEFAULT 'user'::text,
  p_priority text DEFAULT 'normal'::text,
  p_dedupe_key text DEFAULT NULL::text,
  p_title text DEFAULT ''::text,
  p_body text DEFAULT NULL::text,
  p_action_url text DEFAULT NULL::text,
  p_action_label text DEFAULT NULL::text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_created_at timestamp with time zone DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications, postal_private
AS $function$
DECLARE
  v_notification_id uuid;
  v_scope text := COALESCE(NULLIF(BTRIM(COALESCE(p_scope, '')), ''), 'user');
  v_organization_id uuid;
  v_organization_id_text text;
  v_organization_name text;
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_is_merchant boolean := postal_private.is_merchant_staff(p_workspace_id, p_user_id);
  v_push_status text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM notifications.workspace_disabled_types AS disabled_type
    WHERE disabled_type.workspace_id = p_workspace_id
      AND disabled_type.notification_type = p_notification_type
  ) THEN
    RETURN NULL;
  END IF;

  IF v_scope NOT IN ('user', 'workspace', 'system', 'organization') THEN
    RETURN NULL;
  END IF;

  -- Merchant staff never receive broad workspace or system inbox items.
  IF v_is_merchant AND v_scope NOT IN ('user', 'organization') THEN
    RETURN NULL;
  END IF;

  IF v_scope = 'organization' THEN
    v_organization_id_text := NULLIF(BTRIM(COALESCE(v_payload ->> 'organization_id', '')), '');
    IF v_organization_id_text IS NULL
      OR v_organization_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RETURN NULL;
    END IF;

    v_organization_id := v_organization_id_text::uuid;
    IF NOT postal_private.notification_organization_access(
      p_workspace_id,
      p_user_id,
      v_organization_id
    ) THEN
      RETURN NULL;
    END IF;

    SELECT organization.name
    INTO v_organization_name
    FROM public.postal_organizations AS organization
    WHERE organization.workspace_id = p_workspace_id
      AND organization.id = v_organization_id;

    IF v_organization_name IS NULL THEN
      RETURN NULL;
    END IF;
    v_payload := v_payload || jsonb_build_object('organization_name', v_organization_name);
  END IF;

  -- Organization notifications are inbox-only in V1. Merchant workspace notices are
  -- discarded above, and organization notifications must not reach push delivery.
  v_push_status := CASE WHEN v_scope = 'organization' THEN 'skipped' ELSE 'pending' END;

  INSERT INTO notifications.inbox (
    event_id,
    workspace_id,
    user_id,
    notification_type,
    scope,
    organization_id,
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
    v_scope,
    v_organization_id,
    COALESCE(NULLIF(BTRIM(COALESCE(p_priority, '')), ''), 'normal'),
    NULLIF(BTRIM(COALESCE(p_dedupe_key, '')), ''),
    COALESCE(NULLIF(BTRIM(COALESCE(p_title, '')), ''), 'Notification'),
    NULLIF(BTRIM(COALESCE(p_body, '')), ''),
    NULLIF(BTRIM(COALESCE(p_action_url, '')), ''),
    NULLIF(BTRIM(COALESCE(p_action_label, '')), ''),
    v_payload,
    v_push_status,
    NULL,
    CASE WHEN v_push_status = 'skipped' THEN now() ELSE NULL END,
    CASE WHEN v_push_status = 'skipped' THEN 'Organization notifications are inbox-only in V1' ELSE NULL END,
    0,
    COALESCE(p_created_at, now())
  )
  ON CONFLICT (event_id) DO UPDATE
  SET
    workspace_id = EXCLUDED.workspace_id,
    user_id = EXCLUDED.user_id,
    notification_type = EXCLUDED.notification_type,
    scope = EXCLUDED.scope,
    organization_id = EXCLUDED.organization_id,
    priority = EXCLUDED.priority,
    dedupe_key = COALESCE(EXCLUDED.dedupe_key, notifications.inbox.dedupe_key),
    title = EXCLUDED.title,
    body = EXCLUDED.body,
    action_url = EXCLUDED.action_url,
    action_label = EXCLUDED.action_label,
    payload = EXCLUDED.payload,
    push_status = EXCLUDED.push_status,
    push_sent_at = NULL,
    push_last_attempt_at = CASE WHEN EXCLUDED.push_status = 'skipped' THEN now() ELSE NULL END,
    push_error = CASE
      WHEN EXCLUDED.push_status = 'skipped' THEN 'Organization notifications are inbox-only in V1'
      ELSE NULL
    END,
    push_attempt_count = 0,
    created_at = LEAST(notifications.inbox.created_at, EXCLUDED.created_at),
    updated_at = now()
  RETURNING id INTO v_notification_id;

  RETURN v_notification_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_notification_inbox(uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_notification_inbox(uuid, uuid, uuid, text, text, text, text, text, text, text, text, jsonb, timestamptz) TO service_role;

DO $migration$
DECLARE
  v_definition text;
  v_page_replacements integer;
BEGIN
  v_definition := pg_get_functiondef('public.dispatch_notification_events()'::regprocedure);
  IF position('WHEN v_scope IN (''user'', ''workspace'', ''system'') THEN v_scope' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate notification scope normalization';
  END IF;
  v_definition := replace(
    v_definition,
    'WHEN v_scope IN (''user'', ''workspace'', ''system'') THEN v_scope',
    'WHEN v_scope IN (''user'', ''workspace'', ''system'', ''organization'') THEN v_scope'
  );
  EXECUTE v_definition;

  v_definition := pg_get_functiondef('public.list_notifications_inbox_page(text, integer, integer)'::regprocedure);
  v_page_replacements := (length(v_definition) - length(replace(v_definition, 'n.scope, n.priority', ''))) / length('n.scope, n.priority');
  IF v_page_replacements <> 3 THEN
    RAISE EXCEPTION 'Expected three notification page projections with scope';
  END IF;
  v_definition := replace(v_definition, 'n.scope, n.priority', 'n.scope, n.organization_id, n.priority');
  EXECUTE v_definition;
END;
$migration$;

-- Let row-level security apply the merchant-specific filter to list RPCs and realtime rows.
ALTER FUNCTION public.list_notifications_inbox_page(text, integer, integer) SECURITY INVOKER;
ALTER FUNCTION public.list_notifications_inbox(integer) SECURITY INVOKER;

DROP POLICY IF EXISTS notifications_inbox_select ON notifications.inbox;
CREATE POLICY notifications_inbox_select
  ON notifications.inbox
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND workspace_id = public.current_workspace_id()
    AND (
      NOT postal_private.is_merchant_staff(workspace_id, user_id)
      OR scope = 'user'
      OR (
        scope = 'organization'
        AND postal_private.notification_organization_access(workspace_id, user_id, organization_id)
      )
    )
  );

CREATE OR REPLACE FUNCTION public.mark_notification_inbox_read(
  p_notification_id uuid,
  p_read boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications, postal_private
AS $function$
BEGIN
  UPDATE notifications.inbox AS notification
  SET read_at = CASE
      WHEN COALESCE(p_read, true) THEN COALESCE(notification.read_at, now())
      ELSE NULL
    END,
    updated_at = now()
  WHERE notification.id = p_notification_id
    AND notification.user_id = auth.uid()
    AND notification.workspace_id = public.current_workspace_id()
    AND (
      NOT postal_private.is_merchant_staff(notification.workspace_id, notification.user_id)
      OR notification.scope = 'user'
      OR (
        notification.scope = 'organization'
        AND postal_private.notification_organization_access(
          notification.workspace_id,
          notification.user_id,
          notification.organization_id
        )
      )
    );

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_notification_inbox_archived(
  p_notification_id uuid,
  p_archived boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications, postal_private
AS $function$
BEGIN
  UPDATE notifications.inbox AS notification
  SET archived_at = CASE
      WHEN COALESCE(p_archived, true) THEN COALESCE(notification.archived_at, now())
      ELSE NULL
    END,
    updated_at = now()
  WHERE notification.id = p_notification_id
    AND notification.user_id = auth.uid()
    AND notification.workspace_id = public.current_workspace_id()
    AND (
      NOT postal_private.is_merchant_staff(notification.workspace_id, notification.user_id)
      OR notification.scope = 'user'
      OR (
        notification.scope = 'organization'
        AND postal_private.notification_organization_access(
          notification.workspace_id,
          notification.user_id,
          notification.organization_id
        )
      )
    );

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_inbox_read()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, notifications, postal_private
AS $function$
DECLARE
  v_updated_count integer := 0;
BEGIN
  WITH updated_rows AS (
    UPDATE notifications.inbox AS notification
    SET read_at = COALESCE(notification.read_at, now()),
        updated_at = now()
    WHERE notification.user_id = auth.uid()
      AND notification.workspace_id = public.current_workspace_id()
      AND notification.archived_at IS NULL
      AND notification.read_at IS NULL
      AND (
        NOT postal_private.is_merchant_staff(notification.workspace_id, notification.user_id)
        OR notification.scope = 'user'
        OR (
          notification.scope = 'organization'
          AND postal_private.notification_organization_access(
            notification.workspace_id,
            notification.user_id,
            notification.organization_id
          )
        )
      )
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated_count
  FROM updated_rows;

  RETURN COALESCE(v_updated_count, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.mark_notification_inbox_read(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notification_inbox_read(uuid, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_notification_inbox_archived(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_notification_inbox_archived(uuid, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_all_notifications_inbox_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_inbox_read() TO authenticated, service_role;

UPDATE notifications.inbox AS notification
SET push_status = 'skipped',
    push_last_attempt_at = now(),
    push_error = 'Notification scope is not enabled for this recipient'
WHERE notification.push_status = 'pending'
  AND (
    notification.scope = 'organization'
    OR (
      postal_private.is_merchant_staff(notification.workspace_id, notification.user_id)
      AND notification.scope <> 'user'
    )
  );

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
SET search_path = public, notifications, postal_private
AS $function$
  WITH pending_notifications AS (
    SELECT
      notification.id,
      notification.workspace_id,
      notification.user_id,
      notification.notification_type,
      notification.title,
      notification.body,
      notification.action_url,
      notification.payload,
      notification.created_at
    FROM notifications.inbox AS notification
    WHERE notification.push_status = 'pending'
      AND notification.archived_at IS NULL
      AND notification.scope <> 'organization'
      AND (
        NOT postal_private.is_merchant_staff(notification.workspace_id, notification.user_id)
        OR notification.scope = 'user'
      )
      AND (p_workspace_id IS NULL OR notification.workspace_id = p_workspace_id)
    ORDER BY notification.created_at ASC, notification.id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  )
  SELECT
    pending.id,
    pending.workspace_id,
    pending.user_id,
    pending.notification_type,
    pending.title,
    pending.body,
    pending.action_url,
    pending.payload,
    pending.created_at,
    device.id,
    device.device_token,
    device.platform,
    device.language
  FROM pending_notifications AS pending
  LEFT JOIN notifications.device_tokens AS device
    ON device.user_id = pending.user_id
   AND device.workspace_id = pending.workspace_id
  ORDER BY pending.created_at ASC, pending.id ASC, device.updated_at DESC NULLS LAST, device.id ASC;
$function$;

REVOKE ALL ON FUNCTION public.get_pending_push_notification_targets(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pending_push_notification_targets(integer, uuid) TO service_role;
