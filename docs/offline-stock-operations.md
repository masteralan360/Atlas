# Offline stock changes in Cloud and Hybrid

Cloud and Hybrid stock workflows can save offline. Supabase remains authoritative. The client executes the existing local business workflow inside a transaction that also records one immutable `stock_operations` command. Hybrid additionally journals that transaction’s projection and outbox to SQLite before acknowledging success. Local mode retains its existing SQLite authority and creates no Cloud command.

The entry points cover POS and Instant POS checkout, stock adjustments and physical counts, transfers and selected batches, sales-order lifecycles and returns, purchase receipts, financed-order activation/cancellation, initial product stock and product/storage deletion, and batch maintenance. Existing storage access, service access, minimum prices, credit limits, payment/account selection, reservation protection, and stock constraints still apply.

## Saving and reconnecting

- Load the relevant products, storage permissions, and stock availability online first. **Prepare for offline use** also caches aggregate availability in cursor batches. These totals include reservations for orders the operator cannot view. Missing availability fails closed with a localized preparation message.
- Stock, documents, payments, linked counter-entries, and the grouped outbox commit together in Dexie. A later error rolls back the entire local transaction. Module loading keeps the transaction alive without wrapping nested Dexie transactions in `waitFor`.
- Cash and other recorded payments continue through the existing payment workflow. Account movements remain derived from `payment_transactions`. Offline persistence does not authorize an external payment provider or silently collect/refund money.
- Operations retain their original actor, stable business IDs, effects, relative quantity changes, absolute-count revisions, and dependencies. New writes continue through the queue while earlier stock work remains unresolved, even after connectivity returns. Independent incoming receipts can repair shortages without depending on a rejected outgoing sale.
- Replay uses `apply_offline_stock_operation`. The server locks and validates the operation, applies relative movements against current inventory, uses existing business RPCs where applicable, and seals its result in the same PostgreSQL transaction. Repeating an ID with identical input returns the receipt; changing its input is rejected.
- The acknowledgement updates confirmed rows while retaining subsequent pending deltas. Table-specific ID aliases and dependency-specific revision mappings reconcile generated child IDs and server lifecycle versions without modifying the original command. Invoice references receive their confirmed sequence numbers.
- Short leases prevent competing local workers from claiming the same command. Transient failures use bounded backoff. Deterministic rejections remain available for explicit review/retry, and unrelated commands continue.
- Commission reconciliation and automatic reorder evaluation use durable, scoped follow-up jobs after confirmation. Reorder transfer IDs are stable per originating operation and rule. Related unresolved transactions defer their follow-ups.

## Review and recovery

The sync dialog shows a localized stock-operation summary, quantity changes, a local reference, and an explicit retry action. Pending sales have a `LOCAL-…` reference rather than a fabricated server sequence. Financial records are retained after rejection; retry never repeats a payment collection or refund.

A failed physical count with no payments or dependent commands can be discarded through the shared confirmation dialog. `cancel_offline_stock_count` first checks whether the operation already committed. Otherwise it seals a cancellation receipt and returns current stock. A delayed replay therefore cannot apply the discarded count. Uncertain cancellation keeps related writes blocked until its outcome is recovered. Other rejected business transactions remain preserved for review; they are not automatically discarded or financially reversed.

Legacy standalone inventory/batch snapshot mutations remain quarantined. They are not converted into movements because their original intent cannot be recovered safely.

## Server permissions and rollout

`supabase/migrations/20261029221116_offline_stock_operations.sql` and the follow-up `20261030131040_optimize_offline_stock_receipt_policies.sql` were deployed to the linked ERP project (`eboispangcayxxheoufy`) on 2026-10-30. Both versions are recorded in the hosted migration history. Reservation protection was already installed and was retained. Apply both migrations after reservation protection and **before releasing the client changes** in other environments.

The receipt functions use a dedicated `NOLOGIN`, `NOBYPASSRLS` owner that inherits `authenticated`. It does not own business tables and remains subject to their authenticated RLS policies and existing RPC checks. Clients may read their own scoped receipts but cannot insert confirmation receipts directly. The owner’s additional permission is receipt insertion. New order loans/installments and checkout lines receive stable identities; existing loans retain their identities. Guarded patches fail migration if an expected checkout/financing definition no longer matches.

