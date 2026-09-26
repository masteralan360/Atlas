import { getOrderLineFreeBonusInventoryQuantity, getOrderLineInventoryQuantity, getOrderLinePaidInventoryQuantity, getOrderLineUnitFactor } from '@/lib/orderLineItems'
import { getOrderAdjustmentNetAmount, isPostReturnOrderAdjustment, normalizeOrderAdjustments } from '@/lib/orderAdjustments'
import { ORDER_AMOUNT_EPSILON, roundOrderValue } from '@/lib/orderPrecision'
import { roundQuantity } from '@/lib/quantity'
import type { PaymentTransaction } from '@/local-db/models'
import type { SalesOrderTransactionGraph } from './salesOrderGraph'

export type AuditCategory = 'order' | 'items' | 'inventory' | 'payments' | 'loan' | 'relationships' | 'mirror'
export type AuditStatus = 'PASS' | 'WARNING' | 'FAIL' | 'NOT_APPLICABLE'
export interface IntegrityAuditCheck {
  code: string
  category: AuditCategory
  status: AuditStatus
  severity: 'info' | 'warning' | 'error' | 'critical'
  entityType: string
  entityId?: string
  expected?: unknown
  actual?: unknown
}
export interface IntegrityAuditResult {
  transactionType: 'sales_order'
  transactionId: string
  transactionNumber?: string
  workspaceId: string
  auditedAt: string
  sourceOfTruth: 'supabase' | 'sqlite'
  integrityStatus: AuditStatus
  mirrorStatus: AuditStatus | null
  checks: IntegrityAuditCheck[]
  summary: { total: number; passed: number; warnings: number; failed: number }
  expected: Record<string, unknown>
  actual: SalesOrderTransactionGraph
  mirrorActual: SalesOrderTransactionGraph | null
}

export class IntegrityAuditReadError extends Error {
  readonly code = 'AUDIT_SOURCE_READ_FAILED'
  readonly messageKey = 'transactionAudit.loadFailed'
  readonly cause: unknown
  constructor(readonly source: 'supabase' | 'sqlite', cause: unknown) {
    super(`Unable to read the ${source} audit graph`)
    this.cause = cause
  }
}

const close = (a: number, b: number) => Math.abs(roundOrderValue(a) - roundOrderValue(b)) <= ORDER_AMOUNT_EPSILON
const active = <T extends { isDeleted?: boolean }>(rows: T[]) => rows.filter(row => !row.isDeleted)
const amount = (value: unknown) => Number(value ?? 0)
const quantityEqual = (a: number, b: number) => Math.abs(roundQuantity(a) - roundQuantity(b)) < 0.000001

function buildCheck(
  category: AuditCategory, code: string, matches: boolean, entityType: string,
  entityId?: string, expected?: unknown, actual?: unknown, warning = false
): IntegrityAuditCheck {
  return { code, category, status: matches ? 'PASS' : warning ? 'WARNING' : 'FAIL',
    severity: matches ? 'info' : warning ? 'warning' : 'error', entityType, entityId, expected, actual }
}

function paymentNet(row: PaymentTransaction, all: PaymentTransaction[]): number {
  if (row.isDeleted || row.voidId) return 0
  const reversals = all.filter(candidate => !candidate.isDeleted && !candidate.voidId && candidate.reversalOfTransactionId === row.id)
  return roundOrderValue(amount(row.amount) - reversals.reduce((sum, candidate) => sum + Math.abs(amount(candidate.amount)), 0))
}

