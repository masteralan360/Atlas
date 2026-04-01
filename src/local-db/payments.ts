import { useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { addMonths, buildDueDate, monthKeyFromDate, type MonthKey } from '@/lib/budget'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toSnakeCase } from '@/lib/utils'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import type {
    CurrencyCode,
    Employee,
    ExpenseItem,
    ExpenseSeries,
    Loan,
    LoanInstallment,
    LoanPaymentMethod,
    OrderPaymentMethod,
    PaymentObligation,
    PaymentTransaction,
    PaymentTransactionDirection,
    PaymentTransactionSourceModule,
    PaymentTransactionSourceType,
    PayrollStatus,
    PurchaseOrder,
    SalesOrder,
    WorkspacePaymentMethod
} from './models'

export interface PaymentTransactionFilterOptions {
    direction?: PaymentTransactionDirection | 'all'
    sourceModule?: PaymentTransactionSourceModule | 'all'
    sourceType?: PaymentTransactionSourceType | 'all'
    search?: string
    includeReversals?: boolean
}

export interface PaymentObligationFilterOptions {
    direction?: PaymentTransactionDirection | 'all'
    sourceModule?: PaymentTransactionSourceModule | 'all'
    sourceType?: PaymentTransactionSourceType | 'all'
    status?: 'all' | 'open' | 'overdue'
    search?: string
}

export interface RecordObligationSettlementInput {
    paymentMethod: WorkspacePaymentMethod
    paidAt?: string
    note?: string
    createdBy?: string | null
}

export interface RecordDirectTransactionInput {
    direction: PaymentTransactionDirection
    amount: number
    currency: CurrencyCode
    paymentMethod: WorkspacePaymentMethod
    paidAt?: string
    reason: string
    note?: string
    counterpartyName?: string
    businessPartnerId?: string | null
    createdBy?: string | null
}

export interface AppendPaymentTransactionInput {
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

type SourceLocator = {
    sourceType: PaymentTransactionSourceType
    sourceRecordId: string
    sourceSubrecordId?: string | null
    metadata?: Record<string, unknown> | null
}

type PaymentSourceKeyInput = {
    sourceType: PaymentTransactionSourceType
    sourceRecordId: string
    sourceSubrecordId?: string | null
    metadata?: Record<string, unknown> | null
}

function shouldUseCloudBusinessData(workspaceId?: string | null) {
    return !!workspaceId && !isLocalWorkspaceMode(workspaceId)
}

function getSyncMetadata(workspaceId: string, timestamp: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return {
            syncStatus: 'synced' as const,
            lastSyncedAt: timestamp
        }
    }

    return {
        syncStatus: 'pending' as const,
        lastSyncedAt: null
    }
}

function shouldUseOfflineMutationFallback(error: unknown): boolean {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return true
    }

    if (!isOnline()) {
        return true
    }

    return isRetriableWebRequestError(error)
}

async function runMutation<T>(label: string, promiseFactory: () => PromiseLike<T>): Promise<T> {
    return runSupabaseAction(label, promiseFactory)
}

function sanitizeSyncPayload(entity: Record<string, unknown>) {
    return toSnakeCase({
        ...entity,
        syncStatus: undefined,
        lastSyncedAt: undefined
    })
}

function normalizeDateKey(value?: string | null) {
    if (!value) {
        return ''
    }

    return value.slice(0, 10)
}

function isDateOverdue(dateValue: string, todayKey: string) {
    return normalizeDateKey(dateValue) < todayKey
}

function matchesSearch(values: Array<string | null | undefined>, search: string) {
    const normalized = search.trim().toLowerCase()
    if (!normalized) {
        return true
    }

    return values.some((value) => value?.toLowerCase().includes(normalized))
}

function getTransactionRoutePath(transaction: Pick<PaymentTransaction, 'sourceModule' | 'sourceType' | 'sourceRecordId' | 'metadata'>) {
    if (transaction.sourceModule === 'orders') {
        return `/orders/${transaction.sourceRecordId}`
    }

    if (transaction.sourceModule === 'budget') {
        return '/budget'
    }

    if (transaction.sourceModule === 'payments') {
        const businessPartnerId = transaction.metadata?.businessPartnerId
        if (typeof businessPartnerId === 'string' && businessPartnerId) {
            return `/business-partners/${businessPartnerId}`
        }

        return transaction.sourceType === 'direct_transaction' ? '/direct-transactions' : '/payments'
    }

    if (transaction.sourceType === 'simple_loan') {
        return '/loans'
    }

    if (transaction.sourceType === 'loan_installment') {
        return `/installments/${transaction.sourceRecordId}`
    }

    return `/loans/${transaction.sourceRecordId}`
}

export function getPaymentSourceKey(source: PaymentSourceKeyInput) {
    if (source.sourceType === 'payroll_status') {
        const employeeId = typeof source.metadata?.employeeId === 'string' && source.metadata.employeeId
            ? source.metadata.employeeId
            : source.sourceSubrecordId || null
        const month = typeof source.metadata?.month === 'string' && source.metadata.month
            ? source.metadata.month
            : null

        if (employeeId && month) {
            return `${source.sourceType}:${employeeId}:${month}`
        }
    }

    return `${source.sourceType}:${source.sourceRecordId}:${source.sourceSubrecordId || ''}`
}

