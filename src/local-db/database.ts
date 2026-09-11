import Dexie, {
  type DBCore,
  type DBCoreMutateRequest,
  type DBCoreMutateResponse,
  type DBCoreTable,
  type EntityTable,
  type Transaction
} from 'dexie'
import type {
  Product,
  ProductBarcode,
  PriceBook,
  PriceBookItem,
  Category,
  Unit,
  Invoice,
  InvoiceVersion,
  User,
  SyncQueueItem,
  Sale,
  SalesExchange,
  SaleItem,
  SaleReturn,
  SaleReturnItem,
  SaleProductExchange,
  OrderReturn,
  OrderReturnItem,
  OfflineMutation,
  Workspace,
  AppSetting,
  Storage,
  Inventory,
  InventoryTransaction,
  StockBatch,
  InventoryTransferTransaction,
  ReorderTransferRule,
  Supplier,
  Customer,
  Agent,
  AgentExcludedCategory,
  AgentCommissionPlan,
  AgentCommissionMembership,
  ProductCommissionRule,
  ProductCommissionRuleAgent,
  SalesOrderAgentAssignment,
  AgentCommissionEntry,
  AgentProductCommissionEntry,
  FleetVehicle,
  FleetVehicleAssignment,
  RentalVehicle,
  RentalRequest,
  RentalContract,
  DeliveryMerchantProfile,
  DeliveryShipment,
  DeliveryShipmentEvent,
  DeliveryShipmentCodAdjustmentRequest,
  DeliveryShipmentCodCorrection,
  DeliveryShipmentRecipientPayoutCorrection,
  DeliveryShipmentRecipientPayoutAdjustmentRequest,
  DeliveryRun,
  DeliveryRunItem,
  DeliverySettlement,
  DeliveryLedgerEntry,
  BusinessPartner,
  BusinessPartnerMergeCandidate,
  Employee,
  WorkspaceContact,
  RestaurantTableSettings,
  RestaurantPosTicket,
  Loan,
  LoanInstallment,
  LoanPayment,
  InstallmentSale,
  InstallmentSaleInstallment,
  InstallmentSalePayment,
  PaymentTransaction,
  FinancialTransactionVoid,
  PaymentAccount,
  CapitalPool,
  PaymentAccountBalance,
  PaymentAccountMovement,
  CashierShift,
  CashierShiftCurrencyCount,
  CashierShiftTemplate,
  CashierShiftAssignment,
  CashierShiftOccurrence,
  CashierShiftPauseRequest,
  CashierShiftPausePeriod,
  BudgetSettings,
  BudgetAllocation,
  ExpenseCategory,
  ExpenseSeries,
  ExpenseItem,
  PayrollStatus,
  DividendStatus,
  ProductDiscount,
  CategoryDiscount,
  SalesOrder,
  PurchaseOrder,
  OrderInstallment,
  RealEstateTransaction,
  RealEstateInstallment,
  RealEstatePayment,
  TravelBooking,
  TravelPassenger,
  ActivityCatalogItem,
  ActivityTransaction,
  ActivityTransactionLine,
  ExchangePairPrice,
  ExchangeTransaction,
  ExchangeFeeRule,
  ExchangeSafe,
  ExchangeSafeBalance,
  ExchangeSafeMovement,
  ClinicalAppointment,
  ClinicalPatient,
  ClinicalAttachment,
  ClinicalPreset,
  Profile,
  LocalAccountCredential,
  ModuleLockerSettings,
  ModuleLockerLock,
  ModuleLockerAuditEvent,
  WorkspacePermission,
  ManualEntryTemplate,
  ManualEntry
} from './models'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { normalizeProductSku } from './productSku'
import { getActiveBusinessWorkspaceId } from '@/lib/network'
import {
  LOCAL_MODE_SQLITE_TABLES,
  commitLocalModeSqliteMutations,
  queueLocalModeSqliteDelete,
  queueLocalModeSqliteUpsert,
  type LocalModeSqliteMutation,
  type LocalModeSqliteTableName
} from './localModeSqlite'

const STOCK_ADJUSTMENT_REASONS = [
  'purchase',
  'return',
  'correction',
  'damage',
  'theft',
  'expired',
  'production',
  'other'
] as const

const SUPPORTED_CURRENCIES = ['usd', 'eur', 'iqd', 'try'] as const

interface LocalModeSqliteTransactionContext {
  mutations: LocalModeSqliteMutation[]
}

const localModeSqliteTransactions = new WeakMap<object, LocalModeSqliteTransactionContext>()

function isMirroredSqliteTable(tableName: string): tableName is LocalModeSqliteTableName {
  return (LOCAL_MODE_SQLITE_TABLES as readonly string[]).includes(tableName)
}

function getMutationWorkspaceId(tableName: LocalModeSqliteTableName, row: Record<string, unknown>) {
  if (tableName === 'workspaces') {
    return typeof row.id === 'string' ? row.id : null
  }
  if (tableName === 'profiles') {
    return typeof row.currentWorkspaceId === 'string'
      ? row.currentWorkspaceId
      : typeof row.workspaceId === 'string'
        ? row.workspaceId
        : null
  }
  if (typeof row.workspaceId === 'string') {
    return row.workspaceId
  }
  if (tableName === 'sale_items') {
    return getActiveBusinessWorkspaceId()
  }
  return null
}

function readRowsBeforeMutation(table: DBCoreTable, request: DBCoreMutateRequest): Promise<Record<string, unknown>[]> {
  if (request.type === 'add' || request.type === 'put') {
    return Dexie.Promise.resolve(request.values as Record<string, unknown>[])
  }
  if (request.type === 'delete') {
    return table
      .getMany({
        trans: request.trans,
        keys: request.keys
      })
      .then((rows) => rows.filter(Boolean) as Record<string, unknown>[])
  }

  return table
    .query({
      trans: request.trans,
      values: true,
      query: {
        index: table.schema.primaryKey,
        range: request.range
      }
    })
    .then(({ result }) => result as Record<string, unknown>[])
}

function successfulMutationRows(
  request: DBCoreMutateRequest,
  response: DBCoreMutateResponse,
  rows: readonly Record<string, unknown>[]
) {
  if (request.type === 'deleteRange') {
    return response.numFailures === 0 ? rows : []
  }
  return rows.filter((_row, index) => !Object.prototype.hasOwnProperty.call(response.failures, index))
}

function buildSqliteMutations(
  tableName: LocalModeSqliteTableName,
  request: DBCoreMutateRequest,
  rows: readonly Record<string, unknown>[]
): LocalModeSqliteMutation[] {
  const type = request.type === 'add' || request.type === 'put' ? 'upsert' : 'delete'
  return rows.map((row) => ({
    type,
    tableName,
    row,
    workspaceId: getMutationWorkspaceId(tableName, row)
  }))
}

function getStringValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function getNullableStringValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  if (value === null) {
    return null
  }

  return typeof value === 'string' ? value : null
}

