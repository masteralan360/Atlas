# Post Service developer testing: implementation and agent handoff

`post-service` is an independent module suite using Atlas's shared developer
testing runner. Sale Orders V1 and regular POS are reference implementations of
the runner architecture; their fixtures and business rules do not define this
suite. Read [AGENTS.md](../AGENTS.md), the [shared extension guide](./developer-testing-agent-guide.md)
and the [operator quick start](./developer-testing.md) before expanding it.

## Run it

Start `npm run dev`, open Atlas through localhost, and select **Post Service →
Developer tests**. The header button is available across the module's tabs,
including the staff layout, behind the existing module access rules. It is
lazily loaded with both development gates and excluded from production builds.
The login-free modal harness is `/__atlas-dev-testing/preview?suite=post-service`.

```sh
npm run test:post-service
npm run test:post-service -- --groups remote-contract,failure-recovery --seed 42 --samples 16
npm run test:post-service -- --groups settlements-payments --seed 0 --samples 100
```

CLI and UI use the same registry, controller and reporter. Reports persist in
`.atlas-test-runs/<run-id>/report.json`. A failed group does not stop subsequent
groups. Cancellation finishes the current group; a failed, skipped, empty or
incomplete group fails the run. Passing means the selected checks passed.

## Production boundary and ownership

The production entry points are in `src/local-db/postService.ts`; the actual
page is `src/ui/pages/PostService.tsx`. Tests call those functions, rather than
reimplementing shipment creation or settlement. The page's existing error mapper
was moved unchanged to `src/lib/postServiceErrors.ts` so remote failure tests use
the same mapper as the real UI. This extraction changes no error behavior.

Independent fixtures live in `src/dev/testing/fixtures/postService.ts`, Local
test setup in `postServiceHarness.ts`, and saved-data/financial assertions in
`src/dev/testing/assertions/postService.ts`. Scenario files are
`src/dev/testing/suites/postService*.test.ts`.

Each persistence test deletes and reopens disposable fake IndexedDB, seeds only
test workspaces and parties, and resets modes, connectivity, mocks and timers.
Load `fake-indexeddb/auto` before importing the database. Local scenarios fail on
unexpected Supabase requests. Remote scenarios use recording client mocks,
mocked table hydration and an immediate request wrapper; they do not exercise
the wrapper's retry policy or real server transactions. Runner isolation also
strips credentials, disables dotenv and rejects live fetches. No fixture is
written into the workspace open in the browser.

| Group | Coverage |
| --- | --- |
| `merchants` | Merchant defaults, duplicate profiles, activation, validation and history-protected deletion |
| `shipment-creation` | Four currencies, COD/prepaid creation, decimals, explicit zero fees, inherited defaults, recipient validation, received events, source-order reference and Baghdad daily tracking |
| `dispatch` | Manifest deduplication, eligible couriers, entire-batch validation, run/shipment fee snapshots, stable create-and-dispatch replay and run closure |
| `lifecycle` | Assignment, courier ownership, status events, cancellation and voice-duration boundaries; existing production Post Service regressions |
| `returns-redispatch` | Return transfer, prior manifest audit, physical receipt, stale-version guards, admin edit and stable redispatch |
| `cod-accounting` | Fixed currency × fee payer × funding × payout matrix, saved obligation lines and partner balances |
| `prepaid-accounting` | Fixed prepaid matrix, recipient payment methods/accounts, reimbursement, merchant repayment and uncovered courier fee |
| `adjustments` | COD requests/reviews, pending delivery blocker, signed delivered corrections, replay, operation mismatch and settlement-started guard; existing lifecycle regressions also cover recipient requests |
| `settlements-payments` | All standard methods and currencies, optional accounts, remittance/payout and repayment/reimbursement, fee payout, invalid/partial/full/collective settlement, FIFO allocation and seeded lifecycles |
| `calculations-reporting` | Existing FIFO/completion/net/staff-metric regressions; revenue/cost projection, generator reproducibility and scoped voice paths |
| `permissions-visibility` | Runtime admin guards, linked courier identity, workspace boundaries and view-own ledger visibility; existing visibility regressions |
| `remote-contract` | Cloud/Hybrid schema and write order, sanitized payloads, authoritative tracking, offline queue, exact tab refresh tables, correction RPC parameters and authoritative hydration, persisted settlement/payment links, rejected RPC/hydration and deferred voice cleanup |
| `failure-recovery` | Injected shipment/event/manifest/ledger failures, funding validation, recipient-payment atomicity, settlement compensation and create-and-dispatch recovery |

The registry explicitly includes existing tests without moving or duplicating
them. Group labels describe coverage, not distinct execution adapters.

