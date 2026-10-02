# Developer module tests

For architecture, contracts, isolation, and extension instructions, read the
[agent extension guide](./developer-testing-agent-guide.md). Sales Order Resilience Lab owns Sales Order stateful verification and preserves
shared domain regressions. Other modules keep their own independent suites.

Standalone Sales Order **Cloud / Hybrid request contracts**, Business Partners **Order
summary refresh**, and POS **Checkout** include deferred sales-order summary
coverage. Tests hold summary RPCs open and verify that confirmed create/edit
saves finish, payments and ledger effects remain correct, draft stock is unchanged,
both counterparties refresh after a customer change, and failed summary writes
enter the existing offline retry queue. Refresh-ordering tests prevent older
summary writes from overwriting newer totals. Deferred saves now commit recovery
jobs to IndexedDB before reporting success. The authenticated workspace resumes
them at startup, reconnect, wake, and periodic retry. A completed refresh removes
its job only after remote acknowledgement or durable offline-queue handoff, and
only if a newer save has not replaced that job. Recovery forces sync even when
cached totals match, covering interruption between the local write and upload.
Tests cover database reopen, workspace isolation, overlapping saves, missing local
sources, job-storage failure with an idempotent payment retry, and recovery cleanup.
Jobs contain references, not order/payment operations; recovery does not repeat
the transaction. Clearing application storage removes these device-local jobs.
Local-mode saves still await their summaries. These are disposable IndexedDB and mocked request checks, not native
SQLite or live Supabase integration tests.

The Resilience Lab **Focused domain contracts** and POS **Checkout** groups also run payment-account
member-visibility checks. They verify workspace/member filtering, the
`payment_accounts.account_member_restrictions` Cloud / Hybrid request contract,
offline retry handoff, and hard deletion when access is restored. This is an
application visibility preference; it does not replace or change the existing
workspace-scoped account RLS policy.

Start the development server with `npm run dev`, open its localhost URL, and go
to **Products → Developer tests**, **Orders → Sale Orders → Developer tests**, **POS → Developer tests**, or **Post Service → Developer tests**. The button and runner are enabled
automatically during development and excluded from production builds.

The default frontend port is 5173, matching Tauri's development URL. If another
web development server occupies it, use `npm run dev -- --port 5176`.
The `npm run dev:testing` convenience command also
works and binds the server to localhost. For reviewing the modal without logging
into Atlas, open `/__atlas-dev-testing/preview` for Sale Orders or
`/__atlas-dev-testing/preview?suite=pos` for regular POS on the local development server.
Use `/__atlas-dev-testing/preview?suite=post-service` for Post Service.
Use `/__atlas-dev-testing/preview?suite=products` for Products.

The modal selects test groups, accepts a reproducible unsigned 32-bit seed and
1–10,000 generated sequences for SORL (1–100 for other suites), streams individual results, retains failed diagnostics,
reruns failed groups with the original seed, and exports a JSON report. Cancel
terminates the active child process tree and cancels remaining groups. Reopening or
reloading the modal attaches to the active runner; restarting Vite starts a new
session. Only one run is allowed per server. Reports are saved under the ignored
`.atlas-test-runs/<run-id>/report.json` directory. These contain disposable
fixture names and test diagnostics, not credentials or current-workspace data.

The same registry and controller work from the command line and CI:

```sh
npm run test:sales-order-resilience
npm run test:sales-order-resilience -- --groups generated,regressions --seed=42 --runs=100
npm run test:sales-order-resilience:integration
npm run test:sales-order-resilience:stress
npm run test:sales-order-resilience:entitlements
npm run test:sales-order-resilience:e2e
npm run test:pos
npm run test:pos -- --groups checkout,remote-contract,failure-recovery --seed 42 --samples 100
npm run test:pos:live
npm run test:post-service
npm run test:post-service -- --groups remote-contract,failure-recovery --seed 42 --samples 16
npm run test:products
npm run test:products -- --groups catalog-lifecycle,units-stock --seed 42 --samples 16
npm run test:products:live
```

