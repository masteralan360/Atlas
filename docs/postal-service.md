# Post Service

This is an independent module using the `postal_service` platform grant, `postService.merchant` / `postService.officeEmployee` permissions, `/post-service` routes and new `postal_*` tables. It has no dependency on retired Post Service data, permissions, identities or code.

## Deployment

1. Migration `supabase/migrations/20261024003737_postal_service.sql` was deployed to ERP (`eboispangcayxxheoufy`) on 2026-10-24. For other environments, review and apply it through the normal migration deployment process. Review `supabase db push --dry-run` before pushing; do not blindly apply other pending migrations.
2. Migration `supabase/migrations/20261024004656_postal_registration_permission_keys.sql` was also deployed to ERP on 2026-10-24. For other environments, apply it after the base migration. It allows exactly the new merchant and office permission keys through the shared namespace constraint; all other keys in that namespace remain blocked.
3. Migration `supabase/migrations/20261024094518_postal_dashboard_summary.sql` was deployed to ERP on 2026-10-24. For other environments, apply it after the base migration to expose the authenticated summary RPC used by the shipment cards.
4. The updated `workspace-account-creation` Edge Function is deployed to ERP with JWT verification enabled. For other environments, deploy it with `supabase functions deploy workspace-account-creation`. Existing Atlas registration keys must be configured.
5. Deploy Atlas and the Admin frontend changes together. Grant **Post Service** in the Admin console for the intended workspace. No plan includes it automatically.
6. Administrators create merchant accounts from **Workspace Account Creation** in Post Service. Merchant enrollment is automatic in this entry point: there is no Merchant checkbox. Administrators must explicitly choose **Join Organization** or **Create an Organization** and provide a valid same-workspace organization code or a new organization name before submitting. Grant **Office Employee** to existing Staff accounts through Members. Merchant membership is managed through Post Service organization management, rather than a generic permission switch.

All three migrations are deployed and their local filenames match the hosted versions. Hosted tables, RLS, RPC permissions, Auth triggers, Realtime publication and location seeds have been verified. Only these migrations were applied through the Supabase migration API because unrelated migration-history differences prevent a blanket CLI push; no existing history records were repaired or changed. The hosted Edge Function source matches the updated registration flow. Merchant creation and joining an organization passed hosted database checks in a rolled-back transaction, including profile, membership, permission, permit consumption, metadata cleanup and deferred constraints. No verification accounts or organizations remain. The summary RPC was verified against available hosted actors and direct source counts, including status filtering; anonymous execution is denied. Frontend deployment and the authenticated HTTP request were not verified here.

## Shipment summary cards

The Shipments tab shows four cards for every Post Service role. Admins and Office Employees see matching shipments across the current workspace; merchants see their organization's matching shipments. Search, status and the shared date range use the same predicates as the list, with an inclusive creation-time start and exclusive end. Totals cover every matching row, independently of the selected table page.

- Active Shipments includes drafts and every shipment that is neither delivered nor cancelled.
- Delivered Orders counts delivered shipments.
- In-Transit Orders counts the `in_transit` state, for movement between offices or branches.
- COD Balance sums each delivered shipment's signed COD less its recorded recipient collections. Merchant settlements do not reduce this recipient balance. All collections for the matching shipments are included, even when the payment was recorded after the shipment creation-date range. Integer IQD totals are returned as text and formatted with BigInt to preserve exact values.

The cards clear old figures while new filters load and show retryable failures instead of zero totals. Their cache keys include workspace, viewer, role, permission scope and all filters. Existing mutation and Realtime invalidations refresh the summary namespace. Freshness tracks both `postal_shipments` and `postal_cod_records` with operation-specific start, progress, completion, cancellation and failure events.

## Data and security

