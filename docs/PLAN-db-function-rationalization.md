# Database Function Rationalization Plan

## Scope

This document classifies the current Supabase SQL function set into four buckets:

1. Keep in the database layer
2. Move to an Edge Function or other server-side backend
3. Replace with direct table access, a view, or a normal SQL query after RLS is in place
4. Delete, fold into another function, or retire from the workflow

It is based on the current repository state as of 2026-03-28.

## Implementation Status

Implemented on 2026-03-28:

- direct `workspaces` reads replaced `get_workspace_features`
- workspace setup now uses direct `workspaces` updates instead of `configure_workspace`
- workspace join, kick, admin dashboard actions, and pre-signup workspace creation moved behind Edge Functions
- `hybrid` workspace mode drift fixed in migrations
- kicked-user bootstrap now treats `profiles.workspace_id` as the canonical membership source

Implemented on 2026-03-29:

- cleanup migration drops the abandoned workspace/admin RPCs and low-value workspace access wrappers
- only the intentionally kept SQL RPCs remain: `lookup_workspace_by_code`, `complete_sale`, `delete_sale`, `return_sale_items`, and `return_whole_sale`

## Hard Prerequisite

Do not migrate more public-table writes to the loans-style client sync pattern until Row Level Security and policies exist for the core public tables that the app reads and writes directly or plans to write directly.

At minimum, review and secure:

- `public.workspaces`
- `public.profiles`
- `public.workspace_contacts`
- `public.products`
- `public.categories`
- `public.storages`
- `public.inventory`
- `public.sales`
- `public.sale_items`
- `public.loans`
- `public.loan_installments`
- `public.loan_payments`

The repo clearly has RLS coverage for the CRM schema and `public.payment_transactions`, but not for the public business tables listed above.

## Bucket 1: Keep In The Database Layer

These routines enforce invariants, support RLS, or provide cloud-side transactional safety that should not be moved to client-side sequential writes.

| Function | Recommendation | Why | Notes |
| --- | --- | --- | --- |
| `complete_sale` | Keep in DB | Atomic sale creation plus inventory deduction belongs in one database transaction. | Keep as RPC or move to a server-side wrapper that still calls DB logic. |
| `return_sale_items` | Keep in DB | Atomic return processing plus inventory restoration belongs in one database transaction. | This is the correct core return routine. |
| `check_registration_passkey` | Keep in DB | Auth trigger validation must run inside the database/auth pipeline. | Trigger helper. |
| `handle_new_user` | Keep in DB | Profile bootstrap should happen at user creation time in the DB/auth pipeline. | Trigger helper. |
| `refresh_product_inventory_snapshot` | Keep in DB | Maintains product quantity/storage snapshot from inventory rows. | Invariant helper. |
| `handle_inventory_snapshot_refresh` | Keep in DB | Trigger hook for inventory snapshot refresh. | Defined inside `refresh_product_inventory_snapshot.sql`. |
| `rotate_signup_safe_app_permissions_keys` | Keep in DB | Trigger-linked helper for signup-related secret rotation. | Internal helper. |
| `trigger_rotate_keys_on_register` | Keep in DB | Trigger wrapper for signup-safe key rotation. | Internal helper. |
| `update_updated_at_column` | Keep in DB | Generic timestamp trigger helper. | Standard schema utility. |
| `update_workspace_member_count` | Keep in DB | Counter maintenance should stay in the database. | Trigger helper. |
| `generate_workspace_code` | Keep in DB | Used as a DB-side code generator and default helper. | Fine as a DB helper. |
| `generate_random_alphanumeric_key` | Keep in DB | Shared helper for DB-side key rotation logic. | Fine as a DB helper. |
| `current_workspace_id` | Keep in DB | Core RLS helper. | Keep and reuse for future public-table RLS policies. |
| `prevent_workspace_mode_switch` | Keep in DB | Prevents invalid state transitions regardless of client behavior. | Trigger helper. |
| `prevent_inventory_transfer_transaction_delete` | Keep in DB | Protects immutable transfer history at the DB layer. | Trigger helper. |

## Bucket 2: Move To Edge Functions Or Another Server-Side Backend

These should not become plain client-side table writes. They touch `auth.users`, privileged secrets, or admin-only cross-workspace operations.

| Function | Recommendation | Why | Notes |
| --- | --- | --- | --- |
| `create_workspace` | Move server-side | Workspace bootstrap currently happens before a normal authenticated workspace session exists. | Better as an Edge Function than a client-callable SQL RPC. |
| `join_workspace` | Move server-side | Updates both `public.profiles` and `auth.users` metadata. | Keep server-side; do not replace with direct client writes. |
| `kick_member` | Move server-side | Updates `public.profiles` and `auth.users`, with cross-user authorization checks. | Good Edge Function candidate. |
| `delete_user_account` | Move server-side | Deletes from `auth.users` and mutates workspace state. | Good Edge Function candidate. |
| `admin_update_workspace_features` | Move server-side | Privileged admin mutation using a passkey. | Fold passkey verification into the server-side handler. |
| `admin_update_workspace_subscription` | Move server-side | Privileged admin mutation using a passkey. | Fold passkey verification into the server-side handler. |
| `get_all_users` | Move server-side | Reads `auth.users` and workspace metadata. | Good admin backend operation. |
| `get_all_workspaces` | Move server-side | Cross-workspace admin listing should not be a general client RPC. | Good admin backend operation. |
| `verify_admin_passkey` | Move server-side or delete after migration | Secret verification should not remain as a standalone client-exposed primitive. | Prefer folding it into admin Edge Functions. |
| `rotate_app_permissions_keys` | Move server-side | Secret rotation is an internal privileged admin task. | Keep off the client path. |

