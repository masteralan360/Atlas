import { supabase } from '@/auth/supabase'
import { isOnline } from '@/lib/network'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { toCamelCase } from '@/lib/utils'

import { recalculateBusinessPartnerSummary } from './businessPartners'
import { db } from './database'
import { persistLoanAggregateRpcResult } from './loanTransactions'
import type { Loan, OrderType, PaymentTransaction, PurchaseOrder, SalesOrder } from './models'
import { addToOfflineMutations } from './offlineMutations'
import { mirrorPaymentAccountTransactionLocally } from './paymentAccounts'

type Order = SalesOrder | PurchaseOrder

export async function assertNoPendingFinancedOrderCancellation(workspaceId: string, orderId: string) {
  const pending = await db.offline_mutations
    .where('[entityType+entityId+status]')
    .equals(['order_cancellation_commands', orderId, 'pending'])
    .first()
  const syncing = await db.offline_mutations
    .where('[entityType+entityId+status]')
    .equals(['order_cancellation_commands', orderId, 'syncing'])
    .first()
  const failed = await db.offline_mutations
    .where('[entityType+entityId+status]')
    .equals(['order_cancellation_commands', orderId, 'failed'])
    .first()
  if ([pending, syncing, failed].some((mutation) => mutation?.workspaceId === workspaceId)) {
    throw new Error('order_cancellation_pending')
  }
}

function objectRow<T>(value: unknown): T | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? toCamelCase(value as Record<string, unknown>) as T
    : null
}

function hasExactReversals(transactions: PaymentTransaction[]) {
  return transactions.filter((transaction) => !transaction.isDeleted
    && !transaction.reversalOfTransactionId && transaction.amount > 0)
    .every((original) => {
      const reversals = transactions.filter((transaction) => !transaction.isDeleted
        && transaction.reversalOfTransactionId === original.id)
      const reversalTotal = reversals.reduce((sum, transaction) => sum + Number(transaction.amount), 0)
      return reversals.every((transaction) => Number(transaction.amount) < 0)
        && Math.abs(Number(original.amount) + reversalTotal) <= 0.0005
    })
}

/** A queued cancellation is only an intent. The order and loan stay active until the RPC succeeds. */
export async function cancelFinancedOrder(
  orderType: OrderType,
  order: Order,
): Promise<{ order: Order; queued: boolean }> {
  if (!isOnline(order.workspaceId)) {
    await addToOfflineMutations('order_cancellation_commands', order.id, 'create', {
      orderType,
      orderId: order.id,
    }, order.workspaceId)
    return { order, queued: true }
  }

  const unsyncedOrder = await db.offline_mutations
    .where('workspaceId').equals(order.workspaceId)
    .filter((mutation) => mutation.entityType === (orderType === 'sales' ? 'sales_orders' : 'purchase_orders')
      && mutation.entityId === order.id && mutation.status !== 'synced')
    .first()
  if (unsyncedOrder) throw new Error('order_cancellation_waiting_for_sync')

  const { data, error } = await runSupabaseAction('orders.cancelFinancing', () =>
    supabase.rpc('cancel_order_with_financing', {
      p_order_type: orderType,
      p_order_id: order.id,
    }),
  )
  if (error) throw error
  return {
    order: await persistFinancedOrderCancellation(data, orderType, order.id, order.workspaceId, order.linkedLoanId),
    queued: false,
  }
}

/** Validate the authoritative result before mutating any local projection. */
export async function persistFinancedOrderCancellation(
  value: unknown,
  orderType: OrderType,
  orderId: string,
  workspaceId: string,
  expectedLoanId?: string | null,
): Promise<Order> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('order_cancellation_invalid_result')
  }
  const raw = value as Record<string, unknown>
  const order = objectRow<Order>(raw.linked_order ?? raw.linkedOrder)
  const loan = objectRow<Loan>(raw.loan)
  if (!order || order.id !== orderId || order.workspaceId !== workspaceId
    || order.status !== 'cancelled' || order.linkedLoanId
    || Number(order.paidAmount ?? 0) !== 0) {
    throw new Error('order_cancellation_invalid_result')
  }
  if (expectedLoanId && loan?.id !== expectedLoanId) {
    throw new Error('order_cancellation_invalid_result')
  }
  if (loan && (loan.workspaceId !== workspaceId || loan.orderId !== orderId
    || loan.orderType !== orderType || !loan.isDeleted)) {
    throw new Error('order_cancellation_invalid_result')
  }
  if (loan && (!Array.isArray(raw.installments) || !Array.isArray(raw.payments)
    || !Array.isArray(raw.transactions)
    || raw.installments.some((item) => !objectRow<{ isDeleted: boolean }>(item)?.isDeleted)
    || raw.payments.some((item) => !objectRow<{ isDeleted: boolean }>(item)?.isDeleted)
    || (raw.payments.length > 0 && raw.transactions.length === 0))) {
    throw new Error('order_cancellation_invalid_result')
  }
  if (!Array.isArray(raw.order_transactions)) {
    throw new Error('order_cancellation_invalid_result')
  }
  const orderTransactions = raw.order_transactions.map((item) => objectRow<PaymentTransaction>(item))
  const loanTransactions = Array.isArray(raw.transactions)
    ? raw.transactions.map((item) => objectRow<PaymentTransaction>(item))
    : []
  if (orderTransactions.some((item) => !item?.id || item.workspaceId !== workspaceId
    || item.sourceRecordId !== orderId)
    || loanTransactions.some((item) => !item?.id || item.workspaceId !== workspaceId
      || item.sourceRecordId !== loan?.id)
    || !hasExactReversals(orderTransactions as PaymentTransaction[])
    || !hasExactReversals(loanTransactions as PaymentTransaction[])) {
    throw new Error('order_cancellation_invalid_result')
  }

  if (loan) {
    await persistLoanAggregateRpcResult(value)
  } else {
    const syncedAt = new Date().toISOString()
    const table = orderType === 'sales' ? db.sales_orders : db.purchase_orders
    await table.put({ ...order, syncStatus: 'synced', lastSyncedAt: syncedAt } as never)
  }
  const transactions = orderTransactions as PaymentTransaction[]
  if (transactions.length > 0) {
    await db.payment_transactions.bulkPut(transactions.map((transaction) => ({
      ...transaction, syncStatus: 'synced' as const, lastSyncedAt: new Date().toISOString(),
    })))
    for (const transaction of transactions) {
      await mirrorPaymentAccountTransactionLocally(transaction)
    }
  }
  const partnerId = order.businessPartnerId
    ?? (loan?.linkedPartyType === 'business_partner' ? loan.linkedPartyId : null)
  if (partnerId) await recalculateBusinessPartnerSummary(workspaceId, partnerId)
  if (orderType === 'sales' && (order as SalesOrder).customerId) {
    const { recalculateCustomerSummary } = await import('./orders')
    await recalculateCustomerSummary(workspaceId, (order as SalesOrder).customerId)
  }
  if (orderType === 'purchase' && (order as PurchaseOrder).supplierId) {
    const { recalculateSupplierSummary } = await import('./orders')
    await recalculateSupplierSummary(workspaceId, (order as PurchaseOrder).supplierId)
  }
  return order
}
