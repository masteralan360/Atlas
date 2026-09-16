import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from '@/i18n/config'
import { I18nextProvider } from 'react-i18next'
import { A4InvoiceTemplate, ModernA4InvoiceTemplate, ProfessionalA4InvoiceTemplate, RefundA4InvoiceTemplate, RefundPrimaryA4InvoiceTemplate } from '@/ui/components'
import { SaleReceiptBase } from '@/ui/components/SaleReceipt'
import { UniversalInvoice } from '@/types'
import {
    A4_PAGE_HEIGHT_MM,
    getA4PageStarts,
    type A4KeepTogetherBlock
} from '@/services/a4Pagination'
import { paginateOrderItemsStatementPages, paginateOrderItemsTables } from '@/lib/orderItemsTablePagination'
import { settleAtlasStandardOrderLayouts } from '@/lib/useAtlasStandardOrderLayout'
import { centerTablesOnPages } from '@/lib/centeredTablePagination'
import { reportPdfProgress } from '@/services/pdfProgress'
import { inlineCaptureableImages, waitForPdfImages } from '@/services/pdfImageCapture'
import { preparePdfPageCapture } from '@/services/pdfPageCapture'
import { resolvePdfPageRenderScale, streamPdfPages } from '@/services/pdfPageStream'

/** Formats that can be stored as invoice versions. */
export type InvoicePrintFormat = 'a4' | 'receipt'

/**
 * Formats available from the common print selector. Barcode labels are
 * printable documents, but never invoice versions.
 */
export type PrintFormat = InvoicePrintFormat | 'barcode_35x15'

export function isInvoicePrintFormat(format: PrintFormat): format is InvoicePrintFormat {
    return format === 'a4' || format === 'receipt'
}

interface RenderResult {
    background: HTMLCanvasElement
    widthMm: number
    heightMm: number
}

type JsPDFConstructor = typeof import('jspdf').jsPDF

interface WorkspaceContactPair {
    primary?: string
    nonPrimary?: string
}

interface WorkspaceFooterContacts {
    address?: WorkspaceContactPair
    email?: WorkspaceContactPair
    phone?: WorkspaceContactPair
}

interface PDFGeneratorOptions {
    data: UniversalInvoice
    format: PrintFormat
    features: {
        logo_url?: string | null
        iqd_display_preference?: string
        print_lang?: string
        a4_template?: string
    }
    workspaceName?: string
    workspaceId?: string
    translations?: Record<string, string>
    workspaceFooterContacts?: WorkspaceFooterContacts
}

interface TemplatePdfOptions {
    element: ReactElement
    format?: PrintFormat
    printLang?: string
}

const A4_WIDTH_MM = 210
const A4_HEIGHT_MM = A4_PAGE_HEIGHT_MM
const RECEIPT_WIDTH_MM = 80
const RENDER_SCALE = 4
const MAX_RENDER_SCALE = 6
const TARGET_CANVAS_WIDTH_PX = 1600
const MAX_CANVAS_DIMENSION_PX = 16_384
const CSS_PX_PER_MM = 96 / 25.4

// html-to-image needs a valid data URL when an image cannot be downloaded.
// An empty source makes its cloned <img> emit an error event, which rejects
// the entire PDF render. This transparent GIF preserves the image's layout
// without putting an unreadable third-party image in the canvas.
const TRANSPARENT_IMAGE_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

function resolvePrintLanguage(printLang: string | null | undefined) {
    return printLang && printLang !== 'auto' ? printLang : i18n.language
}

async function expandContainerToRenderedBounds(container: HTMLElement) {
    await new Promise(requestAnimationFrame)

    const containerRect = container.getBoundingClientRect()
    let maxBottomPx = Math.max(container.scrollHeight, container.offsetHeight)

    container.querySelectorAll<HTMLElement>('*').forEach((element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 && rect.height <= 0) return

        const bottomPx = rect.bottom - containerRect.top
        if (Number.isFinite(bottomPx)) {
            maxBottomPx = Math.max(maxBottomPx, bottomPx)
        }
    })

    if (maxBottomPx > container.offsetHeight) {
        container.style.minHeight = `${Math.ceil(maxBottomPx)}px`
        await new Promise(requestAnimationFrame)
    }
}

function resolveRenderScale(containerPixelWidth: number) {
    if (!Number.isFinite(containerPixelWidth) || containerPixelWidth <= 0) {
        return RENDER_SCALE
    }

    const dynamicScale = Math.ceil(TARGET_CANVAS_WIDTH_PX / containerPixelWidth)
    return Math.min(MAX_RENDER_SCALE, Math.max(RENDER_SCALE, dynamicScale))
}