Deploy the additive migration first, verify it in a staging workspace, and then release the client. Keep receipts and queued commands when reverting a client release; do not repair rejected payments by editing balances or deleting their history.

The deployment used an ignored, isolated CLI directory populated with the recorded remote migration history, then added only these two migrations. This avoids changing older history gaps in the checkout or applying unrelated migrations. Hosted default table grants were reproduced in the regression fixture; the receipt migration explicitly revokes client writes and `TRUNCATE` before restoring scoped reads. The follow-up policy migration caches workspace/auth lookups once per statement, resolving the new `auth_rls_initplan` findings without changing scope.

Post-deployment checks confirmed receipt RLS, client read-only privileges, restricted function ownership, stable checkout/financing identities, and the existing reservation trigger. Both RPCs rejected requests without an authenticated actor in a rolled-back smoke transaction. No business records were created for verification. The two new [authenticated SECURITY DEFINER execution advisories](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) are intentional: only authenticated callers may reach these actor/workspace-gated endpoints, and their owner cannot bypass business RLS. The new receipt index is reported as [unused](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) until replay traffic uses it. Other project advisories predate this deployment.

## Verification

The focused suites exercise transaction rollback, reopen, relative replay on newer stock, lost responses and immutable IDs, actor/workspace isolation, receipt permissions and inventory RLS, hidden reservations with competing operations, canonical order/receipt/transfer routing, exact refund rollback, generated child IDs, dependent revision mapping, and count cancellation fencing. Cloud/Hybrid client cases cover checkout with selected accounts, financed Quick Orders, fractional batch transfers, and exchanges. Follow-up tests cover restart/retry and scope isolation.

Hybrid journal tests use the existing SQLite connection test adapter to verify commit ordering and Dexie rollback; they do not simulate a native filesystem power failure. PostgreSQL tests run the new migration in PGlite with selected canonical RPC fixtures, and reservation tests use the actual reservation migration. They do not replace a hosted Supabase acceptance run against the entire production schema.

The actual review component was checked at desktop and 390px widths, including Kurdish RTL, immediate retry disabling, and prevention of closing while processing. Disposable browser fixtures and screenshots are under the ignored `.atlas-test-runs/offline-stock-ui/` folder.

The focused 15-file regression run passed 216 tests; the expanded checkout suite subsequently passed all 71 checks, including connection loss during submission. Both TypeScript configurations and lint for the new implementation files pass. The broader Quick Order/low-level stock suites passed 51 checks and retained five failures already documented in `stock-reservation-protection.md`: the old transfer-reference expectation, three removed missing-cost validations, and a removed Price Book cost-index read. These policies were not changed for this task.

The deployment regression run passed all 28 database checks, including hosted default privilege hardening and receipt read isolation across workspaces and actors. Hosted verification checked schema, permissions, policies, migration history, and unauthenticated RPC guards; a signed-in end-to-end stock workflow against the full hosted schema remains a separate client acceptance check.

## Read-only audit replay fix

`20261030132510_fix_offline_stock_read_only_audit_locks.sql` was deployed to ERP on 2026-10-30 after reproducing `42501: permission denied for table inventory_transactions`. Replay preflight requested `FOR UPDATE` on every effect, including the read-only inventory ledger and transfer receipt tables. [PostgreSQL requires update permission for locking reads](https://www.postgresql.org/docs/17/sql-select.html), even when the requested row does not exist yet.

Preflight now uses ordinary, RLS-scoped reads for `inventory_transactions` and `inventory_transfer_batches`. Their canonical RPCs retain responsibility for writes and concurrency; mutable business rows retain their existing locks. The executor still has no insert/update/delete grants on either audit table. No client deployment is needed for this server fix. Already-failed stock operations must be retried through the sync dialog; retain their original operation IDs and payment records.

The updated regression fixture reproduces hosted audit grants and RLS. Adjustment and transfer replay failed with the exact permission error before the fix. All 30 database checks pass after it, including one-time replay and rollback when the authoritative audit row is inaccessible. Live checks confirmed the migration record, function marker and owner, read-only audit grants, receipt RLS, and reservation trigger. Security advisors reported no new findings from this fix.
