/**
 * Paginates statement tables (partner order items) across A4 page boundaries.
 *
 * The template renders the sales/purchase statement as one continuous flow that
 * the PDF pipeline slices at every `pageHeightMm` (the preview "red line").
 * When a table would cross that line, this splits the table right at the line:
 * rows above it keep their original header, while the rest moves into a new
 * chunk table that repeats the section title ("… (continued)") and the column
 * header row, so the second page reads as a clear continuation of its parent
 * section.
 *
 * The same DOM routine is used by the print preview editor (`PrintPreviewEditorPage`) and by the
 * canvas→PDF generator (`pdfGenerator`), which keeps the on-screen preview and
 * the exported document in sync.
 */

import { fitPrintReferenceLists } from './printReferenceList'

export const ORDER_ITEMS_PAGINATED_ATTR = 'data-order-items-paginated'
export const ORDER_ITEMS_SECTION_ATTR = 'data-order-items-section'
export const ORDER_ITEMS_TITLE_BAR_ATTR = 'data-order-items-section-title-bar'
export const ORDER_ITEMS_CONTINUATION_LABEL_ATTR = 'data-order-items-continuation-label'
export const ORDER_ITEMS_CONTINUATION_ATTR = 'data-order-items-continuation'
export const ORDER_ITEMS_CONTINUATION_TABLE_ATTR = 'data-order-items-continuation-table'
export const ORDER_ITEMS_TITLE_TEXT_ATTR = 'data-order-items-title-text'
export const ORDER_ITEMS_CONTINUATION_SUFFIX_ATTR = 'data-order-items-continuation-suffix'
export const ORDER_ITEMS_STATEMENT_BLOCK_ATTR = 'data-order-statement-block'
export const ORDER_ITEMS_SECTION_SUMMARY_ATTR = 'data-order-items-section-summary'
export const ORDER_ITEMS_PAGE_SPACER_ATTR = 'data-order-items-page-spacer'
export const ORDER_ITEMS_TABLE_HEADER_SPACER_ATTR = 'data-order-items-table-header-spacer'

const ORDER_ITEMS_PAGINATED_SELECTOR = `table[${ORDER_ITEMS_PAGINATED_ATTR}]`
const ORDER_ITEMS_CONTINUATION_SELECTOR = `[${ORDER_ITEMS_CONTINUATION_ATTR}]`
const ORDER_ITEMS_CONTINUATION_TABLE_SELECTOR = `table[${ORDER_ITEMS_CONTINUATION_TABLE_ATTR}]`
const ORDER_ITEMS_SECTION_SELECTOR = `[${ORDER_ITEMS_SECTION_ATTR}]`
const ORDER_ITEMS_TITLE_BAR_SELECTOR = `[${ORDER_ITEMS_TITLE_BAR_ATTR}]`

const SPLIT_EPSILON_MM = 0.05
const MAX_SPLIT_ITERATIONS = 500

export type OrderItemsRowSpan = {
    topMm: number
    bottomMm: number
}

export type OrderItemsSplitDecision = {
    rowIndex: number
    boundaryMm: number
}

export type OrderItemsTableHeaderSpacer = {
    spacerMm: number
}

/**
 * Finds where a statement table should be cut for the given page height.
 *
 * Rows are never split in half: the cut happens immediately above the first
 * row that would cross the boundary, so the previous page keeps every fully
 * visible row and the continuation starts with a whole row. When the table's
 * very first row already crosses the line there is nothing to cut above it —
 * the keep-together pagination moves the whole table to the next page instead.
 * When present, a footer is measured as part of the last data row.
 */
export function findOrderItemsSplitIndex(
    rows: readonly OrderItemsRowSpan[],
    pageHeightMm: number,
    pagePaddingMm = 0,
    footerBottomMm?: number
): OrderItemsSplitDecision | null {
    if (rows.length === 0 || !Number.isFinite(pageHeightMm) || pageHeightMm <= 0 || !Number.isFinite(pagePaddingMm) || pagePaddingMm < 0) {
        return null
    }

    const firstTopMm = rows[0].topMm
    // Keep a statement's totals and notes with its final data row. A footer
    // participates in page fitting even though it lives outside tbody.
    const lastRowIndex = rows.length - 1
    const lastBottomMm = Number.isFinite(footerBottomMm)
        ? Math.max(rows[lastRowIndex].bottomMm, footerBottomMm!)
        : rows[lastRowIndex].bottomMm
    const lastBoundaryIndex = Math.floor((lastBottomMm + pagePaddingMm) / pageHeightMm)

    for (let boundaryIndex = 1; boundaryIndex <= lastBoundaryIndex; boundaryIndex += 1) {
        const boundaryMm = (boundaryIndex * pageHeightMm) - pagePaddingMm
        if (boundaryMm <= firstTopMm + SPLIT_EPSILON_MM) continue

        const crossingRowIndex = rows.findIndex((row, index) => (
            index === lastRowIndex ? lastBottomMm : row.bottomMm
        ) > boundaryMm + SPLIT_EPSILON_MM)
        if (crossingRowIndex > 0) {
            return { rowIndex: crossingRowIndex, boundaryMm }
        }
    }

    return null
}

