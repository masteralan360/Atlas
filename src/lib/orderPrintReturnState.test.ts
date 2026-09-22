import { describe, expect, it } from 'vitest'

import { getOrderPrintOriginalTotal, getOrderPrintReturnState } from './orderPrintReturnState'

describe('order print return state', () => {
    it('converts returned base inventory back to the original commercial unit', () => {
        expect(getOrderPrintReturnState({
            quantity: 2,
            freeBonusQuantity: 1,
            unitFactor: 20,
            returnedQuantity: 20,
            lineTotal: 80000
        })).toMatchObject({
            status: 'partially-returned',
            originalQuantity: 2,
            remainingQuantity: 1,
            remainingLineTotal: 40000
        })
    })

    it('does not treat returned free units as returned paid quantity', () => {
        expect(getOrderPrintReturnState({
            quantity: 2,
            freeBonusQuantity: 1,
            unitFactor: 20,
            returnedQuantity: 40,
            returnedPaidInventoryQuantity: 20,
            returnedFreeInventoryQuantity: 20,
            lineTotal: 80000
        })).toMatchObject({
            status: 'partially-returned',
            originalQuantity: 2,
            remainingQuantity: 1,
            remainingLineTotal: 40000
        })
    })
    it('keeps active order lines unchanged', () => {
        expect(getOrderPrintReturnState({ quantity: 3, lineTotal: 75 })).toEqual({
            status: 'active',
            originalQuantity: 3,
            remainingQuantity: 3,
            originalLineTotal: 75,
            remainingLineTotal: 75
        })
    })

    it('shows the original and remaining values for a partial return', () => {
        expect(getOrderPrintReturnState({ quantity: 3, returnedQuantity: 1, lineTotal: 75 })).toEqual({
            status: 'partially-returned',
            originalQuantity: 3,
            remainingQuantity: 2,
            originalLineTotal: 75,
            remainingLineTotal: 50
        })
    })

    it('marks a fully returned line and reduces its displayed values to zero', () => {
        expect(getOrderPrintReturnState({ quantity: 3, returnedQuantity: 3, lineTotal: 75 })).toEqual({
            status: 'fully-returned',
            originalQuantity: 3,
            remainingQuantity: 0,
            originalLineTotal: 75,
            remainingLineTotal: 0
        })
    })

    it('uses the posted refund amount when one is available', () => {
        expect(getOrderPrintReturnState(
            { quantity: 3, lineTotal: 80_000 },
            { returnedQuantity: 1, returnedAmount: 20_000 }
        )).toMatchObject({
            status: 'partially-returned',
            remainingQuantity: 2,
            remainingLineTotal: 60_000
        })
    })

    it('only marks a bonus-bearing line fully returned after all inventory is returned', () => {
    expect(getOrderPrintReturnState({ quantity: 3, freeBonusQuantity: 1, returnedQuantity: 3, lineTotal: 75 }).status)
            .toBe('partially-returned')
    })

    it('restores the saved original total for original-order prints', () => {
        expect(getOrderPrintOriginalTotal({
            total: 50,
            returnedAmount: 25,
            originalTotalAmount: 75
        })).toBe(75)
        expect(getOrderPrintOriginalTotal({
            total: 50,
            returnedAmount: 25,
            originalTotalAmount: null
        })).toBe(75)
    })
})