function filterTransactions(
    items: PaymentTransaction[],
    filters: PaymentTransactionFilterOptions
) {
    const includeReversals = filters.includeReversals ?? true

    return items.filter((item) => {
        if (item.isDeleted) {
            return false
        }

        if (!includeReversals && item.reversalOfTransactionId) {
            return false
        }

        if (filters.direction && filters.direction !== 'all' && item.direction !== filters.direction) {
            return false
        }

        if (filters.sourceModule && filters.sourceModule !== 'all' && item.sourceModule !== filters.sourceModule) {
            return false
        }

        if (filters.sourceType && filters.sourceType !== 'all' && item.sourceType !== filters.sourceType) {
            return false
        }

        if (!matchesSearch(
            [item.counterpartyName, item.referenceLabel, item.note, item.sourceModule, item.sourceType],
            filters.search || ''
        )) {
            return false
        }

        return true
    })
}

function filterObligations(
    items: PaymentObligation[],
    filters: PaymentObligationFilterOptions
) {
    return items.filter((item) => {
        if (filters.direction && filters.direction !== 'all' && item.direction !== filters.direction) {
            return false
        }

        if (filters.sourceModule && filters.sourceModule !== 'all' && item.sourceModule !== filters.sourceModule) {
            return false
        }

        if (filters.sourceType && filters.sourceType !== 'all' && item.sourceType !== filters.sourceType) {
            return false
        }

        if (filters.status && filters.status !== 'all' && item.status !== filters.status) {
            return false
        }

        if (!matchesSearch(
            [item.title, item.subtitle, item.counterpartyName, item.referenceLabel, item.sourceModule, item.sourceType],
            filters.search || ''
        )) {
            return false
        }

        return true
    })
}

