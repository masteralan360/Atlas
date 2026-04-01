// Data Models for Atlas
// All entities include sync metadata for offline-first architecture

export type SyncStatus = 'pending' | 'synced' | 'conflict'

export type UserRole = 'admin' | 'staff' | 'viewer'

export type CurrencyCode = 'usd' | 'eur' | 'iqd' | 'try'
export type WorkspaceDataMode = 'cloud' | 'local' | 'hybrid'

export type PaymentMethod = 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay' | 'loan'
export type LoanPaymentMethod = PaymentMethod | 'loan_adjustment' | 'bank_transfer'
export type WorkspacePaymentMethod = LoanPaymentMethod | 'credit' | 'bank_transfer' | 'unknown'

export type IQDDisplayPreference = 'IQD' | 'د.ع'

export interface SyncMetadata {
    syncStatus: SyncStatus
    lastSyncedAt: string | null
    version: number
    isDeleted: boolean
}

export interface BaseEntity extends SyncMetadata {
    id: string
    workspaceId: string
    createdAt: string
    updatedAt: string
}

export interface User extends BaseEntity {
    email: string
    name: string
    role: UserRole
    profileUrl?: string
    monthlyTarget?: number
    monthlyProgress?: number
}

export interface Product extends BaseEntity {
    sku: string
    name: string
    description: string
    categoryId?: string | null
    category?: string
    storageId?: string | null
    storageName?: string
    price: number
    costPrice: number
    quantity: number
    minStockLevel: number
    unit: string
    currency: CurrencyCode
    barcode?: string
    imageUrl?: string
    canBeReturned: boolean
    returnRules?: string
}


export interface Category extends BaseEntity {
    name: string
    description?: string
}

export interface Storage extends BaseEntity {
    name: string
    isSystem: boolean
    isProtected: boolean
}

export interface Inventory extends BaseEntity {
    productId: string
    storageId: string
    quantity: number
}

export interface ReorderTransferRule extends BaseEntity {
    productId: string
    sourceStorageId: string
    destinationStorageId: string
    minStockLevel: number
    transferQuantity: number
    expiresOn?: string | null
    isIndefinite: boolean
    lastTriggeredAt?: string | null
}

export type InventoryTransferTransactionType = 'manual' | 'automation'

export interface InventoryTransferTransaction extends BaseEntity {
    productId: string
    sourceStorageId: string
    destinationStorageId: string
    quantity: number
    transferType: InventoryTransferTransactionType
    reorderRuleId?: string | null
}

export interface Supplier extends BaseEntity {
    businessPartnerId?: string | null
    name: string
    contactName?: string
    email?: string
    phone?: string
    address?: string
    city?: string
    country?: string
    defaultCurrency: CurrencyCode
    notes?: string
    totalPurchases: number
    totalSpent: number
    creditLimit: number
    isEcommerce?: boolean
}

export interface Customer extends BaseEntity {
    businessPartnerId?: string | null
    name: string
    email?: string
    phone?: string
    address?: string
    city?: string
    country?: string
    defaultCurrency: CurrencyCode
    notes?: string
    totalOrders: number
    totalSpent: number
    outstandingBalance: number
    creditLimit: number
    isEcommerce?: boolean
}

export type BusinessPartnerRole = 'customer' | 'supplier' | 'both'

export interface BusinessPartner extends BaseEntity {
    name: string
    contactName?: string
    email?: string
    phone?: string
    address?: string
    city?: string
    country?: string
    defaultCurrency: CurrencyCode
    notes?: string
    role: BusinessPartnerRole
    creditLimit: number
    customerFacetId?: string | null
    supplierFacetId?: string | null
    totalSalesOrders: number
    totalSalesValue: number
    receivableBalance: number
    totalPurchaseOrders: number
    totalPurchaseValue: number
    payableBalance: number
    totalLoanCount: number
    loanOutstandingBalance: number
    netExposure: number
    mergedIntoBusinessPartnerId?: string | null
    isEcommerce?: boolean
}

export type BusinessPartnerMergeType = 'customer_supplier'
export type BusinessPartnerMergeStatus = 'pending' | 'accepted' | 'dismissed'

export interface BusinessPartnerMergeCandidate extends BaseEntity {
    primaryPartnerId: string
    secondaryPartnerId: string
    mergeType: BusinessPartnerMergeType
    reason: string
    confidence: number
    status: BusinessPartnerMergeStatus
}

