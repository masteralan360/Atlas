import { describe, expect, it } from 'vitest'

import type { PaymentTransaction, PaymentTransactionSourceType } from './models'
import {
  getPaymentReversalAmountPolicy,
  getPaymentTransactionReversalState,
} from '@/lib/paymentReversals'

function payment(overrides: Partial<PaymentTransaction> = {}): PaymentTransaction {
  const base: PaymentTransaction = {
    id: 'payment-1',
    workspaceId: 'workspace-1',
    sourceModule: 'payments',
    sourceType: 'direct_transaction',
    sourceRecordId: 'source-1',
    sourceSubrecordId: null,
    direction: 'outgoing',
    amount: 100,
    currency: 'usd',
    paymentMethod: 'cash',
    paidAt: '2026-09-01T10:00:00.000Z',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    syncStatus: 'synced',
    lastSyncedAt: '2026-09-01T10:00:00.000Z',
    version: 1,
    isDeleted: false,
  }

  return Object.assign(base, overrides)
}

describe('payment reversal state', () => {
  it('allows partial reversal only for sources with partial-safe balance models', () => {
    const partialSources: PaymentTransactionSourceType[] = [
      'direct_transaction',
      'sales_order',
      'purchase_order',
      'installment_sale_down_payment',
      'installment_sale_installment',
    ]
    const fullOnlySources: PaymentTransactionSourceType[] = [
      'loan_payment',
      'expense_item',
      'payroll_status',
      'clinical_appointment',
      'travel_booking_payment',
      'real_estate_commission',
      'activity_transaction',
    ]

    partialSources.forEach((sourceType) => {
      expect(getPaymentReversalAmountPolicy(sourceType)).toBe('partial_or_full')
    })
    fullOnlySources.forEach((sourceType) => {
      expect(getPaymentReversalAmountPolicy(sourceType)).toBe('full_remaining')
    })
  })

  it('accumulates repeated partial reversals and ignores deleted counter-entries', () => {
    const original = payment()
    const rows = [
      original,
      payment({ id: 'reversal-1', amount: -25, reversalOfTransactionId: original.id }),
      payment({ id: 'reversal-2', amount: -15.5, reversalOfTransactionId: original.id }),
      payment({ id: 'deleted-reversal', amount: -50, reversalOfTransactionId: original.id, isDeleted: true }),
    ]

    expect(getPaymentTransactionReversalState(original, rows)).toEqual({
      originalAmount: 100,
      reversedAmount: 40.5,
      remainingAmount: 59.5,
      status: 'partially_reversed',
      amountPolicy: 'partial_or_full',
    })
  })

  it('treats sub-cent floating residue inside the transaction epsilon as fully reversed', () => {
    const original = payment({ amount: 0.3 })
    const rows = [
      original,
      payment({ id: 'reversal-1', amount: -0.1, reversalOfTransactionId: original.id }),
      payment({ id: 'reversal-2', amount: -0.2, reversalOfTransactionId: original.id }),
    ]

    expect(getPaymentTransactionReversalState(original, rows)).toMatchObject({
      status: 'fully_reversed',
      remainingAmount: 0,
    })
  })
})
