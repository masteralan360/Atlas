# Atlas Overview

## What is Atlas?

Atlas is an **offline-first Enterprise Resource Planning (ERP) and Point-of-Sale (POS) system** designed for retail businesses. It works fully offline with local data storage and automatically handles synchronization and session recovery via an **Active Resilience** system.

---

## Key Features

### 🛡️ Active Resilience (Self-Healing)
- **Centralized Connection Management**: Real-time monitoring of network, tab visibility, and heartbeats.
- **Session Watchdog**: Proactive token refresh before expiry to prevent session drops.
- **Recovery Bridge**: 7-day local session persistence for instant hydration even when offline.
- **Auto-Sync Recovery**: Automatic background sync on network reconnection or app wake events.

### 🛒 Point of Sale (POS)
- Fast product lookup via search, SKU, or barcode scanning.
- Category-based product filtering.
- Multi-currency support (USD, EUR, IQD, TRY) with real-time rate integration.
- Keyboard navigation for rapid checkout.

### 🔄 Data Synchronization
- Local-first architecture (Dexie.js + IndexedDB).
- Background delta-sync with Supabase.
- Conflict resolution with version tracking.
- P2P image/media sync across workspace devices.

### 👥 Team & Workspace
- Multi-user environments with Role-Based Access Control (RBAC).
- Workspace isolation via Supabase RLS.
- Real-time propagation of workspace settings and feature flags.

---

## Technology Stack

| Layer | Technology |
|-------|------------|
| **Framework** | React 18 + TypeScript |
| **Desktop Runtime** | Tauri 2.x |
| **Database** | Dexie.js (Local) + Supabase (Cloud) |
| **Styling** | Tailwind CSS + shadcn/ui |
| **Realtime** | Supabase Realtime (WebSockets) |
| **Notifications** | Novu |

---

## Core Concepts

### Offline-First
All write operations are finalized locally immediately and queued for background synchronization. This ensures the app is always fast and works perfectly in areas with unstable internet.

### Active Resilience
The app "heals" itself. If a connection is lost, it waits for reconnection; if a session is idle, it refreshes the token; if a workspace update happens elsewhere, it's reflected locally without a page refresh.

### Security
Data is encrypted at rest using AES-256 (CryptoJS) and protected in transit via JWT and RLS. The system supports custom encryption keys via environment variables for maximum privacy.
