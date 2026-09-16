# Other agents: product commission audit and recovery

Recovery applied on **2026-09-16**, migration **20260916023724_recover_other_agents_product_commissions**, for workspace **کۆگای حەسەن مامەد**.

Recovered **247,150 IQD** across 18 fulfilled orders. All recovered commissions remain **tracked and nonpayable**. No payments, payouts, recoveries, inventory movements, partner balances, loan/ledger records, rules, profiles, or privileges changed.

| Agent | Recovered IQD | Current all-time tracked IQD | Current September tracked IQD |
| --- | ---: | ---: | ---: |
| فراس مزيد | 6,550 | 75,200 | 75,200 |
| مندوب خالد | 45,100 | 149,800 | 147,800 |
| مندوب حسن | 195,500 | 380,000 | 380,000 |
| **Total recovered** | **247,150** | | |

Ibrahim remains at **232,700 IQD** all-time and **228,500 IQD** for September. Workspace tracked total is now **837,700 IQD** all-time and **831,500 IQD** for September.

The repair removes the creator-attribution customer-payment condition consistently on the server and in Local mode. Creator/delivery-only aggregate adjustments now record the product difference with zero plan commission; repeated reconciliation of an unchanged derived entitlement adds no entries. Fully returned derived commissions reverse their aggregate to zero.

Eight later occurrences of duplicated item IDs were repaired across seven audited orders, preserving every physical row and every business field. Creator assignments were added for six eligible orders before their sync timestamps changed, retaining historical assignment events and rates. Free bonus quantities are excluded.

The backfill appended **117 product commission records** (110 initials and seven restorations), **18 aggregate records**, and **six creator assignments**. Every original commission and assignment record remains byte-for-byte intact. Existing reversals on SO-2026-00016 were retained.

Verification completed:

- 119 relevant Vitest tests passed: 44 local lifecycle, four Cloud/Hybrid request and failure-handling, 29 PostgreSQL migration/calculation, and 42 existing backfill/movement/mode regression tests.
- ESLint, application TypeScript checking, and Git whitespace checks passed.
- The final SQL was rehearsed against the deployed engine under rollback, including a same-transaction replay and a hypothetical full return. The full-return aggregate and product nets both reached zero, and the rehearsal left stored data unchanged.
- Post-application audit confirms product and aggregate totals match for all four field agents, with zero financial commission entries.
- Current assigned beneficiary orders have zero duplicated item-ID groups and zero quantity mismatches. Every product group for Firas, Khalid, and Hasan has recorded commission history.
- Fingerprints confirm no changes to protected financial, inventory, business, rule, or profile data; only audited technical item IDs/sync metadata and new commission/assignment rows changed.
- Function owners, execution privileges, and empty search paths are unchanged. Security advisors found no new findings.
- A post-application rollback-only replay passed without any new or changed stored records.

The following sections preserve the initial audit.

## Initial read-only audit

Read-only audit completed on 2026-09-16 for workspace **کۆگای حەسەن مامەد**, after Ibrahim's targeted recovery. No database mutations, reconciliation calls, backfill migrations, payments, or rule changes were performed.

## Result

All three other field agents need commission recovery on existing assignments. There are also six fulfilled staff-created orders whose automatic creator assignments are blocked by the current full-customer-payment condition. Those additional amounts require resolving that eligibility condition before recovery; they are not currently eligible for automatic creator-assignment creation.

Amounts are IQD.

| Agent | Existing affected orders | Confirmed missing/reversed commission | Orders awaiting creator assignment | Potential additional commission |
| --- | ---: | ---: | ---: | ---: |
| فراس مزيد | 5 | 3,850 | 1 | 2,700 |
| مندوب خالد | 5 | 45,100 | 0 | 0 |
| مندوب حسن | 2 | 3,500 | 5 | 192,000 |
| **Total** | **12** | **52,450** | **6** | **194,700** |

Potential combined recovery is **247,150 IQD**, if the creator-attribution condition is changed to follow fulfillment-based tracking. This is an audited target, not an applied result.

## Existing assignments requiring recovery

All listed orders are completed, commission-enabled, tracked, and have active assignments. The missing initial amounts use applicable historical fixed IQD product rules; existing records use their locked per-product rates. Existing rates and rule IDs match the applicable historical rules in the affected scope. None of these orders has returned or bonus quantities.

| Agent | Sales order | Affected product lines | Additional IQD | Finding |
| --- | --- | ---: | ---: | --- |
| مندوب خالد | SO-2026-00014 | 6 | 1,900 | No product or aggregate commissions |
| مندوب خالد | SO-2026-00015 | 18 | 9,300 | No product or aggregate commissions |
| مندوب خالد | SO-2026-00028 | 4 | 1,600 | No product or aggregate commissions |
| مندوب خالد | SO-2026-00038 | 25 | 10,000 | No product or aggregate commissions |
| مندوب خالد | SO-2026-00048 | 13 | 22,300 | No product or aggregate commissions |
| فراس مزيد | SO-2026-00016 | 7 | 2,400 | Existing commission reversals leave a zero net amount |
| فراس مزيد | SO-2026-00021 | 2 | 550 | Duplicate item IDs omit physical quantities |
| فراس مزيد | SO-2026-00032 | 1 | 350 | Duplicate item IDs omit physical quantities |
| فراس مزيد | SO-2026-00045 | 1 | 250 | Duplicate item IDs omit physical quantities |
| فراس مزيد | SO-2026-00063 | 1 | 300 | Duplicate item IDs omit physical quantities |
| مندوب حسن | SO-2026-00068 | 1 | 2,500 | Duplicate item IDs omit physical quantities |
| مندوب حسن | SO-2026-00073 | 1 | 1,000 | Duplicate item IDs omit physical quantities |