The CLI exits nonzero for failed, skipped, empty, timed-out, or cancelled runs.
It does not silently retry a failed check. Successful runs mean the selected
checks passed; the report also records environment coverage gaps.

## Hosted Supabase checks

The [Sales Order Resilience Lab](./sales-order-resilience.md) uses disposable,
run-scoped workspaces and real admin, staff, viewer and observer users. Its five
selectable groups each pair isolated checks with normal-JWT hosted checks.
Provisioning and cleanup alone use a parent-only service key; business actions
run through Atlas modules and normal authenticated clients. It includes actual
SQLite restart and Hybrid mutation-journal recovery, and six curated Playwright
journeys across desktop and mobile. Browser and native-device results are
reported separately; WASM SQLite verifies SQL persistence but cannot establish
OS or native-driver behavior.

Configure `.env.atlas-live-tests.local` from the existing live example, then
`.env.atlas-resilience.local` with `SORL_SUPABASE_URL` matching its origin and
`SORL_PROVISIONING_KEY` for controlled provisioning. Deploy the checked-in SORL
actor-permit and Sales Order authorization migrations first. Neither file is
committed. See the lab guide for profiles, fixture ownership, cleanup, fault
injection, shrinking and replay.

Products and regular POS keep their existing guarded hosted runner and
module-owned scenarios. Read [Products coverage](./developer-testing-products.md)
and [POS coverage](./developer-testing-pos.md). Their Cloud/Hybrid checks use a
normal dedicated admin and an exact `DEV TEST` workspace; the runner blocks
mismatched targets and limits requests to the configured HTTPS Supabase origin.
Their existing hosted checks do not prove native SQLite mirror behavior.

## Sales Order Resilience Lab coverage

SORL replaces the exclusive Cartesian catalog and wrapper engine. The
`generated` group runs preconditioned action sequences with an independent model,
`regressions` preserves deterministic failure reproductions, `faults` covers
interruption, concurrent retry and sync recovery, `entitlements` verifies plans,
grants, staff permissions and RLS, and `domain-contracts` preserves focused
production regressions for financing, UoM/free quantities, services, statements,
printing, pricing and integrity audits. The last group is useful domain knowledge,
not a replacement permutation catalog. All five IDs have matching `liveGroups`.

The integrity-audit contracts remain registered in `domain-contracts`. Read
[Transaction Reconciliation & Integrity Audit](./transaction-reconciliation-integrity-audit.md)
and [Module-Wide Transaction Integrity Audit](./module-wide-transaction-integrity-audit.md)
for their evidence limits and production behavior. The Sales Order contract
also checks idle-scheduled execution and severity-colored breadcrumb status.
Exact files and localized
coverage text are in the authoritative registry and en/ku/ar `devTesting.resilience`.

## Loan Integrity Audit coverage

The selectable **Loan Transaction Integrity Audit** group covers Supabase and SQLite graph reads, loan balance reconstruction, repayment and reversal links, payment-account movement checks, installment reconciliation, linked partner scope, Hybrid mirror parity, the JSON snapshot, the Loans breadcrumb action, idle scheduling after detail readiness, pending and completed icon colors, severity precedence, and friendly read failures. Its hosted selection creates and audits a simple POS loan in the verified DEV TEST workspace, then confirms that the same loan ID is not visible when queried under another workspace. The audit is read-only and its persisted payment-transaction set is checked before completion.

Run the isolated selection with `node scripts/dev-testing/cli.mjs --suite loans --groups integrity-audit`. Run the paired hosted selection with `node scripts/dev-testing/cli.mjs --suite loans --groups integrity-audit --environment hosted-supabase`. Hosted execution is opt-in and requires the configured DEV TEST workspace. Browser interaction, other workspace roles, and Hybrid native SQLite parity remain separate checks.

## Business Partners coverage

The `business-partners` suite includes a **Statement templates and balance colors**
group. It checks legacy template defaults, HEX validation, balance signs and zero,
A4 rendering, and the Cloud / Hybrid client save contract with friendly failure
copy. Run it with `node scripts/dev-testing/cli.mjs --suite business-partners --groups account-statement-templates`.

## E-Commerce coverage

