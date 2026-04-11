# Authentication System

## Overview

Atlas uses **Supabase Auth** for authentication with a custom workspace-based authorization model. The system is hardened with an **Active Resilience** layer to ensure session stability even during network drops or long idle periods.

---

## Authentication Flow

### Sign Up
1. User enters email, password, name, passkey.
2. Passkey validated against the active one-time registration key for the selected role.
3. Supabase creates `auth.users` record.
4. Database trigger creates `profiles` record with `workspace_id`.
5. The submitted passkey is stripped from auth metadata and all three role registration keys rotate.
6. User redirected to dashboard.

### Sign In
1. User enters email, password.
2. Supabase validates credentials.
3. Session created with JWT.
4. `AuthContext` loads profile from Supabase and hydrates the "Recovery Bridge".
5. User redirected to appropriate page.

---

## Files

| File | Purpose |
|------|---------|
| `src/auth/supabase.ts` | Supabase client initialization |
| `src/auth/AuthContext.tsx` | Auth state management & Resilience Watchdog |
| `src/auth/ProtectedRoute.tsx` | Route guards & Role/Feature checks |
| `src/auth/index.ts` | Public exports |

---

## Active Resilience (Self-Healing)

The authentication layer is designed to proactively recover from session expiry or network interruptions. Detailed architecture can be found in [docs/RESILIENCE.md](RESILIENCE.md).

### 1. Session Watchdog
A background process in `AuthContext` checks the token expiry every 5 minutes. If the token is set to expire in less than 2 minutes, it proactively calls `refreshSession()` to prevent the user from being kicked out mid-operation.

### 2. Wake Handler
Whenever the application returns from an idle state (e.g., computer wakes from sleep or tab returns to focus after 1+ minute), the `AuthContext` verifies the session validity. If the session has invalidated during sleep, it attempts a silent refresh.

### 3. Recovery Bridge
To prevent application crashes or blank screens during network failures, essential user metadata is persisted to encrypted LocalStorage with a **7-day expiration**. This allows the UI to hydrate immediately even if the initial Supabase handshake is delayed.

---

## User Roles

| Role | Permissions |
|------|-------------|
| `admin` | Full access to all features, settings, members |
| `staff` | POS, sales, products, limited settings |
| `viewer` | Read-only access to dashboard and reports |

---

## Security Model

1. **Row Level Security (RLS)**: Users only access data within their `workspace_id`.
2. **Encrypted Persistence**: Local session metadata is encrypted using AES-256 via the `VITE_ENCRYPTION_KEY`.
3. **Passkey System**: Registration is restricted by one-time role keys stored in `public.keys`, and every successful signup rotates the full key set.
4. **Graceful Degradation**: Token refresh failures trigger a toast notification and a clean sign-out rather than hard crashes.
