# Developer module tests

For architecture, contracts, isolation, and extension instructions, read the
[agent extension guide](./developer-testing-agent-guide.md). Sale Orders is the
first independent V1 suite using shared infrastructure; its business scenarios
are a reference implementation, not a universal specification for other modules.

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

Start the development server with `npm run dev`, open its localhost URL, and go
to **Orders → Sale Orders → Developer tests**, **POS → Developer tests**, or **Post Service → Developer tests**. The button and runner are enabled
automatically during development and excluded from production builds.

If another development server occupies port 1420, use
`npm run dev -- --port 1422`. The `npm run dev:testing` convenience command also
works and binds the server to localhost. For reviewing the modal without logging
into Atlas, open `/__atlas-dev-testing/preview` for Sale Orders or
`/__atlas-dev-testing/preview?suite=pos` for regular POS on the local development server.
Use `/__atlas-dev-testing/preview?suite=post-service` for Post Service.

The modal selects test groups, accepts a reproducible unsigned 32-bit seed and
1–100 generated cases, streams individual results, retains failed diagnostics,
reruns failed groups with the original seed, and exports a JSON report. Cancel
finishes the current group and cancels the remaining groups. Reopening or
reloading the modal attaches to the active runner; restarting Vite starts a new
session. Only one run is allowed per server. Reports are saved under the ignored
`.atlas-test-runs/<run-id>/report.json` directory. These contain disposable
fixture names and test diagnostics, not credentials or current-workspace data.

The same registry and controller work from the command line and CI:

```sh
npm run test:sale-orders
npm run test:sale-orders -- --groups matrix,lifecycle --seed 42 --samples 100
npm run test:pos
npm run test:pos -- --groups checkout,remote-contract,failure-recovery --seed 42 --samples 100
npm run test:pos:live
npm run test:post-service
npm run test:post-service -- --groups remote-contract,failure-recovery --seed 42 --samples 16
```

The CLI exits nonzero for failed, skipped, empty, timed-out, or cancelled runs.
It does not silently retry a failed check. Successful runs mean the selected
checks passed; the report also records environment coverage gaps.

## Hosted Supabase checks

Sale Orders and regular POS have a separate **Hosted Supabase** environment in
their Developer Test dialogs. It signs in as a dedicated admin test user and
runs production functions against a dedicated Cloud or Hybrid `DEV TEST`
workspace. Sale Orders creates real partner, storage, product, financed order,
loan and payment records. POS creates its own storage, product, batch, sale,
payment, loan and return records. Some
financial history remains for audit; use an empty test workspace, never a
business workspace. A Hybrid selection checks its Supabase source of truth,
but does not exercise the desktop SQLite mirror.

Copy [the configuration example](./developer-testing-live.env.example) to
`.env.atlas-live-tests.local` in the Atlas root, then set the project URL,
publishable or legacy anon key, dedicated admin email/password, and exact
workspace ID/name. Give this test account access to only that workspace. The
filled file is gitignored. The local runner checks the account's current and
only visible workspace, its `DEV TEST` name, Cloud/Hybrid mode, and the
required Supabase schema before each live group. A mismatch blocks the run before
scenario writes. The developer UI receives readiness and the target identity,
never the credentials. Network requests in the live child are limited to the
configured Supabase HTTPS origin. The isolated environment remains network
blocked.

The eight regular Sale Orders groups are also selectable in Hosted Supabase.
Each selection runs its complete existing isolated group in a credential-free,
network-blocked child, then runs a focused live scenario in a separate child.
Results are labeled **Isolated checks** or **Hosted Supabase**. A group passes
only if both parts pass; a local assertion is never presented as proof of a
server effect. The hosted scenarios cover payment methods and overpayment,
print source records, partner statements, draft and approval lifecycle,
fractional prices and discounts, related-unit stock, payment account movements,
and workspace-scoped order reads. Printing and UI role/layout cases still rely
on their isolated checks; the live printing scenario verifies saved print input,
and the access scenario verifies only the dedicated admin account's workspace.
The Payments live case needs the Payment Accounts module enabled in the target
workspace. Account and unit configuration created by passing scenarios may
remain because financial and order history can refer to them.