export type SalesOrderStatus = 'draft' | 'pending' | 'completed' | 'cancelled'
export type PurchaseOrderStatus = 'draft' | 'ordered' | 'received' | 'completed' | 'cancelled'
export type OrderPaymentMethod = PaymentMethod | 'credit' | 'bank_transfer'
export type WorkspaceVisibility = 'private' | 'public'
export type MarketplaceOrderStatus = 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled'

export interface ExchangeRateSnapshot {
    pair: string
    rate: number
    source: string
    timestamp: string
}

export interface OrderLineItem {
    id: string
    productId: string
    storageId?: string | null
    productName: string
    productSku: string
    quantity: number
    lineTotal: number
    originalCurrency: CurrencyCode
    originalUnitPrice: number
    convertedUnitPrice: number
    settlementCurrency: CurrencyCode
}

export interface SalesOrderItem extends OrderLineItem {
    costPrice: number
    convertedCostPrice: number
    reservedQuantity?: number
    fulfilledQuantity?: number
}

export interface PurchaseOrderItem extends OrderLineItem {
    receivedQuantity?: number
}

export interface SalesOrder extends BaseEntity {
    orderNumber: string
    businessPartnerId?: string | null
    customerId: string
    customerName: string
    sourceStorageId?: string | null
    items: SalesOrderItem[]
    subtotal: number
    discount: number
    tax: number
    total: number
    currency: CurrencyCode
    exchangeRate: number
    exchangeRateSource: string
    exchangeRateTimestamp: string
    exchangeRates?: ExchangeRateSnapshot[]
    status: SalesOrderStatus
    expectedDeliveryDate?: string | null
    actualDeliveryDate?: string | null
    isPaid: boolean
    paidAt?: string | null
    paymentMethod?: OrderPaymentMethod
    reservedAt?: string | null
    shippingAddress?: string
    notes?: string
    isLocked?: boolean
    sourceChannel?: 'manual' | 'marketplace' | null
    marketplaceOrderId?: string | null
}

export interface PurchaseOrder extends BaseEntity {
    orderNumber: string
    businessPartnerId?: string | null
    supplierId: string
    supplierName: string
    destinationStorageId?: string | null
    items: PurchaseOrderItem[]
    subtotal: number
    discount: number
    total: number
    currency: CurrencyCode
    exchangeRate: number
    exchangeRateSource: string
    exchangeRateTimestamp: string
    exchangeRates?: ExchangeRateSnapshot[]
    status: PurchaseOrderStatus
    expectedDeliveryDate?: string | null
    actualDeliveryDate?: string | null
    isPaid: boolean
    paidAt?: string | null
    paymentMethod?: OrderPaymentMethod
    notes?: string
    isLocked?: boolean
}

export interface MarketplaceOrderItem {
    productId: string
    storageId?: string | null
    name: string
    sku: string
    unitPrice: number
    currency: CurrencyCode
    quantity: number
    lineTotal: number
    imageUrl?: string | null
}

export interface MarketplaceOrder extends BaseEntity {
    orderNumber: string
    orderSequence: number
    customerName: string
    customerPhone: string
    customerEmail?: string | null
    customerAddress?: string | null
    customerCity?: string | null
    customerNotes?: string | null
    items: MarketplaceOrderItem[]
    subtotal: number
    total: number
    currency: CurrencyCode
    status: MarketplaceOrderStatus
    confirmedAt?: string | null
    processingAt?: string | null
    shippedAt?: string | null
    deliveredAt?: string | null
    cancelledAt?: string | null
    cancelReason?: string | null
    inventoryDeducted: boolean
    businessPartnerId?: string | null
    customerId?: string | null
    salesOrderId?: string | null
}

export type TravelAgencyTravelMethod = 'bus' | 'plane' | 'train' | 'car' | 'ship' | 'hotel' | 'other'
export type TravelAgencyTripType = 'one_way' | 'round_trip'
export type TravelAgencyPaymentMethod = 'cash' | 'fib' | 'qicard' | 'hawala' | 'fastpay'
export type TravelAgencyReceiver = 'office' | 'erbil'
export type TravelAgencySaleStatus = 'completed' | 'draft'

export interface TravelAgencyTravelPlan {
    method: TravelAgencyTravelMethod
    departure?: string
    arrival?: string
    tripType?: TravelAgencyTripType
    details?: string
}

