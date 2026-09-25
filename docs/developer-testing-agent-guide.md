# Developer testing: agent extension guide

This is the implementation handoff for agents expanding Atlas's developer
testing system. Read the repository's `AGENTS.md` first and use
[developer-testing.md](./developer-testing.md) for the operator quick start.
The source files referenced here are authoritative when implementation changes.

**Sale Orders is the first independent module suite, implemented in V1.** It
uses shared testing infrastructure, but its fixtures, scenarios, lifecycle,
financial assertions, and coverage choices belong to Sale Orders. Other modules
should follow the same architectural pattern and define coverage around their
own behavior. They do not inherit Sale Orders' business rules or need to copy
its group structure. Think of it as a reference implementation of the shared
runner architecture, rather than a universal test specification.

## 1. What exists today

- `npm run dev` automatically enables developer testing. Open Atlas through
  localhost, then **Orders → Sale Orders → Developer tests**, **POS → Developer tests**, or **Post Service → Developer tests**.
- Production builds exclude the entry point and runner client from the emitted
  application dependency graph. Production preview servers do not install the
  runner. Keep both protections when extending the system.
- The modal chooses registered groups, accepts a reproducible seed and sample
  count, displays streamed results, reruns failed groups, and exports JSON.
- A local Node controller executes existing Vitest tests in separate processes.
  The browser never substitutes its current workspace database with test data.
- UI runs and CLI runs share the registry, execution controller, and reporter.
  The selected environment chooses the isolated or hosted Vitest configuration.
- Sale Orders V1, regular POS and Post Service are independent suites. Sale Orders
  and POS have opt-in hosted Supabase groups; Post Service retains isolated
  request contract groups. POS cart, media uploads and UI access are local-only
  selections even in a hosted run. Complete browser, Hybrid native, and Local
  native adapters remain unavailable.

"Selected checks passed" means precisely that. It is not a guarantee of no
bugs, every possible scenario, or coverage of the unimplemented adapters.

## 2. Architecture and ownership

```text
Module page: development-only, lazy DeveloperTestButton(suiteId)
    → shared DeveloperTestDialog + testRunnerClient
    → same-origin Vite middleware
    → TestController → allowlisted Vitest child processes
    → reporter events → live run state → finished JSON report

CLI → the same TestController and registered suite
```

| Responsibility | Source | Reuse boundary |
| --- | --- | --- |
| Development enablement | `vite.config.ts`, `src/vite-env.d.ts` | Shared infrastructure |
| Suite and group registry | `src/dev/testing/suites.json` | Shared schema; each suite owns its entries |
| Result/session types | `src/dev/testing/types.ts` | Shared infrastructure |
| HTTP, validation, execution, cancellation, report persistence | `scripts/dev-testing/controller.mjs` | Shared infrastructure |
| Vite import declaration | `scripts/dev-testing/controller.d.mts` | Keep synchronized with plugin signature changes |
| Reporter protocol | `scripts/dev-testing/reporter.mjs` | Shared infrastructure |
| Isolated test configuration and fetch guard | `scripts/dev-testing/vitest.config.mts`, `networkGuard.ts` | Shared baseline for current Vitest groups |
| CLI and localhost convenience server | `scripts/dev-testing/cli.mjs`, `dev.mjs` | CLI already accepts any registered suite |
| Button, modal, HTTP client | `src/dev/testing/DeveloperTestButton.tsx`, `DeveloperTestDialog.tsx`, `client.ts` | Reusable components with suite-specific description metadata |
| Runner/client regression tests | `scripts/dev-testing/controller.test.mjs`, `src/dev/testing/client.test.ts` | Test the infrastructure independently of business coverage |
| Browser visual harness | `src/dev/testing/preview.tsx` | Registry-driven navigation; Sale Orders by default, `?suite=pos` or `?suite=post-service` |
| Minimal browser import stubs | `src/dev/testing/fixtures/browser.ts` | Reuse only for compatible Node tests; not a rendered browser |
| Sale Orders scenario suite | `src/dev/testing/suites/saleOrders.test.ts` | Sale Orders-specific |
| Sale Orders inputs and generation | `src/dev/testing/fixtures/saleOrder.ts` | Sale Orders-specific |
| Order financial/stock assertions | `src/dev/testing/assertions/saleOrders.ts` | Sale Orders-specific |
| Page integration | `src/ui/pages/Orders.tsx` | Entry point on the sales tab only |
| Regular POS scenario suites | `src/dev/testing/suites/pos*.test.ts` | POS-specific, excluding Instant POS |
| POS fixtures and assertions | `src/dev/testing/fixtures/pos.ts`, `posLive.ts`, `src/dev/testing/assertions/pos.ts` | Independent of Sale Orders fixtures and business rules; hosted fixture verifies the workspace and records IDs |
| POS SQLite adapter stub | `src/dev/testing/fixtures/sqlite.ts` | Recording contract adapter, not native persistence |
| POS production persistence | `src/local-db/posCheckout.ts`, `posSaleReturns.ts` | Used by the actual POS and Sales pages as well as tests |
| POS cart and retry snapshot logic | `src/lib/posCart.ts`, `posCheckoutAttempt.ts`, `posPaymentPolicy.ts` | Production calculations, held carts, retry identities and domain routing |
| Post Service suite | `src/dev/testing/suites/postService*.test.ts` | Independent shipment, obligation, payment and remote-contract scenarios; includes existing domain regressions |
| Post Service fixtures/assertions | `src/dev/testing/fixtures/postService.ts`, `postServiceHarness.ts`, `src/dev/testing/assertions/postService.ts` | Domain-specific and independent of Orders/POS |
| Post Service production boundary | `src/local-db/postService.ts`, `src/lib/postService*.ts`, Post Service page | Actual production APIs and shared page error mapper; see `developer-testing-post-service.md` |
| UI language strings | `src/i18n/locales/{en,ku,ar}.json`, `devTesting` namespace | Shared labels plus suite-specific descriptions |

