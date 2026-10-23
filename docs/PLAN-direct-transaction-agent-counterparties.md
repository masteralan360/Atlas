# Agents as counterparties in New Direct Transaction

Prepared: 23 October 2026. Status: implemented in the working tree; the additive database migration is prepared and has not been applied to a hosted workspace.

## Intended result

A user creating a direct transaction can select an existing Agent as the payer or recipient, record incoming or outgoing money, choose its effect on the Agent's partner account, and see the correct identity throughout transaction history, the ledger, statements, reversals, and vouchers.

The financial identity remains the Agent's existing business partner. This extends Direct Transactions and Agents under their existing access rules.

## Findings before implementation

| Area | Current behavior | Implication |
| --- | --- | --- |
| `src/local-db/models.ts` | `Agent.businessPartnerId` links to a `BusinessPartner` with role `agent`; the partner carries `agentFacetId`. Four operational modes exist: driver, field agent, courier, and seller. Custom Agent types refer to these modes. | Use the partner ID for accounting and the Agent facet for eligibility and presentation. Agent and partner IDs must not be interchanged. |
| `src/ui/components/payments/DirectTransactionDialog.tsx` | Uses `PartnerAutocompleteInput` without `includeAgentRoles`; its browse action opens `LoanPartyPickerDialog` only when CRM is enabled. | Both entry points exclude Agents. Agents access must be evaluated independently of CRM. |
| `src/ui/components/loans/LoanPartyPickerDialog.tsx` | Uses the default partner filter, loads a collection, and searches it in memory. | The direct-transaction picker needs a bounded source query rather than copying this collection-loading behavior. |
| `src/local-db/payments.ts` | `recordDirectTransaction` accepts a partner ID, resolves its name, stores the ID in `sourceSubrecordId` and `metadata.businessPartnerId`, and accepts an explicit `partnerAccountEffect`. It has no Agent-specific eligibility validation. | The underlying posting format already supports Agent accounts; validation and UI integration are the main gaps. |
| `src/lib/partnerAccountStatement.ts`, `src/hooks/usePartnerAccountStatement.ts`, `supabase/functions/partner-account-statement-period/index.ts` | Direct account movements already participate in statement calculations. | Extend coverage and fix discrepancies discovered by tests instead of introducing another balance calculation. |
| `src/dev/testing/suites/agentAccountPaymentNettingLive.test.ts` | Contains an Agent-linked direct receipt that decreases the Agent's receivable. | There is an existing service-level example to preserve and expand. This plan does not claim that the test was run. |
| `src/ui/pages/DirectTransactions.tsx` | Labels every linked counterparty as Business Partner. Reads all payment transactions before filtering the direct list; derives reversal state from that collection. Its availability check omits Agents. | Add Agent presentation and support an Agents-enabled workspace without an incidental CRM dependency. Source paging must preserve complete reversal calculations. |
| `src/ui/components/payments/DirectTransactionVoucherPrintTemplate.tsx` | Uses stored counterparty names and generic linked-partner labels. | Preserve historical names and add Agent-aware labels. |
| `src/ui/components/crm/BusinessPartnerAutocomplete.tsx` | The path named in AGENTS.md is absent in this checkout; the shared implementation is `PartnerAutocompleteInput.tsx`. | Extend the existing shared partner autocomplete rather than creating a second implementation under the missing filename. |

The working tree already contains edits to statement hooks, statement rendering, the statement Edge Function, and locale files. Implementation must integrate with those edits and preserve them.

## Recommended behavior and scope

The implementation uses these product defaults:

- Support all four Agent modes and custom Agent types. A workspace user link, sales account, or commission plan is not required for a direct transaction.
- Allow active, accessible Agents for new postings. Inactive, blocked, deleted, merged, or inaccessible Agents cannot be newly selected. A selection that becomes unavailable remains visible with an explanation and blocks saving until replaced or explicitly unlinked.
- Keep ordinary business partners and external free-text counterparties available. Selecting an Agent is an explicit link; typing an Agent's name alone remains an external name and does not affect that Agent's account.
- Offer the same explicit cash-only versus partner-account treatment for Agents as for other linked partners. Do not preselect a financial treatment merely because an Agent has been selected.
- Treat these as general direct cash movements. Commission payouts/recoveries, courier remittances, payroll, and tracked obligation settlement retain their existing workflows. An Agent-linked direct payment does not mark a commission or shipment as settled.
- Preserve historical payments and authorized reversals when an Agent later changes status or loses a module entitlement. New-posting eligibility must not prevent reversing an existing payment.

### Account effects

| Direction | User's choice | Financial effect |
| --- | --- | --- |
| Incoming or outgoing | Cash record only | Record the payment and ledger movement; leave partner balances and account-statement totals unchanged. Linked activity can still identify the Agent. |
| Outgoing | Increase receivable | The Agent owes the workspace more. |
| Outgoing | Decrease payable | The workspace owes the Agent less. |
| Incoming | Decrease receivable | The Agent owes the workspace less. |
| Incoming | Increase payable | The workspace owes the Agent more. |

Amounts remain in the selected transaction currency. Existing currency and summary-conversion rules remain authoritative. Any live conversion uses `src/lib/exchangeRate.ts`.

## 1. Define one counterparty contract and access policy

Create a small data-layer contract for an external counterparty, a business partner, or an Agent-backed partner. Reuse `RecordDirectTransactionInput` between the page and dialog instead of maintaining separate inline payload types; the page's current inline type also omits `partnerAccountEffect`.

For an Agent selection, retain both `businessPartnerId` and `agentId`, plus its display name, operational mode, optional custom type, and availability state. Resolve these from records rather than accepting arbitrary client snapshots as authority.

Access policy:

1. Direct Transactions requires its existing `direct_transactions` entitlement and `directTransaction.access` permission, evaluated with the shared permission resolver and its existing admin behavior.
2. Agent selection additionally requires the existing `agents` entitlement and `agents.access` permission. Loading permission state does not temporarily grant access.
3. Ordinary partner selection keeps its existing CRM and partner-visibility requirements. Agent selection works when Agents is available even if CRM is disabled.
4. Apply workspace isolation and business-partner group visibility to searches, selections, save validation, and profile navigation. A guessed ID or a stale cached row cannot bypass these checks.
5. Honor the current transaction authorization model for creation, reversal, and historical financial reads. Showing a saved financial snapshot does not grant access to an Agent profile or protected partner record.

Update the page's availability check and empty-state copy to include the Agents-supported case. Reuse existing plan/admin grants; this extension does not introduce another module or require new plan membership.

Deliverable: shared types, an explicit eligibility helper, and tests for the access matrix.

## 2. Build bounded counterparty search and browsing

Reusable fetchers and selected-record resolution live in `src/local-db/directTransactionCounterparties.ts`; React hooks, access resolution, and shared RPC/freshness handling live in `directTransactionHooks.ts`, `directTransactionAccess.ts`, and `directTransactionReads.ts`. They reuse the existing partner visibility and normalization rules.

- Expose one query contract with workspace, counterparty scope, search, page, page size, stable ordering, and viewer/permission/group scope. The Agent scope applies the active-status rule before counting or paging.
- Use a dedicated, permission-checked RPC such as `crm.list_direct_transaction_counterparties_page`, reusing canonical partner and Agent tables and existing access helpers. Return a filtered page, its exact total, and the Agent metadata needed for those rows. Keep unrelated shared-directory callers' semantics unchanged.
- Search partner name and phone, and Agent zone, operational type, and custom type name. Use the same predicates for page and count, with a unique ID tie-breaker after name ordering.
- Reuse the shared `PartnerAutocompleteInput` with an optional scoped search context/data-source contract. Its normal callers keep their current behavior. Both autocomplete and the browse dialog use the same eligibility rules; neither depends on preloading all Agents or building a workspace-wide eligible-ID array.
- Resolve and cache a selected partner and its Agent facet by ID, even when neither is on the current page. Preserve pending/conflicting local rows when remote results arrive.
- Cloud/Hybrid use cancellable remote queries and the established offline cache fallback. Local uses indexed Dexie reads over its SQLite-backed mirror, with equivalent filters and ordering. Add only the indexes needed for these reads.
- Online pages and counts come from the authoritative remote source. Pending/conflicting cached records are protected from replacement; offline selection uses the indexed local cache. Locally pending candidates become available in online results after synchronization. This avoids mixing an incomplete local candidate set into a remote page/count.
- Add scoped keys under `queryKeys` and use the app's existing QueryClient. Include every request and visibility input; keep Query cache in memory.