The independent `live-transactions` group creates a paid cash Quick Order and
full return, plus simple-loan and installment sale orders with and without a
down payment. It uses production functions and fresh authenticated clients to
check stored orders, returns, loans, installments, payment counter-entries and
stock. It also completes a regular pending Sale Order through the atomic
completion RPC and verifies one stock deduction with one sale-ledger entry.
The group races that completion against financed cancellation and verifies
that a cancelled order has no stock deduction or sale-ledger entry, while a
completed order has exactly one of each. Earlier hosted checks tested pending
cancellation and completed Quick Orders separately; they did not test those
two transitions competing on the same order. The runner refreshes the
workspace's storages into its local cache before creating test storages, so
existing primary or marketplace locations remain respected.
The target project must have the app's current Sale Orders migrations deployed,
including `cancel_order_with_financing` and
`complete_sales_order_with_inventory`.
The report records run and fixture IDs to aid investigation. A failed fixture
is retained for inspection; the test may retire a successful catalog item.
The hosted related-units group follows the supported Sale Order lifecycle for
two paid packs and one free pack at a factor of 20. It verifies that stock moves
from 100 base units to 40, then back to 100 after a full return, with linked
payment reversals. A separate live check calls the atomic Quick Order RPC with
an active product conversion and requires it to reject the request before an
order, payment, or stock movement is created. This boundary requires the
`reject_related_unit_quick_orders` migration on the target project.
Run it from the dialog or with `npm run test:sale-orders:live`. This command is
opt-in and is excluded from normal `npm test` and isolated developer runs.

Regular POS uses the same guarded hosted environment with POS-owned fixtures.
Its hosted groups pair isolated checks with focused live checkout, payment,
account, pricing, currency, batch, related-unit, financing, return, service,
authorization and rollback scenarios. Cart, media uploads and UI access remain
isolated-only selections and are labeled accordingly. Run
`npm run test:pos:live`; its cases do not exercise Instant POS. Post Service,
browser interaction and native SQLite still require separate live adapters or
scenarios. Isolated request contracts remain useful for failures and retries,
but only hosted cases prove their selected server effects.

## Sale Orders V1 coverage

The generated matrix calls the production order, payment, return, and financing
functions against disposable fake IndexedDB, with fresh data for every case.
Payment methods come from the app's shared registries rather than a separate
list. The fixed cases cover regular creation and Quick Orders, USD/IQD, optional
payment accounts, unpaid obligations, partial/full payments, approval, edits,
soft deletion, reservation, completion, reload, cancellation, partial/full
returns, services, stable retry identities, and important validation failures.
Assertions read saved orders, inventory, transactions, linked reversals, account
movements/balances, loans/installments, and the ledger's production projection.
Seeded cases add fractional prices/quantities with checkout and full return.

Existing regression groups add financing repayment/reversal, stock aggregation,
commission mode snapshots, customer summaries, currency conversion, pricing,
and rounding. Mocked Cloud/Hybrid request contract tests remain as standalone
Vitest unit tests for client retry, offline queue, invalid server result, and
friendly failure behavior; they are no longer a selectable Sale Orders group.
The Hosted Supabase group covers the financed Sale Order cancellation server
effect. The lifecycle group retains Local financing cancellation cases.
Run the read-only manual SQL check in
`supabase/manual_checks/check_cancelled_order_linked_loans.sql` separately; the
suite does not change historical cancelled orders.

Browser automation of the real order form, Hybrid desktop SQLite mirroring,
Local native SQLite persistence/restart, and exhaustive live Supabase/RLS
coverage remain outside these groups. The modal and report label those gaps.
IndexedDB reopen verifies cache survival only; standalone remote mocks verify
client contracts only. Hosted scenarios verify their selected server effects,
not every module workflow or permission role.

## Business Partners coverage

The `business-partners` suite includes a **Statement templates and balance colors**
group. It checks legacy template defaults, HEX validation, balance signs and zero,
A4 rendering, and the Cloud / Hybrid client save contract with friendly failure
copy. Run it with `node scripts/dev-testing/cli.mjs --suite business-partners --groups account-statement-templates`.

## Regular POS coverage

The independent `pos` suite covers production checkout for cash and all four
POS digital providers, USD/IQD/EUR/TRY, optional payment accounts, services,
loans/installments, cart and held-sale helpers, bulk and automatic discounts,
conversion and immutable rate snapshots, stock batches, storage permissions,
partial/full refund audit entries, exchanges, financing returns, barcode parsing,
Activities, Quick Order routing, Cloud/Hybrid request/result/failure contracts,
idempotent retries and atomic rollback. Generated cases belong to POS and do not
reuse Sale Orders' scenarios. The complete rendered POS checkout and Sales return
dialog are not automated by this suite.

Local transaction checks use disposable IndexedDB, with an additional recording
SQLite adapter test for commit/rollback. Hosted cases verify selected Supabase
SQL and persisted effects; broader permissions, native Local and Hybrid
persistence/restart, and scanner/camera/printer hardware remain unavailable.
Read [the POS implementation and agent handoff](./developer-testing-pos.md) before
expanding the suite or changing its production transaction boundaries.

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
