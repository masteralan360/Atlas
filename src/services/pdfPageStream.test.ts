import { describe, expect, it, vi } from 'vitest'
import { resolvePdfPageRenderScale, streamPdfPages } from './pdfPageStream'

const pages = [
    { offsetPx: 0, heightPx: 1123, heightMm: 297.1 },
    { offsetPx: 1122, heightPx: 1124, heightMm: 297.3 },
    { offsetPx: 2245, heightPx: 500, heightMm: 132.2 },
]
const sink = () => ({ addPage: vi.fn(), addImage: vi.fn() })
const canvas = () => ({ width: 3176, height: 4492,
    toDataURL: vi.fn(() => 'data:image/jpeg;base64,page') }) as unknown as HTMLCanvasElement

describe('streamPdfPages', () => {
    it('keeps short prints at 384 DPI and uses print-quality 288 DPI after the ten-page boundary', () => {
        expect(resolvePdfPageRenderScale(4, 10)).toBe(4)
        expect(resolvePdfPageRenderScale(4, 11)).toBe(3)
        expect(resolvePdfPageRenderScale(2, 100)).toBe(2)
        expect(resolvePdfPageRenderScale(4.9, 1)).toBe(4)
        expect(resolvePdfPageRenderScale(Number.NaN, 11)).toBe(1)
    })
    it('retains only one page raster while encoding ordered full and partial pages', async () => {
        const pdf = sink(), captured: HTMLCanvasElement[] = [], progress = vi.fn(), yieldToUi = vi.fn(async () => {})
        await streamPdfPages(pdf, pages, 210, async () => {
            expect(captured.every((page) => page.width === 0 && page.height === 0)).toBe(true)
            const page = canvas()
            captured.push(page)
            return page
        }, progress, yieldToUi)
        expect(pdf.addPage.mock.calls).toEqual([['a4', 'p'], ['a4', 'p']])
        expect(pdf.addImage.mock.calls.map((call) => call.slice(1))).toEqual(
            pages.map((page) => ['JPEG', 0, 0, 210, page.heightMm, undefined, 'FAST'])
        )
        expect(progress.mock.calls).toEqual([[1, 3], [2, 3], [3, 3]])
        expect(yieldToUi).toHaveBeenCalledTimes(3)
        expect(captured.every((page) => page.width === 0 && page.height === 0)).toBe(true)
        captured.forEach((page) => expect(page.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.92))
    })

    it.each(['encoding', 'adding image', 'adding page'])('releases the current canvas after failure %s', async (stage) => {
        const pdf = sink(), captured: HTMLCanvasElement[] = []
        if (stage === 'adding image') pdf.addImage.mockImplementation(() => { throw new Error('failed') })
        if (stage === 'adding page') pdf.addPage.mockImplementation(() => { throw new Error('failed') })
        await expect(streamPdfPages(pdf, pages, 210, async () => {
            const page = canvas()
            if (stage === 'encoding') vi.mocked(page.toDataURL).mockImplementation(() => { throw new Error('failed') })
            captured.push(page)
            return page
        }, vi.fn(), async () => {})).rejects.toThrow('failed')
        expect(captured.every((page) => page.width === 0 && page.height === 0)).toBe(true)
    })

    it('propagates capture failure after releasing earlier pages without reporting completion', async () => {
        const first = canvas(), capture = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('capture'))
        const progress = vi.fn()
        await expect(streamPdfPages(sink(), pages, 210, capture, progress, async () => {})).rejects.toThrow('capture')
        expect(first.width).toBe(0)
        expect(first.height).toBe(0)
        expect(progress.mock.calls).toEqual([[1, 3]])
    })

    it('does no capture or page allocation for an empty document', async () => {
        const pdf = sink(), capture = vi.fn(), progress = vi.fn(), yieldToUi = vi.fn()
        await streamPdfPages(pdf, [], 210, capture, progress, yieldToUi)
        expect(capture).not.toHaveBeenCalled()
        expect(pdf.addPage).not.toHaveBeenCalled()
        expect(progress).not.toHaveBeenCalled()
        expect(yieldToUi).not.toHaveBeenCalled()
    })
})
