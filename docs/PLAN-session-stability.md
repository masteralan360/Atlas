# PLAN: Session & Network Stability Improvements

This plan addresses the issue where long idle periods lead to connection loss and subsequent logouts on refresh.

## User Review Required

> [!IMPORTANT]
> To properly debug why the session is lost on refresh, we may need to add diagnostic telemetry to `AuthProvider`.
>
> **Questions:**
> 1. Does the logout happen on all devices (Browser, Electron, Mobile) or just one?
> 2. When you refresh and are logged out, does it happen instantly or after a "Loading" spinner?

## Proposed Changes

### Auth & Security

#### [MODIFY] [AuthContext.tsx](file:///e:/ERP%20System/Atlas/src/auth/AuthContext.tsx)
- Add detailed logging for `onAuthStateChange` events to identify if a specific "SIGNED_OUT" or "TOKEN_REFRESHED" event is failing.
- Implement a **Session Recovery Bridge**: Store the last known `workspaceId` and `user.id` in a secondary, persistent storage. If `supabase.auth.getSession()` fails on init, attempt one silent retry before giving up.

#### [MODIFY] [supabase.ts](file:///e:/ERP%20System/Atlas/src/auth/supabase.ts)
- Audit `EncryptedStorage`. Ensure the key used for encryption is stable across sessions and doesn't change based on dynamic machine properties that might fluctuate (if any).
- Add error handling to `decrypt` - if a session exists but cannot be decrypted, log the error instead of silently returning `null`.

### Network & Performance

#### [MODIFY] [useNetworkStatus.ts](file:///e:/ERP%20System/Atlas/src/hooks/useNetworkStatus.ts)
- Add a "Session Heartbeat". Every 5-10 minutes, verify the Supabase session is still active and valid.
- If the session is near expiry, trigger `refreshSession()` proactively.

## Verification Plan

### Automated Tests
- Run `npm run preview` and simulate network disconnection to see if session persists.
- Monitor `localStorage` keys for `supabase.auth.token`.

### Manual Verification
- Leave the app open idle for 1+ hour, then refresh. 
- Verify with Browser DevTools (Application Tab) if the encrypted session is still present before the refresh.