Khalid's five affected orders have 66 qualifying lines and no recorded aggregate or product commission history for their assignments. Two orders are paid, two are partly paid, and one is unpaid. Current reconciliation no longer requires full customer payment for an existing beneficiary assignment.

Firas's SO-2026-00016 originally accrued 2,400 IQD. Its append-only history repeatedly reverses and restores all seven product commissions, ending at zero on September 6. The current order is fulfilled, unpaid, commission-enabled, not returned, and still actively assigned. Both the current server product reconciler and local existing-assignment reconciler target those seven paid product quantities independently of customer payment. Recovery should append the missing restoration and retain the entire prior history; the audit does not establish what caused the historical toggling.

Firas's four other affected orders contain five pairs of identical physical product lines sharing item IDs. One carton from each pair has been omitted from commission. Hasan's SO-2026-00068 and SO-2026-00073 similarly omit five and two cartons of باكس خل48عدد at the recorded 500 IQD/carton rate.

Give only the later occurrence of each duplicate a deterministic unique technical item ID before reconciliation. Preserve every physical line, quantity, unit, price, allocation, and fulfillment field. Existing product snapshots and their rates must remain intact.

## Fulfilled orders blocked by creator attribution

The deployed `private.ensure_order_creator_product_commission_assignment` still returns without attributing an ordinary staff-created order until it is fully customer-paid. The local counterpart in `src/local-db/agentCommissions.ts` has the same condition. Marketplace delivery attribution is a separate path.

These six completed, tracked, commission-enabled orders were created by users linked to active field agents. They have no active creator-beneficiary assignment for that agent. All listed product lines have applicable all-assigned fixed IQD rules. Recorded fulfillment includes the paid quantities plus any free bonuses; the potential commission amounts below exclude all free bonus quantities.

| Agent | Sales order | Customer payment status | Product lines | Potential additional IQD |
| --- | --- | --- | ---: | ---: |
| فراس مزيد | SO-2026-00076 | unpaid | 9 | 2,700 |
| مندوب حسن | SO-2026-00025 | unpaid | 6 | 18,000 |
| مندوب حسن | SO-2026-00040 | partial | 8 | 42,500 |
| مندوب حسن | SO-2026-00051 | partial | 6 | 61,500 |
| مندوب حسن | SO-2026-00062 | unpaid | 4 | 62,500 |
| مندوب حسن | SO-2026-00071 | unpaid | 4 | 7,500 |

Hasan's five orders total 192,000 IQD; Firas's order totals 2,700 IQD. Historical rule versions and rates at fulfillment match those at the current derived-assignment event timestamps in this scope.

Hasan's SO-2026-00071 also has one pair of product lines sharing an item ID: four physical lines but only three distinct IDs. That collision must be repaired before initial reconciliation to recover the full audited 7,500 IQD.

For fulfillment-based commission tracking, remove the ordinary creator-assignment full-payment gate consistently in Cloud/Hybrid and Local paths, then recover only these audited orders with their historical terms. Do not post customer payments to make them eligible.

## Verification and limits

- Audited all 47 assignments belonging to the three other field agents, including all-time history. Ibrahim was also checked as a control and has no remaining quantity or missing-initial-commission gaps on his current assigned orders.
- Compared physical order-item groups with immutable commission accruals and signed adjustment/reversal quantities. Comparing aggregate and product totals alone would miss these errors because both totals currently agree.
- All 111 non-deleted workspace product rules are fixed IQD and all-assigned. Historical applicability and recipient eligibility were checked.
- Current aggregate and product net totals match for every field agent. No active nonzero product history is orphaned from its order, assignment, or item ID.
- All active aggregate entries for these agents are tracked. No approval, payout, or recovery entries were found.
- Fulfillment is verified from sales-order item quantities and fulfillment fields. The remote inventory-transactions table contains no linked sales-order movement records for these orders, so it cannot independently confirm physical inventory movement. Order item line totals match saved subtotals for the twelve existing affected orders.
- This is a read-only SQL audit; no application calculation or transaction code was changed, so no new Vitest tests were introduced. Any subsequent eligibility change or backfill must have calculation/request/transaction coverage and a deployed rollback-only reconciliation check before application.
- Recheck all source records immediately before a recovery, preserve existing history, verify idempotency, and verify no inventory, payment, partner balance, or ledger changes for tracked commissions.

If all audited recoveries are applied, with the creator-attribution change, September totals are expected to become:

| Agent | Current September IQD | Expected September IQD |
| --- | ---: | ---: |
| فراس مزيد | 68,650 | 75,200 |
| مندوب خالد | 102,700 | 147,800 |
| مندوب حسن | 184,500 | 380,000 |

Ibrahim's September total remains 228,500 IQD. Expected workspace all-time tracked total would be 837,700 IQD, compared with the current 590,550 IQD.