- Cloud and Hybrid workspaces use real Supabase transactions. Operations require connectivity; Local and Demo workspaces do not expose this module. Server-authoritative rows are cached in scoped Dexie records, mirrored to SQLite by the existing Hybrid infrastructure. Operational and financial changes are deliberately not queued for offline replay.
- Row Level Security isolates workspaces and merchant organizations, including postal entries in the shared payment table. Direct client writes to module tables are revoked. Public RPC wrappers run as invokers; private transaction functions validate the current actor, grant, scope, revision and transition.
- Merchant registration uses a five-minute, service-only permit bound to a random Auth user UUID and email. An Auth insert trigger consumes it before Atlas's existing registration-key guard. Another trigger creates the organization, membership, leader link and merchant permission within the Auth transaction. This accounts for GoTrue applying `app_metadata` after the user insert. Normal Office Employee registration is unchanged.
- Organizations have a unique code and a deferred leader-membership foreign key. Merchant membership is unique per user. Moving a leader requires a replacement in the same atomic operation. Leadership grants no additional access.
- Shipment QR identities are opaque, immutable and unique. Reads enforce authorization; copying a shipment copies editable fields and receives a new identity. Draft deletion is an audited tombstone. Accepted shipments allow controlled corrections and cancellation, with no financial amount edits.
- Supabase Realtime invalidates active pages after authorized changes from other devices. Membership changes reset the former organization view immediately.
- Requests are idempotent per actor and workspace. Replays recheck current permissions and organization access. Shipment revisions and row locks prevent concurrent scans from duplicating transitions.
- Transfers are administrator-authorized, optional and repeatable. Arrival must match the current authorized destination. Delivery-driver assignments reuse existing CRM driver agents when the operator has Agents access.
- Physical events and financial events remain separate. Recipient payments and merchant settlements are signed integer IQD records linked to real `payment_transactions`; the existing ledger and account movement pipeline receive those transactions. Negative COD cannot be recorded as a positive incoming collection. Cash direction is explicitly confirmed, and no fees or additional financial rules are inferred.
- Financial totals are aggregated by the database independently of paged history. Main lists, events, membership options and payment history are fetched in bounded pages.

## UI and printing

### Organization account statement

`/post-service/account-statement` is the **Account Statement** tab. It inherits the
existing `postal_service` workspace grant and Cloud/Hybrid restriction. Access is
limited to administrators and Staff with `postService.officeEmployee` (the existing
Office Employee permission). The route, tab, client data functions, and both new
invoker RPCs enforce this scope; merchants cannot call the statement or its
organization-search endpoint, even for their own organization. The existing RLS
policies remain in force on all source tables.

Migration `20261028021022_postal_organization_account_statement.sql` was applied to
ERP (`eboispangcayxxheoufy`) on 2026-10-28. Its local filename matches the hosted
migration history. For other environments, apply it after the shipment
tariff/delivery-fee migration. Hosted verification exercised authenticated
organization search and statement reads against an existing organization,
reconciled counts and balances to source records, and checked cross-workspace and
unauthorized-user denial. Both RPCs remain invokers with anonymous execution
revoked; the security advisor reported no findings for either new function.
Verification changed no business records. Local PostgreSQL/PGlite and browser
regression coverage remains in place.

The organization selector uses the shared debounced autocomplete and popover,
searches real organization names/codes, requires three characters, and returns at
most eight options. Changing text or unlinking explicitly clears the selection;
loading, refreshing, unavailable records, and connection failures preserve the
selected organization until the user changes it.

The statement is a COD funds control account from the postal operator's perspective:

- A signed recipient COD collection changes the organization's balance by that
  amount. Positive collections credit the organization's payable; negative COD
  payouts debit it.
- A signed organization settlement changes the balance by its negative. Positive
  payouts debit the payable; negative settlements received from the organization
  credit it. Partial payments remain individual entries linked to the original
  `payment_transactions` records.
- `balance = sum(COD collections) - sum(organization settlements)`. A positive
  balance is due to the organization; a negative balance is due from it.
- Recipient delivery-fee collections are shown as separate cash movements with
  zero organization-account debit/credit. No tariff is deducted from organization
  funds or asserted to be organization debt. The current workflow collects these
  fees from recipients independently of COD.