Use `usePaginationState`, `usePaginationBounds`, and header `AppPagination` in the browse dialog. Reset page in the same render when scope, search, sort, or page size changes. Preserve page/count during loading or failure; show a centered localized loader in place of old rows.

Deliverable: tested autocomplete, paged browsing, targeted selection lookup, and mode-equivalent source behavior.

## 3. Update the transaction dialog

Replace this flow's dependency on the loan-specific picker with `DirectTransactionCounterpartyPickerDialog` under the payments components. Use Business Partners and Agents scopes where authorized. Reuse the shared partner autocomplete for typed selection.

The browse dialog uses `AppDialog`, fixed header/footer, and `AppDialogBody`; it returns a selection to the parent and has no competing Save Transaction action. Returning from browsing preserves the parent's amount, reason, date, method, currency, and account input. Keep the loan picker's labels and behavior specific to loans.

After selecting an Agent:

- Show its name, Agent icon, localized type/custom type, and `Linked` badge.
- Provide an explicit Unlink action. Unlink clears the counterparty text, partner ID, Agent ID, snapshots, account treatment, and account effect together. Changing the text explicitly removes the old link before searching again.
- Require the user to choose cash-only or an account movement. For account movement, require a valid effect for the current direction. Changing direction clears an incompatible effect.
- Keep the current selection during search loading, page changes, empty results, and option refreshes. A lookup failure is an error/retry state, not evidence that the selected Agent was deleted.
- Revalidate a selected Agent before saving. Preserve a genuinely unavailable selection visibly, with a localized reason; do not silently convert it to external free text.

Continue using `PaymentAccountSelector` as an optional field and pass its ID/name snapshot through the payment. Keep `CurrencySelector`, `PaymentMethodSelector`, and `DateTimePicker`. Mark all required choices with `*`, format numbers with separators, and leave an erased amount empty with a `0` placeholder.

Guard submission synchronously as well as through React loading state. Disable/grayout Save immediately, show a localized loading label, and block overlay, X, Escape, and cancel closure during processing. Save failures retain the complete form.

Deliverable: complete creation flow verified against `BusinessPartnerFormDialog.tsx` at desktop and narrow mobile widths.

## 4. Validate and persist through the existing payment path

Update `recordDirectTransaction` to resolve the selected canonical partner and Agent facet, confirm their workspace/link relationship, enforce access and current eligibility, validate account treatment/direction, and build metadata before calling `appendPaymentTransaction`.

Persistence contract:

| Stored field | Meaning |
| --- | --- |
| `sourceModule: payments`, `sourceType: direct_transaction` | Existing direct-transaction classification. |
| `sourceRecordId` | Stable identity for this direct transaction and its reversal family. |
| `sourceSubrecordId` | Canonical business-partner ID when linked. |
| `counterpartyName` | Name snapshot resolved at posting time. |
| `metadata.businessPartnerId` | Existing partner accounting association. |
| `metadata.partnerAccountEffect` | Existing explicit financial effect, or `none`. |
| `metadata.counterpartyKind` | Additive presentation snapshot: `agent`, `business_partner`, or `external`. |
| `metadata.agentId` | Agent facet ID for an Agent-backed transaction; otherwise absent/null. |
| Optional Agent type/name snapshots | Historical Agent mode/custom type presentation, derived at save time. |

