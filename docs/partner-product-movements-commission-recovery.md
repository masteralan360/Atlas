# Missing product commission recovery

Audit and targeted migration completed on 2026-09-16 for partner **مندوب ابراهيم** and the September 2026 Partner Product Movements Statement.

## Verified scope

These six sales orders are completed, commission-enabled, and in `tracked` commission mode. Each has an active assignment to this partner's field agent. None has recorded product or aggregate commission entries for that agent. Every product line has an applicable, fixed IQD commission rule effective at fulfillment. There are no returned quantities or free bonus quantities in these orders.

| Sales order | Qualifying product lines | Expected product commission (IQD) |
| --- | ---: | ---: |
| SO-2026-00010 | 20 | 12,700 |
| SO-2026-00013 | 20 | 12,300 |
| SO-2026-00029 | 24 | 11,700 |
| SO-2026-00033 | 11 | 4,600 |
| SO-2026-00039 | 19 | 10,350 |
| SO-2026-00041 | 28 | 18,750 |
| **Total** | **122** | **70,400** |

Before recovery, the statement's recorded total was **158,100 IQD** across 268 September product commission entries. After recovery, the verified total is **228,500 IQD** across 390 entries.

## Applied recovery

1. Recheck the six orders, their agent assignments, quantities, applicable rule versions, and absence of existing commissions immediately before recovery. Save the relevant records as an audit snapshot.
2. Reconcile only these orders through the existing `public.reconcile_sales_agent_commission(order_id, null)` operation. The privileged migration establishes the original creator's verified administrator/workspace context temporarily and restores the previous request context afterwards. It does not change profiles or privileges. No commission rows are manually inserted and no product rules are changed.
3. Verify 122 initial product commission entries totaling 70,400 IQD for the selected agent, with the expected per-order totals above. Verify the resulting aggregate commissions match their product detail. Existing commission records and order quantities must retain their original values. No inventory, payment, partner balance, or financial ledger changes are expected for this tracked recovery.
4. Verify that a retry preserves the same earned quantities and net amounts without adding duplicate initial accruals. Refresh the statement's own sources and regenerate its PDF; verify the total and recovered product rows.

The existing reconciliation chooses initial rules at the order's commission event time and preserves recorded line terms for later adjustments. Its rule lookup also requires the rule to be active. All rules in this audited scope satisfy both conditions; this procedure must not be generalized to other historical orders without checking their rule history.

The live dry run discovered that SO-2026-00033 contained two identical one-carton product lines sharing one legacy composite item ID. Reconciliation keys entries by item ID, so leaving that collision would omit 200 IQD. The migration gives only the second duplicate a deterministic unique ID, preserves all product business fields and row order, and increments the order's sync version. Before/after verification confirmed one changed technical ID across the six orders, with all quantities, prices, fulfillment dates, and other business fields preserved.

## Prevent recurrence

All six orders were unpaid or partly paid. The original product commission reconciler required a completed and fully paid order; migration `20260910203214_manual_sales_agent_commission_payments.sql` removed the full-payment requirement on September 10. This is consistent with the missing historical entries. The current reconciler is already independent of customer payment status. Queued/deferred failures remain another possible contributor, and the audit does not establish whether they also affected these orders.

Show an explicit pending or failed commission state when an order qualifies but its commission recording has not completed. Label sales-order rule calculations as estimates until recorded entries exist, and use recorded historical terms for fulfilled orders once available. Retain the movement statement's recorded-entry calculation.

Any implementation of a recovery or retry workflow must include Vitest coverage for request contracts, successful record handling, failure handling, repeated requests, rounding, and relevant inventory/payment/balance/ledger effects under the repository's testing rules.

## Execution status

Migration [20260916011840_backfill_ibrahim_missing_product_commissions.sql](../supabase/migrations/20260916011840_backfill_ibrahim_missing_product_commissions.sql) was applied successfully to the configured ERP Supabase project and recorded in its migration history.

Verification:

- 27 Vitest/PostgreSQL migration tests and 13 movement-calculation tests passed; test-file lint passed. PGlite is pinned as a development dependency for executing the SQL migration tests.
- A rollback-only run against the deployed reconciliation engine passed before application, including a repeated backfill in the same transaction.
- An applied-migration replay also passed in a rollback-only transaction without additional entries or changes.
- Recovery produced exactly 122 product entries and six tracked accruals totaling 70,400 IQD, matching every per-order expectation.
- Protected workspace records passed the migration's before/after fingerprints. Independent before/after audit checks also confirmed unchanged payment, inventory, product, partner, assignment, purchase, return, and loan records.
- The selected agent's September recorded product commission total is 228,500 IQD. Refresh the statement's data and regenerate its PDF to display the updated history.

The detailed before/after audit snapshots are stored outside the repository under `C:/Users/Excellence/.codex/backfill-audits/2026-09-16/`.
