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
| SKU, barcode, and product variants | SKU normalization/uniqueness, barcode normalization and workspace-scoped uniqueness, primary-barcode changes/deletion, parent/variant relations, and marketplace product-image snapshots. Hosted checks persist a variant and barcode revision. |
| Units, inventory, and stock movements | Unit and relationship validation, product unit conversions, stock presentation, inventory hydration/sync, and Cloud inventory transaction contracts. Hosted checks save a conversion between unique custom units and verify opening stock and the separate archive movement. |
| Prices, discounts, price books, and commissions | Product cost and discount calculations, rounding, price books, order price-book consumers, commission previews and assignments, and marketplace delivery product-commission migration rules. Hosted checks persist and then remove a price-book item, product discount, and commission rule. |
| Import, export, labels, templates, and images | Product import mapping/validation, export table rendering, barcode labels, print templates, marketplace images, image paths, and initial additional-image upload/rollback contracts. Upload behavior uses mocks; it does not write to real Supabase Storage. |
| Orders, POS, agents, and storefront consumers | Related-unit ordering and inventory transactions, POS cart/pricing/routing, product selection, catalog/storefront rules, sale product exchanges, partner product movement reads/templates/printing, and workspace-scoped destination matching. |
| Cloud / Hybrid product request contracts | Product create/edit payload scoping, cache updates only after acknowledgement, remote rejection behavior, inventory movement requests, and unit/relationship request contracts. Mocked Supabase requests run in both Cloud and Hybrid modes. |

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

The suite does not automate the Products browser form, native SQLite persistence
or restart, Hybrid SQLite mirror parity, hardware barcode scanning, actual image
uploads to private Storage, or broad live RLS checks across non-admin roles.
Hosted workspace scoping is checked with the dedicated admin account; it is not
a substitute for testing each permission role. Those environments are marked
unavailable or isolated-only in the registry until they have a safe, dedicated
adapter and scenarios.

## Existing failing product-movement checks

The first full isolated run preserved two failures in the existing product
movement scenarios. `src/lib/partnerProductMovements.test.ts` expected fulfilled
quantities `[1.5, 3, 2]` but received `[3, 2]`. The PDF integration case in
`src/lib/partnerProductMovementsCustomTemplates.test.tsx` expected the edited
footer `Current edited footer` but received an empty footer. They remain
registered in **Orders, POS, agents, and storefront consumers** so later changes
can show when the behavior is corrected. Reproduce them with
`npm run test:products -- --groups product-consumers`.
