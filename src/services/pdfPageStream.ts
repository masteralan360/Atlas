interface PdfPageSink {
    addPage(format: 'a4', orientation: 'p'): unknown
    addImage(data: string, format: string, x: number, y: number,
        width: number, height: number, alias: undefined, compression: 'FAST'): unknown
}

export interface PdfCapturePage {
    offsetPx: number
    heightPx: number
    heightMm: number
}

/** Long reports use print-quality 288 DPI rather than 384 DPI. */
export function resolvePdfPageRenderScale(requestedScale: number, pageCount: number) {
    const scale = Number.isFinite(requestedScale) ? Math.max(1, Math.floor(requestedScale)) : 1
    return pageCount > 10 ? Math.min(scale, 3) : scale
}

/** Encode and release each raster before capturing the next page. */
export async function streamPdfPages(
    pdf: PdfPageSink,
    pages: readonly PdfCapturePage[],
    widthMm: number,
    capture: (page: PdfCapturePage) => Promise<HTMLCanvasElement>,
    progress: (page: number, total: number) => void,
    yieldToUi: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0))
) {
    for (let index = 0; index < pages.length; index += 1) {
        await yieldToUi()
        const canvas = await capture(pages[index])
        try {
            if (index > 0) pdf.addPage('a4', 'p')
            pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG',
                0, 0, widthMm, pages[index].heightMm, undefined, 'FAST')
        } finally {
            // Clearing dimensions releases the backing pixel buffer immediately.
            canvas.width = 0
            canvas.height = 0
        }
        progress(index + 1, pages.length)
    }
}
