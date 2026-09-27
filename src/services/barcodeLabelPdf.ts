import {
    getBarcodeLabelProfile,
    getCode128BBarWidths,
    formatBarcodeLabelPrice,
    type BarcodeLabelData,
    type BarcodeLabelPriceUnitTranslations,
    type BarcodeLabelProfile
} from '@/lib/barcodeLabel'

export const BARCODE_LABEL_WIDTH_MM = getBarcodeLabelProfile('barcode_35x15').widthMm
export const BARCODE_LABEL_HEIGHT_MM = getBarcodeLabelProfile('barcode_35x15').heightMm
export const WIDE_BARCODE_LABEL_WIDTH_MM = getBarcodeLabelProfile('barcode_108x50').widthMm
export const WIDE_BARCODE_LABEL_HEIGHT_MM = getBarcodeLabelProfile('barcode_108x50').heightMm

type BarcodeLabelsPdfOptions = {
    labels: BarcodeLabelData[]
    profile?: BarcodeLabelProfile
    showPrice?: boolean
    priceLabel?: string
    pricePerUnitTranslations?: Partial<BarcodeLabelPriceUnitTranslations>
}

const ARABIC_FONT_FILE = 'NotoKufiArabic-Regular.ttf'
const ARABIC_FONT_FAMILY = 'NotoKufiArabic'
let arabicFontDataPromise: Promise<string | null> | null = null

async function getArabicFontData() {
    if (!arabicFontDataPromise) {
        arabicFontDataPromise = fetch('/fonts/NotoKufiArabic-Regular.ttf')
            .then(async (response) => {
                if (!response.ok) return null

                const bytes = new Uint8Array(await response.arrayBuffer())
                let binary = ''
                const chunkSize = 0x8000
                for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
                }
                return btoa(binary)
            })
            .catch(() => null)
    }

    return arabicFontDataPromise
}

async function registerArabicFont(pdf: import('jspdf').jsPDF) {
    const fontData = await getArabicFontData()
    if (!fontData) return false

    pdf.addFileToVFS(ARABIC_FONT_FILE, fontData)
    pdf.addFont(ARABIC_FONT_FILE, ARABIC_FONT_FAMILY, 'normal')
    return true
}

function fitText(pdf: import('jspdf').jsPDF, value: string, maxWidth: number, startingSize: number, minimumSize: number) {
    let size = startingSize
    pdf.setFontSize(size)

    while (size > minimumSize && pdf.getTextWidth(value) > maxWidth) {
        size = Math.max(minimumSize, size - 0.15)
        pdf.setFontSize(size)
    }

    return size
}

function containsArabic(value: string) {
    return /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u.test(value)
}

function renderText(pdf: import('jspdf').jsPDF, value: string, useArabicFont: boolean) {
    return useArabicFont ? pdf.processArabic(value) : value
}

function drawBarcode(pdf: import('jspdf').jsPDF, value: string, x: number, y: number, width: number, height: number) {
    const widths = getCode128BBarWidths(value)
    const totalModules = widths.reduce((total, barWidth) => total + barWidth, 0)
    const moduleWidth = width / totalModules
    let cursor = x

    widths.forEach((barWidth, index) => {
        const renderedWidth = barWidth * moduleWidth
        if (index % 2 === 0) {
            pdf.rect(cursor, y, renderedWidth, height, 'F')
        }
        cursor += renderedWidth
    })
}

function drawCompactLabel(
    pdf: import('jspdf').jsPDF,
    label: BarcodeLabelData,
    profile: BarcodeLabelProfile,
    showPrice: boolean,
    priceLabel: string,
    pricePerUnitTranslations: Partial<BarcodeLabelPriceUnitTranslations>,
    useArabicFont: boolean
) {
    const horizontalPadding = profile.safeMarginMm
    const contentWidth = profile.widthMm - horizontalPadding * 2
    const priceText = formatBarcodeLabelPrice(
        label.price,
        label.currency,
        label.iqdDisplayPreference,
        label.unit,
        pricePerUnitTranslations
    )
    const barcodeHeight = showPrice ? 5.35 : 8.15
    const barcodeY = showPrice ? 5.3 : 1.1

    pdf.setDrawColor(212, 212, 212)
    pdf.setLineWidth(0.15)
    pdf.roundedRect(0.35, 0.35, profile.widthMm - 0.7, profile.heightMm - 0.7, 0.55, 0.55, 'S')
    pdf.setTextColor(0, 0, 0)
    pdf.setFont('helvetica', 'normal')

    if (showPrice) {
        pdf.setFontSize(1.7 * 2.835)
        pdf.text(priceLabel, horizontalPadding, 2.1)
        pdf.setFont(useArabicFont ? ARABIC_FONT_FAMILY : 'helvetica', useArabicFont ? 'normal' : 'bold')
        const renderedPriceText = renderText(pdf, priceText, useArabicFont)
        fitText(pdf, renderedPriceText, contentWidth, 2.7 * 2.835, 5)
        pdf.text(renderedPriceText, horizontalPadding, 4.45)
    }

    pdf.setFillColor(0, 0, 0)
    drawBarcode(pdf, label.barcode, horizontalPadding, barcodeY, contentWidth, barcodeHeight)
    pdf.setFont('courier', 'bold')
    fitText(pdf, label.displayValue, contentWidth, 1.65 * 2.835, 4.2)
    pdf.text(label.displayValue, profile.widthMm / 2, 13.95, { align: 'center' })
}

