import { describe, expect, it } from 'vitest'

import { getQuickOrderInstallmentSummary } from './quickOrderInstallments'

describe('Quick Order installment summary', () => {
    it('rounds the initial payment and financed balance to order precision', () => {
        expect(getQuickOrderInstallmentSummary(100.1234, '3', '12.3456')).toEqual({
            installmentCount: 3,
            initialPaymentAmount: 12.346,
            financedBalance: 87.777,
            isInstallmentCountValid: true,
            isInitialPaymentAmountValid: true,
            isValid: true
        })
    })

    it('accepts zero as an initial payment while retaining the full financed balance', () => {
        expect(getQuickOrderInstallmentSummary(100, '1', '0')).toMatchObject({
            initialPaymentAmount: 0,
            financedBalance: 100,
            isValid: true
        })
    })

    it('keeps an empty initial payment invalid instead of treating it as zero', () => {
        expect(getQuickOrderInstallmentSummary(100, '3', '')).toMatchObject({
            initialPaymentAmount: null,
            financedBalance: 100,
            isInitialPaymentAmountValid: false,
            isValid: false
        })
    })

    it.each(['100', '100.001', '-1'])('rejects invalid initial payment amount %s', (amount) => {
        expect(getQuickOrderInstallmentSummary(100, '3', amount).isInitialPaymentAmountValid).toBe(false)
    })

    it.each(['', '0', '121', '1.5', 'abc'])('rejects invalid installment count %s', (count) => {
        expect(getQuickOrderInstallmentSummary(100, count, '0').isInstallmentCountValid).toBe(false)
    })

    it('accepts the installment count boundaries', () => {
        expect(getQuickOrderInstallmentSummary(100, '1', '0').isInstallmentCountValid).toBe(true)
        expect(getQuickOrderInstallmentSummary(100, '120', '0').isInstallmentCountValid).toBe(true)
    })
})
