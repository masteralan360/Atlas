import { describe, expect, it } from 'vitest'
import { isActiveOrder, isOrderArchiveEligible } from './orderArchiving'

describe('order archive eligibility', () => {
    it('allows cancelled sales and purchase orders', () => {
        expect(isOrderArchiveEligible({ status: 'cancelled' }, 'sales')).toBe(true)
        expect(isOrderArchiveEligible({ status: 'cancelled' }, 'purchase')).toBe(true)
    })

    it('allows returned orders, including fully returned sales orders', () => {
        expect(isOrderArchiveEligible({ status: 'returned' }, 'sales')).toBe(true)
        expect(isOrderArchiveEligible({ status: 'returned' }, 'purchase')).toBe(true)
        expect(isOrderArchiveEligible({ status: 'completed', returnStatus: 'full' }, 'sales')).toBe(true)
        expect(isOrderArchiveEligible({ status: 'completed', returnStatus: 'partial' }, 'sales')).toBe(false)
    })

    it('does not allow active orders to be archived', () => {
        expect(isOrderArchiveEligible({ status: 'draft' }, 'sales')).toBe(false)
        expect(isOrderArchiveEligible({ status: 'completed' }, 'purchase')).toBe(false)
        expect(isOrderArchiveEligible({ status: 'pending' }, 'sales')).toBe(false)
    })
})

describe('active order list filtering', () => {
    it('treats legacy rows without the flag as active and excludes archived rows', () => {
        expect(isActiveOrder({})).toBe(true)
        expect(isActiveOrder({ isArchived: false })).toBe(true)
        expect(isActiveOrder({ isArchived: true })).toBe(false)
    })
})
