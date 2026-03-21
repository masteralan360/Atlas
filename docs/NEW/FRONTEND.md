# Frontend Architecture

The Atlas frontend is built as a Single Page Application (SPA) using React 18 and Vite. It serves as the core user interface for all platforms (Web, Desktop via Tauri, and Android). 

## Core Technologies
- **UI library**: React 18
- **Build tool**: Vite
- **Routing**: `wouter` (lightweight hook-based routing)
- **Styling**: Tailwind CSS v4 and `shadcn/ui` components
- **Icons**: `lucide-react`
- **Data Visualization**: `recharts` for dashboards
- **Localization**: `i18next` and `react-i18next`

## Key Directories (`src/`)
- `ui/`: Contains all visual elements with a clear separation between `components/` (reusable UI pieces) and `pages/` (route-level views).
- `auth/`: Supabase authentication context and Protected/Guest route wrappers.
- `local-db/`: Dexie.js IndexedDB implementation containing data models and local operations.
- `sync/`: Sync Engine orchestrating data flow between Dexie and Supabase.
- `workspace/`: Context providers for multi-workspace selection and settings.
- `context/`: Additional application contexts (e.g., ExchangeRates, DateRanges).
- `services/`: Core logic abstractions like platform detection.

## State Management and Data Flow
As an offline-first application, the primary source of state is the **local database (IndexedDB)** managed by Dexie.js.

1. **Reading Data**: React components use the `useLiveQuery` hook from `dexie-react-hooks` to subscribe to local database queries. When the local data changes, the UI updates almost instantaneously.
2. **Writing Data**: User actions trigger mutations to the local IndexedDB. 
3. **Synchronization**: After a local mutation is successful, the Sync Engine queues the action in an `offline_mutations` table and attempts to push it to Supabase in the background.

## UI Design & Theming
The project heavily utilizes customizable design tokens via the `ThemeProvider`. It supports Dark/Light mode and multiple thematic styles (e.g., Primary, Legacy).

## Page Structure & Routing
Important pages:
- `/dashboard`: Eagerly loaded. Overview metrics and charts.
- `/pos`: Eagerly loaded. High-performance Point of Sale interface.
- `/products`, `/customers`, `/suppliers`: CRUD interfaces for core entities.
- `/orders` & `/invoices-history`: Transaction history and processing.
- `/settings` & `/admin`: Configuration and multi-workspace management. 

Pages are lazy-loaded on web/mobile platforms using React's `Suspense`, but eagerly loaded on the Tauri desktop build to optimize for responsiveness.
