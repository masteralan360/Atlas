# Instant POS table carts becoming zero — investigation

Investigated on 24 October 2026. Reported configuration: Release **0.16.9**, Restaurant live sync **off**, and reopening affected tables shows **empty carts**. Release source examined: `2ed18604` (23 October 2026). Production access was read-only. No customer records or application behavior were changed.

**Finding:** a reproduced data-loss defect converts a failed service-permission lookup into an instruction to remove service lines from every open restaurant ticket, then overwrites those tickets in the terminal's local database. This precisely produces occupied, Pending tables with zero totals and empty carts after reopening. It works with Restaurant live sync off.

The defect is confirmed in the release source and isolated execution. Attribution of every individual reported incident remains an inference: the affected terminals' original IndexedDB records, local logs, and exact incident times were not supplied. Server evidence independently confirms that this permission endpoint failed for a user belonging to the 32-table restaurant workspace.

**How a temporary request failure becomes permanent cart loss**

1. `useProductSelectionAccess()` calls `useServiceAccessIds()` independently of the Restaurant live sync setting. In Cloud/Hybrid workspace modes, service authorization still uses `get_accessible_service_ids`, even when restaurant tickets are stored only on the terminal. See `src/local-db/businessPartners.ts:838` and `src/local-db/serviceAccess.ts:182`.
2. The service hook refreshes every **10 seconds**, on window focus, when the document becomes visible, and after a service-access invalidation event. A single request failure is sufficient. See `src/local-db/serviceAccess.ts:225`.
3. The catch handler changes its state to `ids: new Set(), ready: true` (`serviceAccess.ts:256`). Cloud/Hybrid staff going offline also receives an empty, ready set (`serviceAccess.ts:246`). A failed authorization check is therefore indistinguishable from a successful check granting access to zero services. Administrators have an offline bypass, but online administrators still enter the request-failure catch handler.
4. Instant POS has an automatic cleanup effect (`src/ui/pages/InstantPOS.tsx:1321`). It waits for `serviceAccessReady` and the storage boundary, then calls `canSelectServiceId()` for service lines. The empty permission set returns false for every service.
5. The effect maps **all** `restaurantTickets`, rather than only the active table. When any ticket changes, it invokes `persistRestaurantTickets(nextTickets)` (`InstantPOS.tsx:1343`). That callback saves every ticket in the list (`InstantPOS.tsx:1080`). No user action or confirmation is involved, and this cleanup path does not show a removal toast.
6. `saveRestaurantRow()` writes the changed row using `localTable.put()` **before** considering cloud synchronization (`src/local-db/restaurantTables.ts:243`). With live sync off, it returns after that write and marks the row `synced`; no restaurant upload or offline mutation is created.
7. The ticket ID, table number, Pending status, and `isDeleted: false` remain. Only its `items` array becomes empty. The grid considers any existing ticket occupied and calculates its amount from `sum(quantity * unitPrice)`. An empty array totals zero.
8. When a later permission refresh succeeds, there is no retained item snapshot in this path from which to restore the cart. Reading the ticket again returns the saved empty array.

For mixed service/stock carts, the service-request failure removes the service portion; stock lines can remain. Complete zeroing across many tables is particularly consistent with restaurants whose menu entries are modeled as services.

**Release history explains the recent increase in exposure**

- `978965fb`, **v0.15.15**, 19 October 2026: introduced the service-access hook and service-aware cart cleanup.
- `cd0f34c5`, **v0.16.4**, 22 October 2026 at 05:13 Baghdad time: removed the cleanup effect's `if (excludedProductIds.size === 0) return` guard and changed its product input. Before this change, a service-only setup with no excluded physical product IDs returned before removing service lines. Removing that guard made the failed-service-permission path execute in that setup.
- `2ed18604`, **v0.16.9**, 23 October 2026: contains the exposed path. The relevant hook, cleanup, and ticket persistence code remains present in the current checkout.

An A/B execution used the **same failed permission snapshot** against the v0.16.4 parent's cleanup and v0.16.9's cleanup. The earlier effect performed **zero writes** and retained all 12 carts; v0.16.9 wrote and emptied **all 12**. The old guard was incidental protection, not an adequate general fix.

**Production evidence**

The linked Supabase project is `eboispangcayxxheoufy` (ERP). Its current restaurant configuration has four enabled workspaces, all with Restaurant live sync disabled. The server's `restaurant_pos_tickets` table currently contains zero rows, consistent with these terminal-only carts. That does not establish that the terminals contain no tickets.

