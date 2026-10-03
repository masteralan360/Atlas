import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const sourceRoot = path.join(process.cwd(), 'src')

// This is filled from the current codebase once. Existing generic dialogs are
// tolerated, but this guard prevents adding another one anywhere in `src`.
const legacyGenericDialogBaseline = {
  'src/marketplace/components/StoreQrDialog.tsx': 1,
  'src/ui/components/budget/BudgetLockPromptModal.tsx': 1,
  'src/ui/components/budget/BudgetSnoozeModal.tsx': 1,
  'src/ui/components/budget/MonthlyBudgetAllocationModal.tsx': 1,
  'src/ui/components/crm/BusinessPartnerFormDialog.tsx': 1,
  'src/ui/components/crm/PartnerLocationField.tsx': 1,
  'src/ui/components/DeleteConfirmationModal.tsx': 1,
  'src/ui/components/ecommerce/MarketplaceOrderReminderModal.tsx': 1,
  'src/ui/components/exchange/RateDiscrepancyModal.tsx': 1,
  'src/ui/components/exchange/SnoozeSelectionModal.tsx': 1,
  'src/ui/components/ExchangeRateIndicator.tsx': 1,
  'src/ui/components/FireConfirmationModal.tsx': 1,
  'src/ui/components/fleet/FleetAssignmentDialog.tsx': 1,
  'src/ui/components/fleet/FleetVehicleDialog.tsx': 1,
  'src/ui/components/Layout.tsx': 2,
  'src/ui/components/loans/LoanPartyPickerDialog.tsx': 1,
  'src/ui/components/loans/SaveBorrowerAsPartnerDialog.tsx': 1,
  'src/ui/components/LocalAccountSwitcher.tsx': 1,
  'src/ui/components/ManualSyncModal.tsx': 2,
  'src/ui/components/MetricDetailModal.tsx': 1,
  'src/ui/components/modals/PatchNoteModal.tsx': 1,
  'src/ui/components/modals/RegisterWorkspaceContactsModal.tsx': 1,
  'src/ui/components/modals/WhatsAppNumberInputModal.tsx': 1,
  'src/ui/components/NotificationCenter.tsx': 1,
  'src/ui/components/orders/AtlasStandardOrderInvoiceTemplate.tsx': 4,
  'src/ui/components/orders/OrderAdjustmentsDialog.tsx': 1,
  'src/ui/components/orders/OrderDetailsView.tsx': 2,
  'src/ui/components/orders/OrderLineItemNoteDialog.tsx': 1,
  'src/ui/components/orders/SalesOrderFormPage.tsx': 1,
  'src/ui/components/PartialReturnInfoModal.tsx': 1,
  'src/ui/components/pos/BarcodeScannerModal.tsx': 1,
  'src/ui/components/pos/CheckoutSuccessModal.tsx': 1,
  'src/ui/components/pos/CrossStorageWarningModal.tsx': 1,
  'src/ui/components/pos/HeldSalesModal.tsx': 1,
  'src/ui/components/pos/PosAdjust.tsx': 1,
  'src/ui/components/pos/QuickOrderModal.tsx': 1,
  'src/ui/components/pos/QuickOrderSuccessModal.tsx': 1,
  'src/ui/components/PostSaveInvoiceDialog.tsx': 1,
  'src/ui/components/PriceBookManagementDialog.tsx': 1,
  'src/ui/components/print/HideablePrintFieldCard.tsx': 1,
  'src/ui/components/ProductAdditionalImagesModal.tsx': 1,
  'src/ui/components/ProductsViewModal.tsx': 1,
  'src/ui/components/ProfileCardModal.tsx': 1,
  'src/ui/components/real-estate/RealEstateBuyPrintTemplate.tsx': 1,
  'src/ui/components/real-estate/RecordRealEstatePaymentModal.tsx': 1,
  'src/ui/components/reminders/UnifiedSnoozedRemindersBell.tsx': 1,
  'src/ui/components/ReturnConfirmationModal.tsx': 1,
  'src/ui/components/ReturnDeclineModal.tsx': 1,
  'src/ui/components/ReturnRulesDisplayModal.tsx': 1,
  'src/ui/components/revenue/PeakTradingModal.tsx': 1,
  'src/ui/components/revenue/ProductSalesSummaryModal.tsx': 1,
  'src/ui/components/revenue/ReturnsAnalysisModal.tsx': 1,
  'src/ui/components/revenue/SalesOverviewModal.tsx': 1,
  'src/ui/components/revenue/TopProductsModal.tsx': 1,
  'src/ui/components/SaleDetailsModal.tsx': 1,
  'src/ui/components/SalesNoteModal.tsx': 1,
  'src/ui/components/small-dialog.tsx': 1,
  'src/ui/components/SubscriptionExpiryWarningModal.tsx': 1,
  'src/ui/components/UsbBackupWarningModal.tsx': 1,
  'src/ui/components/workspace/BranchManager.tsx': 1,
  'src/ui/components/WorkspaceExtraDaysDialog.tsx': 1,
  'src/ui/components/WorkspaceLocationPrompt.tsx': 1,
  'src/ui/components/WorkspacePaymentDialog.tsx': 2,
  'src/ui/pages/Budget.tsx': 2,
  'src/ui/pages/ClinicalAppointments.tsx': 1,
  'src/ui/pages/CurrencyExchange.tsx': 3,
  'src/ui/pages/CustomTemplates.tsx': 2,
  'src/ui/pages/Discounts.tsx': 1,
  'src/ui/pages/Ecommerce.tsx': 2,
  'src/ui/pages/ForgetPasswordFeature.tsx': 1,
  'src/ui/pages/HR.tsx': 1,
  'src/ui/pages/InstantPOS.tsx': 2,
  'src/ui/pages/InventoryTransactions.tsx': 1,
  'src/ui/pages/InventoryTransfer.tsx': 1,
  'src/ui/pages/InvoicesHistory.tsx': 1,
  'src/ui/pages/Ledger.tsx': 1,
  'src/ui/pages/LockedWorkspace.tsx': 1,
  'src/ui/pages/ManualEntry.tsx': 1,
  'src/ui/pages/ManualEntryTemplates.tsx': 1,
  'src/ui/pages/Members.tsx': 3,
  'src/ui/pages/Orders.tsx': 2,
  'src/ui/pages/PrintPreviewEditorPage.tsx': 1,
  'src/ui/pages/POS.tsx': 8,
  'src/ui/pages/PostService.tsx': 2,
  'src/ui/pages/ProductFormPage.tsx': 4,
  'src/ui/pages/Products.tsx': 4,
  'src/ui/pages/Revenue.tsx': 1,
  'src/ui/pages/Sales.tsx': 1,
  'src/ui/pages/ServiceFormPage.tsx': 3,
  'src/ui/pages/Settings.tsx': 9,
  'src/ui/pages/Storages.tsx': 2,
  'src/ui/pages/TeamPerformance.tsx': 1,
  'src/ui/pages/UnitsPage.tsx': 1,
}

function getTsxFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      return getTsxFiles(fullPath)
    }

    return entry.isFile() && fullPath.endsWith('.tsx') ? [fullPath] : []
  })
}

function usesStructuredLayout(openingElement) {
  return openingElement.attributes.properties.some((attribute) => (
    ts.isJsxAttribute(attribute)
    && attribute.name.text === 'layout'
    && attribute.initializer
    && ts.isStringLiteral(attribute.initializer)
    && attribute.initializer.text === 'structured'
  ))
}

function countGenericDialogs(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let count = 0

  function visit(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && node.tagName.getText(sourceFile) === 'DialogContent'
      && !usesStructuredLayout(node)) {
      count += 1
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return count
}

const currentCounts = Object.fromEntries(
  getTsxFiles(sourceRoot)
    .map((filePath) => [path.relative(process.cwd(), filePath).replaceAll('\\', '/'), countGenericDialogs(filePath)])
    .filter(([, count]) => count > 0),
)

if (process.argv.includes('--print-baseline')) {
  console.log(JSON.stringify(currentCounts, null, 2))
  process.exit(0)
}

const violations = Object.entries(currentCounts)
  .filter(([filePath, count]) => count > (legacyGenericDialogBaseline[filePath] ?? 0))
  .map(([filePath, count]) => `${filePath}: ${count} generic DialogContent use(s); allowed: ${legacyGenericDialogBaseline[filePath] ?? 0}`)

if (violations.length > 0) {
  console.error('New generic dialogs are not allowed. Use AppDialog* for a structured modal, or SmallDialog for a compact interaction.\n')
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log('Dialog conventions passed.')
