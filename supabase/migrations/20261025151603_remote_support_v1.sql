-- Remote Support V1. Screen content is never written to this schema.
CREATE SCHEMA IF NOT EXISTS support;
REVOKE ALL ON SCHEMA support FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA support TO authenticated, service_role;

CREATE TABLE support.settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO support.settings (singleton, enabled) VALUES (true, false)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE support.operators (
  user_id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE support.client_instances (
  instance_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform = 'windows-tauri'),
  app_version text NOT NULL DEFAULT 'unknown',
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_client_instances_presence_idx
  ON support.client_instances (workspace_id, last_heartbeat_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE support.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  operator_user_id uuid NOT NULL,
  operator_name text NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
  target_scope text NOT NULL DEFAULT 'atlas_window_view_only'
    CHECK (target_scope = 'atlas_window_view_only'),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'approved', 'connecting', 'active', 'declined', 'cancelled',
    'expired', 'failed', 'ended'
  )),
  request_expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  approved_user_id uuid,
  approved_instance_id uuid,
  session_expires_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  terminal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_sessions_workspace_created_idx
  ON support.sessions (workspace_id, created_at DESC);
CREATE INDEX support_sessions_operator_created_idx
  ON support.sessions (operator_user_id, created_at DESC);
CREATE INDEX support_sessions_terminal_retention_idx
  ON support.sessions (ended_at)
  WHERE status IN ('declined', 'cancelled', 'expired', 'failed', 'ended');
CREATE UNIQUE INDEX support_sessions_one_open_per_workspace_idx
  ON support.sessions (workspace_id)
  WHERE status IN ('requested', 'approved', 'connecting', 'active');

CREATE TABLE support.session_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL,
  event_type text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('operator', 'client', 'system')),
  actor_user_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_session_events_chronology_idx
  ON support.session_events (session_id, created_at, id);
CREATE INDEX support_session_events_retention_idx ON support.session_events (created_at);

CREATE OR REPLACE FUNCTION support.terminate_session(p_session_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, support, notifications, realtime
AS $function$
DECLARE
  v_session support.sessions%ROWTYPE;
  v_next_status text;
BEGIN
  SELECT * INTO v_session FROM support.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.status NOT IN ('requested', 'approved', 'connecting', 'active') THEN
    RETURN;
  END IF;
  v_next_status := CASE WHEN v_session.status = 'requested' THEN 'cancelled' ELSE 'ended' END;
  UPDATE support.sessions SET status = v_next_status, ended_at = now(),
    terminal_reason = p_reason, updated_at = now() WHERE id = p_session_id;
  INSERT INTO support.session_events(session_id, event_type, actor_type, metadata)
  VALUES (p_session_id, v_next_status, 'system', jsonb_build_object('reason', p_reason));
  UPDATE notifications.inbox SET
    payload = payload || jsonb_build_object('status', v_next_status, 'terminal_reason', p_reason),
    updated_at = now()
  WHERE workspace_id = v_session.workspace_id
    AND notification_type = 'remote_support_request'
    AND payload ->> 'session_id' = p_session_id::text;
  IF v_session.status <> 'requested' THEN
    PERFORM realtime.send(
      jsonb_build_object('type', 'stop', 'reason', p_reason),
      'signal', 'remote-support:' || p_session_id::text, true
    );
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION support.terminate_session(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION support.stop_sessions_when_disabled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, support
AS $function$
DECLARE v_session_id uuid;
BEGIN
  IF OLD.enabled AND NOT NEW.enabled THEN
    FOR v_session_id IN SELECT id FROM support.sessions
      WHERE status IN ('requested', 'approved', 'connecting', 'active')
    LOOP
      PERFORM support.terminate_session(v_session_id, 'feature_disabled');
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER support_stop_sessions_when_disabled
AFTER UPDATE OF enabled ON support.settings
FOR EACH ROW EXECUTE FUNCTION support.stop_sessions_when_disabled();
REVOKE ALL ON FUNCTION support.stop_sessions_when_disabled() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION support.stop_sessions_for_disabled_operator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, support
AS $function$
DECLARE v_session_id uuid;
BEGIN
  IF OLD.enabled AND NOT NEW.enabled THEN
    FOR v_session_id IN SELECT id FROM support.sessions
      WHERE operator_user_id = NEW.user_id
        AND status IN ('requested', 'approved', 'connecting', 'active')
    LOOP
      PERFORM support.terminate_session(v_session_id, 'operator_disabled');
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER support_stop_sessions_for_disabled_operator
AFTER UPDATE OF enabled ON support.operators
FOR EACH ROW EXECUTE FUNCTION support.stop_sessions_for_disabled_operator();
REVOKE ALL ON FUNCTION support.stop_sessions_for_disabled_operator() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION support.stop_sessions_for_revoked_instance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, support
AS $function$
DECLARE v_session_id uuid;
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    FOR v_session_id IN SELECT id FROM support.sessions
      WHERE approved_instance_id = NEW.instance_id
        AND status IN ('approved', 'connecting', 'active')
    LOOP
      PERFORM support.terminate_session(v_session_id, 'client_instance_revoked');
    END LOOP;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER support_stop_sessions_for_revoked_instance
AFTER UPDATE OF revoked_at ON support.client_instances
FOR EACH ROW EXECUTE FUNCTION support.stop_sessions_for_revoked_instance();
REVOKE ALL ON FUNCTION support.stop_sessions_for_revoked_instance() FROM PUBLIC, anon, authenticated;

ALTER TABLE support.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.client_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support.session_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA support FROM PUBLIC, anon, authenticated;
GRANT SELECT ON support.operators, support.sessions, support.settings TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA support TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA support TO service_role;

CREATE POLICY support_operators_self_read ON support.operators
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()) AND enabled);
CREATE POLICY support_settings_enabled_read ON support.settings
  FOR SELECT TO authenticated USING (singleton AND enabled);
