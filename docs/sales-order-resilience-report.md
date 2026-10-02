# Sales Order Resilience Lab: implementation report

The implementation results below are historical. The later
[hosted failure fixes and verification](./sales-order-resilience-hosted-fixes.md)
address the paid-on-create failures, return fixture, audit mock and domain-runner
setup/time budgets reported here.

SORL (`sales-order-resilience`) is the authoritative Sales Order testing
architecture. Its primary engine uses fast-check commands with model
preconditions, actual Atlas module calls, an independent reference model,
invariants after every action, deterministic shrinking, and exact replay.
Configuration is sampled without expanding a Cartesian catalog.

1. **Legacy files removed.** Removed `scripts/dev-testing/salesOrdersManifest.mjs`,
   `salesOrdersHosted.test.mjs`, `buildSalesOrdersCoverage.mjs`, the entire
   `src/dev/testing/hosted/salesOrders/` engine, all thirty
   `saleOrdersHosted01Live.test.ts` through `saleOrdersHosted30Live.test.ts`
   wrappers, the fixed `saleOrders.test.ts` and `saleOrdersMatrixLive.test.ts`
   matrices, and the duplicate broad `saleOrdersLive.test.ts`. Removed the old
   registry entry, case catalog/count machinery, configuration and coverage docs.
2. **Useful files retained.** No legacy engine remains. Focused production
   regressions for completion, financing, services, units, pricing, lifecycle,
   archiving, printing, statements and audit remain as `contracts/domain*Live`
   tests and the `domain-contracts` registry selection. Shared helpers moved to
   `fixtures/orderInput.ts`, `fixtures/orderLive.ts`, and
   `assertions/orderEffects.ts`; POS and Business Partners still need them.
   Agent statement/netting checks use neutral names and remain registered in
   Business Partners as well as SORL. These are independent domain contracts.
3. **New files.** `src/dev/testing/salesOrderResilience/` contains `model/`,
   `commands/`, `invariants/`, `drivers/`, `fixtures/`, `faults/`, `scenarios/`,
   `runner/`, `contracts/`, and `e2e/`, plus paired isolated/hosted test entry
   points. `scripts/dev-testing/resilience*.mjs`, two Vitest configurations and
   the Playwright configuration provide the profiles. The registry, controller,
   CLI, localized coverage and violet lab dialog were migrated together.
4. **Npm commands.** See the commands below. The default profile runs 100
   generated Local sequences plus fixed regressions, faults and entitlement
   checks; stress runs 2,000; integration runs 100 Cloud sequences plus the
   paired regressions and faults. All five selectable groups have matching
   `liveGroups` IDs and `isolatedGroupId` links. Browser checks run separately.
5. **Provisioning.** The parent creates UUID-tagged `DEV TEST SORL <run-id>`
   workspaces and actual Auth users. The canonical workspace is configured,
   unlocked Business, with a second Business workspace for tenant probes.
   Authenticated admin and observer clients perform and inspect business work.
   A service key is used only for fixture provisioning and exact-ID cleanup;
   child processes receive the public key and ordinary actor credentials.
   The actor-permit migrations use expiring, single-use, service-only permits
   rather than bypassing registration with untrusted user metadata. The private
   manifest and reports are gitignored. Admin actors have no permission rows.
6. **Admin Orders grants.** Business and Enterprise use plan-derived Orders
   access. Basic with no override fails; Basic with an explicit Orders grant
   succeeds; an explicit revoke disables Business Orders. Tests read the stored
   overrides and use the production resolver and real RLS writes. Fixture
   customer data is seeded before a Basic plan downgrade; unrelated modules
   are not granted for the entitlement probe. Focused contracts explicitly
   grant their existing services, agents, agent accounts and Quick Order
   dependencies; ordinary generated runs keep the canonical Business fixture.
7. **Staff permissions.** Enterprise staff authenticate as separate users with
   and without `orders.saleOrdersAccess`. A viewer with that route permission
   remains unable to write. Hosted probes verify positive authorized writes,
   denied writes, service-only permit rejection, and exclusion of real foreign
   rows. The browser checks the actual ProtectedRoute. Admin permission checks
   remain implicit, while module restrictions still apply.
8. **Local/Hybrid persistence.** Local sequences use disposable Dexie plus a
   real SQL.js SQLite connection through the production adapter. Reload exports
   and reopens SQLite, clears IndexedDB, then hydrates it from SQL. Entitlements
   are reconstructed from browser cache and SQL snapshots. Hybrid runs use
   Supabase as authority and the real SQLite mirror; offline mutation-journal
   restart, acknowledgement and commercial/inventory convergence are checked.
   Browser grant access is checked again after blocking Supabase and reloading.
9. **Actions.** Create; add/remove product; edit quantity, price, customer and
   discount; save/reopen; request/approve/reject; pending/complete; partial/full
   payment; return; cancel/delete; offline/online; sync/reload; repeat create,
   payment, return and completion. Preconditions keep sequences meaningful.
   The editor and persisted model are separate. Create retries replay the
   original request identity, including after subsequent draft edits.
