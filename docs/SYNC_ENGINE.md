# Sync Engine

## Overview

The Atlas sync engine enables **offline-first operation**. It ensures that data is always available locally in IndexedDB and is lazily synchronized with the Supabase cloud.

Location: `src/sync/`

---

## Sync Methodology

1. **Local-First Write**: All changes are written to IndexedDB immediately via Dexie.js.
2. **Mutation Queue**: Every change creates an `offline_mutation` record marked as `pending`.
3. **Background Push**: Pending mutations are pushed to Supabase when the connection is stable.
4. **Differential Pull**: Remote changes are pulled by fetching records where `updated_at > last_sync_time`.

---

## Active Resilience (Auto-Recovery)

The sync engine is integrated with the **Connection Manager** to recover from network interruptions automatically.

### 1. Auto-Sync on Reconnect
When the `ConnectionManager` detects the transition from offline to online, it triggers a sync attempt after a 3-second "stabilization" delay. This ensures that any changes made while the user was offline are pushed immediately without user intervention.

### 2. Auto-Sync on Wake
When the user returns to the app after 10+ minutes of idle time, the sync engine checks if a sync is needed. If the last sync was more than 10 minutes ago, a background sync is triggered.

### 3. Exponential Backoff
If a sync fails due to a network error, the engine retries up to 3 times with increasing delays (5s, 15s, 30s) before returning to an `idle` state.

---

## Key Components

### `syncEngine.ts`
The core logic for processing the mutation queue and pulling down changed records. It handles the `snake_case` (Supabase) to `camelCase` (JS) conversion and basic conflict resolution (last-write-wins).

### `useSyncStatus.ts`
The primary React hook used by the UI to monitor sync state. It provides `pendingCount`, `syncState` (idle, syncing, error), and triggers the auto-recovery logic.

### `useNetworkStatus.ts`
A unified hook that subscribes to the `ConnectionManager` to provide a single source of truth for the application's online/offline state.

---

## Conflict Resolution

Atlas uses a **Last-Write-Wins (LWW)** strategy by default. 
- Records have a `version` number.
- Remote updates with a higher version number or more recent `updated_at` timestamp will overwrite local changes unless the local change is still in the `pending` mutation queue.
- If a mutation fails due to a conflict, it is flagged for manual review or automatic retry depending on the error code.
