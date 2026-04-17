BEGIN;

CREATE TEMP TABLE pg_temp.manual_notification_params (
  target_workspace_id uuid
);

-- Set this to a workspace UUID to scope the run.
-- Leave NULL to process all workspaces.
INSERT INTO pg_temp.manual_notification_params (target_workspace_id)
VALUES (NULL::uuid);

-- Manual notification detection helper.
--
-- Steps:
-- 1. Optionally change target_workspace_id above.
-- 2. Run this script in the Supabase SQL editor.
-- 3. The script calls the edge dispatcher over pg_net so inbox materialization
--    and FCM push use the same path as production.
--
-- Notes:
-- - The HTTP request is asynchronous.
-- - If the response row is still NULL after the sleep below, rerun only the
--   final response query a few seconds later.

CREATE TEMP TABLE pg_temp.dispatch_request AS
SELECT
  target_workspace_id,
  public.request_dispatch_notifications(target_workspace_id) AS request_id
FROM pg_temp.manual_notification_params;

COMMIT;

SELECT pg_sleep(5);

SELECT
  target_workspace_id,
  request_id
FROM pg_temp.dispatch_request;

SELECT
  r.request_id,
  h.status_code,
  h.error_msg,
  h.content::text AS response_body
FROM pg_temp.dispatch_request r
LEFT JOIN net._http_response h
  ON h.id = r.request_id;

SELECT
  entity_type,
  status,
  COUNT(*) AS event_count,
  MAX(updated_at) AS latest_updated_at
FROM notifications.events
WHERE updated_at >= now() - interval '10 minutes'
GROUP BY entity_type, status
ORDER BY entity_type, status;

SELECT
  notification_type,
  push_status,
  COUNT(*) AS inbox_count,
  MAX(updated_at) AS latest_updated_at
FROM notifications.inbox
WHERE updated_at >= now() - interval '10 minutes'
GROUP BY notification_type, push_status
ORDER BY notification_type, push_status;
