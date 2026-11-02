import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { findBottomContentRow } from './pdfRasterizerUtils'

interface PdfPageImageOptions {
    maxWidthPx: number
    pageNumber?: number
    trimBottomWhitespace?: boolean
    bottomPaddingPx?: number
}

export interface NativePdfPageImage {
    pngDataUrl: string
    widthMm: number
    heightMm: number
}

interface NativePdfRenderOptions {
    maxWidthPx?: number
    pageNumber?: number
}

let isPdfWorkerConfigured = false

function ensurePdfWorkerConfigured(pdfjsLib: typeof import('pdfjs-dist')) {
    if (isPdfWorkerConfigured) return

    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    isPdfWorkerConfigured = true
}

function resolvePdfRenderScale(pageWidthPx: number, maxWidthPx: number) {
    if (
        !Number.isFinite(pageWidthPx)
        || pageWidthPx <= 0
        || !Number.isFinite(maxWidthPx)
        || maxWidthPx <= 0
    ) {
        return 1
    }

    return maxWidthPx / pageWidthPx
}

function trimCanvasBottomWhitespace(canvas: HTMLCanvasElement, bottomPaddingPx: number) {
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return canvas

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
    const bottomContentRow = findBottomContentRow(imageData.data, canvas.width, canvas.height)
    if (bottomContentRow < 0) return canvas

    const croppedHeight = Math.min(canvas.height, bottomContentRow + 1 + Math.max(0, bottomPaddingPx))
    if (croppedHeight >= canvas.height) return canvas

    const croppedCanvas = document.createElement('canvas')
    const croppedContext = croppedCanvas.getContext('2d', { alpha: false })
    if (!croppedContext) return canvas

    croppedCanvas.width = canvas.width
    croppedCanvas.height = croppedHeight
    croppedContext.fillStyle = '#ffffff'
    croppedContext.fillRect(0, 0, croppedCanvas.width, croppedCanvas.height)
    croppedContext.drawImage(canvas, 0, 0)

    return croppedCanvas
}

export async function renderPdfPageToPngDataUrl(
    pdfBlob: Blob,
    {
        maxWidthPx,
        pageNumber = 1,
        trimBottomWhitespace = true,
        bottomPaddingPx = 24
    }: PdfPageImageOptions
): Promise<string> {
    const pdfjsLib = await import('pdfjs-dist')
    ensurePdfWorkerConfigured(pdfjsLib)

    const pdfData = new Uint8Array(await pdfBlob.arrayBuffer())
    const loadingTask = pdfjsLib.getDocument({ data: pdfData })

    try {
        const pdf = await loadingTask.promise
        const safePageNumber = Math.min(Math.max(1, pageNumber), pdf.numPages)
        const page = await pdf.getPage(safePageNumber)
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = resolvePdfRenderScale(baseViewport.width, maxWidthPx)
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        const canvasWidth = Math.ceil(viewport.width)
        const canvasHeight = Math.ceil(viewport.height)
        const context = canvas.getContext('2d', { alpha: false })

        if (!context) {
            throw new Error('Unable to create a canvas context for PDF receipt printing.')
        }

        canvas.width = canvasWidth
        canvas.height = canvasHeight
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvasWidth, canvasHeight)

        await page.render({
            canvas,
            viewport,
            background: '#ffffff',
            intent: 'print'
        }).promise

        const outputCanvas = trimBottomWhitespace
            ? trimCanvasBottomWhitespace(canvas, bottomPaddingPx)
            : canvas

        return outputCanvas.toDataURL('image/png')
    } finally {
        await loadingTask.destroy()
    }
}

/** Rasterizes a PDF page while retaining its physical page size for native label printing. */
export async function renderPdfPageForNativePrinting(
    pdfBlob: Blob,
    { maxWidthPx = 2048, pageNumber = 1 }: NativePdfRenderOptions = {},
): Promise<NativePdfPageImage> {
    const pdfjsLib = await import('pdfjs-dist')
    ensurePdfWorkerConfigured(pdfjsLib)

    const pdfData = new Uint8Array(await pdfBlob.arrayBuffer())
    const loadingTask = pdfjsLib.getDocument({ data: pdfData })

    try {
        const pdf = await loadingTask.promise
        const safePageNumber = Math.min(Math.max(1, pageNumber), pdf.numPages)
        const page = await pdf.getPage(safePageNumber)
        const baseViewport = page.getViewport({ scale: 1 })
        const widthMm = baseViewport.width * 25.4 / 72
        const heightMm = baseViewport.height * 25.4 / 72
        const scale = resolvePdfRenderScale(baseViewport.width, maxWidthPx)
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('Unable to create an image for native label printing.')

        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        await page.render({ canvas, viewport, background: '#ffffff', intent: 'print' }).promise

        return {
            pngDataUrl: canvas.toDataURL('image/png'),
            widthMm,
            heightMm,
        }
    } finally {
        await loadingTask.destroy()
    }
}