function getNumberValue(record: Record<string, unknown> | undefined, key: string, fallback: number) {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function getBooleanValue(record: Record<string, unknown> | undefined, key: string, fallback: boolean) {
  const value = record?.[key]
  return typeof value === 'boolean' ? value : fallback
}

function getCurrencyCodeValue(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: (typeof SUPPORTED_CURRENCIES)[number]
) {
  const value = getStringValue(record, key)?.toLowerCase()
  return value && SUPPORTED_CURRENCIES.includes(value as (typeof SUPPORTED_CURRENCIES)[number])
    ? (value as (typeof SUPPORTED_CURRENCIES)[number])
    : fallback
}

function getAdjustmentReason(record: Record<string, unknown> | undefined) {
  const reason = getStringValue(record, 'reason') ?? getStringValue(record, 'adjustmentReason')
  return reason && STOCK_ADJUSTMENT_REASONS.includes(reason as (typeof STOCK_ADJUSTMENT_REASONS)[number])
    ? reason
    : 'correction'
}

function buildInventoryTransactionFromStockAdjustmentRecord(
  adjustmentRecord: Record<string, unknown>,
  existingTransactionRecord?: Record<string, unknown>
) {
  const id = getStringValue(adjustmentRecord, 'id')
  const workspaceId =
    getStringValue(adjustmentRecord, 'workspaceId') ?? getStringValue(existingTransactionRecord, 'workspaceId')
  const productId =
    getStringValue(adjustmentRecord, 'productId') ?? getStringValue(existingTransactionRecord, 'productId')
  const storageId =
    getStringValue(adjustmentRecord, 'storageId') ?? getStringValue(existingTransactionRecord, 'storageId')

  if (!id || !workspaceId || !productId || !storageId) {
    return null
  }

  const quantity = Math.max(
    0,
    getNumberValue(
      adjustmentRecord,
      'quantity',
      Math.abs(getNumberValue(existingTransactionRecord, 'quantityDelta', 0))
    )
  )
  const adjustmentType = getStringValue(adjustmentRecord, 'adjustmentType')
  const quantityDelta = adjustmentType === 'decrease' ? -quantity : quantity
  const createdAt =
    getStringValue(adjustmentRecord, 'createdAt') ??
    getStringValue(existingTransactionRecord, 'createdAt') ??
    new Date().toISOString()
  const updatedAt =
    getStringValue(adjustmentRecord, 'updatedAt') ?? getStringValue(existingTransactionRecord, 'updatedAt') ?? createdAt
  const version = Math.max(
    getNumberValue(existingTransactionRecord, 'version', 1),
    getNumberValue(adjustmentRecord, 'version', 1)
  )
  const previousQuantity = getNumberValue(
    adjustmentRecord,
    'previousQuantity',
    getNumberValue(existingTransactionRecord, 'previousQuantity', 0)
  )

  return {
    ...(existingTransactionRecord ?? {}),
    id,
    workspaceId,
    productId,
    storageId,
    transactionType: 'stock_adjustment',
    quantityDelta,
    previousQuantity,
    newQuantity: getNumberValue(
      adjustmentRecord,
      'newQuantity',
      getNumberValue(existingTransactionRecord, 'newQuantity', previousQuantity + quantityDelta)
    ),
    adjustmentReason: getAdjustmentReason(adjustmentRecord),
    referenceId: id,
    referenceType: 'stock_adjustment',
    notes:
      getNullableStringValue(adjustmentRecord, 'notes') ?? getNullableStringValue(existingTransactionRecord, 'notes'),
    createdBy:
      getNullableStringValue(adjustmentRecord, 'createdBy') ??
      getNullableStringValue(existingTransactionRecord, 'createdBy'),
    createdAt,
    updatedAt,
    version,
    isDeleted: getBooleanValue(
      adjustmentRecord,
      'isDeleted',
      getBooleanValue(existingTransactionRecord, 'isDeleted', false)
    ),
    syncStatus:
      getStringValue(adjustmentRecord, 'syncStatus') ??
      getStringValue(existingTransactionRecord, 'syncStatus') ??
      'synced',
    lastSyncedAt:
      getNullableStringValue(adjustmentRecord, 'lastSyncedAt') ??
      getNullableStringValue(existingTransactionRecord, 'lastSyncedAt') ??
      null
  }
}

function normalizeStockAdjustmentInventoryTransactionRecord(
  transactionRecord: Record<string, unknown>,
  canonicalId?: string | null
) {
  const id = canonicalId ?? getStringValue(transactionRecord, 'id')
  const workspaceId = getStringValue(transactionRecord, 'workspaceId')
  const productId = getStringValue(transactionRecord, 'productId')
  const storageId = getStringValue(transactionRecord, 'storageId')
  const quantityDelta = getNumberValue(transactionRecord, 'quantityDelta', 0)

  if (!id || !workspaceId || !productId || !storageId || quantityDelta === 0) {
    return null
  }

  const createdAt = getStringValue(transactionRecord, 'createdAt') ?? new Date().toISOString()
  const previousQuantity = getNumberValue(transactionRecord, 'previousQuantity', 0)

  return {
    ...transactionRecord,
    id,
    workspaceId,
    productId,
    storageId,
    transactionType: 'stock_adjustment',
    quantityDelta,
    previousQuantity,
    newQuantity: getNumberValue(transactionRecord, 'newQuantity', previousQuantity + quantityDelta),
    adjustmentReason: getAdjustmentReason(transactionRecord),
    referenceId: id,
    referenceType: 'stock_adjustment',
    notes: getNullableStringValue(transactionRecord, 'notes'),
    createdBy: getNullableStringValue(transactionRecord, 'createdBy'),
    createdAt,
    updatedAt: getStringValue(transactionRecord, 'updatedAt') ?? createdAt,
    version: getNumberValue(transactionRecord, 'version', 1),
    isDeleted: getBooleanValue(transactionRecord, 'isDeleted', false),
    syncStatus: getStringValue(transactionRecord, 'syncStatus') ?? 'synced',
    lastSyncedAt: getNullableStringValue(transactionRecord, 'lastSyncedAt') ?? null
  }
}

// Atlas Database using Dexie.js for IndexedDB
export class AtlasDatabase extends Dexie {
  products!: EntityTable<Product, 'id'>
  product_barcodes!: EntityTable<ProductBarcode, 'id'>
  price_books!: EntityTable<PriceBook, 'id'>
  price_book_items!: EntityTable<PriceBookItem, 'id'>
  categories!: EntityTable<Category, 'id'>
  units!: EntityTable<Unit, 'id'>
  invoices!: EntityTable<Invoice, 'id'>
  invoice_versions!: EntityTable<InvoiceVersion, 'id'>
  users!: EntityTable<User, 'id'>
  sales!: EntityTable<Sale, 'id'>
  sales_exchange!: EntityTable<SalesExchange, 'id'>
  sale_items!: EntityTable<SaleItem, 'id'>
  sale_returns!: EntityTable<SaleReturn, 'id'>
  sale_return_items!: EntityTable<SaleReturnItem, 'id'>
  sale_product_exchanges!: EntityTable<SaleProductExchange, 'id'>
  order_returns!: EntityTable<OrderReturn, 'id'>
  order_return_items!: EntityTable<OrderReturnItem, 'id'>
  workspaces!: EntityTable<Workspace, 'id'>
  storages!: EntityTable<Storage, 'id'>
  inventory!: EntityTable<Inventory, 'id'>
  inventory_transactions!: EntityTable<InventoryTransaction, 'id'>
  stock_batches!: EntityTable<StockBatch, 'id'>
  product_discounts!: EntityTable<ProductDiscount, 'id'>
  category_discounts!: EntityTable<CategoryDiscount, 'id'>
  inventory_transfer_transactions!: EntityTable<InventoryTransferTransaction, 'id'>
  reorder_transfer_rules!: EntityTable<ReorderTransferRule, 'id'>
  suppliers!: EntityTable<Supplier, 'id'>
  customers!: EntityTable<Customer, 'id'>
  agents!: EntityTable<Agent, 'id'>
  agent_excluded_categories!: EntityTable<AgentExcludedCategory, 'id'>
  agent_commission_plans!: EntityTable<AgentCommissionPlan, 'id'>
  agent_commission_memberships!: EntityTable<AgentCommissionMembership, 'id'>
  product_commission_rules!: EntityTable<ProductCommissionRule, 'id'>
  product_commission_rule_agents!: EntityTable<ProductCommissionRuleAgent, 'id'>
  sales_order_agent_assignments!: EntityTable<SalesOrderAgentAssignment, 'id'>
  agent_commission_entries!: EntityTable<AgentCommissionEntry, 'id'>
  agent_product_commission_entries!: EntityTable<AgentProductCommissionEntry, 'id'>
  fleet_vehicles!: EntityTable<FleetVehicle, 'id'>
  fleet_vehicle_assignments!: EntityTable<FleetVehicleAssignment, 'id'>
  rental_vehicles!: EntityTable<RentalVehicle, 'id'>
  rental_requests!: EntityTable<RentalRequest, 'id'>
  rental_contracts!: EntityTable<RentalContract, 'id'>
  delivery_merchant_profiles!: EntityTable<DeliveryMerchantProfile, 'id'>
  delivery_shipments!: EntityTable<DeliveryShipment, 'id'>
  delivery_shipment_events!: EntityTable<DeliveryShipmentEvent, 'id'>
  delivery_shipment_cod_adjustment_requests!: EntityTable<DeliveryShipmentCodAdjustmentRequest, 'id'>
  delivery_shipment_cod_corrections!: EntityTable<DeliveryShipmentCodCorrection, 'id'>
  delivery_shipment_recipient_payout_corrections!: EntityTable<DeliveryShipmentRecipientPayoutCorrection, 'id'>
  delivery_shipment_recipient_payout_adjustment_requests!: EntityTable<
    DeliveryShipmentRecipientPayoutAdjustmentRequest,
    'id'
  >
  delivery_runs!: EntityTable<DeliveryRun, 'id'>
  delivery_run_items!: EntityTable<DeliveryRunItem, 'id'>
  delivery_settlements!: EntityTable<DeliverySettlement, 'id'>
  delivery_ledger_entries!: EntityTable<DeliveryLedgerEntry, 'id'>
  business_partners!: EntityTable<BusinessPartner, 'id'>
  business_partner_merge_candidates!: EntityTable<BusinessPartnerMergeCandidate, 'id'>
  employees!: EntityTable<Employee, 'id'>
  budget_settings!: EntityTable<BudgetSettings, 'id'>
  budget_allocations!: EntityTable<BudgetAllocation, 'id'>
  expense_categories!: EntityTable<ExpenseCategory, 'id'>
  expense_series!: EntityTable<ExpenseSeries, 'id'>
  expense_items!: EntityTable<ExpenseItem, 'id'>
  payroll_statuses!: EntityTable<PayrollStatus, 'id'>
  dividend_statuses!: EntityTable<DividendStatus, 'id'>
  syncQueue!: EntityTable<SyncQueueItem, 'id'>
  offline_mutations!: EntityTable<OfflineMutation, 'id'>
  app_settings!: EntityTable<AppSetting, 'key'>
  workspace_contacts!: EntityTable<WorkspaceContact, 'id'>
  restaurant_table_settings!: EntityTable<RestaurantTableSettings, 'id'>
  restaurant_pos_tickets!: EntityTable<RestaurantPosTicket, 'id'>
  loans!: EntityTable<Loan, 'id'>
  loan_installments!: EntityTable<LoanInstallment, 'id'>
  loan_payments!: EntityTable<LoanPayment, 'id'>
  installment_sales!: EntityTable<InstallmentSale, 'id'>
  installment_sale_installments!: EntityTable<InstallmentSaleInstallment, 'id'>
  installment_sale_payments!: EntityTable<InstallmentSalePayment, 'id'>
  payment_transactions!: EntityTable<PaymentTransaction, 'id'>
  financial_transaction_voids!: EntityTable<FinancialTransactionVoid, 'id'>
  payment_accounts!: EntityTable<PaymentAccount, 'id'>
  capital_pools!: EntityTable<CapitalPool, 'id'>
  payment_account_balances!: EntityTable<PaymentAccountBalance, 'id'>
  payment_account_movements!: EntityTable<PaymentAccountMovement, 'id'>
  cashier_shifts!: EntityTable<CashierShift, 'id'>
  cashier_shift_currency_counts!: EntityTable<CashierShiftCurrencyCount, 'id'>
  cashier_shift_templates!: EntityTable<CashierShiftTemplate, 'id'>
  cashier_shift_assignments!: EntityTable<CashierShiftAssignment, 'id'>
  cashier_shift_occurrences!: EntityTable<CashierShiftOccurrence, 'id'>
  cashier_shift_pause_requests!: EntityTable<CashierShiftPauseRequest, 'id'>
  cashier_shift_pause_periods!: EntityTable<CashierShiftPausePeriod, 'id'>
  sales_orders!: EntityTable<SalesOrder, 'id'>
  purchase_orders!: EntityTable<PurchaseOrder, 'id'>
  order_installments!: EntityTable<OrderInstallment, 'id'>
  real_estate_transactions!: EntityTable<RealEstateTransaction, 'id'>
  real_estate_installments!: EntityTable<RealEstateInstallment, 'id'>
  real_estate_payments!: EntityTable<RealEstatePayment, 'id'>
  travel_bookings!: EntityTable<TravelBooking, 'id'>
  travel_passengers!: EntityTable<TravelPassenger, 'id'>
  activity_catalog!: EntityTable<ActivityCatalogItem, 'id'>
  activity_transactions!: EntityTable<ActivityTransaction, 'id'>
  activity_transaction_lines!: EntityTable<ActivityTransactionLine, 'id'>
  exchange_pair_prices!: EntityTable<ExchangePairPrice, 'id'>
  exchange_transactions!: EntityTable<ExchangeTransaction, 'id'>
  exchange_fee_rules!: EntityTable<ExchangeFeeRule, 'id'>
  fx_safes!: EntityTable<ExchangeSafe, 'id'>
  fx_safe_balances!: EntityTable<ExchangeSafeBalance, 'id'>
  fx_safe_movements!: EntityTable<ExchangeSafeMovement, 'id'>
  clinical_appointments!: EntityTable<ClinicalAppointment, 'id'>
  clinical_patients!: EntityTable<ClinicalPatient, 'id'>
  clinical_attachments!: EntityTable<ClinicalAttachment, 'id'>
  clinical_presets!: EntityTable<ClinicalPreset, 'id'>
  profiles!: EntityTable<Profile, 'id'>
  local_account_credentials!: EntityTable<LocalAccountCredential, 'id'>
  module_locker_settings!: EntityTable<ModuleLockerSettings, 'id'>
  module_locker_locks!: EntityTable<ModuleLockerLock, 'id'>
  module_locker_audit!: EntityTable<ModuleLockerAuditEvent, 'id'>
  workspace_permissions!: EntityTable<WorkspacePermission, 'id'>
  manual_entry_templates!: EntityTable<ManualEntryTemplate, 'id'>
  manual_entries!: EntityTable<ManualEntry, 'id'>

  constructor(databaseName = 'AtlasDatabase') {
    super(databaseName)

    // Version 38 combines two parallel migration intents: invoice PDF metadata
    // indexes and the budget/expense/payroll/dividend local tables. Keep this
    // as a single declaration because Dexie versions must be unique, while the
    // upgrade clears queued mutations for the retired budget/expense entities.
    this.version(38)
      .stores({
        products:
          'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
        categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
        invoices:
          'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt, fileSize, fileMimeType',

        users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
        sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
        sale_items: 'id, saleId, productId',
        workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
        storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
        employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
        budget_settings: 'id, workspaceId',
        budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
        expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
        expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
        payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        syncQueue: 'id, entityType, entityId, operation, timestamp',
        offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
        workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
        loans: 'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, syncStatus, updatedAt, isDeleted',
        loan_installments:
          'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
        loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
        app_settings: 'key'
      })
      .upgrade((tx) =>
        Promise.all([
          tx.table('offline_mutations').where('entityType').anyOf(['budget_allocations', 'expenses']).delete(),
          tx.table('syncQueue').where('entityType').anyOf(['budget_allocations', 'expenses']).delete()
        ])
      )

    this.version(39).stores({
      budget_allocations: 'id, workspaceId, month, [workspaceId+month]'
    })

    this.version(40)
      .stores({
        budget_allocations: 'id, workspaceId, month, [workspaceId+month]'
      })
      .upgrade(async (tx) => {
        const allocations = await tx.table('budget_allocations').toArray()
        for (const alloc of allocations) {
          if (alloc.limitAmount !== undefined && alloc.allocationValue === undefined) {
            await tx.table('budget_allocations').update(alloc.id, {
              allocationType: alloc.allocationType || 'fixed',
              allocationValue: alloc.limitAmount
            })
          }
        }
      })

    this.version(41).stores({
      products:
        'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
      categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
      invoices:
        'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
      users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
      sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
      sale_items: 'id, saleId, productId',
      workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
      storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
      suppliers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
      customers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
      employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
      budget_settings: 'id, workspaceId',
      budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
      expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
      expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
      payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
      dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
      syncQueue: 'id, entityType, entityId, operation, timestamp',
      offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
      workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
      loans: 'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, syncStatus, updatedAt, isDeleted',
      loan_installments:
        'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
      loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
      sales_orders:
        'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
      purchase_orders:
        'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
      app_settings: 'key'
    })

    this.version(42)
      .stores({
        products:
          'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
        categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
        invoices:
          'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
        users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
        sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
        sale_items: 'id, saleId, productId',
        workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
        storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
        inventory:
          'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
        suppliers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        customers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
        budget_settings: 'id, workspaceId',
        budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
        expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
        expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
        payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        syncQueue: 'id, entityType, entityId, operation, timestamp',
        offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
        workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
        loans: 'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, syncStatus, updatedAt, isDeleted',
        loan_installments:
          'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
        loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
        sales_orders:
          'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
        purchase_orders:
          'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
        app_settings: 'key'
      })
      .upgrade(async (tx) => {
        const products = await tx.table('products').toArray()
        const inventoryRows = products
          .filter((product) => typeof product.storageId === 'string' && product.storageId.length > 0)
          .map((product) => ({
            id: `${product.id}:${product.storageId}`,
            workspaceId: product.workspaceId,
            productId: product.id,
            storageId: product.storageId,
            quantity: typeof product.quantity === 'number' ? product.quantity : 0,
            createdAt: product.createdAt,
            updatedAt: product.updatedAt,
            syncStatus: product.syncStatus,
            lastSyncedAt: product.lastSyncedAt,
            version: product.version,
            isDeleted: product.isDeleted
          }))

        if (inventoryRows.length > 0) {
          await tx.table('inventory').bulkPut(inventoryRows)
        }
      })

    this.version(43).stores({
      products:
        'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
      categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
      invoices:
        'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
      users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
      sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
      sale_items: 'id, saleId, productId',
      workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
      storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
      inventory:
        'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
      suppliers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
      customers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
      employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
      budget_settings: 'id, workspaceId',
      budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
      expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
      expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
      payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
      dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
      syncQueue: 'id, entityType, entityId, operation, timestamp',
      offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
      workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
      loans:
        'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted',
      loan_installments:
        'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
      loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
      sales_orders:
        'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
      purchase_orders:
        'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
      app_settings: 'key'
    })

    this.version(44)
      .stores({
        products:
          'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
        categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
        invoices:
          'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
        users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
        sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
        sale_items: 'id, saleId, productId',
        workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
        storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
        inventory:
          'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
        suppliers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        customers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
        budget_settings: 'id, workspaceId',
        budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
        expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
        expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
        payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        syncQueue: 'id, entityType, entityId, operation, timestamp',
        offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
        workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
        loans:
          'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted',
        loan_installments:
          'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
        loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
        sales_orders:
          'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
        purchase_orders:
          'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
        app_settings: 'key'
      })
      .upgrade(async (tx) => {
        await tx.table('loans').where('linkedPartyType').equals('supplier').modify({
          linkedPartyType: null,
          linkedPartyId: null,
          linkedPartyName: null
        })
      })

    this.version(45).stores({
      products:
        'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
      categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
      invoices:
        'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
      users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
      sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
      sale_items: 'id, saleId, productId',
      workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
      storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
      inventory:
        'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
      reorder_transfer_rules:
        'id, workspaceId, productId, sourceStorageId, destinationStorageId, isIndefinite, expiresOn, updatedAt, isDeleted, [workspaceId+productId], [workspaceId+destinationStorageId], [workspaceId+expiresOn]',
      suppliers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
      customers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
      employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
      budget_settings: 'id, workspaceId',
      budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
      expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
      expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
      payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
      dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
      syncQueue: 'id, entityType, entityId, operation, timestamp',
      offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
      workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
      loans:
        'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted',
      loan_installments:
        'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
      loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
      sales_orders:
        'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
      purchase_orders:
        'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
      app_settings: 'key'
    })

    this.version(46).stores({
      products:
        'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
      categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
      invoices:
        'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
      users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
      sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
      sale_items: 'id, saleId, productId',
      workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
      storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
      inventory:
        'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
      inventory_transfer_transactions:
        'id, workspaceId, productId, sourceStorageId, destinationStorageId, transferType, createdAt, isDeleted, [workspaceId+createdAt], [workspaceId+productId], [workspaceId+transferType]',
      reorder_transfer_rules:
        'id, workspaceId, productId, sourceStorageId, destinationStorageId, isIndefinite, expiresOn, updatedAt, isDeleted, [workspaceId+productId], [workspaceId+destinationStorageId], [workspaceId+expiresOn]',
      suppliers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
      customers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
      employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
      budget_settings: 'id, workspaceId',
      budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
      expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
      expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
      payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
      dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
      syncQueue: 'id, entityType, entityId, operation, timestamp',
      offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
      workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
      loans:
        'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted',
      loan_installments:
        'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
      loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
      sales_orders:
        'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
      purchase_orders:
        'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
      app_settings: 'key'
    })

    this.version(47).stores({
      products:
        'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
      categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
      invoices:
        'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
      users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
      sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
      sale_items: 'id, saleId, productId',
      workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
      storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
      inventory:
        'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
      inventory_transfer_transactions:
        'id, workspaceId, productId, sourceStorageId, destinationStorageId, transferType, createdAt, isDeleted, [workspaceId+createdAt], [workspaceId+productId], [workspaceId+transferType]',
      reorder_transfer_rules:
        'id, workspaceId, productId, sourceStorageId, destinationStorageId, isIndefinite, expiresOn, updatedAt, isDeleted, [workspaceId+productId], [workspaceId+destinationStorageId], [workspaceId+expiresOn]',
      suppliers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
      customers: 'id, name, workspaceId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
      employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
      budget_settings: 'id, workspaceId',
      budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
      expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
      expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
      payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
      dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
      syncQueue: 'id, entityType, entityId, operation, timestamp',
      offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
      workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
      loans:
        'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted',
      loan_installments:
        'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
      loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
      sales_orders:
        'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
      purchase_orders:
        'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
      app_settings: 'key'
    })

    this.version(48)
      .stores({
        products:
          'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
        categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
        invoices:
          'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
        users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
        sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
        sale_items: 'id, saleId, productId',
        workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
        storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
        inventory:
          'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
        inventory_transfer_transactions:
          'id, workspaceId, productId, sourceStorageId, destinationStorageId, transferType, createdAt, isDeleted, [workspaceId+createdAt], [workspaceId+productId], [workspaceId+transferType]',
        reorder_transfer_rules:
          'id, workspaceId, productId, sourceStorageId, destinationStorageId, isIndefinite, expiresOn, updatedAt, isDeleted, [workspaceId+productId], [workspaceId+destinationStorageId], [workspaceId+expiresOn]',
        suppliers:
          'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        customers:
          'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        business_partners:
          'id, name, workspaceId, role, customerFacetId, supplierFacetId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId',
        business_partner_merge_candidates:
          'id, workspaceId, primaryPartnerId, secondaryPartnerId, status, confidence, updatedAt, syncStatus, isDeleted',
        employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
        budget_settings: 'id, workspaceId',
        budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
        expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
        expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
        payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        syncQueue: 'id, entityType, entityId, operation, timestamp',
        offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
        workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
        loans:
          'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted',
        loan_installments:
          'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
        loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
        sales_orders:
          'id, orderNumber, businessPartnerId, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
        purchase_orders:
          'id, orderNumber, businessPartnerId, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
        app_settings: 'key'
      })
      .upgrade(async (tx) => {
        const now = new Date().toISOString()
        const customers = await tx.table('customers').toArray()
        const suppliers = await tx.table('suppliers').toArray()
        const existingPartners = await tx
          .table('business_partners')
          .toArray()
          .catch(() => [])
        const existingMergeCandidates = await tx
          .table('business_partner_merge_candidates')
          .toArray()
          .catch(() => [])
        const partnerMap = new Map<string, Record<string, unknown>>(
          existingPartners.map((partner: Record<string, unknown>) => [String(partner.id), partner])
        )
        const customerPartnerIdByFacetId = new Map<string, string>()
        const supplierPartnerIdByFacetId = new Map<string, string>()

        const buildPartnerBase = (
          facet: Record<string, unknown>,
          partnerId: string,
          role: 'customer' | 'supplier'
        ) => ({
          id: partnerId,
          workspaceId: facet.workspaceId,
          // This v48 migration predates `partnerName`. Preserve the raw
          // legacy attributes so v111 can derive the canonical field while
          // retaining the original values as historical metadata.
          name: facet.name,
          contactName: role === 'supplier' ? facet.contactName : undefined,
          phone: facet.phone,
          address: facet.address,
          city: facet.city,
          defaultCurrency: facet.defaultCurrency || 'usd',
          notes: facet.notes,
          role,
          creditLimit: Number(facet.creditLimit || 0),
          customerFacetId: role === 'customer' ? facet.id : null,
          supplierFacetId: role === 'supplier' ? facet.id : null,
          totalSalesOrders: 0,
          totalSalesValue: 0,
          receivableBalance: 0,
          totalPurchaseOrders: 0,
          totalPurchaseValue: 0,
          payableBalance: 0,
          totalLoanCount: 0,
          loanOutstandingBalance: 0,
          netExposure: 0,
          mergedIntoBusinessPartnerId: null,
          createdAt: facet.createdAt || now,
          updatedAt: facet.updatedAt || now,
          syncStatus: facet.syncStatus || 'pending',
          lastSyncedAt: facet.lastSyncedAt || null,
          version: Number(facet.version || 1),
          isDeleted: Boolean(facet.isDeleted)
        })

        for (const customer of customers as Array<Record<string, unknown>>) {
          const facetId = String(customer.id)
          const partnerId =
            typeof customer.businessPartnerId === 'string' && customer.businessPartnerId
              ? customer.businessPartnerId
              : facetId

          customer.businessPartnerId = partnerId
          customerPartnerIdByFacetId.set(facetId, partnerId)
          if (!partnerMap.has(partnerId)) {
            partnerMap.set(partnerId, buildPartnerBase(customer, partnerId, 'customer'))
          }
        }

        for (const supplier of suppliers as Array<Record<string, unknown>>) {
          const facetId = String(supplier.id)
          const partnerId =
            typeof supplier.businessPartnerId === 'string' && supplier.businessPartnerId
              ? supplier.businessPartnerId
              : facetId

          supplier.businessPartnerId = partnerId
          supplierPartnerIdByFacetId.set(facetId, partnerId)
          if (!partnerMap.has(partnerId)) {
            partnerMap.set(partnerId, buildPartnerBase(supplier, partnerId, 'supplier'))
          }
        }

        await tx.table('customers').bulkPut(customers)
        await tx.table('suppliers').bulkPut(suppliers)
        await tx.table('business_partners').bulkPut(Array.from(partnerMap.values()))

        const salesOrders = await tx.table('sales_orders').toArray()
        for (const order of salesOrders as Array<Record<string, unknown>>) {
          if (!order.businessPartnerId && typeof order.customerId === 'string') {
            order.businessPartnerId = customerPartnerIdByFacetId.get(order.customerId) || null
          }
        }
        if (salesOrders.length > 0) {
          await tx.table('sales_orders').bulkPut(salesOrders)
        }

        const purchaseOrders = await tx.table('purchase_orders').toArray()
        for (const order of purchaseOrders as Array<Record<string, unknown>>) {
          if (!order.businessPartnerId && typeof order.supplierId === 'string') {
            order.businessPartnerId = supplierPartnerIdByFacetId.get(order.supplierId) || null
          }
        }
        if (purchaseOrders.length > 0) {
          await tx.table('purchase_orders').bulkPut(purchaseOrders)
        }

        const loans = await tx.table('loans').toArray()
        for (const loan of loans as Array<Record<string, unknown>>) {
          if (loan.linkedPartyType === 'customer' && typeof loan.linkedPartyId === 'string') {
            loan.linkedPartyType = 'business_partner'
            loan.linkedPartyId = customerPartnerIdByFacetId.get(loan.linkedPartyId) || null
          }
        }
        if (loans.length > 0) {
          await tx.table('loans').bulkPut(loans)
        }

        const normalizeValue = (value: unknown) =>
          String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim()
        const candidateMap = new Map<string, Record<string, unknown>>(
          existingMergeCandidates.map((candidate: Record<string, unknown>) => [String(candidate.id), candidate])
        )

        for (const customer of customers as Array<Record<string, unknown>>) {
          const customerPartnerId = customerPartnerIdByFacetId.get(String(customer.id))
          if (!customerPartnerId) {
            continue
          }
          // This v48 migration runs before `partnerName` exists. The legacy
          // value is read only to identify records that must be migrated.
          const customerName = normalizeValue(customer.name)
          const customerPhone = normalizeValue(customer.phone)

          for (const supplier of suppliers as Array<Record<string, unknown>>) {
            const supplierPartnerId = supplierPartnerIdByFacetId.get(String(supplier.id))
            if (!supplierPartnerId || customer.workspaceId !== supplier.workspaceId) {
              continue
            }

            const supplierName = normalizeValue(supplier.name)
            const supplierPhone = normalizeValue(supplier.phone)
            const exactName = customerName && customerName === supplierName
            const phoneMatch = customerPhone && customerPhone === supplierPhone

            if (!exactName && !phoneMatch) {
              continue
            }

            const confidence = exactName && phoneMatch ? 0.98 : exactName ? 0.86 : 0.78
            const candidateId = `${customerPartnerId}:${supplierPartnerId}`
            if (candidateMap.has(candidateId)) {
              continue
            }

            const reasons = [exactName ? 'matching name' : '', phoneMatch ? 'matching phone' : ''].filter(Boolean)

            candidateMap.set(candidateId, {
              id: candidateId,
              workspaceId: customer.workspaceId,
              primaryPartnerId: customerPartnerId,
              secondaryPartnerId: supplierPartnerId,
              mergeType: 'customer_supplier',
              reason: reasons.join(', '),
              confidence,
              status: 'pending',
              createdAt: now,
              updatedAt: now,
              syncStatus: 'pending',
              lastSyncedAt: null,
              version: 1,
              isDeleted: false
            })
          }
        }

        if (candidateMap.size > 0) {
          await tx.table('business_partner_merge_candidates').bulkPut(Array.from(candidateMap.values()))
        }
      })

    this.version(49)
      .stores({
        products:
          'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
        categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
        invoices:
          'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
        users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
        sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
        sale_items: 'id, saleId, productId',
        workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
        storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
        inventory:
          'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
        inventory_transfer_transactions:
          'id, workspaceId, productId, sourceStorageId, destinationStorageId, transferType, createdAt, isDeleted, [workspaceId+createdAt], [workspaceId+productId], [workspaceId+transferType]',
        reorder_transfer_rules:
          'id, workspaceId, productId, sourceStorageId, destinationStorageId, isIndefinite, expiresOn, updatedAt, isDeleted, [workspaceId+productId], [workspaceId+destinationStorageId], [workspaceId+expiresOn]',
        suppliers:
          'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        customers:
          'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        business_partners:
          'id, name, workspaceId, role, customerFacetId, supplierFacetId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId',
        business_partner_merge_candidates:
          'id, workspaceId, primaryPartnerId, secondaryPartnerId, status, confidence, updatedAt, syncStatus, isDeleted',
        employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
        budget_settings: 'id, workspaceId',
        budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
        expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
        expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
        payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        syncQueue: 'id, entityType, entityId, operation, timestamp',
        offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
        workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
        loans:
          'id, workspaceId, saleId, loanCategory, direction, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted, [workspaceId+loanCategory], [workspaceId+direction]',
        loan_installments:
          'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
        loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
        sales_orders:
          'id, orderNumber, businessPartnerId, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
        purchase_orders:
          'id, orderNumber, businessPartnerId, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
        app_settings: 'key'
      })
      .upgrade(async (tx) => {
        const loans = await tx.table('loans').toArray()
        if (loans.length === 0) {
          return
        }

        for (const loan of loans as Array<Record<string, unknown>>) {
          if (loan.loanCategory !== 'simple' && loan.loanCategory !== 'standard') {
            loan.loanCategory = 'standard'
          }
          if (loan.direction !== 'borrowed' && loan.direction !== 'lent') {
            loan.direction = 'lent'
          }
        }

        await tx.table('loans').bulkPut(loans)
      })

    this.version(50)
      .stores({
        products:
          'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
        categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
        invoices:
          'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
        users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
        sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
        sale_items: 'id, saleId, productId',
        workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
        storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
        inventory:
          'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
        inventory_transfer_transactions:
          'id, workspaceId, productId, sourceStorageId, destinationStorageId, transferType, createdAt, isDeleted, [workspaceId+createdAt], [workspaceId+productId], [workspaceId+transferType]',
        reorder_transfer_rules:
          'id, workspaceId, productId, sourceStorageId, destinationStorageId, isIndefinite, expiresOn, updatedAt, isDeleted, [workspaceId+productId], [workspaceId+destinationStorageId], [workspaceId+expiresOn]',
        suppliers:
          'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        customers:
          'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        business_partners:
          'id, name, workspaceId, role, customerFacetId, supplierFacetId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId',
        business_partner_merge_candidates:
          'id, workspaceId, primaryPartnerId, secondaryPartnerId, status, confidence, updatedAt, syncStatus, isDeleted',
        employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
        budget_settings: 'id, workspaceId',
        budget_allocations: 'id, workspaceId, month, [workspaceId+month]',
        expense_series: 'id, workspaceId, recurrence, startMonth, endMonth, isDeleted',
        expense_items: 'id, workspaceId, seriesId, month, dueDate, status, [seriesId+month], [workspaceId+month]',
        payroll_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        dividend_statuses: 'id, workspaceId, employeeId, month, status, [employeeId+month], [workspaceId+month]',
        syncQueue: 'id, entityType, entityId, operation, timestamp',
        offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
        workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
        loans:
          'id, workspaceId, saleId, loanCategory, direction, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted, [workspaceId+loanCategory], [workspaceId+direction]',
        loan_installments:
          'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
        loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
        payment_transactions:
          'id, workspaceId, paidAt, sourceModule, sourceType, sourceRecordId, sourceSubrecordId, direction, reversalOfTransactionId, updatedAt, isDeleted, syncStatus, [workspaceId+paidAt], [workspaceId+sourceType+sourceRecordId]',
        sales_orders:
          'id, orderNumber, businessPartnerId, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
        purchase_orders:
          'id, orderNumber, businessPartnerId, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
        app_settings: 'key'
      })
      .upgrade(async (tx) => {
        const paymentTransactionsTable = tx.table('payment_transactions')
        const existingCount = await paymentTransactionsTable.count()
        if (existingCount > 0) {
          return
        }

        const now = new Date().toISOString()
        const [
          loans,
          loanPayments,
          salesOrders,
          purchaseOrders,
          expenseItems,
          expenseSeries,
          payrollStatuses,
          employees
        ] = await Promise.all([
          tx.table('loans').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('loan_payments').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('sales_orders').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('purchase_orders').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('expense_items').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('expense_series').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('payroll_statuses').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('employees').toArray() as Promise<Array<Record<string, unknown>>>
        ])

        const loanById = new Map(loans.map((loan) => [String(loan.id), loan]))
        const expenseSeriesById = new Map(expenseSeries.map((series) => [String(series.id), series]))
        const employeeById = new Map(employees.map((employee) => [String(employee.id), employee]))
        const rows: Array<Record<string, unknown>> = []

        const createRow = (input: Record<string, unknown>) => ({
          syncStatus: 'synced',
          lastSyncedAt: now,
          version: 1,
          isDeleted: false,
          createdAt: input.createdAt ?? now,
          updatedAt: input.updatedAt ?? input.createdAt ?? now,
          metadata: {
            backfilled: true,
            ...(typeof input.metadata === 'object' && input.metadata !== null
              ? (input.metadata as Record<string, unknown>)
              : {})
          },
          ...input
        })

        for (const loan of loans) {
          if (loan.isDeleted || loan.source !== 'manual') {
            continue
          }

          rows.push(
            createRow({
              id: crypto.randomUUID(),
              workspaceId: loan.workspaceId,
              sourceModule: 'loans',
              sourceType: 'loan_origination',
              sourceRecordId: loan.id,
              sourceSubrecordId: null,
              direction: loan.direction === 'borrowed' ? 'incoming' : 'outgoing',
              amount: loan.principalAmount ?? 0,
              currency: loan.settlementCurrency ?? 'usd',
              paymentMethod: 'unknown',
              paidAt: loan.createdAt ?? now,
              counterpartyName: loan.borrowerName ?? null,
              referenceLabel: loan.loanNo ?? null,
              note: loan.notes ?? null,
              createdBy: loan.createdBy ?? null,
              reversalOfTransactionId: null,
              createdAt: loan.createdAt ?? now,
              updatedAt: loan.updatedAt ?? loan.createdAt ?? now,
              metadata: {
                loanCategory: loan.loanCategory ?? 'standard',
                loanDirection: loan.direction ?? 'lent',
                origination: true
              }
            })
          )
        }

        for (const payment of loanPayments) {
          if (payment.isDeleted) {
            continue
          }

          const loan = loanById.get(String(payment.loanId))
          if (!loan) {
            continue
          }

          rows.push(
            createRow({
              id: payment.id,
              workspaceId: payment.workspaceId,
              sourceModule: 'loans',
              sourceType: loan.loanCategory === 'simple' ? 'simple_loan' : 'loan_payment',
              sourceRecordId: loan.id,
              sourceSubrecordId: payment.id,
              direction: loan.direction === 'borrowed' ? 'outgoing' : 'incoming',
              amount: payment.amount,
              currency: loan.settlementCurrency ?? 'usd',
              paymentMethod: payment.paymentMethod ?? 'unknown',
              paidAt: payment.paidAt,
              counterpartyName: loan.borrowerName ?? null,
              referenceLabel: loan.loanNo ?? null,
              note: payment.note ?? null,
              createdBy: payment.createdBy ?? null,
              reversalOfTransactionId: null,
              createdAt: payment.createdAt ?? payment.paidAt ?? now,
              updatedAt: payment.updatedAt ?? payment.createdAt ?? payment.paidAt ?? now,
              metadata: {
                loanPaymentId: payment.id,
                loanCategory: loan.loanCategory ?? 'standard',
                loanDirection: loan.direction ?? 'lent'
              }
            })
          )
        }

        for (const order of salesOrders) {
          if (order.isDeleted || !order.isPaid) {
            continue
          }

          rows.push(
            createRow({
              id: crypto.randomUUID(),
              workspaceId: order.workspaceId,
              sourceModule: 'orders',
              sourceType: 'sales_order',
              sourceRecordId: order.id,
              sourceSubrecordId: null,
              direction: 'incoming',
              amount: order.total ?? 0,
              currency: order.currency ?? 'usd',
              paymentMethod: order.paymentMethod ?? 'unknown',
              paidAt: order.paidAt ?? order.updatedAt ?? order.createdAt ?? now,
              counterpartyName: order.customerName ?? null,
              referenceLabel: order.orderNumber ?? null,
              note: null,
              createdBy: null,
              reversalOfTransactionId: null,
              createdAt: order.paidAt ?? order.updatedAt ?? order.createdAt ?? now,
              updatedAt: order.updatedAt ?? order.paidAt ?? order.createdAt ?? now,
              metadata: {
                orderStatus: order.status ?? 'draft'
              }
            })
          )
        }

        for (const order of purchaseOrders) {
          if (order.isDeleted || !order.isPaid) {
            continue
          }

          rows.push(
            createRow({
              id: crypto.randomUUID(),
              workspaceId: order.workspaceId,
              sourceModule: 'orders',
              sourceType: 'purchase_order',
              sourceRecordId: order.id,
              sourceSubrecordId: null,
              direction: 'outgoing',
              amount: order.total ?? 0,
              currency: order.currency ?? 'usd',
              paymentMethod: order.paymentMethod ?? 'unknown',
              paidAt: order.paidAt ?? order.updatedAt ?? order.createdAt ?? now,
              counterpartyName: order.supplierName ?? null,
              referenceLabel: order.orderNumber ?? null,
              note: null,
              createdBy: null,
              reversalOfTransactionId: null,
              createdAt: order.paidAt ?? order.updatedAt ?? order.createdAt ?? now,
              updatedAt: order.updatedAt ?? order.paidAt ?? order.createdAt ?? now,
              metadata: {
                orderStatus: order.status ?? 'draft'
              }
            })
          )
        }

        for (const item of expenseItems) {
          if (item.isDeleted || item.status !== 'paid') {
            continue
          }

          const series = expenseSeriesById.get(String(item.seriesId))
          rows.push(
            createRow({
              id: crypto.randomUUID(),
              workspaceId: item.workspaceId,
              sourceModule: 'budget',
              sourceType: 'expense_item',
              sourceRecordId: item.id,
              sourceSubrecordId: item.seriesId ?? null,
              direction: 'outgoing',
              amount: item.amount ?? 0,
              currency: item.currency ?? 'usd',
              paymentMethod: 'unknown',
              paidAt: item.paidAt ?? item.updatedAt ?? item.createdAt ?? now,
              counterpartyName: null,
              referenceLabel: series?.name ? String(series.name) : 'Expense',
              note: null,
              createdBy: null,
              reversalOfTransactionId: null,
              createdAt: item.paidAt ?? item.updatedAt ?? item.createdAt ?? now,
              updatedAt: item.updatedAt ?? item.paidAt ?? item.createdAt ?? now,
              metadata: {
                month: item.month ?? null,
                seriesId: item.seriesId ?? null,
                category: series?.category ?? null,
                subcategory: series?.subcategory ?? null
              }
            })
          )
        }

        for (const status of payrollStatuses) {
          if (status.isDeleted || status.status !== 'paid') {
            continue
          }

          const employee = employeeById.get(String(status.employeeId))
          rows.push(
            createRow({
              id: crypto.randomUUID(),
              workspaceId: status.workspaceId,
              sourceModule: 'budget',
              sourceType: 'payroll_status',
              sourceRecordId: status.id,
              sourceSubrecordId: status.employeeId ?? null,
              direction: 'outgoing',
              amount: employee?.salary ?? 0,
              currency: employee?.salaryCurrency ?? 'usd',
              paymentMethod: 'unknown',
              paidAt: status.paidAt ?? status.updatedAt ?? status.createdAt ?? now,
              counterpartyName: employee?.name ?? null,
              referenceLabel: employee?.name
                ? `${employee.name} • ${String(status.month ?? '')}`
                : String(status.month ?? 'Payroll'),
              note: null,
              createdBy: null,
              reversalOfTransactionId: null,
              createdAt: status.paidAt ?? status.updatedAt ?? status.createdAt ?? now,
              updatedAt: status.updatedAt ?? status.paidAt ?? status.createdAt ?? now,
              metadata: {
                employeeId: status.employeeId ?? null,
                month: status.month ?? null
              }
            })
          )
        }

        if (rows.length > 0) {
          await paymentTransactionsTable.bulkPut(rows)
        }
      })

    this.version(51)
      .stores({
        storages: 'id, name, workspaceId, isSystem, isProtected, isPrimary, syncStatus, updatedAt, isDeleted'
      })
      .upgrade(async (tx) => {
        const storageRows = (await tx.table('storages').toArray()) as Array<Record<string, unknown>>
        if (storageRows.length === 0) {
          return
        }

        const rowsByWorkspace = new Map<string, Array<Record<string, unknown>>>()
        for (const row of storageRows) {
          const workspaceId = String(row.workspaceId || '')
          if (!workspaceId) {
            row.isPrimary = false
            continue
          }

          const workspaceRows = rowsByWorkspace.get(workspaceId) ?? []
          workspaceRows.push(row)
          rowsByWorkspace.set(workspaceId, workspaceRows)
        }

        for (const workspaceRows of rowsByWorkspace.values()) {
          const activeRows = workspaceRows.filter((row) => !row.isDeleted)
          const primaryRow =
            activeRows.find((row) => row.isPrimary === true) ??
            activeRows.find(
              (row) =>
                row.isSystem === true &&
                String(row.name || '')
                  .trim()
                  .toLowerCase() === 'main'
            ) ??
            activeRows[0]

          for (const row of workspaceRows) {
            row.isPrimary = !!primaryRow && !row.isDeleted && row.id === primaryRow.id
          }
        }

        await tx.table('storages').bulkPut(storageRows)
      })

    this.version(52).stores({
      product_discounts:
        'id, workspaceId, productId, isActive, startsAt, endsAt, updatedAt, isDeleted, [workspaceId+productId]',
      category_discounts:
        'id, workspaceId, categoryId, isActive, startsAt, endsAt, updatedAt, isDeleted, [workspaceId+categoryId]'
    })

    this.version(53)
      .stores({
        product_barcodes:
          'id, productId, workspaceId, barcode, isPrimary, updatedAt, isDeleted, [workspaceId+barcode], [productId+isPrimary]'
      })
      .upgrade(async (tx) => {
        const now = new Date().toISOString()
        const barcodeTable = tx.table('product_barcodes')
        const products = (await tx.table('products').toArray()) as Array<Record<string, unknown>>
        const existingBarcodes = (await barcodeTable.toArray()) as Array<Record<string, unknown>>
        const activeBarcodeKeys = new Set(
          existingBarcodes
            .filter((row) => !row.isDeleted)
            .map((row) => `${String(row.workspaceId ?? '')}::${String(row.barcode ?? '')}`)
        )
        const barcodeRowsToInsert: Array<Record<string, unknown>> = []
        const productsToUpdate: Array<Record<string, unknown>> = []

        for (const product of products) {
          const workspaceId = String(product.workspaceId ?? '')
          const productId = String(product.id ?? '')
          const legacyBarcode = String(product.barcode ?? '').trim()
          if (!workspaceId || !productId) {
            continue
          }

          if (!legacyBarcode) {
            continue
          }

          const barcodeKey = `${workspaceId}::${legacyBarcode}`
          if (activeBarcodeKeys.has(barcodeKey)) {
            continue
          }

          barcodeRowsToInsert.push({
            id: crypto.randomUUID(),
            workspaceId,
            productId,
            barcode: legacyBarcode,
            label: undefined,
            isPrimary: true,
            createdAt: String(product.createdAt ?? now),
            updatedAt: String(product.updatedAt ?? product.createdAt ?? now),
            syncStatus: product.syncStatus ?? 'synced',
            lastSyncedAt: product.lastSyncedAt ?? null,
            version: typeof product.version === 'number' ? product.version : 1,
            isDeleted: false
          })
          productsToUpdate.push({
            ...product,
            barcode: legacyBarcode,
            barcodes: [legacyBarcode]
          })
          activeBarcodeKeys.add(barcodeKey)
        }

        if (barcodeRowsToInsert.length > 0) {
          await barcodeTable.bulkPut(barcodeRowsToInsert)
        }

        if (productsToUpdate.length > 0) {
          await tx.table('products').bulkPut(productsToUpdate)
        }
      })

    this.version(54).stores({
      stock_adjustments:
        'id, workspaceId, productId, storageId, adjustmentType, reason, createdAt, isDeleted, [workspaceId+productId], [workspaceId+createdAt]',
      inventory_transactions:
        'id, workspaceId, productId, storageId, transactionType, referenceId, createdAt, isDeleted, [workspaceId+productId], [workspaceId+createdAt], [workspaceId+transactionType]',
      stock_batches:
        'id, workspaceId, productId, storageId, batchNumber, expiryDate, isDeleted, [workspaceId+productId], [productId+storageId]'
    })

    this.version(55)
      .stores({
        stock_adjustments: null,
        inventory_transactions:
          'id, workspaceId, productId, storageId, transactionType, adjustmentReason, referenceId, createdAt, isDeleted, [workspaceId+productId], [workspaceId+createdAt], [workspaceId+transactionType], [workspaceId+adjustmentReason]',
        stock_batches:
          'id, workspaceId, productId, storageId, batchNumber, expiryDate, isDeleted, [workspaceId+productId], [productId+storageId]'
      })
      .upgrade(async (tx) => {
        const stockAdjustmentTable = tx.table('stock_adjustments')
        const inventoryTransactionTable = tx.table('inventory_transactions')
        const offlineMutationTable = tx.table('offline_mutations')
        const syncQueueTable = tx.table('syncQueue')

        const [stockAdjustmentRows, inventoryTransactionRows, offlineMutationRows, syncQueueRows] = await Promise.all([
          stockAdjustmentTable.toArray() as Promise<Array<Record<string, unknown>>>,
          inventoryTransactionTable.toArray() as Promise<Array<Record<string, unknown>>>,
          offlineMutationTable.toArray() as Promise<Array<Record<string, unknown>>>,
          syncQueueTable.toArray() as Promise<Array<Record<string, unknown>>>
        ])

        const stockAdjustmentIds = new Set(
          stockAdjustmentRows.map((row) => getStringValue(row, 'id')).filter((id): id is string => !!id)
        )

        const legacyTransactionByAdjustmentId = new Map<string, Record<string, unknown>>()
        for (const row of inventoryTransactionRows) {
          if (getStringValue(row, 'transactionType') !== 'stock_adjustment') {
            continue
          }

          const referenceId = getStringValue(row, 'referenceId')
          const rowId = getStringValue(row, 'id')
          if (referenceId && stockAdjustmentIds.has(referenceId)) {
            legacyTransactionByAdjustmentId.set(referenceId, row)
            continue
          }

          if (rowId && stockAdjustmentIds.has(rowId)) {
            legacyTransactionByAdjustmentId.set(rowId, row)
          }
        }

        for (const adjustmentRow of stockAdjustmentRows) {
          const adjustmentId = getStringValue(adjustmentRow, 'id')
          if (!adjustmentId) {
            continue
          }

          const legacyTransaction = legacyTransactionByAdjustmentId.get(adjustmentId)
          const canonicalTransaction = buildInventoryTransactionFromStockAdjustmentRecord(
            adjustmentRow,
            legacyTransaction
          )

          if (!canonicalTransaction) {
            continue
          }

          await inventoryTransactionTable.put(canonicalTransaction)

          const legacyTransactionId = getStringValue(legacyTransaction, 'id')
          if (legacyTransactionId && legacyTransactionId !== adjustmentId) {
            await inventoryTransactionTable.delete(legacyTransactionId)
          }
        }

        const convertedMutationIdsByAdjustmentId = new Map<string, string>()
        for (const mutationRow of offlineMutationRows) {
          if (getStringValue(mutationRow, 'entityType') !== 'stock_adjustments') {
            continue
          }

          const mutationId = getStringValue(mutationRow, 'id')
          const payload = mutationRow.payload as Record<string, unknown> | undefined
          const adjustmentId = getStringValue(payload, 'id') ?? getStringValue(mutationRow, 'entityId')

          if (!mutationId || !adjustmentId) {
            continue
          }

          const canonicalPayload = buildInventoryTransactionFromStockAdjustmentRecord(
            {
              ...(payload ?? {}),
              id: adjustmentId,
              workspaceId: getStringValue(payload, 'workspaceId') ?? getStringValue(mutationRow, 'workspaceId')
            },
            legacyTransactionByAdjustmentId.get(adjustmentId)
          )

          if (!canonicalPayload) {
            continue
          }

          await offlineMutationTable.update(mutationId, {
            entityType: 'inventory_transactions',
            entityId: adjustmentId,
            payload: canonicalPayload
          })
          convertedMutationIdsByAdjustmentId.set(adjustmentId, mutationId)
        }

        for (const mutationRow of offlineMutationRows) {
          if (getStringValue(mutationRow, 'entityType') !== 'inventory_transactions') {
            continue
          }

          const mutationId = getStringValue(mutationRow, 'id')
          const entityId = getStringValue(mutationRow, 'entityId')
          const payload = mutationRow.payload as Record<string, unknown> | undefined
          const transactionType = getStringValue(payload, 'transactionType')

          if (!mutationId || transactionType !== 'stock_adjustment') {
            continue
          }

          const adjustmentId = getStringValue(payload, 'referenceId')
          if (!adjustmentId || !stockAdjustmentIds.has(adjustmentId) || adjustmentId === entityId) {
            continue
          }

          if (convertedMutationIdsByAdjustmentId.has(adjustmentId)) {
            await offlineMutationTable.delete(mutationId)
            continue
          }

          const canonicalPayload = normalizeStockAdjustmentInventoryTransactionRecord(
            {
              ...(payload ?? {}),
              id: adjustmentId,
              workspaceId: getStringValue(payload, 'workspaceId') ?? getStringValue(mutationRow, 'workspaceId')
            },
            adjustmentId
          )

          if (!canonicalPayload) {
            continue
          }

          await offlineMutationTable.update(mutationId, {
            entityId: adjustmentId,
            payload: canonicalPayload
          })
        }

        const convertedSyncQueueIdsByAdjustmentId = new Map<string, string>()
        for (const queueRow of syncQueueRows) {
          if (getStringValue(queueRow, 'entityType') !== 'stock_adjustments') {
            continue
          }

          const queueId = getStringValue(queueRow, 'id')
          const adjustmentId = getStringValue(queueRow, 'entityId')
          const data = queueRow.data as Record<string, unknown> | undefined

          if (!queueId || !adjustmentId) {
            continue
          }

          const canonicalPayload = buildInventoryTransactionFromStockAdjustmentRecord(
            {
              ...(data ?? {}),
              id: adjustmentId,
              workspaceId: getStringValue(data, 'workspaceId')
            },
            legacyTransactionByAdjustmentId.get(adjustmentId)
          )

          if (!canonicalPayload) {
            continue
          }

          await syncQueueTable.update(queueId, {
            entityType: 'inventory_transactions',
            entityId: adjustmentId,
            data: canonicalPayload
          })
          convertedSyncQueueIdsByAdjustmentId.set(adjustmentId, queueId)
        }

        for (const queueRow of syncQueueRows) {
          if (getStringValue(queueRow, 'entityType') !== 'inventory_transactions') {
            continue
          }

          const queueId = getStringValue(queueRow, 'id')
          const entityId = getStringValue(queueRow, 'entityId')
          const data = queueRow.data as Record<string, unknown> | undefined
          const transactionType = getStringValue(data, 'transactionType')

          if (!queueId || transactionType !== 'stock_adjustment') {
            continue
          }

          const adjustmentId = getStringValue(data, 'referenceId')
          if (!adjustmentId || !stockAdjustmentIds.has(adjustmentId) || adjustmentId === entityId) {
            continue
          }

          if (convertedSyncQueueIdsByAdjustmentId.has(adjustmentId)) {
            await syncQueueTable.delete(queueId)
            continue
          }

          const canonicalPayload = normalizeStockAdjustmentInventoryTransactionRecord(
            {
              ...(data ?? {}),
              id: adjustmentId
            },
            adjustmentId
          )

          if (!canonicalPayload) {
            continue
          }

          await syncQueueTable.update(queueId, {
            entityId: adjustmentId,
            data: canonicalPayload
          })
        }
      })

    this.version(56)
      .stores({
        storages:
          'id, name, workspaceId, isSystem, isProtected, isPrimary, isMarketplace, syncStatus, updatedAt, isDeleted'
      })
      .upgrade(async (tx) => {
        const storageRows = (await tx.table('storages').toArray()) as Array<Record<string, unknown>>
        if (storageRows.length === 0) {
          return
        }

        const rowsByWorkspace = new Map<string, Array<Record<string, unknown>>>()
        for (const row of storageRows) {
          const workspaceId = String(row.workspaceId || '')
          if (!workspaceId) {
            row.isMarketplace = false
            continue
          }

          const workspaceRows = rowsByWorkspace.get(workspaceId) ?? []
          workspaceRows.push(row)
          rowsByWorkspace.set(workspaceId, workspaceRows)
        }

        for (const workspaceRows of rowsByWorkspace.values()) {
          const activeRows = workspaceRows.filter((row) => !row.isDeleted)
          const marketplaceRow =
            activeRows.find((row) => row.isMarketplace === true) ??
            activeRows.find((row) => row.isPrimary === true) ??
            activeRows.find(
              (row) =>
                row.isSystem === true &&
                String(row.name || '')
                  .trim()
                  .toLowerCase() === 'main'
            ) ??
            activeRows[0]

          for (const row of workspaceRows) {
            row.isMarketplace = !!marketplaceRow && !row.isDeleted && row.id === marketplaceRow.id
          }
        }

        await tx.table('storages').bulkPut(storageRows)
      })

    this.version(57)
      .stores({
        stock_batches:
          'id, workspaceId, productId, storageId, batchNumber, expiryDate, isDeleted, [workspaceId+productId], [productId+storageId]'
      })
      .upgrade(async (tx) => {
        const [batchRows, productRows] = await Promise.all([
          tx.table('stock_batches').toArray() as Promise<Array<Record<string, unknown>>>,
          tx.table('products').toArray() as Promise<Array<Record<string, unknown>>>
        ])

        if (batchRows.length === 0) {
          return
        }

        const productById = new Map<string, Record<string, unknown>>()
        for (const productRow of productRows) {
          const productId = getStringValue(productRow, 'id')
          if (productId) {
            productById.set(productId, productRow)
          }
        }

        for (const batchRow of batchRows) {
          const product = productById.get(getStringValue(batchRow, 'productId') ?? '')
          batchRow.price = getNumberValue(batchRow, 'price', getNumberValue(product, 'price', 0))
          batchRow.costPrice = getNumberValue(batchRow, 'costPrice', getNumberValue(product, 'costPrice', 0))
          batchRow.currency = getCurrencyCodeValue(
            batchRow,
            'currency',
            getCurrencyCodeValue(product, 'currency', 'usd')
          )
        }

        await tx.table('stock_batches').bulkPut(batchRows)
      })

    this.version(59).stores({
      real_estate_transactions:
        'id, workspaceId, transactionNo, transactionType, propertyType, status, currency, buyerBusinessPartnerId, sellerBusinessPartnerId, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+status], [workspaceId+createdAt]',
      real_estate_installments:
        'id, transactionId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [transactionId+installmentNo], [workspaceId+dueDate], [workspaceId+status]',
      real_estate_payments: 'id, transactionId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted'
    })

    this.version(60).stores({
      exchange_transactions:
        'id, workspaceId, transactionNo, transactionType, transactionDate, fromCurrency, toCurrency, paymentMethod, employeeUserId, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+createdAt], [workspaceId+transactionDate], [workspaceId+transactionType]',
      exchange_fee_rules:
        'id, workspaceId, name, transactionScope, feeType, currency, effectiveStartDate, effectiveEndDate, isActive, isLocked, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+isActive], [workspaceId+transactionScope], [workspaceId+effectiveStartDate]'
    })

    this.version(61).stores({
      exchange_transactions:
        'id, workspaceId, transactionNo, transactionType, transactionDate, fromCurrency, toCurrency, safeId, profitCurrency, paymentMethod, employeeUserId, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+createdAt], [workspaceId+transactionDate], [workspaceId+transactionType], [workspaceId+safeId]',
      exchange_fee_rules:
        'id, workspaceId, name, transactionScope, feeType, currency, effectiveStartDate, effectiveEndDate, isActive, isLocked, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+isActive], [workspaceId+transactionScope], [workspaceId+effectiveStartDate]',
      fx_safes:
        'id, workspaceId, name, isActive, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+isActive], [workspaceId+createdAt]',
      fx_safe_balances:
        'id, workspaceId, safeId, currency, balanceAmount, updatedAt, isDeleted, syncStatus, [safeId+currency], [workspaceId+safeId], [workspaceId+currency]',
      fx_safe_movements:
        'id, workspaceId, safeId, currency, movementType, sourceType, sourceId, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+safeId], [safeId+currency], [sourceType+sourceId]'
    })

    this.version(62).stores({
      exchange_transactions:
        'id, workspaceId, transactionNo, transactionType, transactionDate, fromCurrency, toCurrency, safeId, profitCurrency, paymentMethod, employeeUserId, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+createdAt], [workspaceId+transactionDate], [workspaceId+transactionType], [workspaceId+safeId]'
    })

    this.version(63).stores({
      exchange_pair_prices:
        'id, workspaceId, baseCurrency, quoteCurrency, buyPrice, sellPrice, updatedAt, isDeleted, syncStatus, [workspaceId+baseCurrency+quoteCurrency], [workspaceId+updatedAt]'
    })

    this.version(64).stores({
      clinical_appointments:
        'id, workspaceId, patientId, appointmentDate, startTime, appointmentType, status, priority, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+appointmentDate], [workspaceId+status], [workspaceId+patientId]',
      clinical_patients:
        'id, workspaceId, name, phone, birthYear, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+name], [workspaceId+phone]',
      clinical_attachments:
        'id, workspaceId, appointmentId, fileName, fileType, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+appointmentId]'
    })

    this.version(65).stores({
      clinical_presets:
        'id, workspaceId, category, isActive, sortOrder, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+category], [workspaceId+sortOrder]'
    })

    this.version(66).stores({
      profiles: 'id, workspaceId, name, role, [workspaceId+name]'
    })

    this.version(67).stores({
      sale_returns:
        'id, workspaceId, saleId, status, returnedAt, updatedAt, [workspaceId+saleId], [workspaceId+returnedAt]',
      sale_return_items:
        'id, workspaceId, returnId, saleId, saleItemId, updatedAt, [returnId+saleItemId], [workspaceId+saleId]'
    })

    this.version(68).stores({
      stock_batches:
        'id, workspaceId, productId, storageId, batchNumber, expiryDate, sourcePurchaseOrderId, sourcePurchaseOrderItemId, isDeleted, [workspaceId+productId], [productId+storageId], [sourcePurchaseOrderId+sourcePurchaseOrderItemId]'
    })

    this.version(69).stores({
      local_account_credentials: 'id, workspaceId, userId, email, [workspaceId+userId]'
    })

    this.version(70)
      .stores({
        sales_orders:
          'id, orderNumber, businessPartnerId, customerId, workspaceId, status, paymentStatus, currency, nextDueDate, createdAt, updatedAt, isDeleted, syncStatus',
        purchase_orders:
          'id, orderNumber, businessPartnerId, supplierId, workspaceId, status, paymentStatus, currency, nextDueDate, createdAt, updatedAt, isDeleted, syncStatus',
        order_installments:
          'id, orderId, orderType, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [orderId+installmentNo], [workspaceId+dueDate], [workspaceId+status]'
      })
      .upgrade(async (tx) => {
        const normalizeOrder = (order: Record<string, unknown>) => {
          const total = Math.max(0, Number(order.total || 0))
          const isPaid = order.isPaid === true
          const paidAmount = isPaid ? total : 0
          return {
            ...order,
            paymentStatus: isPaid ? 'paid' : 'unpaid',
            paidAmount,
            balanceAmount: Math.max(total - paidAmount, 0),
            isInstallmentBased: false,
            installmentCount: 0,
            installmentFrequency: null,
            firstDueDate: null,
            nextDueDate: null
          }
        }

        const salesOrders = await tx.table('sales_orders').toArray()
        const purchaseOrders = await tx.table('purchase_orders').toArray()
        if (salesOrders.length > 0) {
          await tx.table('sales_orders').bulkPut(salesOrders.map(normalizeOrder))
        }
        if (purchaseOrders.length > 0) {
          await tx.table('purchase_orders').bulkPut(purchaseOrders.map(normalizeOrder))
        }
      })

    this.version(71).stores({
      workspace_permissions:
        'id, workspaceId, userUuid, key, module, [workspaceId+userUuid], [workspaceId+userUuid+key]'
    })

    this.version(72).stores({
      agents:
        'id, workspaceId, businessPartnerId, agentType, status, linkedUserId, updatedAt, isDeleted, syncStatus, [workspaceId+status], [workspaceId+agentType]',
      business_partners:
        'id, name, workspaceId, role, customerFacetId, supplierFacetId, agentFacetId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId'
    })

    this.version(73).stores({
      fleet_vehicles:
        'id, workspaceId, plateNumber, status, updatedAt, isDeleted, syncStatus, [workspaceId+plateNumber], [workspaceId+status]',
      fleet_vehicle_assignments:
        'id, workspaceId, vehicleId, agentId, status, assignedAt, endedAt, updatedAt, isDeleted, syncStatus, [workspaceId+status], [workspaceId+vehicleId], [workspaceId+agentId]'
    })

    this.version(75).stores({
      manual_entry_templates: 'id, workspaceId, name, status, updatedAt, isDeleted',
      manual_entries: 'id, workspaceId, templateId, createdAt'
    })

    this.version(74)
      .stores({
        sales_exchange:
          'id, saleId, workspaceId, baseCurrency, quoteCurrency, capturedAt, [saleId+baseCurrency+quoteCurrency+rateSide], [workspaceId+capturedAt]'
      })
      .upgrade(async (tx) => {
        const sales = (await tx.table('sales').toArray()) as Array<Record<string, unknown>>
        const exchangeRows: SalesExchange[] = []

        for (const sale of sales) {
          const saleId = getStringValue(sale, 'id')
          const workspaceId = getStringValue(sale, 'workspaceId')
          const snapshots = Array.isArray(sale.exchangeRates) ? sale.exchangeRates : []

          if (saleId && workspaceId) {
            for (const [index, rawSnapshot] of snapshots.entries()) {
              const snapshot = rawSnapshot as Record<string, unknown>
              const pair = getStringValue(snapshot, 'pair')?.split('/') ?? []
              const baseCurrency = pair[0]?.toLowerCase()
              const quoteCurrency = pair[1]?.toLowerCase()
              const quoteAmount = getNumberValue(snapshot, 'rate', 0)
              const baseAmount = getNumberValue(snapshot, 'priceBasisAmount', 100)

              if (
                !['usd', 'eur', 'iqd', 'try'].includes(baseCurrency || '') ||
                !['usd', 'eur', 'iqd', 'try'].includes(quoteCurrency || '') ||
                baseCurrency === quoteCurrency ||
                baseAmount <= 0 ||
                quoteAmount <= 0
              ) {
                continue
              }

              const side = getStringValue(snapshot, 'side')
              const capturedAt =
                getStringValue(snapshot, 'timestamp') || getStringValue(sale, 'createdAt') || new Date().toISOString()

              exchangeRows.push({
                id:
                  typeof crypto !== 'undefined' && crypto.randomUUID
                    ? crypto.randomUUID()
                    : `${saleId}-exchange-${index}`,
                saleId,
                workspaceId,
                baseCurrency: baseCurrency as SalesExchange['baseCurrency'],
                quoteCurrency: quoteCurrency as SalesExchange['quoteCurrency'],
                baseAmount,
                quoteAmount,
                source: getStringValue(snapshot, 'source') || 'unknown',
                capturedAt,
                rateSide: side === 'buy' || side === 'sell' ? side : ('mid' as const),
                sourcePriceId: getNullableStringValue(snapshot, 'priceRowId') ?? null,
                sourcePriceUpdatedAt: getNullableStringValue(snapshot, 'priceUpdatedAt') ?? null,
                createdAt: getStringValue(sale, 'createdAt') || capturedAt
              })
            }

            const legacyRate = getNumberValue(sale, 'exchangeRate', 0)
            if (snapshots.length === 0 && legacyRate > 0) {
              const settlementCurrency = getStringValue(sale, 'settlementCurrency')?.toLowerCase()
              const saleItems = (await tx.table('sale_items').where('saleId').equals(saleId).toArray()) as Array<
                Record<string, unknown>
              >
              const sourceItem = saleItems.find((item) => {
                const originalCurrency = getStringValue(item, 'originalCurrency')?.toLowerCase()
                return (
                  originalCurrency &&
                  originalCurrency !== settlementCurrency &&
                  ['usd', 'eur', 'iqd', 'try'].includes(originalCurrency)
                )
              })
              const baseCurrency = getStringValue(sourceItem, 'originalCurrency')?.toLowerCase()

              if (baseCurrency && settlementCurrency && ['usd', 'eur', 'iqd', 'try'].includes(settlementCurrency)) {
                const capturedAt =
                  getStringValue(sale, 'exchangeRateTimestamp') ||
                  getStringValue(sale, 'createdAt') ||
                  new Date().toISOString()
                exchangeRows.push({
                  id:
                    typeof crypto !== 'undefined' && crypto.randomUUID
                      ? crypto.randomUUID()
                      : `${saleId}-exchange-legacy`,
                  saleId,
                  workspaceId,
                  baseCurrency: baseCurrency as SalesExchange['baseCurrency'],
                  quoteCurrency: settlementCurrency as SalesExchange['quoteCurrency'],
                  baseAmount: 100,
                  quoteAmount: legacyRate,
                  source: getStringValue(sale, 'exchangeSource') || 'legacy',
                  capturedAt,
                  rateSide: 'mid',
                  sourcePriceId: null,
                  sourcePriceUpdatedAt: null,
                  createdAt: getStringValue(sale, 'createdAt') || capturedAt
                })
              }
            }
          }

          delete sale.exchangeSource
          delete sale.exchangeRate
          delete sale.exchangeRateTimestamp
          delete sale.exchangeRates
        }

        if (sales.length > 0) {
          await tx.table('sales').bulkPut(sales)
        }
        if (exchangeRows.length > 0) {
          await tx.table('sales_exchange').bulkPut(exchangeRows)
        }
      })

    this.version(76)
      .stores({
        profiles: 'id, workspaceId, currentWorkspaceId, name, role, [workspaceId+name], [currentWorkspaceId+name]'
      })
      .upgrade(async (tx) => {
        const profiles = (await tx.table('profiles').toArray()) as Array<Record<string, unknown>>
        if (profiles.length > 0) {
          await tx.table('profiles').bulkPut(
            profiles.map((profile) => ({
              ...profile,
              currentWorkspaceId:
                typeof profile.currentWorkspaceId === 'string' ? profile.currentWorkspaceId : profile.workspaceId
            }))
          )
        }
      })

    this.version(77).stores({
      sales:
        'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes, [workspaceId+createdAt]'
    })

    this.version(78)
      .stores({
        loans:
          'id, saleId, orderId, orderType, loanNo, workspaceId, source, loanCategory, direction, linkedPartyId, borrowerName, status, nextDueDate, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+status], [workspaceId+loanCategory], [workspaceId+direction], [orderType+orderId]',
        sales_orders:
          'id, orderNumber, businessPartnerId, customerId, linkedLoanId, workspaceId, status, paymentStatus, paymentMethod, currency, nextDueDate, createdAt, updatedAt, isDeleted, syncStatus',
        purchase_orders:
          'id, orderNumber, businessPartnerId, supplierId, linkedLoanId, workspaceId, status, paymentStatus, paymentMethod, currency, nextDueDate, createdAt, updatedAt, isDeleted, syncStatus'
      })
      .upgrade(async (tx) => {
        const migratePartnerLimits = async () => {
          const partners = (await tx.table('business_partners').toArray()) as Array<Record<string, unknown>>
          const migrated = partners.map((partner) => {
            const legacy = Number(partner.creditLimit || 0)
            const role = String(partner.role || 'customer')
            const migratedLimit = legacy > 0 ? legacy : null
            return {
              ...partner,
              receivableCreditLimit:
                partner.receivableCreditLimit !== undefined
                  ? partner.receivableCreditLimit
                  : role === 'customer' || role === 'both'
                    ? migratedLimit
                    : null,
              payableCreditLimit:
                partner.payableCreditLimit !== undefined
                  ? partner.payableCreditLimit
                  : role === 'supplier' || role === 'both'
                    ? migratedLimit
                    : null
            }
          })
          if (migrated.length > 0) await tx.table('business_partners').bulkPut(migrated)
        }

        const migrateOrders = async (
          tableName: 'sales_orders' | 'purchase_orders',
          orderType: 'sales' | 'purchase'
        ) => {
          const orders = (await tx.table(tableName).toArray()) as Array<Record<string, unknown>>
          const installmentRows = (await tx.table('order_installments').toArray()) as Array<Record<string, unknown>>
          const facetRows = (await tx.table(orderType === 'sales' ? 'customers' : 'suppliers').toArray()) as Array<
            Record<string, unknown>
          >
          const partnerIdByFacetId = new Map(
            facetRows
              .filter((row) => typeof row.id === 'string' && typeof row.businessPartnerId === 'string')
              .map((row) => [row.id as string, row.businessPartnerId as string])
          )
          const loans: Array<Record<string, unknown>> = []
          const loanInstallments: Array<Record<string, unknown>> = []
          const retiredOrderInstallments: Array<Record<string, unknown>> = []

          for (const order of orders) {
            const legacyCredit = order.paymentMethod === 'credit'
            const installmentFinancing = order.isInstallmentBased === true
            const paymentMethod = legacyCredit ? (installmentFinancing ? 'installments' : 'loan') : order.paymentMethod
            const total = Math.max(0, Number(order.total || 0))
            const paidAmount = Math.min(total, Math.max(0, Number(order.paidAmount ?? (order.isPaid ? total : 0))))
            const balanceAmount = Math.max(0, Number(order.balanceAmount ?? total - paidAmount))
            const isActive =
              orderType === 'sales'
                ? order.status === 'pending' || order.status === 'completed'
                : order.status === 'ordered' || order.status === 'received' || order.status === 'completed'
            let linkedLoanId = typeof order.linkedLoanId === 'string' ? order.linkedLoanId : null

            if (
              legacyCredit &&
              isActive &&
              balanceAmount > 0 &&
              typeof order.workspaceId === 'string' &&
              isLocalWorkspaceMode(order.workspaceId)
            ) {
              linkedLoanId = crypto.randomUUID()
              const now = typeof order.updatedAt === 'string' ? order.updatedAt : new Date().toISOString()
              const facetId = String(orderType === 'sales' ? order.customerId || '' : order.supplierId || '')
              const linkedPartyId =
                typeof order.businessPartnerId === 'string'
                  ? order.businessPartnerId
                  : partnerIdByFacetId.get(facetId) || facetId
              const linkedPartyName = orderType === 'sales' ? order.customerName : order.supplierName
              const firstDueDate = typeof order.firstDueDate === 'string' ? order.firstDueDate.slice(0, 10) : null
              const category = installmentFinancing ? 'standard' : 'simple'
              const direction = orderType === 'sales' ? 'lent' : 'borrowed'
              const existingSchedule = installmentRows
                .filter(
                  (row) =>
                    row.orderId === order.id &&
                    row.orderType === orderType &&
                    row.isDeleted !== true &&
                    Number(row.balanceAmount || 0) > 0
                )
                .sort((left, right) => Number(left.installmentNo || 0) - Number(right.installmentNo || 0))

              if (installmentFinancing) {
                for (const [index, row] of existingSchedule.entries()) {
                  const amount = Math.max(0, Number(row.balanceAmount || 0))
                  loanInstallments.push({
                    ...row,
                    id: crypto.randomUUID(),
                    loanId: linkedLoanId,
                    installmentNo: index + 1,
                    plannedAmount: amount,
                    paidAmount: 0,
                    balanceAmount: amount,
                    paidAt: null,
                    syncStatus: 'synced',
                    lastSyncedAt: now
                  })
                  retiredOrderInstallments.push({
                    ...row,
                    isDeleted: true,
                    updatedAt: now,
                    version: Number(row.version || 0) + 1
                  })
                }

                if (existingSchedule.length === 0) {
                  const count = Math.max(1, Math.trunc(Number(order.installmentCount || 1)))
                  const frequency = String(order.installmentFrequency || 'monthly')
                  const roundAmount = (amount: number) => Number(amount.toFixed(3))
                  const baseAmount = roundAmount(balanceAmount / count)
                  let allocated = 0
                  const advanceDueDate = (index: number) => {
                    if (!firstDueDate) return null
                    const base = new Date(`${firstDueDate}T00:00:00.000Z`)
                    if (frequency === 'daily' || frequency === 'weekly' || frequency === 'biweekly') {
                      const interval = frequency === 'daily' ? 1 : frequency === 'weekly' ? 7 : 14
                      base.setUTCDate(base.getUTCDate() + index * interval)
                      return base.toISOString().slice(0, 10)
                    }
                    const targetMonth = base.getUTCMonth() + index
                    const targetYear = base.getUTCFullYear() + Math.floor(targetMonth / 12)
                    const normalizedMonth = ((targetMonth % 12) + 12) % 12
                    const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate()
                    return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(base.getUTCDate(), lastDay)))
                      .toISOString()
                      .slice(0, 10)
                  }

                  for (let index = 0; index < count; index += 1) {
                    const amount = index === count - 1 ? roundAmount(balanceAmount - allocated) : baseAmount
                    allocated = roundAmount(allocated + amount)
                    const dueDate = advanceDueDate(index)
                    loanInstallments.push({
                      id: crypto.randomUUID(),
                      workspaceId: order.workspaceId,
                      loanId: linkedLoanId,
                      installmentNo: index + 1,
                      dueDate,
                      plannedAmount: amount,
                      paidAmount: 0,
                      balanceAmount: amount,
                      status: dueDate && dueDate < now.slice(0, 10) ? 'overdue' : 'unpaid',
                      paidAt: null,
                      createdAt: now,
                      updatedAt: now,
                      syncStatus: 'synced',
                      lastSyncedAt: now,
                      version: 1,
                      isDeleted: false
                    })
                  }
                }
              } else {
                loanInstallments.push({
                  id: crypto.randomUUID(),
                  workspaceId: order.workspaceId,
                  loanId: linkedLoanId,
                  installmentNo: 1,
                  dueDate: firstDueDate,
                  plannedAmount: balanceAmount,
                  paidAmount: 0,
                  balanceAmount,
                  status: firstDueDate && firstDueDate < now.slice(0, 10) ? 'overdue' : 'unpaid',
                  paidAt: null,
                  createdAt: now,
                  updatedAt: now,
                  syncStatus: 'synced',
                  lastSyncedAt: now,
                  version: 1,
                  isDeleted: false
                })
              }

              const nextDueDate =
                loanInstallments.find((row) => row.loanId === linkedLoanId && Number(row.balanceAmount || 0) > 0)
                  ?.dueDate ?? null
              loans.push({
                id: linkedLoanId,
                workspaceId: order.workspaceId,
                saleId: null,
                orderId: order.id,
                orderType,
                loanNo: `${category === 'simple' ? 'SL' : 'LN'}-${now.slice(0, 10).replace(/-/g, '')}-${linkedLoanId.replace(/-/g, '').slice(0, 6).toUpperCase()}`,
                source: 'order',
                loanCategory: category,
                direction,
                linkedPartyType: 'business_partner',
                linkedPartyId,
                linkedPartyName,
                borrowerName: linkedPartyName || 'Order counterparty',
                borrowerPhone: '',
                borrowerAddress: '',
                borrowerNationalId: '',
                principalAmount: balanceAmount,
                totalPaidAmount: 0,
                balanceAmount,
                settlementCurrency: order.currency,
                exchangeRateSnapshot: order.exchangeRates ?? null,
                installmentCount: loanInstallments.filter((row) => row.loanId === linkedLoanId).length,
                installmentFrequency: order.installmentFrequency || 'monthly',
                firstDueDate,
                nextDueDate,
                status: nextDueDate && nextDueDate < now.slice(0, 10) ? 'overdue' : 'active',
                notes: `Migrated from ${orderType} order ${String(order.orderNumber || order.id)}`,
                createdBy: order.createdBy ?? null,
                createdAt: now,
                updatedAt: now,
                syncStatus: 'synced',
                lastSyncedAt: now,
                version: 1,
                isDeleted: false
              })
            }

            order.paymentMethod = paymentMethod
            order.initialPaymentAmount = legacyCredit
              ? paidAmount
              : Math.max(0, Number(order.initialPaymentAmount || 0))
            order.linkedLoanId = linkedLoanId
            order.isInstallmentBased = paymentMethod === 'installments'
          }

          if (orders.length > 0) await tx.table(tableName).bulkPut(orders)
          if (loans.length > 0) await tx.table('loans').bulkPut(loans)
          if (loanInstallments.length > 0) await tx.table('loan_installments').bulkPut(loanInstallments)
          if (retiredOrderInstallments.length > 0)
            await tx.table('order_installments').bulkPut(retiredOrderInstallments)
        }

        await migratePartnerLimits()
        await migrateOrders('sales_orders', 'sales')
        await migrateOrders('purchase_orders', 'purchase')
      })

    this.version(79)
      .stores({
        invoices:
          'id, invoiceid, sourceId, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt, latestVersionId, latestVersionNumber, [workspaceId+origin+sourceId]',
        invoice_versions:
          'id, invoiceId, workspaceId, sourceId, origin, versionNumber, format, createdBy, createdAt, syncStatus, [invoiceId+versionNumber], [workspaceId+invoiceId], [workspaceId+origin+sourceId]'
      })
      .upgrade(async (tx) => {
        const invoices = (await tx.table('invoices').toArray()) as Array<Record<string, unknown>>
        const legacyVersions: Array<Record<string, unknown>> = []

        for (const invoice of invoices) {
          const invoiceId = String(invoice.id || '')
          const workspaceId = String(invoice.workspaceId || '')
          if (!invoiceId || !workspaceId) continue

          const sourceId =
            typeof invoice.sourceId === 'string'
              ? invoice.sourceId
              : typeof invoice.orderId === 'string' && invoice.orderId
                ? invoice.orderId
                : invoiceId
          const origin = typeof invoice.origin === 'string' && invoice.origin ? invoice.origin : 'manual'
          const createdAt = typeof invoice.createdAt === 'string' ? invoice.createdAt : new Date().toISOString()
          let versionNumber = 0

          const addLegacyVersion = (format: 'a4' | 'receipt') => {
            const upper = format === 'a4' ? 'A4' : 'Receipt'
            const r2Path = invoice[`r2Path${upper}`]
            const localPath = invoice[`localPath${upper}`]
            const pdfBlob = invoice[`pdfBlob${upper}`]
            if (!r2Path && !localPath && !pdfBlob) return

            versionNumber += 1
            const versionId = crypto.randomUUID()
            legacyVersions.push({
              id: versionId,
              invoiceId,
              workspaceId,
              sourceId,
              origin,
              versionNumber,
              format,
              r2Path,
              localPath,
              pdfBlob,
              fileSize: pdfBlob instanceof Blob ? pdfBlob.size : Number(invoice.fileSize || 0),
              createdBy: invoice.createdBy,
              createdByName: invoice.createdByName,
              createdAt,
              syncStatus: invoice.syncStatus || 'synced',
              lastSyncedAt: invoice.lastSyncedAt || null,
              metadata: { migratedFromLegacyInvoice: true }
            })
            invoice.latestVersionId = versionId
          }

          addLegacyVersion('a4')
          addLegacyVersion('receipt')
          invoice.sourceId = sourceId
          invoice.latestVersionNumber = versionNumber
        }

        if (invoices.length > 0) await tx.table('invoices').bulkPut(invoices)
        if (legacyVersions.length > 0) await tx.table('invoice_versions').bulkPut(legacyVersions)
      })

    this.version(80).upgrade(async (tx) => {
      const [loanRows, installmentRows, workspaceRows] = await Promise.all([
        tx.table('loans').toArray() as Promise<Array<Record<string, unknown>>>,
        tx.table('loan_installments').toArray() as Promise<Array<Record<string, unknown>>>,
        tx.table('workspaces').toArray() as Promise<Array<Record<string, unknown>>>
      ])
      if (loanRows.length === 0) return

      const localWorkspaceIds = new Set(
        workspaceRows
          .filter((row) => row.data_mode === 'local' || row.data_mode === 'demo')
          .map((row) => row.id)
          .filter((id): id is string => typeof id === 'string')
      )
      const activeInstallmentLoanIds = new Set(
        installmentRows
          .filter((row) => row.isDeleted !== true && typeof row.loanId === 'string')
          .map((row) => row.loanId as string)
      )
      const now = new Date().toISOString()
      const today = now.slice(0, 10)
      const backfilledInstallments: Array<Record<string, unknown>> = []
      const updatedLoans: Array<Record<string, unknown>> = []

      for (const loan of loanRows) {
        const loanId = typeof loan.id === 'string' ? loan.id : ''
        const workspaceId = typeof loan.workspaceId === 'string' ? loan.workspaceId : ''
        if (
          !loanId ||
          !workspaceId ||
          (!localWorkspaceIds.has(workspaceId) && !isLocalWorkspaceMode(workspaceId)) ||
          loan.isDeleted === true ||
          loan.source !== 'order' ||
          loan.loanCategory !== 'simple' ||
          activeInstallmentLoanIds.has(loanId)
        ) {
          continue
        }

        const principalAmount = Math.max(0, Number(loan.principalAmount || 0))
        const paidAmount = Math.max(0, Number(loan.totalPaidAmount || 0))
        const balanceAmount = Math.max(0, Number(loan.balanceAmount ?? Math.max(principalAmount - paidAmount, 0)))
        const firstDueDate =
          typeof loan.firstDueDate === 'string' && loan.firstDueDate ? loan.firstDueDate.slice(0, 10) : null
        const installmentStatus =
          balanceAmount <= 0
            ? 'paid'
            : paidAmount > 0
              ? 'partial'
              : firstDueDate && firstDueDate < today
                ? 'overdue'
                : 'unpaid'

        backfilledInstallments.push({
          id: crypto.randomUUID(),
          workspaceId,
          loanId,
          installmentNo: 1,
          dueDate: firstDueDate,
          plannedAmount: principalAmount,
          paidAmount,
          balanceAmount,
          status: installmentStatus,
          paidAt: installmentStatus === 'paid' ? (typeof loan.updatedAt === 'string' ? loan.updatedAt : now) : null,
          createdAt: typeof loan.createdAt === 'string' ? loan.createdAt : now,
          updatedAt: now,
          syncStatus: 'synced',
          lastSyncedAt: now,
          version: 1,
          isDeleted: false
        })

        updatedLoans.push({
          ...loan,
          installmentCount: 1,
          nextDueDate: balanceAmount > 0 ? firstDueDate : null,
          status: balanceAmount <= 0 ? 'completed' : firstDueDate && firstDueDate < today ? 'overdue' : 'active',
          updatedAt: now,
          version: Number(loan.version || 0) + 1,
          syncStatus: 'synced',
          lastSyncedAt: now
        })
        activeInstallmentLoanIds.add(loanId)
      }

      if (backfilledInstallments.length > 0) {
        await tx.table('loan_installments').bulkPut(backfilledInstallments)
      }
      if (updatedLoans.length > 0) {
        await tx.table('loans').bulkPut(updatedLoans)
      }
    })

    this.version(81).stores({
      products:
        'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned, [workspaceId+name], [workspaceId+sku], [workspaceId+categoryId], [workspaceId+currency], [workspaceId+updatedAt], [workspaceId+storageId]',
      categories:
        'id, name, workspaceId, syncStatus, updatedAt, isDeleted, [workspaceId+name], [workspaceId+updatedAt]',
      storages:
        'id, name, workspaceId, isSystem, isProtected, isPrimary, isMarketplace, syncStatus, updatedAt, isDeleted, [workspaceId+name], [workspaceId+updatedAt]',
      inventory:
        'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId], [workspaceId+storageId+productId], [workspaceId+updatedAt]',
      stock_batches:
        'id, workspaceId, productId, storageId, batchNumber, expiryDate, sourcePurchaseOrderId, sourcePurchaseOrderItemId, updatedAt, isDeleted, [workspaceId+productId], [productId+storageId], [workspaceId+storageId], [workspaceId+storageId+productId], [workspaceId+updatedAt], [sourcePurchaseOrderId+sourcePurchaseOrderItemId]'
    })

    this.version(82).stores({
      order_returns:
        'id, workspaceId, orderId, status, returnedAt, updatedAt, isDeleted, syncStatus, [workspaceId+orderId], [workspaceId+returnedAt]',
      order_return_items:
        'id, workspaceId, returnId, orderId, orderItemId, updatedAt, isDeleted, syncStatus, [returnId+orderItemId], [workspaceId+orderId], [workspaceId+orderItemId]'
    })

    this.version(83).stores({
      business_partners:
        'id, name, workspaceId, role, customerFacetId, supplierFacetId, agentFacetId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId, latitude, longitude'
    })

    this.version(84)
      .stores({
        agents:
          'id, workspaceId, businessPartnerId, agentType, status, linkedUserId, updatedAt, isDeleted, syncStatus, [workspaceId+status], [workspaceId+agentType]'
      })
      .upgrade(async (tx) => {
        const agents = (await tx.table('agents').toArray()) as Array<Record<string, unknown>>
        for (const agent of agents) {
          delete agent.imageUrl
          delete agent.image_url
        }
        if (agents.length > 0) {
          await tx.table('agents').bulkPut(agents)
        }

        const stripLegacyAgentImage = (row: Record<string, unknown>, field: 'payload' | 'data') => {
          const current = row[field]
          if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return row
          }

          const next = { ...(current as Record<string, unknown>) }
          delete next.imageUrl
          delete next.image_url
          return { ...row, [field]: next }
        }

        const offlineMutations = (await tx
          .table('offline_mutations')
          .where('entityType')
          .equals('agents')
          .toArray()) as Array<Record<string, unknown>>
        if (offlineMutations.length > 0) {
          await tx
            .table('offline_mutations')
            .bulkPut(offlineMutations.map((row) => stripLegacyAgentImage(row, 'payload')))
        }

        const syncQueue = (await tx.table('syncQueue').where('entityType').equals('agents').toArray()) as Array<
          Record<string, unknown>
        >
        if (syncQueue.length > 0) {
          await tx.table('syncQueue').bulkPut(syncQueue.map((row) => stripLegacyAgentImage(row, 'data')))
        }
      })

    this.version(85).stores({
      price_books:
        'id, name, workspaceId, syncStatus, updatedAt, isDeleted, [workspaceId+name], [workspaceId+updatedAt]',
      price_book_items:
        'id, workspaceId, priceBookId, productId, currency, syncStatus, updatedAt, isDeleted, [workspaceId+priceBookId], [workspaceId+productId], &[priceBookId+productId], [workspaceId+updatedAt]',
      business_partners:
        'id, name, workspaceId, role, customerFacetId, supplierFacetId, agentFacetId, priceBookId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId, latitude, longitude'
    })

    this.version(86)
      .stores({
        products:
          'id, sku, skuKey, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned, [workspaceId+name], [workspaceId+sku], [workspaceId+skuKey], [workspaceId+categoryId], [workspaceId+currency], [workspaceId+updatedAt], [workspaceId+storageId]'
      })
      .upgrade(async (tx) => {
        const products = (await tx.table('products').toArray()) as Array<Record<string, unknown>>
        const productsToUpdate = products
          .filter((product) => {
            const sku = typeof product.sku === 'string' ? product.sku : ''
            return product.skuKey !== normalizeProductSku(sku)
          })
          .map((product) => ({
            ...product,
            skuKey: normalizeProductSku(typeof product.sku === 'string' ? product.sku : '')
          }))

        if (productsToUpdate.length > 0) {
          await tx.table('products').bulkPut(productsToUpdate)
        }
      })

    this.version(87).upgrade(async (tx) => {
      // Do not let records queued by earlier clients revive the retired cloud logs.
      const localOnlyEntityTypes = ['inventory_transactions', 'inventory_transfer_transactions']

      await Promise.all([
        tx.table('offline_mutations').where('entityType').anyOf(localOnlyEntityTypes).delete(),
        tx.table('syncQueue').where('entityType').anyOf(localOnlyEntityTypes).delete()
      ])
    })

    this.version(88).stores({
      sale_product_exchanges:
        'id, workspaceId, saleId, returnId, returnSaleItemId, returnProductId, replacementProductId, replacementStorageId, status, exchangedAt, updatedAt, isDeleted, syncStatus, [workspaceId+saleId], [workspaceId+exchangedAt], [saleId+exchangedAt]'
    })

    this.version(89).stores({
      activity_catalog:
        'id, workspaceId, name, currency, isInfinite, isActive, updatedAt, isDeleted, syncStatus, [workspaceId+name], [workspaceId+isActive], [workspaceId+updatedAt]',
      activity_transactions:
        'id, workspaceId, transactionNo, status, currency, occurredAt, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+occurredAt], [workspaceId+status], [workspaceId+createdAt]',
      activity_transaction_lines:
        'id, workspaceId, transactionId, activityId, updatedAt, isDeleted, syncStatus, [transactionId+activityId], [workspaceId+transactionId], [workspaceId+activityId]'
    })

    this.version(90).stores({
      agent_excluded_categories:
        'id, workspaceId, agentId, categoryId, updatedAt, isDeleted, syncStatus, [workspaceId+agentId], [workspaceId+categoryId], [agentId+categoryId]'
    })

    this.version(91)
      .stores({
        sale_items: 'id, workspaceId, saleId, productId, [workspaceId+saleId]'
      })
      .upgrade(async (tx) => {
        const sales = (await tx.table('sales').toArray()) as Array<Record<string, unknown>>
        const workspaceIdBySaleId = new Map(
          sales
            .filter((sale) => typeof sale.id === 'string' && typeof sale.workspaceId === 'string')
            .map((sale) => [sale.id as string, sale.workspaceId as string])
        )
        const saleItems = (await tx.table('sale_items').toArray()) as Array<Record<string, unknown>>
        const backfilledItems: Array<Record<string, unknown>> = []
        for (const item of saleItems) {
          const workspaceId = typeof item.saleId === 'string' ? workspaceIdBySaleId.get(item.saleId) : undefined
          if (!workspaceId || item.workspaceId === workspaceId) {
            continue
          }
          backfilledItems.push({ ...item, workspaceId })
        }

        if (backfilledItems.length > 0) {
          await tx.table('sale_items').bulkPut(backfilledItems)
        }
      })

    this.version(92)
      .stores({
        sale_items: 'id, workspaceId, saleId, productId, [workspaceId+saleId]'
      })
      .upgrade(async (tx) => {
        const sales = (await tx.table('sales').toArray()) as Array<Record<string, unknown>>
        const createdAtBySaleId = new Map(
          sales
            .filter((sale) => typeof sale.id === 'string' && typeof sale.createdAt === 'string')
            .map((sale) => [sale.id as string, sale.createdAt as string])
        )
        const saleItems = (await tx.table('sale_items').toArray()) as Array<Record<string, unknown>>
        const backfilledItems: Array<Record<string, unknown>> = []
        for (const item of saleItems) {
          const parentCreatedAt = typeof item.saleId === 'string' ? createdAtBySaleId.get(item.saleId) : undefined
          const createdAt = typeof item.createdAt === 'string' ? item.createdAt : parentCreatedAt
          const updatedAt =
            typeof item.updatedAt === 'string'
              ? item.updatedAt
              : typeof item.returnedAt === 'string'
                ? item.returnedAt
                : createdAt

          // A sale always has createdAt, but leave an unexpectedly malformed
          // record untouched rather than falsely assigning the upgrade time.
          if (!createdAt || !updatedAt) {
            continue
          }
          if (item.createdAt === createdAt && item.updatedAt === updatedAt) {
            continue
          }
          backfilledItems.push({ ...item, createdAt, updatedAt })
        }

        if (backfilledItems.length > 0) {
          await tx.table('sale_items').bulkPut(backfilledItems)
        }
      })

    this.version(93).stores({
      units: 'id, workspaceId, code, updatedAt, isDeleted, syncStatus, [workspaceId+code], [workspaceId+updatedAt]'
    })

    this.version(94).stores({
      products:
        'id, sku, skuKey, name, categoryId, storageId, workspaceId, parentProductId, currency, syncStatus, updatedAt, isDeleted, canBeReturned, [workspaceId+name], [workspaceId+sku], [workspaceId+skuKey], [workspaceId+parentProductId], [workspaceId+categoryId], [workspaceId+currency], [workspaceId+updatedAt], [workspaceId+storageId]'
    })

    this.version(95).stores({
      delivery_merchant_profiles:
        'id, workspaceId, businessPartnerId, isActive, updatedAt, isDeleted, syncStatus, [workspaceId+businessPartnerId], [workspaceId+isActive]',
      delivery_shipments:
        'id, workspaceId, trackingNumber, merchantProfileId, merchantBusinessPartnerId, assignedAgentId, assignedRunId, status, currency, updatedAt, isDeleted, syncStatus, [workspaceId+trackingNumber], [workspaceId+status], [workspaceId+merchantProfileId], [workspaceId+assignedAgentId], [workspaceId+assignedRunId]',
      delivery_shipment_events:
        'id, workspaceId, shipmentId, status, occurredAt, updatedAt, isDeleted, syncStatus, [workspaceId+shipmentId], [workspaceId+occurredAt]',
      delivery_runs:
        'id, workspaceId, runNumber, agentId, vehicleId, status, dispatchedAt, updatedAt, isDeleted, syncStatus, [workspaceId+runNumber], [workspaceId+agentId], [workspaceId+status]',
      delivery_run_items:
        'id, workspaceId, runId, shipmentId, assignedAt, updatedAt, isDeleted, syncStatus, [workspaceId+runId], [workspaceId+shipmentId], [runId+shipmentId]',
      delivery_settlements:
        'id, workspaceId, settlementNumber, type, agentId, merchantProfileId, businessPartnerId, currency, settledAt, updatedAt, isDeleted, syncStatus, [workspaceId+type], [workspaceId+agentId], [workspaceId+merchantProfileId]',
      delivery_ledger_entries:
        'id, workspaceId, kind, shipmentId, settlementId, agentId, merchantProfileId, businessPartnerId, currency, occurredAt, updatedAt, isDeleted, syncStatus, [workspaceId+shipmentId], [workspaceId+settlementId], [workspaceId+agentId], [workspaceId+merchantProfileId]'
    })

    this.version(96).stores({
      delivery_shipments:
        'id, workspaceId, trackingNumber, merchantProfileId, merchantBusinessPartnerId, assignedAgentId, assignedRunId, status, currency, createdBy, updatedAt, isDeleted, syncStatus, [workspaceId+trackingNumber], [workspaceId+status], [workspaceId+merchantProfileId], [workspaceId+assignedAgentId], [workspaceId+assignedRunId], [workspaceId+createdBy]'
    })

    this.version(97).stores({
      agent_commission_plans:
        'id, workspaceId, level, isActive, effectiveFrom, effectiveTo, updatedAt, isDeleted, syncStatus, [workspaceId+level], [workspaceId+isActive], [workspaceId+effectiveFrom]',
      agent_commission_memberships:
        'id, workspaceId, agentId, planId, effectiveFrom, effectiveTo, updatedAt, isDeleted, syncStatus, [workspaceId+agentId], [workspaceId+planId], [agentId+effectiveFrom]',
      sales_order_agent_assignments:
        'id, workspaceId, orderId, agentId, assignedAt, unassignedAt, updatedAt, isDeleted, syncStatus, [workspaceId+orderId], [workspaceId+agentId], [orderId+assignedAt]',
      agent_commission_entries:
        'id, workspaceId, orderId, assignmentId, agentId, membershipId, planId, orderReturnId, relatedEntryId, kind, status, currency, occurredAt, updatedAt, isDeleted, syncStatus, [workspaceId+agentId], [workspaceId+orderId], [workspaceId+status], [agentId+occurredAt]'
    })

    this.version(98).stores({
      rental_vehicles:
        'id, workspaceId, plateNumber, status, currency, updatedAt, isDeleted, syncStatus, [workspaceId+plateNumber], [workspaceId+status]',
      rental_requests:
        'id, workspaceId, requestNo, status, preferredVehicleId, requestedStartAt, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+requestNo], [workspaceId+status], [workspaceId+createdAt], [workspaceId+preferredVehicleId]',
      rental_contracts:
        'id, workspaceId, contractNo, requestId, vehicleId, businessPartnerId, status, plannedPickupAt, plannedReturnAt, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+contractNo], [workspaceId+vehicleId], [workspaceId+status], [workspaceId+createdAt]'
    })

    this.version(99).stores({
      payment_transactions:
        'id, workspaceId, paidAt, accountId, sourceModule, sourceType, sourceRecordId, sourceSubrecordId, direction, reversalOfTransactionId, updatedAt, isDeleted, syncStatus, [workspaceId+paidAt], [workspaceId+accountId], [workspaceId+sourceType+sourceRecordId]',
      payment_accounts:
        'id, workspaceId, name, accountType, isActive, updatedAt, isDeleted, syncStatus, [workspaceId+name], [workspaceId+isActive]',
      payment_account_balances:
        'id, workspaceId, accountId, currency, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [accountId+currency]',
      payment_account_movements:
        'id, workspaceId, accountId, paymentTransactionId, currency, occurredAt, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [accountId+occurredAt], [workspaceId+occurredAt]',
      cashier_shifts:
        'id, workspaceId, accountId, cashierUserId, status, openedAt, closedAt, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [workspaceId+status], [accountId+cashierUserId]',
      cashier_shift_currency_counts:
        'id, workspaceId, shiftId, currency, updatedAt, isDeleted, syncStatus, [workspaceId+shiftId], [shiftId+currency]'
    })

    this.version(100)
      .stores({
        payment_transactions:
          'id, workspaceId, paidAt, accountId, sourceModule, sourceType, sourceRecordId, sourceSubrecordId, direction, reversalOfTransactionId, updatedAt, isDeleted, syncStatus, [workspaceId+paidAt], [workspaceId+accountId], [workspaceId+sourceType+sourceRecordId]',
        payment_accounts:
          'id, workspaceId, name, accountType, iconKey, isPrimary, isDefaultForPaymentSelector, isActive, updatedAt, isDeleted, syncStatus, [workspaceId+name], [workspaceId+isActive]',
        payment_account_balances:
          'id, workspaceId, accountId, currency, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [accountId+currency]',
        payment_account_movements:
          'id, workspaceId, accountId, paymentTransactionId, currency, occurredAt, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [accountId+occurredAt], [workspaceId+occurredAt]',
        cashier_shifts:
          'id, workspaceId, accountId, cashierUserId, status, openedAt, closedAt, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [workspaceId+status], [accountId+cashierUserId]',
        cashier_shift_currency_counts:
          'id, workspaceId, shiftId, currency, updatedAt, isDeleted, syncStatus, [workspaceId+shiftId], [shiftId+currency]'
      })
      .upgrade(async (transaction) => {
        const accounts = (await transaction.table('payment_accounts').toArray()) as PaymentAccount[]
        const updates = new Map<string, PaymentAccount>()

        for (const account of accounts) {
          const iconKey =
            account.iconKey ??
            (account.accountType === 'bank_account'
              ? 'bank'
              : account.accountType === 'digital_wallet'
                ? 'wallet'
                : account.accountType === 'other'
                  ? 'card'
                  : 'cash_drawer')
          if (account.iconKey !== iconKey) updates.set(account.id, { ...account, iconKey })
        }

        const accountsByWorkspace = new Map<string, PaymentAccount[]>()
        for (const account of accounts) {
          if (account.isDeleted || !account.isActive) continue
          const workspaceAccounts = accountsByWorkspace.get(account.workspaceId) ?? []
          workspaceAccounts.push(account)
          accountsByWorkspace.set(account.workspaceId, workspaceAccounts)
        }
        for (const workspaceAccounts of accountsByWorkspace.values()) {
          if (workspaceAccounts.some((account) => account.isPrimary)) continue
          const firstAccount = [...workspaceAccounts].sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name)
          )[0]
          updates.set(firstAccount.id, {
            ...(updates.get(firstAccount.id) ?? firstAccount),
            isPrimary: true
          })
        }

        if (updates.size) await transaction.table('payment_accounts').bulkPut([...updates.values()])
      })

    this.version(101).stores({
      payment_transactions:
        'id, workspaceId, paidAt, accountId, sourceModule, sourceType, sourceRecordId, sourceSubrecordId, direction, reversalOfTransactionId, updatedAt, isDeleted, syncStatus, [workspaceId+paidAt], [workspaceId+accountId], [workspaceId+sourceType+sourceRecordId]',
      payment_accounts:
        'id, workspaceId, name, accountType, linkedPaymentMethod, iconKey, isPrimary, isDefaultForPaymentSelector, isActive, updatedAt, isDeleted, syncStatus, [workspaceId+name], [workspaceId+isActive], [workspaceId+linkedPaymentMethod]',
      payment_account_balances:
        'id, workspaceId, accountId, currency, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [accountId+currency]',
      payment_account_movements:
        'id, workspaceId, accountId, paymentTransactionId, currency, occurredAt, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [accountId+occurredAt], [workspaceId+occurredAt]',
      cashier_shifts:
        'id, workspaceId, accountId, cashierUserId, status, openedAt, closedAt, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [workspaceId+status], [accountId+cashierUserId]',
      cashier_shift_currency_counts:
        'id, workspaceId, shiftId, currency, updatedAt, isDeleted, syncStatus, [workspaceId+shiftId], [shiftId+currency]'
    })

    this.version(102).stores({
      payment_transactions:
        'id, workspaceId, paidAt, accountId, sourceModule, sourceType, sourceRecordId, sourceSubrecordId, direction, reversalOfTransactionId, updatedAt, isDeleted, syncStatus, [workspaceId+paidAt], [workspaceId+accountId], [workspaceId+sourceType+sourceRecordId]',
      payment_accounts:
        'id, workspaceId, name, accountType, linkedPaymentMethod, iconKey, isPrimary, isDefaultForPaymentSelector, isActive, updatedAt, isDeleted, syncStatus, [workspaceId+name], [workspaceId+isActive], [workspaceId+linkedPaymentMethod]',
      payment_account_balances:
        'id, workspaceId, accountId, currency, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [accountId+currency]',
      payment_account_movements:
        'id, workspaceId, accountId, paymentTransactionId, currency, occurredAt, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [accountId+occurredAt], [workspaceId+occurredAt]',
      cashier_shifts:
        'id, workspaceId, accountId, cashierUserId, status, openedAt, closedAt, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [workspaceId+status], [accountId+cashierUserId]',
      cashier_shift_currency_counts:
        'id, workspaceId, shiftId, currency, updatedAt, isDeleted, syncStatus, [workspaceId+shiftId], [shiftId+currency]',
      cashier_shift_templates:
        'id, workspaceId, name, isActive, updatedAt, isDeleted, syncStatus, [workspaceId+name], [workspaceId+isActive]',
      cashier_shift_assignments:
        'id, workspaceId, templateId, accountId, cashierUserId, isActive, updatedAt, isDeleted, syncStatus, [workspaceId+cashierUserId], [workspaceId+isActive], [cashierUserId+isActive]',
      cashier_shift_occurrences:
        'id, workspaceId, assignmentId, cashierUserId, scheduledStartAt, status, updatedAt, isDeleted, syncStatus, [workspaceId+cashierUserId], [workspaceId+scheduledStartAt], [cashierUserId+scheduledStartAt], [assignmentId+scheduledStartAt]'
    })

    this.version(103).stores({
      agents:
        'id, workspaceId, businessPartnerId, agentType, status, linkedUserId, salesAccountEnabled, updatedAt, isDeleted, syncStatus, [workspaceId+status], [workspaceId+agentType], [workspaceId+salesAccountEnabled]',
      sales_orders:
        'id, orderNumber, businessPartnerId, customerId, linkedLoanId, salesAccountAgentId, workspaceId, status, paymentStatus, paymentMethod, currency, nextDueDate, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+salesAccountAgentId]'
    })

    this.version(104).stores({
      delivery_shipment_cod_adjustment_requests:
        'id, workspaceId, shipmentId, requesterUserId, requesterAgentId, status, updatedAt, isDeleted, syncStatus, [workspaceId+shipmentId], [workspaceId+shipmentId+status], [workspaceId+requesterUserId], [workspaceId+status]'
    })

    this.version(105).stores({
      product_commission_rules:
        'id, workspaceId, productId, isActive, effectiveFrom, effectiveTo, updatedAt, isDeleted, syncStatus, [workspaceId+productId], [workspaceId+isActive]',
      product_commission_rule_agents:
        'id, workspaceId, ruleId, agentId, updatedAt, isDeleted, syncStatus, [workspaceId+ruleId], [workspaceId+agentId], [ruleId+agentId]',
      agent_product_commission_entries:
        'id, workspaceId, orderId, assignmentId, agentId, orderItemId, productId, orderReturnId, kind, status, occurredAt, updatedAt, isDeleted, syncStatus, [workspaceId+orderId], [workspaceId+agentId], [assignmentId+orderItemId], [workspaceId+orderReturnId]'
    })

    this.version(106).stores({
      payment_transactions:
        'id, workspaceId, paidAt, accountId, cashierShiftOccurrenceId, sourceModule, sourceType, sourceRecordId, sourceSubrecordId, direction, reversalOfTransactionId, updatedAt, isDeleted, syncStatus, [workspaceId+paidAt], [workspaceId+accountId], [workspaceId+cashierShiftOccurrenceId], [workspaceId+sourceType+sourceRecordId]',
      cashier_shift_occurrences:
        'id, workspaceId, assignmentId, cashierUserId, scheduledStartAt, status, completedAt, completedBy, updatedAt, isDeleted, syncStatus, [workspaceId+cashierUserId], [workspaceId+scheduledStartAt], [workspaceId+completedAt], [cashierUserId+scheduledStartAt], [assignmentId+scheduledStartAt]'
    })

    this.version(107)
      .stores({
        cashier_shift_assignments:
          'id, workspaceId, templateId, accountId, cashierUserId, earlyFinishPolicy, isActive, updatedAt, isDeleted, syncStatus, [workspaceId+cashierUserId], [workspaceId+isActive], [cashierUserId+isActive]',
        cashier_shift_occurrences:
          'id, workspaceId, assignmentId, cashierUserId, scheduledStartAt, earlyFinishPolicy, earlyFinishRequestStatus, status, completedAt, completedBy, updatedAt, isDeleted, syncStatus, [workspaceId+cashierUserId], [workspaceId+scheduledStartAt], [workspaceId+earlyFinishRequestStatus], [workspaceId+completedAt], [cashierUserId+scheduledStartAt], [assignmentId+scheduledStartAt]'
      })
      .upgrade(async (transaction) => {
        const assignments = (await transaction.table('cashier_shift_assignments').toArray()) as CashierShiftAssignment[]
        await Promise.all(
          assignments
            .filter((assignment) => !assignment.earlyFinishPolicy)
            .map((assignment) =>
              transaction.table('cashier_shift_assignments').update(assignment.id, {
                earlyFinishPolicy: 'scheduled_end',
                earlyFinishOffsetMinutes: null
              })
            )
        )

        const occurrences = (await transaction.table('cashier_shift_occurrences').toArray()) as CashierShiftOccurrence[]
        await Promise.all(
          occurrences
            .filter((occurrence) => !occurrence.earlyFinishPolicy)
            .map((occurrence) =>
              transaction.table('cashier_shift_occurrences').update(occurrence.id, {
                earlyFinishPolicy: 'scheduled_end',
                earlyFinishOffsetMinutes: null,
                earlyFinishRequestStatus: 'not_requested',
                earlyFinishRequestReason: null,
                earlyFinishRequestedAt: null,
                earlyFinishRequestedBy: null,
                earlyFinishReviewedAt: null,
                earlyFinishReviewedBy: null,
                earlyFinishReviewNote: null,
                completionReason: null
              })
            )
        )
      })

    this.version(108)
      .stores({
        cashier_shift_occurrences:
          'id, workspaceId, assignmentId, cashierUserId, scheduledStartAt, earlyFinishPolicy, earlyFinishRequestStatus, status, completedAt, completedBy, terminatedAt, terminatedBy, updatedAt, isDeleted, syncStatus, [workspaceId+cashierUserId], [workspaceId+scheduledStartAt], [workspaceId+status], [workspaceId+earlyFinishRequestStatus], [workspaceId+completedAt], [workspaceId+terminatedAt], [cashierUserId+scheduledStartAt], [assignmentId+scheduledStartAt]',
        cashier_shift_pause_requests:
          'id, workspaceId, occurrenceId, cashierUserId, status, requestedAt, reviewedAt, updatedAt, isDeleted, syncStatus, [workspaceId+occurrenceId], [workspaceId+status], [occurrenceId+status], [cashierUserId+requestedAt]',
        cashier_shift_pause_periods:
          'id, workspaceId, occurrenceId, kind, startedAt, resumedAt, updatedAt, isDeleted, syncStatus, [workspaceId+occurrenceId], [occurrenceId+resumedAt], [workspaceId+startedAt]'
      })
      .upgrade(async (transaction) => {
        const occurrences = (await transaction.table('cashier_shift_occurrences').toArray()) as CashierShiftOccurrence[]
        await Promise.all(
          occurrences.map((occurrence) =>
            transaction.table('cashier_shift_occurrences').update(occurrence.id, {
              terminatedAt: occurrence.terminatedAt ?? null,
              terminatedBy: occurrence.terminatedBy ?? null,
              terminationReason: occurrence.terminationReason ?? null
            })
          )
        )
      })

    this.version(109)
      .stores({
        cashier_shift_assignments:
          'id, workspaceId, assignmentMode, templateId, accountId, cashierUserId, earlyFinishPolicy, isActive, updatedAt, isDeleted, syncStatus, [workspaceId+cashierUserId], [workspaceId+assignmentMode], [workspaceId+isActive], [cashierUserId+isActive]',
        cashier_shift_occurrences:
          'id, workspaceId, assignmentId, assignmentMode, cashierUserId, scheduledStartAt, earlyFinishPolicy, earlyFinishRequestStatus, status, completedAt, completedBy, terminatedAt, terminatedBy, updatedAt, isDeleted, syncStatus, [workspaceId+cashierUserId], [workspaceId+assignmentMode], [workspaceId+scheduledStartAt], [workspaceId+status], [workspaceId+earlyFinishRequestStatus], [workspaceId+completedAt], [workspaceId+terminatedAt], [cashierUserId+scheduledStartAt], [assignmentId+scheduledStartAt]'
      })
      .upgrade(async (transaction) => {
        const assignments = (await transaction.table('cashier_shift_assignments').toArray()) as CashierShiftAssignment[]
        await Promise.all(
          assignments.map((assignment) =>
            transaction.table('cashier_shift_assignments').update(assignment.id, {
              assignmentMode: assignment.assignmentMode ?? 'scheduled',
              startTime: assignment.startTime ?? null,
              endTime: assignment.endTime ?? null,
              workingDays: assignment.workingDays ?? [],
              earlyFinishPolicy: assignment.earlyFinishPolicy ?? 'scheduled_end',
              earlyFinishOffsetMinutes: assignment.earlyFinishOffsetMinutes ?? null
            })
          )
        )

        const occurrences = (await transaction.table('cashier_shift_occurrences').toArray()) as CashierShiftOccurrence[]
        await Promise.all(
          occurrences.map((occurrence) =>
            transaction.table('cashier_shift_occurrences').update(occurrence.id, {
              assignmentMode: occurrence.assignmentMode ?? 'scheduled',
              scheduledStartAt: occurrence.scheduledStartAt ?? null,
              scheduledEndAt: occurrence.scheduledEndAt ?? null,
              earlyFinishPolicy: occurrence.earlyFinishPolicy ?? 'scheduled_end',
              earlyFinishOffsetMinutes: occurrence.earlyFinishOffsetMinutes ?? null
            })
          )
        )
      })

    this.version(110).stores({
      expense_categories:
        'id, workspaceId, name, updatedAt, isDeleted, syncStatus, [workspaceId+name], [workspaceId+updatedAt]',
      expense_series: 'id, workspaceId, categoryId, recurrence, startMonth, endMonth, isDeleted'
    })

    this.version(111)
      .stores({
        suppliers:
          'id, partnerName, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        customers:
          'id, partnerName, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
        business_partners:
          'id, partnerName, workspaceId, role, customerFacetId, supplierFacetId, agentFacetId, priceBookId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId, latitude, longitude'
      })
      .upgrade(async (tx) => {
        const toPartnerName = (row: Record<string, unknown>) => {
          const current = typeof row.partnerName === 'string' ? row.partnerName.trim() : ''
          const historical = typeof row.name === 'string' ? row.name.trim() : ''
          return current || historical || 'Unnamed partner'
        }
        const migrateRows = async (tableName: 'business_partners' | 'customers' | 'suppliers') => {
          const rows = (await tx.table(tableName).toArray()) as Array<Record<string, unknown>>
          if (rows.length > 0) {
            await tx.table(tableName).bulkPut(
              rows.map((row) => ({
                ...row,
                partnerName: toPartnerName(row)
              }))
            )
          }
        }
        const migrateQueuedPayloads = async (
          tableName: 'offline_mutations' | 'syncQueue',
          field: 'payload' | 'data'
        ) => {
          const rows = (await tx.table(tableName).toArray()) as Array<Record<string, unknown>>
          const migrated = rows.map((row) => {
            const entityType = row.entityType
            const payload = row[field]
            if (
              (entityType !== 'business_partners' && entityType !== 'customers' && entityType !== 'suppliers') ||
              !payload ||
              typeof payload !== 'object' ||
              Array.isArray(payload)
            ) {
              return row
            }

            const nextPayload = payload as Record<string, unknown>
            return {
              ...row,
              [field]: {
                ...nextPayload,
                partnerName: toPartnerName(nextPayload)
              }
            }
          })
          if (migrated.length > 0) {
            await tx.table(tableName).bulkPut(migrated)
          }
        }

        await Promise.all([
          migrateRows('business_partners'),
          migrateRows('customers'),
          migrateRows('suppliers'),
          migrateQueuedPayloads('offline_mutations', 'payload'),
          migrateQueuedPayloads('syncQueue', 'data')
        ])
      })

    this.version(112)
      .stores({
        suppliers:
          'id, partnerName, workspaceId, businessPartnerId, phone, defaultCurrency, updatedAt, isDeleted, syncStatus',
        customers:
          'id, partnerName, workspaceId, businessPartnerId, phone, defaultCurrency, updatedAt, isDeleted, syncStatus',
        business_partners:
          'id, partnerName, workspaceId, role, customerFacetId, supplierFacetId, agentFacetId, priceBookId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId, latitude, longitude'
      })
      .upgrade(async (tx) => {
        const removeRetiredFields = (row: Record<string, unknown>) => {
          const { email: _email, country: _country, ...retained } = row
          return retained
        }
        const scrubRows = async (tableName: 'business_partners' | 'customers' | 'suppliers') => {
          const rows = (await tx.table(tableName).toArray()) as Array<Record<string, unknown>>
          if (rows.length > 0) {
            await tx.table(tableName).bulkPut(rows.map(removeRetiredFields))
          }
        }
        const scrubQueuedPayloads = async (tableName: 'offline_mutations' | 'syncQueue', field: 'payload' | 'data') => {
          const rows = (await tx.table(tableName).toArray()) as Array<Record<string, unknown>>
          const scrubbed = rows.map((row) => {
            const entityType = row.entityType
            const payload = row[field]
            if (
              (entityType !== 'business_partners' && entityType !== 'customers' && entityType !== 'suppliers') ||
              !payload ||
              typeof payload !== 'object' ||
              Array.isArray(payload)
            ) {
              return row
            }

            return {
              ...row,
              [field]: removeRetiredFields(payload as Record<string, unknown>)
            }
          })
          if (scrubbed.length > 0) {
            await tx.table(tableName).bulkPut(scrubbed)
          }
        }

        await Promise.all([
          scrubRows('business_partners'),
          scrubRows('customers'),
          scrubRows('suppliers'),
          scrubQueuedPayloads('offline_mutations', 'payload'),
          scrubQueuedPayloads('syncQueue', 'data')
        ])
      })

    this.version(113).stores({
      module_locker_settings: 'id, workspaceId',
      module_locker_locks: 'id, workspaceId, moduleHref, [workspaceId+moduleHref]',
      module_locker_audit: 'id, workspaceId, action, occurredAt, [workspaceId+occurredAt]'
    })

    this.version(114)
      .stores({
        travel_agency_sales: null
      })
      .upgrade(async (tx) => {
        const paymentTransactions = (await tx.table('payment_transactions').toArray()) as PaymentTransaction[]
        const retiredPayments = paymentTransactions.filter(
          (payment) =>
            (payment.sourceModule as string) === 'travel_agency' ||
            (payment.sourceType as string) === 'travel_agency_sale'
        )
        const retiredPaymentIds = new Set(retiredPayments.map((payment) => payment.id))

        const workspaces = (await tx.table('workspaces').toArray()) as Array<Record<string, unknown>>
        const workspacesToUpdate = workspaces.flatMap((workspace) => {
          if (!('travel_agency' in workspace)) return []
          const { travel_agency: _retiredModuleFlag, ...updatedWorkspace } = workspace
          return [updatedWorkspace]
        })
        const workspacePermissions = (await tx.table('workspace_permissions').toArray()) as WorkspacePermission[]
        const retiredPermissions = workspacePermissions.filter(
          (permission) => permission.module === 'travelAgency' || permission.key.startsWith('travelAgency.')
        )
        const retiredPermissionIds = new Set(retiredPermissions.map((permission) => permission.id))

        const offlineMutations = (await tx.table('offline_mutations').toArray()) as Array<Record<string, unknown>>
        const syncQueue = (await tx.table('syncQueue').toArray()) as Array<Record<string, unknown>>

        const isRetiredPayload = (payload: unknown) => {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
          const value = payload as Record<string, unknown>
          return (
            value.sourceModule === 'travel_agency' ||
            value.source_module === 'travel_agency' ||
            value.sourceType === 'travel_agency_sale' ||
            value.source_type === 'travel_agency_sale'
          )
        }
        const isRetiredQueueRow = (row: Record<string, unknown>, field: 'payload' | 'data') =>
          row.entityType === 'travel_agency_sales' ||
          (row.entityType === 'payment_transactions' && isRetiredPayload(row[field]))
        const stripRetiredWorkspaceFlag = (row: Record<string, unknown>, field: 'payload' | 'data') => {
          if (row.entityType !== 'workspaces') return null
          const value = row[field]
          if (!value || typeof value !== 'object' || Array.isArray(value) || !('travel_agency' in value)) return null
          const { travel_agency: _retiredModuleFlag, ...updatedPayload } = value as Record<string, unknown>
          return { ...row, [field]: updatedPayload }
        }

        const paymentAccountMovements = (await tx
          .table('payment_account_movements')
          .toArray()) as PaymentAccountMovement[]
        const retiredMovements = paymentAccountMovements.filter((movement) =>
          retiredPaymentIds.has(movement.paymentTransactionId)
        )
        const balanceDeltas = new Map<string, number>()
        for (const movement of retiredMovements) {
          if (movement.isDeleted) continue
          const key = `${movement.workspaceId}:${movement.accountId}:${movement.currency}`
          balanceDeltas.set(key, (balanceDeltas.get(key) ?? 0) + movement.deltaAmount)
        }

        const paymentAccountBalances = (await tx.table('payment_account_balances').toArray()) as PaymentAccountBalance[]
        const balancesToUpdate = paymentAccountBalances.flatMap((balance) => {
          const key = `${balance.workspaceId}:${balance.accountId}:${balance.currency}`
          const delta = balanceDeltas.get(key)
          if (!delta) return []
          return [
            {
              ...balance,
              balanceAmount: balance.balanceAmount - delta,
              updatedAt: new Date().toISOString(),
              version: balance.version + 1
            }
          ]
        })

        if (workspacesToUpdate.length) await tx.table('workspaces').bulkPut(workspacesToUpdate)
        if (retiredPermissions.length)
          await tx.table('workspace_permissions').bulkDelete(retiredPermissions.map((permission) => permission.id))
        if (balancesToUpdate.length) {
          await tx.table('payment_account_balances').bulkPut(balancesToUpdate)
        }
        if (retiredMovements.length) {
          await tx.table('payment_account_movements').bulkDelete(retiredMovements.map((movement) => movement.id))
        }
        if (retiredPayments.length) {
          await tx.table('payment_transactions').bulkDelete(retiredPayments.map((payment) => payment.id))
        }

        const retiredMovementIds = new Set(retiredMovements.map((movement) => movement.id))
        const retiredBalanceIds = new Set(balancesToUpdate.map((balance) => balance.id))
        const removeOfflineMutationIds = offlineMutations
          .filter(
            (row) =>
              isRetiredQueueRow(row, 'payload') ||
              (row.entityType === 'workspace_permissions' && retiredPermissionIds.has(String(row.entityId))) ||
              (row.entityType === 'payment_account_movements' && retiredMovementIds.has(String(row.entityId))) ||
              (row.entityType === 'payment_account_balances' && retiredBalanceIds.has(String(row.entityId)))
          )
          .map((row) => String(row.id))
        const removeSyncQueueIds = syncQueue
          .filter(
            (row) =>
              isRetiredQueueRow(row, 'data') ||
              (row.entityType === 'workspace_permissions' && retiredPermissionIds.has(String(row.entityId))) ||
              (row.entityType === 'payment_account_movements' && retiredMovementIds.has(String(row.entityId))) ||
              (row.entityType === 'payment_account_balances' && retiredBalanceIds.has(String(row.entityId)))
          )
          .map((row) => String(row.id))
        const offlineMutationsToUpdate = offlineMutations
          .map((row) => stripRetiredWorkspaceFlag(row, 'payload'))
          .filter((row): row is Record<string, unknown> => row !== null)
        const syncQueueToUpdate = syncQueue
          .map((row) => stripRetiredWorkspaceFlag(row, 'data'))
          .filter((row): row is Record<string, unknown> => row !== null)

        if (removeOfflineMutationIds.length) await tx.table('offline_mutations').bulkDelete(removeOfflineMutationIds)
        if (removeSyncQueueIds.length) await tx.table('syncQueue').bulkDelete(removeSyncQueueIds)
        if (offlineMutationsToUpdate.length) await tx.table('offline_mutations').bulkPut(offlineMutationsToUpdate)
        if (syncQueueToUpdate.length) await tx.table('syncQueue').bulkPut(syncQueueToUpdate)
      })

    this.version(115).stores({
      travel_bookings:
        'id, workspaceId, bookingNumber, status, currency, travelDate, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+status], [workspaceId+createdAt]',
      travel_passengers:
        'id, workspaceId, bookingId, transportationType, createdAt, updatedAt, isDeleted, syncStatus, [bookingId+transportationType], [workspaceId+bookingId]'
    })

    this.version(116).stores({
      delivery_shipment_recipient_payout_adjustment_requests:
        'id, workspaceId, shipmentId, requesterUserId, requesterAgentId, status, updatedAt, isDeleted, syncStatus, [workspaceId+shipmentId], [workspaceId+shipmentId+status], [workspaceId+requesterUserId], [workspaceId+status]'
    })

    this.version(118)
      .stores({
        delivery_shipment_settlement_obligations: null
      })
      .upgrade((tx) =>
        Promise.all([
          tx.table('offline_mutations').where('entityType').equals('delivery_shipment_settlement_obligations').delete(),
          tx.table('syncQueue').where('entityType').equals('delivery_shipment_settlement_obligations').delete()
        ])
      )

    this.version(119).stores({
      delivery_shipment_cod_corrections:
        'id, workspaceId, shipmentId, correctedBy, correctedAt, updatedAt, isDeleted, syncStatus, [workspaceId+shipmentId], [workspaceId+correctedAt], [shipmentId+correctedAt]'
    })

    this.version(120).stores({
      delivery_shipment_recipient_payout_corrections:
        'id, workspaceId, shipmentId, correctedBy, correctedAt, updatedAt, isDeleted, syncStatus, [workspaceId+shipmentId], [workspaceId+correctedAt], [shipmentId+correctedAt]'
    })

    this.version(121).stores({
      restaurant_table_settings: 'id, workspaceId, enabled, updatedAt, isDeleted, syncStatus, [workspaceId+enabled]',
      restaurant_pos_tickets:
        'id, workspaceId, tableNumber, status, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+tableNumber], [workspaceId+status], [workspaceId+updatedAt]'
    })

    this.version(122).stores({
      installment_sales:
        'id, workspaceId, saleNo, customerBusinessPartnerId, status, nextDueDate, createdAt, updatedAt, isDeleted, syncStatus, [workspaceId+status], [workspaceId+createdAt], [workspaceId+customerBusinessPartnerId]',
      installment_sale_installments:
        'id, workspaceId, installmentSaleId, dueDate, status, updatedAt, isDeleted, syncStatus, [installmentSaleId+installmentNo], [workspaceId+installmentSaleId]',
      installment_sale_payments:
        'id, workspaceId, installmentSaleId, installmentId, paidAt, updatedAt, isDeleted, syncStatus, [workspaceId+installmentSaleId]'
    })

    this.version(123).stores({
      installment_sale_supplier_payments: null
    })

    this.version(124).stores({
      capital_pools:
        'id, workspaceId, name, currency, updatedAt, isDeleted, syncStatus, [workspaceId+name], [workspaceId+currency], *accountIds'
    })

    this.version(125).stores({
      payment_transactions:
        'id, workspaceId, paidAt, accountId, cashierShiftOccurrenceId, sourceModule, sourceType, sourceRecordId, sourceSubrecordId, direction, reversalOfTransactionId, voidId, updatedAt, isDeleted, syncStatus, [workspaceId+paidAt], [workspaceId+accountId], [workspaceId+cashierShiftOccurrenceId], [workspaceId+sourceType+sourceRecordId], [workspaceId+voidId]',
      financial_transaction_voids:
        'id, workspaceId, rootPaymentTransactionId, sourceModule, sourceType, sourceRecordId, voidedBy, voidedAt, updatedAt, [workspaceId+voidedAt], [workspaceId+sourceType+sourceRecordId]',
      expense_series:
        'id, workspaceId, name, recurrence, startMonth, endMonth, categoryId, voidId, updatedAt, isDeleted, syncStatus, [workspaceId+name], [workspaceId+voidId]',
      expense_items:
        'id, workspaceId, seriesId, month, dueDate, status, voidId, updatedAt, isDeleted, syncStatus, [seriesId+month], [workspaceId+month], [workspaceId+voidId]',
      payment_account_movements:
        'id, workspaceId, accountId, paymentTransactionId, currency, occurredAt, voidId, updatedAt, isDeleted, syncStatus, [workspaceId+accountId], [accountId+occurredAt], [workspaceId+occurredAt], [workspaceId+voidId]'
    })

    this.registerLocalModeSqliteAuthority()
    this.registerLocalModeSyncHooks()
  }

  private registerLocalModeSqliteAuthority() {
    const database = this

    this.use({
      stack: 'dbcore',
      name: 'LocalModeSqliteAuthority',
      level: 1,
      create(down: DBCore) {
        return {
          ...down,
          table(tableName: string) {
            const downTable = down.table(tableName)
            if (!isMirroredSqliteTable(tableName)) {
              return downTable
            }

            return {
              ...downTable,
              mutate(request: DBCoreMutateRequest) {
                return readRowsBeforeMutation(downTable, request).then((rows) =>
                  downTable.mutate(request).then((response) => {
                    const successfulRows = successfulMutationRows(request, response, rows)
                    const mutations = buildSqliteMutations(tableName, request, successfulRows)
                    if (mutations.length === 0) {
                      return response
                    }

                    const context = localModeSqliteTransactions.get(request.trans as object)
                    if (context) {
                      context.mutations.push(...mutations)
                      return response
                    }

                    return Dexie.waitFor(commitLocalModeSqliteMutations(database, mutations)).then(
                      () => response,
                      (error) => {
                        request.trans.abort()
                        throw error
                      }
                    )
                  })
                )
              }
            }
          }
        }
      }
    })

    const originalTransaction = this.transaction.bind(this) as (mode: string, ...args: unknown[]) => Promise<unknown>

    this.transaction = ((mode: string, ...args: unknown[]) => {
      const scope = args.pop()
      if (typeof scope !== 'function') {
        return originalTransaction(mode, ...args, scope)
      }

      return originalTransaction(mode, ...args, async (transaction: Transaction) => {
        const isReadWrite = mode === 'readwrite' || mode.startsWith('rw')
        const transactionKey = (transaction as Transaction & { idbtrans?: object }).idbtrans
        if (!isReadWrite || !transactionKey) {
          return scope(transaction)
        }

        const existingContext = localModeSqliteTransactions.get(transactionKey)
        if (existingContext) {
          return scope(transaction)
        }

        const context: LocalModeSqliteTransactionContext = { mutations: [] }
        localModeSqliteTransactions.set(transactionKey, context)
        try {
          const result = await scope(transaction)
          if (context.mutations.length > 0) {
            await Dexie.waitFor(commitLocalModeSqliteMutations(database, context.mutations))
          }
          return result
        } catch (error) {
          try {
            transaction.abort()
          } catch {
            // The IndexedDB transaction may already be aborting.
          }
          throw error
        } finally {
          localModeSqliteTransactions.delete(transactionKey)
        }
      })
    }) as typeof this.transaction
  }

  private registerLocalModeSyncHooks() {
    const database = this
    const syncAwareTables = [
      'products',
      'product_barcodes',
      'price_books',
      'price_book_items',
      'categories',
      'units',
      'invoices',
      'invoice_versions',
      'users',
      'sales',
      'sales_exchange',
      'sale_returns',
      'sale_return_items',
      'sale_product_exchanges',
      'order_returns',
      'order_return_items',
      'workspaces',
      'storages',
      'inventory',
      'inventory_transactions',
      'stock_batches',
      'product_discounts',
      'category_discounts',
      'inventory_transfer_transactions',
      'reorder_transfer_rules',
      'suppliers',
      'customers',
      'agents',
      'agent_commission_plans',
      'agent_commission_memberships',
      'product_commission_rules',
      'product_commission_rule_agents',
      'sales_order_agent_assignments',
      'agent_commission_entries',
      'agent_product_commission_entries',
      'fleet_vehicles',
      'fleet_vehicle_assignments',
      'rental_vehicles',
      'rental_requests',
      'rental_contracts',
      'delivery_merchant_profiles',
      'delivery_shipments',
      'delivery_shipment_events',
      'delivery_shipment_cod_adjustment_requests',
      'delivery_shipment_cod_corrections',
      'delivery_shipment_recipient_payout_corrections',
      'delivery_shipment_recipient_payout_adjustment_requests',
      'delivery_runs',
      'delivery_run_items',
      'delivery_settlements',
      'delivery_ledger_entries',
      'business_partners',
      'employees',
      'workspace_contacts',
      'loans',
      'loan_installments',
      'loan_payments',
      'installment_sales',
      'installment_sale_installments',
      'installment_sale_payments',
      'payment_transactions',
      'financial_transaction_voids',
      'payment_accounts',
      'capital_pools',
      'payment_account_balances',
      'payment_account_movements',
      'cashier_shifts',
      'cashier_shift_currency_counts',
      'cashier_shift_templates',
      'cashier_shift_assignments',
      'cashier_shift_occurrences',
      'sales_orders',
      'purchase_orders',
      'order_installments',
      'real_estate_transactions',
      'real_estate_installments',
      'real_estate_payments',
      'exchange_pair_prices',
      'exchange_transactions',
      'exchange_fee_rules',
      'fx_safes',
      'fx_safe_balances',
      'fx_safe_movements',
      'clinical_appointments',
      'clinical_patients',
      'clinical_attachments',
      'clinical_presets',
      'budget_settings',
      'budget_allocations',
      'expense_categories',
      'expense_series',
      'expense_items',
      'payroll_statuses',
      'dividend_statuses'
    ] as const

    const normalizeSyncMetadata = (workspaceId?: string | null) => {
      if (!workspaceId || !isLocalWorkspaceMode(workspaceId)) {
        return null
      }

      return {
        syncStatus: 'synced',
        lastSyncedAt: new Date().toISOString()
      }
    }

    for (const tableName of syncAwareTables) {
      const table = this.table(tableName)

      table.hook('creating', function (_primaryKey, obj) {
        if (!obj || typeof obj !== 'object') {
          return
        }

        const normalized = normalizeSyncMetadata((obj as { workspaceId?: string }).workspaceId)
        if (normalized) {
          Object.assign(obj, normalized)
        }

        this.onsuccess = () => {
          queueLocalModeSqliteUpsert(database, tableName, obj as Record<string, unknown>)
        }
      })

      table.hook('updating', function (mods, _primaryKey, obj) {
        const nextWorkspaceId = (mods as { workspaceId?: unknown }).workspaceId
        const normalized = normalizeSyncMetadata(
          typeof nextWorkspaceId === 'string'
            ? nextWorkspaceId
            : (obj as { workspaceId?: string } | undefined)?.workspaceId
        )

        this.onsuccess = (updatedObj) => {
          queueLocalModeSqliteUpsert(database, tableName, updatedObj as Record<string, unknown>)
        }

        if (!normalized) {
          return mods
        }

        return {
          ...mods,
          ...normalized
        }
      })

      table.hook('deleting', function (_primaryKey, obj) {
        if (!obj || typeof obj !== 'object') {
          return
        }

        this.onsuccess = () => {
          queueLocalModeSqliteDelete(database, tableName, obj as Record<string, unknown>)
        }
      })
    }

    for (const tableName of LOCAL_MODE_SQLITE_TABLES) {
      if (syncAwareTables.includes(tableName as (typeof syncAwareTables)[number])) {
        continue
      }

      const table = this.table(tableName)

      table.hook('creating', function (_primaryKey, obj) {
        if (!obj || typeof obj !== 'object') {
          return
        }

        this.onsuccess = () => {
          queueLocalModeSqliteUpsert(database, tableName, obj as Record<string, unknown>)
        }
      })

      table.hook('updating', function (_mods, _primaryKey, _obj) {
        this.onsuccess = (updatedObj) => {
          queueLocalModeSqliteUpsert(database, tableName, updatedObj as Record<string, unknown>)
        }
      })

      table.hook('deleting', function (_primaryKey, obj) {
        if (!obj || typeof obj !== 'object') {
          return
        }

        this.onsuccess = () => {
          queueLocalModeSqliteDelete(database, tableName, obj as Record<string, unknown>)
        }
      })
    }
  }
}

