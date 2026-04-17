# Notification System

## Overview
Notifications are now delivered through Courier.

Flow:
1. App code or SQL functions insert rows into `notifications.events`.
2. `dispatch-notifications` reads pending rows and sends them to Courier using template IDs.
3. Courier delivers inbox messages to the signed-in user.
4. `NotificationCenter` renders the Courier inbox popup and shows desktop OS notifications for new messages while the app is open.

## Frontend
- `src/ui/components/NotificationCenter.tsx` uses `@trycourier/courier-react`.
- The client signs in by calling `issue-courier-token` with the current Supabase access token.
- The inbox UI is `CourierInboxPopupMenu` with a custom bell button and unread badge.
- Desktop notifications still use `@tauri-apps/plugin-notification`.

## Backend
- `supabase/functions/issue-courier-token/index.ts` issues short-lived Courier JWTs for authenticated users.
- `supabase/functions/dispatch-notifications/index.ts` maps notification event types to Courier templates and marks rows as `sent` or `failed`.
- `supabase/functions/place-inquiry-order/index.ts` still queues marketplace notification events and triggers the dispatcher immediately.

## Required Secrets
Set these in Supabase Edge Function secrets:
- `COURIER_API_KEY`
- `COURIER_TEMPLATE_BUDGET_OVERDUE`
- `COURIER_TEMPLATE_LOAN_OVERDUE`
- `COURIER_TEMPLATE_MARKETPLACE_PENDING_ORDER`
- `NOTIFICATION_CRON_SECRET`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

## Required Frontend Env
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Removed Pieces
The old Novu popup registry and popup components are gone:
- `src/lib/notificationPopups.ts`
- `src/ui/components/novupopups/`

Courier inbox messages are now the only in-app notification surface.