CREATE POLICY support_sessions_attendee_read ON support.sessions
  FOR SELECT TO authenticated
  USING (
    (operator_user_id = (SELECT auth.uid()) AND EXISTS (
      SELECT 1 FROM support.operators o
      WHERE o.user_id = (SELECT auth.uid()) AND o.enabled
    ))
    OR (approved_user_id = (SELECT auth.uid())
      AND status IN ('approved', 'connecting', 'active')
      AND COALESCE(session_expires_at, request_expires_at) > now())
  );

CREATE OR REPLACE FUNCTION public.remote_support_client_heartbeat(
  p_instance_id uuid,
  p_app_version text DEFAULT 'unknown',
  p_online boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, support, auth
AS $function$
DECLARE
  v_workspace_id uuid;
  v_role text;
  v_data_mode text;
BEGIN
  IF auth.uid() IS NULL OR p_instance_id IS NULL THEN
    RAISE EXCEPTION 'remote_support_auth_required' USING ERRCODE = '42501';
  END IF;

  IF NOT COALESCE(p_online, true) THEN
    UPDATE support.client_instances
       SET last_heartbeat_at = now() - interval '2 minutes', updated_at = now()
     WHERE instance_id = p_instance_id AND user_id = auth.uid();
    RETURN FOUND;
  END IF;

  SELECT p.workspace_id, lower(p.role), w.data_mode::text
    INTO v_workspace_id, v_role, v_data_mode
    FROM public.profiles p
    JOIN public.workspaces w ON w.id = p.workspace_id
   WHERE p.id = auth.uid() AND w.deleted_at IS NULL;

  IF v_workspace_id IS NULL OR v_role IS DISTINCT FROM 'admin'
    OR COALESCE(v_data_mode, '') NOT IN ('cloud', 'hybrid') THEN
    RAISE EXCEPTION 'remote_support_client_not_eligible' USING ERRCODE = '42501';
  END IF;

  IF char_length(COALESCE(p_app_version, '')) > 64 THEN
    RAISE EXCEPTION 'remote_support_invalid_app_version' USING ERRCODE = '22023';
  END IF;

  INSERT INTO support.client_instances (
    instance_id, workspace_id, user_id, platform, app_version, last_heartbeat_at, revoked_at
  ) VALUES (
    p_instance_id, v_workspace_id, auth.uid(), 'windows-tauri',
    COALESCE(NULLIF(btrim(p_app_version), ''), 'unknown'), now(), NULL
  )
  ON CONFLICT (instance_id) DO UPDATE SET
    app_version = EXCLUDED.app_version,
    last_heartbeat_at = now(),
    updated_at = now()
  WHERE support.client_instances.workspace_id = EXCLUDED.workspace_id
    AND support.client_instances.user_id = EXCLUDED.user_id
    AND support.client_instances.platform = 'windows-tauri'
    AND support.client_instances.revoked_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'remote_support_instance_conflict' USING ERRCODE = '23505';
  END IF;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.remote_support_client_decide(
  p_session_id uuid,
  p_decision text,
  p_instance_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, notifications, support, auth
AS $function$
DECLARE
  v_session support.sessions%ROWTYPE;
  v_workspace_id uuid;
  v_role text;
  v_next_status text;
BEGIN
  IF auth.uid() IS NULL OR p_session_id IS NULL
    OR COALESCE(p_decision, '') NOT IN ('approve', 'decline') THEN
    RAISE EXCEPTION 'remote_support_invalid_decision' USING ERRCODE = '22023';
  END IF;

  SELECT workspace_id, lower(role) INTO v_workspace_id, v_role
    FROM public.profiles WHERE id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'remote_support_workspace_admin_required' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE((SELECT enabled FROM support.settings WHERE singleton), false) THEN
    RAISE EXCEPTION 'remote_support_disabled' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_session FROM support.sessions
   WHERE id = p_session_id AND workspace_id = v_workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remote_support_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_session.status <> 'requested' OR v_session.request_expires_at <= now() THEN
    RAISE EXCEPTION 'remote_support_request_expired_or_decided' USING ERRCODE = '40001';
  END IF;

  IF p_decision = 'approve' THEN
    IF p_instance_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM support.client_instances ci
       WHERE ci.instance_id = p_instance_id
         AND ci.workspace_id = v_workspace_id
         AND ci.user_id = auth.uid()
         AND ci.platform = 'windows-tauri'
         AND ci.revoked_at IS NULL
         AND ci.last_heartbeat_at > now() - interval '90 seconds'
    ) THEN
      RAISE EXCEPTION 'remote_support_client_instance_unavailable' USING ERRCODE = '42501';
    END IF;
    v_next_status := 'approved';
    UPDATE support.sessions SET
      status = v_next_status,
      approved_at = now(),
      approved_user_id = auth.uid(),
      approved_instance_id = p_instance_id,
      session_expires_at = now() + interval '30 minutes',
      updated_at = now()
    WHERE id = p_session_id;
  ELSE
    v_next_status := 'declined';
    UPDATE support.sessions SET status = v_next_status, ended_at = now(),
      terminal_reason = 'client_declined', updated_at = now()
     WHERE id = p_session_id;
  END IF;

  INSERT INTO support.session_events(session_id, event_type, actor_type, actor_user_id)
  VALUES (p_session_id, v_next_status, 'client', auth.uid());
  UPDATE notifications.inbox SET
    payload = payload || jsonb_build_object('status', v_next_status, 'decision_at', now()),
    updated_at = now()
  WHERE workspace_id = v_workspace_id
    AND notification_type = 'remote_support_request'
    AND payload ->> 'session_id' = p_session_id::text;

  RETURN jsonb_build_object('session_id', p_session_id, 'status', v_next_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.remote_support_client_end(
  p_session_id uuid,
  p_reason text DEFAULT 'client_stopped'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, notifications, support, auth
AS $function$
DECLARE
  v_session support.sessions%ROWTYPE;
  v_role text;
BEGIN
  IF auth.uid() IS NULL OR p_session_id IS NULL THEN
    RAISE EXCEPTION 'remote_support_auth_required' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_reason, '') NOT IN ('client_stopped', 'capture_ended', 'connection_failed', 'app_closed', 'session_expired') THEN
    RAISE EXCEPTION 'remote_support_invalid_end_reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_session FROM support.sessions
   WHERE id = p_session_id AND approved_user_id = auth.uid()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remote_support_session_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_session.status NOT IN ('approved', 'connecting', 'active') THEN
    RETURN false;
  END IF;
  SELECT lower(role) INTO v_role FROM public.profiles
   WHERE id = auth.uid() AND workspace_id = v_session.workspace_id;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'remote_support_workspace_admin_required' USING ERRCODE = '42501';
  END IF;
  UPDATE support.sessions SET status = 'ended', ended_at = now(),
    terminal_reason = p_reason, updated_at = now() WHERE id = p_session_id;
  INSERT INTO support.session_events(session_id, event_type, actor_type, actor_user_id, metadata)
  VALUES (p_session_id, 'ended', 'client', auth.uid(), jsonb_build_object('reason', p_reason));
  UPDATE notifications.inbox SET
    payload = payload || jsonb_build_object('status', 'ended', 'terminal_reason', p_reason),
    updated_at = now()
  WHERE workspace_id = v_session.workspace_id
    AND notification_type = 'remote_support_request'
    AND payload ->> 'session_id' = p_session_id::text;
  PERFORM realtime.send(
    jsonb_build_object('type', 'stop', 'reason', p_reason),
    'signal', 'remote-support:' || p_session_id::text, true
  );
  RETURN true;
END;
$function$;

-- The Edge Function is the only caller of these service-role RPCs.
CREATE OR REPLACE FUNCTION public.remote_support_admin_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, support
AS $function$
DECLARE
  v_snapshot jsonb;
BEGIN
  IF NOT COALESCE((SELECT enabled FROM support.settings WHERE singleton), false) THEN
    UPDATE support.sessions SET status = CASE WHEN status = 'requested' THEN 'expired' ELSE 'ended' END,
      ended_at = now(), terminal_reason = 'feature_disabled', updated_at = now()
     WHERE status IN ('requested', 'approved', 'connecting', 'active');
  END IF;
  UPDATE support.sessions SET status = 'expired', ended_at = now(),
    terminal_reason = 'request_expired', updated_at = now()
   WHERE status = 'requested' AND request_expires_at <= now();
  UPDATE support.sessions SET status = 'expired', ended_at = now(),
    terminal_reason = 'session_expired', updated_at = now()
   WHERE status IN ('approved', 'connecting', 'active') AND session_expires_at <= now();

  INSERT INTO support.session_events(session_id, event_type, actor_type, metadata)
  SELECT s.id, s.status, 'system', jsonb_build_object('reason', s.terminal_reason)
    FROM support.sessions s
   WHERE s.status IN ('expired', 'ended') AND s.terminal_reason IN ('request_expired', 'session_expired', 'feature_disabled')
     AND NOT EXISTS (SELECT 1 FROM support.session_events e WHERE e.session_id = s.id AND e.event_type = s.status);
  UPDATE notifications.inbox i SET
    payload = i.payload || jsonb_build_object('status', s.status, 'terminal_reason', s.terminal_reason),
    updated_at = now()
  FROM support.sessions s
  WHERE s.status IN ('expired', 'ended') AND i.notification_type = 'remote_support_request'
    AND i.workspace_id = s.workspace_id AND i.payload ->> 'session_id' = s.id::text
    AND i.payload ->> 'status' IS DISTINCT FROM s.status;

  DELETE FROM support.session_events e USING support.sessions s
   WHERE e.session_id = s.id AND s.ended_at < now() - interval '365 days';
  DELETE FROM support.sessions WHERE ended_at < now() - interval '365 days';
  DELETE FROM support.client_instances WHERE last_heartbeat_at < now() - interval '7 days';

  SELECT jsonb_build_object(
    'enabled', COALESCE((SELECT enabled FROM support.settings WHERE singleton), false),
    'workspaces', COALESCE(jsonb_agg(jsonb_build_object(
      'workspace_id', w.id,
      'workspace_name', w.name,
      'workspace_code', w.code,
      'data_mode', w.data_mode::text,
      'deleted_at', w.deleted_at,
      'online', COALESCE(presence.online, false),
      'last_heartbeat_at', presence.last_heartbeat_at,
      'last_session', active_session.session_json
    ) ORDER BY w.created_at DESC), '[]'::jsonb)
  ) INTO v_snapshot
  FROM public.workspaces w
  LEFT JOIN LATERAL (
    SELECT true AS online, max(ci.last_heartbeat_at) AS last_heartbeat_at
      FROM support.client_instances ci
     WHERE ci.workspace_id = w.id AND ci.revoked_at IS NULL
       AND ci.last_heartbeat_at > now() - interval '90 seconds'
  ) presence ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'id', s.id, 'status', s.status, 'operator_name', s.operator_name,
      'reason', s.reason, 'created_at', s.created_at,
      'request_expires_at', s.request_expires_at,
      'approved_at', s.approved_at, 'session_expires_at', s.session_expires_at,
      'started_at', s.started_at, 'terminal_reason', s.terminal_reason
    ) AS session_json
      FROM support.sessions s
     WHERE s.workspace_id = w.id
       AND s.created_at > now() - interval '24 hours'
     ORDER BY s.created_at DESC LIMIT 1
  ) active_session ON true;
  RETURN v_snapshot;
