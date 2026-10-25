-- Remove Remote Support V1 data, access policies, and API surface.
UPDATE support.settings
   SET enabled = false, updated_at = now()
 WHERE singleton;

DELETE FROM notifications.inbox
 WHERE notification_type = 'remote_support_request';

DROP POLICY IF EXISTS remote_support_broadcast_receive ON realtime.messages;
DROP POLICY IF EXISTS remote_support_broadcast_send ON realtime.messages;

DROP FUNCTION IF EXISTS public.remote_support_client_heartbeat(uuid, text, boolean);
DROP FUNCTION IF EXISTS public.remote_support_client_decide(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.remote_support_client_end(uuid, text);
DROP FUNCTION IF EXISTS public.remote_support_admin_snapshot();
DROP FUNCTION IF EXISTS public.remote_support_session_channel(uuid, uuid);
DROP FUNCTION IF EXISTS public.remote_support_admin_create_session(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.remote_support_admin_create_session(uuid, text);
DROP FUNCTION IF EXISTS public.remote_support_admin_transition(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.remote_support_admin_transition(uuid, text, text);
DROP FUNCTION IF EXISTS public.remote_support_accessible_session(uuid, uuid);
DROP FUNCTION IF EXISTS public.remote_support_operator_identity(uuid);

DROP SCHEMA IF EXISTS support CASCADE;
