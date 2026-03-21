# Plan: Suppliers, Customers & Orders System

> **Version:** 1.0  
> **Created:** 2026-02-03  
> **Status:** PLANNING  
> **Project Type:** WEB (Tauri + React)

---

## Overview

Implement three new interconnected modules for the Atlas ERP system:

1. **Suppliers** - Manage vendors who supply products to restock inventory
2. **Customers** - Manage customer accounts with order history and credit tracking
3. **Orders** - Unified order management for both purchase orders (from suppliers) and sales orders (to customers)

### Key Decisions Made

| Question | Decision |
|----------|----------|
| Supplier flow | Purchase Orders - Suppliers sell TO the business (restocking inventory) |
| Customer orders | Pre-paid reservations - Reserve products, pay later, fulfill separately |
| Currency | Per-entity default currency with auto-conversion and historical rate storage |
| Supplier-Product link | Any product can be bought from any supplier (record supplier per transaction) |
| Order status | Manual status changes with automatic delivery date tracking |

---

## Success Criteria

| Criteria | Measurement |
|----------|-------------|
| Suppliers CRUD | Create, read, update, delete suppliers with currency |
| Customers CRUD | Create, read, update, delete customers with currency and history |
| Purchase Orders | Buy products from suppliers → Increase inventory |
| Sales Orders | Sell products to customers → Reserve stock, fulfill, deliver |
| Multi-Currency | Live exchange rate conversion at order creation |
| Offline-First | All operations work offline, sync when online |
| Order Status | pending → confirmed → processing → shipped → delivered |
| Historical Rates | Exchange rates snapshot stored per order |

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Frontend | React 18 + TypeScript | Existing stack |
| State | Dexie.js (IndexedDB) | Offline-first, existing pattern |
| Cloud | Supabase PostgreSQL | Existing sync infrastructure |
| Styling | Tailwind CSS + shadcn/ui | Consistent with existing UI |
| Exchange Rates | Existing `exchangeRate.ts` | Multi-source rate fetching |

---

## File Structure

```
src/
├── local-db/
│   ├── models.ts              [MODIFY] Add Supplier, update Customer/Order interfaces
│   ├── database.ts            [MODIFY] Add suppliers, purchaseOrders tables
│   └── hooks.ts               [MODIFY] Add supplier/order hooks
│
├── ui/
│   ├── pages/
│   │   ├── Suppliers.tsx      [NEW] Supplier management page
│   │   ├── Customers.tsx      [NEW] Customer management page
│   │   ├── Orders.tsx         [NEW] Unified orders page (purchase + sales)
│   │   └── index.ts           [MODIFY] Export new pages
│   │
│   └── components/
│       ├── orders/            [NEW] Order-related components
│       │   ├── OrderForm.tsx
│       │   ├── OrderDetails.tsx
│       │   ├── OrderStatusBadge.tsx
│       │   └── CurrencyConverter.tsx
│       │
│       ├── suppliers/         [NEW] Supplier components
│       │   ├── SupplierForm.tsx
│       │   └── SupplierCard.tsx
│       │
│       └── customers/         [NEW] Customer components
│           ├── CustomerForm.tsx
│           └── CustomerCard.tsx
│
├── sync/
│   └── syncEngine.ts          [MODIFY] Add suppliers, purchaseOrders sync
│
└── App.tsx                    [MODIFY] Add routes
```

### Supabase Schema

```
supabase/
├── migrations/
│   └── YYYYMMDD_suppliers_customers_orders.sql  [NEW]
```

---

## Data Models

### Supplier

```typescript
interface Supplier extends BaseEntity {
  name: string
  contactName?: string
  email?: string
  phone?: string
  address?: string
  city?: string
  country?: string
  defaultCurrency: CurrencyCode        // Their preferred currency
  notes?: string
  totalPurchases: number               // Running total of purchase orders
  totalSpent: number                   // Running total amount spent
}
```

### Customer (Enhanced)