10. **Invariants.** Independent rounded totals and balances; positive unique
    lines; currency and customer persistence; base quantities; stock and
    movement conservation; exact returned quantities/refunds; unique payments
    and return identities; linked reversal portions and ledger net; optional
    account movements/balances; parent/child and tenant integrity; equivalent
    reload state; monotonic versions; queue acknowledgement and convergence.
    Financing schedules, exchange snapshots, services, free quantities and
    additional currencies have focused contracts. The primary generator uses
    USD/IQD, standard non-financed methods, physical base-unit lines and optional
    accounts; it does not claim to fuzz every financing or unit configuration.
11. **Faults.** Actual authenticated transport failure before a payment RPC;
    a committed RPC response being discarded; response loss on return-item
    persistence; overlapping payment/completion/return retries; cold return
    identity recovery; same-key/different-return intent rejection; offline
    edits, double synchronization and SQLite restart. A separate JWT attempts
    a stale conditional write. This last check exercises the version boundary,
    not two complete independently running module caches.
12. **Playwright.** Three real journeys at 1440px desktop and 375px mobile:
    draft creation/save/reopen/reload with an independent Supabase observer;
    Basic grant/revoke route access and disconnected cached-grant reload;
    Enterprise staff access and the distinct lab dialog fitting its viewport.
    There are no mock business operations and no browser permutation matrix.
    Screenshots and masked bootstrap diagnostics support failures. Login traces
    are disabled because they can record passwords and JWTs.
13. **Replay.** Every generated failure saves its seed, failing run/attempt,
    configuration, model before/after, observed graph, executed actions,
    invariant, fixture IDs, transport history, shrink path and ready-to-run
    command. fast-check shrinks commands and arguments. Exact replay needs the
    seed, command limit, counterexample path and command replay path, plus the
    boundary/mode for a hosted run. Hosted replay provisions a fresh namespace.
14. **Bugs discovered.** Fixed duplicate return effects with a stable request
    identity and in-flight coalescing; persisted return identity recovery and
    conflicting retry rejection; immediate return-dialog submission guarding;
    lost cached Orders grants; missing Hybrid SQLite mutation-journal mirroring;
    rejection of valid publishable Supabase keys; viewer/direct Sales Order
    access bypass; and retry-create version/draft overwrite. Seed `20261002`,
    path `35:0`, command replay `B:B` shrank the last bug to Create → Save →
    RetryCreate; permanent `SORL-REG-005` now covers it in both environments.
    The focused contract run also caught the retry return-value regression,
    which was fixed to return the acknowledged record. Unrelated existing
    failures are preserved and reported below.
15. **Validation.** Exact command/results and known failures appear below.
    Passing selections establish their stated boundaries; a failed focused
    contract remains failed in the registry and UI.

## Commands and setup

```sh
npm run test:sales-order-resilience
npm run test:sales-order-resilience -- --seed=42 --runs=100
npm run test:sales-order-resilience:stress
npm run test:sales-order-resilience:integration
npm run test:sales-order-resilience:integration -- --mode=hybrid --groups=regressions,faults
npm run test:sales-order-resilience:entitlements
npm run test:sales-order-resilience:e2e
npm run test:sales-order-resilience -- --groups=domain-contracts
npm run test:sales-order-resilience:integration -- --groups=domain-contracts
npm run test:sales-order-resilience:replay -- --seed=20261002 --max-commands=60 --path=35:0 --replay-path=B:B
```

`--runs` accepts 1–10,000; `--max-commands` accepts 1–500. Replay through
Supabase adds `--boundary=supabase --mode=cloud` or `--mode=hybrid` and uses the
command limit from its report. Do not substitute a different limit or omit the
command replay path when reproducing a minimized case.

Install dependencies with `npm ci`, and Chromium with
`npx playwright install chromium`. Configure the existing
`.env.atlas-live-tests.local` using its example and a verified DEV TEST
bootstrap actor/workspace. In the gitignored `.env.atlas-resilience.local`, set
only `SORL_SUPABASE_URL` (the identical origin) and `SORL_PROVISIONING_KEY`.
The checked-in actor-permit and Sales Order access migrations must be deployed.
No business driver receives the provisioning capability. The hosted network
guard permits only the configured origin.

Successful cleanup guards each exact tracked workspace ID and namespace before
calling the existing cascade. Immutable account-linked audit history is retained
without weakening database guards, and test users are soft-deleted to disable
sign-in while preserving audit foreign keys. A cascade statement timeout is
explicitly recorded as pending cleanup; the actors are still disabled. Failures
retain their tagged fixture and private manifest for investigation. Never reuse
these fixture credentials for production work.

## Validation and preserved defects

Validation was performed on 2 October 2026 with seed `20261002`. Logs are under
the ignored `.atlas-dev-testing/` directory.