Existing tests elsewhere in `src/` are included by the registry without moving
or duplicating them. A test can support multiple suites when its behavior is
relevant to both; this does not couple their business scenario definitions.

## 3. Registry contract

The registry is a JSON object keyed by stable suite IDs. Each definition has
`titleKey`, `groups`, and `unavailable`, plus optional `samplesHelpKey` and
`coverageHelpKey` for suite-specific localized descriptions. New suites should
provide both description keys. Each group has `id`, `titleKey`, `layer`,
and `files`. Keep group IDs unique within a suite and use explicit repository
test paths. Registry edits are trusted code changes, not user-supplied input.

This illustrative entry would be added only after its tests and translations
exist; it does not register an implemented Purchase Orders suite:

```json
{
  "purchase-orders": {
    "titleKey": "devTesting.purchaseOrders",
    "groups": [
      {
        "id": "receiving",
        "titleKey": "devTesting.groups.purchaseReceiving",
        "layer": "business",
        "files": ["src/dev/testing/suites/purchaseOrders.test.ts"]
      }
    ],
    "unavailable": ["browser-workflow", "cloud-database", "hybrid-native", "local-native"]
  }
}
```

Isolated layer values are `business`, `contract`, and `calculation`, with matching
localized descriptions. `layer` is descriptive metadata; it does not select an
execution adapter. All current groups use the same isolated Vitest configuration.
New layers need appropriate translations and, when necessary, explicit runner
support. Merely labeling a group `browser` or `native` implements neither.

Sale Orders and POS have independent `liveGroups` for the hosted Supabase
adapter. The `live` layer describes server tests, while the explicit run
`environment` selects `hosted-supabase`. A hosted group may declare
`isolatedGroupId`; the controller runs that exact isolated group first in a
credential-free, network-blocked child, then rechecks the live target and runs
the hosted files in a separate child. Each result is labeled with its actual
environment, and both parts must pass. Keep each module's live scenarios
independent; Sale Orders is a reference for runner wiring, not a universal
business fixture or assertion model. Do not move isolated files into the live
allowlist or treat a mocked request contract as a deployed database check.
For a hosted POS selection with no relevant Supabase scenario,
set `isolatedOnly: true` and `files: []`; the controller runs just the paired
isolated group, retains its isolated label and result, and makes no claim of a
server check. Document such groups in the suite coverage copy.

`unavailable` lists declared coverage gaps, rendered using
`devTesting.environments.<id>`. It is copied into reports and does not make an
otherwise successful run fail. It is not an adapter registry, and removing an
ID does not prove that the missing coverage exists. The hosted Sale Orders run
still reports the broader Cloud coverage gap beyond its selected live scenario.
For a future CI policy that
requires specific adapters, implement and test a separate coverage requirement.