export interface TravelAgencyTourist {
    id: string
    fullName: string
    surname: string
    dateOfBirth?: string
    travelPlans: TravelAgencyTravelPlan[]
    revenue: number
    notes?: string
}

export interface TravelAgencySale extends BaseEntity {
    saleNumber: string
    saleDate: string
    status: TravelAgencySaleStatus
    touristCount: number
    tourists: TravelAgencyTourist[]
    groupTravelPlans: TravelAgencyTravelPlan[]
    groupName?: string | null
    groupRevenue: number
    businessPartnerId?: string | null
    supplierId?: string | null
    supplierName?: string | null
    supplierCost: number
    currency: CurrencyCode
    travelPackages: string[]
    paymentMethod: TravelAgencyPaymentMethod
    paidAmount: number
    receiver: TravelAgencyReceiver
    notes?: string
    isPaid: boolean
    paidAt?: string | null
    isLocked?: boolean
    // Financial snapshot — locked at save time
    snapshotRevenue?: number | null
    snapshotCost?: number | null
    snapshotProfit?: number | null
    // Exchange rate snapshot
    exchangeRateSnapshot?: {
        pair: string
        rate: number
        source: string
        timestamp: string
    } | null
}


export interface Employee extends BaseEntity {
    name: string
    email?: string
    phone?: string
    gender?: 'male' | 'female' | 'other'
    role: string // Internal labeling role. Format: "Category:Role" (e.g. "Management:Manager", "Staff:Salesman")
    location?: string
    joiningDate: string
    salary: number
    salaryCurrency: CurrencyCode
    hasDividends?: boolean
    dividendType?: 'fixed' | 'percentage'
    dividendAmount?: number
    dividendCurrency?: CurrencyCode
    salaryPayday?: number
    dividendPayday?: number
    isFired?: boolean
    linkedUserId?: string
}

export type BudgetStatus = 'pending' | 'snoozed' | 'paid'
export type ExpenseRecurrence = 'monthly' | 'one_time'

export interface BudgetSettings extends BaseEntity {
    startMonth: string
}

export interface BudgetAllocation extends BaseEntity {
    month: string
    currency: CurrencyCode
    allocationType?: 'fixed' | 'percentage'
    allocationValue?: number
}

export interface ExpenseSeries extends BaseEntity {
    name: string
    amount: number
    currency: CurrencyCode
    dueDay: number
    recurrence: ExpenseRecurrence
    startMonth: string
    endMonth?: string | null
    category?: string | null
    subcategory?: string | null
}

export interface ExpenseItem extends BaseEntity {
    seriesId: string
    month: string
    dueDate: string
    amount: number
    currency: CurrencyCode
    status: BudgetStatus
    snoozedUntil?: string | null
    snoozedIndefinite?: boolean
    snoozeCount?: number
    paidAt?: string | null
    isLocked?: boolean
}

export interface PayrollStatus extends BaseEntity {
    employeeId: string
    month: string
    status: BudgetStatus
    snoozedUntil?: string | null
    snoozedIndefinite?: boolean
    snoozeCount?: number
    paidAt?: string | null
    isLocked?: boolean
}

export interface DividendStatus extends BaseEntity {
    employeeId: string
    month: string
    status: BudgetStatus
    snoozedUntil?: string | null
    snoozedIndefinite?: boolean
    snoozeCount?: number
    paidAt?: string | null
    isLocked?: boolean
}

// Order Items (Unified logic for base items, but separated for type safety)


// Legacy OrderItem for Invoice compatibility (to be refactored or kept for snapshots)
export interface OrderItem {
    productId: string
    productName: string
    quantity: number
    unitPrice: number
    total: number
    currency: CurrencyCode
}

export type InvoiceStatus = 'sent' | 'paid' | 'overdue' | 'cancelled' | 'draft'

export interface Invoice extends BaseEntity {
    invoiceid: string;
    orderId?: string;
    customerId?: string;
    status?: InvoiceStatus;
    // Total amount in settlement currency
    totalAmount: number;
    settlementCurrency: CurrencyCode;
    // Print-to-Invoice tracking
    origin?: 'pos' | 'instant_pos' | 'revenue' | 'inventory' | 'manual' | 'loans' | 'Loans' | 'sales_order' | 'travel_agency';
    /** @deprecated Use cashierName for the name string. createdBy might map to system UUID. */
    createdBy?: string;
    cashierName?: string;
    createdByName?: string;
    sequenceId?: number;
    printFormat?: 'a4' | 'receipt';
    // PDF Storage (R2)
    r2PathA4?: string;
    r2PathReceipt?: string;
    // Local PDF Storage (AppData)
    localPathA4?: string;
    localPathReceipt?: string;
    // Local PDF Blob (pending upload)
    pdfBlobA4?: Blob;
    pdfBlobReceipt?: Blob;
}


