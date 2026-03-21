# Atlas Documentation

> Comprehensive documentation for the Atlas offline-first ERP/POS system.

## Quick Navigation

| Document | Description |
|----------|-------------|
| [OVERVIEW.md](./OVERVIEW.md) | Project overview, architecture, and key concepts |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Detailed system architecture and data flow |
| [DATABASE.md](./DATABASE.md) | Local and cloud database schemas |
| [SYNC_ENGINE.md](./SYNC_ENGINE.md) | Offline sync and conflict resolution |
| [AUTHENTICATION.md](./AUTHENTICATION.md) | Auth system, roles, and workspace management |
| [FEATURES.md](./FEATURES.md) | Feature modules and their implementation |
| [NOTIFICATION_POPUP_SYSTEM.md](./NOTIFICATION_POPUP_SYSTEM.md) | Scalable registry-driven notification popup system |
| [API_REFERENCE.md](./API_REFERENCE.md) | Supabase functions and API endpoints |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Build and deployment instructions |

## Project Summary

**Atlas** is a multi-platform, offline-first Enterprise Resource Planning and Point-of-Sale system built with:

- **Frontend**: React 18 + TypeScript + Vite
- **Desktop**: Tauri 2.x (Windows/macOS/Linux)
- **Mobile**: Tauri Android (with iOS support planned)
- **Database**: Dexie.js (IndexedDB) for local, Supabase (PostgreSQL) for cloud
- **Styling**: Tailwind CSS + shadcn/ui components

## Version

Current: **v1.6.6**
