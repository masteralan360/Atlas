# Atlas Architecture

## Admin dashboard backend files

All Supabase Edge Functions and database migrations related to the Admin dashboard live in this Atlas repository under `supabase/functions` and `supabase/migrations`, not in `E:\ERP System\Admin`. Make Admin dashboard backend changes here; the Admin repository contains its frontend.

## Workspace data modes

- **Cloud:** Supabase is the source of truth; Dexie is a local cache and offline changes sync when connectivity returns.
- **Hybrid:** Supabase remains the source of truth; desktop apps also maintain a local SQLite mirror for resilience and recovery.
- **Local:** The device’s SQLite database is the source of truth; business data does not synchronize with Supabase.
- All modes use Dexie/IndexedDB for responsive local UI reads and writes.

## TanStack Query and server-state conventions

- TanStack Query is an in-memory cache for remote Cloud/Hybrid server state. It does not replace Dexie, the offline mutation queue, workspace hydration/freshness, or SQLite authority in Local mode. Do not persist the Query cache.
- The app-level `QueryClientProvider` and workspace/user/data-mode cache boundary live in `src/main.tsx`, `src/App.tsx`, and `src/query/`. Reuse the shared `queryClient`; do not create feature-level clients or providers.
- Define reusable keys in `src/query/queryKeys.ts`. Keys must include the workspace, every filter/page/sort input, and any user or permission scope that changes visibility. Keep related keys under a feature root so mutations can invalidate the smallest correct namespace. Do not include presentation-only state or refresh counters in keys.
- Keep remote page fetchers and reusable hooks in the relevant `src/local-db` data module. Pass TanStack Query's `AbortSignal` to Supabase requests, normalize and validate remote results there, and update the Dexie cache without overwriting pending or conflicting local rows. Pages and components must not issue their own Supabase requests for list data.
- Use TanStack Query for remote reads that benefit from request deduplication, scoped caching, cancellation, or refetching. Local mode must continue reading its indexed Dexie/SQLite mirror reactively. Do not wrap every existing Dexie hook in Query or duplicate the same server data in competing state stores.
- Query cache defaults are centralized in `src/query/queryClient.ts`. Keep page requests free of previous-page placeholder data: while a remote page is loading, show the localized centered loader and do not display rows from another page or filter.
- After a mutation changes data represented by Query, invalidate the affected feature key after the existing persistence/offline-queue operation succeeds. Prefer the established local database mutation path; do not add a second Query-cache optimistic write for data already updated through Dexie.
- Every mutation that changes data shown in a remote server-paged list must refresh that list after the persistence/offline-queue operation succeeds. For TanStack Query lists, invalidate the smallest affected feature namespace or page key. For custom page hooks, use an explicit refresh mechanism such as a refresh key or callback. This applies to create, update, and delete mutations, including mutations initiated outside the list page. Never rely on navigating away and back to refresh the list. Refresh the active page and its filtered total/page count without loading the full dataset; preserve the shared loading and pagination-bound behavior when the page count changes.
- Optimistic Query updates are allowed only for low-risk, reversible actions whose authoritative state is not already updated through Dexie. Cancel in-flight related queries, snapshot every affected cache entry, apply one deterministic update, restore snapshots on failure, and invalidate the related namespace on settlement. Never optimistically change payments, ledger entries, inventory quantities, permissions, or irreversible business operations.

## TanStack Table and virtualization

- Use TanStack Table when a table has meaningful sorting, filtering, selection, or server-pagination state to coordinate. Keep Atlas table components and existing visual conventions for markup; TanStack Table manages row/state models and is not a UI replacement.
- For source-paged data, configure manual pagination/sorting/filtering and pass the exact filtered row count from the source. Sorting must use a stable unique tie-breaker at the data source. Keep pagination in the table header as required below.
- Keep the existing `react-virtuoso` integrations where they already solve large-list rendering. Do not add TanStack Virtual or migrate a working virtualizer without profiling that shows a measurable benefit.
- For combined or derived lists, do not claim compliance by slicing an already-loaded array. Provide an equivalent filtered page and summary from the authoritative source, or keep full-dataset operations batched when they truly require every row.

## Pagination and large lists

