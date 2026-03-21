# PLAN-pos-background-sync

Optimize the POS checkout experience by backgrounding the printing and synchronization logic. This allows immediate closure of the success modal and eliminates unnecessary browser print dialogs.

## Analysis

### Current State
1. **Print Dialog**: Clicking "Print" in `CheckoutSuccessModal` opens the system print dialog via `react-to-print`.
2. **Blocking Process**: The modal stays open and shows a loading state while generating the PDF, uploading to R2, and upserting to Supabase.
3. **User Wait**: The user must wait for the upload to finish or the print dialog to close before they can start a "New Sale".

### Desired State
1. **Instant Closure**: Clicking "Print" triggers the background process and closes the modal immediately.
2. **No Dialog**: The system print dialog is removed.
3. **Background Sync**: A dedicated service handles PDF generation and Supabase synchronization independently of the component lifecycle.
4. **Toast Feedback**: Asynchronous success/error notifications via global toasts.
5. **Silent Printing Stub**: A dedicated `printService` structure to support future physical printer integration.

## Proposed Changes

### [Component] POS Success Modal

#### [MODIFY] [CheckoutSuccessModal.tsx](file:///e:/ERP%20System/Atlas/src/ui/components/pos/CheckoutSuccessModal.tsx)
- Remove `useReactToPrint`, `handlePrint`, and the hidden print `ref`.
- Import `triggerInvoiceSync` from `invoiceSyncService`.
- Update `handlePrintAndUpload`:
    - Call `triggerInvoiceSync` with `saleData`, `features`, and `workspaceName` (non-blocking).
    - Call `onClose()` immediately.
    - Show an initial "Processing receipt..." toast.

### [New Service] Invoice Sync Service

#### [NEW] [invoiceSyncService.ts](file:///e:/ERP%20System/Atlas/src/services/invoiceSyncService.ts)
- A function `triggerInvoiceSync` that:
    - Captures the current `user` and `workspace` context.
    - Runs the PDF generation (`generateInvoicePdf`).
    - Performs R2 upload.
    - Performs Supabase `upsert`.
    - Updates local Dexie.
    - Shows success/error toasts upon completion.

### [New Service] Silent Print Structure

#### [NEW] [printService.ts](file:///e:/ERP%20System/Atlas/src/services/printService.ts)
- A utility for silent printing.
- Current Implementation: Placeholder/Stub.
- Future Implementation: Integration with `tauri-plugin-printer` or custom OS-level commands.

## Verification Plan

### Manual Verification
1. Open POS, add items, and checkout.
2. Click "Print" in the success modal.
3. **Expect**: The modal closes immediately.
4. **Expect**: No browser print dialog appears.
5. **Expect**: A toast appears saying "Saving receipt...".
6. **Expect**: A second toast appears later saying "Receipt saved successfully".
7. Check Supabase and R2: Verify the invoice record and PDF are created correctly in the background.

## Task Breakdown
- [ ] Create `src/services/printService.ts` stub.
- [ ] Create `src/services/invoiceSyncService.ts` with background logic.
- [ ] Refactor `CheckoutSuccessModal.tsx` to use background services and exit immediately.
- [ ] Verify background sync and toast notifications.
