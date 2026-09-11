import { describe, expect, it } from 'vitest'

import { getPaymentAccountMovementPresentation } from './paymentAccountMovementPresentation'

const outgoingMovement = { amount: 400, deltaAmount: -400 } as const
const outgoingTransaction = { id: 'original-outflow', amount: 400 } as const

describe('getPaymentAccountMovementPresentation', () => {
  it('keeps a fully reversed original movement immutable for account audit', () => {
    expect(getPaymentAccountMovementPresentation(
      outgoingMovement,
      outgoingTransaction,
      new Map([[outgoingTransaction.id, 400]]),
    )).toEqual({
      amount: 400,
      deltaAmount: -400,
      reversalStatus: 'reversed',
      reversedAmount: 400,
    })
  })

  it('keeps the original amount while reporting a partial reversal', () => {
    expect(getPaymentAccountMovementPresentation(
      outgoingMovement,
      outgoingTransaction,
      new Map([[outgoingTransaction.id, 125]]),
    )).toEqual({
      amount: 400,
      deltaAmount: -400,
      reversalStatus: 'partially_reversed',
      reversedAmount: 125,
    })
  })

  it('leaves an unreversed movement unchanged', () => {
    expect(getPaymentAccountMovementPresentation(
      outgoingMovement,
      outgoingTransaction,
      new Map(),
    )).toEqual({
      amount: 400,
      deltaAmount: -400,
      reversalStatus: 'posted',
      reversedAmount: 0,
    })
  })

  it('preserves the immutable incoming movement when only part is reversed', () => {
    expect(getPaymentAccountMovementPresentation(
      { amount: 400, deltaAmount: 400 },
      { id: 'original-inflow', amount: 400 },
      new Map([['original-inflow', 150]]),
    )).toEqual({
      amount: 400,
      deltaAmount: 400,
      reversalStatus: 'partially_reversed',
      reversedAmount: 150,
    })
  })
})