- Use the shared `AppPagination` control for list and table pagination. Use `usePaginationState` from `src/hooks/usePaginationState.ts` for a single list's page and page-size state, and `usePaginationPageMap` for views with an independent page per tab. Keep persisted page-size preferences and validate them against the view's offered options.
- Declare the filters that invalidate the current page in `resetOn`; changing search, date range, sorting, or result filters must return to page 1 in the same render as the new criteria. Changing page size must also return to page 1.
- After the page data is available, use `usePaginationBounds` to derive the displayed page and page count. Pass its `pageCount` into `AppPagination`. Clamp only after a successful result; while a remote request is loading or failed, preserve the selected page and last known page count so pending empty data cannot reset navigation.
- Keep page data-source behavior appropriate to Cloud, Hybrid, and Local modes. The shared pagination hooks standardize navigation state and bounds; they do not replace source-side filtering, remote paging, indexed Dexie reads, or module-specific APIs.
- Apply search, filters, sorting, and pagination at the data source before loading records into the UI. UI pagination alone does not prevent the app from loading the full dataset.
- Cloud and Hybrid modules must page remote data through Supabase queries or RPCs and keep Dexie cache reads consistent. Local modules must use indexed local queries with equivalent filtering and ordering.
- Calculate the total count from the same filtered dataset as the current page.
- Use a stable sort with a unique tie-breaker so records do not move unpredictably between pages.
- During remote page changes, replace the previous page's records with a centered, localized loading indicator until the requested page loads, and keep pagination in the header; Take Business Partners and Products modules paginations as reference.
- Load related or derived data only for records on the current page. Avoid unbounded reads such as `toArray()` when they are only used for pagination, search, or sorting.
- Operations that require the full dataset, such as exports or bulk processing, must fetch and process records in batches.
- Add or reuse database indexes for common workspace scopes, filters, and sort fields when needed.

## Live Exchange Rate Fetch

Any module that requires live exchange rate fetch MUST use the app-provided and centralized live exchange rate fetcher at `src/lib/exchangeRate.ts` and always ensure the exchange rate is up to date.

## New Modules

Any new module must have its access controlled either by workspace plan or by admin grant (E:\ERP System\Admin).
When adding a module, the user must specify whether it should be included in one or more plans or remain admin-grant only.
No new module should be accessible without one of these access rules being explicitly configured.
Any new module that reads remote data must use scoped `ModulePageFreshness` with its own table names, and report start, page progress, completion, cancellation, and failure through `workspaceDataFreshness`; never show “Up to date” from an unrelated table’s load.

## Payment transactions

Every incoming or outgoing payment MUST be recorded through `payment_transactions` and mirrored in the ledger. Do not update payment balances or ledger entries directly without the corresponding payment transaction.
Every reversed payment MUST remain visible in the ledger as a separate counter-entry linked to its original payment; each counter-entry must reverse its exact portion, so linked entries net to zero after a full reversal and to the correct remaining amount after a partial reversal.
Every UI flow that processes a real payment MUST require the user to proceed through a payment dialog, following the existing payment workflow.
Every UI flow that records a real incoming or outgoing payment, rather than merely creating an unpaid obligation, MUST include the provided `PaymentAccountSelector`.
The selector remains optional: with no selection, record the payment transaction and ledger entry normally; when selected, pass the account ID and name snapshot to the payment transaction so its account movement is created.
Do not create a module-specific account selector or update a payment-account balance directly; account movements must be derived from the payment transaction.


# Atlas UI conventions

All full-page forms and detail/view pages MUST use the full available content area. Do not constrain them with a centered max-width wrapper unless the user explicitly requests it.

## Dialogs (required)

Clearly mark every required form field in its label with an asterisk (`*`), including required title fields.

Use the Atlas structured-dialog façade for every new workflow, form, detail, list, or editor modal. It supplies the app's responsive shell, fixed header and footer, safe-area spacing, and a scrollable body.

```tsx
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
} from '@/ui/components'

<AppDialog open={open} onOpenChange={setOpen}>
  <AppDialogContent className="max-w-2xl">
    <AppDialogHeader>
      <AppDialogTitle>Dialog title</AppDialogTitle>
    </AppDialogHeader>
    <AppDialogBody>{/* scrollable content */}</AppDialogBody>
    <AppDialogFooter>{/* actions */}</AppDialogFooter>
  </AppDialogContent>
</AppDialog>
```

Use the base `Dialog*` primitives only when a compact confirmation, alert, or deliberately custom interaction needs a different presentation. Do not create a new generic `DialogContent` modal as a shortcut. Keep the header, body, and footer separate; never make the whole structured dialog scroll.

The dialog's `confirmation` or `Proceed` button MUST be `disabled/grayed` out if there is a `requirement field or selector` which is invalid or empty.

Every save, confirm, or proceed action MUST show a grayed-out loading state and disable its trigger immediately while processing, preventing duplicate submissions from repeated clicks.

For fields that primarily contain numeric values or monetary amounts, display values using appropriate number formatting and thousands separators (for example, `100000` → `100,000`). Apply this consistently in both editable inputs and read-only displays where applicable, also have `0` as a placeholder for empty values and deleting an amount in the field must not make it 0 but rather an unvalid-to-proceed empty field with the `0` placeholder.

