# Workspace product sync failure — 2026-11-02

Workspace: `e445e7d4-c676-4b1f-a431-880121779d2a` (Hybrid).
Supabase project: `eboispangcayxxheoufy`.
Reported window: 07:00–09:00 Asia/Baghdad (04:00–06:00 UTC).

## Evidence

The workspace admin's API requests in the reported window included:

- 91 HTTP 400 responses from `apply_offline_stock_operation`, with PostgreSQL
  `22P02` errors casting legacy `product UUID:storage UUID` inventory IDs to UUID.
- 56 HTTP 403 responses from product writes. PostgreSQL rejected these with
  `42501`, `new row violates row-level security policy for table "products"`.
- 3 HTTP 409 responses from product UoM writes, with `23503`,
  `Product UoM must belong to a product in the same workspace`.

The affected profile is an admin whose current workspace matches this workspace.
The workspace is unlocked and has no storage-member exclusions. A rollback-only
upsert using the affected profile's authenticated permissions reproduced the
product RLS rejection. This is a server-side failure, independent of reinstalling
the client.

## Cause and repair

Product SELECT RLS calls a STABLE storage helper that looks the proposed product
up in `products`. PostgreSQL applies SELECT RLS during `INSERT ... ON CONFLICT DO
UPDATE`; the newly proposed row is absent from that helper's statement snapshot.
This incorrectly rejects even the workspace admin's new products. Dependent UoM
writes cannot find their rejected parent products.

Migration `20261102092306_fix_admin_product_upsert_visibility` was applied to the
live project. It evaluates admin storage access directly inside the workspace-
scoped SELECT policy. Staff storage checks, service entitlements, and the separate
restrictive service-category policies remain in place. RLS remains enabled.

The earlier composite-inventory-ID migration
`20261101200401_support_composite_inventory_ids_in_offline_stock` was already
installed when this investigation inspected the server. It was verified with a
rollback-only call using a real workspace inventory position and a composite ID;
the response returned the authoritative UUID, alias, and availability. No second
inventory repair or manual quantity adjustment was applied.

## Verification and recovery

- After the policy repair, a live rollback-only probe using the affected admin
  created a product, retried its upsert, and upserted its base UoM. The result was
  exactly one product and one active base UoM. Deferred constraints passed.
- PostgreSQL regression tests reproduce the old failure and verify admin create/
  retry, both product storage scopes, workspace isolation, service entitlement
  checks, and staff storage visibility.
- Offline-stock regression tests verify composite-ID replay, idempotency, and
  rejection of an ID that refers to a different inventory position.
- Supabase security advisor finding counts were unchanged after the repair.

The rejected queue belongs to the affected device, not Supabase. The user should
run **Retry sync** / **Sync Now** from that device while signed in as the original
admin. The established retry path explicitly requeues integrity failures. These
probes do not establish that the device has replayed its pending changes, and
cannot recover local-only records already erased by an uninstall.
