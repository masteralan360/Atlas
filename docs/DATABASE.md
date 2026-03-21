# Database Schema

## Overview

Atlas uses a **dual-database architecture**:

1. **Local**: Dexie.js (IndexedDB wrapper) for offline-first data access
2. **Cloud**: Supabase PostgreSQL for persistence and sync

Both databases share the same schema structure, with local tables including sync metadata fields.

---

## Local Database (Dexie.js)

### Schema Definition

Location: `src/local-db/database.ts`

```typescript
class AtlasDatabase extends Dexie {
  products!: Table<Product>
  categories!: Table<Category>
  customers!: Table<Customer>     // Legacy - removed in v1.6.6+
  orders!: Table<Order>           // Legacy - removed in v1.6.6+
  invoices!: Table<Invoice>
  sales!: Table<Sale>
  users!: Table<User>
  workspaces!: Table<Workspace>
  offlineMutations!: Table<OfflineMutation>
  syncQueue!: Table<SyncQueueItem>
  settings!: Table<AppSetting>

  constructor() {
    super('atlas-db')
    this.version(1).stores({
      products: 'id, workspaceId, sku, barcode, categoryId, syncStatus',
      categories: 'id, workspaceId, name, syncStatus',
      invoices: 'id, workspaceId, invoiceid, sequenceId, syncStatus',
      sales: 'id, workspaceId, cashierId, createdAt, syncStatus',
      users: 'id, workspaceId, email, syncStatus',
      workspaces: 'id, code, syncStatus',
      offlineMutations: 'id, workspaceId, entityType, status, createdAt',
      syncQueue: 'id, entityType, timestamp',
      settings: 'key'
    })
  }
}
```

---

## Entity Models

Location: `src/local-db/models.ts`

### Base Interfaces

```typescript
// Sync tracking fields
interface SyncMetadata {
  syncStatus: 'pending' | 'synced' | 'conflict'
  lastSyncedAt: string | null
  version: number
  isDeleted: boolean  // Soft delete marker
}

// Common fields for all entities
interface BaseEntity extends SyncMetadata {
  id: string          // UUID
  workspaceId: string
  createdAt: string   // ISO timestamp
  updatedAt: string
}
```

### Product

```typescript
interface Product extends BaseEntity {
  sku: string
  name: string
  description: string
  categoryId?: string
  category?: string        // Denormalized for display
  price: number
  costPrice: number
  quantity: number         // Current stock
  minStockLevel: number    // Low stock threshold
  unit: string             // e.g., 'pcs', 'kg'
  currency: 'usd' | 'eur' | 'iqd' | 'try'
  barcode?: string
  imageUrl?: string        // Local or remote path
  canBeReturned: boolean
  returnRules?: string
}
```

### Category

```typescript
interface Category extends BaseEntity {
  name: string
  description?: string
}
```

### Sale

```typescript
interface Sale extends BaseEntity {
  cashierId: string
  totalAmount: number
  settlementCurrency: CurrencyCode
  exchangeSource: string      // e.g., 'xeiqd', 'fallback'
  exchangeRate: number        // USD/IQD at time of sale
  exchangeRateTimestamp: string
  exchangeRates?: any[]       // Full snapshot for audit
  origin: string              // 'pos', 'manual', etc.
  payment_method?: 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay'
  sequenceId?: number         // Server-assigned sequential ID
  
  // Verification fields
  systemVerified: boolean
  systemReviewStatus: 'approved' | 'flagged' | 'inconsistent'
  systemReviewReason: string | null
  isReturned?: boolean
}
```

### SaleItem

```typescript
interface SaleItem {
  id: string
  saleId: string
  productId: string
  quantity: number
  unitPrice: number
  totalPrice: number
  costPrice: number
  convertedCostPrice: number
  originalCurrency: CurrencyCode
  originalUnitPrice: number
  convertedUnitPrice: number
  settlementCurrency: CurrencyCode
  negotiatedPrice?: number    // Custom price if discounted
  inventorySnapshot: number   // Stock at time of sale
  returnedQuantity?: number   // For partial returns
}
```

