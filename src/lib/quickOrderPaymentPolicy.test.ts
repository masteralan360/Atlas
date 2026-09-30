import { describe, expect, it } from 'vitest'

import {
    getQuickOrderPaymentStatusAfterMethodChange,
    getQuickOrderPaymentStatusAfterOrderStatusChange,
    getQuickOrderPaymentStatusPolicy
} from './quickOrderPaymentPolicy'

describe('Quick Order payment status policy', () => {
    it('leaves payment status empty and unrestricted when no method is selected', () => {
        expect(getQuickOrderPaymentStatusPolicy(null, 'completed')).toEqual({
            requiredStatus: null,
            selectorDisabled: true,
            paidDisabled: false,
            unpaidDisabled: false
        })
    })

    it('requires Paid for Cash on non-Draft orders and disables Unpaid', () => {
        for (const orderStatus of ['pending', 'completed'] as const) {
            expect(getQuickOrderPaymentStatusPolicy('cash', orderStatus)).toEqual({
                requiredStatus: 'paid',
                selectorDisabled: false,
                paidDisabled: false,
                unpaidDisabled: true
            })
        }
    })

    it('keeps both Cash payment statuses available for Draft orders', () => {
        expect(getQuickOrderPaymentStatusPolicy('cash', 'draft')).toEqual({
            requiredStatus: null,
            selectorDisabled: false,
            paidDisabled: false,
            unpaidDisabled: false
        })
    })

    it.each(['loan', 'installments'] as const)(
        'requires Unpaid and disables Paid for %s, including Draft orders',
        (paymentMethod) => {
            expect(getQuickOrderPaymentStatusPolicy(paymentMethod, 'draft')).toEqual({
                requiredStatus: 'unpaid',
                selectorDisabled: false,
                paidDisabled: true,
                unpaidDisabled: false
            })
        }
    )

    it('does not force a status for other payment methods', () => {
        expect(getQuickOrderPaymentStatusPolicy('bank_transfer', 'completed')).toEqual({
            requiredStatus: null,
            selectorDisabled: false,
            paidDisabled: false,
            unpaidDisabled: false
        })
    })

    it('immediately applies the required status when the method changes', () => {
        expect(getQuickOrderPaymentStatusAfterMethodChange(null, 'cash', 'completed')).toBe('paid')
        expect(getQuickOrderPaymentStatusAfterMethodChange('paid', 'loan', 'draft')).toBe('unpaid')
        expect(getQuickOrderPaymentStatusAfterMethodChange('paid', null, 'completed')).toBeNull()
        expect(getQuickOrderPaymentStatusAfterMethodChange(null, 'bank_transfer', 'completed')).toBeNull()
    })

    it('reapplies Cash restrictions when Draft changes to an active order status', () => {
        expect(getQuickOrderPaymentStatusAfterOrderStatusChange('unpaid', 'cash', 'completed')).toBe('paid')
        expect(getQuickOrderPaymentStatusAfterOrderStatusChange('unpaid', 'cash', 'pending')).toBe('paid')
    })

    it('keeps Draft payment choices open and leaves an empty method unselected', () => {
        expect(getQuickOrderPaymentStatusAfterOrderStatusChange('unpaid', 'cash', 'draft')).toBe('unpaid')
        expect(getQuickOrderPaymentStatusPolicy('cash', 'draft').unpaidDisabled).toBe(false)
        expect(getQuickOrderPaymentStatusAfterOrderStatusChange(null, null, 'completed')).toBeNull()
    })
})
