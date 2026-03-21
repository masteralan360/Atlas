# Features Documentation

## Core Feature Modules

This document covers the main feature modules in Atlas.

---

## 1. Point of Sale (POS)

Location: `src/ui/pages/POS.tsx`

### Overview

Full-featured checkout interface for retail transactions.

### Key Capabilities

| Feature | Description |
|---------|-------------|
| Product Search | Real-time search by name, SKU, or barcode |
| Category Filter | Filter products by category |
| Barcode Scanning | Camera-based barcode input |
| Cart Management | Add, remove, adjust quantities |
| Negotiated Pricing | Custom prices with discount limits |
| Multi-Currency | Product prices in various currencies |
| Payment Methods | Cash, FiB, QiCard, ZainCash, FastPay |
| Receipt Printing | Thermal receipt or A4 invoice |

### Keyboard Navigation

| Key | Action |
|-----|--------|
| `Arrow Keys` | Navigate product grid |
| `Enter` | Add focused product to cart |
| `Tab` | Switch between grid and cart |
| `Escape` | Remove focused cart item |
| `Double Enter` | Initiate checkout |

### Checkout Flow

```
1. Build cart with products
2. Select payment method
3. System captures:
   - Current exchange rates
   - Inventory snapshots
   - Cashier ID
4. Sale created locally
5. Stock decremented
6. Optional: Print receipt/invoice
7. Sync to cloud when online
```

### Exchange Rate Integration

- Real-time rates displayed in header
- Rates from multiple sources (XE.IQD, Forexfy, etc.)
- Rate snapshot stored with each sale for audit

---

## 2. Sales Management

Location: `src/ui/pages/Sales.tsx`

### Overview

Transaction history with filtering, returns, and receipt reprinting.

### Key Features

| Feature | Description |
|---------|-------------|
| Date Filtering | View sales by custom date range |
| Cashier Filter | Filter by specific team member |
| Sale Details | View line items, payment info |
| Receipt Reprint | Print receipt or A4 invoice |
| Returns | Full or partial return processing |

### Return System

#### Full Return
- Entire sale marked as returned
- All stock quantities restored
- Return reason recorded

#### Partial Return
- Individual items can be returned
- Specify return quantity per item
- Stock restored proportionally

#### Return Rules
- Products can have return eligibility settings
- Rules displayed to cashier before processing
- Admin can configure per-product rules

---

## 3. Revenue Analytics

Location: `src/ui/pages/Revenue.tsx`

### Overview

Net profit and margin analysis for admin users.

### Metrics

| Metric | Calculation |
|--------|-------------|
| Gross Revenue | Sum of all sale totals |
| Net Revenue | Gross - Cost of Goods Sold |
| Profit Margin | (Net / Gross) × 100 |
| Average Order Value | Gross / Number of Sales |

### Visualizations

- Revenue trend charts
- Profit breakdown by product
- Performance over time

### Bulk Actions

- Select multiple sales for batch operations
- Export selected data
- Print consolidated invoices

---

## 4. Product Management

Location: `src/ui/pages/Products.tsx`

### Overview

Complete product catalog management.

### Product Fields

| Field | Description |
|-------|-------------|
| SKU | Unique stock keeping unit |
| Name | Product display name |
| Description | Detailed description |
| Category | Product category (optional) |
| Price | Selling price |
| Cost Price | Purchase/cost price |
| Quantity | Current stock level |
| Min Stock Level | Low stock alert threshold |
| Unit | Unit of measure (pcs, kg, etc.) |
| Currency | Price currency |
| Barcode | Optional barcode |
| Image | Product image (synced via P2P) |
| Can Be Returned | Return eligibility |
| Return Rules | Custom return policy text |

### Stock Management

- Real-time stock tracking
- Low stock alerts on dashboard
- Stock adjusted automatically on sale
- Stock restored on returns

### Categories

- Create/edit/delete categories
- Assign products to categories
- Filter products by category in POS

---

## 5. Team Performance

Location: `src/ui/pages/TeamPerformance.tsx`

### Overview

Cashier productivity and sales metrics.

### Metrics Per Member

- Total sales count
- Total revenue generated
- Average transaction value
- Sales target progress (if set)

### Target System

- Admins set monthly targets per member
- Progress displayed as percentage
- Visual indicators for on-track vs behind

---

## 6. Invoice Management

Location: `src/ui/pages/InvoicesHistory.tsx`

### Overview

Historical invoice records with viewing and reprinting.

### Invoice Creation

Invoices created from:
1. POS checkout (automatic)
2. Revenue page (batch)
3. Sales page (reprint)

### Invoice Templates

#### Receipt Format
- Compact thermal printer format
- Essential info only
- Fast printing

#### A4 Format
- Full page invoice
- Business details
- Professional layout
- Configurable via print metadata

---

## 7. Settings

Location: `src/ui/pages/Settings.tsx`

### Sections

| Section | Description |
|---------|-------------|
| Profile | User name, photo, contact info |
| Workspace | Name, logo, branding |
| Currency | Default currency, display preferences |
| Features | Toggle POS, invoices, WhatsApp |
| Appearance | Theme, language |
| Security | Change password |

### Currency Settings

- Default settlement currency
- IQD display preference (IQD vs د.ع)
- EUR conversion toggle
- TRY conversion toggle

### Feature Toggles

Workspace admins can enable/disable:
- `allow_pos` - Point of Sale access
- `allow_invoices` - Invoice generation
- `allow_whatsapp` - WhatsApp integration (desktop)

---

## 8. Members/Team

Location: `src/ui/pages/Members.tsx`

### Overview

Workspace member management.

### Capabilities

| Feature | Description |
|---------|-------------|
| View Members | List all workspace users |
| Invite | Share workspace code |
| Role Management | Change member roles |
| Remove | Kick members from workspace |
| Targets | Set monthly sales targets |

### Invitation Flow

```
1. Admin shares workspace code
2. New user registers with code + passkey
3. User added to workspace with appropriate role
4. User appears in members list
```

---

## 9. Dashboard

Location: `src/ui/pages/Dashboard.tsx`

### Widgets

| Widget | Content |
|--------|---------|
| Stats Cards | Revenue, sales count, product count |
| Low Stock Alerts | Products below minimum level |
| Recent Sales | Latest transactions |
| Quick Actions | Links to common tasks |

---

## 10. WhatsApp Integration

Location: `src/ui/pages/WhatsAppWeb.tsx`

### Overview

Embedded WhatsApp Web for customer communication (desktop only).

### Features

- WebView container for WhatsApp Web
- Toggle on/off from header
- Session persists between visits
- Hidden when navigating away

### Platform Requirement

Only available on:
- Windows (Tauri)
- macOS (Tauri)
- Linux (Tauri)

Not available on:
- Web browser
- Mobile (Android/iOS)

---

## Feature Flags

### Workspace-Level Flags

Controlled via `workspaces` table:

```typescript
interface WorkspaceFeatures {
  allow_pos: boolean
  allow_customers: boolean    // Legacy
  allow_orders: boolean       // Legacy
  allow_invoices: boolean
  allow_whatsapp: boolean
  locked_workspace: boolean
  max_discount_percent: number
}
```

### Checking Features

```typescript
const { hasFeature } = useWorkspace()

if (hasFeature('allow_pos')) {
  // Show POS feature
}
```

### Route Protection

```tsx
<Route path="/pos">
  <ProtectedRoute requiredFeature="allow_pos">
    <POS />
  </ProtectedRoute>
</Route>
```
