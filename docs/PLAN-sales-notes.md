# PLAN-sales-notes.md

## Goal
Add a "Notes" feature to each sale to allow internal staff to record specific details about a transaction.

## Proposed Changes

### 1. Database Schema
#### [MODIFY] [types.ts](file:///e:/ERP%20System/Atlas/src/types.ts)
- Add `notes?: string` to the `Sale` interface.

#### [MODIFY] [models.ts](file:///e:/ERP%20System/Atlas/src/local-db/models.ts)
- Add `notes?: string` to the `Sale` interface.

#### [MODIFY] [database.ts](file:///e:/ERP%20System/Atlas/src/local-db/database.ts)
- Increment database version to 27.
- Add `notes` to the `sales` store schema.

#### [SUPABASE]
- Add `notes` column (TEXT) to the `public.sales` table.
- Add a check constraint: `length(notes) <= 250`.

### 2. UI Components
#### [MODIFY] [Sales.tsx](file:///e:/ERP%20System/Atlas/src/ui/pages/Sales.tsx)
- Update "Recent Sales" table header to include a "Notes" column between "Origin" and "Total".
- Add cell logic:
    - `sale.notes` exists -> "View Note.."
    - No note -> "Add Note"
- Implement `SalesNoteModal` for direct read/write editing.

### 3. Synchronization
#### [VERIFY] [syncEngine.ts](file:///e:/ERP%20System/Atlas/src/sync/syncEngine.ts)
- Verify `toSnakeCase` and `toCamelCase` correctly handle the `notes` field.

## Verification Plan
1. Open Sales page.
2. Click "Add Note" on a recent sale.
3. Enter 100 characters and save.
4. Verify "Add Note" changes to "View Note..".
5. Click "View Note.." and verify the note content is correct.
6. Refresh the page to ensure local persistence.
7. Check Supabase 'sales' table to ensure the note is synced.
8. Attempt to enter > 250 characters and verify validation prevents saving.
