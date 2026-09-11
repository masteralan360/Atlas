import { describe, expect, it } from 'vitest'

import {
    formatAtlasStandardPartnerBalanceSnapshot,
    formatAtlasStandardPartnerCurrentBalance
} from '@/lib/atlasStandardPartnerBalance'
import {
    chunkAtlasStandardTableRows,
    resolveAtlasStandardTableCapacities
} from '@/lib/atlasStandardOrderTablePagination'

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

describe('formatAtlasStandardPartnerBalanceSnapshot', () => {
    it('formats immutable before and after amounts independently for each currency', () => {
        const snapshot = {
            version: 1 as const,
            capturedAt: '2026-09-11T10:00:00.000Z',
            balances: [
                { currency: 'iqd' as const, before: -50_000, after: -45_000 },
                { currency: 'usd' as const, before: 12.34567, after: 10 }
            ]
        }

        expect(formatAtlasStandardPartnerBalanceSnapshot(snapshot, 'before', 'IQD')).toBe('-50,000 IQD • $12.3457')
        expect(formatAtlasStandardPartnerBalanceSnapshot(snapshot, 'after', 'IQD')).toBe('-45,000 IQD • $10')
    })

    it('does not infer a historical balance for legacy orders without a snapshot', () => {
        expect(formatAtlasStandardPartnerBalanceSnapshot(null, 'before', 'IQD')).toBe('-')
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
