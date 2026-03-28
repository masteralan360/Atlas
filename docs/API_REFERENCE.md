# API Reference

## Current Shape

The app now uses three access patterns:

1. Direct table reads and writes for normal workspace-scoped CRUD, protected by RLS
2. Supabase Edge Functions for privileged auth/admin/member operations
3. A small SQL RPC layer for atomic sales and returns

## Edge Functions

Location: `supabase/functions/`

### `workspace-access`

Called with `supabase.functions.invoke('workspace-access', { body })`.

Supported actions:

- `create`
  - body: `{ action: 'create', workspaceName, passkey }`
  - use: pre-signup workspace bootstrap for admin registration
  - returns: `{ id, name, code }`
- `join`
  - body: `{ action: 'join', workspaceCode }`
  - use: assign the authenticated user to a workspace and sync auth metadata
  - returns: `{ workspace_id, workspace_code, workspace_name, data_mode }`
- `kick`
  - body: `{ action: 'kick', targetUserId }`
  - use: remove a member from the caller's workspace and clear their auth metadata
  - returns: `{ success, message }`

### `admin-console`

Called with `supabase.functions.invoke('admin-console', { body })`.

Supported actions:

- `verify`
  - body: `{ action: 'verify', passkey }`
  - returns: `{ valid, user_id }`
- `listUsers`
  - body: `{ action: 'listUsers', passkey }`
  - returns: admin user rows joined with profile/workspace context
- `listWorkspaces`
  - body: `{ action: 'listWorkspaces', passkey }`
  - returns: workspace rows for the admin dashboard
- `deleteUser`
  - body: `{ action: 'deleteUser', passkey, targetUserId }`
- `updateWorkspaceFeatures`
  - body: `{ action: 'updateWorkspaceFeatures', passkey, workspaceId, pos, crm, invoices_history, locked_workspace }`
- `updateWorkspaceSubscription`
  - body: `{ action: 'updateWorkspaceSubscription', passkey, workspaceId, newExpiry }`

## Kept SQL RPCs

These still run through `supabase.rpc()` because they are transactional or intentionally narrow database helpers.

### `lookup_workspace_by_code`

- use: pre-auth workspace lookup during signup
- returns: `{ id, name, code }`

### `complete_sale`

- use: atomic sale creation plus inventory deduction

### `delete_sale`

- use: admin-only server-side sale deletion path

### `return_sale_items`

- use: partial or full item returns with inventory restoration

### `return_whole_sale`

- use: admin-only wrapper over `return_sale_items`

## Direct Table Operations

Direct table access is the default for simple workspace-scoped CRUD. The current app uses direct reads and writes for:

- `workspaces`
- `profiles`
- `workspace_contacts`
- `products`
- `categories`
- `storages`
- `inventory`
- `loans`
- `loan_installments`
- `loan_payments`

This assumes the RLS migrations in `supabase/migrations/20260328_secure_public_rls_and_workspace_lookup.sql` and `supabase/migrations/20260328_finish_rpc_rationalization.sql` are applied.