## 4. Runner contracts and lifecycle

### Inputs and HTTP

The prefix is `/__atlas-dev-testing`. Every endpoint requires loopback socket
and Host checks and compatible same-origin request metadata. `/session` returns
the per-server token; subsequent JSON API requests require
`X-Atlas-Test-Token`. The token is separate from Atlas authentication and is not
a workspace role or admin grant.

| Method and path | Body | Response |
| --- | --- | --- |
| `GET /session` | None | `{ token, suites, run }` |
| `POST /runs` | `{ suiteId, groupIds, seed, samples }` | Accepted run, HTTP 202 |
| `POST /live-runs` | `{ suiteId, environment: 'hosted-supabase', groupIds }` | Accepted live run after preflight, HTTP 202 |
| `GET /live-readiness` | None | Readiness, target identity, or a blocked reason |
| `GET /run` | None | Current run or `null` |
| `POST /cancel` | `{ id }` | Current run with cancellation requested |
| `GET /preview` | None | Local-only visual harness HTML, without Atlas login |

Paths in this table are relative to the prefix. The preview is a separate plugin
route and does not require the session token. `client.ts` wraps the JSON API
with a 10-second timeout, abort support, omitted credentials, and no-store fetches.
It maps known errors to localized messages and hides arbitrary backend errors
behind `devTesting.errors.unavailable`.

Accepted suite/group IDs must already exist in the registry. Omitted group IDs
select all groups; supplied IDs must be a nonempty, unique, valid list. Execution
follows registry order, not the submitted list's order. The controller accepts
an integer seed from `0` to `4,294,967,295`, default `20260918`, and an integer
sample count from `1` to `100`, default `16`. HTTP bodies are limited to 4,096
characters. There is no API for arbitrary commands, scripts, paths, or credentials.

Defaults and bounds also appear in the modal and translations. Change all
relevant consumers and regression tests together if the input contract changes.

### Execution and status

Only one run may be active per controller/server, across all suites. Each group
gets a new Vitest child process; groups execute sequentially, with one Vitest
worker and isolated test files. Separate Vite servers or CLI invocations have
separate controllers, not a global machine-wide lock.

The controller supplies fixed config/reporter paths and the group's registered
test file filters to Vitest using `shell: false`. It currently allows 180 seconds
per group. The test configuration allows 30 seconds per test/hook, has no retries,
uses Node and fork workers, and includes `src/**/*.test.{ts,tsx}` except
`*Live.test.ts`. Tests outside
that include pattern need a deliberate configuration change before registry use.

The reporter emits stdout lines prefixed with `ATLAS_TEST_EVENT `:

- `collected`: all collected tests for a module, initially pending.
- `test`: one running or completed test result.
- `finished`: terminal event with unhandled, module, and nested suite errors.

The controller merges results by test ID. A group passes only with exit code
zero, a terminal event, no group errors, at least one collected test, and every
test passed. Skipped, empty, unfinished, timed-out, malformed-event, and hook-error
groups fail. Preserve this rule: a successful process exit alone is insufficient.

Cancel is cooperative at the group boundary: finish the current group, then
mark remaining groups cancelled. Ctrl+C in the CLI requests the same behavior.
Disposal/server shutdown or a group timeout terminates the spawned child; Windows
termination targets only that child PID and its descendants. Do not replace this
with machine-wide process termination. Failed groups do not prevent subsequent
groups from running unless cancellation was requested.

### Reports and UI state

`types.ts` defines test statuses (`pending`, `running`, `passed`, `failed`,
`skipped`, `cancelled`) and run statuses (`running`, `passed`, `failed`,
`cancelled`). A run contains its UUID, suite ID, seed, samples, timestamps,
cancellation flag, groups, unavailable coverage, and optional report path.
Each test includes its ID, full name, file, duration, status, and error strings.
Reporter errors retain stacks and expected/actual values where provided, bounded
to 12,000 characters; controller diagnostics are also bounded.

Finished reports are written to ignored
`.atlas-test-runs/<run-id>/report.json`. A write failure fails the run. Reports
do not include the session token. Keep fixture data and diagnostics free of
credentials and real customer/workspace data.