```typescript
interface Customer extends BaseEntity {
  name: string
  email?: string
  phone: string
  address?: string
  city?: string
  country?: string
  defaultCurrency: CurrencyCode        // Their preferred currency
  notes?: string
  totalOrders: number                  // Count of orders
  totalSpent: number                   // Total amount from completed orders
  outstandingBalance: number           // Unpaid amount
}
```

### PurchaseOrder (Buy from Supplier)

```typescript
interface PurchaseOrder extends BaseEntity {
  orderNumber: string                  // PO-YYYYMMDD-XXX
  supplierId: string
  supplierName: string                 // Denormalized
  items: PurchaseOrderItem[]
  subtotal: number
  discount: number
  total: number
  currency: CurrencyCode               // Order currency (supplier's default)
  
  // Exchange rate snapshot
  exchangeRate: number
  exchangeRateSource: string
  exchangeRateTimestamp: string
  exchangeRates?: any[]                // Full snapshot for audit
  
  // Status
  status: PurchaseOrderStatus
  expectedDeliveryDate?: string
  actualDeliveryDate?: string          // Auto-set when status = 'delivered'
  
  // Payment
  isPaid: boolean
  paidAt?: string
  paymentMethod?: string
  
  notes?: string
}

type PurchaseOrderStatus = 
  | 'draft'
  | 'pending'
  | 'confirmed'
  | 'shipped'
  | 'delivered'
  | 'cancelled'

interface PurchaseOrderItem {
  id: string
  productId: string
  productName: string
  productSku: string
  quantity: number
  unitCost: number                     // Cost per unit in order currency
  totalCost: number
  originalCurrency: CurrencyCode       // Product's original currency
  originalUnitCost: number             // Original cost before conversion
  convertedUnitCost: number            // Converted to order currency
  receivedQuantity?: number            // For partial deliveries
}
```

### SalesOrder (Sell to Customer)

```typescript
interface SalesOrder extends BaseEntity {
  orderNumber: string                  // SO-YYYYMMDD-XXX
  customerId: string
  customerName: string                 // Denormalized
  items: SalesOrderItem[]
  subtotal: number
  discount: number
  tax: number
  total: number
  currency: CurrencyCode               // Order currency (customer's default)
  
  // Exchange rate snapshot
  exchangeRate: number
  exchangeRateSource: string
  exchangeRateTimestamp: string
  exchangeRates?: any[]
  
  // Status
  status: SalesOrderStatus
  expectedDeliveryDate?: string
  actualDeliveryDate?: string          // Auto-set when status = 'delivered'
  
  // Payment
  isPaid: boolean
  paidAt?: string
  paymentMethod?: 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay' | 'credit'
  
  // Reservation
  reservedAt: string                   // When stock was reserved
  
  shippingAddress?: string
  notes?: string
}

type SalesOrderStatus = 
  | 'pending'        // Created, awaiting confirmation
  | 'confirmed'      // Customer confirmed, stock reserved
  | 'processing'     // Being prepared
  | 'shipped'        // Out for delivery
  | 'delivered'      // Completed
  | 'cancelled'      // Cancelled (stock unreserved)
  | 'returned'       // Returned after delivery

interface SalesOrderItem {
  id: string
  productId: string
  productName: string
  productSku: string
  quantity: number
  unitPrice: number
  totalPrice: number
  costPrice: number                    // For profit calculation
  originalCurrency: CurrencyCode
  originalUnitPrice: number
  convertedUnitPrice: number
  reservedQuantity: number             // Amount reserved from inventory
  fulfilledQuantity?: number           // Amount actually delivered
}
```

---

## Task Breakdown

### Phase 1: Database Foundation

#### Task 1.1: Update Data Models
- **Agent:** backend-specialist
- **Skills:** database-design, clean-code
- **Priority:** P0
- **Dependencies:** None
- **INPUT:** Existing `models.ts`
- **OUTPUT:** Updated `models.ts` with Supplier, enhanced Customer, PurchaseOrder, SalesOrder interfaces
- **VERIFY:** TypeScript compiles without errors

