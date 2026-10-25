-- Use the existing Admin passkey as the operator gate. A per-session random
-- topic capability replaces Supabase Auth identity for operator-side signaling.
ALTER TABLE support.sessions
  ADD COLUMN channel_secret uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE support.sessions
  ALTER COLUMN operator_name SET DEFAULT 'Atlas Admin';
DROP INDEX IF EXISTS support.support_sessions_operator_created_idx;

DROP TRIGGER IF EXISTS support_stop_sessions_for_disabled_operator ON support.operators;
DROP FUNCTION IF EXISTS support.stop_sessions_for_disabled_operator();
DROP POLICY IF EXISTS support_operators_self_read ON support.operators;
DROP POLICY IF EXISTS support_sessions_attendee_read ON support.sessions;
DROP POLICY IF EXISTS support_settings_enabled_read ON support.settings;
DROP POLICY IF EXISTS remote_support_broadcast_receive ON realtime.messages;
DROP POLICY IF EXISTS remote_support_broadcast_send ON realtime.messages;

DROP FUNCTION IF EXISTS public.remote_support_admin_create_session(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.remote_support_admin_transition(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.remote_support_accessible_session(uuid, uuid);
DROP FUNCTION IF EXISTS public.remote_support_operator_identity(uuid);
DROP TABLE support.operators;
ALTER TABLE support.sessions DROP COLUMN operator_user_id;

REVOKE ALL ON support.sessions, support.settings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION support.broadcast_stop_on_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, support, realtime
AS $function$
BEGIN
  IF OLD.status IN ('approved', 'connecting', 'active')
     AND NEW.status IN ('failed', 'ended', 'expired')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM realtime.send(
      jsonb_build_object('type', 'stop', 'reason', COALESCE(NEW.terminal_reason, NEW.status)),
      'signal', 'remote-support:' || NEW.id::text || ':' || OLD.channel_secret::text, false
    );
    UPDATE support.sessions
       SET channel_secret = gen_random_uuid()
     WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS support_broadcast_stop_on_terminal ON support.sessions;
CREATE TRIGGER support_broadcast_stop_on_terminal
AFTER UPDATE OF status ON support.sessions
FOR EACH ROW EXECUTE FUNCTION support.broadcast_stop_on_terminal();
REVOKE ALL ON FUNCTION support.broadcast_stop_on_terminal() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION support.terminate_session(p_session_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, support, notifications
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
END;
$function$;
REVOKE ALL ON FUNCTION support.terminate_session(uuid, text) FROM PUBLIC, anon, authenticated;

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
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.remote_support_session_channel(
  p_session_id uuid,
  p_client_user_id uuid DEFAULT NULL
)
RETURNS TABLE(session_id uuid, session_expires_at timestamptz, channel_secret uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, support
AS $function$
  SELECT s.id, s.session_expires_at, s.channel_secret
    FROM support.sessions s
   WHERE s.id = p_session_id
     AND s.status IN ('approved', 'connecting', 'active')
     AND s.session_expires_at > now()
     AND EXISTS (SELECT 1 FROM support.settings settings WHERE settings.singleton AND settings.enabled)
     AND (p_client_user_id IS NULL OR s.approved_user_id = p_client_user_id);
$function$;

CREATE OR REPLACE FUNCTION public.remote_support_admin_create_session(
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
  v_operator_name constant text := 'Atlas Admin';
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

  INSERT INTO support.sessions(id, workspace_id, operator_name, reason, request_expires_at)
  VALUES (v_session_id, p_workspace_id, v_operator_name, v_reason, v_expires_at);
  INSERT INTO support.session_events(session_id, event_type, actor_type, metadata)
  VALUES (v_session_id, 'requested', 'operator', jsonb_build_object('authorization', 'admin_passkey'));

  INSERT INTO notifications.inbox (
    workspace_id, user_id, notification_type, scope, priority, dedupe_key,
    title, body, action_url, action_label, payload, push_status, created_at, updated_at
  )
  SELECT p_workspace_id, p.id, 'remote_support_request', 'workspace', 'high',
    'remote_support:' || v_session_id::text,
    'Remote support request', 'The Atlas Admin requested a view-only session.',
    NULL, NULL,
    jsonb_build_object('session_id', v_session_id, 'operator_name', v_operator_name,
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
    'request_expires_at', v_expires_at, 'operator_name', v_operator_name);
END;
$function$;

CREATE OR REPLACE FUNCTION public.remote_support_admin_transition(
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
  SELECT * INTO v_session FROM support.sessions WHERE id = p_session_id FOR UPDATE;
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
  INSERT INTO support.session_events(session_id, event_type, actor_type, metadata)
  VALUES (p_session_id, v_status, 'operator',
    jsonb_build_object('authorization', 'admin_passkey') ||
    CASE WHEN p_reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason', left(p_reason, 120)) END);
  UPDATE notifications.inbox SET
    payload = payload || jsonb_build_object('status', v_status, 'terminal_reason', p_reason),
    updated_at = now()
  WHERE workspace_id = v_session.workspace_id
    AND notification_type = 'remote_support_request'
    AND payload ->> 'session_id' = p_session_id::text;
  RETURN jsonb_build_object('session_id', p_session_id, 'status', v_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.remote_support_client_end(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remote_support_client_end(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.remote_support_session_channel(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remote_support_admin_create_session(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remote_support_admin_transition(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remote_support_session_channel(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.remote_support_admin_create_session(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.remote_support_admin_transition(uuid, text, text) TO service_role;

COMMENT ON TABLE support.sessions IS 'Client-approved view-only support sessions. Signaling topics use an unguessable random per-session capability; no screen media is stored.';