/** Pure reconciliation: validators consume one normalized graph and never access storage. */
export function auditSalesOrderGraph(graph: SalesOrderTransactionGraph, workspaceId: string, orderId: string, source?: 'supabase' | 'sqlite') {
  const checks: IntegrityAuditCheck[] = []
  const add = (...args: Parameters<typeof buildCheck>) => checks.push(buildCheck(...args))
  const order = graph.order
  const expected: Record<string, unknown> = {}
  add('order', 'ORDER_EXISTS', !!order, 'sales_order', orderId, true, !!order)
  if (!order) return { checks, expected }
  add('order', 'WORKSPACE_MISMATCH', order.workspaceId === workspaceId, 'sales_order', order.id, workspaceId, order.workspaceId)
  add('order', 'ORDER_ACTIVE', !order.isDeleted, 'sales_order', order.id, false, !!order.isDeleted)
  add('order', 'ORDER_STATUS_INVALID', ['completed', 'cancelled'].includes(order.status), 'sales_order', order.id, 'completed or cancelled', order.status)
  add('order', 'ORDER_CURRENCY_MISSING', !!order.currency, 'sales_order', order.id)
  add('order', 'ORDER_ITEMS_INVALID', Array.isArray(order.items) && order.items.length > 0, 'sales_order', order.id)
  const items = Array.isArray(order.items) ? order.items.filter(item => item && typeof item === 'object') : []
  if (Array.isArray(order.items)) add('items', 'ORDER_ITEM_RECORD_INVALID', items.length === order.items.length, 'sales_order', order.id, order.items.length, items.length)
  const productMap = new Map(graph.products.map(product => [product.id, product]))
  const itemIds = new Set<string>()
  let originalSubtotal = 0
  const expectedInventory = new Map<string, number>()
  for (const item of items) {
    add('items', 'DUPLICATE_ORDER_ITEM', !itemIds.has(item.id), 'sales_order_item', item.id)
    itemIds.add(item.id)
    const product = productMap.get(item.productId)
    add('items', 'PRODUCT_MISSING', !!product && !product.isDeleted, 'product', item.productId, true, !!product && !product.isDeleted)
    if (product) add('relationships', 'PRODUCT_WORKSPACE_MISMATCH', product.workspaceId === workspaceId, 'product', product.id, workspaceId, product.workspaceId)
    add('items', 'ITEM_QUANTITY_INVALID', Number.isFinite(item.quantity) && item.quantity >= 0 && getOrderLineInventoryQuantity(item) > 0, 'sales_order_item', item.id)
    add('items', 'BONUS_QUANTITY_INVALID', amount(item.freeBonusQuantity) >= 0 && Number.isFinite(amount(item.freeBonusQuantity)), 'sales_order_item', item.id)
    add('items', 'ITEM_PRICE_INVALID', Number.isFinite(item.convertedUnitPrice) && item.convertedUnitPrice >= 0, 'sales_order_item', item.id)
    add('items', 'ITEM_COST_SNAPSHOT_INVALID', Number.isFinite(item.convertedCostPrice) && item.convertedCostPrice >= 0, 'sales_order_item', item.id)
    add('items', 'ITEM_CURRENCY_MISMATCH', item.settlementCurrency === order.currency, 'sales_order_item', item.id, order.currency, item.settlementCurrency)
    if (item.originalCurrency !== order.currency) {
      add('items', 'EXCHANGE_RATE_SNAPSHOT_MISSING', !!order.exchangeRates?.length, 'sales_order_item', item.id)
    }
    const lineTotal = roundOrderValue(amount(item.quantity) * amount(item.convertedUnitPrice))
    add('items', 'ITEM_TOTAL_MISMATCH', close(lineTotal, item.lineTotal), 'sales_order_item', item.id, lineTotal, item.lineTotal)
    originalSubtotal = roundOrderValue(originalSubtotal + lineTotal)
    if (product && (amount(item.fulfilledQuantity) > 0 || !product.isService) && order.status === 'completed') {
      const storageId = item.storageId || order.sourceStorageId || ''
      add('inventory', 'SOURCE_STORAGE_MISSING', !!storageId, 'sales_order_item', item.id)
      const factor = getOrderLineUnitFactor(item)
      const paidUnits = roundQuantity(amount(item.quantity) * factor)
      const bonusUnits = roundQuantity(amount(item.freeBonusQuantity) * factor)
      add('items', 'PAID_INVENTORY_QUANTITY_MISMATCH', quantityEqual(paidUnits, getOrderLinePaidInventoryQuantity(item)), 'sales_order_item', item.id, paidUnits, getOrderLinePaidInventoryQuantity(item))
      add('items', 'BONUS_INVENTORY_QUANTITY_MISMATCH', quantityEqual(bonusUnits, getOrderLineFreeBonusInventoryQuantity(item)), 'sales_order_item', item.id, bonusUnits, getOrderLineFreeBonusInventoryQuantity(item))
      const key = `${item.productId}:${storageId}`
      expectedInventory.set(key, roundQuantity((expectedInventory.get(key) ?? 0) - paidUnits - bonusUnits))
      add('inventory', 'FULFILLED_QUANTITY_MISMATCH', item.fulfilledQuantity == null || quantityEqual(amount(item.fulfilledQuantity), paidUnits + bonusUnits), 'sales_order_item', item.id, paidUnits + bonusUnits, item.fulfilledQuantity)
    }
  }
  const adjustments = normalizeOrderAdjustments(order.orderAdjustments, order.currency)
  if (Array.isArray(order.orderAdjustments)) add('order', 'ORDER_ADJUSTMENT_INVALID', adjustments.length === order.orderAdjustments.length, 'sales_order', order.id, order.orderAdjustments.length, adjustments.length)
  for (const adjustment of adjustments) {
    add('order', 'ORDER_ADJUSTMENT_AMOUNT_MISMATCH', close(roundOrderValue(adjustment.amount * adjustment.exchangeRate), adjustment.convertedAmount), 'order_adjustment', adjustment.id, roundOrderValue(adjustment.amount * adjustment.exchangeRate), adjustment.convertedAmount)
    if (adjustment.currency !== order.currency) add('order', 'ORDER_ADJUSTMENT_RATE_SNAPSHOT_MISSING', adjustment.exchangeRates.length > 0, 'order_adjustment', adjustment.id)
  }
  add('order', 'ORDER_DISCOUNT_INVALID', Number.isFinite(amount(order.discount)) && amount(order.discount) >= 0, 'sales_order', order.id)
  add('order', 'ORDER_TAX_INVALID', Number.isFinite(amount(order.tax)) && amount(order.tax) >= 0, 'sales_order', order.id)
  const saleAdjustments = adjustments.filter(row => !isPostReturnOrderAdjustment(row))
  const postedReturns = active(graph.returns).filter(row => row.status === 'posted')
  const returnedTotal = roundOrderValue(postedReturns.reduce((sum, row) => sum + amount(row.refundAmount), 0))
  // Returns rescale the header discount and tax; the original components are
  // not preserved. Do not compare a recomputation using those current values.
  const originalComponentsUnavailable = postedReturns.length > 0 && (amount(order.discount) !== 0 || amount(order.tax) !== 0)
  if (originalComponentsUnavailable) add('order', 'ORIGINAL_DISCOUNT_TAX_HISTORY_UNAVAILABLE', false, 'sales_order', order.id, undefined, undefined, true)
  const originalTotal = originalComponentsUnavailable
    ? amount(order.originalTotalAmount)
    : roundOrderValue(originalSubtotal - amount(order.discount) + amount(order.tax) + getOrderAdjustmentNetAmount(saleAdjustments))
  const effectiveTotal = roundOrderValue(originalTotal - returnedTotal)
  expected.orderTotal = effectiveTotal
  expected.originalTotal = originalTotal
  expected.subtotal = originalSubtotal
  expected.inventory = Object.fromEntries(expectedInventory)
  if (postedReturns.length === 0) add('order', 'ORDER_SUBTOTAL_MISMATCH', close(originalSubtotal, order.subtotal), 'sales_order', order.id, originalSubtotal, order.subtotal)
  add('order', 'ORDER_TOTAL_MISMATCH', close(effectiveTotal, order.total), 'sales_order', order.id, effectiveTotal, order.total)
  if (postedReturns.length > 0) {
    if (!originalComponentsUnavailable) add('order', 'ORIGINAL_TOTAL_MISMATCH', close(originalTotal, amount(order.originalTotalAmount)), 'sales_order', order.id, originalTotal, order.originalTotalAmount)
    add('order', 'RETURNED_AMOUNT_MISMATCH', close(returnedTotal, amount(order.returnedAmount)), 'sales_order', order.id, returnedTotal, order.returnedAmount)
  }

  add('relationships', 'CUSTOMER_REFERENCE_MISSING', !!order.customerId && graph.customers.some(row => row.id === order.customerId && !row.isDeleted), 'customer', order.customerId)
  if (order.businessPartnerId) add('relationships', 'PARTNER_REFERENCE_MISSING', graph.partners.some(row => row.id === order.businessPartnerId && !row.isDeleted), 'business_partner', order.businessPartnerId)
  for (const row of [...graph.customers, ...graph.partners, ...graph.returns, ...graph.returnItems, ...graph.loans,
    ...graph.loanPayments, ...graph.loanInstallments, ...graph.orderInstallments, ...graph.payments,
    ...graph.inventoryMovements, ...graph.accountMovements, ...graph.paymentAccounts, ...graph.assignments, ...graph.commissions, ...graph.productCommissions]) {
    add('relationships', 'RELATED_WORKSPACE_MISMATCH', row.workspaceId === workspaceId, 'related_record', row.id, workspaceId, row.workspaceId)
  }
  const returnMap = new Map(graph.returns.map(row => [row.id, row]))
  const returnedInventory = new Map<string, number>()
  const returnedByItem = new Map<string, number>()
  const returnItemKeys = new Set<string>()
  for (const row of graph.returnItems) {
    add('relationships', 'ORPHAN_RETURN_ITEM', returnMap.get(row.returnId)?.orderId === order.id && row.orderId === order.id && itemIds.has(row.orderItemId), 'order_return_item', row.id)
    const returnKey = `${row.returnId}:${row.orderItemId}`
    add('relationships', 'DUPLICATE_RETURN_ITEM', !returnItemKeys.has(returnKey), 'order_return_item', row.id)
    returnItemKeys.add(returnKey)
    if (!row.isDeleted && returnMap.get(row.returnId)?.status === 'posted') {
      const item = items.find(candidate => candidate.id === row.orderItemId)
      if (item) {
        const key = `${item.productId}:${row.restoredStorageId || item.storageId || order.sourceStorageId || ''}`
        returnedInventory.set(key, roundQuantity((returnedInventory.get(key) ?? 0) + amount(row.inventoryQuantity ?? row.quantity)))
        returnedByItem.set(item.id, roundQuantity((returnedByItem.get(item.id) ?? 0) + amount(row.inventoryQuantity ?? row.quantity)))
        add('inventory', 'RETURN_QUANTITY_INVALID', amount(row.inventoryQuantity ?? row.quantity) > 0 && amount(row.inventoryQuantity ?? row.quantity) <= getOrderLineInventoryQuantity(item), 'order_return_item', row.id)
        add('items', 'RETURN_BONUS_QUANTITY_MISMATCH', row.paidInventoryQuantity == null || row.freeInventoryQuantity == null || quantityEqual(amount(row.paidInventoryQuantity) + amount(row.freeInventoryQuantity), amount(row.inventoryQuantity ?? row.quantity)), 'order_return_item', row.id)
      }
    }
  }
  for (const item of items) {
    const returned = returnedByItem.get(item.id) ?? 0
    add('items', 'ITEM_RETURNED_QUANTITY_MISMATCH', quantityEqual(returned, amount(item.returnedQuantity)), 'sales_order_item', item.id, returned, item.returnedQuantity)
    add('inventory', 'RETURN_EXCEEDS_SOLD_QUANTITY', returned <= getOrderLineInventoryQuantity(item), 'sales_order_item', item.id, getOrderLineInventoryQuantity(item), returned)
  }
  expected.inventoryNet = Object.fromEntries([...new Set([...expectedInventory.keys(), ...returnedInventory.keys()])].map(key => [key, roundQuantity((expectedInventory.get(key) ?? 0) + (returnedInventory.get(key) ?? 0))]))
  for (const row of graph.returns) {
    add('relationships', 'WRONG_RETURN_REFERENCE', row.orderId === order.id, 'order_return', row.id, order.id, row.orderId)
    if (row.status === 'posted') add('order', 'RETURN_ITEM_AMOUNT_MISMATCH', close(row.refundAmount,
      active(graph.returnItems).filter(item => item.returnId === row.id).reduce((sum, item) => sum + amount(item.refundAmount), 0)), 'order_return', row.id)
  }

  const salesMovements = active(graph.inventoryMovements).filter(row => row.referenceId === order.id && row.referenceType === 'sales_order')
  const actualInventory = new Map<string, number>()
  for (const row of graph.inventoryMovements) {
    add('relationships', 'WRONG_INVENTORY_REFERENCE', (row.referenceId === order.id && row.referenceType === 'sales_order')
      || (!!row.referenceId && returnMap.has(row.referenceId) && row.referenceType === 'order_return'), 'inventory_transaction', row.id, order.id, row.referenceId)
  }
  for (const row of salesMovements) {
    const key = `${row.productId}:${row.storageId}`
    actualInventory.set(key, roundQuantity((actualInventory.get(key) ?? 0) + amount(row.quantityDelta)))
    add('inventory', 'INVENTORY_MOVEMENT_TYPE_INVALID', row.transactionType === 'sale', 'inventory_transaction', row.id, 'sale', row.transactionType)
    add('inventory', 'INVENTORY_MOVEMENT_ARITHMETIC_MISMATCH', quantityEqual(amount(row.previousQuantity) + amount(row.quantityDelta), amount(row.newQuantity)), 'inventory_transaction', row.id)
  }
  for (const [key, expectedDelta] of expectedInventory) {
    const rows = salesMovements.filter(row => `${row.productId}:${row.storageId}` === key)
    const legacyOrLocal = source !== 'supabase' || Date.parse(order.actualDeliveryDate ?? order.createdAt ?? '') < Date.parse('2026-09-25T14:28:44Z')
    add('inventory', 'INVENTORY_MOVEMENT_MISSING', rows.length > 0, 'inventory_transaction', key, expectedDelta, actualInventory.get(key) ?? null, legacyOrLocal)
    if (rows.length) {
      add('inventory', 'INVENTORY_MOVEMENT_DUPLICATE', rows.length === 1, 'inventory_transaction', key, 1, rows.length)
      add('inventory', 'INVENTORY_QUANTITY_MISMATCH', quantityEqual(expectedDelta, actualInventory.get(key) ?? 0), 'inventory_transaction', key, expectedDelta, actualInventory.get(key))
    }
  }
  for (const key of actualInventory.keys()) if (!expectedInventory.has(key)) add('inventory', 'UNEXPECTED_INVENTORY_MOVEMENT', false, 'inventory_transaction', key, null, actualInventory.get(key))
  if (postedReturns.length > 0) {
    add('inventory', 'RETURN_INVENTORY_HISTORY_UNAVAILABLE', false, 'order_return', order.id, 'transaction-specific restoration rows', null, true)
  }

  const paymentRows = active(graph.payments)
  const paymentMap = new Map(paymentRows.map(row => [row.id, row]))
  for (const row of paymentRows) {
    add('payments', 'PAYMENT_CURRENCY_MISMATCH', row.currency === order.currency, 'payment_transaction', row.id, order.currency, row.currency)
    add('payments', 'PAYMENT_METHOD_MISSING', !!row.paymentMethod, 'payment_transaction', row.id)
    const validSource = (row.sourceType === 'sales_order' && row.sourceRecordId === order.id)
      || (row.sourceType === 'order_return' && returnMap.has(row.sourceRecordId))
      || (['loan_payment', 'simple_loan', 'loan_installment'].includes(row.sourceType) && graph.loans.some(loanRow => loanRow.id === row.sourceRecordId))
      || (['agent_commission_payout', 'agent_commission_recovery'].includes(row.sourceType)
        && graph.commissions.some(entry => entry.id === row.sourceSubrecordId && entry.agentId === row.sourceRecordId))
    add('relationships', 'WRONG_PAYMENT_REFERENCE', validSource, 'payment_transaction', row.id)
    if (row.reversalOfTransactionId) {
      const original = paymentMap.get(row.reversalOfTransactionId)
      add('relationships', 'ORPHAN_PAYMENT_REVERSAL', !!original, 'payment_transaction', row.id, row.reversalOfTransactionId, original?.id)
      if (original) add('payments', 'PAYMENT_REVERSAL_EXCEEDS_ORIGINAL', Math.abs(amount(row.amount)) <= amount(original.amount) + ORDER_AMOUNT_EPSILON, 'payment_transaction', row.id)
      if (original) add('payments', 'PAYMENT_REVERSAL_REFERENCE_MISMATCH', row.currency === original.currency && row.sourceType === original.sourceType && row.sourceRecordId === original.sourceRecordId && row.direction === original.direction, 'payment_transaction', row.id)
    }
    if (row.accountId) {
      const account = graph.paymentAccounts.find(candidate => candidate.id === row.accountId)
      add('relationships', 'PAYMENT_ACCOUNT_REFERENCE_MISSING', !!account && account.workspaceId === workspaceId && !account.isDeleted, 'payment_account', row.accountId)
      const movements = active(graph.accountMovements).filter(movement => movement.paymentTransactionId === row.id)
      add('payments', 'PAYMENT_ACCOUNT_MOVEMENT_MISSING', movements.length === 1, 'payment_transaction', row.id, 1, movements.length)
      if (movements.length === 1) {
        add('payments', 'PAYMENT_ACCOUNT_MOVEMENT_MISMATCH', movements[0].accountId === row.accountId && close(Math.abs(amount(movements[0].amount)), Math.abs(amount(row.amount))), 'payment_account_movement', movements[0].id)
        const expectedDelta = row.voidId ? 0 : row.direction === 'incoming' ? amount(row.amount) : -amount(row.amount)
        add('payments', 'PAYMENT_ACCOUNT_DELTA_MISMATCH', close(expectedDelta, amount(movements[0].deltaAmount)), 'payment_account_movement', movements[0].id, expectedDelta, movements[0].deltaAmount)
      }
    }
  }
  for (const movement of graph.accountMovements) add('relationships', 'ORPHAN_ACCOUNT_MOVEMENT', paymentMap.has(movement.paymentTransactionId), 'payment_account_movement', movement.id)
  for (const original of paymentRows.filter(row => !row.reversalOfTransactionId)) {
    const reversed = paymentRows.filter(row => row.reversalOfTransactionId === original.id).reduce((sum, row) => sum + Math.abs(amount(row.amount)), 0)
    add('payments', 'PAYMENT_REVERSALS_EXCEED_ORIGINAL', reversed <= amount(original.amount) + ORDER_AMOUNT_EPSILON, 'payment_transaction', original.id, original.amount, reversed)
  }

  const orderPayments = paymentRows.filter(row => row.sourceType === 'sales_order' && row.sourceRecordId === order.id && !row.reversalOfTransactionId)
  const orderPaid = roundOrderValue(orderPayments.reduce((sum, row) => sum + Math.max(0, paymentNet(row, paymentRows)), 0))
  add('payments', 'DUPLICATE_INITIAL_PAYMENT', orderPayments.filter(row => row.metadata?.isDownPayment === true && paymentNet(row, paymentRows) > ORDER_AMOUNT_EPSILON).length <= 1, 'sales_order', order.id)
  const financed = order.paymentMethod === 'loan' || order.paymentMethod === 'installments' || !!order.linkedLoanId
  const hasTrackedPaymentBalance = (paid: number) => order.paymentStatus !== 'unpaid' || !!order.isPaid || paid > ORDER_AMOUNT_EPSILON
  if (financed) {
    const initialPaymentEvidence = paymentRows.filter(row => !row.reversalOfTransactionId
      && (row.metadata?.isFinancingInitialPayment === true || row.metadata?.isOrderLoanInitialRepayment === true))
    const initialPaymentFromLedger = roundOrderValue(initialPaymentEvidence.reduce((sum, row) => sum + Math.max(0, paymentNet(row, paymentRows)), 0))
    add('payments', 'INITIAL_PAYMENT_HISTORY_MISSING', initialPaymentEvidence.length > 0 || amount(order.initialPaymentAmount) <= ORDER_AMOUNT_EPSILON,
      'sales_order', order.id, order.initialPaymentAmount, initialPaymentFromLedger,
      !initialPaymentEvidence.length && !graph.loanPayments.some(row => !!row.integrityVersion))
    if (initialPaymentEvidence.length) add('payments', 'INITIAL_PAYMENT_MISMATCH', close(initialPaymentFromLedger, order.initialPaymentAmount),
      'sales_order', order.id, order.initialPaymentAmount, initialPaymentFromLedger)
  }
  const matchingLoans = active(graph.loans).filter(row => row.orderId === order.id && row.orderType === 'sales')
  add('loan', 'LOAN_MISSING', !financed || matchingLoans.length === 1, 'loan', order.linkedLoanId ?? undefined, financed ? 1 : 0, matchingLoans.length)
  add('loan', 'LOAN_DUPLICATE', matchingLoans.length <= 1, 'loan', order.id, 'at most one', matchingLoans.length)
  if (!financed) add('loan', 'UNEXPECTED_LOAN', matchingLoans.length === 0, 'loan', order.id, 0, matchingLoans.length)
  const loan = matchingLoans[0]
  if (order.linkedLoanId) {
    const linked = graph.loans.find(row => row.id === order.linkedLoanId)
    add('relationships', 'WRONG_LOAN_REFERENCE', !!linked && linked.orderId === order.id && linked.orderType === 'sales', 'loan', order.linkedLoanId, order.id, linked?.orderId)
  }
  if (loan) {
    add('relationships', 'WRONG_LOAN_REFERENCE', loan.id === order.linkedLoanId && loan.source === 'order' && loan.orderId === order.id && loan.orderType === 'sales', 'loan', loan.id, order.linkedLoanId, loan.id)
    add('loan', 'LOAN_CURRENCY_MISMATCH', loan.settlementCurrency === order.currency, 'loan', loan.id, order.currency, loan.settlementCurrency)
    add('loan', 'LOAN_CUSTOMER_MISMATCH', !order.businessPartnerId || loan.linkedPartyId === order.businessPartnerId, 'loan', loan.id, order.businessPartnerId, loan.linkedPartyId)
    const repayments = active(graph.loanPayments).filter(row => row.loanId === loan.id)
    const repaid = roundOrderValue(repayments.reduce((sum, row) => sum + amount(row.amount), 0))
    const reconstructedPaid = roundOrderValue(Math.min(order.total, orderPaid + repaid))
    add('payments', 'PAYMENTS_EXCEED_ORDER_TOTAL', orderPaid + repaid <= order.total + ORDER_AMOUNT_EPSILON,
      'sales_order', order.id, order.total, roundOrderValue(orderPaid + repaid))
    const originatedPrincipal = order.paymentMethod === 'loan' ? originalTotal : roundOrderValue(originalTotal - amount(order.initialPaymentAmount))
    const expectedPrincipal = order.returnStatus === 'full'
      ? originatedPrincipal
      : roundOrderValue(Math.max(0, originatedPrincipal - returnedTotal))
    add('loan', 'LOAN_PRINCIPAL_MISMATCH', close(expectedPrincipal, loan.principalAmount), 'loan', loan.id, expectedPrincipal, loan.principalAmount)
    add('loan', 'LOAN_PAID_MISMATCH', close(repaid, loan.totalPaidAmount), 'loan', loan.id, repaid, loan.totalPaidAmount)
    const remaining = order.returnStatus === 'full' ? 0 : roundOrderValue(Math.max(0, expectedPrincipal - repaid))
    add('loan', 'LOAN_BALANCE_MISMATCH', close(remaining, loan.balanceAmount), 'loan', loan.id, remaining, loan.balanceAmount)
    add('loan', 'LOAN_STATUS_MISMATCH', loan.status === (order.returnStatus === 'full' ? 'cancelled' : remaining <= ORDER_AMOUNT_EPSILON ? 'completed' : loan.status === 'active' || loan.status === 'overdue' ? loan.status : 'active'), 'loan', loan.id)
    add('payments', 'ORDER_PAID_MISMATCH', close(reconstructedPaid, order.paidAmount), 'sales_order', order.id, reconstructedPaid, order.paidAmount)
    expected.derivedOutstandingAmount = roundOrderValue(Math.max(0, order.total - reconstructedPaid))
    if (hasTrackedPaymentBalance(reconstructedPaid)) add('payments', 'ORDER_BALANCE_MISMATCH', close(Math.max(0, order.total - reconstructedPaid), order.balanceAmount), 'sales_order', order.id, expected.derivedOutstandingAmount, order.balanceAmount)
    for (const repayment of graph.loanPayments) {
      add('relationships', 'ORPHAN_LOAN_PAYMENT', repayment.loanId === loan.id, 'loan_payment', repayment.id)
      if (!repayment.isDeleted && repayment.paymentTransactionId) {
        add('payments', 'LOAN_PAYMENT_TRANSACTION_MISSING', paymentMap.has(repayment.paymentTransactionId), 'loan_payment', repayment.id, repayment.paymentTransactionId)
        const transaction = paymentMap.get(repayment.paymentTransactionId)
        if (transaction) add('payments', 'LOAN_PAYMENT_AMOUNT_MISMATCH', close(repayment.amount, paymentNet(transaction, paymentRows)), 'loan_payment', repayment.id, repayment.amount, paymentNet(transaction, paymentRows))
      }
      if (!repayment.isDeleted && !repayment.paymentTransactionId) add('payments', 'LOAN_PAYMENT_TRANSACTION_MISSING', false, 'loan_payment', repayment.id, undefined, null, !repayment.integrityVersion)
    }
    const linkedTransactionIds = repayments.map(row => row.paymentTransactionId).filter(Boolean)
    add('loan', 'DUPLICATE_LOAN_PAYMENT', linkedTransactionIds.length === new Set(linkedTransactionIds).size, 'loan', loan.id)
  } else if (!financed) {
    add('payments', 'ORDER_PAID_MISMATCH', close(orderPaid, order.paidAmount), 'sales_order', order.id, orderPaid, order.paidAmount)
    expected.derivedOutstandingAmount = roundOrderValue(Math.max(0, order.total - orderPaid))
    // The details page derives outstanding from the order total and payments;
    // an unpaid order's cached balance is not evidence of a posted payment.
    if (hasTrackedPaymentBalance(orderPaid)) add('payments', 'ORDER_BALANCE_MISMATCH', close(Math.max(0, order.total - orderPaid), order.balanceAmount), 'sales_order', order.id, expected.derivedOutstandingAmount, order.balanceAmount)
  }
  if (loan || !financed) {
    const paid = loan ? roundOrderValue(Math.min(order.total, orderPaid + active(graph.loanPayments).reduce((sum, row) => sum + amount(row.amount), 0))) : orderPaid
    const expectedStatus = paid >= order.total - ORDER_AMOUNT_EPSILON ? 'paid' : paid > ORDER_AMOUNT_EPSILON ? 'partial' : 'unpaid'
    add('payments', 'ORDER_PAYMENT_STATUS_MISMATCH', order.paymentStatus === expectedStatus && order.isPaid === (expectedStatus === 'paid'), 'sales_order', order.id, expectedStatus, order.paymentStatus)
  }
  for (const row of graph.orderInstallments) add('relationships', 'WRONG_INSTALLMENT_REFERENCE', row.orderId === order.id && row.orderType === 'sales', 'order_installment', row.id)
  for (const row of graph.loanInstallments) add('relationships', 'ORPHAN_LOAN_INSTALLMENT', graph.loans.some(loanRow => loanRow.id === row.loanId), 'loan_installment', row.id)
  if (loan?.firstDueDate) {
    const installments = active(graph.loanInstallments).filter(row => row.loanId === loan.id)
    add('loan', 'LOAN_INSTALLMENTS_MISSING', installments.length > 0, 'loan', loan.id)
    add('loan', 'DUPLICATE_LOAN_INSTALLMENT', installments.length === new Set(installments.map(row => row.installmentNo)).size, 'loan', loan.id)
    if (installments.length && loan.status !== 'cancelled') add('loan', 'LOAN_INSTALLMENT_BALANCE_MISMATCH', close(installments.reduce((sum, row) => sum + amount(row.balanceAmount), 0), loan.balanceAmount), 'loan', loan.id, loan.balanceAmount, installments.reduce((sum, row) => sum + amount(row.balanceAmount), 0))
  }
  for (const row of graph.assignments) add('relationships', 'WRONG_COMMISSION_ASSIGNMENT_REFERENCE', row.orderId === order.id, 'sales_order_agent_assignment', row.id)
  for (const row of graph.commissions) add('relationships', 'WRONG_COMMISSION_REFERENCE', row.orderId === order.id && (!row.orderReturnId || returnMap.has(row.orderReturnId)), 'agent_commission_entry', row.id)
  for (const entry of graph.commissions.filter(row => !row.isDeleted && (row.kind === 'payout' || row.kind === 'recovery'))) {
    const transactions = paymentRows.filter(row => row.sourceSubrecordId === entry.id && (row.sourceType === 'agent_commission_payout' || row.sourceType === 'agent_commission_recovery') && !row.reversalOfTransactionId && !row.voidId)
    add('payments', 'COMMISSION_PAYMENT_MISSING', transactions.length === 1, 'agent_commission_entry', entry.id, 1, transactions.length)
    if (transactions.length === 1) add('payments', 'COMMISSION_PAYMENT_AMOUNT_MISMATCH', close(Math.abs(entry.amount), Math.abs(transactions[0].amount)), 'agent_commission_entry', entry.id, Math.abs(entry.amount), transactions[0].amount)
  }
  for (const row of graph.productCommissions) add('relationships', 'WRONG_PRODUCT_COMMISSION_REFERENCE', row.orderId === order.id && itemIds.has(row.orderItemId), 'agent_product_commission_entry', row.id)
  expected.paidAmount = loan ? roundOrderValue(orderPaid + active(graph.loanPayments).reduce((sum, row) => sum + amount(row.amount), 0)) : orderPaid
  return { checks, expected }
}

