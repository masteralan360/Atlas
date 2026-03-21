# Backend Architecture

Atlas uses a hybrid backend approach, combining **Supabase** (BaaS) for cloud operations and **Tauri** (Rust) for native desktop capabilities.

## Supabase (Cloud Backend)
Supabase acts as the central source of truth for the application. It handles:

1. **PostgreSQL Database**: Stores all synchronized data across workspaces.
2. **Row Level Security (RLS)**: Enforces strict data access rules. A user can only access data belonging to workspaces they are a member of.
3. **Authentication**: Manages user accounts using Email/Password and JWTs.
4. **RPC Functions (Remote Procedure Calls)**: Complex business logic is executed securely on the database level via PL/pgSQL functions.
   - Example: `complete_sale` processes a transaction, generates a sequential ID, and updates revenue in a single atomic transaction.
5. **Storage**: Manages file uploads (like PDF receipts or invoices).

## Tauri (Desktop Native Backend)
For Windows, macOS, and Linux, the application is wrapped in a Tauri shell (`src-tauri/`).
Features provided by the Tauri backend:
- **Performance**: Provides a low-overhead Chromium/WebKit webview.
- **Native OS APIs**: Access to filesystem, HTTP clients, and native dialogs without browser sandbox restrictions.
- **Auto-Updater**: Integrates with `@tauri-apps/plugin-updater` to seamlessly download and install new versions.
- **Hardware Integration**: Enhanced capabilities for barcode scanners and local thermal receipt printers (if configured).

## Sync Engine (`src/sync/`)
The bridge between the Frontend (IndexedDB) and the Backend (Supabase) is the Sync Engine.

### 1. Mutation Queue
Every local modification (Create, Update, Delete) is saved to an `offline_mutations` table in Dexie.
### 2. Push Process
When the app detects a connection to Supabase, it processes the queue sequentially, calling the appropriate Supabase APIs or RPCs.
### 3. Pull Process
The application queries Supabase for records modified *since the last successful sync timestamp*. It updates the local IndexedDB using a "Last Write Wins" strategy natively supported by the sync architecture.
