import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from '@/i18n/config'
import { I18nextProvider } from 'react-i18next'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import { A4InvoiceTemplate, ModernA4InvoiceTemplate, RefundA4InvoiceTemplate, RefundPrimaryA4InvoiceTemplate } from '@/ui/components'
import { SaleReceiptBase } from '@/ui/components/SaleReceipt'
import { UniversalInvoice } from '@/types'

export type PrintFormat = 'a4' | 'receipt'

interface PDFLayer {
    image: string | HTMLCanvasElement // dataUrl or Canvas
    x: number    // mm
    y: number    // mm
    w: number    // mm
    h: number    // mm
    format: 'PNG' | 'JPEG'
}

interface RenderResult {
    background: string // Low-res JPEG dataUrl
    qrs: PDFLayer[]    // High-res PNG dataUrls
    widthMm: number
    heightMm: number
}

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
        print_quality?: 'low' | 'high'
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
    printQuality?: 'low' | 'high'
}

const A4_WIDTH_MM = 210
const RECEIPT_WIDTH_MM = 80

async function waitForImages(container: HTMLElement) {
    const images = Array.from(container.querySelectorAll('img'))
    await Promise.all(images.map(img => new Promise<void>((resolve) => {
        if (img.complete && img.naturalWidth > 0) {
            resolve()
            return
        }
        const cleanup = () => {
            img.removeEventListener('load', cleanup)
            img.removeEventListener('error', cleanup)
            resolve()
        }
        img.addEventListener('load', cleanup)
        img.addEventListener('error', cleanup)
        setTimeout(cleanup, 3000)
    })))
}

async function renderToCanvas(element: ReturnType<typeof createElement>, widthMm: number, quality: 'low' | 'high' = 'low'): Promise<RenderResult> {
    const container = document.createElement('div')
    container.id = 'pdf-render-container'
    container.style.position = 'fixed'
    container.style.left = '-10000px'
    container.style.top = '0'
    container.style.width = `${widthMm}mm`
    container.style.background = '#ffffff'
    container.style.zIndex = '-9999'
    container.style.pointerEvents = 'none'
    // Rely on index.css @media print for hiding, as display:none breaks html2canvas
    container.classList.add('no-print')
    document.body.appendChild(container)

    const root = createRoot(container)
    root.render(element)

    await new Promise(requestAnimationFrame)
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (document.fonts?.ready) {
        await document.fonts.ready
    }
    await waitForImages(container)

    const HIGH_SCALE = 6 // Higher scale for perfect QR pixel capture
    const LOW_SCALE = quality === 'high' ? 2.5 : 1.25
    const JPEG_QUALITY = quality === 'high' ? 0.9 : 0.6

    let sharpZones: { x: number, y: number, width: number, height: number }[] = []

    // 1. Identify sharp zones (QRs) in the live DOM before capture
    // This ensures we get real coordinates that aren't zeroed out
    const containerRect = container.getBoundingClientRect()
    const qrElements = container.querySelectorAll('[data-qr-sharp="true"]')
    qrElements.forEach(el => {
        const rect = (el as HTMLElement).getBoundingClientRect()
        sharpZones.push({
            x: rect.left - containerRect.left,
            y: rect.top - containerRect.top,
            width: rect.width,
            height: rect.height
        })
    })

    // 2. Capture High-Res for QR Extraction
    const highResCanvas = await html2canvas(container, {
        scale: HIGH_SCALE,
        useCORS: true,
        backgroundColor: '#ffffff'
    })

    // 2. Identify sharp zones and calculate unit conversion ratio
    const containerPixelWidth = container.offsetWidth
    const pxToMm = widthMm / containerPixelWidth

    const lowResCanvas = await html2canvas(container, {
        scale: LOW_SCALE,
        useCORS: true,
        backgroundColor: '#ffffff',
        onclone: (clonedDoc) => {
            const qrElements = clonedDoc.querySelectorAll('[data-qr-sharp="true"]')
            qrElements.forEach(el => {
                (el as HTMLElement).style.visibility = 'hidden'
            })
        }
    })

    const calculatedHeightMm = (lowResCanvas.height * pxToMm) / LOW_SCALE

    // 3. Extract QR Layers and convert to MM units
    const qrs: PDFLayer[] = sharpZones
        .filter(zone => zone.width > 0 && zone.height > 0)
        .map(zone => {
            const qrCanvas = document.createElement('canvas')
            qrCanvas.width = Math.round(zone.width * HIGH_SCALE)
            qrCanvas.height = Math.round(zone.height * HIGH_SCALE)
            const qrCtx = qrCanvas.getContext('2d')

            if (qrCtx) {
                qrCtx.drawImage(
                    highResCanvas,
                    Math.round(zone.x * HIGH_SCALE), Math.round(zone.y * HIGH_SCALE),
                    Math.round(zone.width * HIGH_SCALE), Math.round(zone.height * HIGH_SCALE),
                    0, 0, qrCanvas.width, qrCanvas.height
                )
            }

            return {
                image: qrCanvas.toDataURL('image/png'),
                x: zone.x * pxToMm,
                y: zone.y * pxToMm,
                w: zone.width * pxToMm,
                h: zone.height * pxToMm,
                format: 'PNG'
            }
        })

    root.unmount()
    container.remove()

    return {
        background: lowResCanvas.toDataURL('image/jpeg', JPEG_QUALITY),
        qrs,
        widthMm,
        heightMm: calculatedHeightMm
    }
}