/**
 * Ensures a table header and its first full row never strand at the bottom of
 * an A4 page. The returned spacer moves that table to the next printable page
 * area, preserving both the repeated heading and the exact measured row
 * height. A header plus a single row taller than an A4 content area is left in
 * place because it cannot be kept together by any pagination strategy.
 */
export function planOrderItemsTableHeaderSpacer(
    tableTopMm: number,
    firstRowBottomMm: number,
    pageHeightMm: number,
    pagePaddingMm = 0
): OrderItemsTableHeaderSpacer | null {
    if (!Number.isFinite(tableTopMm)
        || !Number.isFinite(firstRowBottomMm)
        || !Number.isFinite(pageHeightMm)
        || !Number.isFinite(pagePaddingMm)
        || pageHeightMm <= 0
        || pagePaddingMm < 0
        || firstRowBottomMm <= tableTopMm + SPLIT_EPSILON_MM
    ) {
        return null
    }

    const headerAndFirstRowHeightMm = firstRowBottomMm - tableTopMm
    const printablePageHeightMm = pageHeightMm - (pagePaddingMm * 2)
    if (headerAndFirstRowHeightMm > printablePageHeightMm + SPLIT_EPSILON_MM) {
        return null
    }

    const pageStartMm = Math.floor(tableTopMm / pageHeightMm) * pageHeightMm
    const pageContentTopMm = pageStartMm + pagePaddingMm
    const pageContentBottomMm = pageStartMm + pageHeightMm - pagePaddingMm
    const targetTopMm = tableTopMm < pageContentTopMm - SPLIT_EPSILON_MM
        ? pageContentTopMm
        : firstRowBottomMm > pageContentBottomMm + SPLIT_EPSILON_MM
            ? pageStartMm + pageHeightMm + pagePaddingMm
            : null

    if (targetTopMm === null) return null

    const spacerMm = targetTopMm - tableTopMm
    return spacerMm > SPLIT_EPSILON_MM ? { spacerMm } : null
}

/**
 * Undoes every previous split: moves the chunk rows and footer back into their original
 * table (in reverse document order so each chunk is appended after the rows of
 * the chunk before it) and removes the continuation wrappers.
 */
export function restoreOrderItemsTableSplits(root: HTMLElement): void {
    const continuations = Array.from(root.querySelectorAll<HTMLElement>(ORDER_ITEMS_CONTINUATION_SELECTOR))

    for (let index = continuations.length - 1; index >= 0; index -= 1) {
        const continuation = continuations[index]
        const chunkTable = continuation.querySelector<HTMLTableElement>(ORDER_ITEMS_CONTINUATION_TABLE_SELECTOR)
        const movedRows = chunkTable
            ? Array.from(chunkTable.querySelectorAll('tbody > tr'))
            : []
        const targetTable = nearestPrecedingOrderItemsTable(continuation)

        if (targetTable && movedRows.length > 0) {
            const targetBody = targetTable.querySelector('tbody') || targetTable
            movedRows.forEach((row) => targetBody.appendChild(row))
            const footer = chunkTable?.querySelector('tfoot')
            if (footer) targetTable.appendChild(footer)
        }

        continuation.remove()
    }

    root.querySelectorAll<HTMLElement>(`[${ORDER_ITEMS_TABLE_HEADER_SPACER_ATTR}]`).forEach((spacer) => spacer.remove())
}

function nearestPrecedingOrderItemsTable(element: Element): HTMLTableElement | null {
    let previous = element.previousElementSibling

    while (previous) {
        if (previous.matches(`${ORDER_ITEMS_PAGINATED_SELECTOR}, ${ORDER_ITEMS_CONTINUATION_TABLE_SELECTOR}`)) {
            return previous as HTMLTableElement
        }
        previous = previous.previousElementSibling
    }

    return null
}