Keep these additions in JSON metadata; they do not require another payment table or a new accounting identity. Define typed readers/writers so missing metadata on legacy rows is safe.

Use a stable transaction ID for a submission attempt and retries through the existing append idempotency support. Validate that an existing ID belongs to the same workspace and operation before treating a retry as success; a changed financial payload must not silently reuse a previous payment. A duplicate request must not create a second payment-account movement or voucher.

Add server validation at the actual `public.payment_transactions` write boundary so direct REST writes and offline replay obey the same rules. Resolve the partner's actual role server-side rather than trusting `counterpartyKind` or supplied Agent IDs. Validate a matching Agent facet, workspace, module/permission, group access, direction/effect, and canonical IDs. Failures must occur before financial posting can become partially visible.

Scope the validation to new direct postings and their changed financial identity. Preserve unrelated module payment writes, exact idempotent retries, and authorized reversals of historical payments. For reversals, verify the original and inherit its counterparty/effect; do not require that Agent to remain active.

Keep ledger and payment-account effects derived from `payment_transactions`. Use the existing Local SQLite persistence, Cloud offline queue, Hybrid mirror, and sync error handling. A rejected queued payment must remain visibly failed/conflicted under the existing recovery path, with a localized explanation; do not report it as cloud-confirmed.

After persistence/offline enqueue succeeds, refresh affected transaction queries and partner summary/statement readers through the existing mutation and invalidation paths. A summary refresh failure after a saved payment must not encourage reposting the payment.

Deliverable: matching local/server validation, retry safety, and standard payment/ledger/account behavior across all modes.

## 5. Carry Agent identity through history and reporting

Update `DirectTransactions.tsx` to display Agent identity and its linked badge/type, and navigate to `/agents/<businessPartnerId>` only when profile access is permitted. The Agent detail route resolves a partner ID despite its parameter name. Ordinary partners and external names keep their respective presentation.

While changing this list, replace the full-payment-collection dependency with a source-paged direct-transactions hook in `src/local-db`. Use manual TanStack Table pagination/filtering/sorting, the shared pagination hooks, header `AppPagination`, `DateRangeFilters`, and the scoped QueryClient.

- Apply direct source, search, date, direction, and any added counterparty criteria at the source; return an exact matching count.
- Order by `paidAt DESC, createdAt DESC, id DESC`; add matching source indexes where needed, including local schema upgrades if required.
- Return reversal aggregates and eligibility for the current page's original transactions from the complete authorized reversal family. A reversal outside the page/date filter still affects the original's remaining amount. Never calculate it from only visible rows.
- Load legacy partner/Agent label enrichment only for current page IDs and required original transactions. Prefer immutable snapshots for new rows. If a legacy identity cannot be resolved, retain its saved name and generic linked-partner label.
- Invalidate active pages and counts after create/reverse/void and after relevant changes initiated elsewhere; preserve bounds while loading and clamp after a successful response.
- Scope freshness to `payment_transactions` and the partner/Agent/type lookups actually used. Report fetch start, progress, completion, cancellation, and failure through `workspaceDataFreshness`.

For statements and summaries, reuse `metadata.businessPartnerId` and `partnerAccountEffect` in the existing browser and server paths. Verify every Agent mode, with and without a sales account or commission plan. Cash-only rows have no statement balance effect. Sales-account credits continue participating in the existing netting rules exactly once.

For reversals, preserve the original name and Agent metadata on each linked counter-entry. Test partial and complete reversal in the ledger, partner statement, transaction list, and payment-account movement history. The existing signed-amount convention remains authoritative.

Extend `DirectTransactionVoucherPrintTemplate` with Agent-aware labels and saved identity. Continue the existing `PrintSelectionModal` -> `PrintPreviewEditorPage` -> final edited PDF callback flow, custom A4 pagination, and voucher save/version persistence. Renaming/deleting an Agent must not rewrite saved voucher identity.

