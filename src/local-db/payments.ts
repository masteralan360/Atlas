import { useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'

import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { canAccessBusinessPartnerInLocalCache } from './businessPartnerPrivacy'
import {
    addMonths,
    buildDueDate,
    compareMonthKeys,
    getApplicableStartMonth,
    isMonthKeyOnOrBefore,
    monthKeyFromDate,
    type MonthKey
} from '@/lib/budget'
import { isOnline } from '@/lib/network'
import { getSupabaseClientForTable } from '@/lib/supabaseSchema'
import { isRetriableWebRequestError, normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import { generateId, toSnakeCase } from '@/lib/utils'
import { isReportablePaymentTransaction } from '@/lib/financialReportability'
import {
  getPaymentTransactionReversalState,
} from '@/lib/paymentReversals'
export {
  getPaymentReversalAmountPolicy,
  getPaymentTransactionReversalState,
  type PaymentReversalAmountPolicy,
  type PaymentTransactionReversalState,
} from '@/lib/paymentReversals'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import { db } from './database'
import { addToOfflineMutations, fetchTableFromSupabase } from './hooks'
import { getOrderBalanceAmount } from './orderInstallments'
import {
    assertPaymentAccountTransactionCanBeAppliedLocally,
    mirrorPaymentAccountTransactionLocally,
    resolveActiveCashierShiftOccurrenceId
} from './paymentAccounts'
import type {
    BusinessPartner,
    CurrencyCode,
    ClinicalAppointment,
    Employee,
    ExpenseItem,
    ExpenseSeries,
    Loan,
    LoanInstallment,
    LoanPaymentMethod,
    InstallmentSale,
  InstallmentSaleInstallment,
    OrderInstallment,
    OrderType,
    PaymentObligation,
    PaymentTransaction,
    PaymentTransactionDirection,
    PaymentTransactionSourceModule,
    PaymentTransactionSourceType,
    PayrollStatus,
    PurchaseOrder,
    RealEstateTransaction,
    SalesOrder,
    WorkspacePaymentMethod
} from './models'
import {
    buildClinicalAppointmentPaymentObligation,
    getClinicalAppointmentPaymentSummary
} from './clinicalAppointmentPayments'

export interface PaymentTransactionFilterOptions {
    direction?: PaymentTransactionDirection | 'all'
    sourceModule?: PaymentTransactionSourceModule | 'all'
    sourceType?: PaymentTransactionSourceType | 'all'
    search?: string
    includeReversals?: boolean
    /** Administrator audit surfaces only. Ordinary views always exclude voided rows. */
    includeVoided?: boolean
}

export interface UsePaymentTransactionsOptions {
    hydrateSourceTables?: boolean
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
    amount?: number
    note?: string
    counterpartyName?: string
    businessPartnerId?: string | null
    createdBy?: string | null
    accountId?: string | null
    accountNameSnapshot?: string | null
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
    /** Explicit partner-subledger treatment; cash-only is the safe default. */
    partnerAccountEffect?: DirectTransactionPartnerAccountEffect
    createdBy?: string | null
    accountId?: string | null
    accountNameSnapshot?: string | null
}

export const DIRECT_TRANSACTION_PARTNER_ACCOUNT_EFFECTS = [
    'increase_receivable',
    'decrease_receivable',
    'increase_payable',
    'decrease_payable'
] as const

export type DirectTransactionPartnerAccountEffect = 'none' | ( typeof DIRECT_TRANSACTION_PARTNER_ACCOUNT_EFFECTS)[number]

export function isDirectTransactionPartnerAccountEffect(
    value: unknown
): value is ( typeof DIRECT_TRANSACTION_PARTNER_ACCOUNT_EFFECTS)[number] {
    return typeof value === 'string'
        && (DIRECT_TRANSACTION_PARTNER_ACCOUNT_EFFECTS as readonly string[]).includes(value)
}

function isDirectTransactionEffectCompatibleWithDirection(
    effect: DirectTransactionPartnerAccountEffect,
    direction: PaymentTransactionDirection
) {
    if (effect === 'none') return true
    return direction === 'outgoing'
        ? effect === 'increase_receivable' || effect === 'decrease_payable'
        : effect === 'decrease_receivable' || effect === 'increase_payable'
}

export interface PartnerSettlementBalanceGroup {
    currency: CurrencyCode
    total: number
    items: number
}

export interface PartnerSettlementBalance {
    partnerId: string
    direction: PaymentTransactionDirection
    groups: PartnerSettlementBalanceGroup[]
    total: number
    items: number
    eligibleObligations: PaymentObligation[]
}

export interface PartnerSettlementProgress {
    settledItems: number
    totalItems: number
}

export interface CurrencySettlementAmount {
    currency: CurrencyCode
    amount: number
}

export interface SettlePartnerBalanceInput {
    partnerId: string
    direction: PaymentTransactionDirection
    paymentMethod: WorkspacePaymentMethod
    paidAt?: string
    note?: string
    createdBy?: string | null
    amount?: number
    amountsByCurrency?: CurrencySettlementAmount[]
    onProgress?: (progress: PartnerSettlementProgress) => void
    accountId?: string | null
    accountNameSnapshot?: string | null
}

export interface SettlePartnerBalanceResult {
    partnerId: string
    partnerName: string
    direction: PaymentTransactionDirection
    totalSettled: number
    items: number
    groups: PartnerSettlementBalanceGroup[]
}

export interface AppendPaymentTransactionInput {
    /** Optional deterministic ID for a retriable, one-time operational payment. */
    id?: string
    /** Uses an ID upsert for an operation that may be replayed by an offline client. */
    idempotent?: boolean
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
    accountId?: string | null
    accountNameSnapshot?: string | null
    reversalOfTransactionId?: string | null
    metadata?: Record<string, unknown> | null
}

export type SourceLocator = {
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

function isDateOverdue(dateValue: string | null | undefined, todayKey: string) {
    const dateKey = normalizeDateKey(dateValue)
    return !!dateKey && dateKey < todayKey
}

function matchesSearch(values: Array<string | null | undefined>, search: string) {
    const normalized = search.trim().toLowerCase()
    if (!normalized) {
        return true
    }

    return values.some((value) => value?.toLowerCase().includes(normalized))
}

function getMetadataString(metadata: Record<string, unknown> | null | undefined, key: string) {
    const value = metadata?.[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function getTransactionRoutePath(transaction: Pick<PaymentTransaction, 'sourceModule' | 'sourceType' | 'sourceRecordId' | 'metadata'>) {
    if (transaction.sourceType === 'agent_commission_payout' || transaction.sourceType === 'agent_commission_recovery') {
        return '/agents/commissions'
    }

    if (transaction.sourceModule === 'sales') {
        return '/sales'
    }

    if (transaction.sourceModule === 'clinical_appointments') {
        return `/clinical-appointments/${transaction.sourceRecordId}/edit`
  }

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

    if (transaction.sourceType === 'payment_account_opening_balance') {
      return '/payment-accounts'
    }

    return transaction.sourceType === 'direct_transaction' ? '/direct-transactions' : '/payments'
  }

  if (transaction.sourceModule === 'payment_accounts') {
    return '/payment-accounts'
  }

  if (transaction.sourceModule === 'real_estate') {
    return `/real-estate/${transaction.sourceRecordId}`
  }

  if (transaction.sourceModule === 'activities') {
    return `/activities?transaction=${transaction.sourceRecordId}`
  }

  if (transaction.sourceModule === 'post_service') {
    return '/post-service'
  }

  if (transaction.sourceModule === 'car_rental') {
    return '/car-rental/contracts'
  }

  if (transaction.sourceModule === 'travel_transportation') {
    return `/travel-transportation/${transaction.sourceRecordId}`
  }

  if (transaction.sourceModule === 'installment_sales') {
    return '/installments'
  }

  if (transaction.sourceType === 'simple_loan') {
    return `/loans/${transaction.sourceRecordId}`
  }

  if (transaction.sourceType === 'loan_installment') {
    return `/installments/${transaction.sourceRecordId}`
  }

  return `/loans/${transaction.sourceRecordId}`
}

export function getPaymentSourceKey(source: PaymentSourceKeyInput) {
  if (source.sourceType === 'payroll_status') {
    const employeeId =
      typeof source.metadata?.employeeId === 'string' && source.metadata.employeeId
        ? source.metadata.employeeId
        : source.sourceSubrecordId || null
    const month = typeof source.metadata?.month === 'string' && source.metadata.month ? source.metadata.month : null

    if (employeeId && month) {
      return `${source.sourceType}:${employeeId}:${month}`
    }
  }

  return `${source.sourceType}:${source.sourceRecordId}:${source.sourceSubrecordId || ''}`
}

function buildLoanOriginationTransactionInput(
  loan: Pick<
    Loan,
    | 'id'
    | 'source'
    | 'loanCategory'
    | 'direction'
    | 'principalAmount'
    | 'settlementCurrency'
    | 'createdAt'
    | 'borrowerName'
    | 'loanNo'
    | 'notes'
    | 'createdBy'
  >
): AppendPaymentTransactionInput | null {
  if (loan.source !== 'manual') {
    return null
  }

  return {
    sourceModule: 'loans',
    sourceType: 'loan_origination',
    sourceRecordId: loan.id,
    sourceSubrecordId: null,
    direction: (loan.direction || 'lent') === 'borrowed' ? 'incoming' : 'outgoing',
    amount: loan.principalAmount,
    currency: loan.settlementCurrency,
    paymentMethod: 'unknown',
    paidAt: loan.createdAt,
    counterpartyName: loan.borrowerName || null,
    referenceLabel: loan.loanNo || null,
    note: loan.notes?.trim() || null,
    createdBy: loan.createdBy || null,
    metadata: {
      loanCategory: loan.loanCategory || 'standard',
      loanDirection: loan.direction || 'lent',
      origination: true
    }
  }
}

const loanOriginationEnsureLocks = new Map<string, Promise<void>>()

function filterTransactions(items: PaymentTransaction[], filters: PaymentTransactionFilterOptions) {
  const includeReversals = filters.includeReversals ?? true
  const includeVoided = filters.includeVoided ?? false

  return items.filter((item) => {
    if (item.isDeleted || (!includeVoided && item.voidId)) {
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

    if (
      !matchesSearch(
        [item.counterpartyName, item.referenceLabel, item.note, item.sourceModule, item.sourceType],
        filters.search || ''
      )
    ) {
      return false
    }

    return true
  })
}

function filterObligations(items: PaymentObligation[], filters: PaymentObligationFilterOptions) {
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

    if (
      !matchesSearch(
        [item.title, item.subtitle, item.counterpartyName, item.referenceLabel, item.sourceModule, item.sourceType],
        filters.search || ''
      )
    ) {
      return false
    }

    return true
  })
}

const PAYMENT_AMOUNT_EPSILON = 0.000001

/**
 * Returns the total reversed amount for each original payment transaction.
 *
 * A reversal can be partial (for example, an order return), so callers must
 * not use the presence of a reversal as proof that the original payment was
 * fully cancelled.
 */
export function getPaymentTransactionReversalAmounts(rows: PaymentTransaction[]) {
  const reversalAmounts = new Map<string, number>()
  for (const row of rows) {
    if (!isReportablePaymentTransaction(row) || !row.reversalOfTransactionId) continue
    reversalAmounts.set(
      row.reversalOfTransactionId,
      (reversalAmounts.get(row.reversalOfTransactionId) || 0) + Math.abs(Number(row.amount || 0))
    )
  }
  return reversalAmounts
}

/**
 * Projects original payment transactions to their unreversed balance.
 * Reversal rows are represented by the reduction to their source payment,
 * keeping partial returns visible as the remaining settlement amount.
 */
export function getRemainingPaymentTransactions(rows: PaymentTransaction[]) {
  const reversalAmounts = getPaymentTransactionReversalAmounts(rows)

  return rows
    .filter((row) => isReportablePaymentTransaction(row) && !row.reversalOfTransactionId)
    .map((row) => {
      const amount = Number(row.amount || 0)
      const remainingMagnitude = Math.max(0, Math.abs(amount) - (reversalAmounts.get(row.id) || 0))

      if (remainingMagnitude <= PAYMENT_AMOUNT_EPSILON) {
        return null
      }

      return {
        ...row,
        amount: amount < 0 ? -remainingMagnitude : remainingMagnitude
      }
    })
    .filter((row): row is PaymentTransaction => row !== null)
}

function getActivePaymentTransactionAmount(rows: PaymentTransaction[]) {
  return getRemainingPaymentTransactions(rows).reduce((sum, row) => sum + Math.max(0, Number(row.amount || 0)), 0)
}

async function hydratePaymentSourceTables(workspaceId: string) {
  if (!shouldUseCloudBusinessData(workspaceId)) {
    return
  }

  await Promise.all([
    fetchTableFromSupabase('payment_transactions', db.payment_transactions, workspaceId, { includeDeleted: true }),
    fetchTableFromSupabase('clinical_appointments', db.clinical_appointments, workspaceId, {
      includeDeleted: true
    }),
    fetchTableFromSupabase('loans', db.loans, workspaceId, {
      includeDeleted: true
    }),
    fetchTableFromSupabase('loan_installments', db.loan_installments, workspaceId, { includeDeleted: true }),
    fetchTableFromSupabase('installment_sales', db.installment_sales, workspaceId, { includeDeleted: true }),
    fetchTableFromSupabase('installment_sale_installments', db.installment_sale_installments, workspaceId, {
      includeDeleted: true
    }),
    fetchTableFromSupabase('real_estate_transactions', db.real_estate_transactions, workspaceId, {
      includeDeleted: true
    }),
    fetchTableFromSupabase('rental_vehicles', db.rental_vehicles, workspaceId, {
      includeDeleted: true
    }),
    fetchTableFromSupabase('rental_contracts', db.rental_contracts, workspaceId, { includeDeleted: true }),
    fetchTableFromSupabase('sales_orders', db.sales_orders, workspaceId, {
      includeDeleted: true
    }),
    fetchTableFromSupabase('purchase_orders', db.purchase_orders, workspaceId, {
      includeDeleted: true
    }),
    fetchTableFromSupabase('order_installments', db.order_installments, workspaceId, { includeDeleted: true }),
    fetchTableFromSupabase('expense_series', db.expense_series, workspaceId, {
      includeDeleted: true
    }),
    fetchTableFromSupabase('expense_items', db.expense_items, workspaceId, {
      includeDeleted: true
    }),
    fetchTableFromSupabase('payroll_statuses', db.payroll_statuses, workspaceId, { includeDeleted: true }),
    fetchTableFromSupabase('employees', db.employees, workspaceId, {
      includeDeleted: true
    })
  ])

  await repairPendingOrderPaymentReferences(workspaceId)
  await ensureManualLoanOriginationTransactions(workspaceId)
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
    .map((item) => getApplicableStartMonth(item.startMonth, item.createdAt, currentMonth))
    .filter((month): month is MonthKey => !!month)
    .sort(compareMonthKeys)[0]

  if (!earliestMonth) {
    return
  }

  const { ensureExpenseItemsForMonth } = await import('./hooks')
  let monthCursor: MonthKey = earliestMonth

  while (isMonthKeyOnOrBefore(monthCursor, currentMonth)) {
    await ensureExpenseItemsForMonth(workspaceId, monthCursor)
    monthCursor = addMonths(monthCursor, 1)
  }
}

function buildSalesOrderObligation(order: SalesOrder, todayKey: string): PaymentObligation | null {
  const balanceAmount = getOrderBalanceAmount(order)
  if (order.isDeleted || balanceAmount <= 0 || (order.status !== 'pending' && order.status !== 'completed')) {
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
    amount: balanceAmount,
    currency: order.currency,
    dueDate,
    createdAt: order.createdAt,
    counterpartyName: order.customerName,
    referenceLabel: order.orderNumber,
    title: order.customerName,
    subtitle:
      order.sourceChannel === 'marketplace'
        ? order.status === 'completed'
          ? 'Delivered E-Commerce order'
          : 'Open E-Commerce order'
        : order.status === 'completed'
          ? 'Completed sales order'
          : 'Pending sales order',
    status: isDateOverdue(dueDate, todayKey) ? 'overdue' : 'open',
    routePath: `/orders/${order.id}`,
    metadata: {
      orderStatus: order.status,
      sourceChannel: order.sourceChannel || 'manual',
      businessPartnerId: order.businessPartnerId || null
    }
  }
}

function buildPurchaseOrderObligation(order: PurchaseOrder, todayKey: string): PaymentObligation | null {
  const balanceAmount = getOrderBalanceAmount(order)
  if (
    order.isDeleted ||
    balanceAmount <= 0 ||
    (order.status !== 'ordered' && order.status !== 'received' && order.status !== 'completed')
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
    amount: balanceAmount,
    currency: order.currency,
    dueDate,
    createdAt: order.createdAt,
    counterpartyName: order.supplierName,
    referenceLabel: order.orderNumber,
    title: order.supplierName,
    subtitle: order.status === 'completed' ? 'Completed purchase order' : `${order.status} purchase order`,
    status: isDateOverdue(dueDate, todayKey) ? 'overdue' : 'open',
    routePath: `/orders/${order.id}`,
    metadata: {
      orderStatus: order.status,
      businessPartnerId: order.businessPartnerId || null
    }
  }
}

function buildOrderInstallmentObligations(
  order: SalesOrder | PurchaseOrder,
  installments: OrderInstallment[],
  todayKey: string
) {
  const isSalesOrder = 'customerName' in order
  const sourceType = isSalesOrder ? ('sales_order' as const) : ('purchase_order' as const)
  const direction = isSalesOrder ? ('incoming' as const) : ('outgoing' as const)
  const counterpartyName = isSalesOrder ? order.customerName : order.supplierName

  if (
    order.isDeleted ||
    !order.isInstallmentBased ||
    getOrderBalanceAmount(order) <= 0 ||
    (isSalesOrder
      ? order.status !== 'pending' && order.status !== 'completed'
      : order.status !== 'ordered' && order.status !== 'received' && order.status !== 'completed')
  ) {
    return []
  }

  return installments
    .filter(
      (installment) =>
        !installment.isDeleted &&
        installment.orderId === order.id &&
        installment.orderType === (isSalesOrder ? 'sales' : 'purchase') &&
        installment.balanceAmount > 0
    )
    .sort((left, right) => left.installmentNo - right.installmentNo)
    .map((installment): PaymentObligation => {
      const dueDate = normalizeDateKey(installment.dueDate)
      const installmentLabel = `Installment ${String(installment.installmentNo).padStart(2, '0')}`
      return {
        id: `order-installment:${installment.id}`,
        workspaceId: order.workspaceId,
        sourceModule: 'orders',
        sourceType,
        sourceRecordId: order.id,
        sourceSubrecordId: installment.id,
        direction,
        amount: installment.balanceAmount,
        currency: order.currency,
        dueDate,
        createdAt: installment.createdAt,
        counterpartyName,
        referenceLabel: `${order.orderNumber} / ${installmentLabel}`,
        title: counterpartyName,
        subtitle: installmentLabel,
        status: isDateOverdue(dueDate, todayKey) ? 'overdue' : 'open',
        routePath: `/orders/${order.id}`,
        metadata: {
          orderStatus: order.status,
          orderType: isSalesOrder ? 'sales' : 'purchase',
          installmentId: installment.id,
          installmentNo: installment.installmentNo,
          businessPartnerId: order.businessPartnerId || null
        }
      }
    })
}

function buildExpenseObligation(
  item: ExpenseItem,
  series: ExpenseSeries | undefined,
  todayKey: string
): PaymentObligation | null {
  if (item.isDeleted || item.voidId || item.status === 'paid') {
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
    createdAt: item.createdAt,
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
    createdAt: status?.createdAt || '',
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

function buildStandardLoanInstallmentObligations(loans: Loan[], installments: LoanInstallment[], todayKey: string) {
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

    return [
      {
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
        createdAt: installment.createdAt,
        counterpartyName: loan.borrowerName,
        referenceLabel: `${loan.loanNo} / ${installmentLabel}`,
        title: loan.borrowerName,
        subtitle: installmentLabel,
        status: isDateOverdue(dueDate, todayKey) ? ('overdue' as const) : ('open' as const),
        routePath: `/installments/${loan.id}`,
        metadata: {
          loanId: loan.id,
          installmentId: installment.id,
          installmentNo: installment.installmentNo,
          loanCategory: loan.loanCategory || 'standard',
          loanDirection: loan.direction || 'lent',
          businessPartnerId: loan.linkedPartyType === 'business_partner' ? loan.linkedPartyId || null : null
        }
      }
    ]
  })
}

function buildSimpleLoanObligations(loans: Loan[], todayKey: string) {
  return loans.flatMap((loan) => {
    if (loan.isDeleted || (loan.loanCategory || 'standard') !== 'simple' || loan.balanceAmount <= 0) {
      return []
    }

    const dueDate = normalizeDateKey(loan.nextDueDate || loan.firstDueDate)
    const direction: PaymentTransactionDirection = (loan.direction || 'lent') === 'borrowed' ? 'outgoing' : 'incoming'
    const isOrderLoan = loan.source === 'order' && !!loan.orderId && !!loan.orderType

    return [
      {
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
        createdAt: loan.createdAt,
        counterpartyName: loan.borrowerName,
        referenceLabel: loan.loanNo,
        title: loan.borrowerName,
        subtitle: isOrderLoan ? 'Order loan balance' : 'Simple loan balance',
        status: isDateOverdue(dueDate, todayKey) ? ('overdue' as const) : ('open' as const),
        routePath: '/loans',
        metadata: {
          loanId: loan.id,
          loanCategory: loan.loanCategory || 'simple',
          loanDirection: loan.direction || 'lent',
          ...(isOrderLoan
            ? {
                displaySourceLabel: 'order_loan',
                orderId: loan.orderId,
                orderType: loan.orderType
              }
            : {}),
          businessPartnerId: loan.linkedPartyType === 'business_partner' ? loan.linkedPartyId || null : null
        }
      }
    ]
  })
}

function buildInstallmentSaleObligations(
  sales: InstallmentSale[],
  installments: InstallmentSaleInstallment[],
  todayKey: string
) {
  const saleById = new Map(
    sales.filter((sale) => !sale.isDeleted && sale.status !== 'cancelled').map((sale) => [sale.id, sale])
  )

  const customerObligations = installments.flatMap((installment) => {
    const sale = saleById.get(installment.installmentSaleId)
    if (!sale || installment.isDeleted || installment.balanceAmount <= 0) {
      return []
    }

    const dueDate = normalizeDateKey(installment.dueDate)
    return [
      {
        id: `installment-sale:${installment.id}`,
        workspaceId: sale.workspaceId,
        sourceModule: 'installment_sales' as const,
        sourceType: 'installment_sale_installment' as const,
        sourceRecordId: sale.id,
        sourceSubrecordId: installment.id,
        direction: 'incoming' as const,
        amount: installment.balanceAmount,
        currency: sale.currency,
        dueDate,
        createdAt: installment.createdAt,
        counterpartyName: sale.customerNameSnapshot,
        referenceLabel: sale.saleNo,
        title: sale.customerNameSnapshot,
        subtitle: sale.description,
        status: isDateOverdue(dueDate, todayKey) ? ('overdue' as const) : ('open' as const),
        routePath: '/installments',
        metadata: {
          installmentSaleId: sale.id,
          installmentSaleInstallmentId: installment.id,
          businessPartnerId: sale.customerBusinessPartnerId
        }
      }
    ]
  })

  return customerObligations
}

function getLoanManagedOrderIds(loans: Loan[], orderType: 'sales' | 'purchase') {
  return new Set(
    loans
      .filter(
        (loan) =>
          !loan.isDeleted &&
          loan.source === 'order' &&
          loan.orderType === orderType &&
          !!loan.orderId &&
          loan.balanceAmount > 0
      )
      .map((loan) => loan.orderId as string)
  )
}

function buildRealEstateCommissionObligations(
  transactions: RealEstateTransaction[],
  paymentTransactions: PaymentTransaction[]
) {
  const commissionPaymentsByTransactionId = new Map<string, PaymentTransaction[]>()
  paymentTransactions
    .filter((row) => row.sourceType === 'real_estate_commission')
    .forEach((row) => {
      const existing = commissionPaymentsByTransactionId.get(row.sourceRecordId) || []
      existing.push(row)
      commissionPaymentsByTransactionId.set(row.sourceRecordId, existing)
    })

  return transactions.flatMap((transaction) => {
    if (transaction.isDeleted || transaction.profitAmount <= 0) {
      return []
    }

    const paidAmount = getActivePaymentTransactionAmount(commissionPaymentsByTransactionId.get(transaction.id) || [])
    const balanceAmount = Math.max(transaction.profitAmount - paidAmount, 0)
    if (balanceAmount <= 0) {
      return []
    }

    return [
      {
        id: `real-estate-commission:${transaction.id}`,
        workspaceId: transaction.workspaceId,
        sourceModule: 'real_estate' as const,
        sourceType: 'real_estate_commission' as const,
        sourceRecordId: transaction.id,
        sourceSubrecordId: null,
        direction: 'incoming' as const,
        amount: balanceAmount,
        currency: transaction.currency,
        dueDate: normalizeDateKey(transaction.createdAt),
        createdAt: transaction.createdAt,
        counterpartyName: transaction.buyerName || transaction.sellerName,
        referenceLabel: `${transaction.transactionNo} / Commission`,
        title: transaction.location,
        subtitle: 'Mediator commission',
        status: 'open' as const,
        routePath: `/real-estate/${transaction.id}`,
        metadata: {
          realEstateTransactionId: transaction.id,
          transactionType: transaction.transactionType,
          propertyLocation: transaction.location,
          businessPartnerId: transaction.buyerBusinessPartnerId || transaction.sellerBusinessPartnerId || null
        }
      }
    ]
  })
}

function buildPayrollObligations(employees: Employee[], payrollStatuses: PayrollStatus[], todayKey: string) {
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

    const startMonth = getApplicableStartMonth(employee.joiningDate, employee.createdAt, currentMonth)
    if (!startMonth) {
      return []
    }
    const obligations: PaymentObligation[] = []
    let monthCursor: MonthKey = startMonth

    while (isMonthKeyOnOrBefore(monthCursor, currentMonth)) {
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

export async function buildPaymentObligations(workspaceId: string, filters: PaymentObligationFilterOptions) {
  const todayKey = new Date().toISOString().slice(0, 10)
  const [
    loans,
    installments,
    installmentSales,
    installmentSaleInstallments,
    realEstateTransactions,
    paymentTransactions,
    salesOrders,
    purchaseOrders,
    orderInstallments,
    expenseSeries,
    expenseItems,
    payrollStatuses,
    employees,
    clinicalAppointments,
    workspace
  ] = await Promise.all([
    db.loans.where('workspaceId').equals(workspaceId).toArray(),
    db.loan_installments.where('workspaceId').equals(workspaceId).toArray(),
    db.installment_sales.where('workspaceId').equals(workspaceId).toArray(),
    db.installment_sale_installments.where('workspaceId').equals(workspaceId).toArray(),
    db.real_estate_transactions.where('workspaceId').equals(workspaceId).toArray(),
    db.payment_transactions.where('workspaceId').equals(workspaceId).toArray(),
    db.sales_orders.where('workspaceId').equals(workspaceId).toArray(),
    db.purchase_orders.where('workspaceId').equals(workspaceId).toArray(),
    db.order_installments.where('workspaceId').equals(workspaceId).toArray(),
    db.expense_series.where('workspaceId').equals(workspaceId).toArray(),
    db.expense_items.where('workspaceId').equals(workspaceId).toArray(),
    db.payroll_statuses.where('workspaceId').equals(workspaceId).toArray(),
    db.employees.where('workspaceId').equals(workspaceId).toArray(),
    db.clinical_appointments.where('workspaceId').equals(workspaceId).toArray(),
    db.workspaces.get(workspaceId)
  ])

  const expenseSeriesMap = new Map(expenseSeries.filter((item) => !item.isDeleted && !item.voidId).map((item) => [item.id, item]))
  const salesOrdersWithInstallments = new Set(
    orderInstallments.filter((item) => !item.isDeleted && item.orderType === 'sales').map((item) => item.orderId)
  )
  const purchaseOrdersWithInstallments = new Set(
    orderInstallments.filter((item) => !item.isDeleted && item.orderType === 'purchase').map((item) => item.orderId)
  )
  const loanManagedSalesOrderIds = getLoanManagedOrderIds(loans, 'sales')
  const loanManagedPurchaseOrderIds = getLoanManagedOrderIds(loans, 'purchase')

  const obligations = [
    ...buildStandardLoanInstallmentObligations(loans, installments, todayKey),
    ...buildSimpleLoanObligations(loans, todayKey),
    ...buildInstallmentSaleObligations(installmentSales, installmentSaleInstallments, todayKey),
    ...buildRealEstateCommissionObligations(realEstateTransactions, paymentTransactions),
    ...clinicalAppointments
      .map((appointment) =>
        buildClinicalAppointmentPaymentObligation(
          appointment,
          paymentTransactions,
          workspace?.default_currency || 'usd'
        )
      )
      .filter((item): item is PaymentObligation => !!item),
    ...salesOrders
      .filter((order) => !loanManagedSalesOrderIds.has(order.id))
      .filter((order) => !order.isInstallmentBased || !salesOrdersWithInstallments.has(order.id))
      .map((order) => buildSalesOrderObligation(order, todayKey))
      .filter((item): item is PaymentObligation => !!item),
    ...purchaseOrders
      .filter((order) => !loanManagedPurchaseOrderIds.has(order.id))
      .filter((order) => !order.isInstallmentBased || !purchaseOrdersWithInstallments.has(order.id))
      .map((order) => buildPurchaseOrderObligation(order, todayKey))
      .filter((item): item is PaymentObligation => !!item),
    ...salesOrders.flatMap((order) => buildOrderInstallmentObligations(order, orderInstallments, todayKey)),
    ...purchaseOrders.flatMap((order) => buildOrderInstallmentObligations(order, orderInstallments, todayKey)),
    ...expenseItems
      .filter((item) => !item.isDeleted && !item.voidId)
      .map((item) => buildExpenseObligation(item, expenseSeriesMap.get(item.seriesId), todayKey))
      .filter((item): item is PaymentObligation => !!item),
    ...buildPayrollObligations(employees, payrollStatuses, todayKey)
  ]

  // Commission balances are not derived from order payment state. Add them to
  // the shared source list so Open Items, Payable, Collectable, and partner
  // settlement all see the identical per-assignment balance.
  const agentCommissionObligations = await buildAgentCommissionObligations(workspaceId)

  return filterObligations([...obligations, ...agentCommissionObligations], filters).sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === 'overdue' ? -1 : 1
    }

    return compareObligationAllocationOrder(left, right)
  })
}

export function usePaymentTransactions(
  workspaceId: string | undefined,
  filters: PaymentTransactionFilterOptions = {},
  options: UsePaymentTransactionsOptions = {}
) {
  const online = useNetworkStatus()
  const hydrateSourceTables = options.hydrateSourceTables ?? true
  const filterKey = useMemo(
    () => JSON.stringify(filters),
    [filters.direction, filters.includeReversals, filters.includeVoided, filters.search, filters.sourceModule, filters.sourceType]
  )

  const transactions = useLiveQuery(async () => {
    if (!workspaceId) {
      return []
    }

    const items = await db.payment_transactions.where('workspaceId').equals(workspaceId).toArray()

    const visibility = await Promise.all(
      items.map((transaction) => {
        const businessPartnerId = transaction.metadata?.businessPartnerId
        return typeof businessPartnerId === 'string'
          ? canAccessBusinessPartnerInLocalCache(
              workspaceId,
              businessPartnerId,
              transaction.sourceType === 'purchase_order' ? 'supplier' : 'customer'
            )
          : true
      })
    )

    return filterTransactions(
      items.filter((_, index) => visibility[index]),
      filters
    ).sort((left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt))
  }, [workspaceId, filterKey])

  useEffect(() => {
    if (!workspaceId) {
      return
    }

    if (online && shouldUseCloudBusinessData(workspaceId)) {
      return
    }

    void ensureManualLoanOriginationTransactions(workspaceId).catch((error) => {
      console.error('[Payments] Failed to ensure loan origination transactions', error)
    })
  }, [online, workspaceId])

  useEffect(() => {
    if (!online || !workspaceId) {
      return
    }

    const hydration = hydrateSourceTables
      ? hydratePaymentSourceTables(workspaceId)
      : fetchTableFromSupabase('payment_transactions', db.payment_transactions, workspaceId, {
          includeDeleted: true
        })

    void hydration.catch((error) => {
      console.error('[Payments] Failed to hydrate transaction tables', error)
    })
  }, [hydrateSourceTables, online, workspaceId])

  return transactions ?? []
}

export function usePaymentObligations(workspaceId: string | undefined, filters: PaymentObligationFilterOptions = {}) {
  const online = useNetworkStatus()
  const filterKey = useMemo(
    () => JSON.stringify(filters),
    [filters.direction, filters.search, filters.sourceModule, filters.sourceType, filters.status]
  )

  const obligations = useLiveQuery(
    () => (workspaceId ? buildPaymentObligations(workspaceId, filters) : Promise.resolve([])),
    [workspaceId, filterKey]
  )

  useEffect(() => {
    if (!workspaceId) {
      return
    }

    if (!online || !shouldUseCloudBusinessData(workspaceId)) {
      void ensureManualLoanOriginationTransactions(workspaceId).catch((error) => {
        console.error('[Payments] Failed to ensure loan origination obligations', error)
      })
    }

    void ensureExpenseItemsThroughCurrentMonth(workspaceId).catch((error) => {
      console.error('[Payments] Failed to ensure expense items through current month', error)
    })
  }, [online, workspaceId])

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
  const keys = useLiveQuery(async () => {
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
        .map((item) =>
          getPaymentSourceKey({
            sourceType: 'sales_order',
            sourceRecordId: item.id,
            sourceSubrecordId: null
          })
        ),
      ...purchaseOrders
        .filter((item) => !item.isDeleted && !!item.isLocked)
        .map((item) =>
          getPaymentSourceKey({
            sourceType: 'purchase_order',
            sourceRecordId: item.id,
            sourceSubrecordId: null
          })
        ),
      ...expenseItems
        .filter((item) => !item.isDeleted && !item.voidId && !!item.isLocked)
        .map((item) =>
          getPaymentSourceKey({
            sourceType: 'expense_item',
            sourceRecordId: item.id,
            sourceSubrecordId: item.seriesId
          })
        ),
      ...payrollStatuses
        .filter((item) => !item.isDeleted && !!item.isLocked)
        .map((item) =>
          getPaymentSourceKey({
            sourceType: 'payroll_status',
            sourceRecordId: item.id,
            sourceSubrecordId: item.employeeId,
            metadata: {
              employeeId: item.employeeId,
              month: item.month
            }
          })
        )
    ]
  }, [workspaceId])

  return useMemo(() => new Set(keys ?? []), [keys])
}

function assertSettlementPaymentMethod(
  paymentMethod: WorkspacePaymentMethod
): asserts paymentMethod is LoanPaymentMethod {
  if (paymentMethod === 'credit' || paymentMethod === 'unknown') {
    throw new Error('Select a settlement payment method')
  }
}

export function assertStandardSettlementPaymentMethod(
  paymentMethod: WorkspacePaymentMethod
): asserts paymentMethod is Exclude<LoanPaymentMethod, 'loan_adjustment' | 'loan'> {
  assertSettlementPaymentMethod(paymentMethod)

  if (paymentMethod === 'loan_adjustment' || paymentMethod === 'loan') {
    throw new Error('Select a standard settlement payment method')
  }
}

export function isReversiblePaymentSourceType(sourceType: PaymentTransactionSourceType) {
  return (
    sourceType === 'loan_payment' ||
    sourceType === 'simple_loan' ||
    sourceType === 'loan_installment' ||
    sourceType === 'installment_sale_down_payment' ||
    sourceType === 'installment_sale_installment' ||
    sourceType === 'real_estate_commission' ||
    sourceType === 'clinical_appointment' ||
    sourceType === 'travel_booking_payment' ||
    sourceType === 'sales_order' ||
    sourceType === 'purchase_order' ||
    sourceType === 'expense_item' ||
    sourceType === 'payroll_status' ||
    sourceType === 'direct_transaction'
  )
}

async function listPaymentTransactionsForSource(workspaceId: string, locator: SourceLocator) {
  if (locator.sourceType === 'payroll_status') {
    const sourceKey = getPaymentSourceKey(locator)
    const items = await db.payment_transactions.where('workspaceId').equals(workspaceId).toArray()

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
  if (input.id) {
    const existing = await db.payment_transactions.get(input.id)
    if (existing && !existing.isDeleted) return existing
  }
  const now = new Date().toISOString()
  const paidAt = input.paidAt ? new Date(input.paidAt).toISOString() : now
  const reversedTransaction = input.reversalOfTransactionId
    ? await db.payment_transactions.get(input.reversalOfTransactionId)
    : undefined
  if (reversedTransaction?.voidId) {
    throw new Error('Voided payment transactions cannot be reversed')
  }
  const accountId = input.accountId === undefined
    ? reversedTransaction?.accountId ?? null
    : input.accountId
  const accountNameSnapshot = input.accountNameSnapshot === undefined
    ? reversedTransaction?.accountNameSnapshot ?? null
    : input.accountNameSnapshot
  const cashierShiftOccurrenceId = await resolveActiveCashierShiftOccurrenceId(workspaceId, {
    cashierUserId: input.createdBy,
    accountId
  })
  const transaction: PaymentTransaction = {
    id: input.id ?? generateId(),
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
    accountId,
    accountNameSnapshot,
    cashierShiftOccurrenceId,
    reversalOfTransactionId: input.reversalOfTransactionId ?? null,
    metadata: input.metadata ?? null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    isDeleted: false,
    ...getSyncMetadata(workspaceId, now)
  }

  if (!shouldUseCloudBusinessData(workspaceId)) {
    await assertPaymentAccountTransactionCanBeAppliedLocally(transaction)
    await db.payment_transactions.put(transaction)
    await mirrorPaymentAccountTransactionLocally(transaction)
    return transaction
  }

  if (!isOnline()) {
    await assertPaymentAccountTransactionCanBeAppliedLocally(transaction)
    await db.payment_transactions.put(transaction)
    await mirrorPaymentAccountTransactionLocally(transaction)
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
      input.idempotent
        ? client.from('payment_transactions').upsert(payload, { onConflict: 'id' })
        : client.from('payment_transactions').insert(payload)
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
    await mirrorPaymentAccountTransactionLocally(syncedTransaction)
    return syncedTransaction
  } catch (error) {
    if (shouldUseOfflineMutationFallback(error)) {
      console.error('[Payments] Payment transaction sync failed, queued offline mutation:', error)
      await assertPaymentAccountTransactionCanBeAppliedLocally(transaction)
      await db.payment_transactions.put(transaction)
      await mirrorPaymentAccountTransactionLocally(transaction)
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

function isProvisionalOrderReference(referenceLabel: string) {
  return /^(?:SO|PO)-PENDING-/i.test(referenceLabel)
}

/**
 * Replaces a temporary cloud order number on every payment belonging to that
 * order. Payment timestamps and accounting amounts are deliberately left
 * untouched; this only repairs the human-facing document reference.
 */
export async function synchronizeOrderPaymentReferences(
  workspaceId: string,
  orderType: Extract<OrderType, 'sales' | 'purchase'>,
  orderId: string,
  orderNumber: string | null | undefined,
  options?: { deferRemoteSync?: boolean }
) {
  const referenceLabel = orderNumber?.trim()
  if (!referenceLabel || isProvisionalOrderReference(referenceLabel)) return []

  const sourceType: PaymentTransaction['sourceType'] = orderType === 'sales' ? 'sales_order' : 'purchase_order'
  const currentRows = await db.payment_transactions
    .where('[workspaceId+sourceType+sourceRecordId]')
    .equals([workspaceId, sourceType, orderId])
    .toArray()
  const rowsToUpdate = currentRows.filter((row) => !row.isDeleted && row.referenceLabel !== referenceLabel)
  if (rowsToUpdate.length === 0) return []

  const now = new Date().toISOString()
  const updatedRows = rowsToUpdate.map((row) => ({
    ...row,
    referenceLabel,
    updatedAt: now,
    version: row.version + 1,
    ...getSyncMetadata(workspaceId, now)
  }))

  const updatedRowsById = new Map(updatedRows.map((row) => [row.id, row]))
  const pendingPaymentMutations = await db.offline_mutations
    .where('workspaceId')
    .equals(workspaceId)
    .filter(
      (mutation) =>
        mutation.entityType === 'payment_transactions' &&
        mutation.status !== 'synced' &&
        updatedRowsById.has(mutation.entityId)
    )
    .toArray()

  await db.transaction('rw', [db.payment_transactions, db.offline_mutations], async () => {
    await db.payment_transactions.bulkPut(updatedRows)
    await Promise.all(
      pendingPaymentMutations.map((mutation) => {
        const transaction = updatedRowsById.get(mutation.entityId)
        if (!transaction) return Promise.resolve()

        return db.offline_mutations.update(mutation.id, {
          payload: {
            ...mutation.payload,
            referenceLabel,
            updatedAt: transaction.updatedAt,
            version: transaction.version,
            syncStatus: transaction.syncStatus,
            lastSyncedAt: transaction.lastSyncedAt
          }
        })
      })
    )
  })

  if (!shouldUseCloudBusinessData(workspaceId)) return updatedRows
  if (options?.deferRemoteSync && pendingPaymentMutations.length > 0) return updatedRows

  const queueUpdates = async () => {
    await Promise.all(
      updatedRows.map((row) =>
        addToOfflineMutations(
          'payment_transactions',
          row.id,
          'update',
          row as unknown as Record<string, unknown>,
          workspaceId
        )
      )
    )
  }

  if (!isOnline()) {
    await queueUpdates()
    return
  }

  try {
    const client = getSupabaseClientForTable('payment_transactions')
    const payload = updatedRows.map((row) => sanitizeSyncPayload(row as unknown as Record<string, unknown>))
    const { error } = await runMutation('payment_transactions.sync_order_reference', () =>
      client.from('payment_transactions').upsert(payload, { onConflict: 'id' })
    )
    if (error) throw error

    const syncedAt = new Date().toISOString()
    await db.payment_transactions.bulkPut(
      updatedRows.map((row) => ({
        ...row,
        syncStatus: 'synced' as const,
        lastSyncedAt: syncedAt
      }))
    )
  } catch (error) {
    // A document-label correction must never undo a successfully posted
    // payment or order. Keep it queued until a later sync can repair it.
    console.error('[Payments] Failed to synchronize order payment references:', error)
    await queueUpdates()
  }

  return updatedRows
}

/** Repairs older payments that were saved before the server issued an order number. */
export async function repairPendingOrderPaymentReferences(workspaceId: string) {
  const [salesOrders, purchaseOrders] = await Promise.all([
    db.sales_orders.where('workspaceId').equals(workspaceId).toArray(),
    db.purchase_orders.where('workspaceId').equals(workspaceId).toArray()
  ])

  await Promise.all([
    ...salesOrders
      .filter((order) => !order.isDeleted && !isProvisionalOrderReference(order.orderNumber || ''))
      .map((order) => synchronizeOrderPaymentReferences(workspaceId, 'sales', order.id, order.orderNumber)),
    ...purchaseOrders
      .filter((order) => !order.isDeleted && !isProvisionalOrderReference(order.orderNumber || ''))
      .map((order) => synchronizeOrderPaymentReferences(workspaceId, 'purchase', order.id, order.orderNumber))
  ])
}

function getBeauty2PaymentDate(issueDate?: string | null) {
  if (issueDate && /^\d{4}-\d{2}-\d{2}$/.test(issueDate)) {
    return `${issueDate}T12:00:00.000Z`
  }
  return new Date().toISOString()
}

async function replaceBeauty2AppointmentPayment(
  workspaceId: string,
  appointment: ClinicalAppointment,
  targetAmount: number,
  targetCurrency: Extract<CurrencyCode, 'iqd' | 'usd'>,
  createdBy?: string | null,
  selection: {
    accountId?: string | null
    accountNameSnapshot?: string | null
  } = {}
) {
  const relatedTransactions = await listPaymentTransactionsForSource(workspaceId, {
    sourceType: 'clinical_appointment',
    sourceRecordId: appointment.id
  })
  const reversedIds = new Set(
    relatedTransactions
      .filter((transaction) => !!transaction.reversalOfTransactionId)
      .map((transaction) => transaction.reversalOfTransactionId as string)
  )
  const activeAutoTransactions = relatedTransactions
    .filter(
      (transaction) =>
        !transaction.isDeleted &&
        !transaction.reversalOfTransactionId &&
        !reversedIds.has(transaction.id) &&
        transaction.metadata?.beauty2AutoPayment === true
    )
    .sort((left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt))

  const normalizedAmount = Math.max(0, Number(targetAmount || 0))
  const current = activeAutoTransactions[0]
  const effectiveAccountId = selection.accountId === undefined ? (current?.accountId ?? null) : selection.accountId
  const effectiveAccountName =
    selection.accountNameSnapshot === undefined ? (current?.accountNameSnapshot ?? null) : selection.accountNameSnapshot
  if (
    activeAutoTransactions.length === 1 &&
    current.currency === targetCurrency &&
    Math.abs(current.amount - normalizedAmount) <= 0.000001 &&
    current.accountId === effectiveAccountId
  ) {
    return current
  }

  for (const transaction of activeAutoTransactions) {
    await appendPaymentTransaction(workspaceId, {
      sourceModule: 'clinical_appointments',
      sourceType: 'clinical_appointment',
      sourceRecordId: appointment.id,
      sourceSubrecordId: null,
      direction: 'incoming',
      amount: -Math.abs(transaction.amount),
      currency: transaction.currency,
      paymentMethod: transaction.paymentMethod,
      paidAt: new Date().toISOString(),
      counterpartyName: transaction.counterpartyName || appointment.receivedFromName || appointment.patientName,
      referenceLabel: transaction.referenceLabel || appointment.appointmentNumber || null,
      note: `Reversal after editing appointment ${appointment.appointmentNumber || appointment.id}`,
      createdBy: createdBy || null,
      reversalOfTransactionId: transaction.id,
      metadata: {
        ...(transaction.metadata || {}),
        beauty2AutoPayment: true,
        reversal: true
      }
    })
  }

  let replacement: PaymentTransaction | null = null
  if (normalizedAmount > 0) {
    replacement = await appendPaymentTransaction(workspaceId, {
      sourceModule: 'clinical_appointments',
      sourceType: 'clinical_appointment',
      sourceRecordId: appointment.id,
      sourceSubrecordId: null,
      direction: 'incoming',
      amount: normalizedAmount,
      currency: targetCurrency,
      paymentMethod: 'unknown',
      paidAt: getBeauty2PaymentDate(appointment.issueDate),
      counterpartyName: appointment.receivedFromName || appointment.patientName,
      referenceLabel: appointment.appointmentNumber || null,
      note: appointment.internalNotes || null,
      createdBy: createdBy || null,
      accountId: effectiveAccountId,
      accountNameSnapshot: effectiveAccountName,
      metadata: {
        beauty2AutoPayment: true,
        appointmentId: appointment.id,
        appointmentNumber: appointment.appointmentNumber || null,
        calculatedAmount: normalizedAmount,
        calculatedAmountCurrency: targetCurrency
      }
    })
  }

  const { updateClinicalAppointment } = await import('./clinicalAppointments')
  await updateClinicalAppointment(appointment.id, {}, workspaceId)
  return replacement
}

export function syncBeauty2AppointmentPayment(
  workspaceId: string,
  appointment: ClinicalAppointment,
  createdBy?: string | null,
  selection: {
    accountId?: string | null
    accountNameSnapshot?: string | null
  } = {}
) {
  const currency = appointment.calculatedAmountCurrency === 'usd' ? 'usd' : 'iqd'
  return replaceBeauty2AppointmentPayment(
    workspaceId,
    appointment,
    appointment.calculatedAmount || 0,
    currency,
    createdBy,
    selection
  )
}

export function reverseBeauty2AppointmentPayment(
  workspaceId: string,
  appointment: ClinicalAppointment,
  createdBy?: string | null
) {
  const currency = appointment.calculatedAmountCurrency === 'usd' ? 'usd' : 'iqd'
  return replaceBeauty2AppointmentPayment(workspaceId, appointment, 0, currency, createdBy)
}

export async function appendLoanOriginationTransactionForLoan(
  workspaceId: string,
  loan: Pick<
    Loan,
    | 'id'
    | 'workspaceId'
    | 'source'
    | 'loanCategory'
    | 'direction'
    | 'principalAmount'
    | 'settlementCurrency'
    | 'createdAt'
    | 'borrowerName'
    | 'loanNo'
    | 'notes'
    | 'createdBy'
  >,
  selection: {
    accountId?: string | null
    accountNameSnapshot?: string | null
  } = {}
) {
  if (loan.workspaceId !== workspaceId) {
    throw new Error('Workspace mismatch')
  }

  const input = buildLoanOriginationTransactionInput(loan)
  if (!input) {
    return null
  }

  const existing = await db.payment_transactions
    .where('[workspaceId+sourceType+sourceRecordId]')
    .equals([workspaceId, 'loan_origination', loan.id])
    .toArray()

  if (existing.length > 0) {
    return (
      existing
        .slice()
        .sort(
          (left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt)
        )[0] || null
    )
  }

  return appendPaymentTransaction(workspaceId, {
    ...input,
    ...(selection.accountId === undefined
      ? {}
      : {
          accountId: selection.accountId,
          accountNameSnapshot: selection.accountNameSnapshot ?? null
        })
  })
}

async function ensureManualLoanOriginationTransactions(workspaceId: string) {
  const running = loanOriginationEnsureLocks.get(workspaceId)
  if (running) {
    return running
  }

  const task = (async () => {
    const [loans, transactions] = await Promise.all([
      db.loans.where('workspaceId').equals(workspaceId).toArray(),
      db.payment_transactions.where('workspaceId').equals(workspaceId).toArray()
    ])

    const existingLoanIds = new Set(
      transactions.filter((item) => item.sourceType === 'loan_origination').map((item) => item.sourceRecordId)
    )

    for (const loan of loans) {
      if (loan.isDeleted || loan.source !== 'manual' || existingLoanIds.has(loan.id)) {
        continue
      }

      try {
        await appendLoanOriginationTransactionForLoan(workspaceId, loan)
        existingLoanIds.add(loan.id)
      } catch (error) {
        console.error('[Payments] Failed to ensure loan origination transaction:', error)
      }
    }
  })().finally(() => {
    loanOriginationEnsureLocks.delete(workspaceId)
  })

  loanOriginationEnsureLocks.set(workspaceId, task)
  return task
}

export async function hideLoanTransactionsForDeletedLoan(workspaceId: string, loanId: string) {
  const relatedTransactions = await db.payment_transactions.where('workspaceId').equals(workspaceId).toArray()

  const activeLoanTransactions = relatedTransactions.filter(
    (item) => !item.isDeleted && item.sourceModule === 'loans' && item.sourceRecordId === loanId
  )

  for (const transaction of activeLoanTransactions) {
    await softDeletePaymentTransaction(transaction)
  }
}

/**
 * Internal compensation for a source record that could not be created after
 * its payment was posted. This preserves the payment audit trail as a soft
 * delete and lets the account-movement trigger restore the balance.
 */
export async function softDeletePaymentTransaction(transaction: PaymentTransaction) {
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
    await assertPaymentAccountTransactionCanBeAppliedLocally(deletedTransaction)
    await db.payment_transactions.put(deletedTransaction)
    await mirrorPaymentAccountTransactionLocally(deletedTransaction)
    return
  }

  if (!isOnline()) {
    await assertPaymentAccountTransactionCanBeAppliedLocally(deletedTransaction)
    await db.payment_transactions.put(deletedTransaction)
    await mirrorPaymentAccountTransactionLocally(deletedTransaction)
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
      client.from('payment_transactions').update({ is_deleted: true, updated_at: now }).eq('id', transaction.id)
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
      await assertPaymentAccountTransactionCanBeAppliedLocally(deletedTransaction)
      await db.payment_transactions.put(deletedTransaction)
      await mirrorPaymentAccountTransactionLocally(deletedTransaction)
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

export async function retireReplacedPaymentTransactions(
  workspaceId: string,
  locator: SourceLocator,
  keepTransactionId: string,
  metadata: Record<string, unknown> | null = null
) {
  const relatedTransactions = await listPaymentTransactionsForSource(workspaceId, {
    ...locator,
    metadata: locator.metadata ?? metadata
  })

  for (const item of relatedTransactions) {
    if (item.isDeleted || item.id === keepTransactionId) {
      continue
    }

    try {
      await softDeletePaymentTransaction(item)
    } catch (error) {
      console.error('[Payments] Failed to hide replaced transaction row:', error)
    }
  }
}

export async function replacePaymentTransactionForSource(
  workspaceId: string,
  locator: SourceLocator,
  input: AppendPaymentTransactionInput
) {
  const next = await appendPaymentTransaction(workspaceId, input)
  await retireReplacedPaymentTransactions(workspaceId, locator, next.id, input.metadata ?? null)

  return next
}

export async function recordDirectTransaction(workspaceId: string, input: RecordDirectTransactionInput) {
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
  let partnerAccountEffect: DirectTransactionPartnerAccountEffect = input.partnerAccountEffect || 'none'

  if (businessPartnerId) {
    const partner = await db.business_partners.get(businessPartnerId)
    if (!partner || partner.isDeleted || partner.mergedIntoBusinessPartnerId) {
      throw new Error('Business partner not found')
    }

    counterpartyName = partner.partnerName
    businessPartnerId = partner.id
  }

  if (!businessPartnerId) {
    partnerAccountEffect = 'none'
  }

  if (!isDirectTransactionPartnerAccountEffect(partnerAccountEffect) && partnerAccountEffect !== 'none') {
    throw new Error('Invalid partner account effect')
  }

  if (!isDirectTransactionEffectCompatibleWithDirection(partnerAccountEffect, input.direction)) {
    throw new Error('Partner account effect does not match the transaction direction')
  }

  if (!counterpartyName) {
    throw new Error('Counterparty is required')
  }

  const transaction = await appendPaymentTransaction(workspaceId, {
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
    accountId: input.accountId ?? null,
    accountNameSnapshot: input.accountNameSnapshot ?? null,
    metadata: {
      reason,
      businessPartnerId,
      partnerAccountEffect
    }
  })

  if (businessPartnerId && partnerAccountEffect !== 'none') {
    const { recalculateBusinessPartnerSummary } = await import('./businessPartners')
    await recalculateBusinessPartnerSummary(workspaceId, businessPartnerId)
  }

  return transaction
}

const PARTNER_SETTLEMENT_SOURCE_TYPES = new Set<PaymentTransactionSourceType>([
  'loan_installment',
  'simple_loan',
  'installment_sale_installment',
  'real_estate_commission',
  'agent_commission_payout',
  'agent_commission_recovery',
  'sales_order',
  'purchase_order'
])

async function resolveSettlementPartner(workspaceId: string, partnerId: string) {
  const partner = await db.business_partners.get(partnerId)
  if (!partner || partner.isDeleted || partner.mergedIntoBusinessPartnerId || partner.workspaceId !== workspaceId) {
    throw new Error('Business partner not found')
  }
  return partner
}

type AgentCommissionBalance = {
  agentId: string
  assignmentId: string
  order: SalesOrder
  partner: BusinessPartner
  currency: CurrencyCode
  amount: number
  occurredAt: string
}

/**
 * Commission entries are immutable, while their net balance is an open item.
 * A positive balance is payable to the agent; a negative balance is a
 * recoverable amount owed by that agent's linked business partner.
 */
export async function buildAgentCommissionObligations(
  workspaceId: string
): Promise<PaymentObligation[]> {
  const [agents, partners, entries, orders, assignments] = await Promise.all([
    db.agents.where('workspaceId').equals(workspaceId).toArray(),
    db.business_partners.where('workspaceId').equals(workspaceId).toArray(),
    db.agent_commission_entries.where('workspaceId').equals(workspaceId).toArray(),
    db.sales_orders.where('workspaceId').equals(workspaceId).toArray(),
    db.sales_order_agent_assignments.where('workspaceId').equals(workspaceId).toArray()
  ])

  const partnersById = new Map(
    partners
      .filter((partner) => !partner.isDeleted && !partner.mergedIntoBusinessPartnerId)
      .map((partner) => [partner.id, partner])
  )
  const commissionAgents = new Map(
    agents
      .filter((agent) => (
        !agent.isDeleted
        && agent.agentType === 'field_agent'
        && partnersById.has(agent.businessPartnerId)
      ))
      .map((agent) => [agent.id, agent])
  )
  if (commissionAgents.size === 0) {
    return []
  }

  const ordersById = new Map(
    orders.filter((order) => !order.isDeleted).map((order) => [order.id, order])
  )
  const assignmentsById = new Map(
    assignments
      .filter((assignment) => !assignment.isDeleted)
      .map((assignment) => [assignment.id, assignment])
  )
  const balances = new Map<string, AgentCommissionBalance>()

  for (const entry of entries) {
    if (
      entry.isDeleted
      || entry.kind === 'estimate'
      || entry.kind === 'approval'
      || !entry.assignmentId
      || !entry.orderId
    ) {
      continue
    }

    const agent = commissionAgents.get(entry.agentId)
    const order = ordersById.get(entry.orderId)
    const assignment = assignmentsById.get(entry.assignmentId)
    const partner = agent ? partnersById.get(agent.businessPartnerId) : undefined
    if (
      !agent
      || !partner
      || !order
      || !assignment
      || assignment.agentId !== agent.id
      || assignment.orderId !== order.id
    ) {
      continue
    }

    const amount = Number(entry.amount || 0)
    if (!Number.isFinite(amount)) {
      continue
    }

    const key = `${agent.id}:${assignment.id}:${entry.currency}`
    const current = balances.get(key)
    if (current) {
      current.amount += amount
      if (entry.occurredAt < current.occurredAt) {
        current.occurredAt = entry.occurredAt
      }
      continue
    }

    balances.set(key, {
      agentId: agent.id,
      assignmentId: assignment.id,
      order,
      partner,
      currency: entry.currency,
      amount,
      occurredAt: entry.occurredAt
    })
  }

  const todayKey = new Date().toISOString().slice(0, 10)
  return Array.from(balances.values())
    .filter((balance) => Math.abs(balance.amount) > PAYMENT_AMOUNT_EPSILON)
    .map((balance): PaymentObligation => {
      const dueDate = normalizeDateKey(balance.occurredAt)
      const isPayout = balance.amount > 0
      return {
        id: `agent-commission:${balance.agentId}:${balance.assignmentId}:${balance.currency}`,
        workspaceId,
        sourceModule: 'orders',
        sourceType: isPayout ? 'agent_commission_payout' : 'agent_commission_recovery',
        sourceRecordId: balance.order.id,
        sourceSubrecordId: balance.assignmentId,
        direction: isPayout ? 'outgoing' : 'incoming',
        amount: Math.abs(balance.amount),
        currency: balance.currency,
        dueDate,
        createdAt: balance.occurredAt,
        counterpartyName: balance.partner.partnerName,
        referenceLabel: balance.order.orderNumber,
        title: balance.partner.partnerName,
        subtitle: balance.order.orderNumber,
        status: isDateOverdue(dueDate, todayKey) ? 'overdue' : 'open',
        routePath: `/orders/${balance.order.id}`,
        metadata: {
          businessPartnerId: balance.partner.id,
          agentId: balance.agentId,
          commissionAssignmentId: balance.assignmentId,
          orderId: balance.order.id
        }
      }
    })
}

async function collectLockedOrderSourceKeys(workspaceId: string) {
  const [salesOrders, purchaseOrders] = await Promise.all([
    db.sales_orders.where('workspaceId').equals(workspaceId).toArray(),
    db.purchase_orders.where('workspaceId').equals(workspaceId).toArray()
  ])

  return new Set([
    ...salesOrders
      .filter((item) => !item.isDeleted && !!item.isLocked)
      .map((item) =>
        getPaymentSourceKey({
          sourceType: 'sales_order',
          sourceRecordId: item.id,
          sourceSubrecordId: null
        })
      ),
    ...purchaseOrders
      .filter((item) => !item.isDeleted && !!item.isLocked)
      .map((item) =>
        getPaymentSourceKey({
          sourceType: 'purchase_order',
          sourceRecordId: item.id,
          sourceSubrecordId: null
        })
      )
  ])
}

function isEligiblePartnerObligation(
  obligation: PaymentObligation,
  partnerId: string,
  direction: PaymentTransactionDirection
) {
  return (
    obligation.direction === direction &&
    PARTNER_SETTLEMENT_SOURCE_TYPES.has(obligation.sourceType) &&
    getMetadataString(obligation.metadata, 'businessPartnerId') === partnerId
  )
}

/**
 * Deterministic obligation ordering: oldest due date first (missing due dates
 * last), then oldest source-record creation first (missing creation dates
 * last), then reference label for stability.
 */
function compareObligationAllocationOrder(left: PaymentObligation, right: PaymentObligation): number {
  const dueDateCompare =
    !left.dueDate && !right.dueDate
      ? 0
      : !left.dueDate
        ? 1
        : !right.dueDate
          ? -1
          : left.dueDate.localeCompare(right.dueDate)
  if (dueDateCompare !== 0) {
    return dueDateCompare
  }

  const createdAtCompare =
    !left.createdAt && !right.createdAt
      ? 0
      : !left.createdAt
        ? 1
        : !right.createdAt
          ? -1
          : left.createdAt.localeCompare(right.createdAt)
  if (createdAtCompare !== 0) {
    return createdAtCompare
  }

  return (left.referenceLabel || '').localeCompare(right.referenceLabel || '')
}

/**
 * Returns the outstanding settlement balance for a business partner in a
 * single direction. Collect (`incoming`) covers obligations where the partner
 * owes us money; Pay (`outgoing`) covers obligations we owe the partner.
 * Obligations are returned oldest-due-first so settlements can be allocated
 * deterministically across them.
 */
export async function getPartnerSettlementBalance(
  workspaceId: string,
  partnerId: string,
  direction: PaymentTransactionDirection
): Promise<PartnerSettlementBalance> {
  const partner = await resolveSettlementPartner(workspaceId, partnerId)
  const [obligations, lockedSourceKeys] = await Promise.all([
    buildPaymentObligations(workspaceId, { direction }),
    collectLockedOrderSourceKeys(workspaceId)
  ])

  const eligibleObligations = obligations
    .filter((item) => isEligiblePartnerObligation(item, partner.id, direction))
    .filter((item) => item.amount > PAYMENT_AMOUNT_EPSILON)
    .filter((item) => !lockedSourceKeys.has(getPaymentSourceKey(item)))
    .sort(compareObligationAllocationOrder)

  const totalsByCurrency = new Map<CurrencyCode, { total: number; items: number }>()
  eligibleObligations.forEach((item) => {
    const current = totalsByCurrency.get(item.currency) || {
      total: 0,
      items: 0
    }
    current.total += item.amount
    current.items += 1
    totalsByCurrency.set(item.currency, current)
  })

  const groups = Array.from(totalsByCurrency.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => ({
      currency,
      total: value.total,
      items: value.items
    }))

  return {
    partnerId: partner.id,
    direction,
    groups,
    total: groups.reduce((sum, group) => sum + group.total, 0),
    items: groups.reduce((sum, group) => sum + group.items, 0),
    eligibleObligations
  }
}

/**
 * Settles all (or part of) the outstanding balance of a business partner in
 * a single direction. The amount is allocated oldest-due-first across the
 * partner's eligible open obligations using the existing per-source payment
 * flows, so each obligation keeps its correct remaining balance and every
 * generated payment transaction is linked to the obligation it settled.
 */
export async function settlePartnerBalance(
  workspaceId: string,
  input: SettlePartnerBalanceInput
): Promise<SettlePartnerBalanceResult> {
  const partner = await resolveSettlementPartner(workspaceId, input.partnerId)
  assertStandardSettlementPaymentMethod(input.paymentMethod)
  const paymentMethod = input.paymentMethod

  const balance = await getPartnerSettlementBalance(workspaceId, partner.id, input.direction)
  if (balance.total <= PAYMENT_AMOUNT_EPSILON || balance.items === 0) {
    throw new Error(
      input.direction === 'incoming'
        ? 'This partner has no outstanding collectable balance'
        : 'There are no outstanding payables for this partner'
    )
  }

  const requestedAmount = Number(input.amount || 0)
  const remainingByCurrency = new Map<CurrencyCode, number>()
  const useScalarRemaining = !input.amountsByCurrency || input.amountsByCurrency.length === 0

  if (input.amountsByCurrency && input.amountsByCurrency.length > 0) {
    let requestedTotal = 0
    for (const entry of input.amountsByCurrency) {
      const entryAmount = Number(entry.amount || 0)
      if (!Number.isFinite(entryAmount) || entryAmount < -PAYMENT_AMOUNT_EPSILON) {
        throw new Error('Settlement amount cannot exceed the outstanding balance')
      }

      const group = balance.groups.find((item) => item.currency === entry.currency)
      if (!group || entryAmount - group.total > PAYMENT_AMOUNT_EPSILON) {
        throw new Error('Settlement amount cannot exceed the outstanding balance')
      }

      remainingByCurrency.set(entry.currency, Math.max(0, entryAmount))
      requestedTotal += Math.max(0, entryAmount)
    }
    if (requestedTotal <= PAYMENT_AMOUNT_EPSILON) {
      throw new Error('Settlement could not be allocated to any open obligation')
    }
  } else if (requestedAmount > PAYMENT_AMOUNT_EPSILON && requestedAmount - balance.total > PAYMENT_AMOUNT_EPSILON) {
    throw new Error('Settlement amount cannot exceed the outstanding balance')
  }

  const paidAt = input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString()
  const note = input.note?.trim() || null
  const createdBy = input.createdBy || null
  let remaining = useScalarRemaining ? (requestedAmount > PAYMENT_AMOUNT_EPSILON ? requestedAmount : balance.total) : 0

  const appliedByCurrency = new Map<CurrencyCode, { total: number; items: number }>()
  const settledObligationCount = new Map<string, number>()

  const touchedItems = (() => {
    let touched = 0
    let scalarRemaining = remaining
    const perCurrencyRemaining = useScalarRemaining ? null : new Map(remainingByCurrency)
    for (const obligation of balance.eligibleObligations) {
      const cap = useScalarRemaining ? scalarRemaining : (perCurrencyRemaining!.get(obligation.currency) ?? 0)
      if (cap <= PAYMENT_AMOUNT_EPSILON) {
        if (useScalarRemaining) {
          break
        }
        continue
      }

      const applied = Math.min(obligation.amount, cap)
      if (applied <= PAYMENT_AMOUNT_EPSILON) {
        continue
      }

      touched += 1
      if (useScalarRemaining) {
        scalarRemaining = Math.max(scalarRemaining - applied, 0)
      } else {
        perCurrencyRemaining!.set(obligation.currency, cap - applied)
      }
    }
    return touched
  })()

  let settledItems = 0
  input.onProgress?.({ settledItems: 0, totalItems: touchedItems })

  for (const obligation of balance.eligibleObligations) {
    const cap = useScalarRemaining ? remaining : (remainingByCurrency.get(obligation.currency) ?? 0)
    if (useScalarRemaining) {
      if (remaining <= PAYMENT_AMOUNT_EPSILON) {
        break
      }
    } else if (cap <= PAYMENT_AMOUNT_EPSILON) {
      continue
    }

    const applied = Math.min(obligation.amount, cap)
    if (applied <= PAYMENT_AMOUNT_EPSILON) {
      continue
    }

    switch (obligation.sourceType) {
      case 'loan_installment':
      case 'simple_loan': {
        const { recordLoanPayment } = await import('./hooks')
        await recordLoanPayment(workspaceId, {
          loanId: obligation.sourceRecordId,
          installmentId:
            obligation.sourceType === 'loan_installment' ? obligation.sourceSubrecordId || undefined : undefined,
          amount: applied,
          paymentMethod,
          note: note || undefined,
          paidAt,
          createdBy: createdBy || undefined,
          accountId: input.accountId ?? null,
          accountNameSnapshot: input.accountNameSnapshot ?? null
        })
        break
      }

      case 'installment_sale_installment': {
        const { recordInstallmentSaleCustomerPayment } = await import('./installmentSales')
        await recordInstallmentSaleCustomerPayment(workspaceId, {
          installmentSaleId: obligation.sourceRecordId,
          installmentId: obligation.sourceSubrecordId || null,
          amount: applied,
          paymentMethod,
          note,
          paidAt,
          createdBy,
          accountId: input.accountId ?? null,
          accountNameSnapshot: input.accountNameSnapshot ?? null
        })
        break
      }

      case 'sales_order':
      case 'purchase_order': {
        const { recordOrderPayment } = await import('./orders')
        await recordOrderPayment(workspaceId, {
          orderType: obligation.sourceType === 'sales_order' ? 'sales' : 'purchase',
          orderId: obligation.sourceRecordId,
          installmentId: obligation.sourceSubrecordId,
          amount: applied,
          paymentMethod,
          paidAt,
          note,
          createdBy,
          accountId: input.accountId ?? null,
          accountNameSnapshot: input.accountNameSnapshot ?? null
        })
        break
      }

      case 'real_estate_commission': {
        const { recordRealEstateCommissionPayment } = await import('./realEstate')
        await recordRealEstateCommissionPayment(workspaceId, {
          transactionId: obligation.sourceRecordId,
          amount: applied,
          paymentMethod,
          counterpartyName: obligation.counterpartyName || partner.partnerName,
          businessPartnerId: partner.id,
          note,
          paidAt,
          createdBy,
          accountId: input.accountId ?? null,
          accountNameSnapshot: input.accountNameSnapshot ?? null
        })
        break
      }

      case 'agent_commission_payout': {
        const agentId = getMetadataString(obligation.metadata, 'agentId')
        const assignmentId = getMetadataString(obligation.metadata, 'commissionAssignmentId')
        if (!agentId || !assignmentId) {
          throw new Error('Sales agent commission settlement metadata is incomplete')
        }

        const { recordAgentCommissionPayout } = await import('./agentCommissions')
        await recordAgentCommissionPayout(workspaceId, {
          agentId,
          assignmentId,
          orderId: obligation.sourceRecordId,
          amount: applied,
          currency: obligation.currency,
          paymentMethod,
          paidAt,
          note,
          createdBy,
          accountId: input.accountId ?? null,
          accountNameSnapshot: input.accountNameSnapshot ?? null
        })
        break
      }

      case 'agent_commission_recovery': {
        const agentId = getMetadataString(obligation.metadata, 'agentId')
        const assignmentId = getMetadataString(obligation.metadata, 'commissionAssignmentId')
        if (!agentId || !assignmentId) {
          throw new Error('Sales agent commission settlement metadata is incomplete')
        }

        const { recordAgentCommissionRecovery } = await import('./agentCommissions')
        await recordAgentCommissionRecovery(workspaceId, {
          agentId,
          assignmentId,
          orderId: obligation.sourceRecordId,
          amount: applied,
          currency: obligation.currency,
          paymentMethod,
          paidAt,
          note,
          createdBy,
          accountId: input.accountId ?? null,
          accountNameSnapshot: input.accountNameSnapshot ?? null
        })
        break
      }

      default:
        continue
    }

    const currencyTotal = appliedByCurrency.get(obligation.currency) || {
      total: 0,
      items: 0
    }
    currencyTotal.total += applied
    currencyTotal.items += 1
    appliedByCurrency.set(obligation.currency, currencyTotal)
    settledObligationCount.set(obligation.id, applied)
    if (useScalarRemaining) {
      remaining = Math.max(remaining - applied, 0)
    } else {
      remainingByCurrency.set(obligation.currency, cap - applied)
    }
    settledItems += 1
    input.onProgress?.({ settledItems, totalItems: touchedItems })
  }

  const totalSettled = Array.from(appliedByCurrency.values()).reduce((sum, group) => sum + group.total, 0)
  if (totalSettled <= PAYMENT_AMOUNT_EPSILON) {
    throw new Error('Settlement could not be allocated to any open obligation')
  }

  try {
    const { recalculateBusinessPartnerSummary } = await import('./businessPartners')
    await recalculateBusinessPartnerSummary(workspaceId, partner.id)
  } catch (error) {
    console.error('[Payments] Failed to refresh partner summary after settlement:', error)
  }

  return {
    partnerId: partner.id,
    partnerName: partner.partnerName,
    direction: input.direction,
    totalSettled,
    items: settledObligationCount.size,
    groups: Array.from(appliedByCurrency.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, group]) => ({
        currency,
        total: group.total,
        items: group.items
      }))
  }
}

export async function findLatestUnreversedPaymentTransaction(workspaceId: string, locator: SourceLocator) {
  const relevant = (await listPaymentTransactionsForSource(workspaceId, locator)).filter((item) => {
    if (!isReportablePaymentTransaction(item)) {
      return false
    }

    return true
  })

  const reversalAmounts = getPaymentTransactionReversalAmounts(relevant)

  return relevant
    .filter((item) => {
      if (item.reversalOfTransactionId) return false
      return Math.abs(Number(item.amount || 0)) - (reversalAmounts.get(item.id) || 0) > PAYMENT_AMOUNT_EPSILON
    })
    .sort((left, right) => right.paidAt.localeCompare(left.paidAt) || right.createdAt.localeCompare(left.createdAt))[0]
}

export async function recordObligationSettlement(
  workspaceId: string,
  obligation: PaymentObligation,
  input: RecordObligationSettlementInput
) {
  const paidAt = input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString()
  const note = input.note?.trim() || null
  const createdBy = input.createdBy || null
  const settlementAmount = input.amount !== undefined ? Number(input.amount || 0) : obligation.amount

  if (obligation.workspaceId !== workspaceId) {
    throw new Error('Workspace mismatch')
  }

  if (settlementAmount <= 0) {
    throw new Error('Invalid settlement amount')
  }

  switch (obligation.sourceType) {
    case 'loan_installment':
    case 'simple_loan': {
      assertSettlementPaymentMethod(input.paymentMethod)
      const { recordLoanPayment } = await import('./hooks')
      await recordLoanPayment(workspaceId, {
        loanId: obligation.sourceRecordId,
        installmentId:
          obligation.sourceType === 'loan_installment' ? obligation.sourceSubrecordId || undefined : undefined,
        amount: obligation.amount,
        paymentMethod: input.paymentMethod,
        note: note || undefined,
        paidAt,
        createdBy: createdBy || undefined,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null
      })
      return
    }

    case 'installment_sale_installment': {
      assertStandardSettlementPaymentMethod(input.paymentMethod)
      if (settlementAmount > obligation.amount) {
        throw new Error('Settlement amount cannot exceed the customer balance')
      }
      const { recordInstallmentSaleCustomerPayment } = await import('./installmentSales')
      await recordInstallmentSaleCustomerPayment(workspaceId, {
        installmentSaleId: obligation.sourceRecordId,
        installmentId: obligation.sourceSubrecordId || null,
        amount: settlementAmount,
        paymentMethod: input.paymentMethod,
        note,
        paidAt,
        createdBy,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null
      })
      return
    }

    case 'real_estate_commission': {
      assertStandardSettlementPaymentMethod(input.paymentMethod)
      if (settlementAmount > obligation.amount) {
        throw new Error('Settlement amount cannot exceed the receivable balance')
      }
      const { recordRealEstateCommissionPayment } = await import('./realEstate')
      await recordRealEstateCommissionPayment(workspaceId, {
        transactionId: obligation.sourceRecordId,
        amount: settlementAmount,
        paymentMethod: input.paymentMethod,
        counterpartyName: input.counterpartyName || obligation.counterpartyName || null,
        businessPartnerId: input.businessPartnerId || getMetadataString(obligation.metadata, 'businessPartnerId'),
        note,
        paidAt,
        createdBy,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null
      })
      return
    }

    case 'agent_commission_payout':
    case 'agent_commission_recovery': {
      assertStandardSettlementPaymentMethod(input.paymentMethod)
      if (settlementAmount - obligation.amount > PAYMENT_AMOUNT_EPSILON) {
        throw new Error('Settlement amount cannot exceed the commission balance')
      }
      const agentId = getMetadataString(obligation.metadata, 'agentId')
      const assignmentId = getMetadataString(obligation.metadata, 'commissionAssignmentId')
      if (!agentId || !assignmentId) {
        throw new Error('Sales agent commission settlement metadata is incomplete')
      }
      const { recordAgentCommissionPayout, recordAgentCommissionRecovery } = await import('./agentCommissions')
      const commissionInput = {
        agentId,
        assignmentId,
        orderId: obligation.sourceRecordId,
        amount: settlementAmount,
        currency: obligation.currency,
        paymentMethod: input.paymentMethod,
        paidAt,
        note,
        createdBy,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null
      }
      if (obligation.sourceType === 'agent_commission_payout') {
        await recordAgentCommissionPayout(workspaceId, commissionInput)
      } else {
        await recordAgentCommissionRecovery(workspaceId, commissionInput)
      }
      return
    }

    case 'sales_order': {
      assertStandardSettlementPaymentMethod(input.paymentMethod)
      if (settlementAmount > obligation.amount) {
        throw new Error('Settlement amount cannot exceed the order balance')
      }
      const { recordOrderPayment } = await import('./orders')
      await recordOrderPayment(workspaceId, {
        orderType: 'sales',
        orderId: obligation.sourceRecordId,
        installmentId: obligation.sourceSubrecordId,
        amount: settlementAmount,
        paymentMethod: input.paymentMethod,
        paidAt,
        note,
        createdBy,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null
      })
      return
    }

    case 'clinical_appointment': {
      assertStandardSettlementPaymentMethod(input.paymentMethod)
      const appointment = await db.clinical_appointments.get(obligation.sourceRecordId)
      if (!appointment || appointment.isDeleted || appointment.workspaceId !== workspaceId) {
        throw new Error('Appointment not found')
      }

      const sourceTransactions = await listPaymentTransactionsForSource(workspaceId, {
        sourceType: 'clinical_appointment',
        sourceRecordId: appointment.id
      })
      const currentSummary = getClinicalAppointmentPaymentSummary(appointment, sourceTransactions)
      if (!currentSummary.canCollect) {
        throw new Error('This appointment has no collectible balance')
      }

      const paymentTransaction = await appendPaymentTransaction(workspaceId, {
        sourceModule: 'clinical_appointments',
        sourceType: 'clinical_appointment',
        sourceRecordId: appointment.id,
        sourceSubrecordId: null,
        direction: 'incoming',
        amount: settlementAmount,
        currency: obligation.currency,
        paymentMethod: input.paymentMethod,
        paidAt,
        counterpartyName: appointment.patientName,
        referenceLabel: obligation.referenceLabel,
        note,
        createdBy,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null,
        metadata: {
          appointmentId: appointment.id,
          appointmentType: appointment.appointmentType,
          requestedService: appointment.reasonForVisit || appointment.serviceProcedure || null,
          serviceFee: currentSummary.serviceFee
        }
      })
      const { updateClinicalAppointment } = await import('./clinicalAppointments')
      await updateClinicalAppointment(
        appointment.id,
        {
          paymentStatus: getClinicalAppointmentPaymentSummary({ ...appointment, currency: obligation.currency }, [
            ...sourceTransactions,
            paymentTransaction
          ]).paymentStatus
        },
        workspaceId
      )
      return
    }

    case 'purchase_order': {
      assertStandardSettlementPaymentMethod(input.paymentMethod)
      if (settlementAmount > obligation.amount) {
        throw new Error('Settlement amount cannot exceed the order balance')
      }
      const { recordOrderPayment } = await import('./orders')
      await recordOrderPayment(workspaceId, {
        orderType: 'purchase',
        orderId: obligation.sourceRecordId,
        installmentId: obligation.sourceSubrecordId,
        amount: settlementAmount,
        paymentMethod: input.paymentMethod,
        paidAt,
        note,
        createdBy,
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null
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
      const locator: SourceLocator = {
        sourceType: 'expense_item',
        sourceRecordId: item.id,
        sourceSubrecordId: item.seriesId
      }
      const paymentInput: AppendPaymentTransactionInput = {
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
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null,
        metadata: {
          month: item.month,
          seriesId: item.seriesId,
          category: series?.category || null,
          subcategory: series?.subcategory || null
        }
      }

      // Post the actual outgoing payment first. A selected account may
      // reject it for insufficient funds; in that case the expense must
      // remain unpaid rather than presenting a paid status without money
      // leaving the account.
      const paymentTransaction = await appendPaymentTransaction(workspaceId, paymentInput)
      try {
        await updateExpenseItem(item.id, {
          status: 'paid',
          paidAt,
          snoozedUntil: null,
          snoozedIndefinite: false
        })
      } catch (error) {
        await softDeletePaymentTransaction(paymentTransaction)
        throw error
      }
      await retireReplacedPaymentTransactions(
        workspaceId,
        locator,
        paymentTransaction.id,
        paymentInput.metadata ?? null
      )
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

      const existingStatus = await db.payroll_statuses
        .where('[employeeId+month]')
        .equals([employeeId, month])
        .and((item) => !item.isDeleted)
        .first()
      // A new status does not have to be committed as paid just to obtain
      // an identifier for its payment transaction. There is no foreign
      // key between these records, so a generated ID can safely be used
      // and the status is only persisted after the payment is funded.
      const sourceRecordId = existingStatus?.id ?? generateId()
      const locator: SourceLocator = {
        sourceType: 'payroll_status',
        sourceRecordId,
        sourceSubrecordId: employee.id,
        metadata: {
          employeeId: employee.id,
          month
        }
      }
      const paymentInput: AppendPaymentTransactionInput = {
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
        accountId: input.accountId ?? null,
        accountNameSnapshot: input.accountNameSnapshot ?? null,
        metadata: {
          employeeId: employee.id,
          month
        }
      }

      const paymentTransaction = await appendPaymentTransaction(workspaceId, paymentInput)
      try {
        const { upsertPayrollStatus } = await import('./hooks')
        await upsertPayrollStatus(workspaceId, employeeId, month, {
          id: sourceRecordId,
          status: 'paid',
          paidAt,
          snoozedUntil: null,
          snoozedIndefinite: false
        })
      } catch (error) {
        await softDeletePaymentTransaction(paymentTransaction)
        throw error
      }
      await retireReplacedPaymentTransactions(
        workspaceId,
        locator,
        paymentTransaction.id,
        paymentInput.metadata ?? null
      )
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
  /** Omitted means the complete remaining amount. */
  amount?: number
  /** Omitted preserves the original payment method. */
  paymentMethod?: WorkspacePaymentMethod
  /** Omitted inherits the original account; null explicitly posts ledger-only. */
  accountId?: string | null
  accountNameSnapshot?: string | null
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

  if (!isReportablePaymentTransaction(transaction)) {
    throw new Error('Voided payment transactions cannot be reversed')
  }

  if (transaction.reversalOfTransactionId) {
    throw new Error('Reversal entries cannot be reversed')
  }

  if (!isReversiblePaymentSourceType(transaction.sourceType)) {
    throw new Error('This transaction type cannot be reversed in v1')
  }

  const relatedTransactions = await listPaymentTransactionsForSource(workspaceId, {
    sourceType: transaction.sourceType,
    sourceRecordId: transaction.sourceRecordId,
    sourceSubrecordId: transaction.sourceSubrecordId ?? undefined,
    metadata: transaction.metadata
  })
  const reversalState = getPaymentTransactionReversalState(transaction, relatedTransactions)
  if (reversalState.status === 'fully_reversed') {
    throw new Error('This payment has already been fully reversed')
  }

  const reversalAmount = input.amount === undefined
    ? reversalState.remainingAmount
    : Number(input.amount)
  if (!Number.isFinite(reversalAmount) || reversalAmount <= PAYMENT_AMOUNT_EPSILON) {
    throw new Error('Enter a valid reversal amount')
  }
  if (reversalAmount - reversalState.remainingAmount > PAYMENT_AMOUNT_EPSILON) {
    throw new Error('The reversal amount cannot exceed the remaining payment amount')
  }
  if (
    reversalState.amountPolicy === 'full_remaining' &&
    Math.abs(reversalAmount - reversalState.remainingAmount) > PAYMENT_AMOUNT_EPSILON
  ) {
    throw new Error('This payment can only be reversed for its full remaining amount')
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

  const note = input.note?.trim() || `Reversal of ${transaction.referenceLabel || transaction.sourceType}`
  const reversalPaymentMethod = input.paymentMethod ?? transaction.paymentMethod
  const reversalAccount = input.accountId === undefined
    ? {}
    : {
        accountId: input.accountId,
        accountNameSnapshot: input.accountNameSnapshot ?? null
      }

  switch (transaction.sourceType) {
    case 'loan_payment':
    case 'simple_loan':
    case 'loan_installment': {
      const loan = await db.loans.get(transaction.sourceRecordId)
      if (!loan || loan.isDeleted) throw new Error('Loan not found')
      const { reverseLoanPayment } = await import('./hooks')
      const reversal = await appendPaymentTransaction(workspaceId, {
        sourceModule: transaction.sourceModule,
        sourceType: transaction.sourceType,
        sourceRecordId: transaction.sourceRecordId,
        sourceSubrecordId: transaction.sourceSubrecordId ?? null,
        direction: transaction.direction,
        amount: -reversalAmount,
        currency: transaction.currency,
        paymentMethod: reversalPaymentMethod,
        paidAt: input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString(),
        counterpartyName: transaction.counterpartyName || null,
        referenceLabel: loan.loanNo || transaction.referenceLabel || null,
        note,
        createdBy: input.createdBy || null,
        ...reversalAccount,
        reversalOfTransactionId: transaction.id,
        metadata: {
          ...(transaction.metadata && typeof transaction.metadata === 'object' ? transaction.metadata : {}),
          reversal: true
        }
      })
      try {
        await reverseLoanPayment(workspaceId, transaction)
        return reversal
      } catch (error) {
        await softDeletePaymentTransaction(reversal)
        throw error
      }
    }

    case 'sales_order': {
      const reversal = await appendPaymentTransaction(workspaceId, {
        sourceModule: transaction.sourceModule,
        sourceType: transaction.sourceType,
        sourceRecordId: transaction.sourceRecordId,
        sourceSubrecordId: transaction.sourceSubrecordId ?? null,
        direction: transaction.direction,
        amount: -reversalAmount,
        currency: transaction.currency,
        paymentMethod: reversalPaymentMethod,
        paidAt: input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString(),
        counterpartyName: transaction.counterpartyName || null,
        referenceLabel: transaction.referenceLabel || null,
        note,
        createdBy: input.createdBy || null,
        ...reversalAccount,
        reversalOfTransactionId: transaction.id,
        metadata: {
          ...(transaction.metadata && typeof transaction.metadata === 'object' ? transaction.metadata : {}),
          reversal: true
        }
      })
      const { rebuildOrderPaymentState } = await import('./orders')
      await rebuildOrderPaymentState('sales', transaction.sourceRecordId)
      return reversal
    }

    case 'purchase_order': {
      const reversal = await appendPaymentTransaction(workspaceId, {
        sourceModule: transaction.sourceModule,
        sourceType: transaction.sourceType,
        sourceRecordId: transaction.sourceRecordId,
        sourceSubrecordId: transaction.sourceSubrecordId ?? null,
        direction: transaction.direction,
        amount: -reversalAmount,
        currency: transaction.currency,
        paymentMethod: reversalPaymentMethod,
        paidAt: input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString(),
        counterpartyName: transaction.counterpartyName || null,
        referenceLabel: transaction.referenceLabel || null,
        note,
        createdBy: input.createdBy || null,
        ...reversalAccount,
        reversalOfTransactionId: transaction.id,
        metadata: {
          ...(transaction.metadata && typeof transaction.metadata === 'object' ? transaction.metadata : {}),
          reversal: true
        }
      })
      const { rebuildOrderPaymentState } = await import('./orders')
      await rebuildOrderPaymentState('purchase', transaction.sourceRecordId)
      return reversal
    }

    case 'clinical_appointment': {
      const reversal = await appendPaymentTransaction(workspaceId, {
        sourceModule: 'clinical_appointments',
        sourceType: 'clinical_appointment',
        sourceRecordId: transaction.sourceRecordId,
        sourceSubrecordId: null,
        direction: 'incoming',
        amount: -reversalAmount,
        currency: transaction.currency,
        paymentMethod: reversalPaymentMethod,
        paidAt: input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString(),
        counterpartyName: transaction.counterpartyName || null,
        referenceLabel: transaction.referenceLabel || null,
        note,
        createdBy: input.createdBy || null,
        ...reversalAccount,
        reversalOfTransactionId: transaction.id,
        metadata: {
          ...(transaction.metadata && typeof transaction.metadata === 'object' ? transaction.metadata : {}),
          reversal: true
        }
      })
      const { updateClinicalAppointment } = await import('./clinicalAppointments')
      await updateClinicalAppointment(transaction.sourceRecordId, {}, workspaceId)
      return reversal
    }

    case 'travel_booking_payment': {
      const { reverseTravelBookingPayment } = await import('./travelTransportation')
      const { reversal } = await reverseTravelBookingPayment(workspaceId, transaction.id, {
        ...input,
        amount: reversalAmount,
        paymentMethod: reversalPaymentMethod,
        ...reversalAccount
      })
      return reversal
    }

    case 'expense_item': {
      const item = await db.expense_items.get(transaction.sourceRecordId)
      if (!item || item.isDeleted) {
        throw new Error('Expense item not found')
      }
      if (item.isLocked) {
        throw new Error('Locked paid expenses cannot be reversed')
      }

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

      break
    }

    case 'direct_transaction':
      break
  }
  // A reversal is an additional immutable payment transaction. Keeping the
  // original posted row is essential for both the audit trail and the
  // payment-account balance (the two signed deltas net to zero).
  const reversal = await appendPaymentTransaction(workspaceId, {
    sourceModule: transaction.sourceModule,
    sourceType: transaction.sourceType,
    sourceRecordId: transaction.sourceRecordId,
    sourceSubrecordId: transaction.sourceSubrecordId ?? null,
    direction: transaction.direction,
    amount: -reversalAmount,
    currency: transaction.currency,
    paymentMethod: reversalPaymentMethod,
    paidAt: input.paidAt ? new Date(input.paidAt).toISOString() : new Date().toISOString(),
    counterpartyName: transaction.counterpartyName || null,
    referenceLabel: transaction.referenceLabel || null,
    note,
    createdBy: input.createdBy || null,
    ...reversalAccount,
    reversalOfTransactionId: transaction.id,
    metadata: {
      ...(transaction.metadata && typeof transaction.metadata === 'object' ? transaction.metadata : {}),
      reversal: true
    }
  })

  try {
    if (transaction.sourceType === 'expense_item') {
      const { updateExpenseItem } = await import('./hooks')
      await updateExpenseItem(transaction.sourceRecordId, {
        status: 'pending',
        paidAt: null,
        snoozedUntil: null,
        snoozedIndefinite: false
      })
    } else if (transaction.sourceType === 'payroll_status') {
      const employeeId = String(transaction.metadata?.employeeId || transaction.sourceSubrecordId || '')
      const month = String(transaction.metadata?.month || '')
      const { upsertPayrollStatus } = await import('./hooks')
      await upsertPayrollStatus(workspaceId, employeeId, month, {
        status: 'pending',
        paidAt: null,
        snoozedUntil: null,
        snoozedIndefinite: false
      })
    }
  } catch (error) {
    await softDeletePaymentTransaction(reversal)
    throw error
  }

  if (
    transaction.sourceType === 'installment_sale_down_payment' ||
    transaction.sourceType === 'installment_sale_installment'
  ) {
    const { rebuildInstallmentSalePaymentState } = await import('./installmentSales')
    await rebuildInstallmentSalePaymentState(workspaceId, transaction.sourceRecordId)
  }

  const businessPartnerId =
    typeof transaction.metadata?.businessPartnerId === 'string' ? transaction.metadata.businessPartnerId : null
  if (
    transaction.sourceType === 'direct_transaction' &&
    businessPartnerId &&
    isDirectTransactionPartnerAccountEffect(transaction.metadata?.partnerAccountEffect)
  ) {
    const { recalculateBusinessPartnerSummary } = await import('./businessPartners')
    await recalculateBusinessPartnerSummary(workspaceId, businessPartnerId)
  }

  return reversal
}

export function getPaymentTransactionRoutePath(
  transaction: Pick<PaymentTransaction, 'sourceModule' | 'sourceType' | 'sourceRecordId' | 'metadata'>
) {
  return getTransactionRoutePath(transaction)
}
