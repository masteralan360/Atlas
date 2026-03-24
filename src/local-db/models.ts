// Data Models for Atlas
// All entities include sync metadata for offline-first architecture

export type SyncStatus = 'pending' | 'synced' | 'conflict'

export type UserRole = 'admin' | 'staff' | 'viewer'

export type CurrencyCode = 'usd' | 'eur' | 'iqd' | 'try'
export type WorkspaceDataMode = 'cloud' | 'local'

export type PaymentMethod = 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay' | 'loan'
export type LoanPaymentMethod = PaymentMethod | 'loan_adjustment'

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
}

export interface Customer extends BaseEntity {
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
}

export type SalesOrderStatus = 'draft' | 'pending' | 'completed' | 'cancelled'
export type PurchaseOrderStatus = 'draft' | 'ordered' | 'received' | 'completed' | 'cancelled'
export type OrderPaymentMethod = PaymentMethod | 'credit' | 'bank_transfer'

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
}

export interface PurchaseOrder extends BaseEntity {
    orderNumber: string
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
    origin?: 'pos' | 'instant_pos' | 'revenue' | 'inventory' | 'manual' | 'loans' | 'Loans';
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
    exchangeSource: string
    exchangeRate: number
    exchangeRateTimestamp: string
    exchangeRates?: any[]
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
export type LoanStatus = 'active' | 'overdue' | 'completed'
export type InstallmentStatus = 'unpaid' | 'partial' | 'paid' | 'overdue'
export type InstallmentFrequency = 'weekly' | 'biweekly' | 'monthly'
export type LoanLinkedPartyType = 'customer'

export interface Loan extends BaseEntity {
    saleId?: string | null
    loanNo: string
    source: LoanSource
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


// Sync Queue Item for tracking pending changes
export interface SyncQueueItem {
    id: string
    entityType: 'products' | 'inventory' | 'reorder_transfer_rules' | 'inventory_transfer_transactions' | 'invoices' | 'users' | 'sales' | 'categories' | 'storages' | 'employees' | 'workspace_contacts' | 'loans' | 'loan_installments' | 'loan_payments' | 'budget_settings' | 'budget_allocations' | 'expense_series' | 'expense_items' | 'payroll_statuses' | 'dividend_statuses' | 'customers' | 'suppliers' | 'sales_orders' | 'purchase_orders' | 'travel_agency_sales'
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
    entityType: 'products' | 'inventory' | 'reorder_transfer_rules' | 'inventory_transfer_transactions' | 'invoices' | 'users' | 'sales' | 'categories' | 'workspaces' | 'storages' | 'employees' | 'workspace_contacts' | 'loans' | 'loan_installments' | 'loan_payments' | 'budget_settings' | 'budget_allocations' | 'expense_series' | 'expense_items' | 'payroll_statuses' | 'dividend_statuses' | 'customers' | 'suppliers' | 'sales_orders' | 'purchase_orders' | 'travel_agency_sales'
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