export interface Sale extends BaseEntity {
    cashierId: string
    totalAmount: number
    settlementCurrency: CurrencyCode
    exchangeSource: string | null
    exchangeRate: number | null
    exchangeRateTimestamp: string | null
    exchangeRates?: any[] | null
    origin: string
    payment_method?: PaymentMethod
    // Sequential ID (generated by server)
    sequenceId?: number
    // System Verification (offline-first, immutable)
    systemVerified: boolean
    systemReviewStatus: 'approved' | 'flagged' | 'inconsistent'
    systemReviewReason: string | null
    isReturned?: boolean
    notes?: string
}

export interface SaleItem {
    id: string
    saleId: string
    productId: string
    storageId?: string | null
    quantity: number
    unitPrice: number
    totalPrice: number
    costPrice: number
    convertedCostPrice: number
    originalCurrency: CurrencyCode
    originalUnitPrice: number
    convertedUnitPrice: number
    settlementCurrency: CurrencyCode
    negotiatedPrice?: number
    // Immutable inventory snapshot at checkout
    inventorySnapshot: number
    returnedQuantity?: number
}

export type LoanSource = 'pos' | 'manual'
export type LoanCategory = 'standard' | 'simple'
export type LoanDirection = 'lent' | 'borrowed'
export type LoanStatus = 'active' | 'overdue' | 'completed'
export type InstallmentStatus = 'unpaid' | 'partial' | 'paid' | 'overdue'
export type InstallmentFrequency = 'weekly' | 'biweekly' | 'monthly'
export type LoanLinkedPartyType = 'business_partner'

export interface Loan extends BaseEntity {
    saleId?: string | null
    loanNo: string
    source: LoanSource
    loanCategory?: LoanCategory
    direction?: LoanDirection
    linkedPartyType?: LoanLinkedPartyType | null
    linkedPartyId?: string | null
    linkedPartyName?: string | null
    borrowerName: string
    borrowerPhone: string
    borrowerAddress: string
    borrowerNationalId: string
    principalAmount: number
    totalPaidAmount: number
    balanceAmount: number
    settlementCurrency: CurrencyCode
    installmentCount: number
    installmentFrequency: InstallmentFrequency
    firstDueDate: string
    nextDueDate?: string | null
    overdueReminderSnoozedAt?: string | null
    overdueReminderSnoozedForDueDate?: string | null
    status: LoanStatus
    notes?: string
    createdBy?: string
}

export interface LoanInstallment extends BaseEntity {
    loanId: string
    installmentNo: number
    dueDate: string
    plannedAmount: number
    paidAmount: number
    balanceAmount: number
    status: InstallmentStatus
    paidAt?: string | null
}

export interface LoanPayment extends BaseEntity {
    loanId: string
    amount: number
    paymentMethod: LoanPaymentMethod
    paidAt: string
    note?: string
    createdBy?: string
}

export type PaymentTransactionSourceModule = 'loans' | 'orders' | 'budget' | 'payments'
export type PaymentTransactionSourceType =
    | 'loan_payment'
    | 'simple_loan'
    | 'loan_installment'
    | 'sales_order'
    | 'purchase_order'
    | 'expense_item'
    | 'payroll_status'
    | 'direct_transaction'
export type PaymentTransactionDirection = 'incoming' | 'outgoing'

export interface PaymentTransaction extends BaseEntity {
    sourceModule: PaymentTransactionSourceModule
    sourceType: PaymentTransactionSourceType
    sourceRecordId: string
    sourceSubrecordId?: string | null
    direction: PaymentTransactionDirection
    amount: number
    currency: CurrencyCode
    paymentMethod: WorkspacePaymentMethod
    paidAt: string
    counterpartyName?: string | null
    referenceLabel?: string | null
    note?: string | null
    createdBy?: string | null
    reversalOfTransactionId?: string | null
    metadata?: Record<string, unknown> | null
}

