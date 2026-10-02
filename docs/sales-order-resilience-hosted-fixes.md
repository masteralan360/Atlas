# Hosted Sales Order Resilience Lab fixes · 2026-10-02

Reviewed export: `atlas-sales-order-resilience-5734880f-38ad-46c5-b81b-714b88f9e424 (1).json`.
Environment: hosted Supabase, Hybrid; seed `20260918`, 100 generated samples.
The failures were in Domain contracts; generated, regression, fault and
entitlement groups passed in the supplied export.

| Reported failure | Cause and fix |
| --- | --- |
| 13 `remote_order_save_confirmation_failed` completion/UoM checks | Creation posted its initial payment before its parent existed. The new `create_sales_order_with_initial_payment` RPC commits the parent, payment and account-derived effects in one transaction. It preserves RLS and all existing triggers, returns server order/unit snapshots, and replays the same order/payment identity without another receipt. |
| Return reconciliation expected no failures | The test provided posted return items but omitted the inventory restoration. Added the matching canonical movement; the audit's missing-history and restoration checks remain unchanged. |
| `group_timeout`, `runner_did_not_finish` | The isolated domain selection had a three-minute process budget for 57 files. It now has its own complete domain profile and 15-minute budget, 120-second fixture hooks, and unchanged 30-second isolated assertion timeout. Hosted domain tests retain their existing 30-minute group budget. |
| Audit dialog failed collection once the full selection ran | Its translation mock removed `initReactI18next`. The partial mock preserves real initialization exports. |
| Template/account fixtures failed setup in the full selection | Fixtures dynamically import substantial app dependencies. Restored the domain fixture budget and changed the template fixture's explicit 30-second override to 120 seconds. No assertion timeout, expected result or skip was relaxed. |

The deployed migration is
`supabase/migrations/20261002123202_create_sales_order_with_initial_payment.sql`.
The RPC uses `SECURITY INVOKER` with an empty search path, denies anonymous
execution, and checks the actor, workspace and Orders access. No payment guard
or RLS policy was disabled or weakened.

`SORL-REG-006` is registered in Domain contracts for isolated and hosted runs.
Isolated Cloud/Hybrid checks cover invalid returned scope without cached order,
payment, account or stock effects. Hosted checks use normal authenticated actors
and independently inspect committed records. They cover:

- Initial paid saves with and without a selected account, exact payment/account
  movements and balances, and unchanged draft inventory.
- A committed response lost before local acknowledgement, followed by retries
  that persist one order and one payment.
- Conflicting receipt reuse and rejected accounts, with no partial parent,
  payment or account movement after rejection.
- Foreign-workspace users, viewers, staff without Sales Orders Access, and
  revoked Orders grants receiving access denial.

The final complete paired Domain contracts selection passed in run
`94aaca93-232f-45d7-ae51-b57be1aa849b`: **462/462 checks passed**,
comprising 428 isolated and 34 hosted checks, with no failures, skips or runner
errors. This includes all 13 originally failing hosted completion/UoM scenarios.
The machine-readable result is saved at
`.atlas-test-runs/94aaca93-232f-45d7-ae51-b57be1aa849b/report.json`.

An earlier verification, `e5542107-422a-4693-b52f-d2187e122f6e`, already passed
all 34 hosted cases but exposed the isolated setup timeouts described above.
Those fixture errors were repaired before the final paired run.

Focused verification passed 76 payment/audit/controller cases, the two audit
rendering cases, all 37 template cases, the two isolated response-contract cases,
and four hosted payment cases. App and Node type checks and focused lint have
also passed; existing payment-hook dependency warnings remain unrelated.

Reproduce the full UI/controller selection:

```powershell
node scripts/dev-testing/cli.mjs --suite sales-order-resilience --environment hosted-supabase --groups domain-contracts --seed 20260918 --samples 100
```

Restart a running development server so it loads the updated registry and
controller. No additional Supabase environment configuration is required.
Verification created fresh run-scoped fixtures. Normal cleanup removed five
disposable workspaces from each hosted verification namespace and disabled all
20 test actors. Two workspaces retain immutable account-linked test history:
`05da04b6-d804-4a40-a58d-5002bd2bb61a` (final run) and
`2c6dc996-2e37-497b-b2e9-75f01a0c4a9a` (earlier run). No audit guard was
bypassed to remove that history; neither namespace has pending cleanup timeouts.
