// Data Models for Asaas
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
    creditLimit?: number // New
}

export interface Customer extends BaseEntity {
    name: string
    email?: string
    phone: string
    address?: string
    city?: string
    country?: string
    notes?: string
    defaultCurrency: CurrencyCode
    totalOrders: number
    totalSpent: number
    outstandingBalance: number
    creditLimit?: number // New
}

// Order Items (Unified logic for base items, but separated for type safety)
export interface BaseOrderItem {
    id: string
    productId: string
    productName: string
    productSku: string
    quantity: number
    total: number
}

export interface PurchaseOrderItem extends BaseOrderItem {
    unitCost: number             // in order currency
    originalCurrency: CurrencyCode
    originalUnitCost: number
    convertedUnitCost: number
    receivedQuantity?: number
}

export interface SalesOrderItem extends BaseOrderItem {
    unitPrice: number
    costPrice: number            // for profit calc
    originalCurrency: CurrencyCode
    originalUnitPrice: number
    convertedUnitPrice: number
    reservedQuantity: number
    fulfilledQuantity?: number
}

// Legacy OrderItem for Invoice compatibility (to be refactored or kept for snapshots)
export interface OrderItem {
    productId: string
    productName: string
    quantity: number
    unitPrice: number
    total: number
    currency: CurrencyCode
}

export type PurchaseOrderStatus = 'draft' | 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled'

export interface PurchaseOrder extends BaseEntity {
    orderNumber: string
    supplierId: string
    supplierName: string
    items: PurchaseOrderItem[]
    subtotal: number
    discount: number
    total: number
    currency: CurrencyCode

    // Exchange Rate Snapshot
    exchangeRate: number
    exchangeRateSource: string
    exchangeRateTimestamp: string
    exchangeRates?: any[]

    status: PurchaseOrderStatus
    expectedDeliveryDate?: string
    actualDeliveryDate?: string

    isPaid: boolean
    paidAt?: string
    paymentMethod?: string
    notes?: string
}

export type SalesOrderStatus = 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled' | 'returned'

export interface SalesOrder extends BaseEntity {
    orderNumber: string
    customerId: string
    customerName: string
    items: SalesOrderItem[]
    subtotal: number
    discount: number
    tax: number
    total: number
    currency: CurrencyCode

    // Exchange Rate Snapshot
    exchangeRate: number
    exchangeRateSource: string
    exchangeRateTimestamp: string
    exchangeRates?: any[]

    status: SalesOrderStatus
    expectedDeliveryDate?: string
    actualDeliveryDate?: string

    isPaid: boolean
    paidAt?: string
    paymentMethod?: 'cash' | 'fib' | 'qicard' | 'zaincash' | 'fastpay' | 'credit'

    reservedAt?: string
    shippingAddress?: string
    notes?: string
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

export interface Loan extends BaseEntity {
    saleId?: string | null
    loanNo: string
    source: LoanSource
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
    entityType: 'products' | 'customers' | 'suppliers' | 'purchase_orders' | 'sales_orders' | 'invoices' | 'users' | 'sales' | 'categories' | 'storages' | 'employees' | 'workspace_contacts' | 'loans' | 'loan_installments' | 'loan_payments' | 'budget_settings' | 'budget_allocations' | 'expense_series' | 'expense_items' | 'payroll_statuses' | 'dividend_statuses'
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
    default_currency: CurrencyCode
    iqd_display_preference: IQDDisplayPreference
    eur_conversion_enabled?: boolean
    try_conversion_enabled?: boolean
    locked_workspace: boolean
    allow_pos: boolean
    allow_customers: boolean
    allow_suppliers: boolean
    allow_orders: boolean
    allow_invoices: boolean
    allow_whatsapp?: boolean
    kds_enabled?: boolean
    logo_url?: string | null
    coordination?: string | null
    syncStatus: SyncStatus
    // Negotiated price limit (0-100 percentage)
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
    entityType: 'products' | 'customers' | 'suppliers' | 'purchase_orders' | 'sales_orders' | 'invoices' | 'users' | 'sales' | 'categories' | 'workspaces' | 'storages' | 'employees' | 'workspace_contacts' | 'loans' | 'loan_installments' | 'loan_payments' | 'budget_settings' | 'budget_allocations' | 'expense_series' | 'expense_items' | 'payroll_statuses' | 'dividend_statuses'
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

export function isCustomer(entity: BaseEntity): entity is Customer {
    return 'phone' in entity && 'totalOrders' in entity
}

export function isSupplier(entity: BaseEntity): entity is Supplier {
    return 'totalPurchases' in entity && 'defaultCurrency' in entity
}

export function isPurchaseOrder(entity: BaseEntity): entity is PurchaseOrder {
    return 'supplierId' in entity && 'items' in entity && 'status' in entity
}

export function isSalesOrder(entity: BaseEntity): entity is SalesOrder {
    return 'customerId' in entity && 'items' in entity && 'status' in entity
}

export function isInvoice(entity: BaseEntity): entity is Invoice {
    return 'invoiceid' in entity && 'items' in entity
}
