import { describe, expect, it } from 'vitest'

import {
    ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM,
    fitAtlasStandardOrderRows,
    getAtlasStandardAvailableTableAreaMm,
    isAtlasStandardSmartRowExpansionEnabled,
    getAtlasStandardFirstPageFillerRowCount
} from '@/lib/atlasStandardOrderTablePagination'

describe('Atlas Standard first-page filler rows', () => {
    it('does not render a partial row when the remaining space is smaller than one row', () => {
        expect(getAtlasStandardFirstPageFillerRowCount(
            ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM,
            18,
            8
        )).toBe(0)
    })

    it('renders only complete empty rows and leaves any fractional remainder blank', () => {
        expect(getAtlasStandardFirstPageFillerRowCount(
            ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM,
            16,
            8
        )).toBe(2)
        expect(getAtlasStandardFirstPageFillerRowCount(145, 17, 8)).toBe(1)
    })
})

describe('Atlas Standard smart row expansion', () => {
    it('is opt-in and requires both toggles to be explicitly disabled', () => {
        expect(isAtlasStandardSmartRowExpansionEnabled()).toBe(false)
        for (const [footer, anchor, enabled] of [
            ['true', 'true', false], ['false', 'true', false], ['true', 'false', false], ['false', 'false', true]
        ] as const) {
            expect(isAtlasStandardSmartRowExpansionEnabled({ showPrintFooter: footer, enableTextPositionAnchor: anchor })).toBe(enabled)
        }
    })

    it('pulls later products into real unused space before adding whole filler rows', () => {
        const fit = fitAtlasStandardOrderRows(Array(50).fill(8), 200, 8)
        expect(fit.firstPageRows).toBe(25)
        expect(fit.continuationRows).toEqual([25])
        expect(fit.fillerRows).toBe(0)
        expect(fitAtlasStandardOrderRows([8, 8], 200, 8).fillerRows).toBe(23)
    })

    it('uses actual unequal row heights and preserves ordering and every product', () => {
        const fit = fitAtlasStandardOrderRows([8, 12, 9, 17, 8], 30, 8, 25)
        expect(fit.firstPageRows).toBe(3)
        expect(fit.continuationRows).toEqual([2])
        expect(fit.fillerRows).toBe(0)
        expect(fit.firstPageRows + fit.continuationRows.reduce((sum, count) => sum + count, 0)).toBe(5)
    })

    it('rounds only complete rows, tolerating subpixel noise but not genuine overflow', () => {
        expect(fitAtlasStandardOrderRows([], 24 - 0.000001, 8).fillerRows).toBe(3)
        expect(fitAtlasStandardOrderRows([], 23.99, 8).fillerRows).toBe(2)
        expect(fitAtlasStandardOrderRows([8, 8, 8], 23.99, 8).firstPageRows).toBe(2)
        expect(fitAtlasStandardOrderRows([17, 17], 33.9, 17).firstPageRows).toBe(1)
    })

    it('moves the summary down by the exact leftover fraction without a partial row', () => {
        const fractionalFit = fitAtlasStandardOrderRows([8, 12], 185.7, 8)
        expect(fractionalFit.fillerRows).toBe(20)
        expect(fractionalFit.summaryOffsetMm).toBeCloseTo(5.7)
        expect(fitAtlasStandardOrderRows([8, 8], 23.99, 8).summaryOffsetMm).toBeCloseTo(7.99)
        expect(fitAtlasStandardOrderRows([], 24 - 0.000001, 8).summaryOffsetMm).toBe(0)
        const area = getAtlasStandardAvailableTableAreaMm({ tableTopMm: 45, tableChromeMm: 18, tailHeightMm: 42 })
        const fit = fitAtlasStandardOrderRows([8, 12], area, 8)
        expect(45 + 18 + 42 + 20 + fit.fillerRows * 8 + fit.summaryOffsetMm).toBeCloseTo(289)
    })

    it('reserves the existing 8mm page margin, table chrome, summary and visible contacts', () => {
        const geometry = { tableTopMm: 45, tableChromeMm: 18, tailHeightMm: 42 }
        expect(getAtlasStandardAvailableTableAreaMm(geometry)).toBe(184)
        expect(getAtlasStandardAvailableTableAreaMm({ ...geometry, tailHeightMm: 55 })).toBe(171)
        const fit = fitAtlasStandardOrderRows([8, 8], getAtlasStandardAvailableTableAreaMm(geometry), 8)
        const bottom = 45 + 18 + 42 + (fit.firstPageRows + fit.fillerRows) * 8
        expect(bottom).toBeLessThanOrEqual(289)
        expect(289 - bottom).toBeLessThan(8)
    })

    it('gives space back immediately when native content or saved text returns', () => {
        const geometry = { tableTopMm: 40, tableChromeMm: 18, tailHeightMm: 30 }
        const heights = Array(80).fill(8)
        const original = fitAtlasStandardOrderRows(heights, getAtlasStandardAvailableTableAreaMm(geometry), 8)
        const restored = fitAtlasStandardOrderRows(heights, getAtlasStandardAvailableTableAreaMm({ ...geometry, tailHeightMm: 54 }), 8)
        expect(original.firstPageRows - restored.firstPageRows).toBe(3)
        const textLimited = getAtlasStandardAvailableTableAreaMm({ ...geometry, textBounds: [{ topMm: 250, bottomMm: 265 }] })
        expect(textLimited).toBe(161)
        expect(fitAtlasStandardOrderRows(heights, textLimited, 8).firstPageRows).toBe(20)
    })

    it('ignores text entirely in the header or on later pages, but protects text crossing the table top', () => {
        const geometry = { tableTopMm: 40, tableChromeMm: 18, tailHeightMm: 30 }
        expect(getAtlasStandardAvailableTableAreaMm({ ...geometry, textBounds: [
            { topMm: 10, bottomMm: 20 }, { topMm: 310, bottomMm: 320 }
        ] })).toBe(201)
        expect(getAtlasStandardAvailableTableAreaMm({ ...geometry, textBounds: [{ topMm: 35, bottomMm: 45 }] })).toBe(0)
    })

    it('handles zero available space, invalid measurements and oversized rows without losing content', () => {
        expect(fitAtlasStandardOrderRows([8, 8], -1, 8)).toMatchObject({ firstPageRows: 0, fillerRows: 0, continuationRows: [2] })
        expect(fitAtlasStandardOrderRows([NaN, 0], NaN, 0)).toMatchObject({ firstPageRows: 0, fillerRows: 0, rowHeightsMm: [8, 8] })
        expect(fitAtlasStandardOrderRows([250, 8], 10, 8)).toMatchObject({ firstPageRows: 0, fillerRows: 1, continuationRows: [1, 1] })
    })
})