Dates filter the immutable financial record's `created_at`, with an inclusive
start and exclusive end. The opening balance includes all earlier COD movements;
period debits/credits reconcile to the closing balance. Oldest-first running
balances are calculated in PostgreSQL before search/type filters or pagination,
ordered by time, UUID, and record kind. Summaries always describe the whole period;
search/type only narrow the visible rows and filtered count. Even empty or
out-of-range pages retain the correct totals. All monetary aggregates are numeric
SQL results serialized as integer text and formatted using `BigInt` in the UI.

A separate current summary covers all recorded dates. Amounts due to/from the
organization are split per shipment before netting, so opposing balances remain
visible. Remaining recipient COD and refunds include delivered, undeleted
shipments only; they are operational amounts, not funds already held for the
organization. Historical statement entries are never removed merely because a
shipment's current state changes. The statement does not infer historical opening
balances, unrecorded payments, organization fee agreements, or missing tariffs.
Shipment status/contact details are current values, not historical snapshots.

The shared Query client scopes reads by workspace, viewer, role, permission,
organization, dates, filters, and page. Existing postal command and Realtime
invalidation refresh the statement after changes. Only canonical organization
search results enter the existing Dexie cache; derived balances remain in memory.
Freshness tracks the organization, shipment, COD, delivery-fee, and payment tables
through start/progress/completion/cancellation/failure events. Loading or failed
requests hide stale statement amounts.

Verification:

```powershell
npx vitest run src/postal src/local-db/postalStatementData.test.ts src/local-db/postalSummary.test.ts
npm run type-check
# With Vite listening on port 5188:
node scripts/postal-browser/statement-check.mjs
```

The isolated browser fixture runs real statement RPC SQL in PostgreSQL/PGlite,
including autocomplete selection, keyboard interaction, loading/failure/retry,
unlinking, desktop/mobile layout, and Arabic/Kurdish RTL. It does not use hosted
credentials or write verification records to the production database.

Merchant screens prioritize creation, QR scanning, shipment details and printing. Administrator tabs provide branch, organization and settlement management. All UI copy is localized in English, Arabic and Kurdish. Amount inputs preserve an invalid empty state and use thousands separators.

Print goes through `PrintSelectionModal` directly into `PrintPreviewEditorPage`. The module has a dedicated 100 × 150 mm label with a four-module QR quiet zone. The preview generates the final PDF from current edits before invoking the print callback; repeated printing preserves identity. Camera capture uses the shared scanner's opt-in QR single-scan mode; other barcode consumers retain their current behavior.

Governorates are maintained in `src/data/iraqPostalLocations.json`, with matching database reference rows. Sources: [IOM Iraq COD](https://iraqdtm.iom.int/AlternativeCODs) and [Iraqi Ministry of Justice, Halabja decree](https://www.moj.gov.iq/view.9251/). The nineteen governorates include Halabja. Areas are a curated directory of prominent delivery destinations, not an exhaustive boundary dataset; update both JSON and SQL when expanding it.

## Verification

```powershell
npx vitest run src/postal src/local-db/postalSummary.test.ts src/accounts/workspaceAccountCreation.test.ts src/accounts/workspaceAccountCreationServerContract.test.ts src/lib/ledgerCashMovementEntries.test.ts src/lib/ledgerPaymentTransactions.test.ts
npm run type-check
```

The PostgreSQL tests execute the real migration in PGlite, with the existing Atlas registration-key guard. They cover Auth rollback, joining, leadership, membership moves, access revocation, cross-workspace and organization denial, permanent QR identities, copy semantics, idempotency, revisions, repeat transfers, optional direct delivery, driver assignment, signed partial payments, settlement separation and immutable history.

For browser verification, start Vite on port 5188 and run `node scripts/postal-browser/check.mjs`. The isolated fixture intercepts its HTTP requests and executes the real transaction functions in PGlite. It verifies form-to-database creation, QR-to-copy-to-database behavior, empty and negative IQD, mobile sizing, desktop timeline dragging, repeated events, both contact choices, QR decoding and final PDF dimensions. Screenshots and the sample PDF are saved under `artifacts/postal/`. Windows uses installed Edge; `PLAYWRIGHT_CHANNEL` can select another installed browser.

Hosted Auth, physical camera capture and physical label-printer output still need verification after deployment. Repository-wide dialog lint currently reports pre-existing violations outside this module.