/**
 * Cuts every `[data-order-items-paginated]` table at each page boundary it
 * crosses. Idempotent: any previous split is restored first, then the tables
 * are re-split against their current (post-restore) flow positions.
 */
export function paginateOrderItemsTables(
    root: HTMLElement,
    options: { pageHeightMm: number; pageWidthMm: number }
): void {
    if (!root.querySelector(`${ORDER_ITEMS_PAGINATED_SELECTOR}, ${ORDER_ITEMS_CONTINUATION_TABLE_SELECTOR}`)) return

    restoreOrderItemsTableSplits(root)
    fitPrintReferenceLists(root)

    const rootRect = root.getBoundingClientRect()
    if (rootRect.width <= 0) return

    const pxToMm = options.pageWidthMm / rootRect.width
    const pagePaddingMm = resolveStatementPagePaddingMm(root, 0)

    for (let iteration = 0; iteration < MAX_SPLIT_ITERATIONS; iteration += 1) {
        const tableHeaderSpacer = findNextOrderItemsTableHeaderSpacer(
            root,
            options.pageHeightMm,
            pxToMm,
            pagePaddingMm
        )
        if (tableHeaderSpacer) {
            applyOrderItemsTableHeaderSpacer(tableHeaderSpacer.table, tableHeaderSpacer.spacerMm)
            continue
        }

        const nextSplit = findNextOrderItemsTableSplit(root, options.pageHeightMm, pxToMm, pagePaddingMm)
        if (!nextSplit) return
        applyOrderItemsTableSplit(nextSplit.table, nextSplit.rowIndex)
    }
}

function findNextOrderItemsTableHeaderSpacer(
    root: HTMLElement,
    pageHeightMm: number,
    pxToMm: number,
    pagePaddingMm: number
): { table: HTMLTableElement; spacerMm: number } | null {
    const rootRect = root.getBoundingClientRect()
    const tables = Array.from(root.querySelectorAll<HTMLTableElement>(
        `${ORDER_ITEMS_PAGINATED_SELECTOR}, ${ORDER_ITEMS_CONTINUATION_TABLE_SELECTOR}`
    ))

    for (const table of tables) {
        const firstRow = table.querySelector<HTMLTableRowElement>('tbody > tr')
        if (!firstRow) continue

        const tableRect = table.getBoundingClientRect()
        const firstRowRect = firstRow.getBoundingClientRect()
        const singleRowFooter = firstRow.nextElementSibling ? null : table.querySelector('tfoot')
        const firstRowBottom = Math.max(firstRowRect.bottom, singleRowFooter?.getBoundingClientRect().bottom || firstRowRect.bottom)
        const spacer = planOrderItemsTableHeaderSpacer(
            (tableRect.top - rootRect.top) * pxToMm,
            (firstRowBottom - rootRect.top) * pxToMm,
            pageHeightMm,
            pagePaddingMm
        )

        if (spacer) return { table, spacerMm: spacer.spacerMm }
    }

    return null
}

function applyOrderItemsTableHeaderSpacer(table: HTMLTableElement, spacerMm: number): void {
    const spacer = document.createElement('div')
    spacer.setAttribute(ORDER_ITEMS_TABLE_HEADER_SPACER_ATTR, '')
    spacer.style.height = `${spacerMm}mm`
    table.insertAdjacentElement('beforebegin', spacer)
}

function findNextOrderItemsTableSplit(
    root: HTMLElement,
    pageHeightMm: number,
    pxToMm: number,
    pagePaddingMm: number
): { table: HTMLTableElement; rowIndex: number } | null {
    const rootRect = root.getBoundingClientRect()
    const tables = Array.from(root.querySelectorAll<HTMLTableElement>(
        `${ORDER_ITEMS_PAGINATED_SELECTOR}, ${ORDER_ITEMS_CONTINUATION_TABLE_SELECTOR}`
    ))

    for (const table of tables) {
        const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody > tr'))
        if (rows.length === 0) continue

        const spans: OrderItemsRowSpan[] = rows.map((row) => {
            const rect = row.getBoundingClientRect()
            return {
                topMm: (rect.top - rootRect.top) * pxToMm,
                bottomMm: (rect.bottom - rootRect.top) * pxToMm
            }
        })

        const footer = table.querySelector('tfoot')
        const footerBottomMm = footer ? (footer.getBoundingClientRect().bottom - rootRect.top) * pxToMm : undefined
        const decision = findOrderItemsSplitIndex(spans, pageHeightMm, pagePaddingMm, footerBottomMm)
        if (decision) {
            return { table, rowIndex: decision.rowIndex }
        }
    }

    return null
}

