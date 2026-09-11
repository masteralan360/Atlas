import type { PaymentTransaction, PaymentTransactionSourceType } from '@/local-db/models'
import { isReportablePaymentTransaction } from './financialReportability'

const PAYMENT_REVERSAL_EPSILON = 0.000001

export type PaymentReversalAmountPolicy = 'partial_or_full' | 'full_remaining'

export interface PaymentTransactionReversalState {
  originalAmount: number
  reversedAmount: number
  remainingAmount: number
  status: 'available' | 'partially_reversed' | 'fully_reversed'
  amountPolicy: PaymentReversalAmountPolicy
}

const PARTIAL_PAYMENT_REVERSAL_SOURCE_TYPES = new Set<PaymentTransactionSourceType>([
  'sales_order',
  'purchase_order',
  'installment_sale_down_payment',
  'installment_sale_installment',
  'direct_transaction',
])

export function getPaymentReversalAmountPolicy(
  sourceType: PaymentTransactionSourceType,
): PaymentReversalAmountPolicy {
  return PARTIAL_PAYMENT_REVERSAL_SOURCE_TYPES.has(sourceType) ? 'partial_or_full' : 'full_remaining'
}

/** Describes how much of one immutable payment is still reversible. */
export function getPaymentTransactionReversalState(
  transaction: PaymentTransaction,
  rows: readonly PaymentTransaction[],
): PaymentTransactionReversalState {
  const originalAmount = Math.abs(Number(transaction.amount || 0))
  const reversedAmount = rows.reduce((total, row) => {
    if (!isReportablePaymentTransaction(row) || row.reversalOfTransactionId !== transaction.id) return total
    return total + Math.abs(Number(row.amount || 0))
  }, 0)
  const remainingAmount = Math.max(0, originalAmount - reversedAmount)

  return {
    originalAmount,
    reversedAmount,
    remainingAmount,
    status: remainingAmount <= PAYMENT_REVERSAL_EPSILON
      ? 'fully_reversed'
      : reversedAmount > PAYMENT_REVERSAL_EPSILON
        ? 'partially_reversed'
        : 'available',
    amountPolicy: getPaymentReversalAmountPolicy(transaction.sourceType),
  }
}
