# PLAN-pos-receipt-sync

Optimize the checkout success modal by restricting printing to the Receipt format and ensuring invoice records are correctly persisted to Supabase upon printing.

## Analysis

### Current State
1. **POS Checkout**: Finalizes the sale and saves it to `sales` and `sale_items` in Supabase (via RPC). It saves to the local `invoices` table but does not push to the Supabase `invoices` table.
2. **Success Modal**: The `Print` button triggers `handlePrintAndUpload`. This function generates both A4 and Receipt PDFs, uploads them to R2, and then tries to **update** the `invoices` record in Supabase. Since the record doesn't exist in Supabase yet, the update fails or does nothing.
3. **Template Excess**: Currently generates and uploads A4 PDFs even though for POS success, only the Receipt is typically needed.

### Desired State
1. **Receipt Focused**: Only generate and upload the Receipt PDF in the `CheckoutSuccessModal`.
2. **Guaranteed Sync**: Use `upsert` instead of `update` in the `CheckoutSuccessModal` to ensure the `invoices` record is created in Supabase with all necessary metadata (ID, total, settlement currency, etc.) alongside the PDF paths.
3. **A4 Exclusion**: A4 templates will remain available in Invoices History but will be removed from the POS Success modal to speed up the process.

## Proposed Changes

### [Component] POS Success UI

#### [MODIFY] [CheckoutSuccessModal.tsx](file:///e:/ERP%20System/Atlas/src/ui/components/pos/CheckoutSuccessModal.tsx)
- Remove logic for generating `pdfBlobA4`.
- Remove `assetManager.uploadInvoicePdf` call for 'a4'.
- Change `supabase.from('invoices').update` to `upsert`.
- Populate all required fields in the `upsert` call from `saleData` (total_amount, settlement_currency, origin, etc.).
- Remove A4 related fields (`r2_path_a4`) from the payload.
- Update local `db.invoices` cleanup to only focus on the receipt.

## Verification Plan

### Automated Tests
- N/A (UI-driven logic)

### Manual Verification
1. Open the POS page.
2. Complete a sale.
3. When the Success Modal appears, click "Print".
4. Dashboard/Invoices History: Verify that a new record appeared in Invoices History in Supabase.
5. Invoices History: Verify that only the Receipt PDF is available/downloadable for this specific sale from the modal's origin.
6. Verify Cloud Storage: Ensure the Receipt PDF is uploaded correctly to R2 and the path is saved in the DB.

## Task Breakdown

- [ ] Modify `CheckoutSuccessModal.tsx` to restrict PDF generation to Receipt format.
- [ ] Implement `upsert` logic in `CheckoutSuccessModal.tsx` for Supabase `invoices` table.
- [ ] Clean up local Dexie update to match the single-format focus.
- [ ] Verify persistence in Supabase `invoices` table after clicking Print.