/**
 * A template watermark is normally an absolutely positioned image. Once the
 * template flows beyond A4, centering that image centers it in the complete
 * document instead of in each PDF page. During A4 capture we know the actual
 * slice starts, so replace the single source watermark with one clipped layer
 * per slice. Keeping this here also covers every native template that opts in
 * with `data-atlas-standard-background`.
 */
function repeatA4WatermarksForPages(
    container: HTMLElement,
    pageStartsMm: readonly number[],
    widthMm: number
) {
    const watermarks = Array.from(
        container.querySelectorAll<HTMLImageElement>(
            '[data-atlas-standard-background]:not([data-pdf-repeated-watermark])'
        )
    )
    if (watermarks.length === 0 || pageStartsMm.length === 0) {
        return () => undefined
    }

    const containerRect = container.getBoundingClientRect()
    if (containerRect.width <= 0) {
        return () => undefined
    }

    const pixelsToMm = widthMm / containerRect.width
    const restoreWatermarks: Array<() => void> = []

    watermarks.forEach((watermark) => {
        const host = watermark.parentElement
        if (!(host instanceof HTMLElement)) return

        const hostRect = host.getBoundingClientRect()
        const hostTopMm = (hostRect.top - containerRect.top) * pixelsToMm
        const originalVisibility = watermark.style.visibility
        const layers: HTMLElement[] = []

        watermark.style.visibility = 'hidden'

        pageStartsMm.forEach((pageStartMm, pageIndex) => {
            const layer = document.createElement('div')
            layer.dataset.pdfRepeatedWatermarkLayer = String(pageIndex + 1)
            Object.assign(layer.style, {
                position: 'absolute',
                left: '0',
                top: `${pageStartMm - hostTopMm}mm`,
                width: '100%',
                height: `${A4_HEIGHT_MM}mm`,
                overflow: 'hidden',
                pointerEvents: 'none',
                zIndex: '-10'
            })

            const pageWatermark = watermark.cloneNode(false) as HTMLImageElement
            pageWatermark.removeAttribute('id')
            pageWatermark.dataset.pdfRepeatedWatermark = 'true'
            Object.assign(pageWatermark.style, {
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                zIndex: 'auto',
                visibility: 'visible'
            })

            layer.appendChild(pageWatermark)
            host.appendChild(layer)
            layers.push(layer)
        })

        restoreWatermarks.push(() => {
            watermark.style.visibility = originalVisibility
            layers.forEach((layer) => layer.remove())
        })
    })

    return () => restoreWatermarks.forEach((restore) => restore())
}

async function renderTemplateCanvasSlice(
    container: HTMLElement,
    toCanvas: (node: HTMLElement, options: Record<string, unknown>) => Promise<HTMLCanvasElement>,
    widthPx: number,
    heightPx: number,
    offsetPx: number,
    renderScale: number
) {
    const originalTransform = container.style.transform
    const originalWillChange = container.style.willChange

    container.style.transform = `translateY(-${offsetPx}px)`
    container.style.willChange = 'transform'

    try {
        return await toCanvas(container, {
            width: widthPx,
            height: heightPx,
            pixelRatio: renderScale,
            backgroundColor: '#ffffff',
            // Product image providers such as Google thumbnails use a shared
            // path and identify the actual image entirely through query
            // parameters. html-to-image otherwise drops those parameters from
            // its cache key, causing a previously downloaded product photo to
            // be reused for different rows in the same PDF.
            includeQueryParams: true,
            imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
            skipAutoScale: true,
            style: { opacity: '1' }
        })
    } finally {
        container.style.transform = originalTransform
        container.style.willChange = originalWillChange
    }
}

async function reflowTemplateTextAfterContent(container: HTMLElement, widthMm: number) {
    const anchor = container.querySelector<HTMLElement>('[data-template-text-flow-anchor]')
    if (!anchor) return

    const containerRect = container.getBoundingClientRect()
    if (containerRect.width <= 0) return

    const anchorRect = anchor.getBoundingClientRect()
    const millimetersPerPixel = widthMm / containerRect.width
    const contentBottomMm = (anchorRect.bottom - containerRect.top) * millimetersPerPixel
    if (!Number.isFinite(contentBottomMm)) return

    container.querySelectorAll<HTMLElement>('[data-template-text-flow="after-content"]').forEach((text) => {
        const savedY = Number(text.dataset.templateTextYMm)
        if (!Number.isFinite(savedY)) return

        text.style.top = `${Math.max(savedY, contentBottomMm + 1)}mm`
    })

    await new Promise(requestAnimationFrame)
}

