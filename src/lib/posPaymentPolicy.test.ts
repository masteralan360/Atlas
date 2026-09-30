import { describe, expect, it } from 'vitest'

import { isPosPaymentTypeAllowed, shouldShowPosLoanPaymentOption } from './posPaymentPolicy'

describe('POS payment policy', () => {
    it('hides the Loan option while Order is selected and shows it for other regular POS methods', () => {
        expect(shouldShowPosLoanPaymentOption('order', false)).toBe(false)
        expect(shouldShowPosLoanPaymentOption('cash', false)).toBe(true)
        expect(shouldShowPosLoanPaymentOption('digital', false)).toBe(true)
        expect(shouldShowPosLoanPaymentOption('loan', false)).toBe(true)
    })

    it('keeps the Loan option hidden for Activities checkout', () => {
        expect(shouldShowPosLoanPaymentOption('cash', true)).toBe(false)
    })

    it('allows service sales to use the existing loan checkout flow', () => {
        expect(isPosPaymentTypeAllowed('loan', {
            isActivitiesStorage: false,
            isServicesStorage: true,
            quickOrderEnabled: true
        })).toBe(true)
    })

    it('allows service sales to use the existing Sales Order quick-order flow', () => {
        expect(isPosPaymentTypeAllowed('order', {
            isActivitiesStorage: false,
            isServicesStorage: true,
            quickOrderEnabled: true
        })).toBe(true)
    })

    it('continues to exclude financing and quick orders from activities', () => {
        expect(isPosPaymentTypeAllowed('loan', {
            isActivitiesStorage: true,
            isServicesStorage: false,
            quickOrderEnabled: true
        })).toBe(false)
        expect(isPosPaymentTypeAllowed('order', {
            isActivitiesStorage: true,
            isServicesStorage: false,
            quickOrderEnabled: true
        })).toBe(false)
    })

    it('requires Quick Order access before allowing an ordinary POS sale to become an order', () => {
        expect(isPosPaymentTypeAllowed('order', {
            isActivitiesStorage: false,
            isServicesStorage: false,
            quickOrderEnabled: false
        })).toBe(false)
    })
})