function getOrderItemsTitleParts(table: HTMLTableElement): { title: string; label: string | null } | null {
    const storedTitle = table.getAttribute(ORDER_ITEMS_TITLE_TEXT_ATTR)
    const storedLabel = table.getAttribute(ORDER_ITEMS_CONTINUATION_LABEL_ATTR)
    if (storedTitle != null && storedLabel != null) {
        return { title: storedTitle, label: storedLabel }
    }

    const section = table.closest<HTMLElement>(ORDER_ITEMS_SECTION_SELECTOR)
    const titleBar = section?.querySelector<HTMLElement>(ORDER_ITEMS_TITLE_BAR_SELECTOR)
    const title = titleBar?.querySelector('h2')?.textContent?.trim()
    const label = titleBar?.getAttribute(ORDER_ITEMS_CONTINUATION_LABEL_ATTR) || null

    return title ? { title, label } : null
}

/**
 * Moves `rowIndex` and every following row of the table into a new chunk table
 * that repeats the column header and any section title, and inserts that
 * chunk right after the source table. Totals belong to the final chunk.
 */
function applyOrderItemsTableSplit(table: HTMLTableElement, rowIndex: number): void {
    const sourceBody = table.querySelector('tbody')
    if (!sourceBody) return

    const rows = Array.from(sourceBody.querySelectorAll(':scope > tr'))
    const movedRows = rows.slice(rowIndex)
    if (movedRows.length === 0) return

    const continuation = document.createElement('div')
    continuation.setAttribute(ORDER_ITEMS_CONTINUATION_ATTR, '')

    const chunk = table.cloneNode(false) as HTMLTableElement
    chunk.removeAttribute(ORDER_ITEMS_PAGINATED_ATTR)
    chunk.setAttribute(ORDER_ITEMS_CONTINUATION_TABLE_ATTR, '')
    table.querySelectorAll(':scope > colgroup').forEach(group => chunk.appendChild(group.cloneNode(true)))

    const titleParts = getOrderItemsTitleParts(table)
    if (titleParts) {
        chunk.setAttribute(ORDER_ITEMS_TITLE_TEXT_ATTR, titleParts.title)
        if (titleParts.label) {
            chunk.setAttribute(ORDER_ITEMS_CONTINUATION_LABEL_ATTR, titleParts.label)
        }
    }

    const head = table.querySelector('thead')
    const headerRow = Array.from(head?.querySelectorAll('tr') || [])
        .find((tr) => !tr.hasAttribute(ORDER_ITEMS_CONTINUATION_LABEL_ATTR))
    const columnCount = headerRow?.children.length || 1

    const chunkHead = head ? (head.cloneNode(true) as HTMLTableSectionElement) : document.createElement('thead')
    chunkHead.querySelector(`tr[${ORDER_ITEMS_CONTINUATION_LABEL_ATTR}]`)?.remove()
    if (titleParts) chunkHead.insertBefore(buildContinuationTitleRow(titleParts, columnCount), chunkHead.firstChild)
    chunk.appendChild(chunkHead)

    const chunkBody = document.createElement('tbody')
    movedRows.forEach((row) => chunkBody.appendChild(row))
    chunk.appendChild(chunkBody)
    const footer = table.querySelector('tfoot')
    if (footer) chunk.appendChild(footer)

    continuation.appendChild(chunk)
    table.insertAdjacentElement('afterend', continuation)
}

function buildContinuationTitleRow(
    titleParts: { title: string; label: string | null } | null,
    columnCount: number
): HTMLTableRowElement {
    const row = document.createElement('tr')
    row.setAttribute(ORDER_ITEMS_CONTINUATION_LABEL_ATTR, titleParts?.label || '')

    const cell = document.createElement('td')
    cell.colSpan = columnCount
    cell.className = 'border border-slate-300 p-1 text-start'

    const bar = document.createElement('div')
    bar.className = 'flex items-center justify-between'

    const heading = document.createElement('h2')
    heading.className = 'text-sm font-bold'
    heading.textContent = titleParts?.title || ''

    if (titleParts?.label) {
        const suffix = document.createElement('span')
        suffix.setAttribute(ORDER_ITEMS_CONTINUATION_SUFFIX_ATTR, '')
        suffix.className = 'ms-1 text-[9px] font-normal text-slate-500'
        suffix.textContent = titleParts.label
        heading.appendChild(suffix)
    }

    bar.appendChild(heading)
    cell.appendChild(bar)
    row.appendChild(cell)
    return row
}