END;
$function$;

CREATE OR REPLACE FUNCTION public.remote_support_admin_create_session(
  p_operator_user_id uuid,
  p_workspace_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, notifications, support
AS $function$
DECLARE
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_operator support.operators%ROWTYPE;
  v_workspace public.workspaces%ROWTYPE;
  v_session_id uuid := gen_random_uuid();
  v_expires_at timestamptz := now() + interval '10 minutes';
  v_recipient_count integer;
BEGIN
  IF NOT COALESCE((SELECT enabled FROM support.settings WHERE singleton), false) THEN
    RAISE EXCEPTION 'remote_support_disabled' USING ERRCODE = '55000';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'remote_support_reason_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_operator FROM support.operators
   WHERE user_id = p_operator_user_id AND enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'remote_support_operator_disabled' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_workspace FROM public.workspaces
   WHERE id = p_workspace_id AND deleted_at IS NULL;
  IF NOT FOUND OR COALESCE(v_workspace.data_mode::text, '') NOT IN ('cloud', 'hybrid') THEN
    RAISE EXCEPTION 'remote_support_workspace_unavailable' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM support.client_instances ci
     WHERE ci.workspace_id = p_workspace_id AND ci.platform = 'windows-tauri'
       AND ci.revoked_at IS NULL AND ci.last_heartbeat_at > now() - interval '90 seconds'
  ) THEN
    RAISE EXCEPTION 'remote_support_client_offline' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM support.sessions WHERE workspace_id = p_workspace_id
      AND status IN ('requested', 'approved', 'connecting', 'active')) THEN
    RAISE EXCEPTION 'remote_support_session_already_open' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM support.sessions WHERE workspace_id = p_workspace_id
      AND created_at > now() - interval '2 minutes') THEN
    RAISE EXCEPTION 'remote_support_cooldown' USING ERRCODE = '55000';
  END IF;

  INSERT INTO support.sessions(id, workspace_id, operator_user_id, operator_name, reason, request_expires_at)
  VALUES (v_session_id, p_workspace_id, p_operator_user_id, v_operator.display_name, v_reason, v_expires_at);
  INSERT INTO support.session_events(session_id, event_type, actor_type, actor_user_id)
  VALUES (v_session_id, 'requested', 'operator', p_operator_user_id);

  INSERT INTO notifications.inbox (
    workspace_id, user_id, notification_type, scope, priority, dedupe_key,
    title, body, action_url, action_label, payload, push_status, created_at, updated_at
  )
  SELECT p_workspace_id, p.id, 'remote_support_request', 'workspace', 'high',
    'remote_support:' || v_session_id::text,
    'Remote support request', 'A support operator requested a view-only session.',
    NULL, NULL,
    jsonb_build_object('session_id', v_session_id, 'operator_name', v_operator.display_name,
      'reason', v_reason, 'scope', 'atlas_window_view_only', 'status', 'requested',
      'request_expires_at', v_expires_at),
    'pending', now(), now()
  FROM public.profiles p
  WHERE p.workspace_id = p_workspace_id AND lower(p.role) = 'admin';
  GET DIAGNOSTICS v_recipient_count = ROW_COUNT;
  IF v_recipient_count = 0 THEN
    DELETE FROM support.sessions WHERE id = v_session_id;
    RAISE EXCEPTION 'remote_support_workspace_has_no_admin' USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('session_id', v_session_id, 'status', 'requested',
    'request_expires_at', v_expires_at, 'operator_name', v_operator.display_name);
