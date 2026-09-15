import { describe, expect, it } from 'vitest'

import {
    formatAtlasStandardPartnerBalanceAtPosting,
    formatAtlasStandardPartnerCurrentBalance
} from '@/lib/atlasStandardPartnerBalance'
import {
    chunkAtlasStandardTableRows,
    resolveAtlasStandardTableCapacities
} from '@/lib/atlasStandardOrderTablePagination'
import {
    createAtlasStandardPartnerBalancePrintState,
    getAtlasStandardPartnerBalanceLoadingPercentage,
    resetAtlasStandardPartnerBalancePrintState
} from '@/lib/atlasStandardPartnerBalancePrintState'

describe('Atlas Standard partner-balance print state', () => {
    it('starts a live-balance preview in loading state and clears stale values for a new preview', () => {
        const state = createAtlasStandardPartnerBalancePrintState(true)

        expect(state).toEqual({ status: 'loading' })

        state.status = 'ready'
        state.balances = [{ currency: 'iqd', closingBalance: 1_056_000 }]
        state.orderBalanceAtPosting = {
            balances: [{ currency: 'iqd', before: 1_056_000, after: 1_051_150 }]
        }
        resetAtlasStandardPartnerBalancePrintState(state, true)

        expect(state).toEqual({
            status: 'loading',
            balances: undefined,
            orderBalanceAtPosting: undefined,
            progress: undefined
        })
    })

    it('does not hold a print that has no linked partner balance to refresh', () => {
        expect(createAtlasStandardPartnerBalancePrintState(false)).toEqual({ status: 'ready' })
    })
})

describe('Atlas Standard partner-balance loading progress', () => {
    it('converts initial, partial, and complete source counts into a bounded percentage', () => {
        expect(getAtlasStandardPartnerBalanceLoadingPercentage({ completedSources: 0, totalSources: 18 })).toBe(0)
        expect(getAtlasStandardPartnerBalanceLoadingPercentage({ completedSources: 1, totalSources: 18 })).toBe(6)
        expect(getAtlasStandardPartnerBalanceLoadingPercentage({ completedSources: 9, totalSources: 18 })).toBe(50)
        expect(getAtlasStandardPartnerBalanceLoadingPercentage({ completedSources: 18, totalSources: 18 })).toBe(100)
        expect(getAtlasStandardPartnerBalanceLoadingPercentage({ completedSources: 19, totalSources: 18 })).toBe(100)
    })

    it('uses zero when progress is unavailable or invalid', () => {
        expect(getAtlasStandardPartnerBalanceLoadingPercentage()).toBe(0)
        expect(getAtlasStandardPartnerBalanceLoadingPercentage({ completedSources: -1, totalSources: 18 })).toBe(0)
        expect(getAtlasStandardPartnerBalanceLoadingPercentage({ completedSources: 1, totalSources: 0 })).toBe(0)
    })
})

describe('formatAtlasStandardPartnerCurrentBalance', () => {
    it('keeps each account-statement currency separate with circle separators and preserves signed balances', () => {
        expect(formatAtlasStandardPartnerCurrentBalance([
            { currency: 'iqd', closingBalance: -50_000 },
            { currency: 'usd', closingBalance: 12.34567 }
        ], 'IQD')).toBe('-50,000 IQD • $12.3457')
    })

    it('uses a placeholder when the statement has no currency ledger to show', () => {
        expect(formatAtlasStandardPartnerCurrentBalance([], 'IQD')).toBe('-')
    })
})

describe('formatAtlasStandardPartnerBalanceAtPosting', () => {
    it('formats reconstructed before and after amounts independently for each currency', () => {
        const balanceAtPosting = {
            balances: [
                { currency: 'iqd' as const, before: -50_000, after: -45_000 },
                { currency: 'usd' as const, before: 12.34567, after: 10 }
            ]
        }

        expect(formatAtlasStandardPartnerBalanceAtPosting(balanceAtPosting, 'before', 'IQD')).toBe('-50,000 IQD • $12.3457')
        expect(formatAtlasStandardPartnerBalanceAtPosting(balanceAtPosting, 'after', 'IQD')).toBe('-45,000 IQD • $10')
    })

    it('uses a placeholder when the statement cannot reconstruct an order balance', () => {
        expect(formatAtlasStandardPartnerBalanceAtPosting(null, 'before', 'IQD')).toBe('-')
    })

    it('does not substitute a numeric value for an unrequested balance position', () => {
        expect(formatAtlasStandardPartnerBalanceAtPosting({
            balances: [{ currency: 'iqd', before: 12_500 }]
        }, 'after', 'IQD')).toBe('-')
    })
})

describe('Atlas Standard order-table pagination', () => {
    it('keeps the financial first page at 18 rows and expands default-image continuation pages to 30 rows', () => {
        const capacities = resolveAtlasStandardTableCapacities()

        expect(capacities).toMatchObject({
            productImageColumnWidth: 6,
            productImageSizeMm: 7,
            tableItemRowMm: 8,
            firstPageRows: 18,
            continuationRows: 30
        })
        expect(chunkAtlasStandardTableRows(
            Array.from({ length: 76 }, (_, index) => index + 1),
            capacities.firstPageRows,
            capacities.continuationRows
        )).toEqual([
            Array.from({ length: 18 }, (_, index) => index + 1),
            Array.from({ length: 30 }, (_, index) => index + 19),
            Array.from({ length: 28 }, (_, index) => index + 49)
        ])
    })

    it('uses the rounded product-image size when calculating enlarged-image capacities', () => {
        const capacities = resolveAtlasStandardTableCapacities('12')

        expect(capacities).toMatchObject({
            productImageColumnWidth: 12,
            productImageSizeMm: 13.6,
            tableItemRowMm: 14.6,
            firstPageRows: 9,
            continuationRows: 16
        })
    })

    it('reduces both capacities at the maximum product-image width', () => {
        const capacities = resolveAtlasStandardTableCapacities('16')

        expect(capacities).toMatchObject({
            productImageColumnWidth: 16,
            productImageSizeMm: 16,
            tableItemRowMm: 17,
            firstPageRows: 8,
            continuationRows: 14
        })
    })
})
