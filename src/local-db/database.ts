import Dexie, { type EntityTable } from 'dexie'
import type {
    Product,
    Category,
    Customer,
    Supplier,
    PurchaseOrder,
    SalesOrder,
    Invoice,
    User,
    SyncQueueItem,
    Sale,
    SaleItem,
    OfflineMutation,
    Workspace,
    AppSetting,
    Storage,
    Employee,
    WorkspaceContact,
    Loan,
    LoanInstallment,
    LoanPayment,
    BudgetSettings,
    BudgetAllocation,
    ExpenseSeries,
    ExpenseItem,
    PayrollStatus,
    DividendStatus
} from './models'

// Asaas Database using Dexie.js for IndexedDB
export class AsaasDatabase extends Dexie {
    products!: EntityTable<Product, 'id'>
    categories!: EntityTable<Category, 'id'>
    suppliers!: EntityTable<Supplier, 'id'>
    customers!: EntityTable<Customer, 'id'>
    purchaseOrders!: EntityTable<PurchaseOrder, 'id'>
    salesOrders!: EntityTable<SalesOrder, 'id'>
    invoices!: EntityTable<Invoice, 'id'>
    users!: EntityTable<User, 'id'>
    sales!: EntityTable<Sale, 'id'>
    sale_items!: EntityTable<SaleItem, 'id'>
    workspaces!: EntityTable<Workspace, 'id'>
    storages!: EntityTable<Storage, 'id'>
    employees!: EntityTable<Employee, 'id'>
    budget_settings!: EntityTable<BudgetSettings, 'id'>
    budget_allocations!: EntityTable<BudgetAllocation, 'id'>
    expense_series!: EntityTable<ExpenseSeries, 'id'>
    expense_items!: EntityTable<ExpenseItem, 'id'>
    payroll_statuses!: EntityTable<PayrollStatus, 'id'>
    dividend_statuses!: EntityTable<DividendStatus, 'id'>
    syncQueue!: EntityTable<SyncQueueItem, 'id'>
    offline_mutations!: EntityTable<OfflineMutation, 'id'>
    app_settings!: EntityTable<AppSetting, 'key'>
    workspace_contacts!: EntityTable<WorkspaceContact, 'id'>
    loans!: EntityTable<Loan, 'id'>
    loan_installments!: EntityTable<LoanInstallment, 'id'>
    loan_payments!: EntityTable<LoanPayment, 'id'>

    constructor() {
        super('AsaasDatabase')

        this.version(37).stores({
            products: 'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
            categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
            suppliers: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
            customers: 'id, name, phone, workspaceId, syncStatus, updatedAt, isDeleted',
            purchaseOrders: 'id, orderNumber, supplierId, status, workspaceId, syncStatus, updatedAt, isDeleted',
            salesOrders: 'id, orderNumber, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted',
            invoices: 'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',

            users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
            sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
            sale_items: 'id, saleId, productId',
            workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
            storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
            employees: 'id, name, workspaceId, linkedUserId, syncStatus, updatedAt, isDeleted',
            syncQueue: 'id, entityType, entityId, operation, timestamp',
            offline_mutations: 'id, workspaceId, entityType, entityId, status, createdAt, [entityType+entityId+status]',
            workspace_contacts: 'id, workspaceId, type, value, syncStatus, updatedAt',
            loans: 'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, syncStatus, updatedAt, isDeleted',
            loan_installments: 'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
            loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
            app_settings: 'key'
        }).upgrade(tx => Promise.all([
            tx.table('offline_mutations').where('entityType').anyOf(['budget_allocations', 'expenses']).delete(),
            tx.table('syncQueue').where('entityType').anyOf(['budget_allocations', 'expenses']).delete()
        ]))

        this.version(38).stores({
            products: 'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
            categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
            suppliers: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
            customers: 'id, name, phone, workspaceId, syncStatus, updatedAt, isDeleted',
            purchaseOrders: 'id, orderNumber, supplierId, status, workspaceId, syncStatus, updatedAt, isDeleted',
            salesOrders: 'id, orderNumber, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted',
            invoices: 'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',

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
            loan_installments: 'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
            loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
            app_settings: 'key'
        })

        this.version(39).stores({
            budget_allocations: 'id, workspaceId, month, [workspaceId+month]'
        })

        this.version(40).stores({
            budget_allocations: 'id, workspaceId, month, [workspaceId+month]'
        }).upgrade(async tx => {
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
    }
}


// Singleton database instance
export const db = new AsaasDatabase()

// Database utility functions
export async function clearDatabase(): Promise<void> {
    await db.transaction('rw', [db.products, db.categories, db.suppliers, db.customers, db.purchaseOrders, db.salesOrders, db.invoices, db.syncQueue], async () => {
        await db.products.clear()
        await db.categories.clear()
        await db.suppliers.clear()
        await db.customers.clear()
        await db.purchaseOrders.clear()
        await db.salesOrders.clear()
        await db.invoices.clear()
        await db.syncQueue.clear()
    })
}

export async function exportDatabase(): Promise<{
    products: Product[]
    suppliers: Supplier[]
    customers: Customer[]
    purchaseOrders: PurchaseOrder[]
    salesOrders: SalesOrder[]
    invoices: Invoice[]
}> {
    const [products, consumers, suppliers, purchaseOrders, salesOrders, invoices] = await Promise.all([
        db.products.where('isDeleted').equals(false as any).toArray(),
        db.customers.where('isDeleted').equals(false as any).toArray(),
        db.suppliers.where('isDeleted').equals(false as any).toArray(),
        db.purchaseOrders.where('isDeleted').equals(false as any).toArray(),
        db.salesOrders.where('isDeleted').equals(false as any).toArray(),
        db.invoices.where('isDeleted').equals(false as any).toArray(),
    ])

    return { products, suppliers, customers: consumers, purchaseOrders, salesOrders, invoices }
}

// Get pending sync count
export async function getPendingSyncCount(): Promise<number> {
    return await db.syncQueue.count()
}
