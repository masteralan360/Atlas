# Atlas Architecture

## Workspace data modes

- **Cloud:** Supabase is the source of truth; Dexie is a local cache and offline changes sync when connectivity returns.
- **Hybrid:** Supabase remains the source of truth; desktop apps also maintain a local SQLite mirror for resilience and recovery.
- **Local:** The device’s SQLite database is the source of truth; business data does not synchronize with Supabase.
- All modes use Dexie/IndexedDB for responsive local UI reads and writes.

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

## Testing calculations and transactions

Any new or changed calculation logic MUST include Vitest coverage for expected results, rounding, and relevant boundary cases.
Any new or changed transaction flow MUST include Vitest coverage that verifies the resulting records, balances, and ledger effects.
Tests must cover both the successful path and important validation or failure paths.

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
All print workflows MUST follow `PrintSelectionModal` → `PrintPreviewModal` → `PrintPreviewEditorPage` → final print/save action; modules must not bypass these stages with custom preview or direct-print flows.
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