export interface PaymentObligation {
    id: string
    workspaceId: string
    sourceModule: PaymentTransactionSourceModule
    sourceType: PaymentTransactionSourceType
    sourceRecordId: string
    sourceSubrecordId?: string | null
    direction: PaymentTransactionDirection
    amount: number
    currency: CurrencyCode
    dueDate: string
    counterpartyName?: string | null
    referenceLabel?: string | null
    title: string
    subtitle?: string | null
    status: 'open' | 'overdue'
    routePath: string
    metadata?: Record<string, unknown> | null
}


// Sync Queue Item for tracking pending changes
export interface SyncQueueItem {
    id: string
    entityType: 'products' | 'inventory' | 'reorder_transfer_rules' | 'inventory_transfer_transactions' | 'invoices' | 'users' | 'sales' | 'categories' | 'storages' | 'employees' | 'workspace_contacts' | 'loans' | 'loan_installments' | 'loan_payments' | 'payment_transactions' | 'budget_settings' | 'budget_allocations' | 'expense_series' | 'expense_items' | 'payroll_statuses' | 'dividend_statuses' | 'customers' | 'suppliers' | 'business_partners' | 'business_partner_merge_candidates' | 'sales_orders' | 'purchase_orders' | 'travel_agency_sales'
    entityId: string
    operation: 'create' | 'update' | 'delete'
    data: Record<string, unknown>
    timestamp: string
    retryCount: number
}

// Offline Mutation for manual sync queue
export type MutationStatus = 'pending' | 'syncing' | 'failed' | 'synced'

export interface Workspace extends BaseEntity {
    name: string
    code: string
    data_mode: WorkspaceDataMode
    is_configured?: boolean
    // Module toggles
    pos: boolean
    instant_pos?: boolean
    sales_history?: boolean
    crm?: boolean
    travel_agency?: boolean
    loans?: boolean
    net_revenue?: boolean
    budget?: boolean
    monthly_comparison?: boolean
    team_performance?: boolean
    products?: boolean
    storages?: boolean
    inventory_transfer?: boolean
    invoices_history: boolean
    hr?: boolean
    members?: boolean
    ecommerce?: boolean
    // Settings
    default_currency: CurrencyCode
    iqd_display_preference: IQDDisplayPreference
    eur_conversion_enabled?: boolean
    try_conversion_enabled?: boolean
    locked_workspace: boolean
    allow_whatsapp?: boolean
    kds_enabled?: boolean
    logo_url?: string | null
    coordination?: string | null
    syncStatus: SyncStatus
    max_discount_percent?: number
    print_lang?: 'auto' | 'en' | 'ar' | 'ku'
    print_qr?: boolean
    receipt_template?: 'primary' | 'modern'
    a4_template?: 'primary' | 'modern'
    print_quality?: 'low' | 'high'
    thermal_printing?: boolean
    subscription_expires_at?: string | null
    visibility?: WorkspaceVisibility
    store_slug?: string | null
    store_description?: string | null
}

export interface WorkspaceContact extends Omit<BaseEntity, 'isDeleted'> {
    type: 'phone' | 'email' | 'address'
    value: string
    label?: string
    isPrimary: boolean
}

export interface OfflineMutation {
    id: string
    workspaceId: string
    entityType: 'products' | 'inventory' | 'reorder_transfer_rules' | 'inventory_transfer_transactions' | 'invoices' | 'users' | 'sales' | 'categories' | 'workspaces' | 'storages' | 'employees' | 'workspace_contacts' | 'loans' | 'loan_installments' | 'loan_payments' | 'payment_transactions' | 'budget_settings' | 'budget_allocations' | 'expense_series' | 'expense_items' | 'payroll_statuses' | 'dividend_statuses' | 'customers' | 'suppliers' | 'business_partners' | 'business_partner_merge_candidates' | 'sales_orders' | 'purchase_orders' | 'travel_agency_sales'
    entityId: string
    operation: 'create' | 'update' | 'delete'
    payload: Record<string, unknown>
    createdAt: string
    status: MutationStatus
    error?: string
}


export interface AppSetting {
    key: string
    value: string
}

// Type guards
export function isProduct(entity: BaseEntity): entity is Product {
    return 'sku' in entity && 'price' in entity && 'currency' in entity
}


export function isInvoice(entity: BaseEntity): entity is Invoice {
    return 'invoiceid' in entity && 'items' in entity
}