The `ecommerce` suite's **Storefront configuration** group checks storage-rule
composition and source selection, the five-additional-storefront workspace cap,
slug-specific stock-display rules and selected-storage quantities, optional
catalog price-filter parsing, workspace/storefront-scoped Supabase request
contracts and failure propagation, and migration constraints. Run it with
`node scripts/dev-testing/cli.mjs --suite ecommerce --groups storefront-configuration`.
These checks use a mocked Supabase client and inspect migration source; they do
not exercise live RLS, deployed Edge Functions, order delivery, or the public
storefront in a browser.

## Regular POS coverage

The independent `pos` suite covers production checkout for cash and all four
POS digital providers, USD/IQD/EUR/TRY, optional payment accounts, services,
loans/installments, cart and held-sale helpers, bulk and automatic discounts,
conversion and immutable rate snapshots, stock batches, storage permissions,
partial/full refund audit entries, exchanges, financing returns, barcode parsing,
Activities, Quick Order routing, Cloud/Hybrid request/result/failure contracts,
staff-only minimum selling price checks with Admin bypass and pre-write rollback,
idempotent retries and atomic rollback. Generated cases belong to POS and do not
reuse Sale Orders' scenarios. The complete rendered POS checkout and Sales return
dialog are not automated by this suite.

Local transaction checks use disposable IndexedDB, with an additional recording
SQLite adapter test for commit/rollback. Hosted cases verify selected Supabase
SQL and persisted effects; broader permissions, native Local and Hybrid
persistence/restart, and scanner/camera/printer hardware remain unavailable.
Read [the POS implementation and agent handoff](./developer-testing-pos.md) before
expanding the suite or changing its production transaction boundaries.

The `inventory` group verifies Local POS sale and product-archive movement rows,
Cloud/Hybrid authoritative inventory request metadata and returned movement
records, plus Local atomic stock adjustments and the Cloud stock-adjustment RPC. `returns-exchanges` checks
Local POS return and exchange movements; the Sale Orders `related-units` group
checks Local order fulfillment, return and unit-conversion movements. These isolated tests
verify client behavior, not the hosted database trigger. The migration must be
deployed before direct Cloud/Hybrid inventory writers receive the database
capture safeguard. No historical inventory rows are backfilled.

## Independent Post Service coverage

The `post-service` suite has 13 groups covering merchant profiles, shipment
creation, dispatch, status lifecycle, returns and redispatch, COD/prepaid
obligations, adjustments, settlements and actual payments, account movements,
balances, calculations/reporting, permissions, remote contracts and failure
recovery. Fixed currency/payment matrices run alongside independent seeded
lifecycles. Existing application defects remain visible as failing checks,
following the agent guide's rule against fixing bugs during suite implementation.
Read the [Post Service handoff](./developer-testing-post-service.md) for accounting
expectations, reproduction details and unavailable environments.

## Extending it to another existing module

1. Add a suite and allowlisted test groups to `src/dev/testing/suites.json`.
   Provide suite-specific `samplesHelpKey` and `coverageHelpKey` translations.
   Each group has a stable ID, localized title key, explicit layer, and fixed
   repository test paths. Keep cases isolated with independent expected values.
2. Mount the shared `DeveloperTestButton` with that suite ID behind both
   `import.meta.env.DEV` and `__ATLAS_DEV_TESTING__`. Load it lazily, as Orders does.
3. Add translations in English, Kurdish, and Arabic. Document any unavailable
   environment adapters instead of marking them passed.
4. Verify the suite through the shared CLI, controller tests, and both desktop
   and narrow mobile layouts.

The Vite plugin runs only on development servers, never builds or production
preview servers. HTTP requests must
come from loopback, use a loopback Host, and have same-origin request metadata.
Mutations require the per-server random token. The controller accepts suite/group
IDs and bounded numeric options, never shell text or arbitrary paths. Vitest
children use a minimal environment without app credentials or NODE_OPTIONS;
their config disables dotenv loading, uses a non-routable backend URL, and blocks
live fetches. All business simulation occurs in those separate processes, never
by swapping the current browser's database or Supabase client.
