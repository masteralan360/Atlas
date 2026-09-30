import { describe, expect, it } from 'vitest'

import { getQuickOrderLoanRepaymentSummary, getRemainingFinancedBalance } from './orderFinancing'

describe('order financing terms', () => {
    it('calculates the remaining balance at order precision', () => {
        expect(getRemainingFinancedBalance(100.1234, '12.3456')).toBe(87.777)
        expect(getRemainingFinancedBalance(100, '')).toBe(100)
        expect(getRemainingFinancedBalance(100, '-5')).toBe(100)
        expect(getRemainingFinancedBalance(100, 150)).toBe(0)
    })

    it('requires a positive loan repayment below the order total for Quick Order partial status', () => {
        expect(getQuickOrderLoanRepaymentSummary(100, '25')).toMatchObject({
            initialPaymentAmount: 25,
            remainingBalance: 75,
            isValid: true
        })
        expect(getQuickOrderLoanRepaymentSummary(100, '').isValid).toBe(false)
        expect(getQuickOrderLoanRepaymentSummary(100, '0').isValid).toBe(false)
        expect(getQuickOrderLoanRepaymentSummary(100, '100').isValid).toBe(false)
        expect(getQuickOrderLoanRepaymentSummary(100, '100.001').isValid).toBe(false)
    })
})
