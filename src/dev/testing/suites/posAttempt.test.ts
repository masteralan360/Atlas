import { describe, expect, it } from 'vitest'
import { PosCheckoutAttempt, PosCheckoutPendingError } from '@/lib/posCheckoutAttempt'
import { financePosInput, posCheckoutInput } from '../fixtures/pos'

describe('POS uncertain checkout response recovery', () => {
    it('retains sale and installment identities and frozen values across repeated attempts', () => {
        const store = new PosCheckoutAttempt()
        const input = financePosInput(posCheckoutInput(), 3)
        const first = store.getOrCreate('same cart', () => input)
        input.payload.total_amount = 200
        const retry = store.getOrCreate('same cart', () => { throw new Error('A retry must not generate new IDs') })
        expect(retry).toBe(first)
        expect(retry.payload.total_amount).toBe(100)
        expect(retry.payload.id).toBe(input.payload.id)
        expect(retry.atomicLoanPayload).toEqual(input.atomicLoanPayload)
    })
    it('blocks changing an unconfirmed checkout rather than generating a second sale identity', () => {
        const store = new PosCheckoutAttempt()
        const input = store.getOrCreate('cash cart', () => posCheckoutInput())
        expect(() => store.getOrCreate('changed payment', () => posCheckoutInput())).toThrow(PosCheckoutPendingError)
        expect(store.input?.payload.id).toBe(input.payload.id)
    })
    it('allows a new sale after confirmation or a definitive failure clears the attempt', () => {
        const store = new PosCheckoutAttempt()
        const first = store.getOrCreate('cart', () => posCheckoutInput())
        store.clear()
        expect(store.input).toBeUndefined()
        const next = store.getOrCreate('cart', () => posCheckoutInput())
        expect(next.payload.id).not.toBe(first.payload.id)
    })
})
