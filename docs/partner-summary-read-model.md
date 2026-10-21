# Partner summary read model

Cloud and Hybrid partner summaries are calculated from Supabase source records.
Dexie holds the last confirmed read model for offline display; its partial order,
loan or payment cache must never be used to publish workspace totals.

`crm.read_business_partner_summaries(workspace_id, partner_ids)` reads sales and
purchase orders, linked loans, installment sales, delivery ledgers and explicit
direct-account adjustments. Financed orders are counted as activity, but their
debt comes from the linked loan once. Drafts count as activity without creating
an unpaid obligation. Cancelled/deleted obligations are excluded. Direct-payment
reversal rows reverse their original signed account effect.

The reader returns both the existing default-currency summary fields and native
currency balances. Conversion uses recorded snapshots and the existing legacy
fallback rules, never a device's cached live rate. Loan amounts without a valid
conversion snapshot remain visible in native-currency balances. Default-currency
loan conversion requires a recorded conversion path.

The directory RPC calculates its summary from the eligible partner scope and
returns an exact search count with a stable name/id page. Detail views, shared
balance displays and statement metadata use the same source reader. Compatibility
`list_visible_business_partners` reads also calculate their fields on the server.
The legacy stored columns remain for compatibility and are not authoritative.

New saves do not enqueue aggregate reconstruction jobs or upload partner/customer/
supplier totals. Normal and previously queued identity mutations strip derived
fields. Old summary intents are discarded independently of the business mutation
queue on startup/reconnect/wake; no polling or payment replay is involved.

Active TanStack Query readers refresh after committed source changes and after
offline synchronization. Aborted local transactions do not trigger a refresh.
Workspace, user, role and partner-group visibility scope the query keys. Summary
cache updates preserve pending/conflicting identity changes, their version and
their offline queue entry. A confirmed summary retains its reporting currency
even if an unsent partner edit changes the default currency.

Local mode retains the existing SQLite/Dexie calculation path and sends no
summary queries or writes to Supabase.

## Database access boundary

Authenticated clients cannot select the raw partner table. The summary reader
therefore preserves the existing guarded `SECURITY DEFINER` RPC boundary, with a
fixed empty search path, qualified objects, explicit authentication/current-
workspace checks and the existing group-visibility policy. It exposes aggregates
already available in the partner directory, without granting source-table access.
PUBLIC/anonymous execution is revoked. Administrator or privacy-disabled access
is resolved once per request; restricted readers still use the group policy.
Supabase's advisory for authenticated definer functions is intentional for this
boundary; regression tests exercise denied workspace, anonymous and group access.

## Verification

`scripts/authoritative-partner-summaries.test.mjs` runs the migrations in PGlite
with the actual privacy helper and currency conversion function. It checks source
balances, financed debt, purchases, reversals, currencies, pagination, group
visibility and immediate reads after a source payment changes.

Client regressions cover commit/rollback invalidation, Local mode, pending edits,
cancelled/invalid responses, retired-job cleanup, old offline payloads and order
saves that do not depend on aggregate RPCs or job storage.

Hosted `EXPLAIN ANALYZE` on a workspace with 1,211 partners and 1,154 active sales
orders measured approximately 21 ms for one partner and 348 ms for a 20-row
directory page with workspace summary metadata. These are database execution
times, excluding network/UI time, not end-to-end order-save benchmarks.

The broader financing suite contains an existing failure for “records an unmapped
sales-order loan refund as a positive outgoing cash transaction”: the production
guard rejects a refund after its original payment transaction has been deleted.
The same failure was reproduced with the pre-change staged order implementation.
This migration does not change that refund behavior.
