# Notification System

## Overview
Notifications are now stored directly in Supabase and rendered by the app.

Flow:
1. App code or SQL functions insert rows into `notifications.events`.
2. `dispatch-notifications` runs detection, materializes inbox rows, and sends FCM push fan-out.
3. `public.request_dispatch_notifications` lets SQL and `pg_cron` trigger that same edge path.
4. `NotificationCenter` loads the inbox via Supabase RPCs and subscribes to realtime changes on `notifications.inbox`.
5. While the app is open, new inbox rows trigger the in-app sound, toast, and Tauri desktop notification.

## Database
- `notifications.events` remains the outbox / queue.
- `notifications.inbox` is the durable user inbox.
- `notifications.inbox` keeps the stable columns needed for UI (`title`, `body`, `notification_type`, `priority`, `action_url`) plus flexible `payload jsonb` for future notification shapes.
- `read_at` and `archived_at` are the inbox state columns.
- `push_status`, `push_sent_at`, `push_last_attempt_at`, `push_error`, and `push_attempt_count` track FCM delivery.

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
- `public.request_dispatch_notifications` invokes `dispatch-notifications` through `pg_net`, so cron and manual SQL runs use the same FCM path as marketplace orders.
- `supabase/functions/dispatch-notifications/index.ts` now runs detection, inbox materialization, and FCM push fan-out.
- `public.upsert_notification_inbox` makes inbox writes idempotent per event and resets push delivery to `pending` when the inbox payload changes.
- `public.get_pending_push_notification_targets`, `public.update_notification_push_delivery`, and `public.delete_device_token` drive FCM delivery and stale-token cleanup.
- `supabase/functions/place-inquiry-order/index.ts` still queues marketplace events and triggers the dispatcher immediately.
- `pg_cron` should call `public.request_dispatch_notifications()` every 5 minutes so detection and FCM push stay on the same path.

## Required Secrets
Set these in Supabase Edge Function secrets:
- `NOTIFICATION_CRON_SECRET`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `FIREBASE_SERVICE_ACCOUNT_JSON` or these split secrets:
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

Set these in Supabase Vault for SQL/cron-triggered dispatch:
- `project_url`
- `notification_cron_secret`
- Add them from the Supabase Dashboard Vault UI or with `vault.create_secret(...)`. Do not run `CREATE EXTENSION vault`.

## Required Frontend Env
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Notes
- `notifications.inbox` must exist in the `supabase_realtime` publication for live updates.
- Future delivery channels can reuse the same inbox row and extend behavior through `payload jsonb`.

- `register-device-token` authenticates the user and stores Android/Web FCM tokens through `public.upsert_device_token`.

- `public/firebase-messaging-sw.js` handles web background notifications and click routing via `actionUrl`.
