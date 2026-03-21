# Active Resilience System

## Overview

The Atlas Active Resilience System is a multi-layered self-healing architecture designed to eliminate the need for hard refreshes after idle periods or network interruptions. It proactively monitors connection state and application health to ensure a seamless experience.

---

## Core Component: Connection Manager

Location: `src/lib/connectionManager.ts`

The **Connection Manager** is the "heartbeat" of the application. It acts as a centralized event bus that unifies various browser and system events.

### Monitored Events
- **Network**: `online` / `offline` browser events.
- **Visibility**: `visibilitychange` (tab switches).
- **Focus**: `focus` / `blur` (window switching).
- **Heartbeat**: A periodic background ping (every 30s) to verify actual internet connectivity.

### Key Logic: Heartbeat Stability
To avoid false-offline flickers, the heartbeat uses:
- **10s Timeout**: Forgiving of slow network wake-ups.
- **2-Failure Threshold**: Only marks the app as "offline" if two consecutive pings fail.
- **Immediate Reset**: Any successful ping resets the failure counter.

---

## Resilience Layers

### 1. Auth Layer Hardening
**Location**: `src/auth/AuthContext.tsx`

- **Wake Handler**: Automatically verifies and refreshes the Supabase session whenever the tab returns from a "wake" state (idle > 1 min).
- **Session Watchdog**: A background process that checks the token expiry every 5 minutes. If the token expires in < 2 minutes, it proactively triggers a refresh.
- **Recovery Bridge**: Saves essential user metadata to LocalStorage with a 7-day TTL. This allows the UI to hydrate and function even if the network fails during the initial session fetch.

### 2. Workspace Layer Hardening
**Location**: `src/workspace/WorkspaceContext.tsx`

- **Live Updates**: Uses Supabase Realtime (Postgres Changes) to instantly reflect workspace settings or feature flag changes across all devices.
- **Silent Refresh**: Background re-fetch of workspace features on "wake" events as a fallback for WebSocket disconnection.

### 3. Sync Layer Auto-Recovery
**Location**: `src/sync/useSyncStatus.ts`

- **Auto-Sync on Reconnect**: Automatically triggers a `push` of all pending mutations once the `ConnectionManager` emits an `online` event.
- **Auto-Sync on Wake**: Triggers a sync if the app has been idle and the last sync was more than 10 minutes ago.
- **Exponential Backoff**: If a sync fails, it retries up to 3 times (5s, 15s, 30s intervals).

### 4. Notification Reconnection
**Location**: `src/ui/components/NotificationCenter.tsx`

- **Provider Remounting**: Uses a `reconnectKey` to force-remount the `NovuProvider` whenever a "wake" or "online" event is detected, ensuring the WebSocket connection is fresh.

---

## Security Integration

### Encrypted Local Storage
**Location**: `src/lib/encryption.ts`

Local data persistence is secured via AES-256 encryption.
- **Configuration**: Managed via `VITE_ENCRYPTION_KEY` environment variable.
- **Backward Compatibility**: If no env var is found, it safely falls back to a legacy internal key, ensuring existing sessions aren't broken during migration.
