# Products V1 developer test coverage

The Products developer suite is available from **Products → Developer tests**
in development, at `/__atlas-dev-testing/preview?suite=products`, and through
`npm run test:products`. It groups product-owned behavior with the existing
order, POS, marketplace, commission, and product-movement scenarios that use
Products data. The catalog lifecycle group accepts the standard seed and sample
count; the remaining checks use fixed scenarios.

## Selectable groups

| Group | Main coverage |
| --- | --- |
| Catalog fields, categories, and product lifecycle | Generated Local-mode create/edit/archive cases; defaults, price/cost/currency, return settings, zero initial stock, duplicate SKU rejection, category cleanup, and services/catalog persistence. Hosted checks persist edits, reject duplicate SKUs, detach archived categories, verify workspace-scoped reads, and archive products. |
| SKU, barcode, and product variants | SKU normalization/uniqueness, camera-capture SKU normalization, barcode normalization and workspace-scoped uniqueness, primary-barcode changes/deletion, parent/variant relations, and marketplace product-image snapshots. Hosted checks persist a variant and barcode revision. |
| Units, inventory, and stock movements | Unit and relationship validation, product unit conversions, stock presentation, inventory hydration/sync, and Cloud inventory transaction contracts. Hosted checks save a conversion between unique custom units and verify opening stock and the separate archive movement. |
| Prices, discounts, price books, and commissions | Product cost and discount calculations, rounding, price books, order price-book consumers, minimum selling price field visibility and staff/admin boundaries, commission previews and assignments, and marketplace delivery product-commission migration rules. Hosted checks persist and then remove a price-book item, product discount, and commission rule. |
| Import, export, labels, templates, and images | Product import mapping/validation, export table rendering, barcode labels (including service rows with an SKU), print templates, marketplace images, image paths, and initial additional-image upload/rollback contracts. Upload behavior uses mocks; it does not write to real Supabase Storage. |
| Orders, POS, agents, and storefront consumers | Related-unit ordering and inventory transactions, POS cart/pricing/routing, product selection, catalog/storefront rules, sale product exchanges, partner product movement reads/templates/printing, and workspace-scoped destination matching. |
| Cloud / Hybrid product request contracts | Product create/edit payload scoping, cache updates only after acknowledgement, remote rejection behavior, minimum selling price validation request/result/failure handling, inventory movement requests, and unit/relationship request contracts. Mocked Supabase requests run in both Cloud and Hybrid modes. |

The files and selectable group definitions live in `src/dev/testing/suites.json`.
The dialog coverage help is localized in English, Kurdish, and Arabic.

## Isolated checks and hosted Supabase

Every hosted group runs its mapped isolated group first. Catalog lifecycle,
identifiers/variants, units/stock, and pricing/rules have focused live scenarios.
Import/export/assets, product consumers, and Cloud/Hybrid request contracts are
marked isolated-only in the Hosted Supabase selector; selecting those groups
does not imply that the server effects were exercised.

Run `npm run test:products:live` only with the dedicated configuration described
in [Developer module tests](./developer-testing.md). Preflight requires the test
account to be an admin whose current and only visible workspace is the named
`DEV TEST` Cloud or Hybrid workspace. It checks the product, category, barcode,
inventory, unit, price-book, discount, and commission schemas before scenarios
start, and the live child can contact only that project's HTTPS Supabase origin.
The setup uses a publishable or legacy anon key; service-role keys are rejected.

Live fixtures have `DEV TEST PRODUCT` names and recorded IDs in the report.
Failed scenarios retain records for inspection. Passing product, category,
variant, barcode, conversion, price, discount, and commission records are
archived or removed where supported. Inventory audit movements remain, and
storage locations created by the stock scenario are retained. Use an empty
test workspace because product stock history is audit data.

## Coverage gaps

The suite does not automate the Products browser form, live device-camera or
hardware barcode scanning, native SQLite persistence or restart, Hybrid SQLite
mirror parity, actual image uploads to private Storage, or broad live RLS checks
across non-admin roles.
Hosted workspace scoping is checked with the dedicated admin account; it is not
a substitute for testing each permission role. Those environments are marked
unavailable or isolated-only in the registry until they have a safe, dedicated
adapter and scenarios.

## Product movement checks

Movement statements include fulfilled sales and received purchase quantities.
An `ordered` purchase order is not counted as received inventory, even when its
line contains a planned quantity. The custom-template integration check inspects
the rendered page passed to the PDF generator, including the current edited
text and print language. Reproduce these checks with
`npm run test:products -- --groups product-consumers`.

The hosted pricing scenario reads the workspace's `priceBooks` capability. When
granted, it verifies Price Book and item persistence. When absent, it verifies
that RLS rejects creation. Product discounts are checked in either case.
Commission-rule persistence runs only when the workspace has the
`sales_agent_commissions` module grant; otherwise the isolated commission tests
remain the coverage for that module.
