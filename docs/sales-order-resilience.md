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
