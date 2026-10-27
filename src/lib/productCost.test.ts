import { describe, expect, it } from 'vitest'

import { hasValidProductCost } from './productCost'

describe('hasValidProductCost', () => {
    it('accepts zero as a legitimate cost', () => {
        expect(hasValidProductCost(0)).toBe(true)
    })

    it('treats a missing or invalid cost as lacking a stored cost', () => {
        expect(hasValidProductCost(null)).toBe(false)
        expect(hasValidProductCost(undefined)).toBe(false)
        expect(hasValidProductCost(-1)).toBe(false)
        expect(hasValidProductCost(Number.NaN)).toBe(false)
    })
})
