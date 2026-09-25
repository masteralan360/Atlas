# Regular POS developer testing: implementation and agent handoff

The `pos` suite is an independent module suite using Atlas's shared developer
runner. Sale Orders is the independent V1 reference implementation; its cases,
fixtures and lifecycle are not POS's foundation or specification. Read
[AGENTS.md](../AGENTS.md), [the shared extension guide](./developer-testing-agent-guide.md)
and [the operator quick start](./developer-testing.md) before expanding coverage.

## Run it

Start `npm run dev`, open localhost, and go to **POS → Developer tests**. The
button sits above the regular POS responsive panels, on desktop and mobile.
It uses the same development gating and lazy loading as Orders and is absent
from production builds. The localhost preview is
`/__atlas-dev-testing/preview?suite=pos` and requires no workspace login.

```sh
npm run test:pos
npm run test:pos -- --groups checkout,remote-contract,failure-recovery --seed 42 --samples 100
npm run test:pos:live
npm run test:pos:live -- --groups checkout,financing,returns-exchanges --samples 1
```

The controller saves live results and a JSON report under
`.atlas-test-runs/<run-id>/report.json`. Cancellation finishes the current group.
Only one suite runs at a time per server. Registry changes restart Vite and its
runner session. CLI, reports, pass/fail semantics and isolation are shared.

## Scope and ownership

Regular POS is `/pos` in `src/App.tsx`, implemented by `src/ui/pages/POS.tsx`.
Instant POS has separate routes and transaction behavior and is excluded here.
This suite does not add a new commercial module or change POS's plan/permission
access rules.

| Behavior | Production code | Test ownership |
| --- | --- | --- |
| Sale persistence, payments, inventory and financing | `src/local-db/posCheckout.ts` | `posCheckout.test.ts`, `posFinancing.test.ts`, `posRemote.test.ts`, `posRecovery.test.ts` |
| Price precedence, bulk discount, conversion, held-cart snapshot/restore | `src/lib/posCart.ts` | `posCart.test.ts`, `posPricing.test.ts`, `posCurrency.test.ts` |
| Frozen retry identities after uncertain responses | `src/lib/posCheckoutAttempt.ts`, POS page | `posAttempt.test.ts` and remote retry checks |
| Sale / Activities / Quick Order routing | `src/lib/posPaymentPolicy.ts` | `posRouting.test.ts`, existing policy tests |
| Refund amounts, records and linked counter-entries | `src/local-db/posSaleReturns.ts`, Sales page | `posReturns.test.ts`, remote refund contracts |
| Activities | `src/local-db/activities.ts` | `posActivities.test.ts`, existing Activities regressions |
| Barcode input | `src/lib/barcodeScanner.ts` | Existing barcode regressions |
| Batches, return stock and exchanges | Existing inventory, stock batch, Sales return and exchange adapters | Existing regressions registered alongside POS cases |

POS-specific inputs/generation live in `src/dev/testing/fixtures/pos.ts` and
financial assertions in `src/dev/testing/assertions/pos.ts`. Persistence cases delete
and reopen their disposable fake IndexedDB database and use a test-only workspace.
Business scenarios fail on unexpected Supabase calls. Remote tests supply mocks;
the controller strips app credentials and disables dotenv/live fetches.

The **Hosted Supabase** environment uses the same dedicated, verified Cloud or
Hybrid `DEV TEST` workspace as Sale Orders, with POS-owned fixtures and cases.
Configure `.env.atlas-live-tests.local` as described in
[the operator guide](./developer-testing.md). The runner checks the exact
workspace and admin account before each group, limits live requests to that
Supabase origin, and never inherits the current Atlas session or service key.
Each hosted selection first runs its complete isolated group in a credential-free
child. Checkout, pricing, currency, inventory, related units, financing,
returns, service routing, remote authorization and recovery then run separate
live cases. Cart, media uploads and UI access have **isolated checks only** in
the hosted selection; their results are labeled as such and are not server
checks. Hosted tests use `src/dev/testing/fixtures/posLive.ts`, create
run-tagged product/storage/batch records, and inspect their own IDs through a
fresh authenticated client. A passing case may retire its product; sale,
payment, loan and return audit records remain. Failed fixtures are retained for
inspection. Use an empty test workspace rather than business data.