The modal polls roughly once per second. It blocks duplicate mutations with refs,
avoids stale polling overwriting a newer mutation, and aborts polling on closure.
While starting/running, config and submit controls are disabled, and overlay,
Escape, and X cannot close the modal. Rerun uses failed group IDs and the original
seed/sample count. Export downloads the current suite's run as JSON.

Reopening/reloading attaches to the controller's current run. Starting another
run replaces that in-memory run; disk reports remain. Vite restart loses active
session state and creates a new token. There is no history API or automatic disk
report restoration. `/__atlas-dev-testing/preview?suite=pos` opens the regular POS
suite; the default preview opens Sale Orders. Registry file changes restart Vite
and create a fresh runner session, so finish a run before editing its registry.

## 5. Isolation and Atlas data modes

Vitest children inherit only a small operating-system environment allowlist,
plus `NODE_ENV=test`, `FORCE_COLOR=0`, `ATLAS_TEST_SEED`, and `ATLAS_TEST_SAMPLES`.
They do not inherit app credentials, `VITE_*`, or `NODE_OPTIONS`. Their config
sets `envDir: false`, substitutes non-routable backend URLs and a placeholder
key, and installs a fetch guard that rejects live network calls.

Hosted Supabase runs deliberately use a separate `vitest.live.config.mts` and
the gitignored `.env.atlas-live-tests.local`. Only the configured test URL,
publishable/anon key, test credentials, workspace ID/name and run ID enter that
child. Do not pass the app's service-role key or current browser session. The
server performs a fresh login and checks the exact `DEV TEST` workspace before
each group; the test repeats the guard before mutations. The live network guard
allows only the configured HTTPS origin and rejects redirects. This is a
trusted test process boundary, not an operating-system firewall. Hydrate remote
storages before creating test storages: `createStorage` determines the primary
and marketplace flags from the local cache, which starts empty in the live
child even when the hosted workspace already has storages. Any new live
scenario must use run-scoped fixtures, query its own IDs through a fresh
authenticated client, inspect server effects, report fixture IDs, and describe
retained audit records. Live tests must stay out of normal `npm test` and the
isolated controller config.

This is process/environment isolation, not an operating-system sandbox or a
complete network firewall. Trusted repository tests can still access filesystem
or other networking APIs. Do not add isolated tests that open the user's native
database, load app secrets, start business synchronization, or contact a live
workspace. The hosted adapter may contact only its verified dedicated test
workspace. Do not weaken the shared guard to make a missing mock pass.

The Sale Orders matrix uses `fake-indexeddb/auto`, deletes/reopens its disposable
database before each case, uses a test-only workspace ID and Local mode snapshot,
clears mode state afterward, and deletes the test database at teardown. It
installs minimal browser stubs before dynamically importing production functions
whose dependencies expect browser globals. Those stubs do not simulate DOM
interaction, layout, or a desktop runtime. Suites must reset any additional
storage, timers, mocks, mode state, or caches they introduce.

| Atlas mode | Actual source of truth | Evidence a future adapter must supply |
| --- | --- | --- |
| Cloud | Supabase; Dexie is a responsive/offline cache | Real migrations/RPCs, permissions, persisted records, transaction effects, cache/sync behavior where relevant |
| Hybrid | Supabase, with native SQLite mirror and Dexie | Cloud behavior plus native mirror consistency, failure/recovery and restart checks |
| Local | Device SQLite; no Supabase business sync, with Dexie | Native persistence, transaction effects, restart and relevant UI/cache consistency |

A Local mode snapshot in a fake-IndexedDB test does not exercise Local SQLite.
A Dexie close/open proves cache survival, not native application restart. Mocked
Supabase calls prove client contracts, not SQL atomicity or RLS permissions.

Future integration adapters need disposable databases/directories, explicit
readiness checks, bounded resource use, teardown, distinct coverage reporting,
and adapter-specific regression tests. The current fixed Vitest launcher and
environment are not sufficient for every future runtime. Extend infrastructure
deliberately rather than smuggling credentials or live endpoints through suite
options. A browser adapter must run the actual UI against isolated test data,
not click the user's current workspace to create test transactions.

## 6. Sale Orders: independent V1 coverage

The `sale-orders` registry entry owns these groups:

| Group | Scope |
| --- | --- |
| `matrix` | Production order/payment/return functions with fixed and generated scenarios |
| `lifecycle` | Existing financing and installment regressions plus the Cloud / Hybrid inventory completion RPC contract |
| `live-transactions` (hosted) | Real Supabase cash checkout/full return, regular Sale Order atomic completion, and a concurrent financed cancellation/completion race with persisted inventory and sale-ledger effects |
| `pricing` | Existing pricing, exchange, rounding, customer-balance, and line-storage checks |
| `payments` | Payment transactions, accounts, reversals, ledger effects, and direct-transaction voucher numbering and A4 layout |

All eight isolated Sale Orders groups (`matrix`, `printing`,
`account-statement`, `lifecycle`, `pricing`, `related-units`, `payments`, and
`ui-access`) have corresponding hosted selections. Each retains its full
isolated checks and adds a scoped live scenario: method checkout and return;
persisted print inputs; partner statement balance; draft edit/deletion and
approval; fractional pricing and discount; regular Sale Order product unit
conversion, stock, return, and atomic Quick Order rejection;
selected/unselected payment account movements; or workspace-scoped access.
Do not infer full live parity from the paired selection. Extend the live file
when a new behavior needs database verification, and extend the isolated file
for its local or contract behavior. Keep their expectations independent.

Use the registry for the exact current file list. The matrix draws payment
methods from the shared app registries. It covers standard methods, USD/IQD,
optional payment accounts, draft/payment/pending/completion paths, paid and
unpaid Quick Orders, partial payments, approval, editing, soft deletion,
cancellation, partial/full returns, services, financing with/without down payment,
stable save identities, overpayment/reversal validation, locked orders, and
workspace mismatch. Generated inputs vary fractional quantities/prices, currency,
and payment method through checkout and full return.

Assertions read saved records and verify expected stock, paid/outstanding amounts,
payment transactions, linked reversal counter-entries, ledger projections,
account movements/balances, and financing records where relevant. Expected values
must be independently derived; calling the calculation under test to generate
its own expected result cannot demonstrate correctness.

The Payments group also checks Local direct-transaction voucher assignment,
partial reversal history and remaining amount, legacy ID fallback, A4 table
chunking, and signature lines. Mocked Cloud / Hybrid checks verify the insert
return value, workspace-scoped chain read, pending offline state, and read failure.
The Print & Save check verifies that the edited A4 PDF and voucher identity are
passed to the standard document snapshot and immutable PDF-version persistence
flow, including validation and failure propagation. A separate Cloud / Hybrid
contract check verifies the workspace-scoped invoice parent request, PDF upload,
version RPC response, and cleanup when version creation fails.
The SQLite adapter check verifies atomic local counter allocation and rollback
when the payment row cannot be persisted.
Cloud / Hybrid numbering depends on the database
trigger in `20260923063458_direct_transaction_voucher_number.sql`; real Supabase
and native SQLite behavior require integration verification outside this suite.

Initial V1 validation with the default 16 generated cases passed 229 suite checks
and 22 runner/client checks. These are historical validation counts, not a target
for every suite or a fixed count after future changes. Even the existing
`SalesOrderFormPage.test.ts` registry entry tests utilities, not a rendered form
workflow. Broader Supabase SQL/RLS, order-form automation, Hybrid native
mirroring, and Local native persistence remain explicitly unavailable.

Do not reuse `saleOrderInput`, `seededCases`, or order-stock/payment assertions in
unrelated modules merely because they already exist. Extract a shared helper only
when its semantics actually apply to multiple independently defined suites.

### Independent regular POS suite

Regular POS is registered as `pos` and mounted on `/pos`, without an Instant POS
entry point. Its fixtures, assertions, generator and thirteen groups are independent
from Sale Orders V1. Cash, FIB, QiCard, ZainCash and FastPay use the shared immediate
payment registry; loans create obligations. POS Quick Orders remain normal Sales
Orders and Activities retain their own transaction domain.

Read [the POS agent handoff](./developer-testing-pos.md) for production entry
points, transaction boundaries, group ownership, failure/recovery behavior and
hosted fixture rules. Existing stock, payment, exchange and Quick Order regressions
can support both suites without coupling their scenario definitions.

## 7. Extension workflow

### Bugs discovered during suite implementation

When implementing or expanding a testing suite, agents **must not immediately
fix bugs they discover in existing application behavior**. Continue the planned
suite implementation without turning it into a bug-fixing task. Suite
implementation does not implicitly authorize repairs to the behavior being
tested; those fixes require a separate, explicit user instruction.

