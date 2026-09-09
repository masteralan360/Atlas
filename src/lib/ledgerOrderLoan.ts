import type { Loan, PaymentTransaction, PaymentTransactionSourceType } from '@/local-db'

import { getLedgerPaymentTransactionEffect } from './ledgerPaymentTransactions'

const ORDER_LOAN_PAYMENT_SOURCE_TYPES = new Set<PaymentTransactionSourceType>([
    'loan_payment',
    'simple_loan',
    'loan_installment',
])

type OrderLoanTransaction = Pick<
    PaymentTransaction,
    'sourceType' | 'sourceRecordId' | 'direction' | 'amount' | 'metadata'
>

export type SalesOrderLoanCashType = 'order_loan_collection' | 'order_loan_refund'

export interface SalesOrderLoanCashClassification {
    type: SalesOrderLoanCashType
    direction: 'incoming' | 'outgoing'
    amount: number
    orderId: string
}

function metadataString(transaction: OrderLoanTransaction, key: string) {
    const value = transaction.metadata?.[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isOrderReturnCashRefund(transaction: OrderLoanTransaction) {
    return (
        transaction.sourceType === 'order_return' &&
        (transaction.metadata?.loanRepaymentRefund === true || transaction.metadata?.financingInitialPaymentRefund === true)
    )
}

/**
 * A financed sales order creates a receivable, not a cash movement. Once money
 * is actually collected (or returned), however, the Ledger must classify that
 * movement as sales cash while retaining its link to the financing record.
 */
export function classifySalesOrderLoanCash(
    transaction: OrderLoanTransaction,
    loan?: Pick<Loan, 'source' | 'orderId' | 'orderType'> | null,
): SalesOrderLoanCashClassification | null {
    const metadataOrderId = metadataString(transaction, 'orderId')

    // Legacy fallback refunds were recorded directly against the order return
    // instead of the loan payment. Their metadata is the reliable relationship.
    if (isOrderReturnCashRefund(transaction) && metadataOrderId) {
        return {
            type: 'order_loan_refund',
            direction: 'outgoing',
            amount: Math.abs(Number(transaction.amount || 0)),
            orderId: metadataOrderId,
        }
    }

    if (!ORDER_LOAN_PAYMENT_SOURCE_TYPES.has(transaction.sourceType)) return null

    const loanOrderId =
        loan?.source === 'order' && loan.orderType === 'sales' && loan.orderId?.trim() ? loan.orderId.trim() : null
    const metadataOrderType = metadataString(transaction, 'orderType')
    const orderId = loanOrderId || (metadataOrderType === 'sales' ? metadataOrderId : null)
    if (!orderId) return null

    const effect = getLedgerPaymentTransactionEffect(transaction)
    return {
        type: effect.direction === 'incoming' ? 'order_loan_collection' : 'order_loan_refund',
        direction: effect.direction,
        amount: effect.amount,
        orderId,
    }
}