#### Task 1.2: Update Dexie Schema
- **Agent:** backend-specialist
- **Skills:** database-design
- **Priority:** P0
- **Dependencies:** Task 1.1
- **INPUT:** Existing `database.ts`
- **OUTPUT:** Updated schema with suppliers, purchaseOrders, salesOrders tables
- **VERIFY:** Database version upgraded, tables created on app start

#### Task 1.3: Create Supabase Migration
- **Agent:** backend-specialist
- **Skills:** database-design
- **Priority:** P0
- **Dependencies:** Task 1.1
- **INPUT:** Data models
- **OUTPUT:** SQL migration file with tables, indexes, RLS policies
- **VERIFY:** Migration applies without errors

---

### Phase 2: Data Access Layer

#### Task 2.1: Supplier Hooks
- **Agent:** backend-specialist
- **Skills:** react-patterns, clean-code
- **Priority:** P1
- **Dependencies:** Task 1.2
- **INPUT:** Dexie schema
- **OUTPUT:** `useSuppliers()`, `useSupplier()`, `createSupplier()`, `updateSupplier()`, `deleteSupplier()` hooks
- **VERIFY:** CRUD operations work offline, sync to cloud

#### Task 2.2: Customer Hooks (Enhanced)
- **Agent:** backend-specialist
- **Skills:** react-patterns
- **Priority:** P1
- **Dependencies:** Task 1.2
- **INPUT:** Enhanced Customer model
- **OUTPUT:** Updated customer hooks with balance tracking
- **VERIFY:** Customer CRUD with outstanding balance calculation

#### Task 2.3: Purchase Order Hooks
- **Agent:** backend-specialist
- **Skills:** react-patterns
- **Priority:** P1
- **Dependencies:** Task 2.1
- **INPUT:** PurchaseOrder model
- **OUTPUT:** `usePurchaseOrders()`, `createPurchaseOrder()`, `updatePurchaseOrderStatus()` hooks
- **VERIFY:** Purchase order creates, status changes, inventory updates on delivery

#### Task 2.4: Sales Order Hooks
- **Agent:** backend-specialist
- **Skills:** react-patterns
- **Priority:** P1
- **Dependencies:** Task 2.2
- **INPUT:** SalesOrder model
- **OUTPUT:** `useSalesOrders()`, `createSalesOrder()`, `updateSalesOrderStatus()` hooks
- **VERIFY:** Sales order creates, stock reservation, unreserve on cancel

#### Task 2.5: Update Sync Engine
- **Agent:** backend-specialist
- **Skills:** clean-code
- **Priority:** P1
- **Dependencies:** Task 2.1, 2.2, 2.3, 2.4
- **INPUT:** Existing syncEngine.ts
- **OUTPUT:** Add suppliers, purchaseOrders, salesOrders to sync tables
- **VERIFY:** All new entities sync bidirectionally

---

### Phase 3: UI Components

#### Task 3.1: Supplier Form Component
- **Agent:** frontend-specialist
- **Skills:** frontend-design, react-patterns
- **Priority:** P2
- **Dependencies:** Task 2.1
- **INPUT:** Supplier model
- **OUTPUT:** `SupplierForm.tsx` with currency selector, validation
- **VERIFY:** Form creates/edits suppliers correctly

#### Task 3.2: Customer Form Component
- **Agent:** frontend-specialist
- **Skills:** frontend-design, react-patterns
- **Priority:** P2
- **Dependencies:** Task 2.2
- **INPUT:** Customer model
- **OUTPUT:** `CustomerForm.tsx` with currency selector, validation
- **VERIFY:** Form creates/edits customers correctly

#### Task 3.3: Order Form Component
- **Agent:** frontend-specialist
- **Skills:** frontend-design, react-patterns
- **Priority:** P2
- **Dependencies:** Task 2.3, 2.4
- **INPUT:** Order models, exchange rate context
- **OUTPUT:** `OrderForm.tsx` with:
  - Product selection (searchable)
  - Live currency conversion display
  - Exchange rate indicator
  - Quantity/price inputs