Any field that requires date or date/time selection MUST use the app-provided date picker component at `src/ui/components/ui/date-time-picker.tsx`. Do not use native browser or operating-system date/time inputs or pickers (such as `<input type="date">` or `<input type="datetime-local">`). This keeps date selection behavior and presentation consistent across the application.

Any field that requires a business partner to be selected, then it must use the provided partnerautocomplete component at `src/ui/components/crm/BusinessPartnerAutocomplete.tsx` and have the `Linked` badge when linked as well as `Unlink` component when the business partner is linked, if unlinked it must empty out the business partner field and it's related data.

Any field that requires a product to be selected, then it must use the provided productautocomplete component at `src/ui/components/crm/ProductAutocomplete.tsx` and ProductsViewModal at `src/ui/components/crm/ProductsViewModal.tsx` wired properly to the productautocomplete component and have the `Linked` badge when linked as well as `Unlink` component when the product is linked, if unlinked it must empty out the product field.

Any field or control that allows users to select a currency MUST use the app-provided `CurrencySelector` component at `src/ui/components/CurrencySelector.tsx`. Do not create custom currency dropdowns, selectors, or native alternatives. Reuse this component consistently wherever currency selection is required.

Any field or cntrol that allows users to select a payment method MUST use the app-provided `PaymentMethodSelector` component at `src/ui/components/PaymentMethodSelector.tsx`. Do not create custom payment method dropdowns, selectors, or native alternatives IF the use is not module specific (for e.g. if a module needs a specific payment method selector, it can create new payment method inside app's provided one and wire it to that specific module). Reuse this component consistently wherever payment method selection is required.

## Selectors and asynchronous options

Controlled selectors MUST preserve their current value while options are loading or refreshing; loading or empty options must never clear or replace the selection. Accept only a value that matches an available option or an explicit user-initiated clear action. If a saved value is no longer available, keep it visible as unavailable until the user changes or clears it. Validate selected values again when saving, and show a localized, user-friendly error if persistence or cloud sync fails. Reuse shared selector behavior where practical, and cover asynchronous loading, refresh, unavailable values, explicit clearing, and create/edit flows with regression tests.

While the modal is proceeding/processing it must NOT allow the user to close the modal by the overlay or X button. This is to prevent the user from closing the modal while the data is being saved and thus potentially corrupting the data.

When a workflow explicitly uses `MultipleModalLayout`, only its last active panel may own the primary confirmation/submit action. Earlier panels may collect and validate data, but must not offer a competing confirmation action; closing a linked panel must return to the preceding step without losing its input.

Before finishing a modal, compare it with `src/ui/components/crm/BusinessPartnerFormDialog.tsx` and verify it at a narrow mobile width as well as desktop.

## Small Dialogs
Use the `src/ui/components/ui/small-dialog.tsx` component for dialogs that are normally used for showing information, such as the selected items details or list of items.

## Localization (required)
Use the `react-i18next` library for all text content that appears in the UI . Do not hardcode strings in components or application logic. The expected flow is:

1. Define text in the relevant language JSON file at `src/i18n/locales/`
2. Refer to text via keys in JSX, for example: `<p>{t('welcomeMessage')}</p>`

Before adding or translating terminology, search `src/i18n/locales/ku.json` and `src/i18n/locales/ar.json` for the widely used existing term and reuse it whenever applicable.
Do not introduce alternate Kurdish or Arabic terms for an existing app concept unless the user explicitly requests a terminology change or its a new term that has to be introduced.

Message toasts must also be localized and shown a User-Friendly message and not technical.

## Printing
Every user-initiated print entry point MUST first open `PrintSelectionModal`. After the user selects a print format or template, open `PrintPreviewEditorPage` directly; there is no intermediate preview modal in the flow.
`PrintPreviewEditorPage` MUST generate the final PDF blob from the user's current edits or layout, then pass it to the configured `onPrint` or `onSave` callback; print-only workflows use `onPrint`.
For invoice saves, `onSave` MUST use the standard invoice snapshot and PDF-version persistence flow, after which the saved document is exposed through `PostSaveInvoiceDialog`.

If said new print template is required to have tables, then it must use the in-app A4 pagination for tables similar to 
'src\ui\components\crm\PartnerAccountStatementPrintTemplate.tsx'.

it Must always have its custom template.

## Date-range filtering

Any new module that displays a table or list of timestamped records MUST include the shared `DateRangeFilters` control when filtering by creation date is meaningful. Reuse this component rather than building a custom date-range filter.

## Delete Confirmation

Any field or control that allows users to delete data MUST use the app-provided delete confirmation dialog at `src/ui/components/ui/delete-confirmation-dialog.tsx`. Do not create custom delete confirmation dialogs, or native alternatives. Reuse this component consistently wherever delete confirmation is required.

## Iconage 

Use alot of icons, icons should be everywhere in the application. If the user cant see what he needs to do, use an icon to guide them.