Either capture the bug in a reproducible test that remains failing until the
behavior is fixed, or report it after completing the suite implementation. A
failing case must not interrupt work on the remaining coverage. Do not weaken
assertions, change expected results to match incorrect behavior, or skip a known
bug just to make the suite pass. Report the delivered suite's actual result
honestly, including any failures left for follow-up.

For reported bugs, include the affected workflow, reproduction steps or test
name, expected and observed behavior, and relevant run details such as the
group, seed, and sample count. This rule concerns discovered application bugs;
agents should still correct defects in the new fixtures, assertions, or runner
code they introduce as part of implementing the suite.

### Add a scenario to an existing suite

1. Read the module's production entry points, state transitions, validations,
   and existing tests. Identify the failure or behavior the new case proves.
2. Choose the smallest relevant group and execution layer. Keep isolated cases
   independent of test order and prior runs.
3. Arrange realistic disposable records, invoke the production workflow, and
   verify persisted effects and relevant absence of unwanted mutations on failure.
4. Include rounding/boundaries for calculations and success/validation/failure
   paths for transaction changes, as required by `AGENTS.md`.
5. Run the affected group through the shared controller. Document any changed
   coverage claims; expand testing further when the change affects other groups.

### Add an independent suite for another existing module

1. Define its own coverage matrix: entry methods, state transitions, relevant
   data modes, roles/permissions, business dimensions, retry identities, and
   failure points. Include only meaningful combinations; explicitly test
   invalid combinations as rejections. Fixed regressions and bounded generated
   cases serve different purposes.
2. Implement module-specific fixtures, assertions, and scenario tests, generally
   under `src/dev/testing/{fixtures,assertions,suites}/`. Reuse existing production
   registries and relevant regression tests without copying their implementation.
3. Define what seed and samples mean for this suite. Read `ATLAS_TEST_SEED` and
   `ATLAS_TEST_SAMPLES` when generating cases, keep generation deterministic,
   and include seed/case inputs in diagnostic names. Seeds reproduce generated
   inputs, not necessarily UUIDs or timestamps. If a suite has no generated cases,
   extend the UI/contract to represent that honestly instead of implying samples
   control its checks.
4. Add the suite's registry entry, title/group/layer translations, and accurate
   unavailable coverage. No new controller branch is needed for ordinary Vitest
   groups that fit the current configuration.
5. Mount the shared button in the appropriate existing module page, lazily and
   behind the development checks. Follow the Orders integration pattern:

   ```tsx
   import { lazy, Suspense } from 'react'

   const DeveloperTestButton = import.meta.env.DEV && __ATLAS_DEV_TESTING__
       ? lazy(() => import('@/dev/testing/DeveloperTestButton'))
       : null

   // Inside the appropriate page/tab toolbar:
   {DeveloperTestButton && <Suspense fallback={null}>
       <DeveloperTestButton suiteId="purchase-orders" />
   </Suspense>}
   ```

   The example suite ID is illustrative. Do not mount an unregistered suite.
   This is build/server development gating, not a developer-account role check.
   Preserve the existing module's access rules. Adding an actual new commercial
   module still requires explicit plan/admin-grant configuration under `AGENTS.md`.
6. Set `samplesHelpKey` and `coverageHelpKey` to suite-specific localized keys.
   The dialog consumes these metadata fields, uses a neutral title fallback, and
   shares the neutral module browser-workflow label. Add new unavailable adapter
   labels to all three locales. Do not present Sale Orders' coverage claims for
   an unrelated module.
7. Run the suite using `--suite`, verify button/modal behavior at desktop and
   narrow mobile widths, and update this guide and the quick start.

For payment-producing modules, coverage must follow Atlas's existing payment
workflow: real payment transactions drive ledger entries and account movements;
full/partial reversals retain exact linked counter-entries. An unpaid obligation
is not a payment. New payment UI still uses the shared payment dialog and optional
`PaymentAccountSelector`. Tests do not bypass or redefine these business rules.

### Change shared infrastructure or add an adapter

Update controller/client regression coverage for changed contracts, isolation,
timeouts, report handling, and failure semantics. Extend reporter tests when
changing Vitest hooks or terminal-event handling. Update `types.ts` and the
declaration file when their contracts change. Verify an existing suite still
works through both UI and CLI. Keep adapter execution explicit and label what
was actually tested in reports and UI.