function collectA4KeepTogetherBlocks(container: HTMLElement, widthMm: number): A4KeepTogetherBlock[] {
    if (widthMm !== A4_WIDTH_MM) return []

    const containerRect = container.getBoundingClientRect()
    if (containerRect.width <= 0) return []

    const pxToMm = widthMm / containerRect.width
    const candidates = new Set([
        ...container.querySelectorAll<HTMLElement>(
            '[data-pdf-keep-together], [data-qr-sharp="true"], table, tr, .break-inside-avoid, .page-break-inside-avoid'
        )
    ])

    return Array.from(candidates).flatMap((element) => {
        // Statement templates which deliberately chunk their ledgers into
        // page-safe tables must be allowed to flow at their intended page
        // positions. Treating their enclosing table (or any of its rows) as
        // one generic keep-together block can produce an oversized canvas
        // slice and a non-A4 PDF page.
        if (element.closest('[data-pdf-page-chunk]')) return []

        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return []

        const topMm = (rect.top - containerRect.top) * pxToMm
        const bottomMm = (rect.bottom - containerRect.top) * pxToMm
        return Number.isFinite(topMm) && Number.isFinite(bottomMm)
            ? [{ topMm, bottomMm }]
            : []
    })
}

/**
 * Captures a rendered print template to canvas with html-to-image (SVG
 * foreignObject), allowing the browser to paint the clone consistently across
 * desktop, Android, and iOS/iPadOS.
 */