- **VERIFY:** Order form shows live converted prices

#### Task 3.4: Currency Converter Component
- **Agent:** frontend-specialist
- **Skills:** frontend-design
- **Priority:** P2
- **Dependencies:** None
- **INPUT:** Exchange rate context
- **OUTPUT:** `CurrencyConverter.tsx` - displays live conversion
- **VERIFY:** Shows accurate live conversion both directions

#### Task 3.5: Order Status Badge Component
- **Agent:** frontend-specialist
- **Skills:** frontend-design
- **Priority:** P2
- **Dependencies:** None
- **INPUT:** Order status types
- **OUTPUT:** `OrderStatusBadge.tsx` with color-coded statuses
- **VERIFY:** Correct colors for each status

#### Task 3.6: Order Details Modal
- **Agent:** frontend-specialist
- **Skills:** frontend-design
- **Priority:** P2
- **Dependencies:** Task 3.5
- **INPUT:** Order models
- **OUTPUT:** `OrderDetails.tsx` with items, status history, payment info
- **VERIFY:** All order details displayed correctly

---

### Phase 4: Page Implementation

#### Task 4.1: Suppliers Page
- **Agent:** frontend-specialist
- **Skills:** frontend-design, react-patterns
- **Priority:** P2
- **Dependencies:** Task 3.1
- **INPUT:** Supplier hooks and components
- **OUTPUT:** `Suppliers.tsx` page with:
  - Supplier list with search/filter
  - Add/Edit supplier modal
  - Supplier details view
  - Purchase history
- **VERIFY:** Full CRUD, responsive design

#### Task 4.2: Customers Page
- **Agent:** frontend-specialist
- **Skills:** frontend-design, react-patterns
- **Priority:** P2
- **Dependencies:** Task 3.2
- **INPUT:** Customer hooks and components
- **OUTPUT:** `Customers.tsx` page with:
  - Customer list with search/filter
  - Add/Edit customer modal
  - Customer details with order history
  - Outstanding balance display
- **VERIFY:** Full CRUD, balance tracking visible

#### Task 4.3: Orders Page
- **Agent:** frontend-specialist
- **Skills:** frontend-design, react-patterns
- **Priority:** P2
- **Dependencies:** Task 3.3, 3.6
- **INPUT:** Order hooks and components
- **OUTPUT:** `Orders.tsx` page with:
  - Tab navigation: Purchase Orders | Sales Orders
  - Order list with status filters
  - New order form (contextual by tab)
  - Status change buttons
  - Order details modal
- **VERIFY:** Both order types work, status updates, delivery date auto-set

---

### Phase 5: Integration

#### Task 5.1: Update App Routes
- **Agent:** frontend-specialist
- **Skills:** react-patterns
- **Priority:** P2
- **Dependencies:** Task 4.1, 4.2, 4.3
- **INPUT:** New pages
- **OUTPUT:** Updated `App.tsx` with routes, lazy loading
- **VERIFY:** All routes accessible

#### Task 5.2: Update Navigation
- **Agent:** frontend-specialist
- **Skills:** frontend-design
- **Priority:** P2
- **Dependencies:** Task 5.1
- **INPUT:** Layout.tsx
- **OUTPUT:** Add navigation items for Suppliers, Customers, Orders
- **VERIFY:** Nav items visible, icons correct

#### Task 5.3: Update Page Exports
- **Agent:** frontend-specialist
- **Skills:** clean-code
- **Priority:** P2
- **Dependencies:** Task 4.1, 4.2, 4.3
- **INPUT:** New pages
- **OUTPUT:** Updated `pages/index.ts` exports
- **VERIFY:** All pages exportable

#### Task 5.4: Update Workspace Features
- **Agent:** backend-specialist
- **Skills:** clean-code
- **Priority:** P2
- **Dependencies:** None
- **INPUT:** WorkspaceContext
- **OUTPUT:** Add feature flags: `allow_suppliers`, `allow_customers`, `allow_orders`
- **VERIFY:** Features toggleable per workspace

