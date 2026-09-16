import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    render: vi.fn(), unmount: vi.fn(), toCanvas: vi.fn(), addPage: vi.fn(), addImage: vi.fn(),
    output: vi.fn(), prepare: vi.fn(), restore: vi.fn(), progress: vi.fn(),
    statementPages: vi.fn(), tables: vi.fn(), centers: vi.fn(),
}))
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: mocks.render, unmount: mocks.unmount }) }))
vi.mock('@/i18n/config', () => ({ default: {
    isInitialized: true, language: 'en', cloneInstance: () => ({ changeLanguage: async () => {} }),
} }))
vi.mock('react-i18next', () => ({ I18nextProvider: () => null }))
vi.mock('@/ui/components', () => ({ A4InvoiceTemplate: () => null, ModernA4InvoiceTemplate: () => null,
    ProfessionalA4InvoiceTemplate: () => null, RefundA4InvoiceTemplate: () => null, RefundPrimaryA4InvoiceTemplate: () => null }))
vi.mock('@/ui/components/SaleReceipt', () => ({ SaleReceiptBase: () => null }))
vi.mock('@/lib/orderItemsTablePagination', () => ({
    paginateOrderItemsStatementPages: mocks.statementPages, paginateOrderItemsTables: mocks.tables,
}))
vi.mock('@/lib/centeredTablePagination', () => ({ centerTablesOnPages: mocks.centers }))
vi.mock('@/services/pdfProgress', () => ({ reportPdfProgress: mocks.progress }))
vi.mock('@/services/pdfImageCapture', () => ({ waitForPdfImages: async () => {}, inlineCaptureableImages: async () => {} }))
vi.mock('@/services/pdfPageCapture', () => ({ preparePdfPageCapture: mocks.prepare }))
vi.mock('html-to-image', () => ({ toCanvas: mocks.toCanvas }))
vi.mock('jspdf', () => ({ jsPDF: class {
    addPage = mocks.addPage
    addImage = mocks.addImage
    output = mocks.output
} }))

import { generateTemplatePdf } from './pdfGenerator'

describe('final template PDF rendering', () => {
    let container: HTMLElement
    let canvases: HTMLCanvasElement[]
    const blob = new Blob(['pdf'], { type: 'application/pdf' })

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        canvases = []
        container = {
            style: {}, classList: { add: vi.fn() }, remove: vi.fn(),
            offsetWidth: 794, offsetHeight: 2300, scrollHeight: 2300,
            getBoundingClientRect: () => ({ top: 0, bottom: 2300, width: 794 }),
            querySelector: () => null, querySelectorAll: () => [],
        } as unknown as HTMLElement
        vi.stubGlobal('document', { createElement: () => container, body: { appendChild: vi.fn() }, fonts: { ready: Promise.resolve() } })
        vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { queueMicrotask(() => callback(0)); return 1 })
        mocks.output.mockReturnValue(blob)
        mocks.prepare.mockReturnValue(() => mocks.restore)
        mocks.toCanvas.mockImplementation(async () => {
            expect(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
            const canvas = { width: 3176, height: 4492, toDataURL: () => 'data:image/jpeg;base64,page' } as HTMLCanvasElement
            canvases.push(canvas)
            return canvas
        })
    })

    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

    it('renders the edited element into ordered A4 pages, releasing each canvas and disposing the render root', async () => {
        const edited = createElement('div', null, 'Edited statement')
        const pending = generateTemplatePdf({ element: edited })
        await vi.runAllTimersAsync()
        expect(await pending).toBe(blob)
        expect(mocks.render.mock.calls[0][0].props.children).toBe(edited)
        expect(mocks.toCanvas).toHaveBeenCalledTimes(3)
        expect(mocks.addPage).toHaveBeenCalledTimes(2)
        expect(mocks.restore).toHaveBeenCalledTimes(3)
        expect(mocks.unmount).toHaveBeenCalledOnce()
        expect(container.remove).toHaveBeenCalledOnce()
        expect(container.style.transform).toBeUndefined()
        const progress = mocks.progress.mock.calls.map(call => call[0])
        expect(progress).toEqual([...progress].sort((a, b) => a - b))
        expect(mocks.addImage.mock.calls[2][5]).toBeCloseTo(14.55, 1)
    })

    it('restores the page and cleans up after a capture failure', async () => {
        mocks.toCanvas.mockRejectedValueOnce(new Error('capture failed'))
        const result = generateTemplatePdf({ element: createElement('div') }).catch(error => error)
        await vi.runAllTimersAsync()
        expect((await result).message).toBe('capture failed')
        expect(mocks.restore).toHaveBeenCalledOnce()
        expect(mocks.unmount).toHaveBeenCalledOnce()
        expect(container.remove).toHaveBeenCalledOnce()
        expect(container.style.transform).toBeUndefined()
        expect(mocks.output).not.toHaveBeenCalled()
    })

    it('keeps receipt rendering continuous and releases its canvas after PDF encoding', async () => {
        const pending = generateTemplatePdf({ element: createElement('div'), format: 'receipt' })
        await vi.runAllTimersAsync()
        expect(await pending).toBe(blob)
        expect(mocks.toCanvas).toHaveBeenCalledOnce()
        expect(mocks.prepare).not.toHaveBeenCalled()
        expect(mocks.addPage).not.toHaveBeenCalled()
        expect(canvases[0].width).toBe(0)
        expect(canvases[0].height).toBe(0)
        expect(mocks.unmount).toHaveBeenCalledOnce()
    })
})