function canvasToA4Pdf(renderResult: RenderResult) {
    const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' })

    // Add background JPEG (Low Res)
    pdf.addImage(renderResult.background, 'JPEG', 0, 0, renderResult.widthMm, renderResult.heightMm, undefined, 'FAST')

    // Overlay sharp QR codes (High Res) using lossless PNG for maximum clarity
    renderResult.qrs.forEach(qr => {
        pdf.addImage(qr.image as string, 'PNG', qr.x, qr.y, qr.w, qr.h, undefined, 'FAST')
    })

    return pdf.output('blob') as Blob
}

function canvasToReceiptPdf(renderResult: RenderResult) {
    const pdf = new jsPDF({
        orientation: 'p',
        unit: 'mm',
        format: [renderResult.widthMm, renderResult.heightMm]
    })

    // Add background JPEG (Low Res)
    pdf.addImage(renderResult.background, 'JPEG', 0, 0, renderResult.widthMm, renderResult.heightMm, undefined, 'FAST')

    // Overlay sharp QR codes (High Res) using lossless PNG for maximum clarity
    renderResult.qrs.forEach(qr => {
        pdf.addImage(qr.image as string, 'PNG', qr.x, qr.y, qr.w, qr.h, undefined, 'FAST')
    })

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
    const targetLang = features?.print_lang || i18n.language
    const pdfI18n = i18n.cloneInstance({ lng: targetLang })
    await pdfI18n.changeLanguage(targetLang)

    const processedLogoUrl = await preprocessLogoUrl(features?.logo_url)
    const processedFeatures = {
        ...features,
        logo_url: processedLogoUrl
    }

    // Set direction explicitly for the rendering process based on current print selection
    // though templates handle it, this helps html2canvas detect context better
    const isRTL = i18n.language === 'ar' || i18n.language === 'ku'

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
        const renderResult = await renderToCanvas(element, RECEIPT_WIDTH_MM, features?.print_quality)
        return canvasToReceiptPdf(renderResult)
    }

    const isRefundA4 = !!data.is_refund_invoice
    const isModernA4 = features?.a4_template === 'modern'
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
                    workspaceName: workspaceName || workspaceId || 'Atlas'
                }))
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
                workspaceName: workspaceName || workspaceId || 'Atlas'
            })
    )
    const renderResult = await renderToCanvas(element, A4_WIDTH_MM, features?.print_quality)
    return canvasToA4Pdf(renderResult)

}

/**
 * Generates a PDF blob from a custom React element (e.g., Loan print templates).
 */
export async function generateTemplatePdf({
    element,
    format = 'a4',
    printLang,
    printQuality
}: TemplatePdfOptions): Promise<Blob> {
    if (!i18n.isInitialized) {
        await new Promise(resolve => i18n.on('initialized', resolve))
    }

    const targetLang = printLang || i18n.language
    const pdfI18n = i18n.cloneInstance({ lng: targetLang })
    await pdfI18n.changeLanguage(targetLang)

    const wrappedElement = createElement(I18nextProvider, { i18n: pdfI18n }, element)

    const widthMm = format === 'receipt' ? RECEIPT_WIDTH_MM : A4_WIDTH_MM
    const renderResult = await renderToCanvas(wrappedElement, widthMm, printQuality)

    return format === 'receipt' ? canvasToReceiptPdf(renderResult) : canvasToA4Pdf(renderResult)
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
