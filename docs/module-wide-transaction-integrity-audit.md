# Module-Wide Transaction Integrity Audit

## Feature overview

The Module-Wide Transaction Integrity Audit runs a module's existing single-transaction Transaction Integrity Audit against every transaction in the module's current filtered result set. It solves the review burden of opening transactions one at a time when a user wants to scan a whole working set.

The existing single-transaction audit remains the detailed view for one transaction. The module-wide interface is an orchestration and aggregation layer: it shows one compact summary per transaction and does not show rule results, explanations, or expandable details. The user starts the run explicitly; opening the interface does not start an audit.

V1 supports **Sales Orders only**.

> Module-Wide Transaction Integrity Audit never defines transaction integrity rules itself. It delegates transaction validation to the module's existing single-transaction Transaction Integrity Audit.

## Architecture

```text
Module Filters
      ↓
Resolve Matching Transactions
      ↓
Module-Wide Audit Orchestrator
      ↓
Existing Single-Transaction Integrity Audit
      ↓
Normalize/Summarize Result
      ↓
Module-Wide Audit Results UI
```

The shared feature defines a small adapter contract, executes audits with bounded concurrency, tracks progress, and normalizes each result to a transaction reference, passed count, warning count, failed count, and visual severity. The caller supplies a localized module label; the generic result dialog renders only those summaries.

Module-specific integration provides the already-filtered transaction list and an adapter. The module page owns fetching and filtering. The adapter supplies the transaction ID/reference, calls the existing audit implementation, and maps its summary. The existing single-transaction audit remains the only owner of integrity rules and audit reads.

| Responsibility | Implementation |
| --- | --- |
| Shared runner, adapter contract, progress, severity | `src/lib/integrityAudit/moduleWide.ts` |
| Shared summary-only dialog | `src/ui/components/integrity-audit/ModuleWideIntegrityAuditDialog.tsx` |
| Sales Orders adapter | `src/lib/integrityAudit/salesOrderModuleWide.ts` |
| Active Sales Orders filtering and entry point | `src/ui/pages/Orders.tsx` |
| Existing single-order graph and integrity checks | `src/lib/integrityAudit/salesOrderAudit.ts` and `src/lib/integrityAudit/salesOrderGraph.ts` |
| Existing single-order details UI | `src/ui/components/orders/SalesOrderIntegrityAuditDialog.tsx` |

This preserves one source of truth: changes to the Sales Order single-transaction audit automatically affect module-wide results because every row invokes `runSalesOrderIntegrityAudit` and maps that result's `summary`.

## Sales Orders V1 integration

The Sales Orders page exposes **Module-Wide Integrity Audit** in the list action bar beside Archives and Print, and passes its existing `filteredSalesOrders` collection to the shared dialog. That collection is computed by the page's current production filtering path. It applies the created-date `DateRangeFilter`, fulfilled-date range, active-order rule, status, payment status, order source, commission mode when available, and search over order number, customer, product, and visible sales agent. The audit does not keep a second filter state or reinterpret these controls.

`filteredSalesOrders` is computed before `paginateOrders` creates the table rows. The dialog receives the full filtered collection, so table page size and current page do not limit the audit. This is the same list represented by the active Sales Orders filters.

When the user selects **Start Audit**, the shared runner takes a snapshot of that list and invokes the Sales Orders adapter for every order. The adapter calls the existing `runSalesOrderIntegrityAudit(workspaceId, order.id, mode)`. It gets the displayed reference from `order.orderNumber` and maps the existing result's `summary` fields (`passed`, `warnings`, and `failed`). No checks, graph reads, or integrity rules are repeated in the module-wide layer.

Each result row displays the Sales Order number, the three check counts, and a highlight derived from severity. Failure takes precedence over warning; warning takes precedence over pass. If an individual audit cannot read its required records, the run reports a localized error and does not present a partial result list as complete.

## Future Module Expansion Guide

The shared feature is intended to support another module by adding an adapter and entry point. It does not include Purchase Orders or any other module in V1.

### Integration contract

A module must provide:

1. **Transaction source:** all transactions matching the module page's active filters, independent of table pagination.
2. **Existing single-transaction audit:** a functioning audit for one transaction, called by the adapter without recreating its rules.
3. **Transaction identifier:** a stable record ID and a human-readable reference for display.
4. **Standardized audit summary:** a mapping to `passed`, `warnings`, and `failed` counts. The shared runner derives visual status from these counts.
5. **Filter integration:** access to the same active filters and filtering/query semantics used by the normal module page. Module-wide audit must not maintain an independent filter state.

### Expansion procedure

1. Confirm the module already has a functioning single-transaction Transaction Integrity Audit.
2. Expose or reuse the module's filtered transaction collection/query.
3. Ensure the source includes every match, not only the visible table page.
4. Provide the transaction ID and display reference through an adapter.
5. Connect the adapter to the existing per-transaction audit function.
6. Map that audit result into the shared summary shape.
7. Register and enable the shared Module-Wide Transaction Integrity Audit for that module.
8. Add the module's entry point to its UI and pass the active filtered collection.
9. Verify the module's date filters and all standard filters are respected, and pagination does not restrict scope.
10. Verify every module-wide result matches the same transaction's individual audit.
11. Update this document and the module's isolated and hosted developer test coverage.

The intended integration pattern is:

```ts
const adapter: ModuleWideIntegrityAuditAdapter<PurchaseOrder, PurchaseOrderAuditResult> = {
  getTransactionId: order => order.id,
  getTransactionReference: order => order.orderNumber,
  auditTransaction: order => runPurchaseOrderIntegrityAudit(workspaceId, order.id, mode),
  getSummary: result => result.summary
}

<ModuleWideIntegrityAuditDialog
  open={auditOpen}
  onOpenChange={setAuditOpen}
  transactions={filteredPurchaseOrders}
  adapter={adapter}
  transactionLabel={t('orders.tabs.purchase')}
/>
```

`runPurchaseOrderIntegrityAudit` above represents a future module's already-existing single-transaction implementation; it is not a V1 function. The adapter delegates to it and maps its summary. It must not contain Purchase Order integrity rules.

### Conceptual future example: Purchase Orders

```text
Purchase Orders
      ↓
Current Purchase Order Filters
      ↓
All Matching Purchase Orders (not the current page only)
      ↓
Existing Purchase Order Transaction Integrity Audit
      ↓
Standardized Summary
      ↓
Shared Module-Wide Transaction Integrity Audit UI
```

This is an example of a future integration only. Purchase Order support is not implemented in V1.

### Extension rules

- A module must already have a functioning single-transaction Transaction Integrity Audit before module-wide support is added.
- Module-wide support must never introduce a second copy of that module's validation rules.
- Changes to a module's single-transaction integrity rules must automatically affect its module-wide audit.
- Module-wide filtering must use the module's existing filter and query semantics.
- Pagination must never determine module-wide audit scope.
- The shared Module-Wide Transaction Integrity Audit should remain module-agnostic wherever practical.
- Module-specific behavior belongs in clearly defined adapters, not conditionals spread throughout shared code.
- Adding another module should not require redesigning or duplicating the shared results UI.

## Documentation and test maintenance

Whenever another module is enabled, update the supported-module list, its integration behavior, this contract, and the examples if the contract changes. Add its selectable isolated coverage and a paired hosted coverage group under that module's developer testing suite. The Sales Orders V1 group covers adapter delegation, summary and severity normalization, failure handling, summary-only UI, and a hosted comparison with the individual audit plus persisted-record stability.
