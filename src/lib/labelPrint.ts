export const LABEL_PRINT_TEMPLATE_KEY = 'products.LabelPrint'

export type LabelPrintPageSize = {
    widthMm: number
    heightMm: number
}

export function parseLabelDimensionMm(value: string): number | null {
    const normalized = value.trim()
    if (!normalized) return null

    const dimensionMm = Number(normalized)
    return Number.isFinite(dimensionMm) && dimensionMm > 0 ? dimensionMm : null
}

export function isValidLabelPrintPageSize(page: Partial<LabelPrintPageSize>): page is LabelPrintPageSize {
    return Number.isFinite(page.widthMm)
        && Number.isFinite(page.heightMm)
        && Number(page.widthMm) > 0
        && Number(page.heightMm) > 0
}
