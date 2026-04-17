BEGIN;

CREATE TEMP TABLE pg_temp.manual_notification_params (
  target_workspace_id uuid
) ON COMMIT DROP;

-- Set this to a workspace UUID to scope the run.
-- Leave NULL to process all workspaces.
INSERT INTO pg_temp.manual_notification_params (target_workspace_id)
VALUES (NULL::uuid);

-- Manual notification detection helper.
--
-- Steps:
-- 1. Optionally change target_workspace_id above.
-- 2. Run this script in the Supabase SQL editor.
-- 3. This script now detects and dispatches in one run.

SELECT public.detect_and_dispatch_notification_events(target_workspace_id) AS dispatched_count
FROM pg_temp.manual_notification_params;

COMMIT;

-- Inspect the newest queued rows from this run.
SELECT
  entity_type,
  status,
  COUNT(*) AS event_count,
  MAX(created_at) AS latest_created_at
FROM notifications.events
WHERE updated_at >= now() - interval '10 minutes'
GROUP BY entity_type, status
ORDER BY entity_type, status;

SELECT
  notification_type,
  COUNT(*) AS inbox_count,
  MAX(created_at) AS latest_created_at
FROM notifications.inbox
WHERE updated_at >= now() - interval '10 minutes'
GROUP BY notification_type
ORDER BY notification_type;