async function renderTemplateToPdf(element: ReturnType<typeof createElement>, widthMm: number): Promise<Blob> {
    const { jsPDF } = await import('jspdf')
    const container = document.createElement('div')
    container.id = 'pdf-render-container'
    // Must live in the viewport: html-to-image clones the node with its
    // computed style, and Chromium does not paint `position: fixed` (or
    // offscreen) content inside the SVG foreignObject — the capture comes
    // out blank. A top-left, invisible (opacity 0) absolute container is
    // painted correctly; the clone's opacity is restored via the style
    // override below.
    container.style.position = 'absolute'
    container.style.left = '0'
    container.style.top = '0'
    container.style.width = `${Math.max(1, Math.round(widthMm * CSS_PX_PER_MM))}px`
    container.style.background = '#ffffff'
    container.style.zIndex = '-9999'
    container.style.pointerEvents = 'none'
    container.style.opacity = '0'
    // Rely on index.css @media print for hiding, as display:none breaks canvas capture
    container.classList.add('no-print')
    document.body.appendChild(container)

    const root = createRoot(container)
    try {
        root.render(element)

        await new Promise(requestAnimationFrame)
        await new Promise((resolve) => setTimeout(resolve, 300))
        if (document.fonts?.ready) {
            await document.fonts.ready
        }
        await waitForPdfImages(container)
        await inlineCaptureableImages(container)
        await settleAtlasStandardOrderLayouts(container)
        await reflowTemplateTextAfterContent(container, widthMm)
        await expandContainerToRenderedBounds(container)
        reportPdfProgress(0.1, 'print.progressPreparing')

        if (widthMm === A4_WIDTH_MM) {
            // Pack complete orders into whole A4 pages (statement templates only),
            // then cut any oversized single-order table exactly at the A4 red line
            // and give each continuation chunk its own title and column header row.
            paginateOrderItemsStatementPages(container, {
                pageHeightMm: A4_HEIGHT_MM,
                pageWidthMm: widthMm
            })
            await expandContainerToRenderedBounds(container)
            paginateOrderItemsTables(container, {
                pageHeightMm: A4_HEIGHT_MM,
                pageWidthMm: widthMm
            })
            await expandContainerToRenderedBounds(container)
            // Vertically center continuation tables (for example the Atlas Standard
            // order invoice's follow-up tables) on their own A4 page.
            centerTablesOnPages(container, {
                pageHeightMm: A4_HEIGHT_MM,
                pageWidthMm: widthMm
            })
            await expandContainerToRenderedBounds(container)
            reportPdfProgress(0.25, 'print.progressLayingOut')
        }

        const keepTogetherBlocks = collectA4KeepTogetherBlocks(container, widthMm)

        // The container is invisible (opacity 0) while it lives in the viewport;
        // restore the clone's opacity so the SVG foreignObject paints it.
        reportPdfProgress(0.4, 'print.progressRendering')

        const containerPixelWidth = container.offsetWidth
        const containerPixelHeight = Math.max(container.scrollHeight, container.offsetHeight, 1)
        const renderScale = resolveRenderScale(containerPixelWidth)
        const { toCanvas } = await import('html-to-image')

        if (widthMm === A4_WIDTH_MM) {
            const pxToMm = widthMm / containerPixelWidth
            const heightMm = containerPixelHeight * pxToMm
            const pageStarts = getA4PageStarts(heightMm, keepTogetherBlocks, A4_HEIGHT_MM)
            const safeRenderScale = Math.min(
                renderScale,
                Math.max(1, Math.floor(MAX_CANVAS_DIMENSION_PX / containerPixelWidth))
            )
            const restorePageWatermarks = repeatA4WatermarksForPages(container, pageStarts, widthMm)

            try {
                // Ensure html-to-image observes the temporary page watermark layers
                // before it clones the source for the first canvas slice.
                await new Promise(requestAnimationFrame)
                const preparePage = preparePdfPageCapture(container)
                const pages = pageStarts.map((pageOffset, pageIndex) => {
                    const pageEnd = pageStarts[pageIndex + 1] ?? heightMm
                    const pageOffsetPx = Math.floor(pageOffset / pxToMm)
                    const pageHeightPx = Math.max(1, Math.ceil((pageEnd / pxToMm)) - pageOffsetPx)
                    return { offsetPx: pageOffsetPx, heightPx: pageHeightPx, heightMm: pageHeightPx * pxToMm }
                })
                const pageRenderScale = resolvePdfPageRenderScale(safeRenderScale, pages.length)
                const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })
                await streamPdfPages(pdf, pages, widthMm, async (page) => {
                    const restorePage = preparePage(page.offsetPx, page.heightPx)
                    try {
                        return await renderTemplateCanvasSlice(container, toCanvas,
                            containerPixelWidth, page.heightPx, page.offsetPx,
                            Math.min(pageRenderScale, Math.max(1, Math.floor(MAX_CANVAS_DIMENSION_PX / page.heightPx))))
                    } finally {
                        restorePage()
                    }
                }, (page, total) => reportPdfProgress(
                    0.4 + (0.55 * page) / total, 'print.progressBuildingPdf', { page, total }
                ))
                return pdf.output('blob') as Blob
            } finally {
                restorePageWatermarks()
            }

        }

        const background = await toCanvas(container, {
            width: containerPixelWidth,
            height: containerPixelHeight,
            pixelRatio: renderScale,
            backgroundColor: '#ffffff',
            // Product image providers such as Google thumbnails use a shared path
            // and identify the actual image entirely through query parameters.
            // html-to-image otherwise drops those parameters from its cache key,
            // causing a previously downloaded product photo to be reused for
            // different rows in the same PDF.
            includeQueryParams: true,
            imagePlaceholder: TRANSPARENT_IMAGE_PLACEHOLDER,
            skipAutoScale: false,
            style: { opacity: '1' }
        })
        reportPdfProgress(0.6, 'print.progressRendering')

        const pxToMm = widthMm / containerPixelWidth

        try {
            return canvasToReceiptPdf({
                background,
                widthMm,
                heightMm: background.width > 0
                    ? (background.height * widthMm) / background.width
                    : (background.height * pxToMm),
            }, jsPDF)
        } finally {
            background.width = 0
            background.height = 0
        }
    } finally {
        root.unmount()
        container.remove()
    }
}

function canvasToReceiptPdf(renderResult: RenderResult, PdfDocument: JsPDFConstructor) {
    const pdf = new PdfDocument({
        orientation: 'p',
        unit: 'mm',
        format: [renderResult.widthMm, renderResult.heightMm]
    })

    reportPdfProgress(0.95, 'print.progressBuildingPdf', { page: 1, total: 1 })

    // JPEG keeps very long receipt PDFs within browser memory limits while preserving readable text.
    pdf.addImage(
        renderResult.background.toDataURL('image/jpeg', 0.92),
        'JPEG',
        0,
        0,
        renderResult.widthMm,
        renderResult.heightMm,
        undefined,
        'FAST'
    )

    return pdf.output('blob') as Blob
}

async function preprocessLogoUrl(logoUrl?: string | null) {
    if (!logoUrl || !(logoUrl.startsWith('http') || logoUrl.startsWith('https'))) {
        return logoUrl
    }

    try {
        const response = await fetch(logoUrl)
        if (!response.ok) return undefined
        const blob = await response.blob()
        return await new Promise<string>((resolve) => {
            const reader = new FileReader()
            reader.onloadend = () => resolve(reader.result as string)
            reader.readAsDataURL(blob)
        })
    } catch (error) {
        console.warn('Failed to fetch logo for PDF:', error)
        return undefined
    }
}

/**
 * Generates a PDF blob from invoice data using the HTML templates.
 */