const ORDER_ITEMS_STATEMENT_PACKABLE_SELECTOR = [
    `[${ORDER_ITEMS_STATEMENT_BLOCK_ATTR}]`,
    `[${ORDER_ITEMS_TITLE_BAR_ATTR}]`,
    `[${ORDER_ITEMS_SECTION_SUMMARY_ATTR}]`
].join(', ')

function resolveStatementPagePaddingMm(root: HTMLElement, fallback: number) {
    const raw = root.querySelector<HTMLElement>('[data-page-padding-mm]')?.getAttribute('data-page-padding-mm')
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export type OrderItemsStatementPlacement = {
    blockIndex: number
    spacerMm: number
}

/**
 * Decides where invisible page spacers must be inserted so every atomic order
 * block stays inside one A4 page. `topsMm` and `heightsMm` are the blocks'
 * natural (spacer-free) flow positions; the returned placements describe the
 * spacer to insert before each moved block. Spacers shift later blocks, so the
 * running shift is folded into each decision.
 */
export function planOrderItemsStatementSpacers(
    topsMm: readonly number[],
    heightsMm: readonly number[],
    pageHeightMm: number,
    pagePaddingMm: number
): OrderItemsStatementPlacement[] {
    if (topsMm.length === 0 || topsMm.length !== heightsMm.length) return []
    if (!Number.isFinite(pageHeightMm) || pageHeightMm <= 0 || !Number.isFinite(pagePaddingMm)) return []

    const placements: OrderItemsStatementPlacement[] = []
    let shiftMm = 0

    for (let index = 1; index < topsMm.length; index += 1) {
        const topMm = topsMm[index] + shiftMm
        const heightMm = heightsMm[index]
        const pageStartMm = Math.floor(topMm / pageHeightMm) * pageHeightMm
        const pageContentBottomMm = pageStartMm + pageHeightMm - pagePaddingMm

        if (heightMm <= pageContentBottomMm - topMm + SPLIT_EPSILON_MM) continue

        const nextPageContentTopMm = pageStartMm + pageHeightMm + pagePaddingMm
        const spacerMm = nextPageContentTopMm - topMm
        if (spacerMm > SPLIT_EPSILON_MM) {
            placements.push({ blockIndex: index, spacerMm })
            shiftMm += spacerMm
        }
    }

    return placements
}

/**
 * Packs the partner order items statement into whole A4 pages.
 *
 * The template renders each order as its own atomic block (all of its items
 * and its total row in one table). This routine measures every packable block
 * (order blocks plus the section title bars and currency summaries) and pushes
 * any block that would not fit below the current page's content area to the
 * next page by inserting an invisible spacer, so each printed page contains
 * only complete orders. An order taller than one full page is left to span
 * pages on its own; `paginateOrderItemsTables` still splits its table with
 * "(continued)" chunks.
 *
 * Idempotent: previously inserted spacers and table splits are removed first.
 */
export function paginateOrderItemsStatementPages(
    root: HTMLElement,
    options: { pageHeightMm: number; pageWidthMm: number; pagePaddingMm?: number }
): void {
    const blocks = Array.from(root.querySelectorAll<HTMLElement>(ORDER_ITEMS_STATEMENT_PACKABLE_SELECTOR))
    if (blocks.length === 0) return

    root.querySelectorAll<HTMLElement>(`[${ORDER_ITEMS_PAGE_SPACER_ATTR}]`).forEach((spacer) => spacer.remove())
    restoreOrderItemsTableSplits(root)

    const rootRect = root.getBoundingClientRect()
    if (rootRect.width <= 0) return

    const pxToMm = options.pageWidthMm / rootRect.width
    const pagePaddingMm = options.pagePaddingMm ?? resolveStatementPagePaddingMm(root, 10)

    const topsMm = blocks.map((block) => (block.getBoundingClientRect().top - rootRect.top) * pxToMm)
    const heightsMm = blocks.map((block) => block.getBoundingClientRect().height * pxToMm)

    const placements = planOrderItemsStatementSpacers(topsMm, heightsMm, options.pageHeightMm, pagePaddingMm)

    for (const placement of placements) {
        const spacer = document.createElement('div')
        spacer.setAttribute(ORDER_ITEMS_PAGE_SPACER_ATTR, '')
        spacer.style.height = `${placement.spacerMm}mm`
        blocks[placement.blockIndex].insertAdjacentElement('beforebegin', spacer)
    }
}