Cash, FIB, QiCard, ZainCash and FastPay are immediate POS methods. The fixture uses
`CASH_AND_DIGITAL_PAYMENT_METHODS`; bank transfer belongs to other flows and is
not a regular POS checkout method. A POS loan uses simple financing for one
schedule row and standard financing for multiple installments. Both create an
obligation without a checkout cash receipt. Quick Orders use the normal Orders
transaction domain; Activities create their own records. Do not label those
records ordinary `origin: pos` sales or import Instant POS ticket/table/KDS rules.

## Production transaction boundaries

`commitPosCheckout(input)` accepts a typed immutable checkout payload, cashier,
timestamp, captured exchange rates, batch plans, optional loan registration and
atomic loan payload, and optional payment account. POS still owns its product
selection, metadata/payload construction, validation messages, loading lock,
payment/loan/Quick Order dialogs, success state and receipt workflow. Tests call
the persistence service used by the actual page rather than a simulated copy.

**Local:** one Dexie transaction includes sale header, line and exchange rows,
inventory/product/batch changes, payment transactions/account effects, and loan
creation. The existing SQLite authority middleware commits that complete write
set to SQLite. No business Supabase call or business offline-sync mutation is
created. A stock, payment, financing or SQLite write failure rolls back the sale's
write set. Reorder rules run afterward as follow-up work. Reusing an already
committed sale ID returns its existing result; conflicting total/currency/method
inputs are rejected.

**Cloud / Hybrid:** the existing `complete_sale` or `complete_sale_with_loan` RPC
owns authoritative sale and stock changes. One transient verification retry
reuses the same payload and sale/loan/installment IDs. Immediate receipts post
through `appendPaymentTransaction`, with the sale UUID as the stable payment UUID,
idempotent upsert and remote confirmation. Loan responses persist their returned
aggregate and create no checkout receipt. Optional account movements remain
derived from the payment transaction.

Local inventory/batch projection and invoice checkpoint commit together, after
payment confirmation. The invoice prevents a completed projection being applied
twice on replay. A cache failure rolls that projection back while retaining the
already confirmed payment, allowing replay with the same identity. Batch
reconciliation follows the projection. Neither Cloud nor Hybrid completes POS
offline or falls back to a Local sale after an RPC fault.

`PosCheckoutError` carries `saleId`, `committed` and the diagnostic cause. After a
confirmed RPC, a malformed result or posting/projection failure is a recovery
condition; the page clears the submitted cart and displays the sale reference
instead of creating another sale from it. An uncertain network response retains
the frozen attempt while the POS page remains mounted. An unchanged retry reuses
its identities and snapshot. Changing the pending cart/payment details is blocked
with a localized message. This in-memory attempt is not durable across page
unmount, reload or device restart; durable reconciliation is a future adapter.

**Local returns:** Sales uses `commitLocalSaleReturn` around its stock restoration,
return records, refund and financing effects. Selected-sale UI updates occur after
commit and financing failures propagate to roll back that scope. Reorder-rule
evaluation runs after commit so a delayed rule cannot close the Dexie transaction
early. A rule failure is logged without reporting the completed return as failed.
`persistSaleReturnLedger` records returns and POS refunds with stable return IDs,
negative payments linked to the original receipt, proportional refund amounts,
over-reversal validation, optional account selection and idempotent replay. Refund
calculations preserve zero converted prices and fractional quantities. Local
return records and the negative payment share the transaction. Cloud/Hybrid
posting remains a projection of the existing server return workflow and requires
remote payment confirmation; posting errors are friendly and do not manufacture
a successful cash entry. Older sales
without a recorded original payment retain the existing legacy refund behavior;
do not treat legacy data as proof of a linked original receipt.

