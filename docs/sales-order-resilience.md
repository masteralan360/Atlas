# Sales Order Resilience Lab

The authoritative Sales Order test engine is `sales-order-resilience` (SORL).
It compares generated, preconditioned user commands with a small independent
reference model after each action. Configuration is sampled, never expanded into
a Cartesian catalog. fast-check shrinks failing commands and their arguments.

Read the [15-item implementation report](./sales-order-resilience-report.md)
for commands, provisioning, verified boundaries, bugs and validation results.

## Migration inventory

Removed the exclusive legacy catalog, matrix, registration and thirty hosted
wrappers in `src/dev/testing/hosted/salesOrders`, `saleOrdersHosted*Live.test.ts`,
the `saleOrders.test.ts` matrix, `salesOrdersManifest.mjs`,
`salesOrdersHosted.test.mjs`, and `buildSalesOrdersCoverage.mjs`. Removed the
`sale-orders` registry entry and its CLI/controller denominator machinery.

Preserved production regression tests (orders, financing, pricing, payments, print,
units and integrity audits). They verify useful domain behavior independently of
the legacy engine. Moved the shared order input, stock/payment assertions and
hosted fixture helpers to neutral names: POS and Business Partners use them.
Preserved the Business Partner hosted statement regressions; they are owned by that
suite. The new lab does not import the legacy engine.

## Execution and evidence

Commands execute production module functions. Isolated runs use disposable Dexie
and SQLite databases; hosted runs authenticate run-scoped users and use an
independently authenticated observer. Provisioning and cleanup alone may use
the service role. The browser receives only an actor's ordinary credentials.

Reports include seed, shrink path, command replay path, model, observed graph,
commands, failing invariant, mode, actor, plan, fixture IDs and request faults.
Known failures belong in `scenarios/regressionScenarios.ts` with a permanent SORL
ID. A failure is never converted into a skip or a changed expected result.

`SORL-REG-006` preserves paid-on-creation failures from exported run
`5734880f-38ad-46c5-b81b-714b88f9e424`. Domain contracts check the atomic
`create_sales_order_with_initial_payment` RPC: ordinary actor RLS and existing
payment/account guards apply, rejection rolls back the parent and payment, and
lost-response retries return one receipt with the server's immutable unit
snapshots and order number. Hosted observers check the order, payment ledger,
account movement/balance, unchanged draft inventory, and conflicting retries,
with and without a selected account. Cloud and Hybrid client contracts check
returned-record scope and prevent caching an invalid response.

The isolated domain selection uses the full domain Vitest configuration and a
15-minute process budget for its registered files, 120 seconds for fixture setup,
and 30 seconds for individual assertions. Hosted domain contracts keep
their 30-minute process budget and 120-second per-test limit; timed-out or
unfinished checks fail the run. Model generation retains its separate profile.

## Integrated Hybrid Playwright runner

The SORL dialog also exposes **Hybrid Playwright**. Open the Sales Order list
(`/#/en/orders/sales`), open **Sales Order Resilience Lab**, then choose
**Hybrid Playwright**. This is part of the existing developer testing dialog;
the generated state-machine, hosted groups, shrinking, deterministic replay,
existing Playwright journeys and regression tests remain separate SORL paths.

The runner reads only `.env.atlas-live-playwright-tests.local` from the Atlas
repository root. Set `ATLAS_LIVE_SUPABASE_URL`,
`ATLAS_LIVE_SUPABASE_KEY` (the publishable/anon key),
`ATLAS_LIVE_TEST_EMAIL`, `ATLAS_LIVE_TEST_PASSWORD`, and
`ATLAS_LIVE_WORKSPACE_ID`. `ATLAS_LIVE_WORKSPACE_NAME` is optional but, when
set, must match exactly. The workspace name must start with `DEV TEST`; the
workspace must be configured, unlocked, scoped to the user, and report
`data_mode=hybrid` both in Supabase and the authenticated Atlas workspace
snapshot. A Cloud or Local workspace is rejected before plan preparation and
again before execution. The browser signs in through the normal login form with
the configured ordinary user; no service-role key or existing browser session
is accepted.

Choose **Prepare scenarios** to sign in to the target app, inspect the resolved
workspace features and Sales Order payment-method options, and create a bounded
timeline. Preparation makes no order or financial writes. Each row has a stable
`SO-HYB-*` ID, translated name and description, capability requirements,
prepared dimensions, expected UI/persisted effects, assertions, cleanup
requirements and a SHA-256 signature over the prepared contract and discovered
capability snapshot. Refresh
the timeline after changing workspace access or feature configuration. A run
rechecks the workspace and feature fingerprint and requires re-preparation if
they have changed; selected and remaining runs reuse the original prepared rows
and signatures.

