# Loan Transaction Integrity Audit

## Scope and entry point

The Loans details page and Installments details page display **Transaction Integrity Audit** beside the loan breadcrumb. It is available for standard and simple loans, including linked sales/order loans and cancelled loans that remain visible. After the loan record is ready and the detail view has rendered, the shared audit hook schedules the existing audit for browser idle time (with a delayed timer fallback). This keeps it outside the page's critical loading path. The breadcrumb icon is yellow while the audit is queued or running, then reflects Failed > Warning > Passed severity. Opening the dialog shows that run's result; clicking the button again starts a fresh run. The audit is read-only: it does not save a result, repair records, change a balance, or start synchronization.

## Checks

The audit reads one normalized loan graph and compares the loan summary with its repayment, reversal, installment, account-movement, payment-account, and linked business-partner records. It reconstructs the currently paid amount from active loan payment records and the remaining amount from principal minus paid. It verifies:

- loan identity, workspace, status, currency, direction, source-link fields, and linked partner;
- manual loan origination evidence against the principal and settlement currency;
- repayment links, direction, currency, amounts after reversals, and payment-account movements;
- linked reversal entries, including the exact reversed amount and matching source;
- installment uniqueness and arithmetic, plus schedule totals against the loan principal, paid amount, and balance.

Older records without transaction integrity versions may report warnings where their historical payment evidence is incomplete. The audit does not infer missing payments from the cached loan totals.

## Database modes

| Mode | Transaction integrity | Mirror integrity |
| --- | --- | --- |
| Cloud | Audit Supabase as the source of truth. | No SQLite comparison. |
| Hybrid | Audit Supabase first. | Compare loan, schedule, payment, account-movement, and account records against SQLite; report differences as warnings. |
| Local | Audit the existing SQLite database as the source of truth. | No Supabase comparison. |

The SQLite reader uses an existing connection and `SELECT` queries only. A denied or failed authoritative read fails the audit rather than producing a partial pass. In Hybrid mode, an unreadable mirror is reported as a warning without changing the Supabase transaction result.

## Implementation

| Responsibility | Location |
| --- | --- |
| Loan graph collection and source reads | `src/lib/integrityAudit/loanGraph.ts` |
| Expected-state reconstruction and checks | `src/lib/integrityAudit/loanAudit.ts` |
| Shared inspectable JSON model | `src/lib/integrityAudit/auditModel.ts` |
| Loan details action and result dialog | `src/ui/components/loans/LoanIntegrityAuditBreadcrumbAction.tsx`, `src/ui/components/loans/LoanIntegrityAuditDialog.tsx` |
| Deferred auto-run and generic severity action | `src/ui/components/integrity-audit/useDeferredTransactionIntegrityAudit.ts`, `src/ui/components/integrity-audit/TransactionIntegrityAuditAction.tsx`, `src/lib/integrityAudit/severity.ts` |

The audit is surfaced on the existing Loans and Installments detail routes, which share the same loan detail view. See [Developer Testing](./developer-testing.md#loan-integrity-audit-coverage) for isolated and hosted coverage.
