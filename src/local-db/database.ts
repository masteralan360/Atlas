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
    BusinessPartner,
    BusinessPartnerMergeCandidate,
    Employee,
    WorkspaceContact,
    Loan,
    LoanInstallment,
    LoanPayment,
    PaymentTransaction,
    BudgetSettings,
    BudgetAllocation,
    ExpenseSeries,
    ExpenseItem,
    PayrollStatus,
    DividendStatus,
    SalesOrder,
    PurchaseOrder,
    TravelAgencySale
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
    business_partners!: EntityTable<BusinessPartner, 'id'>
    business_partner_merge_candidates!: EntityTable<BusinessPartnerMergeCandidate, 'id'>
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
    payment_transactions!: EntityTable<PaymentTransaction, 'id'>
    sales_orders!: EntityTable<SalesOrder, 'id'>
    purchase_orders!: EntityTable<PurchaseOrder, 'id'>
    travel_agency_sales!: EntityTable<TravelAgencySale, 'id'>

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

        this.version(47).stores({
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
            travel_agency_sales: 'id, saleNumber, workspaceId, saleDate, supplierId, isPaid, updatedAt, isDeleted, syncStatus, [workspaceId+saleDate], [workspaceId+isPaid]',
            app_settings: 'key'
        })

        this.version(48).stores({
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
            suppliers: 'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
            customers: 'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
            business_partners: 'id, name, workspaceId, role, customerFacetId, supplierFacetId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId',
            business_partner_merge_candidates: 'id, workspaceId, primaryPartnerId, secondaryPartnerId, status, confidence, updatedAt, syncStatus, isDeleted',
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
            sales_orders: 'id, orderNumber, businessPartnerId, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            purchase_orders: 'id, orderNumber, businessPartnerId, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            travel_agency_sales: 'id, saleNumber, workspaceId, saleDate, businessPartnerId, supplierId, isPaid, updatedAt, isDeleted, syncStatus, [workspaceId+saleDate], [workspaceId+isPaid]',
            app_settings: 'key'
        }).upgrade(async tx => {
            const now = new Date().toISOString()
            const customers = await tx.table('customers').toArray()
            const suppliers = await tx.table('suppliers').toArray()
            const existingPartners = await tx.table('business_partners').toArray().catch(() => [])
            const existingMergeCandidates = await tx.table('business_partner_merge_candidates').toArray().catch(() => [])
            const partnerMap = new Map<string, Record<string, unknown>>(existingPartners.map((partner: Record<string, unknown>) => [String(partner.id), partner]))
            const customerPartnerIdByFacetId = new Map<string, string>()
            const supplierPartnerIdByFacetId = new Map<string, string>()

            const buildPartnerBase = (facet: Record<string, unknown>, partnerId: string, role: 'customer' | 'supplier') => ({
                id: partnerId,
                workspaceId: facet.workspaceId,
                name: facet.name,
                contactName: role === 'supplier' ? facet.contactName : undefined,
                email: facet.email,
                phone: facet.phone,
                address: facet.address,
                city: facet.city,
                country: facet.country,
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
                const partnerId = typeof customer.businessPartnerId === 'string' && customer.businessPartnerId
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
                const partnerId = typeof supplier.businessPartnerId === 'string' && supplier.businessPartnerId
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

            const travelSales = await tx.table('travel_agency_sales').toArray().catch(() => [])
            for (const sale of travelSales as Array<Record<string, unknown>>) {
                if (!sale.businessPartnerId && typeof sale.supplierId === 'string') {
                    sale.businessPartnerId = supplierPartnerIdByFacetId.get(sale.supplierId) || null
                }
            }
            if (travelSales.length > 0) {
                await tx.table('travel_agency_sales').bulkPut(travelSales)
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

            const normalizeValue = (value: unknown) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
            const candidateMap = new Map<string, Record<string, unknown>>(existingMergeCandidates.map((candidate: Record<string, unknown>) => [String(candidate.id), candidate]))

            for (const customer of customers as Array<Record<string, unknown>>) {
                const customerPartnerId = customerPartnerIdByFacetId.get(String(customer.id))
                if (!customerPartnerId) {
                    continue
                }
                const customerName = normalizeValue(customer.name)
                const customerPhone = normalizeValue(customer.phone)
                const customerEmail = normalizeValue(customer.email)

                for (const supplier of suppliers as Array<Record<string, unknown>>) {
                    const supplierPartnerId = supplierPartnerIdByFacetId.get(String(supplier.id))
                    if (!supplierPartnerId || customer.workspaceId !== supplier.workspaceId) {
                        continue
                    }

                    const supplierName = normalizeValue(supplier.name)
                    const supplierPhone = normalizeValue(supplier.phone)
                    const supplierEmail = normalizeValue(supplier.email)
                    const exactName = customerName && customerName === supplierName
                    const phoneMatch = customerPhone && customerPhone === supplierPhone
                    const emailMatch = customerEmail && customerEmail === supplierEmail

                    if (!exactName && !phoneMatch && !emailMatch) {
                        continue
                    }

                    const confidence = exactName && (phoneMatch || emailMatch)
                        ? 0.98
                        : exactName
                            ? 0.86
                            : 0.78
                    const candidateId = `${customerPartnerId}:${supplierPartnerId}`
                    if (candidateMap.has(candidateId)) {
                        continue
                    }

                    const reasons = [
                        exactName ? 'matching name' : '',
                        phoneMatch ? 'matching phone' : '',
                        emailMatch ? 'matching email' : ''
                    ].filter(Boolean)

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

        this.version(49).stores({
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
            suppliers: 'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
            customers: 'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
            business_partners: 'id, name, workspaceId, role, customerFacetId, supplierFacetId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId',
            business_partner_merge_candidates: 'id, workspaceId, primaryPartnerId, secondaryPartnerId, status, confidence, updatedAt, syncStatus, isDeleted',
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
            loans: 'id, workspaceId, saleId, loanCategory, direction, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted, [workspaceId+loanCategory], [workspaceId+direction]',
            loan_installments: 'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
            loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
            sales_orders: 'id, orderNumber, businessPartnerId, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            purchase_orders: 'id, orderNumber, businessPartnerId, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            travel_agency_sales: 'id, saleNumber, workspaceId, saleDate, businessPartnerId, supplierId, isPaid, updatedAt, isDeleted, syncStatus, [workspaceId+saleDate], [workspaceId+isPaid]',
            app_settings: 'key'
        }).upgrade(async tx => {
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

        this.version(50).stores({
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
            suppliers: 'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
            customers: 'id, name, workspaceId, businessPartnerId, phone, email, defaultCurrency, updatedAt, isDeleted, syncStatus',
            business_partners: 'id, name, workspaceId, role, customerFacetId, supplierFacetId, defaultCurrency, updatedAt, isDeleted, syncStatus, mergedIntoBusinessPartnerId',
            business_partner_merge_candidates: 'id, workspaceId, primaryPartnerId, secondaryPartnerId, status, confidence, updatedAt, syncStatus, isDeleted',
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
            loans: 'id, workspaceId, saleId, loanCategory, direction, status, nextDueDate, borrowerName, loanNo, linkedPartyType, linkedPartyId, syncStatus, updatedAt, isDeleted, [workspaceId+loanCategory], [workspaceId+direction]',
            loan_installments: 'id, loanId, workspaceId, dueDate, status, syncStatus, updatedAt, isDeleted, [loanId+installmentNo]',
            loan_payments: 'id, loanId, workspaceId, paidAt, syncStatus, updatedAt, isDeleted',
            payment_transactions: 'id, workspaceId, paidAt, sourceModule, sourceType, sourceRecordId, sourceSubrecordId, direction, reversalOfTransactionId, updatedAt, isDeleted, syncStatus, [workspaceId+paidAt], [workspaceId+sourceType+sourceRecordId]',
            sales_orders: 'id, orderNumber, businessPartnerId, customerId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            purchase_orders: 'id, orderNumber, businessPartnerId, supplierId, workspaceId, status, currency, createdAt, updatedAt, isDeleted, syncStatus',
            travel_agency_sales: 'id, saleNumber, workspaceId, saleDate, businessPartnerId, supplierId, isPaid, updatedAt, isDeleted, syncStatus, [workspaceId+saleDate], [workspaceId+isPaid]',
            app_settings: 'key'
        }).upgrade(async tx => {
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
                    ...(typeof input.metadata === 'object' && input.metadata !== null ? input.metadata as Record<string, unknown> : {})
                },
                ...input
            })

            for (const payment of loanPayments) {
                if (payment.isDeleted) {
                    continue
                }

                const loan = loanById.get(String(payment.loanId))
                if (!loan) {
                    continue
                }

                rows.push(createRow({
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
                }))
            }

            for (const order of salesOrders) {
                if (order.isDeleted || !order.isPaid) {
                    continue
                }

                rows.push(createRow({
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
                }))
            }

            for (const order of purchaseOrders) {
                if (order.isDeleted || !order.isPaid) {
                    continue
                }

                rows.push(createRow({
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
                }))
            }

            for (const item of expenseItems) {
                if (item.isDeleted || item.status !== 'paid') {
                    continue
                }

                const series = expenseSeriesById.get(String(item.seriesId))
                rows.push(createRow({
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
                }))
            }

            for (const status of payrollStatuses) {
                if (status.isDeleted || status.status !== 'paid') {
                    continue
                }

                const employee = employeeById.get(String(status.employeeId))
                rows.push(createRow({
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
                    referenceLabel: employee?.name ? `${employee.name} • ${String(status.month ?? '')}` : String(status.month ?? 'Payroll'),
                    note: null,
                    createdBy: null,
                    reversalOfTransactionId: null,
                    createdAt: status.paidAt ?? status.updatedAt ?? status.createdAt ?? now,
                    updatedAt: status.updatedAt ?? status.paidAt ?? status.createdAt ?? now,
                    metadata: {
                        employeeId: status.employeeId ?? null,
                        month: status.month ?? null
                    }
                }))
            }

            if (rows.length > 0) {
                await paymentTransactionsTable.bulkPut(rows)
            }
        })

        this.version(51).stores({
            storages: 'id, name, workspaceId, isSystem, isProtected, isPrimary, syncStatus, updatedAt, isDeleted'
        }).upgrade(async tx => {
            const storageRows = await tx.table('storages').toArray() as Array<Record<string, unknown>>
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
                const primaryRow = activeRows.find((row) => row.isPrimary === true)
                    ?? activeRows.find((row) => row.isSystem === true && String(row.name || '').trim().toLowerCase() === 'main')
                    ?? activeRows[0]

                for (const row of workspaceRows) {
                    row.isPrimary = !!primaryRow && !row.isDeleted && row.id === primaryRow.id
                }
            }

            await tx.table('storages').bulkPut(storageRows)
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
            'business_partners',
            'business_partner_merge_candidates',
            'employees',
            'workspace_contacts',
            'loans',
            'loan_installments',
            'loan_payments',
            'payment_transactions',
            'sales_orders',
            'purchase_orders',
            'travel_agency_sales',
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
    await db.transaction('rw', [db.products, db.inventory, db.inventory_transfer_transactions, db.reorder_transfer_rules, db.categories, db.invoices, db.travel_agency_sales, db.payment_transactions, db.syncQueue], async () => {
        await db.products.clear()
        await db.inventory.clear()
        await db.inventory_transfer_transactions.clear()
        await db.reorder_transfer_rules.clear()
        await db.categories.clear()
        await db.invoices.clear()
        await db.travel_agency_sales.clear()
        await db.payment_transactions.clear()
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
