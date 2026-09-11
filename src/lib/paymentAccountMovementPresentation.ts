import type { PaymentAccountMovement, PaymentTransaction } from '@/local-db/models'

export const PAYMENT_ACCOUNT_REVERSAL_EPSILON = 0.000001

export type PaymentAccountMovementReversalStatus = 'posted' | 'partially_reversed' | 'reversed'

export interface PaymentAccountMovementPresentation {
  /** The immutable amount posted by this account movement. */
  amount: number
  /** The immutable signed balance effect posted by this account movement. */
  deltaAmount: number
  reversalStatus: PaymentAccountMovementReversalStatus
  reversedAmount: number
}

/**
 * Payment-account views retain every immutable movement on its actual account
 * and date. Same-account reversals naturally net when both rows are in scope;
 * a reversal posted to another account must never rewrite the original
 * account's history.
 */
export function getPaymentAccountMovementPresentation(
  movement: Pick<PaymentAccountMovement, 'amount' | 'deltaAmount'>,
  transaction: Pick<PaymentTransaction, 'id' | 'amount'> | null,
  reversalAmounts: ReadonlyMap<string, number>,
): PaymentAccountMovementPresentation {
  const sourceAmount = Number(movement.amount || 0)
  const sourceDelta = Number(movement.deltaAmount || 0)

  if (!transaction) {
    return {
      amount: sourceAmount,
      deltaAmount: sourceDelta,
      reversalStatus: 'posted',
      reversedAmount: 0,
    }
  }

  const reversedAmount = Math.max(0, Number(reversalAmounts.get(transaction.id) || 0))
  if (reversedAmount <= PAYMENT_ACCOUNT_REVERSAL_EPSILON) {
    return {
      amount: sourceAmount,
      deltaAmount: sourceDelta,
      reversalStatus: 'posted',
      reversedAmount: 0,
    }
  }

  const originalMagnitude = Math.abs(Number(transaction.amount || sourceAmount))
  const isFullyReversed = originalMagnitude - reversedAmount <= PAYMENT_ACCOUNT_REVERSAL_EPSILON

  return {
    amount: sourceAmount,
    deltaAmount: sourceDelta,
    reversalStatus: isFullyReversed ? 'reversed' : 'partially_reversed',
    reversedAmount,
  }
}
