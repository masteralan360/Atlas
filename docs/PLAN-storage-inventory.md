# PLAN: Storage & Inventory Management

## Phase 0: Socratic Gate (Clarifications Needed)
> [!IMPORTANT]
> Please confirm the following before we proceed to implementation:
> 1. **Storage Deletion**: If a user deletes a custom storage, what should happen to the products currently in it? (Recommended: Block deletion if not empty, or move all products to 'Main').
> 2. **Transfer Logic**: Confirming that "Transfer" just means updating the `storage_id` of the product row.
> 3. **UI Location**: Should "Inventory Transfer" be a standalone page, or a modal accessible from the Products list?

## Phase 1: Database Schema (Supabase & Local)
### [NEW] `storages` Table
- `id`: uuid (PK)
- `workspace_id`: uuid (FK)
- `name`: text
- `is_default`: boolean (to protect Main/Reserve)
- `created_at`: timestamptz

### [MODIFY] `products` Table
- Add `storage_id`: uuid (FK to storages)

## Phase 2: Seed & Backend
- migration to create table.
- Seed "Main" and "Reserve" for existing workspaces.
- Update direct `workspaces` reads if additional workspace feature flags are needed.

## Phase 3: UI - Storage Management
- **Page**: `/settings/storages` or similar.
- CRUD for storages (Protect "Main" and "Reserve" from delete/edit).

## Phase 4: UI - Product Management
- **Add Product Modal**: Select storage (Default to "Main").
- **Edit Product Modal**: Select storage.
- **Products View**: Show storage name tag for each product.

## Phase 5: UI - Inventory Transfer
- **Page**: `/inventory-transfer`.
- **Flow**: Select Source Storage -> Select Products -> Select Destination Storage -> Confirm Transfer.

## Phase 6: Verification
- Verify sync for offline transfers.
- Verify "Main" and "Reserve" protection logic.
