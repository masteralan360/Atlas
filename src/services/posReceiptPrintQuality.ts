export type PosReceiptPrintQuality = 'high' | 'fast' | 'fastest'

export const DEFAULT_POS_RECEIPT_PRINT_QUALITY: PosReceiptPrintQuality = 'high'

const THERMAL_WIDTH_FACTORS: Record<PosReceiptPrintQuality, number> = {
    high: 1,
    fast: 0.75,
    fastest: 0.5
}

const RECEIPT_RENDER_SCALE_LIMITS: Record<PosReceiptPrintQuality, number> = {
    high: Number.POSITIVE_INFINITY,
    fast: 3,
    fastest: 2
}

export function normalizePosReceiptPrintQuality(value: unknown): PosReceiptPrintQuality {
    return value === 'fast' || value === 'fastest'
        ? value
        : DEFAULT_POS_RECEIPT_PRINT_QUALITY
}

export function resolvePosReceiptThermalWidth(maxWidthPx: number, quality: PosReceiptPrintQuality): number {
    const safeWidth = Number.isFinite(maxWidthPx) && maxWidthPx > 0 ? maxWidthPx : 1
    return Math.max(1, Math.round(safeWidth * THERMAL_WIDTH_FACTORS[quality]))
}

export function resolvePosReceiptRenderScale(scale: number, quality: PosReceiptPrintQuality): number {
    return Math.min(scale, RECEIPT_RENDER_SCALE_LIMITS[quality])
}