function drawWideLabel(
    pdf: import('jspdf').jsPDF,
    label: BarcodeLabelData,
    profile: BarcodeLabelProfile,
    showPrice: boolean,
    priceLabel: string,
    pricePerUnitTranslations: Partial<BarcodeLabelPriceUnitTranslations>,
    useArabicFont: boolean
) {
    const margin = profile.safeMarginMm
    const contentWidth = profile.widthMm - margin * 2
    const priceWidth = 39
    const nameWidth = contentWidth - priceWidth - 5
    const priceText = formatBarcodeLabelPrice(
        label.price,
        label.currency,
        label.iqdDisplayPreference,
        label.unit,
        pricePerUnitTranslations
    )

    pdf.setDrawColor(212, 212, 212)
    pdf.setLineWidth(0.2)
    pdf.roundedRect(0.6, 0.6, profile.widthMm - 1.2, profile.heightMm - 1.2, 0.8, 0.8, 'S')
    pdf.setTextColor(0, 0, 0)
    pdf.setFont(useArabicFont ? ARABIC_FONT_FAMILY : 'helvetica', 'bold')
    const renderedName = renderText(pdf, label.productName || label.displayValue, useArabicFont)
    fitText(pdf, renderedName, nameWidth, 15, 8)
    pdf.text(renderedName, margin, 10.2, { maxWidth: nameWidth })

    if (showPrice) {
        pdf.setFont(useArabicFont ? ARABIC_FONT_FAMILY : 'helvetica', 'normal')
        pdf.setFontSize(7.5)
        pdf.text(priceLabel, profile.widthMm - margin, 5.4, { align: 'right' })
        pdf.setFont(useArabicFont ? ARABIC_FONT_FAMILY : 'helvetica', 'bold')
        const renderedPriceText = renderText(pdf, priceText, useArabicFont)
        fitText(pdf, renderedPriceText, priceWidth, 14, 7)
        pdf.text(renderedPriceText, profile.widthMm - margin, 10.5, { align: 'right', maxWidth: priceWidth })
    }

    const barcodeY = showPrice ? 16 : 11
    const barcodeHeight = showPrice ? 23 : 28
    pdf.setFillColor(0, 0, 0)
    drawBarcode(pdf, label.barcode, margin, barcodeY, contentWidth, barcodeHeight)
    pdf.setFont('courier', 'bold')
    fitText(pdf, label.displayValue, contentWidth, 11, 7)
    pdf.text(label.displayValue, profile.widthMm / 2, 45.4, { align: 'center' })
}

function drawLabel(
    pdf: import('jspdf').jsPDF,
    label: BarcodeLabelData,
    profile: BarcodeLabelProfile,
    showPrice: boolean,
    priceLabel: string,
    pricePerUnitTranslations: Partial<BarcodeLabelPriceUnitTranslations>,
    useArabicFont: boolean
) {
    if (profile.layout === 'wide') {
        drawWideLabel(pdf, label, profile, showPrice, priceLabel, pricePerUnitTranslations, useArabicFont)
        return
    }

    drawCompactLabel(pdf, label, profile, showPrice, priceLabel, pricePerUnitTranslations, useArabicFont)
}

export async function generateBarcodeLabelsPdf({
    labels,
    profile = getBarcodeLabelProfile('barcode_35x15'),
    showPrice = true,
    priceLabel = 'Price',
    pricePerUnitTranslations = {}
}: BarcodeLabelsPdfOptions): Promise<Blob> {
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: [profile.widthMm, profile.heightMm]
    })
    const needsArabicFont = labels.some((label) => (
        containsArabic(label.productName)
        || containsArabic(label.iqdDisplayPreference)
        || containsArabic(formatBarcodeLabelPrice(
            label.price,
            label.currency,
            label.iqdDisplayPreference,
            label.unit,
            pricePerUnitTranslations
        ))
    )) || containsArabic(priceLabel)
        || Object.values(pricePerUnitTranslations).some((value) => containsArabic(value || ''))
    const hasArabicFont = needsArabicFont && await registerArabicFont(pdf)

    labels.forEach((label, index) => {
        if (index > 0) {
            pdf.addPage([profile.widthMm, profile.heightMm], 'landscape')
        }
        drawLabel(
            pdf,
            label,
            profile,
            showPrice,
            priceLabel,
            pricePerUnitTranslations,
            hasArabicFont
        )
    })

    return pdf.output('blob') as Blob
}