## 8. Commands and verification

Run commands from the Atlas repository root:

```sh
# Normal development, including the testing button/runner
npm run dev
npm run dev -- --port 1422

# Localhost-only convenience server; no longer required to enable testing
npm run dev:testing -- --port 1422

# Sale Orders, default seed and generated-case count
npm run test:sale-orders
npm run test:sale-orders -- --groups matrix,lifecycle --seed 42 --samples 100
npm run test:sale-orders:live

# Regular POS, including its own generated checkout cases
npm run test:pos
npm run test:pos -- --groups checkout,remote-contract,failure-recovery --seed 42 --samples 100
npm run test:pos:live

# Generic runner, after another suite has actually been registered
node scripts/dev-testing/cli.mjs --suite purchase-orders --groups receiving --seed 42 --samples 16

# Shared infrastructure regressions use the root Vitest config
npm test -- scripts/dev-testing/controller.test.mjs src/dev/testing/client.test.ts

# Direct isolated test execution for diagnosis; final verification uses the controller
npx vitest run --config scripts/dev-testing/vitest.config.mts src/dev/testing/suites/saleOrders.test.ts

# TypeScript and relevant UI/config lint
npx tsc -p tsconfig.app.json --noEmit
npx tsc -p tsconfig.node.json --noEmit
npx eslint src/dev/testing vite.config.ts
npm run lint:dialogs
git diff --check
```

The CLI defaults to `sale-orders`; `--suite` selects another registered suite.
`--groups` is comma-separated. It exits nonzero unless the run passed, logs each
group result, and prints unavailable coverage and the report path. There is no
new per-suite npm script requirement. Direct Vitest execution bypasses controller
validation, process environment stripping, group timeout and report persistence;
use the shared CLI to verify the delivered runner behavior. Reproduce a failure
using its suite/group selection, seed, samples, and repository revision.

For UI changes, compare structured modal behavior with
`src/ui/components/crm/BusinessPartnerFormDialog.tsx`. Verify required labels,
empty/invalid input disabling, number formatting, immediate loading/duplicate
protection, blocked closure while busy, cancellation, reattachment, failure
diagnostics, reruns, and report export. The preview route exercises the testing
modal, not the real order form. All product labels/errors must use en/ku/ar
translations and established terminology.

When changing development gating or lazy imports, verify normal `npm run dev`
enables the browser flag and session endpoint, then verify a production build's
manifest/assets contain no developer-testing entry or runner client code.
The relevant Vite condition is `command === 'serve' && !isPreview`; it does not
require an `ATLAS_DEV_TESTING` environment flag. Do not reintroduce opt-in gating
without an explicit user requirement. Shared locale strings may remain in
production; they are not executable runner code.

Report pre-existing unrelated check failures separately from new failures. Do
not weaken conventions or broaden unrelated changes just to obtain a clean
aggregate check. For documentation-only edits, check source accuracy, links,
and whitespace; rerunning business scenarios is unnecessary.

## 9. Common diagnoses

| Symptom | First checks |
| --- | --- |
| Button missing | Normal dev server, current page/tab condition, development flags, refreshed page; production deliberately excludes it |
| `local_only` | Open via localhost/127.0.0.1 on the same computer; LAN addresses and remote mobile requests are rejected |
| `invalid_session` | Vite restarted; let the modal obtain a new session token |
| `run_busy` | Another run is active on this controller, even if launched from another browser tab |
| Zero tests or skipped checks | Registry paths, isolated config include pattern, collection/setup errors; these cannot pass |
| Browser-global import error | Install compatible stubs before affected imports or improve the production import boundary; do not claim browser coverage from more stubs |
| Unexpected remote call | Missing mock or wrong mode state; preserve the live-fetch guard |
| `group_timeout` | Stalled hooks/imports, excessive generated cases or group size; fix causes before changing timeouts |
| Passing mocked contract but broken backend | Run or extend the hosted adapter on a dedicated DEV TEST workspace; mocks do not execute migrations/RPC SQL/RLS |
| Run absent after restart | Session state is in memory; use the saved disk report, not an assumed history API |

Leave each extension with its own documented scope, reproducible cases, verified
effects, and honest coverage gaps. Shared infrastructure coordinates execution;
each independent module suite supplies the evidence for that module's behavior.