Deliverable: consistent financial totals, history, profile links, and PDFs with bounded page reads.

## 6. Database, compatibility, and release order

All SQL and any needed Edge Function changes belong in Atlas under `supabase/`. The business payment table is `public.payment_transactions`; `billing.payment_transactions` is the separate workspace-billing domain.

1. Create additive migrations for bounded read APIs, direct-counterparty validation, and justified indexes. Generate migration files using the installed Supabase CLI's supported migration workflow.
2. Keep new metadata optional on reads. Existing external and partner-linked transactions remain valid without Agent snapshots. Existing service-level Agent payments can be recognized through their linked partner when accessible; no name-based historical reassignment or destructive backfill is needed.
3. Preserve old shared directory signatures/callers. Harden new RPCs and private validation helpers with explicit grants and workspace/permission checks. Follow the current [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security); review existing SECURITY DEFINER helpers explicitly rather than assuming they apply table policies.
4. Test migrations and the statement Edge Function against disposable data before rollout. Deploy additive backend support before the updated client; verify an older client can still post valid ordinary direct transactions and that legacy Agent posting behavior remains compatible with the new validation.
5. Ship frontend and any local index upgrade together. Test Local database reopening and Hybrid recovery with existing records.
6. For rollback, disable the new Agent selection path or revert the client while retaining payment rows, optional metadata, and additive read support. Financial history must survive rollback.

Deliverable: backward-compatible release and rollback instructions, with the migration verified locally and applied to the target workspace before releasing the updated client.

## 7. Localization and verification

Reuse existing Agent, type, Linked, Unlink, unavailable, and account-treatment terms in `en.json`, `ku.json`, and `ar.json`. Search Kurdish/Arabic terminology before adding keys. Add localized scope labels, unavailable reasons, empty/error states, validation messages, and friendly save/sync errors. Keep RTL and long custom-type names readable.

| Verification area | Required coverage |
| --- | --- |
| Selection | Autocomplete and browse; all four modes; custom types; duplicate names with distinct IDs; partner ID different from Agent ID; Agents enabled with CRM disabled. |
| Access | Agents grant enabled/disabled; Direct Transactions permission; Agents permission; admin/staff/viewer according to existing policy; protected groups; forged/cross-workspace IDs; permission changes during an open dialog. |
| Async behavior | Initial loading; refresh; empty page; search failure; selected Agent outside the current page; selection becomes unavailable; explicit unlink; external name; form reset on reopening; rapid workspace changes. |
| Payments | Incoming/outgoing; all four valid account effects; cash-only; incompatible effect rejection; blank/zero/invalid amount; account selected/unselected; account unavailable; multiple currencies; immediate double-click/Enter; retry after uncertain response. |
| Lifecycle | Agent renamed, inactive, blocked, deleted, merged, or custom type renamed after selection/posting; historical names preserved; reversals still supported under the existing authorization rules. |
| Persistence | Cloud online; offline enqueue/replay; server rejection surfaced; Hybrid mirror/recovery; Local SQLite restart; no Local business sync; pending/conflict cache protection. |
| Financial consistency | Exactly one payment, expected ledger effect, and optional derived account movement; cash-only leaves partner totals unchanged; browser/server statements agree; account credit netting and commissions are not double-counted. |
| Reversals | 100 outgoing increased receivable, then reverse 30: original and counter-entry remain visible, cash/account delta is 70 outgoing and receivable increase is 70. Reverse remaining 70: linked effects net to zero. Include incoming, payable, fractional amounts, and reversals outside the active page/date filter. |
| Scale and refresh | Large Agent directory; filters applied before paging; accurate count; stable sort; no full workspace fetch to build selector options; cancellation; no stale page rows; active page/count refreshes after external mutations. |
| Presentation | 360px/390px mobile and desktop; English/Kurdish/Arabic; keyboard focus; screen-reader labels; long names; disabled/loading state; overlay/X/Escape blocked while saving. |
| Printing | Agent receipt/payment/reversal vouchers; missing legacy metadata; edited PDF output; Print & Save/version behavior; multi-page reversal tables. |