### Invoice

```typescript
interface Invoice extends BaseEntity {
  invoiceid: string          // Human-readable invoice number
  items: OrderItem[]
  subtotal: number
  discount: number
  total: number
  currency: CurrencyCode
  isSnapshot?: boolean       // True if created from print preview
  origin?: 'pos' | 'revenue' | 'inventory' | 'manual'
  cashierName?: string
  createdByName?: string
  printMetadata?: Record<string, unknown>
  sequenceId?: number
  printFormat?: 'a4' | 'receipt'
}
```

### Workspace

```typescript
interface Workspace extends BaseEntity {
  name: string
  code: string               // 8-char invite code
  default_currency: CurrencyCode
  iqd_display_preference: 'IQD' | 'د.ع'
  eur_conversion_enabled?: boolean
  try_conversion_enabled?: boolean
  locked_workspace: boolean  // Freeze all operations
  allow_pos: boolean
  allow_customers: boolean
  allow_orders: boolean
  allow_invoices: boolean
  allow_whatsapp?: boolean
  logo_url?: string | null
  max_discount_percent?: number
}
```

### OfflineMutation

```typescript
// Tracks pending changes for sync
interface OfflineMutation {
  id: string
  workspaceId: string
  entityType: 'products' | 'invoices' | 'sales' | 'categories' | 'workspaces'
  entityId: string
  operation: 'create' | 'update' | 'delete'
  payload: Record<string, unknown>
  createdAt: string
  status: 'pending' | 'syncing' | 'failed' | 'synced'
  error?: string
}
```

---

## Supabase Schema

Location: `supabase/schema.sql`

### Tables

| Table | Description |
|-------|-------------|
| `profiles` | User profiles with workspace association |
| `workspaces` | Workspace configuration and feature flags |
| `products` | Product catalog |
| `categories` | Product categories |
| `sales` | Transaction records |
| `sale_items` | Line items for each sale |
| `invoices` | Invoice snapshots |
| `sync_queue` | P2P file sync tracking |

### Key Relationships

```
workspaces
    ├── profiles (workspace_id)
    ├── products (workspace_id)
    ├── categories (workspace_id)
    ├── sales (workspace_id)
    │       └── sale_items (sale_id)
    ├── invoices (workspace_id)
    └── sync_queue (workspace_id)
```

### Row Level Security

All tables have RLS policies ensuring users can only access data within their workspace:

```sql
-- Example policy
CREATE POLICY "Users can only view their workspace products"
ON products FOR SELECT
USING (
  workspace_id = (
    SELECT workspace_id FROM profiles WHERE id = auth.uid()
  )
);
```

---

## Data Access Hooks

Location: `src/local-db/hooks.ts`

### Pattern

Each entity has a set of hooks:

```typescript
// Read with live updates
useProducts(workspaceId)    // Returns Product[]

// Single item
useProduct(id)              // Returns Product | undefined

// CRUD operations
createProduct(workspaceId, data)
updateProduct(id, data)
deleteProduct(id)           // Soft delete
```

### Example Usage

```typescript
function ProductList() {
  const { user } = useAuth()
  const products = useProducts(user?.workspaceId)
  
  const handleCreate = async (data: ProductFormData) => {
    await createProduct(user.workspaceId, data)
    // Local update is immediate, sync happens in background
  }
  
  return (
    <ul>
      {products.map(p => <li key={p.id}>{p.name}</li>)}
    </ul>
  )
}
```

---

## Sync Metadata

Every entity includes these fields for offline sync:

| Field | Type | Description |
|-------|------|-------------|
| `syncStatus` | enum | `pending`, `synced`, `conflict` |
| `lastSyncedAt` | timestamp | Last successful sync time |
| `version` | number | Incremented on each update |
| `isDeleted` | boolean | Soft delete flag |

Entities with `isDeleted: true` are:
- Hidden from UI queries
- Synced to cloud to propagate deletion
- Eventually purged by cleanup jobs
