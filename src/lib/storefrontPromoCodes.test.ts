import { describe, expect, it } from 'vitest'

import {
    evaluateStorefrontPromoCode,
    normalizeStorefrontPromoCode
} from '../../supabase/functions/_shared/storefrontPromoCodes'

describe('storefront promo code calculations', () => {
    it('normalizes codes for case-insensitive lookup', () => {
        expect(normalizeStorefrontPromoCode('  summer-10 ')).toBe('SUMMER-10')
        expect(normalizeStorefrontPromoCode(null)).toBe('')
    })

    it('calculates percentage discounts against the authoritative subtotal', () => {
        expect(evaluateStorefrontPromoCode({
            code: 'SAVE15',
            discount_type: 'percentage',
            discount_value: '15',
            is_active: true,
            expires_at: null
        }, 20_000)).toEqual({ status: 'valid', discount_amount: 3_000 })
    })

    it('caps a fixed discount at the subtotal so the final order cannot be negative', () => {
        expect(evaluateStorefrontPromoCode({
            code: 'FREEISH',
            discount_type: 'fixed',
            discount_value: 1_500,
            is_active: true,
            expires_at: null
        }, 1_000)).toEqual({ status: 'valid', discount_amount: 1_000 })
    })

    it('reports inactive and expired codes before calculating a discount', () => {
        const common = { code: 'LIMITED', discount_type: 'fixed', discount_value: 100, expires_at: null }
        expect(evaluateStorefrontPromoCode({ ...common, is_active: false }, 1_000).status).toBe('inactive')
        expect(evaluateStorefrontPromoCode({ ...common, is_active: true, expires_at: '2026-01-01T00:00:00Z' }, 1_000, Date.parse('2026-01-02T00:00:00Z')).status).toBe('expired')
    })

    it('rejects invalid discount configuration and carts without a positive subtotal', () => {
        const common = { code: 'BAD', is_active: true, expires_at: null }
        expect(evaluateStorefrontPromoCode({ ...common, discount_type: 'percentage', discount_value: 150 }, 1_000).status).toBe('ineligible')
        expect(evaluateStorefrontPromoCode({ ...common, discount_type: 'unknown', discount_value: 10 }, 1_000).status).toBe('ineligible')
        expect(evaluateStorefrontPromoCode({ ...common, discount_type: 'fixed', discount_value: 10 }, 0).status).toBe('ineligible')
    })
})
