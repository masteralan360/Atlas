# System Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Atlas Application                        │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   React UI  │  │   Wouter    │  │   i18next Translations  │  │
│  │  (Pages +   │  │  (Router)   │  │   (EN / AR / KU)        │  │
│  │ Components) │  │             │  │                         │  │
│  └──────┬──────┘  └──────┬──────┘  └────────────┬────────────┘  │
│         │                │                       │               │
│  ┌──────▼────────────────▼───────────────────────▼────────────┐ │
│  │                    Context Layer                            │ │
│  │  AuthContext │ WorkspaceContext │ ExchangeRateContext      │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
│                             │                                    │
│  ┌──────────────────────────▼──────────────────────────────────┐ │
│  │                  Active Resilience Layer                    │ │
│  │           ConnectionManager (Online / Wake / Heartbeat)     │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
│                             │                                    │
│  ┌──────────────────────────▼──────────────────────────────────┐ │
│  │                    Local Database                            │ │
│  │              Dexie.js (IndexedDB Wrapper)                   │ │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐           │ │
│  │  │Products │ │  Sales  │ │Invoices │ │ etc...  │           │ │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘           │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
│                             │                                    │
│  ┌──────────────────────────▼──────────────────────────────────┐ │
│  │                    Sync Engine                               │ │
│  │  OfflineMutations → Push Queue → Supabase API               │ │
│  └──────────────────────────┬──────────────────────────────────┘ │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │     Supabase      │
                    │  ┌─────────────┐  │
                    │  │ PostgreSQL  │  │
                    │  │   + RLS     │  │
                    │  └─────────────┘  │
                    │  ┌─────────────┐  │
                    │  │    Auth     │  │
                    │  └─────────────┘  │
                    │  ┌─────────────┐  │
                    │  │  Realtime   │  │
                    │  └─────────────┘  │
                    │  ┌─────────────┐  │
                    │  │   Storage   │  │
                    │  └─────────────┘  │
                    └───────────────────┘
```

## Data Flow

### Write Operations (Create/Update/Delete)

```
User Action
    │
    ▼
┌─────────────────┐
│ Local Hook Call │  e.g., createProduct(), updateSale()
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  IndexedDB Put  │  Immediate local persistence
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│ OfflineMutation Created │  Queued for sync
│ status: 'pending'       │
└────────┬────────────────┘
         │
         ▼ (when online)
┌─────────────────────────┐
│   Sync Engine Push      │
│   Supabase Upsert       │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Mutation status: synced │
└─────────────────────────┘
```

### Read Operations

```
React Component mounts
    │
    ▼
┌──────────────────────────┐
│ useLiveQuery() Hook      │  Dexie reactive query
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│ IndexedDB Query          │  Local data returned immediately
└────────┬─────────────────┘
         │
         ▼ (optional background fetch)
┌──────────────────────────┐
│ Supabase Select          │  Pull fresh data if online
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│ IndexedDB Update         │  Merge remote changes
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│ React Re-render          │  useLiveQuery auto-updates
└──────────────────────────┘
```

## Key Modules

### 1. Authentication (`src/auth/`)

| File | Purpose |
|------|---------|
| `supabase.ts` | Supabase client initialization, encryption setup |
| `AuthContext.tsx` | Auth state management, sign in/up/out, session watchdog |
| `ProtectedRoute.tsx` | Route guards with role and feature checks |

### 2. Resilience System (`src/lib/connectionManager.ts`)

Centralized event bus for the "Active Resilience" system. See [docs/RESILIENCE.md](RESILIENCE.md) for details.

| Feature | Description |
|---------|-------------|
| **Heartbeat** | 30s background ping to verify connectivity |
| **Wake Detection** | Triggers recovery when tab/app returns from idle |
| **Visibility Tracking** | Monitors `visibilitychange` and `focus` events |

### 3. Local Database (`src/local-db/`)

| File | Purpose |
|------|---------|
| `database.ts` | Dexie schema definition (11 tables) |
| `models.ts` | TypeScript interfaces for all entities |
| `hooks.ts` | CRUD hooks for each entity type |
| `settings.ts` | App-level key-value settings |

### 3. Sync Engine (`src/sync/`)

| File | Purpose |
|------|---------|
| `syncEngine.ts` | Push mutations, pull changes, conflict resolution |
| `syncQueue.ts` | Mutation queue management |
| `useSyncStatus.ts` | React hook for sync UI state |
| `useOnlineStatus.ts` | Network connectivity detection |

### 4. Workspace Management (`src/workspace/`)

| File | Purpose |
|------|---------|
| `WorkspaceContext.tsx` | Feature flags, workspace settings, branding |

### 5. Exchange Rates (`src/lib/exchangeRate.ts`)

Multi-source exchange rate fetching with fallbacks:
- Primary: XE.IQD, Forexfy
- Fallback: DolarDinar, ExchangeGlobal
- Supports USD/EUR/TRY to IQD conversions

### 6. P2P Sync (`src/lib/p2pSyncManager.ts`)

Store-and-forward image sync between workspace devices:
- Uses Supabase Storage as temporary buffer
- 48-hour TTL for sync items
- Realtime subscription for new uploads
- Tauri file system integration for downloads

## Page Modules

| Page | Route | Description |
|------|-------|-------------|
| Dashboard | `/` | Overview stats, low stock, recent sales |
| POS | `/pos` | Point of sale checkout interface |
| Sales | `/sales` | Transaction history, returns, receipts |
| Revenue | `/revenue` | Net profit analytics, date filtering |
| Products | `/products` | Product CRUD, categories, stock |
| Members | `/members` | Team management, invitations |
| Settings | `/settings` | Workspace and user preferences |
| Admin | `/admin` | Super-admin workspace management |

## Tauri Integration

### Desktop Features

- **Window Vibrancy**: Acrylic/Mica effects on Windows
- **Custom Title Bar**: Draggable with window controls
- **Auto Updates**: GitHub releases with delta updates
- **File System**: Local image storage and retrieval
- **Native HTTP**: CORS-free API requests

### Tauri Plugins Used

| Plugin | Purpose |
|--------|---------|
| `tauri-plugin-fs` | Local file read/write |
| `tauri-plugin-dialog` | Native file picker, alerts |
| `tauri-plugin-http` | Native HTTP client |
| `tauri-plugin-updater` | In-app updates |
| `tauri-plugin-shell` | System command execution |
| `tauri-plugin-process` | App process management |

## Security Model

### Row Level Security (RLS)

All Supabase tables enforce RLS policies:
- Users can only access data within their `workspace_id`
- Policies check `auth.uid()` against `profiles.workspace_id`

### Passkey System

- Workspaces have admin and member passkeys
- Required for user registration
- Stored encrypted in Supabase

### Data Encryption

- Sensitive environment variables encrypted at rest
- AES-256 via CryptoJS for config storage