---

### Phase 6: Inventory Integration

#### Task 6.1: Purchase Order → Inventory
- **Agent:** backend-specialist
- **Skills:** clean-code
- **Priority:** P1
- **Dependencies:** Task 2.3
- **INPUT:** Purchase order delivery workflow
- **OUTPUT:** When PO status = 'delivered':
  - Increment product quantities
  - Update product cost price (optional: weighted average)
  - Record transaction
- **VERIFY:** Inventory increases on delivery

#### Task 6.2: Sales Order → Inventory Reservation
- **Agent:** backend-specialist
- **Skills:** clean-code
- **Priority:** P1
- **Dependencies:** Task 2.4
- **INPUT:** Sales order confirmation workflow
- **OUTPUT:** When SO status = 'confirmed':
  - Reserve stock (decrease available, track reserved)
  - Prevent overselling
  When SO status = 'delivered':
  - Finalize stock deduction
  When SO status = 'cancelled':
  - Unreserve stock
- **VERIFY:** Stock correctly reserved/unreserved

---

### Phase 7: Translations

#### Task 7.1: Add Translation Keys
- **Agent:** frontend-specialist
- **Skills:** i18n-localization
- **Priority:** P3
- **Dependencies:** Task 4.1, 4.2, 4.3
- **INPUT:** New UI text
- **OUTPUT:** Updated EN, AR, KU translation files
- **VERIFY:** All new text translated

---

## Phase X: Verification Checklist

### Build & Lint
- [ ] `npm run lint` passes
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run build` succeeds

### Database
- [ ] Supabase migration applies cleanly
- [ ] RLS policies working (users only see their workspace data)
- [ ] Offline mutations sync correctly

### Functional Testing
- [ ] Suppliers: Create, Edit, Delete, List, Search
- [ ] Customers: Create, Edit, Delete, List, Search, Balance tracking
- [ ] Purchase Orders: Create with live rates, Status workflow, Inventory update
- [ ] Sales Orders: Create with live rates, Stock reservation, Status workflow
- [ ] Currency conversion: Live rates displayed, Historical rates stored
- [ ] Delivery date: Auto-set when status = 'delivered'

### Responsive Design
- [ ] Desktop layout works
- [ ] Tablet layout works
- [ ] Mobile layout works (if applicable)

### Offline Testing
- [ ] Create supplier offline → syncs when online
- [ ] Create order offline → syncs when online
- [ ] Status change offline → syncs when online

### Scripts (Run Before Completion)
```bash
# Full verification
python .agent/scripts/verify_all.py . --url http://localhost:5173

# Or individually:
npm run lint && npx tsc --noEmit
npm run build
python .agent/skills/vulnerability-scanner/scripts/security_scan.py .
```

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Exchange rate API downtime | Medium | Medium | Multiple fallback sources already in place |
| Complex inventory logic | Medium | High | Atomic transactions, comprehensive testing |
| Sync conflicts on orders | Low | High | Last-write-wins with version tracking |
| Large order lists | Medium | Low | Pagination, virtual scrolling |

---

## Timeline Estimate

| Phase | Tasks | Estimated Time |
|-------|-------|----------------|
| Phase 1: Database | 3 tasks | 2-3 hours |
| Phase 2: Hooks | 5 tasks | 3-4 hours |
| Phase 3: Components | 6 tasks | 4-5 hours |
| Phase 4: Pages | 3 tasks | 4-5 hours |
| Phase 5: Integration | 4 tasks | 1-2 hours |
| Phase 6: Inventory | 2 tasks | 2-3 hours |
| Phase 7: Translations | 1 task | 1 hour |
| Phase X: Verification | - | 1-2 hours |
| **Total** | **24 tasks** | **~18-25 hours** |

---

## Next Steps

1. Review this plan
2. Run `/create` or approve to begin implementation
3. Start with Phase 1 (Database Foundation)