## Bucket 3: Replace After RLS With Direct Access, A View, Or A Regular SQL Query

These functions are not fundamentally wrong, but they do not need to remain as database functions once the schema is properly secured.

| Function | Recommendation | Why | Notes |
| --- | --- | --- | --- |
| `get_workspace_features` | Replace after RLS | Mostly a convenience wrapper around current workspace settings. | Replace with direct `workspaces` reads or a security-invoker view. |
| `configure_workspace` | Replace after RLS | Single-workspace setup update can be enforced by RLS plus existing DB constraints/triggers. | Keep mode-switch protection in the trigger, not in the client. |
| `delete_sale` | Replace after RLS | This is a simple authorized delete, not a complex transaction. | Consider whether this should become soft-delete instead of hard-delete. |
| `check_feature_enabled` | Replace after RLS | Can be replaced with a direct read of the workspace feature flags already loaded by the app. | Low value as a standalone function. |
| `check_workspace_access` | Replace after RLS | Can be replaced with a direct read of the target workspace status. | Merge with normal workspace reads if still needed. |
| `is_workspace_active` | Replace after RLS | Overlaps heavily with `check_workspace_access`. | Keep one concept only if still needed. |
| `get_net_revenue` | Replace function with a DB view or direct SQL query | The computation should stay in Postgres, but it does not have to stay as a function. | Do not move this aggregation fully to the client. |
| `get_sales_summary` | Replace function with a DB view or direct SQL query | Same reasoning as above. | Keep computation in the DB layer. |
| `get_team_performance` | Replace function with a DB view or direct SQL query | Same reasoning as above. | Keep computation in the DB layer. |
| `get_top_products` | Replace function with a DB view or direct SQL query | Same reasoning as above. | Keep computation in the DB layer. |

## Bucket 4: Delete, Fold, Or Retire

These functions are dead, duplicated, stubbed, one-off migration helpers, or small wrappers that do not justify staying separate.

| Function | Recommendation | Why | Notes |
| --- | --- | --- | --- |
| `_deploy` | Retire from active workflow, then delete | It duplicates function definitions already present in standalone files and migrations. | Choose migrations as the source of truth. |
| `admin_schedule_workspace_mode_migration` | Delete | Current implementation is a permanent stub that only raises an exception. | Remove after confirming no external dependency. |
| `admin_finalize_workspace_mode_migration` | Delete | Current implementation is a permanent stub that only raises an exception. | Remove after confirming no external dependency. |
| `migrate_products_to_main_storage` | Convert to one-time migration, then delete | This is migration logic, not an app runtime function. | Keep the migration result, not the runtime routine. |
| `check_return_permissions` | Fold into the remaining return SQL | Its only meaningful consumer is `return_whole_sale`. | Inline into `return_whole_sale` or directly into `return_sale_items` if you keep a whole-sale policy in SQL. |
| `return_whole_sale` | Fold into `return_sale_items` or delete | It is a thin wrapper that collects all quantities and delegates. | Keep only if you want a dedicated admin-only whole-return entry point. |

## Bucket 5: Review For Deletion Or Keep Only If The Related Worker Still Exists

These are not referenced by the current app UI flow in this repo, but they may still matter for out-of-band workers or operational tooling.

| Function | Recommendation | Why | Notes |
| --- | --- | --- | --- |
| `acknowledge_p2p_sync` | Review | Internal sync coordination routine, not a normal client CRUD function. | Keep only if the P2P sync subsystem is still active. |
| `get_pending_notification_events` | Review | Internal notification queue reader. | Keep only if a worker still consumes it. |
| `update_notification_event_status` | Review | Internal notification queue updater. | Keep only if a worker still consumes it. |

## Missing Or Drifted

| Item | Recommendation | Why | Notes |
| --- | --- | --- | --- |
| `switch_workspace_data_mode` | Fix immediately | The app calls it, but no matching SQL definition was found in the repo. | Either add the missing migration/function or remove the call path. |

## Recommended Execution Order

1. Stop treating `_deploy.sql` as a source of truth.
2. Add RLS and policies for the core public tables before expanding direct table writes.
3. Move admin/auth cross-user operations to Edge Functions.
4. Remove low-value wrapper functions such as `get_workspace_features`, `check_feature_enabled`, `check_workspace_access`, and `is_workspace_active`.
5. Keep transactional inventory and return logic in the database layer.
6. Replace analytics functions with views or direct DB-side SQL only if you want fewer functions, but do not move those calculations fully to the client.

## Final Position

You can reduce the number of database functions substantially, but the target should be:

- direct CRUD from the client for simple modules, protected by RLS
- a small database layer for invariants, triggers, and truly atomic financial operations
- server-side backend handlers for admin/auth/system actions

The target should not be:

- moving atomic financial mutations into client-side sequential sync code
- exposing privileged system operations as direct client table writes
