# Transaction Reconciliation & Integrity Audit

## Scope and entry point

V1 audits **completed Sales Orders**. On Sales Order Details, select **Run Integrity Audit** to inspect the order's transaction chain. The result dialog groups checks by order, items, inventory, payments, loan, relationships, and (in Hybrid mode) SQLite mirror. Expand **Audit Model JSON** to inspect the normalized snapshot used for that run.

The audit is read-only. It does not save an audit result, repair data, change stock or balances, create payments, or start synchronization. A result describes records observed at `auditedAt`; a later run may differ if the transaction changes.

## How an audit runs

1. `resolveSalesOrderTransactionGraph` reads the originating Sales Order and follows its links to related records. It normalizes database rows into one in-memory graph.
2. `auditSalesOrderGraph` reconstructs expected item amounts, the order total, inventory consumption (including free quantities), payment effects, and loan amounts from historical order data and linked transaction records.
3. The engine compares the reconstructed effects with persisted records and emits individual checks with stable codes, category, status, severity, entity, and expected/actual values.
4. `buildIntegrityAuditModel` exposes the same run as JSON. The dialog renders both the grouped checks and the JSON; it does not run a separate query for the JSON view.

The graph currently includes the order and its item snapshots, products, customer and business-partner references, inventory transactions, order returns and return items, payment transactions and reversals, payment-account movements and accounts, loans and their payments/installments, order installments, and sales-agent commission assignments and entries. Relationship queries use the actual order, return, loan, payment, and commission identifiers. Customer and business-partner reads use their workspace-scoped Supabase RPCs because direct table reads are not granted to the client.

## Audit Model JSON

The model is generated in memory from `IntegrityAuditResult` and has this shape:

```json
{
  "schemaVersion": 1,
  "transaction": {
    "type": "sales_order",
    "id": "...",
    "number": "...",
    "workspaceId": "...",
    "status": "completed",
    "currency": "usd"
  },
  "auditedAt": "...",
  "sourceOfTruth": "supabase",
  "expected": {
    "orderTotal": 60,
    "derivedOutstandingAmount": 40,
    "inventory": {}
  },
  "actual": {
    "authoritative": {},
    "sqliteMirror": null
  },
  "checks": [],
  "summary": {
    "integrityStatus": "PASS",
    "mirrorStatus": null,
    "total": 0,
    "passed": 0,
    "warnings": 0,
    "failed": 0
  }
}
```

The example shows the structure, not a complete Sales Order. `actual.authoritative` contains the resolved transaction graph. In Hybrid mode, `actual.sqliteMirror` contains the corresponding SQLite graph when it can be read. `expected.derivedOutstandingAmount` is a calculated outstanding amount, not a payment transaction that must exist for an unpaid order.

## Database modes

| Mode | Transaction integrity | Mirror integrity |
| --- | --- | --- |
| Cloud | Audit Supabase as the source of truth. | No SQLite comparison. |
| Hybrid | Audit Supabase first. | Compare relevant SQLite records and fields against Supabase; report a separate mirror status. |
| Local | Audit the existing SQLite database as the source of truth. | No Supabase comparison. |

The SQLite audit reader uses an existing connection and `SELECT` queries. It does not initialize the database, hydrate a cache, or trigger a sync. A denied authoritative read fails the audit rather than producing a partial pass. If the Hybrid mirror cannot be read, the mirror section reports a warning without changing the Supabase transaction result.

## What the checks mean

- **Order and items:** Validate references and workspace ownership; recalculate historical line totals, adjustments, returns, and the order total using the application's order precision.
- **Inventory:** Compare expected sold plus free quantity with transaction-specific sale movements by product and storage. Current product stock is not used as historical proof.
- **Payments:** Reconstruct net paid amounts from payment transactions and linked reversals, check initial payment evidence, and verify selected payment accounts through their derived movements. For an unpaid order with zero net payments, the outstanding amount is derived from total minus paid; the audit does not require that amount to be a posted payment or a matching cached order balance. A nonzero net payment or a paid/partial state enables the stored order-balance check.
- **Loans:** Where financing applies, verify the order/partner link, principal, repayments, installments, and remaining balance. The balance is reconstructed from the order financing amount and payment history rather than accepted from a cached loan balance alone.
- **Relationships:** Report missing, duplicate, orphaned, or wrongly linked records, including workspace mismatches.

Check statuses are `PASS`, `WARNING`, `FAIL`, and `NOT_APPLICABLE`; severities are `info`, `warning`, `error`, and `critical`. The transaction status is calculated without mirror checks, so a SQLite mismatch does not mark the authoritative Supabase transaction as corrupt.

## Historical evidence limits

The audit reports a warning when the existing transaction design does not retain enough historical evidence to prove an effect:

- Older sales and Local-mode sales may have changed stock without a transaction-specific sale movement. A missing movement is reported as a warning for those paths; for newer Supabase completions that should write a movement, it fails.
- Posted returns restore stock but do not retain a transaction-specific restoration movement. The audit reconstructs the expected net stock effect from return items and warns that the restoration itself cannot be independently verified from a movement row.
- A return can rescale order-level discount or tax without preserving the original components. When those components are unavailable, the audit warns instead of claiming that the original total was independently reconstructed.

These warnings are evidence limits, not automatic repairs or proof that the underlying transaction is correct.

## Implementation and extension points

| Responsibility | Location |
| --- | --- |
| Sales Order entry point | `src/ui/components/orders/OrderDetailsView.tsx` |
| Graph collection and source-specific reads | `src/lib/integrityAudit/salesOrderGraph.ts` |
| Expected-state reconstruction and checks | `src/lib/integrityAudit/salesOrderAudit.ts` |
| Inspectable JSON model | `src/lib/integrityAudit/auditModel.ts` |
| Result dialog | `src/ui/components/orders/SalesOrderIntegrityAuditDialog.tsx` |

Additional transaction types should supply their own graph resolver and validators while preserving the read-only, expected-versus-persisted approach and structured result model. V1 does not audit other modules.

For the selectable test group and its environment coverage, see [Developer Testing](./developer-testing.md#sale-orders-v1-coverage).
