import { afterEach, describe, expect, it, vi } from 'vitest'

import { measureAtlasStandardOrderRowFit, settleAtlasStandardOrderLayouts } from './useAtlasStandardOrderLayout'

function geometry(scale = 4, contactMm = 0, textTopMm?: number, summaryOffsetMm = 0) {
    const originPx = 100
    const box = (top: number, height: number) => ({ getBoundingClientRect: () => ({ top: originPx + top * scale, bottom: originPx + (top + height) * scale, height: height * scale }) })
    const rows = [8, 12].map((height, index) => ({ ...box(60, height), dataset: { atlasStandardRowIndex: String(index) } }))
    const total = box(242, 8)
    const filler = box(80, 8)
    const table = { ...box(50, 200), tHead: box(50, 8), querySelector: (selector: string) => selector.includes('table-total') ? total : filler }
    const summary = { ...box(252, 35 + summaryOffsetMm), dataset: { atlasStandardSummaryOffsetMm: String(summaryOffsetMm) } }
    const contacts = contactMm ? box(287, contactMm) : null
    const textRoot = { querySelectorAll: () => textTopMm === undefined ? [] : [box(textTopMm, 15)] }
    return {
        getBoundingClientRect: () => ({ top: originPx, width: 210 * scale }),
        querySelector: (selector: string) => selector.includes('first-table') ? table : selector.includes('summary') ? summary : contacts,
        querySelectorAll: () => rows,
        closest: () => textRoot
    } as unknown as HTMLElement
}

afterEach(() => vi.unstubAllGlobals())

describe('shared mounted Atlas Standard layout measurement', () => {
    it('uses measured rows and native tail, independent of editor zoom or PDF capture scale', () => {
        const fit = measureAtlasStandardOrderRowFit(geometry(), 2, 8)
        expect(fit).toMatchObject({ firstPageRows: 2, fillerRows: 20, rowHeightsMm: [8, 12], continuationRows: [] })
        expect(measureAtlasStandardOrderRowFit(geometry(1), 2, 8)).toEqual(fit)
        expect(measureAtlasStandardOrderRowFit(geometry(2.5), 2, 8)).toEqual(fit)
    })

    it('immediately gives measured contact and saved text space back', () => {
        expect(measureAtlasStandardOrderRowFit(geometry(4, 13), 2, 8)?.fillerRows).toBe(19)
        expect(measureAtlasStandardOrderRowFit(geometry(4, 0, 250), 2, 8)?.fillerRows).toBe(15)
    })

    it('places the summary at the usable bottom and converges when remeasured', () => {
        const fit = measureAtlasStandardOrderRowFit(geometry(), 2, 8)!
        expect(fit.summaryOffsetMm).toBeCloseTo(5.7)
        expect(measureAtlasStandardOrderRowFit(geometry(4, 0, undefined, fit.summaryOffsetMm), 2, 8)).toEqual(fit)
        const sameRowCount = measureAtlasStandardOrderRowFit(geometry(4, 1, undefined, fit.summaryOffsetMm), 2, 8)!
        expect(sameRowCount.fillerRows).toBe(fit.fillerRows)
        expect(sameRowCount.summaryOffsetMm).toBeCloseTo(fit.summaryOffsetMm - 1)
        const restored = measureAtlasStandardOrderRowFit(geometry(4, 13, undefined, fit.summaryOffsetMm), 2, 8)!
        expect(restored.fillerRows).toBe(19)
        expect(restored.summaryOffsetMm).toBeCloseTo(0.7)
        const textLimited = measureAtlasStandardOrderRowFit(geometry(4, 0, 250, fit.summaryOffsetMm), 2, 8)!
        expect(textLimited.summaryOffsetMm).toBeCloseTo(5.7)
    })

    it('handles missing/hidden tables without changing pagination', () => {
        expect(measureAtlasStandardOrderRowFit({ querySelector: () => null } as unknown as HTMLElement, 2, 8)).toBeNull()
        const page = geometry()
        page.getBoundingClientRect = () => ({ width: 0 }) as DOMRect
        expect(measureAtlasStandardOrderRowFit(page, 2, 8)).toBeNull()
    })

    it('refreshes the mounted layout after assets settle and before PDF capture', async () => {
        const refresh = vi.fn()
        const page = { dispatchEvent: refresh }
        const container = { querySelector: () => page, querySelectorAll: () => [page] } as unknown as HTMLElement
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
        await settleAtlasStandardOrderLayouts(container)
        expect(refresh).toHaveBeenCalledTimes(4)
        expect(refresh.mock.calls[0][0].type).toBe('atlas-standard-refresh-layout')
    })

    it('does not refresh other templates or the normal toggle combinations', async () => {
        const query = vi.fn()
        await settleAtlasStandardOrderLayouts({ querySelector: () => null, querySelectorAll: query } as unknown as HTMLElement)
        expect(query).not.toHaveBeenCalled()
    })
})