async function hydratePaymentSourceTables(workspaceId: string) {
    if (!shouldUseCloudBusinessData(workspaceId)) {
        return
    }

    await Promise.all([
        fetchTableFromSupabase('payment_transactions', db.payment_transactions, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('loans', db.loans, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('loan_installments', db.loan_installments, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('sales_orders', db.sales_orders, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('purchase_orders', db.purchase_orders, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('expense_series', db.expense_series, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('expense_items', db.expense_items, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('payroll_statuses', db.payroll_statuses, workspaceId, { includeDeleted: true }),
        fetchTableFromSupabase('employees', db.employees, workspaceId, { includeDeleted: true })
    ])
}

async function ensureExpenseItemsThroughCurrentMonth(workspaceId: string) {
    const currentMonth = monthKeyFromDate(new Date())
    const series = await db.expense_series
        .where('workspaceId')
        .equals(workspaceId)
        .and((item) => !item.isDeleted)
        .toArray()

    if (series.length === 0) {
        return
    }

    const earliestMonth = series
        .map((item) => item.startMonth)
        .sort((left, right) => left.localeCompare(right))[0] as MonthKey | undefined

    if (!earliestMonth) {
        return
    }

    const { ensureExpenseItemsForMonth } = await import('./hooks')
    let monthCursor: MonthKey = earliestMonth

    while (monthCursor <= currentMonth) {
        await ensureExpenseItemsForMonth(workspaceId, monthCursor)
        monthCursor = addMonths(monthCursor, 1)
    }
}

function buildSalesOrderObligation(order: SalesOrder, todayKey: string): PaymentObligation | null {
    if (order.isDeleted || order.isPaid || (order.status !== 'pending' && order.status !== 'completed')) {
        return null
    }

    const dueDate = normalizeDateKey(order.expectedDeliveryDate || order.actualDeliveryDate || order.createdAt)
    return {
        id: `sales-order:${order.id}`,
        workspaceId: order.workspaceId,
        sourceModule: 'orders',
        sourceType: 'sales_order',
        sourceRecordId: order.id,
        sourceSubrecordId: null,
        direction: 'incoming',
        amount: order.total,
        currency: order.currency,
        dueDate,
        counterpartyName: order.customerName,
        referenceLabel: order.orderNumber,
        title: order.customerName,
        subtitle: order.sourceChannel === 'marketplace'
            ? (order.status === 'completed' ? 'Delivered E-Commerce order' : 'Open E-Commerce order')
            : (order.status === 'completed' ? 'Completed sales order' : 'Pending sales order'),
        status: isDateOverdue(dueDate, todayKey) ? 'overdue' : 'open',
        routePath: `/orders/${order.id}`,
        metadata: {
            orderStatus: order.status,
            sourceChannel: order.sourceChannel || 'manual'
        }
    }
}

function buildPurchaseOrderObligation(order: PurchaseOrder, todayKey: string): PaymentObligation | null {
    if (
        order.isDeleted
        || order.isPaid
        || (order.status !== 'ordered' && order.status !== 'received' && order.status !== 'completed')
    ) {
        return null
    }

    const dueDate = normalizeDateKey(order.expectedDeliveryDate || order.actualDeliveryDate || order.createdAt)
    return {
        id: `purchase-order:${order.id}`,
        workspaceId: order.workspaceId,
        sourceModule: 'orders',
        sourceType: 'purchase_order',
        sourceRecordId: order.id,
        sourceSubrecordId: null,
        direction: 'outgoing',
        amount: order.total,
        currency: order.currency,
        dueDate,
        counterpartyName: order.supplierName,
        referenceLabel: order.orderNumber,
        title: order.supplierName,
        subtitle: order.status === 'completed' ? 'Completed purchase order' : `${order.status} purchase order`,
        status: isDateOverdue(dueDate, todayKey) ? 'overdue' : 'open',
        routePath: `/orders/${order.id}`,
        metadata: {
            orderStatus: order.status
        }
    }
}

function buildExpenseObligation(item: ExpenseItem, series: ExpenseSeries | undefined, todayKey: string): PaymentObligation | null {
    if (item.isDeleted || item.status === 'paid') {
        return null
    }

    return {
        id: `expense-item:${item.id}`,
        workspaceId: item.workspaceId,
        sourceModule: 'budget',
        sourceType: 'expense_item',
        sourceRecordId: item.id,
        sourceSubrecordId: item.seriesId,
        direction: 'outgoing',
        amount: item.amount,
        currency: item.currency,
        dueDate: normalizeDateKey(item.dueDate),
        counterpartyName: null,
        referenceLabel: series?.name || 'Expense',
        title: series?.name || 'Expense',
        subtitle: series?.category || item.month,
        status: isDateOverdue(item.dueDate, todayKey) ? 'overdue' : 'open',
        routePath: '/budget',
        metadata: {
            month: item.month,
            seriesId: item.seriesId,
            category: series?.category || null,
            subcategory: series?.subcategory || null
        }
    }
}

function buildPayrollObligation(
    employee: Employee,
    month: MonthKey,
    status: PayrollStatus | undefined,
    todayKey: string
): PaymentObligation | null {
    if (employee.isDeleted || employee.isFired || (employee.salary || 0) <= 0) {
        return null
    }

    const dueDate = buildDueDate(month, employee.salaryPayday || 30)
    if (status?.isDeleted || status?.status === 'paid') {
        return null
    }

    return {
        id: `payroll-status:${employee.id}:${month}`,
        workspaceId: employee.workspaceId,
        sourceModule: 'budget',
        sourceType: 'payroll_status',
        sourceRecordId: status?.id || `${employee.id}:${month}`,
        sourceSubrecordId: employee.id,
        direction: 'outgoing',
        amount: employee.salary || 0,
        currency: employee.salaryCurrency || 'usd',
        dueDate,
        counterpartyName: employee.name,
        referenceLabel: `Payroll ${month}`,
        title: employee.name,
        subtitle: employee.role || month,
        status: isDateOverdue(dueDate, todayKey) ? 'overdue' : 'open',
        routePath: '/budget',
        metadata: {
            employeeId: employee.id,
            month,
            payrollStatusId: status?.id || null
        }
    }
}

function buildStandardLoanInstallmentObligations(
    loans: Loan[],
    installments: LoanInstallment[],
    todayKey: string
) {
    const loanMap = new Map(
        loans
            .filter((loan) => !loan.isDeleted && (loan.loanCategory || 'standard') === 'standard')
            .map((loan) => [loan.id, loan])
    )

    return installments.flatMap((installment) => {
        const loan = loanMap.get(installment.loanId)
        if (!loan || installment.isDeleted || installment.balanceAmount <= 0 || installment.status === 'paid') {
            return []
        }

        const dueDate = normalizeDateKey(installment.dueDate)
        const direction: PaymentTransactionDirection = (loan.direction || 'lent') === 'borrowed' ? 'outgoing' : 'incoming'
        const installmentLabel = `Installment ${String(installment.installmentNo).padStart(2, '0')}`

        return [{
            id: `loan-installment:${installment.id}`,
            workspaceId: loan.workspaceId,
            sourceModule: 'loans' as const,
            sourceType: 'loan_installment' as const,
            sourceRecordId: loan.id,
            sourceSubrecordId: installment.id,
            direction,
            amount: installment.balanceAmount,
            currency: loan.settlementCurrency,
            dueDate,
            counterpartyName: loan.borrowerName,
            referenceLabel: `${loan.loanNo} / ${installmentLabel}`,
            title: loan.borrowerName,
            subtitle: installmentLabel,
            status: isDateOverdue(dueDate, todayKey) ? 'overdue' as const : 'open' as const,
            routePath: `/installments/${loan.id}`,
            metadata: {
                loanId: loan.id,
                installmentId: installment.id,
                installmentNo: installment.installmentNo,
                loanCategory: loan.loanCategory || 'standard',
                loanDirection: loan.direction || 'lent'
            }
        }]
    })
}

function buildSimpleLoanObligations(
    loans: Loan[],
    todayKey: string
) {
    return loans.flatMap((loan) => {
        if (
            loan.isDeleted
            || (loan.loanCategory || 'standard') !== 'simple'
            || loan.balanceAmount <= 0
        ) {
            return []
        }

        const dueDate = normalizeDateKey(loan.nextDueDate || loan.firstDueDate || loan.createdAt)
        const direction: PaymentTransactionDirection = (loan.direction || 'lent') === 'borrowed' ? 'outgoing' : 'incoming'

        return [{
            id: `simple-loan:${loan.id}`,
            workspaceId: loan.workspaceId,
            sourceModule: 'loans' as const,
            sourceType: 'simple_loan' as const,
            sourceRecordId: loan.id,
            sourceSubrecordId: null,
            direction,
            amount: loan.balanceAmount,
            currency: loan.settlementCurrency,
            dueDate,
            counterpartyName: loan.borrowerName,
            referenceLabel: loan.loanNo,
            title: loan.borrowerName,
            subtitle: 'Simple loan balance',
            status: isDateOverdue(dueDate, todayKey) ? 'overdue' as const : 'open' as const,
            routePath: '/loans',
            metadata: {
                loanId: loan.id,
                loanCategory: loan.loanCategory || 'simple',
                loanDirection: loan.direction || 'lent'
            }
        }]
    })
}

function buildPayrollObligations(
    employees: Employee[],
    payrollStatuses: PayrollStatus[],
    todayKey: string
) {
    const currentMonth = monthKeyFromDate(new Date())
    const statusMap = new Map(
        payrollStatuses
            .filter((status) => !status.isDeleted)
            .map((status) => [`${status.employeeId}:${status.month}`, status] as const)
    )

    return employees.flatMap((employee) => {
        if (employee.isDeleted || employee.isFired) {
            return []
        }

        const startMonth = monthKeyFromDate(employee.joiningDate)
        const obligations: PaymentObligation[] = []
        let monthCursor: MonthKey = startMonth

        while (monthCursor <= currentMonth) {
            const obligation = buildPayrollObligation(
                employee,
                monthCursor,
                statusMap.get(`${employee.id}:${monthCursor}`),
                todayKey
            )

            if (obligation) {
                obligations.push(obligation)
            }

            monthCursor = addMonths(monthCursor, 1)
        }

        return obligations
    })
}

async function buildPaymentObligations(workspaceId: string, filters: PaymentObligationFilterOptions) {
    const todayKey = new Date().toISOString().slice(0, 10)
    const [
        loans,
        installments,
        salesOrders,
        purchaseOrders,
        expenseSeries,
        expenseItems,
        payrollStatuses,
        employees
    ] = await Promise.all([
        db.loans.where('workspaceId').equals(workspaceId).toArray(),
        db.loan_installments.where('workspaceId').equals(workspaceId).toArray(),
        db.sales_orders.where('workspaceId').equals(workspaceId).toArray(),
        db.purchase_orders.where('workspaceId').equals(workspaceId).toArray(),
        db.expense_series.where('workspaceId').equals(workspaceId).toArray(),
        db.expense_items.where('workspaceId').equals(workspaceId).toArray(),
        db.payroll_statuses.where('workspaceId').equals(workspaceId).toArray(),
        db.employees.where('workspaceId').equals(workspaceId).toArray()
    ])

    const expenseSeriesMap = new Map(
        expenseSeries
            .filter((item) => !item.isDeleted)
            .map((item) => [item.id, item])
    )

    const obligations = [
        ...buildStandardLoanInstallmentObligations(loans, installments, todayKey),
        ...buildSimpleLoanObligations(loans, todayKey),
        ...salesOrders
            .map((order) => buildSalesOrderObligation(order, todayKey))
            .filter((item): item is PaymentObligation => !!item),
        ...purchaseOrders
            .map((order) => buildPurchaseOrderObligation(order, todayKey))
            .filter((item): item is PaymentObligation => !!item),
        ...expenseItems
            .map((item) => buildExpenseObligation(item, expenseSeriesMap.get(item.seriesId), todayKey))
            .filter((item): item is PaymentObligation => !!item),
        ...buildPayrollObligations(employees, payrollStatuses, todayKey)
    ]

    return filterObligations(obligations, filters).sort((left, right) => {
        if (left.status !== right.status) {
            return left.status === 'overdue' ? -1 : 1
        }

        return left.dueDate.localeCompare(right.dueDate)
            || left.referenceLabel?.localeCompare(right.referenceLabel || '') || 0
    })
}

export function usePaymentTransactions(workspaceId: string | undefined, filters: PaymentTransactionFilterOptions = {}) {
    const online = useNetworkStatus()
    const filterKey = useMemo(
        () => JSON.stringify(filters),
        [filters.direction, filters.includeReversals, filters.search, filters.sourceModule, filters.sourceType]
    )

    const transactions = useLiveQuery(
        async () => {
            if (!workspaceId) {
                return []
            }

            const items = await db.payment_transactions
                .where('workspaceId')
                .equals(workspaceId)
                .toArray()

            return filterTransactions(items, filters).sort((left, right) =>
                right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt)
            )
        },
        [workspaceId, filterKey]
    )

    useEffect(() => {
        if (!online || !workspaceId) {
            return
        }

        void hydratePaymentSourceTables(workspaceId).catch((error) => {
            console.error('[Payments] Failed to hydrate transaction tables', error)
        })
    }, [online, workspaceId])

    return transactions ?? []
}

export function usePaymentObligations(workspaceId: string | undefined, filters: PaymentObligationFilterOptions = {}) {
    const online = useNetworkStatus()
    const filterKey = useMemo(
        () => JSON.stringify(filters),
        [filters.direction, filters.search, filters.sourceModule, filters.sourceType, filters.status]
    )

    const obligations = useLiveQuery(
        () => workspaceId ? buildPaymentObligations(workspaceId, filters) : Promise.resolve([]),
        [workspaceId, filterKey]
    )

    useEffect(() => {
        if (!workspaceId) {
            return
        }

        void ensureExpenseItemsThroughCurrentMonth(workspaceId).catch((error) => {
            console.error('[Payments] Failed to ensure expense items through current month', error)
        })
    }, [workspaceId])

    useEffect(() => {
        if (!online || !workspaceId) {
            return
        }

        void hydratePaymentSourceTables(workspaceId).catch((error) => {
            console.error('[Payments] Failed to hydrate obligation tables', error)
        })
    }, [online, workspaceId])

    return obligations ?? []
}

export function useLockedPaymentSourceKeys(workspaceId: string | undefined) {
    const keys = useLiveQuery(
        async () => {
            if (!workspaceId) {
                return []
            }

            const [salesOrders, purchaseOrders, expenseItems, payrollStatuses] = await Promise.all([
                db.sales_orders.where('workspaceId').equals(workspaceId).toArray(),
                db.purchase_orders.where('workspaceId').equals(workspaceId).toArray(),
                db.expense_items.where('workspaceId').equals(workspaceId).toArray(),
                db.payroll_statuses.where('workspaceId').equals(workspaceId).toArray()
            ])

            return [
                ...salesOrders
                    .filter((item) => !item.isDeleted && !!item.isLocked)
                    .map((item) => getPaymentSourceKey({
                        sourceType: 'sales_order',
                        sourceRecordId: item.id,
                        sourceSubrecordId: null
                    })),
                ...purchaseOrders
                    .filter((item) => !item.isDeleted && !!item.isLocked)
                    .map((item) => getPaymentSourceKey({
                        sourceType: 'purchase_order',
                        sourceRecordId: item.id,
                        sourceSubrecordId: null
                    })),
                ...expenseItems
                    .filter((item) => !item.isDeleted && !!item.isLocked)
                    .map((item) => getPaymentSourceKey({
                        sourceType: 'expense_item',
                        sourceRecordId: item.id,
                        sourceSubrecordId: item.seriesId
                    })),
                ...payrollStatuses
                    .filter((item) => !item.isDeleted && !!item.isLocked)
                    .map((item) => getPaymentSourceKey({
                        sourceType: 'payroll_status',
                        sourceRecordId: item.id,
                        sourceSubrecordId: item.employeeId,
                        metadata: {
                            employeeId: item.employeeId,
                            month: item.month
                        }
                    }))
            ]
        },
        [workspaceId]
    )

    return useMemo(() => new Set(keys ?? []), [keys])
}

function assertSettlementPaymentMethod(paymentMethod: WorkspacePaymentMethod): asserts paymentMethod is LoanPaymentMethod {
    if (paymentMethod === 'credit' || paymentMethod === 'unknown') {
        throw new Error('Select a settlement payment method')
    }
}

function assertStandardSettlementPaymentMethod(
    paymentMethod: WorkspacePaymentMethod
): asserts paymentMethod is Exclude<LoanPaymentMethod, 'loan_adjustment'> {
    assertSettlementPaymentMethod(paymentMethod)

    if (paymentMethod === 'loan_adjustment') {
        throw new Error('Loan adjustment is only available for loan settlements')
    }
}

export function isReversiblePaymentSourceType(sourceType: PaymentTransactionSourceType) {
    return sourceType === 'sales_order'
        || sourceType === 'purchase_order'
        || sourceType === 'expense_item'
        || sourceType === 'payroll_status'
        || sourceType === 'direct_transaction'
}

async function listPaymentTransactionsForSource(
    workspaceId: string,
    locator: SourceLocator
) {
    if (locator.sourceType === 'payroll_status') {
        const sourceKey = getPaymentSourceKey(locator)
        const items = await db.payment_transactions
            .where('workspaceId')
            .equals(workspaceId)
            .toArray()

        return items.filter((item) => getPaymentSourceKey(item) === sourceKey)
    }

    const items = await db.payment_transactions
        .where('[workspaceId+sourceType+sourceRecordId]')
        .equals([workspaceId, locator.sourceType, locator.sourceRecordId])
        .toArray()

    return items.filter((item) => {
        if (locator.sourceSubrecordId !== undefined && item.sourceSubrecordId !== locator.sourceSubrecordId) {
            return false
        }

        return true
    })
}

export async function appendPaymentTransaction(
    workspaceId: string,
    input: AppendPaymentTransactionInput
): Promise<PaymentTransaction> {
    const now = new Date().toISOString()
    const paidAt = input.paidAt ? new Date(input.paidAt).toISOString() : now
    const transaction: PaymentTransaction = {
        id: generateId(),
        workspaceId,
        sourceModule: input.sourceModule,
        sourceType: input.sourceType,
        sourceRecordId: input.sourceRecordId,
        sourceSubrecordId: input.sourceSubrecordId ?? null,
        direction: input.direction,
        amount: Number(input.amount || 0),
        currency: input.currency,
        paymentMethod: input.paymentMethod,
        paidAt,
        counterpartyName: input.counterpartyName?.trim() || null,
        referenceLabel: input.referenceLabel?.trim() || null,
        note: input.note?.trim() || null,
        createdBy: input.createdBy || null,
        reversalOfTransactionId: input.reversalOfTransactionId ?? null,
        metadata: input.metadata ?? null,
        createdAt: now,
        updatedAt: now,
        version: 1,
        isDeleted: false,
        ...getSyncMetadata(workspaceId, now)
    }

    if (!shouldUseCloudBusinessData(workspaceId)) {
        await db.payment_transactions.put(transaction)
        return transaction
    }

    if (!isOnline()) {
        await db.payment_transactions.put(transaction)
        await addToOfflineMutations(
            'payment_transactions',
            transaction.id,
            'create',
            transaction as unknown as Record<string, unknown>,
            workspaceId
        )
        return transaction
    }

    try {
        const client = getSupabaseClientForTable('payment_transactions')
        const payload = sanitizeSyncPayload(transaction as unknown as Record<string, unknown>)
        const { error } = await runMutation('payment_transactions.create', () =>
            client.from('payment_transactions').insert(payload)
        )

        if (error) {
            throw error
        }

        const syncedAt = new Date().toISOString()
        const syncedTransaction: PaymentTransaction = {
            ...transaction,
            syncStatus: 'synced',
            lastSyncedAt: syncedAt
        }
        await db.payment_transactions.put(syncedTransaction)
        return syncedTransaction
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Payments] Payment transaction sync failed, queued offline mutation:', error)
            await db.payment_transactions.put(transaction)
            await addToOfflineMutations(
                'payment_transactions',
                transaction.id,
                'create',
                transaction as unknown as Record<string, unknown>,
                workspaceId
            )
            return transaction
        }

        throw normalizeSupabaseActionError(error)
    }
}

async function softDeletePaymentTransaction(transaction: PaymentTransaction) {
    if (transaction.isDeleted) {
        return
    }

    const now = new Date().toISOString()
    const deletedTransaction: PaymentTransaction = {
        ...transaction,
        isDeleted: true,
        updatedAt: now,
        version: transaction.version + 1,
        ...getSyncMetadata(transaction.workspaceId, now)
    }

    if (!shouldUseCloudBusinessData(transaction.workspaceId)) {
        await db.payment_transactions.put(deletedTransaction)
        return
    }

    if (!isOnline()) {
        await db.payment_transactions.put(deletedTransaction)
        await addToOfflineMutations(
            'payment_transactions',
            transaction.id,
            'delete',
            { id: transaction.id },
            transaction.workspaceId
        )
        return
    }

    try {
        const client = getSupabaseClientForTable('payment_transactions')
        const { error } = await runMutation('payment_transactions.delete', () =>
            client
                .from('payment_transactions')
                .update({ is_deleted: true, updated_at: now })
                .eq('id', transaction.id)
        )

        if (error) {
            throw error
        }

        await db.payment_transactions.put({
            ...deletedTransaction,
            syncStatus: 'synced',
            lastSyncedAt: now
        })
    } catch (error) {
        if (shouldUseOfflineMutationFallback(error)) {
            console.error('[Payments] Payment transaction delete failed, queued offline mutation:', error)
            await db.payment_transactions.put(deletedTransaction)
            await addToOfflineMutations(
                'payment_transactions',
                transaction.id,
                'delete',
                { id: transaction.id },
                transaction.workspaceId
            )
            return
        }

        throw normalizeSupabaseActionError(error)
    }
}

async function replacePaymentTransactionForSource(
    workspaceId: string,
    locator: SourceLocator,
    input: AppendPaymentTransactionInput
) {
    const next = await appendPaymentTransaction(workspaceId, input)
    const relatedTransactions = await listPaymentTransactionsForSource(workspaceId, {
        ...locator,
        metadata: locator.metadata ?? input.metadata ?? null
    })

    for (const item of relatedTransactions) {
        if (item.isDeleted || item.id === next.id) {
            continue
        }

        try {
            await softDeletePaymentTransaction(item)
        } catch (error) {
            console.error('[Payments] Failed to hide replaced transaction row:', error)
        }
    }

    return next
}

export async function recordDirectTransaction(
    workspaceId: string,
    input: RecordDirectTransactionInput
) {
    assertStandardSettlementPaymentMethod(input.paymentMethod)

    const reason = input.reason.trim()
    if (!reason) {
        throw new Error('Reason is required')
    }

    const amount = Number(input.amount || 0)
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Enter a valid amount')
    }

    let counterpartyName = input.counterpartyName?.trim() || null
    let businessPartnerId = input.businessPartnerId || null

    if (businessPartnerId) {
        const partner = await db.business_partners.get(businessPartnerId)
        if (!partner || partner.isDeleted || partner.mergedIntoBusinessPartnerId) {
            throw new Error('Business partner not found')
        }

        counterpartyName = partner.name
        businessPartnerId = partner.id
    }

    if (!counterpartyName) {
        throw new Error('Counterparty is required')
    }

    return appendPaymentTransaction(workspaceId, {
        sourceModule: 'payments',
        sourceType: 'direct_transaction',
        sourceRecordId: generateId(),
        sourceSubrecordId: businessPartnerId,
        direction: input.direction,
        amount,
        currency: input.currency,
        paymentMethod: input.paymentMethod,
        paidAt: input.paidAt || new Date().toISOString(),
        counterpartyName,
        referenceLabel: reason,
        note: input.note?.trim() || null,
        createdBy: input.createdBy || null,
        metadata: {
            reason,
            businessPartnerId
        }
    })
}

export async function findLatestUnreversedPaymentTransaction(
    workspaceId: string,
    locator: SourceLocator
) {
    const relevant = (await listPaymentTransactionsForSource(workspaceId, locator)).filter((item) => {
        if (item.isDeleted) {
            return false
        }

        return true
    })

    const reversedIds = new Set(
        relevant
            .filter((item) => !!item.reversalOfTransactionId)
            .map((item) => item.reversalOfTransactionId as string)
    )

    return relevant
        .filter((item) => !item.reversalOfTransactionId && !reversedIds.has(item.id))
        .sort((left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt))[0]
}

async function resolvePayrollSourceRecordId(employeeId: string, month: string) {
    const status = await db.payroll_statuses
        .where('[employeeId+month]')
        .equals([employeeId, month])
        .and((item) => !item.isDeleted)
        .first()

    if (!status) {
        throw new Error('Payroll status not found after settlement')
    }

    return status.id
}

export async function recordObligationSettlement(
    workspaceId: string,
    obligation: PaymentObligation,
    input: RecordObligationSettlementInput
) {
    const paidAt = input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString()
    const note = input.note?.trim() || null
    const createdBy = input.createdBy || null

    if (obligation.workspaceId !== workspaceId) {
        throw new Error('Workspace mismatch')
    }

    if (obligation.amount <= 0) {
        throw new Error('Invalid settlement amount')
    }

    switch (obligation.sourceType) {
        case 'loan_installment':
        case 'simple_loan': {
            assertSettlementPaymentMethod(input.paymentMethod)
            const { recordLoanPayment } = await import('./hooks')
            await recordLoanPayment(workspaceId, {
                loanId: obligation.sourceRecordId,
                installmentId: obligation.sourceType === 'loan_installment'
                    ? (obligation.sourceSubrecordId || undefined)
                    : undefined,
                amount: obligation.amount,
                paymentMethod: input.paymentMethod,
                note: note || undefined,
                paidAt,
                createdBy: createdBy || undefined
            })
            return
        }

        case 'sales_order': {
            assertStandardSettlementPaymentMethod(input.paymentMethod)
            const { setSalesOrderPaymentStatus } = await import('./orders')
            const order = await setSalesOrderPaymentStatus(obligation.sourceRecordId, {
                isPaid: true,
                paymentMethod: input.paymentMethod as OrderPaymentMethod,
                paidAt
            })
            await replacePaymentTransactionForSource(workspaceId, {
                sourceType: 'sales_order',
                sourceRecordId: order.id,
                sourceSubrecordId: null
            }, {
                sourceModule: 'orders',
                sourceType: 'sales_order',
                sourceRecordId: order.id,
                sourceSubrecordId: null,
                direction: 'incoming',
                amount: order.total,
                currency: order.currency,
                paymentMethod: input.paymentMethod,
                paidAt: order.paidAt || paidAt,
                counterpartyName: order.customerName,
                referenceLabel: order.orderNumber,
                note,
                createdBy,
                metadata: {
                    orderStatus: order.status,
                    sourceChannel: order.sourceChannel || 'manual'
                }
            })
            return
        }

        case 'purchase_order': {
            assertStandardSettlementPaymentMethod(input.paymentMethod)
            const { setPurchaseOrderPaymentStatus } = await import('./orders')
            const order = await setPurchaseOrderPaymentStatus(obligation.sourceRecordId, {
                isPaid: true,
                paymentMethod: input.paymentMethod as OrderPaymentMethod,
                paidAt
            })
            await replacePaymentTransactionForSource(workspaceId, {
                sourceType: 'purchase_order',
                sourceRecordId: order.id,
                sourceSubrecordId: null
            }, {
                sourceModule: 'orders',
                sourceType: 'purchase_order',
                sourceRecordId: order.id,
                sourceSubrecordId: null,
                direction: 'outgoing',
                amount: order.total,
                currency: order.currency,
                paymentMethod: input.paymentMethod,
                paidAt: order.paidAt || paidAt,
                counterpartyName: order.supplierName,
                referenceLabel: order.orderNumber,
                note,
                createdBy,
                metadata: {
                    orderStatus: order.status
                }
            })
            return
        }

        case 'expense_item': {
            assertStandardSettlementPaymentMethod(input.paymentMethod)
            const item = await db.expense_items.get(obligation.sourceRecordId)
            if (!item || item.isDeleted) {
                throw new Error('Expense item not found')
            }

            const series = item.seriesId ? await db.expense_series.get(item.seriesId) : undefined
            const { updateExpenseItem } = await import('./hooks')
            await updateExpenseItem(item.id, {
                status: 'paid',
                paidAt,
                snoozedUntil: null,
                snoozedIndefinite: false
            })

            await replacePaymentTransactionForSource(workspaceId, {
                sourceType: 'expense_item',
                sourceRecordId: item.id,
                sourceSubrecordId: item.seriesId
            }, {
                sourceModule: 'budget',
                sourceType: 'expense_item',
                sourceRecordId: item.id,
                sourceSubrecordId: item.seriesId,
                direction: 'outgoing',
                amount: item.amount,
                currency: item.currency,
                paymentMethod: input.paymentMethod,
                paidAt,
                counterpartyName: null,
                referenceLabel: series?.name || 'Expense',
                note,
                createdBy,
                metadata: {
                    month: item.month,
                    seriesId: item.seriesId,
                    category: series?.category || null,
                    subcategory: series?.subcategory || null
                }
            })
            return
        }

        case 'payroll_status': {
            assertStandardSettlementPaymentMethod(input.paymentMethod)
            const employeeId = String(obligation.metadata?.employeeId || obligation.sourceSubrecordId || '')
            const month = String(obligation.metadata?.month || '')
            if (!employeeId || !month) {
                throw new Error('Payroll settlement metadata is incomplete')
            }

            const employee = await db.employees.get(employeeId)
            if (!employee || employee.isDeleted) {
                throw new Error('Employee not found')
            }

            const { upsertPayrollStatus } = await import('./hooks')
            await upsertPayrollStatus(workspaceId, employeeId, month, {
                status: 'paid',
                paidAt,
                snoozedUntil: null,
                snoozedIndefinite: false
            })

            const sourceRecordId = await resolvePayrollSourceRecordId(employeeId, month)
            await replacePaymentTransactionForSource(workspaceId, {
                sourceType: 'payroll_status',
                sourceRecordId,
                sourceSubrecordId: employee.id,
                metadata: {
                    employeeId: employee.id,
                    month
                }
            }, {
                sourceModule: 'budget',
                sourceType: 'payroll_status',
                sourceRecordId,
                sourceSubrecordId: employee.id,
                direction: 'outgoing',
                amount: employee.salary || 0,
                currency: employee.salaryCurrency || 'usd',
                paymentMethod: input.paymentMethod,
                paidAt,
                counterpartyName: employee.name,
                referenceLabel: `Payroll ${month}`,
                note,
                createdBy,
                metadata: {
                    employeeId: employee.id,
                    month
                }
            })
            return
        }

        default:
            throw new Error(`Unsupported obligation source: ${obligation.sourceType}`)
    }
}

export interface ReversePaymentTransactionInput {
    paidAt?: string
    note?: string
    createdBy?: string | null
}

export async function reversePaymentTransaction(
    workspaceId: string,
    transactionId: string,
    input: ReversePaymentTransactionInput = {}
) {
    const transaction = await db.payment_transactions.get(transactionId)
    if (!transaction || transaction.isDeleted || transaction.workspaceId !== workspaceId) {
        throw new Error('Payment transaction not found')
    }

    if (transaction.reversalOfTransactionId) {
        throw new Error('Reversal entries cannot be reversed')
    }

    if (!isReversiblePaymentSourceType(transaction.sourceType)) {
        throw new Error('This transaction type cannot be reversed in v1')
    }

    const latest = await findLatestUnreversedPaymentTransaction(workspaceId, {
        sourceType: transaction.sourceType,
        sourceRecordId: transaction.sourceRecordId,
        sourceSubrecordId: transaction.sourceSubrecordId ?? undefined,
        metadata: transaction.metadata
    })

    if (!latest || latest.id !== transaction.id) {
        throw new Error('Only the latest unreversed transaction can be reversed')
    }

    switch (transaction.sourceType) {
        case 'sales_order': {
            const { setSalesOrderPaymentStatus } = await import('./orders')
            await setSalesOrderPaymentStatus(transaction.sourceRecordId, {
                isPaid: false,
                paidAt: null
            })
            break
        }

        case 'purchase_order': {
            const { setPurchaseOrderPaymentStatus } = await import('./orders')
            await setPurchaseOrderPaymentStatus(transaction.sourceRecordId, {
                isPaid: false,
                paidAt: null
            })
            break
        }

        case 'expense_item': {
            const item = await db.expense_items.get(transaction.sourceRecordId)
            if (!item || item.isDeleted) {
                throw new Error('Expense item not found')
            }
            if (item.isLocked) {
                throw new Error('Locked paid expenses cannot be reversed')
            }

            const { updateExpenseItem } = await import('./hooks')
            await updateExpenseItem(item.id, {
                status: 'pending',
                paidAt: null,
                snoozedUntil: null,
                snoozedIndefinite: false
            })
            break
        }

        case 'payroll_status': {
            const employeeId = String(transaction.metadata?.employeeId || transaction.sourceSubrecordId || '')
            const month = String(transaction.metadata?.month || '')
            if (!employeeId || !month) {
                throw new Error('Payroll reversal metadata is incomplete')
            }

            const status = await db.payroll_statuses.get(transaction.sourceRecordId)
            if (!status || status.isDeleted) {
                throw new Error('Payroll status not found')
            }
            if (status.isLocked) {
                throw new Error('Locked paid payroll entries cannot be reversed')
            }

            const { upsertPayrollStatus } = await import('./hooks')
            await upsertPayrollStatus(workspaceId, employeeId, month, {
                status: 'pending',
                paidAt: null,
                snoozedUntil: null,
                snoozedIndefinite: false
            })
            break
        }

        case 'direct_transaction':
            break
    }

    const note = input.note?.trim() || `Reversal of ${transaction.referenceLabel || transaction.sourceType}`
    return replacePaymentTransactionForSource(workspaceId, {
        sourceType: transaction.sourceType,
        sourceRecordId: transaction.sourceRecordId,
        sourceSubrecordId: transaction.sourceSubrecordId ?? null,
        metadata: transaction.metadata
    }, {
        sourceModule: transaction.sourceModule,
        sourceType: transaction.sourceType,
        sourceRecordId: transaction.sourceRecordId,
        sourceSubrecordId: transaction.sourceSubrecordId ?? null,
        direction: transaction.direction,
        amount: -Math.abs(transaction.amount),
        currency: transaction.currency,
        paymentMethod: transaction.paymentMethod,
        paidAt: input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString(),
        counterpartyName: transaction.counterpartyName || null,
        referenceLabel: transaction.referenceLabel || null,
        note,
        createdBy: input.createdBy || null,
        reversalOfTransactionId: transaction.id,
        metadata: {
            ...(transaction.metadata && typeof transaction.metadata === 'object' ? transaction.metadata : {}),
            reversal: true
        }
    })
}

export function getPaymentTransactionRoutePath(transaction: Pick<PaymentTransaction, 'sourceModule' | 'sourceType' | 'sourceRecordId' | 'metadata'>) {
    return getTransactionRoutePath(transaction)
}
