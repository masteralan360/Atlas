// The compact first-page grid keeps space for the financial section and fixed footer.
export const ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM = 145
// Continuation pages only contain the item table, so they can use more of the A4 page.
// 240 mm yields 30 rows with the default 8 mm row height, while retaining 20 mm
// of breathing room above and below the complete table.
export const ATLAS_STANDARD_CONTINUATION_TABLE_DATA_AREA_MM = 240

const TABLE_ITEM_ROW_MIN_MM = 8
export const DEFAULT_PRODUCT_IMAGE_COLUMN_WIDTH = 6
export const MIN_PRODUCT_IMAGE_COLUMN_WIDTH = 6
export const MAX_PRODUCT_IMAGE_COLUMN_WIDTH = 16

export function clampProductImageColumnWidth(value: number) {
    return Math.min(MAX_PRODUCT_IMAGE_COLUMN_WIDTH, Math.max(MIN_PRODUCT_IMAGE_COLUMN_WIDTH, value))
}

export function getProductImageColumnWidth(value?: string) {
    const parsed = Number(value)
    return Number.isFinite(parsed)
        ? clampProductImageColumnWidth(parsed)
        : DEFAULT_PRODUCT_IMAGE_COLUMN_WIDTH
}

export function getProductImageSizeMm(columnWidth: number) {
    return Math.min(16, Math.max(7, Number((7 + (columnWidth - DEFAULT_PRODUCT_IMAGE_COLUMN_WIDTH) * 1.1).toFixed(1))))
}

export function resolveAtlasStandardTableCapacities(productImageWidthValue?: string) {
    const productImageColumnWidth = getProductImageColumnWidth(productImageWidthValue)
    const productImageSizeMm = getProductImageSizeMm(productImageColumnWidth)
    const tableItemRowMm = Math.max(TABLE_ITEM_ROW_MIN_MM, productImageSizeMm + 1)

    return {
        productImageColumnWidth,
        productImageSizeMm,
        tableItemRowMm,
        firstPageRows: Math.max(1, Math.floor(ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM / tableItemRowMm)),
        continuationRows: Math.max(1, Math.floor(ATLAS_STANDARD_CONTINUATION_TABLE_DATA_AREA_MM / tableItemRowMm))
    }
}

/**
 * The first page shares space with the financial summary. Its filler must be
 * made of complete item rows so a fractional remainder never renders as a
 * thin, meaningless table strip above the totals row.
 */
export function getAtlasStandardFirstPageFillerRowCount(
    tableDataAreaMm: number,
    populatedRowCount: number,
    tableItemRowMm: number
) {
    const safeRowHeight = Math.max(0, Number(tableItemRowMm) || 0)
    if (safeRowHeight === 0) return 0

    const emptyAreaMm = Math.max(
        0,
        (Number(tableDataAreaMm) || 0) - (Math.max(0, populatedRowCount) * safeRowHeight)
    )
    return Math.floor(emptyAreaMm / safeRowHeight)
}

export function chunkAtlasStandardTableRows<T>(
    rows: readonly T[],
    firstPageRows: number,
    continuationRows: number
): T[][] {
    const firstPageCapacity = Math.max(1, Math.floor(firstPageRows))
    const continuationCapacity = Math.max(1, Math.floor(continuationRows))
    if (rows.length === 0) return [[]]

    const chunks = [rows.slice(0, firstPageCapacity)]
    for (let index = firstPageCapacity; index < rows.length; index += continuationCapacity) {
        chunks.push(rows.slice(index, index + continuationCapacity))
    }

    return chunks
}
