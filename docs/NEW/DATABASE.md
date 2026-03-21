# Database Architecture

The data architecture in Atlas is designed to support multi-tenancy (workspaces), offline-first availability, and robust transaction integrity. It operates simultaneously across **IndexedDB (Local)** and **PostgreSQL (Remote)**.

## Core Principles
1. **Workspace Isolation**: Every major entity is tied to a `workspace_id`. Cross-workspace data bleed is prevented heavily via Supabase Row-Level Security (RLS).
2. **Sync Metadata**: Almost every table includes columns essential for synchronization:
   - `updated_at`: The timestamp used to determine delta pulls.
   - `sync_status`: Tracked locally (`pending`, `synced`, `conflict`).
   - `is_deleted`: Soft-delete flag.
3. **Immutability of Transactions**: Sales, Invoices, and Orders store historical snapshots of product prices, quantities, and exchange rates at the time of the transaction, ensuring reports don't change if a product's price is updated later.

## Key Entities

### 1. Workspaces & Users
- **Workspaces**: Represents a tenant/business. Holds configuration like `default_currency`, UI preferences, and feature flags.
- **Users**: Defines staff members. Links a universal Auth user securely to specific Workspaces with specific Roles (`admin`, `staff`, `viewer`).

### 2. Inventory Management
- **Products**: Core inventory item. Includes `sku`, `price`, `costPrice`, multi-currency mapping, and references to `Category` and `Storage`.
- **Categories**: Grouping mechanism for Products.
- **Storages**: Warehouse or shop locations for inventory.
- **Inventory Transfers**: (Implementation details in `src/ui/pages/InventoryTransfer`)

### 3. Sales & Point of Sale
- **Sales**: The metadata for a POS transaction (Cashier, total, currency, payment method, exchange rates at the time).
- **Sale Items**: The line items for a Sale, capturing the exact `unitPrice` and `costPrice` at the moment of checkout for accurate profit margin calculations.

### 4. Supply Chain
- **Suppliers & Customers**: Contact directories with tracking for total spent/ordered and outstanding balances.
- **Purchase Orders**: B2B purchases from Suppliers to replenish inventory.
- **Sales Orders**: B2B or B2C tracked sales to Customers.

### 5. Financial & HR
- **Expenses**: Tracking operational costs (recurring or one-time).
- **Employees**: HR records linking to salaries and performance tracking.
- **Budget Allocations**: Monthly financial limits for different departments.

*For precise schema types see `src/local-db/models.ts` and `supabase/schema.sql`.*
