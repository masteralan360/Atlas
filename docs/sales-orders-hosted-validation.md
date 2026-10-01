# Hosted Sales Orders validation · 2026-10-01

The implementation registers 30 Supabase-only groups, 418 scenario families, and 12,159 generated tests. The full matrix has **not** been executed. The focused live runs below use the already configured DEV TEST account. Missing personas and prepared fixtures remain blocked.

## Verified selections

| Selection | Evidence |
| --- | --- |
| Authenticated regular create/reserve/complete, independent reads, verified fixture retirement | `.atlas-test-runs/4274eaf4-a4b0-431a-b977-4a144c268eb5/report.json` |
| Carton/base-unit completion and return, batch completion, financed partial return with exact debt/refund conservation | `.atlas-test-runs/ccf62772-0f20-411b-a0b6-2ecb7983addf/report.json` · all three passed |
| Weekly/biweekly/monthly schedules; repayment reversal; percentage commission plan and zero/positive fixed plans | Passed individual checks in `.atlas-test-runs/a0d2481e-bd14-4dd1-8d9a-69a46e1a3dfe/report.json`; the overall run failed after later authentication interruption and incomplete execution |
| Manual fixed and percentage commission amounts, persisted ordinary partner projection, explicit parallel fixtures | Passed individual checks in `.atlas-test-runs/ea5cccf8-ae01-47e4-aa83-80c25e3bbf70/report.json`; earlier checks in that development run failed on verifier assumptions corrected afterward |
| Financed per-currency ledger after repayment and partial return; persisted partner projection; verified retirement | `.atlas-test-runs/1eb103ca-6da3-4747-9744-dd99907ed269/report.json` · passed, including TRY principal 100, repayment 25, and closing balance 75 |
| Read-failure handling and parallel hosted fixtures; missing marketplace and historical fixtures classified as blocked | Individual results in `.atlas-test-runs/cdef1db3-ae02-4de9-bf0c-8f8e41b2133d/report.json` |
| Missing viewer and private receipt observer prerequisites | `.atlas-test-runs/50bca510-24d6-468b-8c3e-c9d9505ff387/report.json` · all three registered tests reported blocked before creating business fixtures |

The earlier development reports are retained as evidence of what actually ran. They are not edited into passing reports. Current successful reruns establish the corrected verifier behavior. Per-step JSON under each run's `hosted/<family-id>/` directory contains request paths/statuses, graph hashes, fixture identities, and failed graph snapshots.

The final financed-ledger verifier uses the statement's actual settlement source allowlist (`sales_order`, `purchase_order`, `direct_transaction`) and keeps `simple_loan`/`loan_installment`/`loan_payment` transactions in the separate loan lane. Repayment prerequisites are freshly hydrated through Supabase before calling the production helper; cached table freshness alone can omit a just-created loan. Earlier failures caused by the verifier's incorrect input contract and headless cache prerequisites remain in their original reports and are not classified as database product failures.

## Preserved product and server-contract failures

### SO-H27-06 · Computed-field tampering

A direct authenticated admin Data API update accepts an inconsistent order `total` of 999 while the underlying subtotal remains 200. The payment and balance fields do not reconcile with the changed total. The suite requires rejection with an unchanged graph and retains the failed fixture.

Evidence: `.atlas-test-runs/7f657d1d-1122-4356-ae07-8810efbb1b39/report.json` and the fresh probe in `.atlas-test-runs/cdef1db3-ae02-4de9-bf0c-8f8e41b2133d/report.json`.

### SO-H13-03 / SO-H13-06 · Active cash and approval-request probes

Across the 32 completed-cash variants in SO-H13-03, 16 strict probes fail. The hosted checkout accepts unpaid cash completion, despite the active-cash payment policy requiring paid status, and accepts paid checkout with supplied approval-request metadata while dropping that approval state. The generated cases preserve both supported choices and unsupported payload probes. These server-contract gaps remain visible for product review.

Evidence: `.atlas-test-runs/7da5bee2-bd6d-442b-aa3e-d73c4a01e122/report.json`. Failed per-variant graphs remain under `hosted/SO-H13-03/`.

### SO-H09-13 · Posted down-payment summary lost during an allowed edit

Down-payment draft edits are permitted by the production helper. After a 25 installment down payment is posted, changing the draft commercial total from 200 to 300 leaves the positive payment transaction in place but changes the order's paid amount to 0 and balance to 300. The independent oracle requires paid 25 and balance 275. This fails on the resulting persisted graph, rather than incorrectly requiring every down-payment draft edit to be rejected.

Evidence: `.atlas-test-runs/cdef1db3-ae02-4de9-bf0c-8f8e41b2133d/report.json`, `hosted/SO-H09-13/`.

The task changes testing and its runner only. It does not repair these production behaviors, rewrite the failed business records, deploy functions, or apply migrations.

## Prerequisites and remaining validation

Staff, viewer, restricted/revoked permission personas, and a second DEV TEST workspace account are not configured. The suite reports their selections as blocked, following the requested account policy. Marketplace, tracked/automatic commission, historical corruption, shift-state, custom-unit, and private-receipt scenarios require their explicit local fixture configuration. None are replaced with fabricated users, nonexistent foreign IDs, local database assertions, or passing skips.

The independent runner/verifier checks pass: 27 tests covering complete enumeration, registration/localization, exact selected denominators, blocked states, secret redaction, checkpoints, failure/timeout handling, pagination, and corrupted monetary/inventory/loan records. Eight live-boundary tests also pass. The final combined check reports **35 passed and 1 failed** across all three infrastructure files. The failure is the pre-existing Products registry mismatch: its hosted groups omit `minimum-price-disclosure` while the test expects every isolated non-printing group.

The initial application TypeScript check was blocked by a working-tree diagnostic in `src/lib/integrityAudit/salesOrderAudit.ts:193`: `string | null | undefined` passed to a parameter requiring `string`. The subsequent build repair replaces the return-type array lookup with explicit equality comparisons. TypeScript build checking now passes, and all 19 integrity-audit tests pass, including null and undefined reference types. The Sales Orders hosted implementation produced no additional application diagnostics.

The repaired `npm run build` completes successfully. Vite still reports circular chunk dependencies and oversized bundle chunks; those are separate from the fixed TypeScript error.

Continuous monetary values, unlimited order lines, and arbitrary unbounded action histories are covered through explicit boundary partitions and seeded sequences. The exhaustive finite Quick Order choice product is registered independently of sampling. Use [the generated diagram and complete catalog](sales-orders-hosted-coverage.md) to inspect every family and its denominator before launching the long full selection.
