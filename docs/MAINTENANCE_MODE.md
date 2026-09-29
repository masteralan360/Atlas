# Server Maintenance Mode

## Purpose

Server Maintenance Mode lets an operator temporarily stop Supabase-backed
business operations across Atlas while the server is being changed or repaired.
For Cloud and Hybrid workspaces, Atlas treats the server as intentionally
unavailable and uses its existing offline-first data path. Local workspaces do
not participate in this feature.

Maintenance Mode is a client behavior switch. It does not stop Supabase itself
from accepting requests from other clients or services; server-side maintenance
procedures should be coordinated separately.

## Scope by workspace mode

| Workspace mode | Reads and writes | Maintenance table | Realtime maintenance listener | Status bar |
| --- | --- | --- | --- | --- |
| Cloud | Existing local-first writes are queued; normal Supabase data access and sync are paused | Read when monitoring starts and after relevant Realtime events | One listener remains active | Yellow “Maintenance Active” with pending queue count |
| Hybrid | Existing local-first writes and SQLite mirror behavior continue; Supabase data access and sync are paused | Read when monitoring starts and after relevant Realtime events | One listener remains active | Yellow “Maintenance Active” with pending queue count |
| Local | Normal Local behavior is unchanged | Never read | Never started | No maintenance status |

Eligibility is checked centrally using the current workspace mode. Local and
Demo workspaces are excluded from the request gate and monitor lifecycle.

## Global state table

The migration
[`20260929175358_app_maintenance_mode.sql`](../supabase/migrations/20260929175358_app_maintenance_mode.sql)
creates `public.app_maintenance` and seeds its single row with maintenance off.

- `maintenance` is required and defaults to `false`.
- A boolean primary key constrained to `true` permits at most one row.
- RLS allows `anon` and `authenticated` clients to read the state. Client roles
  have no write permission or write policy.
- The table is added to the `supabase_realtime` publication.

The state is global, not workspace-scoped. Once any Cloud or Hybrid client
observes maintenance, normal Supabase operations for Cloud and Hybrid workspaces
are deferred until the global state is cleared.

## Operator procedure

Apply the migration to the Supabase project **before** releasing an app version
that contains Maintenance Mode. Existing app versions do not query or subscribe
to this table and continue to behave as before.

Use a privileged database connection or another authorized server-side control
to switch the state. Do not grant ordinary app clients permission to update it.

```sql
-- Enable maintenance
update public.app_maintenance
set maintenance = true
where id = true;

-- End maintenance
update public.app_maintenance
set maintenance = false
where id = true;
```

The migration seeds the row. If the row is missing or the state cannot be read,
Cloud and Hybrid clients keep their startup gate closed and retry the read; they
do not assume maintenance is off. Restore the singleton row through an
authorized database operation if it was removed.

## Client lifecycle

### Startup

1. Atlas resolves the workspace data mode. A locally cached mode is used to
   start monitoring before the remote workspace metadata bootstrap when
   available.
2. For Cloud or Hybrid only, Atlas immediately marks the state as being checked
   and starts one dedicated Realtime channel for `public.app_maintenance`.
3. Atlas reads the singleton row after the channel is subscribed. A short
   fallback read covers a delayed Realtime subscription.
4. The state read happens after subscribing, so a change during startup is
   either reflected by the read or delivered as a Realtime event.
5. If the mode is Local or Demo, Atlas stops any prior monitor and does not read
   the maintenance table or open its Realtime channel.

The necessary authentication and workspace bootstrap requests can occur while
Atlas establishes the user and workspace mode. Once Cloud or Hybrid eligibility
is known, the maintenance check gates normal application data access before
workspace synchronization and warmup proceed.

### While maintenance is active

- `useNetworkStatus` reports the Cloud/Hybrid workspace as unavailable, so
  existing offline-aware data paths continue to write locally and enqueue work
  in the existing `offline_mutations` queue.
- The existing queue is preserved. Maintenance does not clear it, add a second
  queue, or alter its ordering, retry, or conflict rules.
- The Supabase request gate blocks REST, Storage, Functions, GraphQL, and normal
  Realtime traffic. The exact maintenance-table GET needed to check state remains
  available, as do Auth endpoints so the Supabase session remains intact.
- Existing non-maintenance Realtime channels are suspended and their original
  subscription arguments are retained. New normal subscriptions are deferred.
- The maintenance Realtime channel stays subscribed. If Realtime reports an
  error or timeout, Atlas retries state reads while keeping Cloud/Hybrid data
  access gated.
- The sticky status indicator shows a yellow warning background and the pending
  mutation count. It says “Maintenance Active,” not “Offline.”

### When maintenance ends

The listener receives the row change to `maintenance = false`, or a retry read
observes it. Atlas clears the artificial offline state, resumes suspended
Realtime subscriptions, and emits the same effective online transition used by
the normal reconnection path. The existing sync coordinator then runs its
ordinary synchronization process against the existing queue. The device must
have network connectivity; an actual offline device remains offline.

## Central implementation

- [`appMaintenanceState.ts`](../src/lib/appMaintenanceState.ts) holds the
  authoritative application state.
- [`appMaintenanceAccess.ts`](../src/lib/appMaintenanceAccess.ts) applies the
  Cloud/Hybrid eligibility check to central data-access and sync gates.
- [`appMaintenance.ts`](../src/services/appMaintenance.ts) owns the single
  state read and Realtime monitor, retry behavior, and workspace-mode lifecycle.
- [`supabaseMaintenanceGate.ts`](../src/lib/supabaseMaintenanceGate.ts) gates
  HTTP requests and suspends/resumes normal Supabase Realtime channels.
- [`syncEngine.ts`](../src/sync/syncEngine.ts) and
  [`syncCoordinator.ts`](../src/sync/syncCoordinator.ts) defer and resume the
  existing mutation synchronization flow.
- [`SyncStatusIndicator.tsx`](../src/ui/components/SyncStatusIndicator.tsx)
  renders the maintenance status and pending count.

The same Supabase client and auth session are retained. The Realtime monitor is
singular and is replaced only when the active workspace changes or monitoring
becomes ineligible.

## Verification

The maintenance developer suite is registered as `maintenance-mode` and covers
Cloud/Hybrid eligibility, Local isolation, migration constraints, request
blocking, Realtime lifecycle, and resynchronization coordination.

```sh
npx vitest run --pool=threads --maxWorkers=1 src/services/appMaintenance.test.ts src/lib/supabaseMaintenanceGate.test.ts src/services/appMaintenanceMigration.test.ts src/sync/syncCoordinator.test.ts

node scripts/dev-testing/cli.mjs --suite maintenance-mode
npm run type-check
```