function summarize(checks: IntegrityAuditCheck[]): IntegrityAuditResult['summary'] {
  return { total: checks.length, passed: checks.filter(row => row.status === 'PASS').length,
    warnings: checks.filter(row => row.status === 'WARNING').length,
    failed: checks.filter(row => row.status === 'FAIL').length }
}
const statusOf = (checks: IntegrityAuditCheck[]): AuditStatus => checks.some(row => row.status === 'FAIL') ? 'FAIL' : checks.some(row => row.status === 'WARNING') ? 'WARNING' : 'PASS'

export async function runSalesOrderIntegrityAudit(
  workspaceId: string, orderId: string, mode: 'cloud' | 'hybrid' | 'local' | 'demo'
): Promise<IntegrityAuditResult> {
  const { resolveSalesOrderTransactionGraph } = await import('./salesOrderGraph')
  const sourceOfTruth = mode === 'local' || mode === 'demo' ? 'sqlite' : 'supabase'
  let actual: SalesOrderTransactionGraph
  try {
    actual = await resolveSalesOrderTransactionGraph(workspaceId, orderId, sourceOfTruth)
  } catch (error) {
    throw new IntegrityAuditReadError(sourceOfTruth, error)
  }
  const { checks, expected } = auditSalesOrderGraph(actual, workspaceId, orderId, sourceOfTruth)
  let mirrorStatus: AuditStatus | null = null
  let mirrorActual: SalesOrderTransactionGraph | null = null
  if (mode === 'hybrid') {
    try {
      const mirror = await resolveSalesOrderTransactionGraph(workspaceId, orderId, 'sqlite')
      mirrorActual = mirror
      const entityKeys: Array<keyof SalesOrderTransactionGraph> = [
        'order', 'inventoryMovements', 'payments', 'accountMovements', 'paymentAccounts', 'loans', 'loanPayments',
        'loanInstallments', 'orderInstallments', 'returns', 'returnItems', 'assignments', 'commissions', 'productCommissions'
      ]
      for (const key of entityKeys) {
        const sourceRows = key === 'order' ? (actual.order ? [actual.order] : []) : actual[key] as Array<{ id: string }>
        const mirrorRows = key === 'order' ? (mirror.order ? [mirror.order] : []) : mirror[key] as Array<{ id: string }>
        const mirrorById = new Map(mirrorRows.map(row => [row.id, row]))
        for (const row of sourceRows) {
          const localRow = mirrorById.get(row.id)
          if (!localRow) {
            checks.push(buildCheck('mirror', 'SQLITE_MIRROR_RECORD_MISSING', false, key, row.id, 'present', 'missing'))
            continue
          }
          const fields = key === 'order' ? ['workspaceId', 'status', 'subtotal', 'discount', 'tax', 'total', 'paidAmount', 'balanceAmount', 'linkedLoanId', 'items', 'returnStatus', 'returnedAmount']
            : key === 'inventoryMovements' ? ['workspaceId', 'referenceId', 'referenceType', 'productId', 'storageId', 'quantityDelta', 'transactionType']
              : key === 'payments' ? ['workspaceId', 'sourceType', 'sourceRecordId', 'sourceSubrecordId', 'amount', 'currency', 'direction', 'accountId', 'reversalOfTransactionId', 'isDeleted']
                : key === 'loans' ? ['workspaceId', 'orderId', 'orderType', 'principalAmount', 'totalPaidAmount', 'balanceAmount', 'settlementCurrency', 'status']
                  : key === 'loanPayments' ? ['workspaceId', 'loanId', 'amount', 'paymentTransactionId', 'isDeleted', 'reversedAmount']
                    : key === 'accountMovements' ? ['workspaceId', 'paymentTransactionId', 'accountId', 'amount', 'deltaAmount', 'currency', 'isDeleted']
                      : key === 'returnItems' ? ['workspaceId', 'returnId', 'orderId', 'orderItemId', 'quantity', 'inventoryQuantity', 'refundAmount', 'isDeleted']
                        : key === 'returns' ? ['workspaceId', 'orderId', 'refundAmount', 'status', 'isDeleted']
                          : key === 'loanInstallments' || key === 'orderInstallments' ? ['workspaceId', 'plannedAmount', 'paidAmount', 'balanceAmount', 'status', 'isDeleted']
                            : ['workspaceId', 'isDeleted']
          for (const field of fields) {
            const expectedField = (row as any)[field] ?? null
            const actualField = (localRow as any)[field] ?? null
            checks.push(buildCheck('mirror', 'SQLITE_MIRROR_FIELD_MISMATCH', JSON.stringify(expectedField) === JSON.stringify(actualField), `${key}.${field}`, row.id, expectedField, actualField))
          }
        }
        for (const row of mirrorRows) if (!sourceRows.some(source => source.id === row.id)) checks.push(buildCheck('mirror', 'SQLITE_MIRROR_ORPHAN', false, key, row.id))
      }
      mirrorStatus = statusOf(checks.filter(row => row.category === 'mirror'))
    } catch (error) {
      checks.push(buildCheck('mirror', 'SQLITE_MIRROR_UNAVAILABLE', false, 'sqlite', undefined, undefined, error instanceof Error ? error.message : String(error), true))
      mirrorStatus = 'WARNING'
    }
  }
  const transactionChecks = checks.filter(row => row.category !== 'mirror')
  return { transactionType: 'sales_order', transactionId: orderId, transactionNumber: actual.order?.orderNumber, workspaceId,
    auditedAt: new Date().toISOString(), sourceOfTruth, integrityStatus: statusOf(transactionChecks), mirrorStatus,
    checks, summary: summarize(checks), expected, actual, mirrorActual }
}