| ID | Scenario | Current execution boundary |
| --- | --- | --- |
| `SO-HYB-001` | Draft create and reload | Runnable when Orders, Business Partners, Products and Storage are available. |
| `SO-HYB-002` | Draft edit and reload | Runnable with the same capabilities; verifies the original order ID, edited line/total, reload and Dexie cache. |
| `SO-HYB-003` | Draft cancellation | Runnable with the same capabilities and order-management access. Uses the real list action and confirmation. |
| `SO-HYB-004` | Repeated save protection | Runnable with the same capabilities. Repeats the actual save control and checks for one persisted draft. |
| `SO-HYB-005` | Service-only and mixed line orders | Skipped when Services is unavailable. Otherwise creates an unpaid service-only draft and a mixed product/service draft through the real Sales Order form, then verifies both customer relationships, line prices/totals, null service storage, Dexie reload, no payment, and unchanged inventory. |
| `SO-HYB-006` | Approval request and review | Skipped until the dedicated config supplies a separate authorized requester/approver identity flow. |
| `SO-HYB-007` | Payment, refund, reversal and financing | Payment methods are discovered from the real form. Skipped if unavailable; otherwise blocked until financial execution and audit-preserving cleanup are implemented. |
| `SO-HYB-008` | Native Hybrid mirror and restart recovery | Blocked in this browser runner. Native SQLite and desktop restart behavior require the Atlas desktop runtime. |

**Run all**, **Run from here**, and **Run this scenario** operate only on
runnable prepared rows. The coverage report separately lists available,
skipped, blocked, and unverified areas, including exact missing capability
names. The current runner does not claim coverage for customer/product
unlinking, order completion, approval rejection, quantity boundaries, discounts,
alternate UoM, currency conversion, optional payment-account behavior, financial
ledger effects, payment reversals, financing, returns/refunds, role and plan
restrictions, controlled failed/lost responses, native SQLite, or desktop
restart recovery. Existing SORL hosted
domain contracts continue to cover many of those server-side behaviors, but
they do not turn them into browser-runner passes.

Runnable scenarios use a unique run marker and customer, product, and (when
Services is enabled) service fixtures created through authenticated Atlas
module APIs. Browser form interactions create, edit, reload, cancel, and save
service-only and mixed drafts. For `SO-HYB-005`, the persisted business-partner
ID and customer-facet ID are checked separately because Atlas stores both
relationships. An authenticated Supabase observer checks the exact order,
lines, totals, payment absence, and unchanged inventory; the app's Dexie cache
is checked after saves and reload. Cleanup verifies run ownership and
dependencies. It soft-deletes unpaid run-owned drafts through the authenticated
workspace-scoped Supabase client only after checking exact identity, draft
status, and the absence of payment and inventory records. Product/service
fixtures are deleted with the Atlas product API. Customer facets and partners
are retired through authorized Atlas sync RPCs after checking for active order
and loan dependencies, avoiding an unbounded directory hydration. Only
run-created storage is retired. Each cleanup is verified in Supabase.
Cancellation stops later scenarios,
finishes the current scenario, enters cleanup and becomes terminal only after
cleanup completes or its failure is recorded. Cleanup failures are displayed
beside the original failure and in run diagnostics.

Progress, logs, screenshot paths, traces, diagnostics, cancellation and JSON
exports belong to the `sales-order-resilience` suite and its run ID. The shared
server permits one active Cloud/Hybrid Playwright execution at a time; a
conflicting run receives a clear conflict response. POS continues to use its
own scenario matrix and default routes. The Sales Order interface is
Hybrid-only and never imports the POS scenario definitions.

The runner verifies real browser behavior, Supabase persistence and Dexie cache
behavior. A browser session connected to a Hybrid workspace does **not** verify
the native SQLite mirror, Electron/Tauri restart recovery, or desktop-specific
offline synchronization. Those boundaries remain blocked/unverified until a
desktop runtime adapter is added. Results export downloads the sanitized run
JSON; screenshots, trace and `report.json` are stored beneath
`.cloud-hybrid-playwright/artifacts/sales-order-resilience/<run-id>/`.

Common readiness failures are a missing dedicated env file, a workspace not
named `DEV TEST…`, a locked/unconfigured workspace, an account outside the
configured workspace, a non-Hybrid `data_mode`, or missing Orders entitlement.
Resolve the stated prerequisite, then refresh the timeline. If a feature changes
after preparation, explicitly prepare the timeline again. If cleanup reports an
error, use the run ID and diagnostics path to identify retained run-owned rows;
the runner does not delete records whose ownership cannot be proven.