export async function generateInvoicePdf(options: PDFGeneratorOptions): Promise<Blob> {
    const { data, format, features = {} as any, workspaceName, workspaceId, workspaceFooterContacts } = options

    // Inject workspaceId into data for QR codes
    if (workspaceId && !data.workspaceId) {
        data.workspaceId = workspaceId
    }

    // Ensure i18n is initialized to prevent raw keys appearing in PDF
    if (!i18n.isInitialized) {
        await new Promise(resolve => i18n.on('initialized', resolve))
    }

    // Create a fixed instance for the specific print language
    const targetLang = resolvePrintLanguage(features?.print_lang)
    const pdfI18n = i18n.cloneInstance({ lng: targetLang })
    await pdfI18n.changeLanguage(targetLang)

    const processedLogoUrl = await preprocessLogoUrl(features?.logo_url)
    const processedFeatures = {
        ...features,
        print_lang: targetLang,
        logo_url: processedLogoUrl
    }

    // Set direction explicitly for the rendering process based on current print selection
    // though templates handle it, this helps the canvas capture detect context better
    const isRTL = targetLang === 'ar' || targetLang === 'ku'

    if (format === 'receipt') {
        const element = createElement(
            'div',
            {
                style: { width: `${RECEIPT_WIDTH_MM}mm`, background: '#ffffff' },
                dir: isRTL ? 'rtl' : 'ltr'
            },
            createElement(
                I18nextProvider,
                { i18n: pdfI18n },
                createElement(SaleReceiptBase, {
                    data,
                    features: processedFeatures,
                    workspaceName: workspaceName || workspaceId || 'Atlas',
                    workspaceId: workspaceId || ''
                })
            )
        )
        return renderTemplateToPdf(element, RECEIPT_WIDTH_MM)
    }

    const isRefundA4 = !!data.is_refund_invoice
    const isModernA4 = features?.a4_template === 'modern'
    const isProfessionalA4 = features?.a4_template === 'professional'
    const element = createElement(
        I18nextProvider,
        { i18n: pdfI18n },
        isRefundA4
            ? (isModernA4
                ? createElement(RefundA4InvoiceTemplate, {
                    data,
                    features: processedFeatures,
                    workspaceId,
                    workspaceName: workspaceName || workspaceId || 'Atlas'
                })
                : createElement(RefundPrimaryA4InvoiceTemplate, {
                    data,
                    features: processedFeatures,
                    workspaceId,
                    workspaceName: workspaceName || workspaceId || 'Atlas',
                    workspaceFooterContacts
                }))
            : isProfessionalA4
            ? createElement(ProfessionalA4InvoiceTemplate, {
                data,
                features: processedFeatures,
                workspaceId,
                workspaceName: workspaceName || workspaceId || 'Atlas',
                workspaceFooterContacts
            })
            : isModernA4
            ? createElement(ModernA4InvoiceTemplate, {
                data,
                features: processedFeatures,
                workspaceId,
                workspaceName: workspaceName || workspaceId || 'Atlas',
                workspaceFooterContacts
            })
            : createElement(A4InvoiceTemplate, {
                data,
                features: processedFeatures,
                workspaceId,
                workspaceName: workspaceName || workspaceId || 'Atlas',
                workspaceFooterContacts
            })
    )
    return renderTemplateToPdf(element, A4_WIDTH_MM)

}

/**
 * Generates a PDF blob from a custom React element (e.g., Loan print templates).
 */
export async function generateTemplatePdf({
    element,
    format = 'a4',
    printLang,
}: TemplatePdfOptions): Promise<Blob> {
    if (!i18n.isInitialized) {
        await new Promise(resolve => i18n.on('initialized', resolve))
    }

    const targetLang = resolvePrintLanguage(printLang)
    const pdfI18n = i18n.cloneInstance({ lng: targetLang })
    await pdfI18n.changeLanguage(targetLang)

    const wrappedElement = createElement(I18nextProvider, { i18n: pdfI18n }, element)

    const widthMm = format === 'receipt' ? RECEIPT_WIDTH_MM : A4_WIDTH_MM
    return renderTemplateToPdf(wrappedElement, widthMm)
}

/**
 * Generates R2 path for invoice PDF
 */
export function getInvoicePdfR2Path(
    workspaceId: string,
    invoiceId: string,
    format: PrintFormat
): string {
    const folder = format === 'a4' ? 'A4' : 'receipts'
    return `${workspaceId}/printed-invoices/${folder}/${invoiceId}.pdf`
}

/**
 * Downloads a PDF blob to user's device
 */
export function downloadPdfBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
}