| Configured tables | Workspace data mode | Active service products | Active stock products |
| --- | --- | ---: | ---: |
| 12 | Hybrid | 1 | 2 |
| 20 | Cloud | 3 | 2,070 |
| 20 | Hybrid | 39 | 0 |
| 32 | Hybrid | 114 | 0 |

The service-only 20- and 32-table Hybrid configurations match the conditions under which every occupied table can become empty. Counts are current snapshots; they are not historical inventory reconstructions or a claim that every workspace in this table experienced this incident.

Read-only unified-log queries filtered the exact path `/rest/v1/rpc/get_accessible_service_ids` and explicit UTC day windows:

| UTC log window | HTTP 200 | HTTP 401 | HTTP 503 |
| --- | ---: | ---: | ---: |
| 22 October 00:00–23 October 00:00 | 31,443 | 111 | 0 |
| 23 October 00:00–24 October 00:00 | 23,177 | 123 | 76 |

These are project-wide request counts, **not counts of carts erased**. Multiple hooks and terminals can issue the same lookup. Requests that fail before reaching the server will not appear here.

Joining the logged authenticated subject to current restaurant workspace membership identified **16 HTTP 503 responses for a user in the 32-table Hybrid restaurant**, from **23 October 23:09:26 to 23:11:56 Baghdad time** (20:09:26–20:11:56 UTC). The other error counts must not be attributed to these restaurants without additional evidence. This observation proves endpoint failures reached a relevant restaurant user; it does not reconstruct the terminal's exact UI state or establish the screenshot's incident time.

The returned status codes identify failed requests, not their underlying infrastructure or authentication cause. Determining why each 401/503 occurred is a separate investigation; cart integrity must survive either outcome.

**Isolated reproduction and verification**

Run from the repository root:

```powershell
node scripts/diagnostics/reproduce-instant-pos-cart-loss.mjs --ref=2ed18604 --compare-ref=cd0f34c5^
```

The diagnostic executes source slices read directly from the specified Git revision: the service hook, service-selection predicate, Instant POS cleanup, ticket conversion, persistence callback, and local saving functions. It injects React state/effect and request boundaries and uses disposable `fake-indexeddb` storage with Dexie. It closes and reopens that database to verify persistence. It cannot open the terminal's real browser database or contact Supabase. This is a focused reproduction, not a browser end-to-end test or a regression test endorsing the faulty behavior.

| Scenario | Observed result |
| --- | --- |
| Staff lookup succeeds, next periodic lookup fails | All 12 service carts saved empty; still Pending after reopen |
| Online administrator lookup fails | All 12 service carts saved empty |
| Cloud/Hybrid staff goes offline, restaurant live sync off | All 12 service carts saved empty; no permission request needed |
| Mixed service/stock carts, permission request fails | Service lines removed from all 12; stock retained |
| Offline administrator bypass | All 12 carts retained; zero writes |
| Successful service lookup | All 12 carts retained; zero writes |
| Service lookup still loading | All 12 carts retained; zero writes |
| Storage boundary unresolved | All 12 carts retained; zero writes |
| An excluded stock product is present | Its lines removed from every affected shared ticket |
| Pre-v0.16.4 cleanup with the same failed service snapshot | All 12 carts retained; zero writes |
| Legacy stock product acquires a restricted inventory position | Storage predicate changes from selectable to excluded |

Every persistence scenario used Restaurant live sync **off** and made **zero remote writes and zero offline-queue writes**. Captured results are in `instant-pos-zero-carts-2026-10-24.reproduction.json` alongside this report.

Existing focused tests also passed: **4 files, 19 tests** across `serviceAccess`, `restaurantTables`, `restaurantTableView`, and `instantPosServiceItems`. Those existing tests verify access lookups, settings persistence, totals/configuration, and service-line aggregation; they do not cover the hook-error → automatic cleanup → persisted table-loss chain. Passing them does not invalidate this reproduction.

**Other findings and alternatives**