## Registered groups

The registry at `src/dev/testing/suites.json` is the authoritative file allowlist.

| ID | Coverage |
| --- | --- |
| `checkout` | Payment-method × currency × optional-account matrix, physical/service checkout, cache reopen, replay, payment/account/ledger regressions, generated POS cases |
| `cart` | Independent held snapshots, fractional quantities, price-book/negotiation retention, current stock bounds, legacy/cross-storage restoration |
| `pricing` | Price precedence including zero, percentage/fixed bulk discount, caps/reset/subtotal boundaries, discounts, price books and cost validation |
| `currency` | Supported direct/inverse/cross pairs, IQD/decimal rounding, missing/invalid rate availability and immutable rate payloads |
| `inventory` | Batch allocation/costing/FEFO/fraction/duplicate-line regressions, Local stock effects and storage access |
| `financing` | Simple/standard POS loans in all four currencies, schedule sums, zero checkout receipt and repayment-related ledger rules |
| `returns-exchanges` | Partial/full refund audit entries, account net effects, replay/over-reversal/math validation, Local return transaction scope and post-commit reorder evaluation, return stock, exchanges and financing cancellation |
| `entry-routing` | Barcode parsing/timing regressions, payment/catalog/capability routing, finite/infinite Activities across immediate methods, Quick Order atomic contracts and rejection of related-unit products before checkout |
| `remote-contract` | RPC names/payloads, authoritative conversion-policy reads, success and loan aggregates, retry identities, offline rejection, friendly failures, confirmed-commit recovery, refund upserts, Sales sync guards |
| `failure-recovery` | Invalid/unavailable quantity/price/financing, payment/batch/loan failure rollback, duplicate submission, frozen attempt behavior, SQLite write-set commit/rollback and offline queue regressions |

Seeded cases vary methods, all four currencies, fractional quantities/prices and
physical/service lines. Seed and sample count control only those additional cases;
fixed regressions always run. Assertions use independent expected values and read
actual persisted rows and the production ledger projection. When a generated
failure reveals a defect, keep a small fixed regression after fixing it.

Hosted cases call regular POS `commitPosCheckout` and the Sales return RPC and
ledger persistence used by the product. They check actual sales, sale items,
inventory, stock batches, payment transactions, account movements, loans and
installments, and return audit/reversal rows. The account case needs the Payment
Accounts module enabled; financing needs Loans. The dedicated workspace must
have current POS migrations, including `complete_sale_with_loan`. This does not
automate the rendered POS payment or return dialog.

The hosted pricing regression sells a fractional quantity at a negotiated
fractional unit price and requires the stored sale, line, and payment to keep
the same exact amount. The hosted return regression requires partial and final
returns to restore the original stock batch ID, even when its optional batch
metadata is null, and to post linked cash reversal entries.

## Honest coverage limits

Passing checks prove the selected functions and contracts. They do not guarantee
no bugs or every possible scenario. Hosted checks verify only their selected
Supabase effects and the dedicated admin account's access; broader SQL/RLS and
other roles, real POS payment-dialog interaction and the complete Sales return
dialog, native Local SQLite persistence/restart, Hybrid mirror recovery and
scanner/camera/printer hardware remain outside the suite. The recording SQLite stub verifies the
production write-set and commit/rollback contract, not a real database file.
Existing Quick Order and return component tests do not automate their entire UI.

For expansion, add cases to the relevant independent group, call production entry
points and assert sale/stock/payment/account/loan/ledger effects and absent writes
on failure. Keep live rate fetching centralized at `src/lib/exchangeRate.ts`.
Add rendered browser or native/server adapters only with disposable environments
and explicit runner support; remove an unavailable label only after proving that
adapter works. Preserve shared runner and Sale Orders regressions when modifying
types, copy, reporting, dev gating or infrastructure.
