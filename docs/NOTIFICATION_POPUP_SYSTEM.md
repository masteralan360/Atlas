# Notification System

## Overview
Notifications are now stored directly in Supabase and rendered by the app.

Flow:
1. App code or SQL functions insert rows into `notifications.events`.
2. `detect_and_dispatch_notification_events` detects overdue/pending sources and immediately dispatches them into `notifications.inbox`.
3. `dispatch-notifications` can still be called manually, but scheduled detection now uses the database function directly.
4. `NotificationCenter` loads the inbox via Supabase RPCs and subscribes to realtime changes on `notifications.inbox`.
4. While the app is open, new inbox rows trigger the in-app sound, toast, and Tauri desktop notification.

## Database
- `notifications.events` remains the outbox / queue.
- `notifications.inbox` is the durable user inbox.
- `notifications.inbox` keeps the stable columns needed for UI (`title`, `body`, `notification_type`, `priority`, `action_url`) plus flexible `payload jsonb` for future notification shapes.
- `read_at` and `archived_at` are the inbox state columns.

## Frontend
- `src/ui/components/NotificationCenter.tsx` now renders a native inbox popover.
- Inbox data is loaded through:
  - `public.list_notifications_inbox`
  - `public.mark_notification_inbox_read`
  - `public.mark_notification_inbox_archived`
  - `public.mark_all_notifications_inbox_read`
- Realtime updates come from `notifications.inbox`.
- Desktop notifications still use `@tauri-apps/plugin-notification`.

## Backend
- `public.upsert_notification_event` makes queue writes idempotent on `(user_id, entity_type, entity_id, due_date)` and refreshes payloads without duplicating events.
- `public.detect_and_dispatch_notification_events` detects marketplace, loan, expense, and payroll notifications and then calls `public.dispatch_notification_events()`.
- `supabase/functions/dispatch-notifications/index.ts` now delegates to `public.dispatch_notification_events()`.
- `public.upsert_notification_inbox` makes inbox writes idempotent per event.
- `supabase/functions/place-inquiry-order/index.ts` still queues marketplace events and triggers the dispatcher immediately.
- A Supabase Cron job now runs detection every 5 minutes using `pg_cron`.

## Required Secrets
Set these in Supabase Edge Function secrets:
- `NOTIFICATION_CRON_SECRET`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## Required Frontend Env
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Notes
- `notifications.inbox` must exist in the `supabase_realtime` publication for live updates.
- Future delivery channels can reuse the same inbox row and extend behavior through `payload jsonb`.