- Product/category visibility is also used to mutate shared restaurant carts. The comment about protecting storage-restricted lines only disables one explicit storage test; it still removes IDs rejected by `canSelectProduct()`, whose predicate includes storage and category access. Changing the viewer must not rewrite another operator's order. This is an independent loss path; it is not required for the reproduced service-only incident.
- The storage predicate can change while inventory or assignments load, and `inventoryLoading` does not cover every call shape. The diagnostic confirms an allow→deny transition for a legacy product when a restricted position becomes known. No production incident is attributed to that timing without terminal evidence.
- Normal POS active carts and held sales contain similar service-permission pruning (`src/ui/pages/POS.tsx:878` and `:1443`). The same failure handling merits a separate regression audit there.
- `persistRestaurantTickets()` writes unchanged tickets as well as changed ones and does not await/serialize the list save. This broadens stale-snapshot and rapid-edit risks. It is a code-review finding, not a reproduced explanation for this service-only mass-zeroing.
- With Restaurant live sync enabled, the remote refresh bulk-writes ticket rows without preserving ordinary pending local updates; save responses also lack an explicit per-ticket stale-response guard. Those are additional review targets. They are not needed to explain the reported disabled-sync configuration.
- Restaurant pending-ticket expiration is explicitly skipped. Ordinary checkout/close removes or hides a ticket rather than leaving it visibly occupied with an empty cart. KDS does not need to run to reproduce the defect. The table total uses stored price/quantity snapshots, with no live exchange-rate fetch in that calculation. These alternatives do not explain the confirmed chain.

**Recommended correction**

1. Stop all automatic **persisted pruning of restaurant tickets** based on the current viewer's access or catalog availability. Validate permissions when adding/changing/checking out; preserve the stored order when access is unavailable or denied. Read-time restrictions must not become order edits.
2. Represent permission loading, successful authorization, and failed authorization separately. An error/offline state must never masquerade as a successful empty result that drives destructive mutations. Keep access controls fail-closed for protected actions while retaining cart contents.
3. Persist only explicitly changed tickets and make each edit awaitable with appropriate per-ticket ordering/revision handling. Do not rewrite every open ticket for a single change.
4. Add regression coverage for initial/periodic/focus permission failures, offline transitions, administrators and staff, actual permission removal, mixed carts, all tables, reopening, and late/out-of-order responses. Audit regular POS and held carts for the same problem.
5. Add a recoverable ticket revision/snapshot trail before destructive edits, honoring the workspace's data mode and Restaurant live sync preference. A current SQLite mirror is not a historical backup.

Restoring the old `excludedProductIds.size` guard or simply keeping live sync off does not address the underlying coupling. Enabling live sync is also not a cure: an empty ticket can then be uploaded.

**Recovery implications**

Preserve an affected terminal's local data before clearing caches, reinstalling, or attempting recovery. Inspect older backups/exports, any independently retained order copies, and printed kitchen/preprint receipts where available. Hybrid's SQLite mirror may already contain the same empty `items` arrays because Dexie updates are mirrored; it must be inspected rather than assumed to contain an earlier version.

This ticket save path retains no prior items, and these configurations have no server ticket copy or offline restaurant mutation from which to restore them. Unchecked-out carts do not become sale lines through this path. Refreshing or receiving a successful permission response will not reconstruct the removed contents. Recovery is possible only if an independent earlier copy or other order evidence exists; availability has not been established for the affected terminals.

Only this report and the isolated diagnostic/results were added during the initial investigation. No database migration, deployment, or customer-data repair was performed.

**Follow-up fix — working tree, 24 October 2026**

At the user's request, the application was patched after the investigation:

- Removed automatic permission/catalog-based line deletion from Instant POS tickets, regular POS carts, and held sales. Existing add/checkout authorization remains in place.
- Service-permission failures and Cloud/Hybrid staff offline states now report `unavailable` with `isReady: false`. Successful empty authorization remains distinguishable as `ready`. Local-mode staff still resolve access from local data; the existing offline administrator bypass remains.
- Scoped the permission cache to user, role, and Local/remote authority as well as workspace. Older request completions cannot overwrite newer refresh results.
- Restaurant persistence now saves only edited/new tickets and explicit closures. An unrelated table edit does not resave a stale snapshot of every other table.
- Added hook lifecycle regressions and production-callback tests using disposable IndexedDB, including cart preservation after reopen, explicit item removal/create/close, independent table edits, and blocked service checkout when access is missing.

The historical reproducer defaults to v0.16.9 and continues to document the original defect; it is separate from the new preservation regression tests. Run the regression tests with:

```powershell
npx vitest run scripts/diagnostics/pos-cart-preservation.test.mjs src/local-db/serviceAccessHook.test.ts src/local-db/serviceAccess.test.ts src/local-db/restaurantTables.test.ts src/lib/restaurantTableView.test.ts src/lib/instantPosServiceItems.test.ts src/dev/testing/suites/posCart.test.ts
```

Verification: 59 focused tests passed across the listed files, the application TypeScript build passed, and a production Vite bundle completed successfully in an isolated ignored output directory. Existing unrelated circular-import/chunk-size build warnings remain.

This patch prevents the reproduced automatic erasure. It does not reconstruct items already erased or address all separate live-sync concurrency findings above. No release or deployment was performed as part of this fix.
