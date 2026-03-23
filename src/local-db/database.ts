import Dexie, { type EntityTable } from 'dexie'
import type {
    Product,
    Category,
    Invoice,
    User,
    SyncQueueItem,
    Sale,
    SaleItem,
    OfflineMutation,
    Workspace,
    AppSetting,
    Storage,
    Inventory,
    InventoryTransferTransaction,
    ReorderTransferRule,
    Supplier,
    Customer,
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
    DividendStatus,
    SalesOrder,
    PurchaseOrder
} from './models'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import {
    LOCAL_MODE_SQLITE_TABLES,
    queueLocalModeSqliteDelete,
    queueLocalModeSqliteUpsert
} from './localModeSqlite'

// Atlas Database using Dexie.js for IndexedDB
export class AtlasDatabase extends Dexie {
    products!: EntityTable<Product, 'id'>
    categories!: EntityTable<Category, 'id'>
    invoices!: EntityTable<Invoice, 'id'>
    users!: EntityTable<User, 'id'>
    sales!: EntityTable<Sale, 'id'>
    sale_items!: EntityTable<SaleItem, 'id'>
    workspaces!: EntityTable<Workspace, 'id'>
    storages!: EntityTable<Storage, 'id'>
    inventory!: EntityTable<Inventory, 'id'>
    inventory_transfer_transactions!: EntityTable<InventoryTransferTransaction, 'id'>
    reorder_transfer_rules!: EntityTable<ReorderTransferRule, 'id'>
    suppliers!: EntityTable<Supplier, 'id'>
    customers!: EntityTable<Customer, 'id'>
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
    sales_orders!: EntityTable<SalesOrder, 'id'>
    purchase_orders!: EntityTable<PurchaseOrder, 'id'>

    constructor() {
        super('AtlasDatabase')

        this.version(37).stores({
            products: 'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
            categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
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

        this.version(41).stores({
            products: 'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
            categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
            invoices: 'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
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
            loan_installments: 'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
            loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
            sales_orders: 'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            purchase_orders: 'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            app_settings: 'key'
        })

        this.version(42).stores({
            products: 'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
            categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
            invoices: 'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
            users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
            sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
            sale_items: 'id, saleId, productId',
            workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
            storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
            inventory: 'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
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
            loan_installments: 'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
            loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
            sales_orders: 'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            purchase_orders: 'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            app_settings: 'key'
        }).upgrade(async tx => {
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
            products: 'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
            categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
            invoices: 'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
            users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
            sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
            sale_items: 'id, saleId, productId',
            workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
            storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
            inventory: 'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
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
            loans: 'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted',
            loan_installments: 'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
            loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
            sales_orders: 'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            purchase_orders: 'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            app_settings: 'key'
        })

        this.version(44).stores({
            products: 'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
            categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
            invoices: 'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
            users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
            sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
            sale_items: 'id, saleId, productId',
            workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
            storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
            inventory: 'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
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
            loans: 'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted',
            loan_installments: 'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
            loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
            sales_orders: 'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            purchase_orders: 'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            app_settings: 'key'
        }).upgrade(async tx => {
            await tx.table('loans')
                .where('linkedPartyType')
                .equals('supplier')
                .modify({
                    linkedPartyType: null,
                    linkedPartyId: null,
                    linkedPartyName: null
                })
        })

        this.version(45).stores({
            products: 'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
            categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
            invoices: 'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
            users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
            sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
            sale_items: 'id, saleId, productId',
            workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
            storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
            inventory: 'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
            reorder_transfer_rules: 'id, workspaceId, productId, sourceStorageId, destinationStorageId, isIndefinite, expiresOn, updatedAt, isDeleted, [workspaceId+productId], [workspaceId+destinationStorageId], [workspaceId+expiresOn]',
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
            loans: 'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted',
            loan_installments: 'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
            loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
            sales_orders: 'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            purchase_orders: 'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            app_settings: 'key'
        })

        this.version(46).stores({
            products: 'id, sku, name, categoryId, storageId, workspaceId, currency, syncStatus, updatedAt, isDeleted, canBeReturned',
            categories: 'id, name, workspaceId, syncStatus, updatedAt, isDeleted',
            invoices: 'id, invoiceid, orderId, customerId, status, workspaceId, syncStatus, updatedAt, isDeleted, origin, createdBy, cashierName, createdByName, sequenceId, printFormat, r2PathA4, r2PathReceipt',
            users: 'id, email, role, workspaceId, syncStatus, updatedAt, isDeleted, monthlyTarget',
            sales: 'id, cashierId, workspaceId, settlementCurrency, syncStatus, createdAt, updatedAt, notes',
            sale_items: 'id, saleId, productId',
            workspaces: 'id, name, code, syncStatus, updatedAt, isDeleted, print_lang, print_qr',
            storages: 'id, name, workspaceId, isSystem, isProtected, syncStatus, updatedAt, isDeleted',
            inventory: 'id, workspaceId, productId, storageId, quantity, syncStatus, updatedAt, isDeleted, [workspaceId+storageId], [workspaceId+productId], [productId+storageId]',
            inventory_transfer_transactions: 'id, workspaceId, productId, sourceStorageId, destinationStorageId, transferType, createdAt, isDeleted, [workspaceId+createdAt], [workspaceId+productId], [workspaceId+transferType]',
            reorder_transfer_rules: 'id, workspaceId, productId, sourceStorageId, destinationStorageId, isIndefinite, expiresOn, updatedAt, isDeleted, [workspaceId+productId], [workspaceId+destinationStorageId], [workspaceId+expiresOn]',
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
            loans: 'id, workspaceId, saleId, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted',
            loan_installments: 'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
            loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
            sales_orders: 'id, orderNumber, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            purchase_orders: 'id, orderNumber, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            app_settings: 'key'
        })

        this.registerLocalModeSyncHooks()
    }

    private registerLocalModeSyncHooks() {
        const database = this
        const syncAwareTables = [
            'products',
            'categories',
            'invoices',
            'users',
            'sales',
            'workspaces',
            'storages',
            'inventory',
            'inventory_transfer_transactions',
            'reorder_transfer_rules',
            'suppliers',
            'customers',
            'employees',
            'workspace_contacts',
            'loans',
            'loan_installments',
            'loan_payments',
            'sales_orders',
            'purchase_orders',
            'budget_settings',
            'budget_allocations',
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
    await db.transaction('rw', [db.products, db.inventory, db.inventory_transfer_transactions, db.reorder_transfer_rules, db.categories, db.invoices, db.syncQueue], async () => {
        await db.products.clear()
        await db.inventory.clear()
        await db.inventory_transfer_transactions.clear()
        await db.reorder_transfer_rules.clear()
        await db.categories.clear()
        await db.invoices.clear()
        await db.syncQueue.clear()
    })
}

export async function exportDatabase(): Promise<{
    products: Product[]
    invoices: Invoice[]
}> {
    const [products, invoices] = await Promise.all([
        db.products.where('isDeleted').equals(false as any).toArray(),
        db.invoices.where('isDeleted').equals(false as any).toArray(),
    ])

    return { products, invoices }
}

// Get pending sync count
export async function getPendingSyncCount(): Promise<number> {
    return await db.syncQueue.count()
}
