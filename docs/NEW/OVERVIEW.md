# Atlas Project Overview

## Introduction
Atlas is a modern, **offline-first** Enterprise Resource Planning (ERP) and Point-of-Sale (POS) system. It is designed to work seamlessly without internet connectivity while ensuring data is synchronized when back online. It targets multiple platforms including Windows, macOS, Linux, Android, and Web.

## Key Features
- **Offline-First Point of Sale**: Lightning-fast checkout, barcode scanning, keyboard navigation.
- **Product & Inventory Management**: Stock tracking, low-stock alerts, and multi-storage support.
- **Multi-Currency**: Native support for USD, EUR, IQD, and TRY with real-time exchange rates.
- **Revenue Analytics**: Comprehensive tracking of net profit, margins, and cashier performance.
- **Team & Workspace Management**: Role-based access control, employee targets, and complete workspace isolation.
- **Multi-Language Support**: Fully localized in English, Arabic, and Kurdish.

## Architecture

Atlas uses a robust offline-first architecture to provide high availability and fast performance:

- **Local Database (IndexedDB)**: The application reads and writes primarily to a local Dexie.js database. This ensures zero latency for operations like scanning items or creating sales.
- **Sync Engine**: A custom built synchronization engine (`src/sync/`) manages communication between the local IndexedDB and the remote Supabase PostgreSQL database. It queues offline mutations and pushes them when connectivity is restored.
- **Remote Database (Supabase)**: Serves as the central source of truth, managing user authentication, row-level security (RLS), and providing real-time data for synchronized clients.

## Technology Stack

### Frontend & UI
- **Framework**: React 18 with TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS v4, shadcn/ui components
- **Routing**: wouter
- **Localization**: i18next
- **Data Visualization**: Recharts

### Desktop & Mobile
- **Core**: Tauri 2.x (Rust-based)
- **Platforms**: Windows (`nsis`), macOS, Linux, Android

### Data Layer
- **Local DB**: Dexie.js (wrapper around IndexedDB)
- **Cloud/Backend**: Supabase
  - PostgreSQL Database
  - Supabase Auth (JWT, Row-Level Security)
  - Supabase Storage (PDFs, Images)

## Directory Structure
- `src/`: Core React application (Frontend, Sync Engine, Local DB, UI Components)
- `src-tauri/`: Tauri Rust backend for desktop and Android applications
- `supabase/`: SQL migrations, RPC functions, and database schema definitions
- `docs/NEW/`: Up-to-date documentation for the project
- `public/`: Static assets including icons and translation fallbacks
