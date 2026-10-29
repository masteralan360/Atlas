# Stock reservation protection

Pending Sales Orders commit their physical products to their source storage. Selling, reserving another order, outgoing exchanges and ordinary transfers cannot consume that commitment. Services and uncommitted drafts do not reserve inventory. Fulfillment consumes the owning order's reservation once; cancellation releases it through the existing financial workflow. There is no cashier or administrator override.

## Storage and enforcement

- Supabase derives `private.sales_order_stock_reservations` from Pending Sales Orders. The private projection has position indexes, no client table grants, and a transactional backfill that does not alter existing orders or payments.
- Reservation writes lock the affected inventory positions. An inventory trigger rejects deductions that would leave other reservations without stock. This applies to POS, Instant POS, Quick Orders, marketplace shipping, exchanges, transfers and direct inventory deductions.
- Only validated order and marketplace fulfillment functions establish the owning order's identity. An audit reference supplied by a client is not authorization to consume a reservation.
- Cloud/Hybrid reservation status is published locally only after remote confirmation. Reservation rejection is not queued as an offline mutation.
- Local mode validates the complete mutation group inside its existing SQLite transaction, before commit. A rejection rolls back the sale, stock, payment, loan and other writes in that group; Dexie remains the reactive mirror. Local order transitions and Instant POS checkout keep their associated writes in one transaction.
- Real stock adjustments and physical corrections remain possible. Existing shortages remain recorded and are shown when the affected order is opened; they do not authorize further sales against reserved stock.
- Quantities use the immutable base-unit snapshots, include free quantities, aggregate repeated lines and remain scoped to workspace and storage. A same-product exchange credits goods returned to the same source storage before checking its net outgoing demand.

## UI

Product cards, shared product pickers, cart lines, Sales Order forms/details and exchanges show on-hand, reserved and available quantities. POS quantity badges use sellable stock. Known conflicts disable checkout or fulfillment while retaining the user's input. Draft Quick Orders remain saveable.

The shared conflict dialog explains the requested quantity, physical stock, reserved quantity, sellable quantity and shortage. It offers review and reservation details without a proceed-anyway action. Reservation details use a bounded scrolling Small Dialog with source pagination in its header. Order identities are filtered by existing permissions/RLS, while all reservations contribute to aggregate availability. Order links retain the selected language and open separately to preserve the cart.

Cloud reads use the shared, memory-only TanStack Query client, scoped keys, cancellation and bounded/coalesced requests. Order mutations and inventory movement notifications invalidate availability; focus/reconnect refresh and polling reconcile other-device changes. Final transaction validation remains authoritative. Local reads are reactive indexed Dexie queries.

## Rollout order

1. Apply `supabase/migrations/20261029151640_protect_sales_order_reservations.sql`.
2. Redeploy the affected Edge Functions: `get-store-catalog`, `get-bound-storefront-catalog`, `place-bound-storefront-order`, and `verify-bound-storefront-promo-code`. Their shared stock reader exposes sellable quantities to storefronts without exposing internal reservations.
3. Deploy/build the updated Atlas clients. The new availability UI requires the migration's RPCs; do not deploy the client before the database migration.

The implementation work did not apply the migration or deploy production functions/clients.

## Verification

- Isolated real PostgreSQL (PGlite) tests exercise reservation projection, canonical/free quantities, competing requests, rollback, owning-order fulfillment, preservation of other reservations, losses, transfers/deletion, forged audit references and order RLS.
- Real SQLite tests verify transaction rollback, fulfillment, losses, reservation increases, unit conversion, storage isolation and immediately completed Quick Orders.
- Indexed Dexie tests verify duplicate cart demand, cancellation/deletion/workspace isolation, services and owning-order exclusion.
- The targeted SQLite authority, exchange and request-error regression suites pass.
- An isolated browser harness renders the actual shared UI at 1366×900 and 390×844, checks header pagination and return from the linked panel, and checks narrow Arabic/Kurdish layouts. No browser runtime errors were observed.
- TypeScript and ESLint for the new implementation files pass; the affected storefront shared modules pass Deno checking.

Broader existing suites still report unrelated expectations: an old transfer-reference ID, an unmapped historical loan-refund fixture, three removed missing-cost validations and a removed Price Book cost read. The repository-wide dialog convention check also reports existing generic dialogs in `EcommerceDetailView`, `ManualRateEditorModal`, `SalesHistoryAtlasStandardInvoiceTemplate` and `InventoryTransfer`. The new reservation dialogs use the required shared façades.
