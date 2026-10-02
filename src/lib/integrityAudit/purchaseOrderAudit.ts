import { getOrderAdjustmentNetAmount, normalizeOrderAdjustments } from '@/lib/orderAdjustments'
import { ORDER_AMOUNT_EPSILON, roundOrderValue } from '@/lib/orderPrecision'
import { getOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { roundQuantity } from '@/lib/quantity'
import type { PaymentTransaction, PurchaseOrder } from '@/local-db/models'
import type { PurchaseOrderTransactionGraph } from './purchaseOrderGraph'
import { IntegrityAuditReadError, type AuditCategory, type AuditStatus, type IntegrityAuditCheck, type IntegrityAuditResult } from './types'

export { IntegrityAuditReadError } from './types'
export type { AuditCategory, AuditStatus, IntegrityAuditCheck, IntegrityAuditResult } from './types'

export function isPurchaseOrderIntegrityAuditEligible(order: Pick<PurchaseOrder, 'paymentStatus' | 'status'>) {
  return (order.paymentStatus === 'partial' || order.paymentStatus === 'paid')
    && (order.status === 'received' || order.status === 'completed')
}

const amount = (value: unknown) => Number(value ?? 0)
const close = (left: number, right: number) => Math.abs(roundOrderValue(left) - roundOrderValue(right)) <= ORDER_AMOUNT_EPSILON
const quantityClose = (left: number, right: number) => Math.abs(roundQuantity(left) - roundQuantity(right)) < 0.000001
const active = <T extends { isDeleted?: boolean }>(rows: T[]) => rows.filter(row => !row.isDeleted)

function buildCheck(
  category: AuditCategory,
  code: string,
  matches: boolean,
  entityType: string,
  entityId?: string,
  expected?: unknown,
  actual?: unknown,
  warning = false
): IntegrityAuditCheck {
  return {
    code,
    category,
    status: matches ? 'PASS' : warning ? 'WARNING' : 'FAIL',
    severity: matches ? 'info' : warning ? 'warning' : 'error',
    entityType,
    entityId,
    expected,
    actual
  }
}

function paymentNet(row: PaymentTransaction, all: PaymentTransaction[]) {
  if (row.isDeleted || row.voidId || row.reversalOfTransactionId) return 0
  const reversed = all.filter(candidate => !candidate.isDeleted && !candidate.voidId
    && candidate.reversalOfTransactionId === row.id)
  return roundOrderValue(amount(row.amount) - reversed.reduce((sum, candidate) => sum + Math.abs(amount(candidate.amount)), 0))
}

/** Reconciles a normalized Purchase Order graph without reading or mutating storage. */
export function auditPurchaseOrderGraph(
  graph: PurchaseOrderTransactionGraph,
  workspaceId: string,
  orderId: string,
  source?: 'supabase' | 'sqlite'
) {
  const checks: IntegrityAuditCheck[] = []
  const add = (...args: Parameters<typeof buildCheck>) => checks.push(buildCheck(...args))
  const expected: Record<string, unknown> = {}
  const order = graph.order
  add('order', 'ORDER_EXISTS', !!order, 'purchase_order', orderId, true, !!order)
  if (!order) return { checks, expected }

  add('order', 'WORKSPACE_MISMATCH', order.workspaceId === workspaceId, 'purchase_order', order.id, workspaceId, order.workspaceId)
  add('order', 'ORDER_ACTIVE', !order.isDeleted, 'purchase_order', order.id, false, !!order.isDeleted)
  add('order', 'ORDER_STATUS_INVALID', ['draft', 'ordered', 'received', 'completed', 'cancelled', 'returned'].includes(order.status), 'purchase_order', order.id, 'valid purchase order status', order.status)
  add('order', 'ORDER_CURRENCY_MISSING', !!order.currency, 'purchase_order', order.id)
  const items = Array.isArray(order.items) ? order.items.filter(item => item && typeof item === 'object') : []
  add('order', 'ORDER_ITEMS_INVALID', Array.isArray(order.items) && order.items.length > 0 && items.length === order.items.length, 'purchase_order', order.id)

  const productMap = new Map(graph.products.map(product => [product.id, product]))
  const itemIds = new Set<string>()
  const expectedReceipts = new Map<string, number>()
  let subtotal = 0
  for (const item of items) {
    add('items', 'DUPLICATE_ORDER_ITEM', !itemIds.has(item.id), 'purchase_order_item', item.id)
    itemIds.add(item.id)
    const product = productMap.get(item.productId)
    add('items', 'PRODUCT_MISSING', !!product && !product.isDeleted, 'product', item.productId, true, !!product && !product.isDeleted)
    if (product) add('relationships', 'PRODUCT_WORKSPACE_MISMATCH', product.workspaceId === workspaceId, 'product', product.id, workspaceId, product.workspaceId)
    add('items', 'ITEM_QUANTITY_INVALID', Number.isFinite(Number(item.quantity)) && amount(item.quantity) > 0 && getOrderLineInventoryQuantity(item) > 0, 'purchase_order_item', item.id)
    add('items', 'ITEM_PRICE_INVALID', Number.isFinite(Number(item.convertedUnitPrice)) && amount(item.convertedUnitPrice) >= 0, 'purchase_order_item', item.id)
    add('items', 'ITEM_CURRENCY_MISMATCH', item.settlementCurrency === order.currency, 'purchase_order_item', item.id, order.currency, item.settlementCurrency)
    if (item.originalCurrency !== order.currency) {
      add('items', 'EXCHANGE_RATE_SNAPSHOT_MISSING', !!order.exchangeRates?.length, 'purchase_order_item', item.id)
    }
    const lineTotal = roundOrderValue(amount(item.quantity) * amount(item.convertedUnitPrice))
    add('items', 'ITEM_TOTAL_MISMATCH', close(lineTotal, item.lineTotal), 'purchase_order_item', item.id, lineTotal, item.lineTotal)
    subtotal = roundOrderValue(subtotal + lineTotal)
  }

  const adjustments = normalizeOrderAdjustments(order.orderAdjustments, order.currency)
  if (Array.isArray(order.orderAdjustments)) {
    add('order', 'ORDER_ADJUSTMENT_INVALID', adjustments.length === order.orderAdjustments.length, 'purchase_order', order.id, order.orderAdjustments.length, adjustments.length)
  }
  for (const adjustment of adjustments) {
    add('order', 'ORDER_ADJUSTMENT_AMOUNT_MISMATCH', close(adjustment.amount * adjustment.exchangeRate, adjustment.convertedAmount), 'order_adjustment', adjustment.id, roundOrderValue(adjustment.amount * adjustment.exchangeRate), adjustment.convertedAmount)
    if (adjustment.currency !== order.currency) add('order', 'ORDER_ADJUSTMENT_RATE_SNAPSHOT_MISSING', adjustment.exchangeRates.length > 0, 'order_adjustment', adjustment.id)
  }
  add('order', 'ORDER_DISCOUNT_INVALID', Number.isFinite(amount(order.discount)) && amount(order.discount) >= 0, 'purchase_order', order.id)
  const calculatedTotal = roundOrderValue(subtotal - amount(order.discount) + getOrderAdjustmentNetAmount(adjustments))
  expected.subtotal = subtotal
  expected.total = calculatedTotal
  add('order', 'ORDER_SUBTOTAL_MISMATCH', close(subtotal, order.subtotal), 'purchase_order', order.id, subtotal, order.subtotal)
  add('order', 'ORDER_TOTAL_MISMATCH', close(calculatedTotal, order.total), 'purchase_order', order.id, calculatedTotal, order.total)

  const suppliers = active(graph.suppliers)
  const supplier = suppliers.find(row => row.id === order.supplierId)
  add('relationships', 'SUPPLIER_REFERENCE_MISSING', !!supplier, 'supplier', order.supplierId, true, !!supplier)
  if (supplier) {
    add('relationships', 'SUPPLIER_WORKSPACE_MISMATCH', supplier.workspaceId === workspaceId, 'supplier', supplier.id, workspaceId, supplier.workspaceId)
    if (supplier.businessPartnerId) add('relationships', 'SUPPLIER_PARTNER_REFERENCE_MISSING', graph.partners.some(row => row.id === supplier.businessPartnerId && !row.isDeleted), 'business_partner', supplier.businessPartnerId)
    if (supplier.businessPartnerId && order.businessPartnerId) {
      add('relationships', 'SUPPLIER_PARTNER_MISMATCH', supplier.businessPartnerId === order.businessPartnerId, 'supplier', supplier.id, supplier.businessPartnerId, order.businessPartnerId)
    }
  }
  for (const partner of graph.partners) {
    add('relationships', 'PARTNER_WORKSPACE_MISMATCH', partner.workspaceId === workspaceId, 'business_partner', partner.id, workspaceId, partner.workspaceId)
  }
  if (order.businessPartnerId) add('relationships', 'PARTNER_REFERENCE_MISSING', graph.partners.some(row => row.id === order.businessPartnerId && !row.isDeleted), 'business_partner', order.businessPartnerId)

  const receiptRequired = order.status === 'received' || order.status === 'completed' || !!order.actualDeliveryDate
  if (receiptRequired) {
    for (const item of items) {
      const storageId = item.storageId || order.destinationStorageId || ''
      add('inventory', 'RECEIPT_STORAGE_MISSING', !!storageId, 'purchase_order_item', item.id)
      const quantity = amount(item.receivedQuantity ?? getOrderLineInventoryQuantity(item))
      add('inventory', 'RECEIVED_QUANTITY_INVALID', Number.isFinite(quantity) && quantity > 0, 'purchase_order_item', item.id)
      if (storageId && Number.isFinite(quantity) && quantity > 0) {
        const key = `${item.productId}:${storageId}`
        expectedReceipts.set(key, roundQuantity((expectedReceipts.get(key) ?? 0) + quantity))
      }
    }
  }
  const receiptMovements = active(graph.inventoryMovements).filter(row => row.referenceId === order.id && row.referenceType === 'purchase_order')
  const actualReceipts = new Map<string, number>()
  for (const row of graph.inventoryMovements) {
    add('relationships', 'WRONG_INVENTORY_REFERENCE', row.referenceId === order.id && row.referenceType === 'purchase_order', 'inventory_transaction', row.id, `${order.id}:purchase_order`, `${row.referenceId}:${row.referenceType}`)
  }
  for (const row of receiptMovements) {
    const key = `${row.productId}:${row.storageId}`
    actualReceipts.set(key, roundQuantity((actualReceipts.get(key) ?? 0) + amount(row.quantityDelta)))
    add('inventory', 'RECEIPT_MOVEMENT_TYPE_INVALID', row.transactionType === 'purchase', 'inventory_transaction', row.id, 'purchase', row.transactionType)
    add('inventory', 'INVENTORY_MOVEMENT_ARITHMETIC_MISMATCH', quantityClose(amount(row.previousQuantity) + amount(row.quantityDelta), amount(row.newQuantity)), 'inventory_transaction', row.id)
    add('inventory', 'RECEIPT_MOVEMENT_QUANTITY_INVALID', Number.isFinite(amount(row.quantityDelta)) && amount(row.quantityDelta) > 0, 'inventory_transaction', row.id)
  }
  for (const [key, quantity] of expectedReceipts) {
    const rows = receiptMovements.filter(row => `${row.productId}:${row.storageId}` === key)
    const isLegacyMissingReceipt = source !== 'supabase' || Date.parse(order.actualDeliveryDate ?? order.createdAt ?? '') < Date.parse('2026-09-13T15:28:21Z')
    add('inventory', 'RECEIPT_MOVEMENT_MISSING', rows.length > 0, 'inventory_transaction', key, quantity, actualReceipts.get(key) ?? null, isLegacyMissingReceipt)
    if (rows.length) {
      add('inventory', 'RECEIPT_MOVEMENT_DUPLICATE', rows.length === 1, 'inventory_transaction', key, 1, rows.length)
      add('inventory', 'RECEIPT_MOVEMENT_QUANTITY_MISMATCH', quantityClose(quantity, actualReceipts.get(key) ?? 0), 'inventory_transaction', key, quantity, actualReceipts.get(key))
    }
  }
  for (const [key, quantity] of actualReceipts) {
    if (!expectedReceipts.has(key)) add('inventory', 'UNEXPECTED_RECEIPT_MOVEMENT', false, 'inventory_transaction', key, null, quantity)
  }

  const duplicateItemIds = new Set(items
    .map(item => item.id)
    .filter((id, index, all) => all.indexOf(id) !== index))
  const stockBatchItemIds = new Set(items.flatMap((item, index) => [
    item.id,
    ...(duplicateItemIds.has(item.id) ? [`${item.id}:${index}`] : [])
  ]))
  for (const batch of graph.stockBatches) {
    add('relationships', 'STOCK_BATCH_WORKSPACE_MISMATCH', batch.workspaceId === workspaceId, 'stock_batch', batch.id, workspaceId, batch.workspaceId)
    add('relationships', 'WRONG_PURCHASE_BATCH_REFERENCE', batch.sourcePurchaseOrderId === order.id && (!batch.sourcePurchaseOrderItemId || stockBatchItemIds.has(batch.sourcePurchaseOrderItemId)), 'stock_batch', batch.id, order.id, batch.sourcePurchaseOrderId)
  }

  const paymentRows = active(graph.payments)
  const paymentMap = new Map(paymentRows.map(row => [row.id, row]))
  for (const row of paymentRows) {
    add('payments', 'PAYMENT_CURRENCY_MISMATCH', row.currency === order.currency, 'payment_transaction', row.id, order.currency, row.currency)
    add('payments', 'PAYMENT_METHOD_MISSING', !!row.paymentMethod, 'payment_transaction', row.id)
    add('payments', 'PURCHASE_PAYMENT_DIRECTION_INVALID', row.sourceType !== 'purchase_order' || row.direction === 'outgoing', 'payment_transaction', row.id, 'outgoing', row.direction)
    const validSource = (row.sourceType === 'purchase_order' && row.sourceRecordId === order.id)
      || (['loan_payment', 'simple_loan', 'loan_installment'].includes(row.sourceType) && graph.loans.some(loan => loan.id === row.sourceRecordId))
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
  for (const movement of graph.accountMovements) {
    if (movement.paymentTransactionId) add('relationships', 'ORPHAN_ACCOUNT_MOVEMENT', paymentMap.has(movement.paymentTransactionId), 'payment_account_movement', movement.id)
  }
  for (const original of paymentRows.filter(row => !row.reversalOfTransactionId)) {
    const reversed = paymentRows.filter(row => row.reversalOfTransactionId === original.id).reduce((sum, row) => sum + Math.abs(amount(row.amount)), 0)
    add('payments', 'PAYMENT_REVERSALS_EXCEED_ORIGINAL', reversed <= amount(original.amount) + ORDER_AMOUNT_EPSILON, 'payment_transaction', original.id, original.amount, reversed)
  }

  const purchasePayments = paymentRows.filter(row => row.sourceType === 'purchase_order' && row.sourceRecordId === order.id && !row.reversalOfTransactionId)
  const directPaid = roundOrderValue(purchasePayments.reduce((sum, row) => sum + Math.max(0, paymentNet(row, paymentRows)), 0))
  const matchingLoans = active(graph.loans).filter(row => row.orderId === order.id && row.orderType === 'purchase')
  const financingConfigured = order.paymentMethod === 'loan' || order.paymentMethod === 'installments' || !!order.linkedLoanId
  const financingPendingDraft = order.status === 'draft' && financingConfigured && !order.linkedLoanId
  const financed = order.status !== 'cancelled' && order.status !== 'draft' && financingConfigured
  add('loan', 'LOAN_MISSING', !financed || matchingLoans.length === 1, 'loan', order.linkedLoanId ?? undefined, financed ? 1 : 0, matchingLoans.length)
  if (order.status !== 'cancelled' && order.status !== 'draft') {
    add('loan', 'LOAN_DUPLICATE', matchingLoans.length <= 1, 'loan', order.id, 'at most one', matchingLoans.length)
    if (!financed) add('loan', 'UNEXPECTED_LOAN', matchingLoans.length === 0, 'loan', order.id, 0, matchingLoans.length)
  }
  const loan = financed ? matchingLoans[0] : undefined
  if (order.linkedLoanId) {
    const linked = graph.loans.find(row => row.id === order.linkedLoanId)
    add('relationships', 'WRONG_LOAN_REFERENCE', !!linked && linked.orderId === order.id && linked.orderType === 'purchase', 'loan', order.linkedLoanId, order.id, linked?.orderId)
  }
  let loanRepaid = 0
  if (loan) {
    add('relationships', 'WRONG_LOAN_REFERENCE', loan.id === order.linkedLoanId && loan.source === 'order' && loan.orderId === order.id && loan.orderType === 'purchase', 'loan', loan.id, order.linkedLoanId, loan.id)
    add('loan', 'LOAN_CURRENCY_MISMATCH', loan.settlementCurrency === order.currency, 'loan', loan.id, order.currency, loan.settlementCurrency)
    const loanPartnerId = order.businessPartnerId ?? supplier?.businessPartnerId
    add('loan', 'LOAN_SUPPLIER_MISMATCH', !loanPartnerId || loan.linkedPartyId === loanPartnerId, 'loan', loan.id, loanPartnerId, loan.linkedPartyId)
    const repayments = active(graph.loanPayments).filter(row => row.loanId === loan.id)
    loanRepaid = roundOrderValue(repayments.reduce((sum, row) => sum + Math.max(0, amount(row.amount) - amount(row.reversedAmount)), 0))
    add('loan', 'LOAN_PAID_MISMATCH', close(loanRepaid, loan.totalPaidAmount), 'loan', loan.id, loanRepaid, loan.totalPaidAmount)
    const originatedPrincipal = order.paymentMethod === 'loan' ? calculatedTotal : roundOrderValue(calculatedTotal - amount(order.initialPaymentAmount))
    add('loan', 'LOAN_PRINCIPAL_MISMATCH', close(originatedPrincipal, loan.principalAmount), 'loan', loan.id, originatedPrincipal, loan.principalAmount)
    const expectedLoanBalance = roundOrderValue(Math.max(0, originatedPrincipal - loanRepaid))
    add('loan', 'LOAN_BALANCE_MISMATCH', close(expectedLoanBalance, loan.balanceAmount), 'loan', loan.id, expectedLoanBalance, loan.balanceAmount)
    add('loan', 'LOAN_STATUS_MISMATCH', loan.status === (expectedLoanBalance <= ORDER_AMOUNT_EPSILON ? 'completed' : loan.status === 'active' || loan.status === 'overdue' ? loan.status : 'active'), 'loan', loan.id)
    for (const repayment of graph.loanPayments) {
      add('relationships', 'ORPHAN_LOAN_PAYMENT', repayment.loanId === loan.id, 'loan_payment', repayment.id)
      if (!repayment.isDeleted && repayment.paymentTransactionId) {
        const transaction = paymentMap.get(repayment.paymentTransactionId)
        add('payments', 'LOAN_PAYMENT_TRANSACTION_MISSING', !!transaction, 'loan_payment', repayment.id, repayment.paymentTransactionId, transaction?.id)
        if (transaction) add('payments', 'LOAN_PAYMENT_AMOUNT_MISMATCH', close(Math.max(0, amount(repayment.amount) - amount(repayment.reversedAmount)), paymentNet(transaction, paymentRows)), 'loan_payment', repayment.id, amount(repayment.amount) - amount(repayment.reversedAmount), paymentNet(transaction, paymentRows))
      }
      if (!repayment.isDeleted && !repayment.paymentTransactionId) add('payments', 'LOAN_PAYMENT_TRANSACTION_MISSING', false, 'loan_payment', repayment.id, undefined, null, !repayment.integrityVersion)
    }
  }

  const paid = roundOrderValue(Math.min(calculatedTotal, directPaid + (financingPendingDraft ? 0 : loanRepaid)))
  expected.paidAmount = paid
  expected.balanceAmount = roundOrderValue(Math.max(0, calculatedTotal - paid))
  add('payments', 'PAYMENTS_EXCEED_ORDER_TOTAL', directPaid + (financingPendingDraft ? 0 : loanRepaid) <= calculatedTotal + ORDER_AMOUNT_EPSILON, 'purchase_order', order.id, calculatedTotal, roundOrderValue(directPaid + (financingPendingDraft ? 0 : loanRepaid)))
  if (!financingPendingDraft) {
    add('payments', 'ORDER_PAID_MISMATCH', close(paid, order.paidAmount), 'purchase_order', order.id, paid, order.paidAmount)
    if (order.paymentStatus !== 'unpaid' || order.isPaid || paid > ORDER_AMOUNT_EPSILON) {
      add('payments', 'ORDER_BALANCE_MISMATCH', close(expected.balanceAmount as number, order.balanceAmount), 'purchase_order', order.id, expected.balanceAmount, order.balanceAmount)
    }
    const expectedPaymentStatus = paid >= calculatedTotal - ORDER_AMOUNT_EPSILON ? 'paid' : paid > ORDER_AMOUNT_EPSILON ? 'partial' : 'unpaid'
    add('payments', 'ORDER_PAYMENT_STATUS_MISMATCH', order.paymentStatus === expectedPaymentStatus && order.isPaid === (expectedPaymentStatus === 'paid'), 'purchase_order', order.id, expectedPaymentStatus, order.paymentStatus)
  }

  for (const row of graph.orderInstallments) add('relationships', 'WRONG_INSTALLMENT_REFERENCE', row.orderId === order.id && row.orderType === 'purchase', 'order_installment', row.id)
  for (const row of graph.loanInstallments) add('relationships', 'ORPHAN_LOAN_INSTALLMENT', graph.loans.some(loanRow => loanRow.id === row.loanId), 'loan_installment', row.id)

  return { checks, expected }
}

function summarize(checks: IntegrityAuditCheck[]): IntegrityAuditResult['summary'] {
  return {
    total: checks.length,
    passed: checks.filter(row => row.status === 'PASS').length,
    warnings: checks.filter(row => row.status === 'WARNING').length,
    failed: checks.filter(row => row.status === 'FAIL').length
  }
}

const statusOf = (checks: IntegrityAuditCheck[]): AuditStatus => checks.some(row => row.status === 'FAIL')
  ? 'FAIL'
  : checks.some(row => row.status === 'WARNING') ? 'WARNING' : 'PASS'

export async function runPurchaseOrderIntegrityAudit(
  workspaceId: string,
  orderId: string,
  mode: 'cloud' | 'hybrid' | 'local' | 'demo'
): Promise<IntegrityAuditResult<PurchaseOrderTransactionGraph>> {
  const { resolvePurchaseOrderTransactionGraph } = await import('./purchaseOrderGraph')
  const sourceOfTruth = mode === 'local' || mode === 'demo' ? 'sqlite' : 'supabase'
  let actual: PurchaseOrderTransactionGraph
  try {
    actual = await resolvePurchaseOrderTransactionGraph(workspaceId, orderId, sourceOfTruth)
  } catch (error) {
    throw new IntegrityAuditReadError(sourceOfTruth, error)
  }
  const { checks, expected } = auditPurchaseOrderGraph(actual, workspaceId, orderId, sourceOfTruth)
  let mirrorStatus: AuditStatus | null = null
  let mirrorActual: PurchaseOrderTransactionGraph | null = null
  if (mode === 'hybrid') {
    try {
      const mirror = await resolvePurchaseOrderTransactionGraph(workspaceId, orderId, 'sqlite')
      mirrorActual = mirror
      const entityKeys: Array<keyof PurchaseOrderTransactionGraph> = [
        'order', 'products', 'suppliers', 'partners', 'inventoryMovements', 'stockBatches', 'payments',
        'accountMovements', 'paymentAccounts', 'loans', 'loanPayments', 'loanInstallments', 'orderInstallments'
      ]
      for (const key of entityKeys) {
        const sourceRows = key === 'order' ? (actual.order ? [actual.order] : []) : actual[key] as Array<{ id: string }>
        const mirrorRows = key === 'order' ? (mirror.order ? [mirror.order] : []) : mirror[key] as Array<{ id: string }>
        const mirrorById = new Map(mirrorRows.map(row => [row.id, row]))
        for (const row of sourceRows) {
          const localRow = mirrorById.get(row.id)
          if (!localRow) {
            checks.push(buildCheck('mirror', 'SQLITE_MIRROR_RECORD_MISSING', false, key, row.id, 'present', 'missing', true))
            continue
          }
          const fields: Record<string, string[]> = {
            order: ['workspaceId', 'status', 'subtotal', 'discount', 'total', 'paidAmount', 'balanceAmount', 'linkedLoanId', 'items', 'paymentStatus'],
            products: ['workspaceId', 'name', 'sku', 'currency', 'costPrice', 'isDeleted'],
            suppliers: ['workspaceId', 'businessPartnerId', 'partnerName', 'isDeleted'],
            partners: ['workspaceId', 'partnerName', 'role', 'isDeleted'],
            inventoryMovements: ['workspaceId', 'referenceId', 'referenceType', 'productId', 'storageId', 'quantityDelta', 'transactionType'],
            stockBatches: ['workspaceId', 'sourcePurchaseOrderId', 'sourcePurchaseOrderItemId', 'productId', 'storageId', 'quantity'],
            payments: ['workspaceId', 'sourceType', 'sourceRecordId', 'sourceSubrecordId', 'amount', 'currency', 'direction', 'accountId', 'reversalOfTransactionId', 'isDeleted'],
            loans: ['workspaceId', 'orderId', 'orderType', 'principalAmount', 'totalPaidAmount', 'balanceAmount', 'settlementCurrency', 'status'],
            loanPayments: ['workspaceId', 'loanId', 'amount', 'paymentTransactionId', 'isDeleted', 'reversedAmount'],
            accountMovements: ['workspaceId', 'paymentTransactionId', 'accountId', 'amount', 'deltaAmount', 'currency', 'isDeleted'],
            orderInstallments: ['workspaceId', 'orderId', 'orderType', 'plannedAmount', 'paidAmount', 'balanceAmount', 'status', 'isDeleted'],
            loanInstallments: ['workspaceId', 'loanId', 'plannedAmount', 'paidAmount', 'balanceAmount', 'status', 'isDeleted'],
            paymentAccounts: ['workspaceId', 'name', 'accountType', 'isDeleted']
          }
          for (const field of fields[key] ?? ['workspaceId', 'isDeleted']) {
            const expectedField = (row as any)[field] ?? null
            const actualField = (localRow as any)[field] ?? null
            checks.push(buildCheck('mirror', 'SQLITE_MIRROR_FIELD_MISMATCH', JSON.stringify(expectedField) === JSON.stringify(actualField), `${key}.${field}`, row.id, expectedField, actualField, true))
          }
        }
        for (const row of mirrorRows) {
          if (!sourceRows.some(sourceRow => sourceRow.id === row.id)) checks.push(buildCheck('mirror', 'SQLITE_MIRROR_ORPHAN', false, key, row.id, undefined, undefined, true))
        }
      }
      mirrorStatus = statusOf(checks.filter(row => row.category === 'mirror'))
    } catch (error) {
      checks.push(buildCheck('mirror', 'SQLITE_MIRROR_UNAVAILABLE', false, 'sqlite', undefined, undefined, error instanceof Error ? error.message : String(error), true))
      mirrorStatus = 'WARNING'
    }
  }
  const transactionChecks = checks.filter(row => row.category !== 'mirror')
  return {
    transactionType: 'purchase_order',
    transactionId: orderId,
    transactionNumber: actual.order?.orderNumber,
    workspaceId,
    auditedAt: new Date().toISOString(),
    sourceOfTruth,
    integrityStatus: statusOf(transactionChecks),
    mirrorStatus,
    checks,
    summary: summarize(checks),
    expected,
    actual,
    mirrorActual
  }
}
