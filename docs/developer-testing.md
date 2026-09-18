# Developer module tests (V1)

For architecture, contracts, isolation, and extension instructions, read the
[agent extension guide](./developer-testing-agent-guide.md). Sale Orders is the
first independent V1 suite using shared infrastructure; its business scenarios
are a reference implementation, not a universal specification for other modules.

Start the development server with `npm run dev`, open its localhost URL, and go
to **Orders → Sale Orders → Developer tests**. The button and runner are enabled
automatically during development and excluded from production builds.

If another development server occupies port 1420, use
`npm run dev -- --port 1422`. The `npm run dev:testing` convenience command also
works and binds the server to localhost. For reviewing the modal without logging
into Atlas, open `/__atlas-dev-testing/preview` on the local development server.

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
npm run test:sale-orders -- --groups matrix,remote-contract --seed 42 --samples 100
```

The CLI exits nonzero for failed, skipped, empty, timed-out, or cancelled runs.
It does not silently retry a failed check. Successful runs mean the selected
checks passed; the report also records environment coverage gaps.

## V1 coverage

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
rounding, and Cloud/Hybrid client request/result/failure contracts.

**Not implemented in V1:** browser automation of the real order form, real
Supabase SQL/RLS integration, Hybrid desktop SQLite mirroring, and Local native
SQLite persistence/restart. The modal labels these as blocked adapters and the
report lists them under `unavailable`. IndexedDB reopen verifies cache survival
only; remote mocks verify client contracts only. Neither is presented as proof
of native persistence, server atomicity, permissions, or every possible scenario.

## Extending it to another existing module

1. Add a suite and allowlisted test groups to `src/dev/testing/suites.json`.
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
