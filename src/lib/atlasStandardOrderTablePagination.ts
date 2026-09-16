// The compact first-page grid keeps space for the financial section and fixed footer.
export const ATLAS_STANDARD_FIRST_PAGE_TABLE_DATA_AREA_MM = 145
// Continuation pages only contain the item table, so they can use more of the A4 page.
// 240 mm yields 30 rows with the default 8 mm row height, while retaining 20 mm
// of breathing room above and below the complete table.
export const ATLAS_STANDARD_CONTINUATION_TABLE_DATA_AREA_MM = 240
export const ATLAS_STANDARD_TEXT_ANCHOR_FIELD = 'enableTextPositionAnchor'
export const ATLAS_STANDARD_PRINTABLE_BOTTOM_MM = 297 - 8

export function isAtlasStandardSmartRowExpansionEnabled(fields?: Record<string, string>) {
    return fields?.showPrintFooter === 'false' && fields?.[ATLAS_STANDARD_TEXT_ANCHOR_FIELD] === 'false'
}

/** Fit ordered, indivisible rows. Real content always takes priority over filler. */
export function fitAtlasStandardOrderRows(
    rowHeightsMm: readonly number[],
    firstPageDataAreaMm: number,
    emptyRowHeightMm: number,
    continuationDataAreaMm = ATLAS_STANDARD_CONTINUATION_TABLE_DATA_AREA_MM
) {
    const minimumRowMm = Number.isFinite(emptyRowHeightMm) && emptyRowHeightMm > 0 ? emptyRowHeightMm : 8
    const heights = rowHeightsMm.map((height) => Number.isFinite(height) && height > 0 ? height : minimumRowMm)
    const availableMm = Number.isFinite(firstPageDataAreaMm) ? Math.max(0, firstPageDataAreaMm) : 0
    // Browser subpixel arithmetic can differ by a few millionths of a mm.
    const epsilonMm = 0.00001
    let usedMm = 0
    let firstPageRows = 0
    while (firstPageRows < heights.length && usedMm + heights[firstPageRows] <= availableMm + epsilonMm) {
        usedMm += heights[firstPageRows++]
    }
    const fillerRows = Math.max(0, Math.floor((availableMm - usedMm + epsilonMm) / minimumRowMm))
    const continuationCapacityMm = Number.isFinite(continuationDataAreaMm) && continuationDataAreaMm > 0
        ? continuationDataAreaMm : ATLAS_STANDARD_CONTINUATION_TABLE_DATA_AREA_MM
    const continuationRows: number[] = []
    let index = firstPageRows
    while (index < heights.length) {
        let count = 0
        let pageUsedMm = 0
        while (index < heights.length && (count === 0 || pageUsedMm + heights[index] <= continuationCapacityMm + epsilonMm)) {
            pageUsedMm += heights[index++]
            count++
        }
        continuationRows.push(count)
    }
    // Never add a fractional table row. Use its remainder above the summary,
    // rather than leaving extra unused space underneath the document.
    const summaryOffsetMm = Math.max(0, availableMm - usedMm - fillerRows * minimumRowMm)
    return { firstPageRows, fillerRows, continuationRows, rowHeightsMm: heights, summaryOffsetMm }
}

/** Reserve the measured native tail and any saved text in the usable first-page region. */
export function getAtlasStandardAvailableTableAreaMm({
    tableTopMm, tableChromeMm, tailHeightMm, textBounds = [], printableBottomMm = ATLAS_STANDARD_PRINTABLE_BOTTOM_MM
}: {
    tableTopMm: number
    tableChromeMm: number
    tailHeightMm: number
    textBounds?: readonly { topMm: number; bottomMm: number }[]
    printableBottomMm?: number
}) {
    let bottomMm = printableBottomMm
    for (const text of textBounds) {
        if (text.bottomMm > tableTopMm && text.topMm < printableBottomMm) {
            bottomMm = Math.min(bottomMm, text.topMm - 1)
        }
    }
    return Math.max(0, bottomMm - tableTopMm - tableChromeMm - tailHeightMm)
}

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