// Singleton database instance
export const db = new AtlasDatabase()

// Database utility functions
export async function clearDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.products,
      db.product_barcodes,
      db.price_books,
      db.price_book_items,
      db.inventory,
      db.inventory_transactions,
      db.stock_batches,
      db.product_discounts,
      db.category_discounts,
      db.inventory_transfer_transactions,
      db.reorder_transfer_rules,
      db.categories,
      db.invoices,
      db.invoice_versions,
      db.real_estate_transactions,
      db.real_estate_installments,
      db.real_estate_payments,
      db.activity_catalog,
      db.activity_transactions,
      db.activity_transaction_lines,
      db.exchange_pair_prices,
      db.exchange_transactions,
      db.exchange_fee_rules,
      db.fx_safes,
      db.fx_safe_balances,
      db.fx_safe_movements,
      db.clinical_appointments,
      db.clinical_patients,
      db.clinical_attachments,
      db.clinical_presets,
      db.manual_entry_templates,
      db.manual_entries,
      db.fleet_vehicles,
      db.fleet_vehicle_assignments,
      db.rental_vehicles,
      db.rental_requests,
      db.rental_contracts,
      db.delivery_merchant_profiles,
      db.delivery_shipments,
      db.delivery_shipment_events,
      db.delivery_shipment_cod_adjustment_requests,
      db.delivery_shipment_cod_corrections,
      db.delivery_shipment_recipient_payout_corrections,
      db.delivery_shipment_recipient_payout_adjustment_requests,
      db.delivery_runs,
      db.delivery_run_items,
      db.delivery_settlements,
      db.delivery_ledger_entries,
      db.payment_transactions,
      db.financial_transaction_voids,
      db.payment_accounts,
      db.capital_pools,
      db.payment_account_balances,
      db.payment_account_movements,
      db.cashier_shifts,
      db.cashier_shift_currency_counts,
      db.cashier_shift_templates,
      db.cashier_shift_assignments,
      db.cashier_shift_occurrences,
      db.order_installments,
      db.order_returns,
      db.order_return_items,
      db.sale_product_exchanges,
      db.agent_commission_entries,
      db.agent_product_commission_entries,
      db.sales_order_agent_assignments,
      db.agent_commission_memberships,
      db.agent_commission_plans,
      db.product_commission_rule_agents,
      db.product_commission_rules,
      db.syncQueue
    ],
    async () => {
      await db.products.clear()
      await db.product_barcodes.clear()
      await db.price_books.clear()
      await db.price_book_items.clear()
      await db.inventory.clear()
      await db.inventory_transactions.clear()
      await db.stock_batches.clear()
      await db.product_discounts.clear()
      await db.category_discounts.clear()
      await db.inventory_transfer_transactions.clear()
      await db.reorder_transfer_rules.clear()
      await db.categories.clear()
      await db.invoices.clear()
      await db.invoice_versions.clear()
      await db.real_estate_transactions.clear()
      await db.real_estate_installments.clear()
      await db.real_estate_payments.clear()
      await db.activity_catalog.clear()
      await db.activity_transactions.clear()
      await db.activity_transaction_lines.clear()
      await db.exchange_pair_prices.clear()
      await db.exchange_transactions.clear()
      await db.exchange_fee_rules.clear()
      await db.fx_safes.clear()
      await db.fx_safe_balances.clear()
      await db.fx_safe_movements.clear()
      await db.clinical_appointments.clear()
      await db.clinical_patients.clear()
      await db.clinical_attachments.clear()
      await db.clinical_presets.clear()
      await db.manual_entry_templates.clear()
      await db.manual_entries.clear()
      await db.fleet_vehicles.clear()
      await db.fleet_vehicle_assignments.clear()
      await db.rental_vehicles.clear()
      await db.rental_requests.clear()
      await db.rental_contracts.clear()
      await db.delivery_merchant_profiles.clear()
      await db.delivery_shipments.clear()
      await db.delivery_shipment_events.clear()
      await db.delivery_shipment_cod_adjustment_requests.clear()
      await db.delivery_shipment_cod_corrections.clear()
      await db.delivery_shipment_recipient_payout_corrections.clear()
      await db.delivery_shipment_recipient_payout_adjustment_requests.clear()
      await db.delivery_runs.clear()
      await db.delivery_run_items.clear()
      await db.delivery_settlements.clear()
      await db.delivery_ledger_entries.clear()
      await db.payment_transactions.clear()
      await db.financial_transaction_voids.clear()
      await db.payment_accounts.clear()
      await db.capital_pools.clear()
      await db.payment_account_balances.clear()
      await db.payment_account_movements.clear()
      await db.cashier_shifts.clear()
      await db.cashier_shift_currency_counts.clear()
      await db.cashier_shift_templates.clear()
      await db.cashier_shift_assignments.clear()
      await db.cashier_shift_occurrences.clear()
      await db.order_installments.clear()
      await db.order_returns.clear()
      await db.order_return_items.clear()
      await db.sale_product_exchanges.clear()
      await db.agent_commission_entries.clear()
      await db.agent_product_commission_entries.clear()
      await db.sales_order_agent_assignments.clear()
      await db.agent_commission_memberships.clear()
      await db.agent_commission_plans.clear()
      await db.product_commission_rule_agents.clear()
      await db.product_commission_rules.clear()
      await db.syncQueue.clear()
    }
  )
}

export async function exportDatabase(): Promise<{
  products: Product[]
  invoices: Invoice[]
}> {
  const [products, invoices] = await Promise.all([
    db.products
      .where('isDeleted')
      .equals(false as any)
      .toArray(),
    db.invoices
      .where('isDeleted')
      .equals(false as any)
      .toArray()
  ])

  return { products, invoices }
}

// Get pending sync count
export async function getPendingSyncCount(): Promise<number> {
  return await db.syncQueue.count()
}
