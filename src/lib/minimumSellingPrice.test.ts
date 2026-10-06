import { describe, expect, it } from 'vitest'
import { isBelowMinimumSellingPrice, shouldShowMinimumSellingPriceField } from './minimumSellingPrice'

describe('minimum selling price policy', () => {
    it('shows the product field only to admins, whether or not staff are present', () => {
        expect(shouldShowMinimumSellingPriceField('admin')).toBe(true)
        expect(shouldShowMinimumSellingPriceField('staff')).toBe(false)
        expect(shouldShowMinimumSellingPriceField('viewer')).toBe(false)
        expect(shouldShowMinimumSellingPriceField(undefined)).toBe(false)
    })

    it('enforces the boundary only for staff and treats an empty minimum as unrestricted', () => {
        expect(isBelowMinimumSellingPrice('staff', 11.9999, 12)).toBe(true)
        expect(isBelowMinimumSellingPrice('staff', 12, 12)).toBe(false)
        expect(isBelowMinimumSellingPrice('staff', 12.0001, 12)).toBe(false)
        expect(isBelowMinimumSellingPrice('staff', 1, null)).toBe(false)
        expect(isBelowMinimumSellingPrice('staff', 1, undefined)).toBe(false)
        expect(isBelowMinimumSellingPrice('admin', 1, 12)).toBe(false)
        expect(isBelowMinimumSellingPrice('viewer', 1, 12)).toBe(false)
        expect(isBelowMinimumSellingPrice('staff', Number.NaN, 12)).toBe(false)
    })
})