| Selection | Result | Evidence log |
| --- | --- | --- |
| Local stress | 2,000 generated sequences; all 17 test cases pass (152.72s) | `resilience-stress-verified.log` |
| Cloud integration | 100 generated sequences; all 11 test cases pass (840.57s) | `resilience-integration-final.log` |
| Hybrid regressions, faults and entitlements | All 16 cases pass (161.23s) | `resilience-hybrid-verified.log` |
| Cloud entitlement selection | All 6 cases pass; Hybrid also exercises the strengthened foreign-row probe | `resilience-entitlements-final.log` |
| Exact minimized replay | Passes with seed `20261002`, path `35:0`, command replay `B:B`, 60-command limit | `resilience-replay-verified.log` |
| Real Playwright journeys | All 6 desktop/mobile cases pass (3.2m), with no retry or skip; fixture cleanup completes | `resilience-browser-standalone.log` |
| Controller, hosted preparation and client contracts | All 41 cases pass | `controller-verified.log` |
| Isolated focused domain contracts | 423 pass, 1 assertion fails; 1 additional file cannot load its i18n mock (55/57 files pass) | `resilience-domain-verified.log` |
| Hosted focused domain contracts | 19 pass, 13 fail at the existing paid-on-create boundary (11/13 files pass) | `resilience-contracts-verified.log` |
| App/Node TypeScript project build and root typecheck | Both pass after replacing ES2021-only diagnostic string calls with ES2020-compatible handling | `build-final.log`, `typecheck-root-verified.log` |
| Production build | Passes, including TypeScript project build, Vite (33.89s) and PWA generation | `build-final.log` |
| Changed source ESLint | Passes with 0 errors; 13 warnings, including ignored configuration-file notices | `lint-verified.log` |
| Repository ESLint and dialog conventions | Existing control-regex error and three existing generic-dialog violations; reproduced on the original checkout | `lint.log`, `lint-dialogs-final.log`, `baseline-lint.log`, `baseline-dialogs.log` |
| Repository unit run | 2,546 pass, 28 fail, 57 skip; 324/345 files pass | `unit-health.log` |
| Original-checkout comparison | Targeted baseline run reproduces 26 failures and existing UI/mock loading failures; some full-run setup timeouts are intermittent | `baseline-health.log` |

The retained isolated audit fixture supplies return items without the matching
inventory history, while expecting no failures; the oracle reports
`RETURN_INVENTORY_HISTORY_UNAVAILABLE` and `RETURN_INVENTORY_RESTORATION_MISMATCH`.
The retained audit-dialog test cannot load because its existing `react-i18next`
mock omits `initReactI18next`. Neither assertion was removed or relaxed.

A browser run concurrent with the production build reached Atlas's existing
startup recovery screen after a reload (5/6 passed). The standalone final run
passes all six. An earlier disconnected bootstrap also intermittently stalled;
the suite keeps these failures visible, has no automatic retry, and retains
masked startup diagnostics rather than treating a later pass as proof of
flakiness being eliminated.

The repository-wide failures also include existing commission recovery and
marketplace migration expectations, capital-pool reversal netting, date-sensitive
installment status, Post Service partial-commit recovery, technical error
disclosure and settlement currency isolation, plus UI mocks/setup timeouts.
These unrelated selections retain their failures. The focused Quick Order retry
contract passes all 34 cases after the introduced acknowledgement-return
regression was corrected.

The focused contracts preserve an existing paid-on-create defect: normal
`createSalesOrder(..., { requireRemoteConfirmation: true })` posts its initial
payment before the order exists. The database's
`prevent_order_payment_overpayment` trigger correctly rejects it with
`order_payment_source_not_found` (`23503`), surfaced as the friendly
`remote_order_save_confirmation_failed` error. Thirteen retained completion/UoM
contracts reproduce this boundary; their assertions and workflows remain intact.
Reproduce with the hosted `domain-contracts` command above. Seed `20261002`,
100 samples; retained fixture namespace
`DEV TEST SORL 69a97ebc-33b0-4e46-89ab-a4b7de6fd939`.

The general [agent testing guide](./developer-testing-agent-guide.md#bugs-discovered-during-suite-implementation)
requires preserving and reporting existing defects. The user's explicit SORL
instruction authorizes fixes for generator-discovered bugs; it does not justify
weakening unrelated legacy contract assertions to manufacture a passing suite.

WASM SQL persistence does not prove native desktop filesystem/driver behavior.
The core does not prove every financing configuration, invoice layout,
commission rule, return interruption point, or operating-system recovery path.
The real hosted project uses dedicated run-scoped test workspaces; tests never
copy or operate on production business rows.

Baseline comparison logs are retained. Git unregistered the temporary baseline
worktree, but could not remove its directory because of a Windows path-length
failure. Automatic approval review blocked the subsequent recursive cleanup;
the leftover directory remains under the ignored `.atlas-dev-testing/baseline/`.