## Accounting expectations

Delivery obligations are separate from real payments. A COD post with COD 100,
merchant fee 10 and courier fee 5 creates courier collection +100 and fee -5,
and merchant payable +100 and fee -10. Delivery creates no cash receipt in the
workspace. Courier handover later records an incoming payment of 95; merchant
payout records an outgoing payment of 90. Cash net is 5.

Electronically prepaid posts force COD to zero. A courier-funded recipient
payout creates courier advance and merchant debt obligations without an
immediate workspace payment. Workspace-funded recipient payout creates an
outgoing `delivery_recipient_payout` payment on delivery. Missing funding on
legacy records follows the production legacy workspace-payment treatment.

Settlement assertions verify `paymentTransactionId`, one actual transaction,
source identity/type, direction, method/currency, the general ledger's production
payment projection and signed delivery clearing lines. Account movements and
balances derive from payments, including optional selected account snapshots.
Partner summaries distinguish money held from money owed. Unrelated workspace
parties, sales, orders, loans and stock remain untouched in Local scenarios.

Amounts use Post Service's actual policy, including decimal IQD. Do not import
POS whole-IQD price rounding. FIFO and currency-isolation regressions belong to
this domain. Post revenue projections include delivery fee and courier cost;
COD and recipient transfers are not sales revenue. Source-order reference
preservation does not claim end-to-end Orders integration coverage.

## Generated cases and extension

The seed is an unsigned 32-bit integer; samples is 1–100 (default 16). Additional
cases vary four currencies, payment method, COD/prepaid, fee payer, recipient
funding, decimal amounts, account selection, collective/per-post and partial/full
settlement, postponed redispatch and eligible delivered COD correction. Each
name contains its seed, case index and input JSON. Fixed matrices always run,
even with one generated case. Changing samples preserves the earlier cases.

To add coverage, extend this domain's fixtures/assertions, add production-function
scenarios with an independent expected result, and register explicit test paths
and localized descriptions. Assert failure side effects as well as exceptions.
Do not assume an API has a stable retry key merely because another API has one.
For remote corrections, test returned hydration and signed ledger records; never
fabricate independently syncable client correction rows as a substitute for RPC.

When suite work discovers an existing application bug, keep its regression
failing or report it after implementation; continue the remaining suite work.
Do not fix the application without a separate user instruction. Fix test setup
and assertion defects introduced by the suite itself. See the exact policy in
the [agent guide](./developer-testing-agent-guide.md#bugs-discovered-during-suite-implementation).

## Declared gaps

`unavailable` retains real Supabase SQL/RLS, Hybrid native SQLite mirroring,
Local native SQLite persistence/restart, complete rendered browser workflows,
and actual microphone/voice recording/private Storage. Contract mocks and
fake IndexedDB do not prove those environments. The preview verifies only the
developer modal, not authenticated Post Service business dialogs or permissions.

## Existing defects captured by the new checks

These checks deliberately remain failing pending separate authorization to fix
application behavior. Reproduce them with the CLI commands above and the group
IDs below; they are fixed cases independent of seed/sample count.

- `failure-recovery`: a workspace-funded recipient payment is posted before the
  delivery transaction. An injected delivery-ledger failure rolls back the
  shipment/events/obligations but leaves the outgoing payment and account debit.
  The fixed case uses payout 20 and account balance 50; expected payment count
  is zero with balance 50, while the failed operation leaves one payment and balance 30.
- `remote-contract`: an unrecognized backend error passes through the existing
  UI mapper as raw technical text instead of the generic localized message.
- `settlements-payments`: collective party totals combine obligations from
  multiple currencies before choosing one currency, so the requested currency's
  expected outstanding amount includes another currency's obligation.
  With USD 95 and IQD 95 outstanding for one courier, a USD settlement reports
  expected amount 190 instead of 95.

Validation results and reproduction diagnostics are saved in the run report;
do not skip these tests or loosen their expected results to obtain a green run.

The default validation run (seed `20260918`, 16 samples) collected 444 checks:
441 passed, these three failed, and none skipped. The browser preview smoke run
passed all nine merchant checks and verified loading/close guards. Desktop and
390-pixel mobile preview layouts were checked. These are developer-modal checks,
not authenticated business-workflow automation.

The settlement/recovery run with seed `42` and 100 samples passed every generated
lifecycle: 221 of 223 checks passed, with only the two known defects in those
selected groups failing. Shared controller/client regressions passed all 22
checks. Application type checking and focused lint also passed.
The production Vite build passed; its 177 JavaScript assets contained no
developer-runner endpoint, token header, event protocol or testing-component
references.