Extend the existing Agent account-netting tests, `directTransactionVoucher*.test.*`, `partnerAccountStatementAgentPaymentNetting.test.ts`, ledger/payment-account tests, and voucher-save tests. Add focused tests for the counterparty data helper, dialog, and SQL allow/deny rules. Use a hosted/disposable workspace for end-to-end server authorization and sync validation.

Run focused Vitest suites, `npm run type-check`, `npm run lint`, and `npm run lint:dialogs`; separate pre-existing working-tree failures from regressions introduced by this feature. Record the verification environment and any remaining release checks below.

## Completion criteria

- [x] An authorized user can find and link eligible Agent modes/custom types through either counterparty entry point.
- [x] Agent selection works without CRM, sales-account, or commission-plan prerequisites.
- [x] Saving validates current access/eligibility and uses the canonical partner identity through `payment_transactions`.
- [x] Cash-only and supported account effects use the existing payment, ledger, statement, and optional account-movement paths, with duplicate/retry protection.
- [x] Partial/full reversals retain counter-entries and exact remaining amounts, including after Agent lifecycle changes.
- [x] Local persistence and Cloud/Hybrid offline enqueue preserve existing authority rules; hosted replay/recovery remains a release check.
- [x] History and vouchers retain the Agent identity snapshot and remain compatible with older rows.
- [x] Selector and transaction lists use scoped source paging, correct counts, localized loading, and immediate mutation refresh.
- [x] Desktop, 360px Arabic RTL, unavailable-selection, embedded-Postgres authorization, and targeted financial checks have been exercised.
- [ ] Apply the migration and verify hosted authorization, offline replay, and Hybrid recovery in a disposable workspace before production rollout.

Suggested delivery sequence: contract/access tests -> bounded read APIs and indexes -> validated posting -> dialog integration -> history/statements/vouchers -> mode and release verification. Each step should preserve the existing direct-transaction flow before the next is integrated.

## Implementation verification and release notes

- Final automated checks: 13 targeted Vitest files, 64 tests passed; `npm run type-check` passed; targeted ESLint completed with no errors and three existing hook-dependency warnings. `git diff --check` passed.
- Migration: `supabase/migrations/20261023150110_direct_transaction_agent_counterparties.sql`. It adds scoped page APIs, indexes, and validation at the actual payment write boundary. Deploy it before the updated client. No hosted schema or production data was changed during implementation.
- The SQL regression suite executes the migration in PGlite, including authenticated invoker calls, access/group/workspace isolation, canonical Agent snapshots, immutable posting, idempotent retries, historical visibility, and partial/full reversals. Docker was unavailable, so a local Supabase stack and hosted synchronization were not exercised.
- Browser verification used a disposable fixture with real dialog, picker, autocomplete, and local payment persistence. It covered Agents without CRM, keyboard selection, required treatment, immediate submission locking, canonical saved identities, stale Agent retention, explicit unlink, desktop layout, and 360px Arabic RTL. Temporary fixture files and the development server were removed afterward.
- Existing voucher rendering/save suites cover identity and PDF persistence integration. An actual printer and a hosted edited-PDF export were not exercised.
- Full-repository lint remains blocked by existing `no-control-regex` errors in `src/lib/integrityAudit/auditModelExport.ts` and `src/services/invoicePdfExport.ts`. The dialog audit reports existing generic dialogs in `EcommerceDetailView.tsx`, `ManualRateEditorModal.tsx`, `SalesHistoryAtlasStandardInvoiceTemplate.tsx`, and `InventoryTransfer.tsx`; the new picker uses the structured facade.

For rollback, revert the client selection path while retaining the additive SQL APIs, payment rows, and saved metadata. Do not delete or rewrite posted transactions.