END;
$function$;

CREATE OR REPLACE FUNCTION public.remote_support_admin_transition(
  p_operator_user_id uuid,
  p_session_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, notifications, support
AS $function$
DECLARE
  v_session support.sessions%ROWTYPE;
  v_status text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM support.operators WHERE user_id = p_operator_user_id AND enabled) THEN
    RAISE EXCEPTION 'remote_support_operator_disabled' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_session FROM support.sessions
   WHERE id = p_session_id AND operator_user_id = p_operator_user_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'remote_support_session_not_found' USING ERRCODE = 'P0002'; END IF;

  IF p_action = 'cancel' AND v_session.status = 'requested' THEN
    v_status := 'cancelled';
  ELSIF p_action = 'connecting' AND v_session.status = 'approved'
    AND v_session.session_expires_at > now() THEN
    IF NOT COALESCE((SELECT enabled FROM support.settings WHERE singleton), false) THEN
      RAISE EXCEPTION 'remote_support_disabled' USING ERRCODE = '55000';
    END IF;
    v_status := 'connecting';
  ELSIF p_action = 'active' AND v_session.status IN ('approved', 'connecting')
    AND v_session.session_expires_at > now() THEN
    IF NOT COALESCE((SELECT enabled FROM support.settings WHERE singleton), false) THEN
      RAISE EXCEPTION 'remote_support_disabled' USING ERRCODE = '55000';
    END IF;
    v_status := 'active';
  ELSIF p_action = 'failed' AND v_session.status IN ('approved', 'connecting', 'active') THEN
    v_status := 'failed';
  ELSIF p_action = 'end' AND v_session.status IN ('requested', 'approved', 'connecting', 'active') THEN
    v_status := CASE WHEN v_session.status = 'requested' THEN 'cancelled' ELSE 'ended' END;
  ELSE
    RAISE EXCEPTION 'remote_support_invalid_transition' USING ERRCODE = '40001';
  END IF;

  UPDATE support.sessions SET status = v_status,
    started_at = CASE WHEN v_status = 'active' THEN COALESCE(started_at, now()) ELSE started_at END,
    ended_at = CASE WHEN v_status IN ('cancelled', 'failed', 'ended') THEN now() ELSE ended_at END,
    terminal_reason = CASE WHEN v_status IN ('cancelled', 'failed', 'ended')
      THEN COALESCE(NULLIF(btrim(p_reason), ''), v_status) ELSE terminal_reason END,
    updated_at = now()
  WHERE id = p_session_id;
  INSERT INTO support.session_events(session_id, event_type, actor_type, actor_user_id, metadata)
  VALUES (p_session_id, v_status, 'operator', p_operator_user_id,
    CASE WHEN p_reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason', left(p_reason, 120)) END);
  UPDATE notifications.inbox SET
    payload = payload || jsonb_build_object('status', v_status, 'terminal_reason', p_reason),
    updated_at = now()
  WHERE workspace_id = v_session.workspace_id
    AND notification_type = 'remote_support_request'
    AND payload ->> 'session_id' = p_session_id::text;
  IF v_status IN ('failed', 'ended') AND v_session.status <> 'requested' THEN
    PERFORM realtime.send(
      jsonb_build_object('type', 'stop', 'reason', COALESCE(NULLIF(btrim(p_reason), ''), v_status)),
      'signal', 'remote-support:' || p_session_id::text, true
    );
  END IF;
  RETURN jsonb_build_object('session_id', p_session_id, 'status', v_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.remote_support_accessible_session(p_session_id uuid, p_actor_user_id uuid)
RETURNS TABLE(id uuid, workspace_id uuid, status text, operator_user_id uuid,
  approved_user_id uuid, session_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, support
AS $function$
  SELECT s.id, s.workspace_id, s.status, s.operator_user_id, s.approved_user_id, s.session_expires_at
    FROM support.sessions s
   WHERE s.id = p_session_id
     AND s.status IN ('approved', 'connecting', 'active')
     AND s.session_expires_at > now()
     AND EXISTS (SELECT 1 FROM support.settings settings WHERE settings.singleton AND settings.enabled)
     AND (s.approved_user_id = p_actor_user_id OR (s.operator_user_id = p_actor_user_id AND EXISTS (
       SELECT 1 FROM support.operators o WHERE o.user_id = p_actor_user_id AND o.enabled
     )));
$function$;

CREATE OR REPLACE FUNCTION public.remote_support_operator_identity(p_actor_user_id uuid)
RETURNS TABLE(user_id uuid, display_name text, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, support
AS $function$
  SELECT o.user_id, o.display_name, o.enabled
    FROM support.operators o
   WHERE o.user_id = p_actor_user_id;
$function$;

REVOKE ALL ON FUNCTION public.remote_support_client_heartbeat(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remote_support_client_decide(uuid, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remote_support_client_end(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remote_support_client_heartbeat(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remote_support_client_decide(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remote_support_client_end(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.remote_support_admin_snapshot() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remote_support_admin_create_session(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remote_support_admin_transition(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remote_support_accessible_session(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remote_support_operator_identity(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remote_support_admin_snapshot() TO service_role;
GRANT EXECUTE ON FUNCTION public.remote_support_admin_create_session(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.remote_support_admin_transition(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.remote_support_accessible_session(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.remote_support_operator_identity(uuid) TO service_role;

DROP POLICY IF EXISTS remote_support_broadcast_receive ON realtime.messages;
CREATE POLICY remote_support_broadcast_receive ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    extension = 'broadcast'
    AND EXISTS (
      SELECT 1 FROM support.sessions s
       WHERE realtime.messages.topic = 'remote-support:' || s.id::text
         AND s.status IN ('approved', 'connecting', 'active')
         AND s.session_expires_at > now()
         AND EXISTS (SELECT 1 FROM support.settings settings WHERE settings.singleton AND settings.enabled)
         AND ((s.operator_user_id = (SELECT auth.uid()) AND EXISTS (
           SELECT 1 FROM support.operators o WHERE o.user_id = (SELECT auth.uid()) AND o.enabled
         )) OR s.approved_user_id = (SELECT auth.uid()))
    )
  );
DROP POLICY IF EXISTS remote_support_broadcast_send ON realtime.messages;
CREATE POLICY remote_support_broadcast_send ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    extension = 'broadcast'
    AND EXISTS (
      SELECT 1 FROM support.sessions s
       WHERE realtime.messages.topic = 'remote-support:' || s.id::text
         AND s.status IN ('approved', 'connecting', 'active')
         AND s.session_expires_at > now()
         AND EXISTS (SELECT 1 FROM support.settings settings WHERE settings.singleton AND settings.enabled)
         AND ((s.operator_user_id = (SELECT auth.uid()) AND EXISTS (
           SELECT 1 FROM support.operators o WHERE o.user_id = (SELECT auth.uid()) AND o.enabled
         )) OR s.approved_user_id = (SELECT auth.uid()))
    )
  );

COMMENT ON SCHEMA support IS 'Private metadata and audit records for client-approved, view-only support. No media is stored.';
COMMENT ON TABLE support.operators IS 'Named Supabase Auth users explicitly allowlisted for remote support; provisioned by trusted administrators.';
COMMENT ON TABLE support.session_events IS 'Append-only remote support lifecycle and consent audit trail.';
COMMENT ON TABLE support.client_instances IS 'Short-lived Windows Tauri support availability, not device attestation.';
