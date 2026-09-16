import { describe, expect, it } from 'vitest'
import {
    findOrderItemsSplitIndex,
    ORDER_ITEMS_CONTINUATION_ATTR,
    ORDER_ITEMS_PAGINATED_ATTR,
    ORDER_ITEMS_TABLE_HEADER_SPACER_ATTR,
    planOrderItemsTableHeaderSpacer,
    planOrderItemsStatementSpacers
} from './orderItemsTablePagination'

function row(topMm: number, heightMm = 8): { topMm: number; bottomMm: number } {
    return { topMm, bottomMm: topMm + heightMm }
}

describe('findOrderItemsSplitIndex', () => {
    it('returns null when the table fits within a single page', () => {
        const rows = [row(10), row(18), row(26), row(34)]
        expect(findOrderItemsSplitIndex(rows, 297)).toBeNull()
    })

    it('cuts right above the first row that crosses the red line', () => {
        // Boundary at 297mm; the row at 292mm (bottom 300mm) is the first to cross.
        const rows = [row(120), row(128), row(136), row(144), row(292)]
        expect(findOrderItemsSplitIndex(rows, 297)).toEqual({ rowIndex: 4, boundaryMm: 297 })
    })

    it('keeps a row that ends exactly at the boundary on the previous page', () => {
        const rows = [row(120), row(128), row(289), row(297)]
        expect(findOrderItemsSplitIndex(rows, 297)).toEqual({ rowIndex: 3, boundaryMm: 297 })
    })

    it('handles tables that span several pages by returning the first crossing', () => {
        const rows = [row(10), row(18), row(290), row(298), row(306), row(580), row(588)]
        expect(findOrderItemsSplitIndex(rows, 297)).toEqual({ rowIndex: 2, boundaryMm: 297 })
    })

    it('does not split when the very first row already crosses the line', () => {
        const rows = [row(295), row(303), row(311), row(500)]
        expect(findOrderItemsSplitIndex(rows, 297)).toBeNull()
    })

    it('splits on later boundaries when the table starts after the first page', () => {
        const rows = [row(298), row(306), row(314), row(590), row(598)]
        expect(findOrderItemsSplitIndex(rows, 297)).toEqual({ rowIndex: 3, boundaryMm: 594 })
    })

    it('returns null for an empty table or an invalid page height', () => {
        expect(findOrderItemsSplitIndex([], 297)).toBeNull()
        expect(findOrderItemsSplitIndex([row(10)], 0)).toBeNull()
        expect(findOrderItemsSplitIndex([row(10)], Number.NaN)).toBeNull()
    })

    it('uses the printable content bottom, not the physical page edge, when padding is configured', () => {
        // On page 2, the printable bottom is 580mm (594 - 14). The second
        // row expands to 584mm, so it must start a new continuation table.
        expect(findOrderItemsSplitIndex([
            row(320, 16),
            row(568, 16)
        ], 297, 14)).toEqual({ rowIndex: 1, boundaryMm: 580 })
    })

    it('fills the first page and uses the larger continuation area without a fixed row limit', () => {
        expect(findOrderItemsSplitIndex(Array.from({ length: 60 }, (_, index) => row(60 + index * 10, 10)), 297, 9))
            .toEqual({ rowIndex: 22, boundaryMm: 288 })
        expect(findOrderItemsSplitIndex(Array.from({ length: 38 }, (_, index) => row(316 + index * 10, 10)), 297, 9))
            .toEqual({ rowIndex: 26, boundaryMm: 585 })
    })

    it('moves the last data row with its totals when the rows fit but the footer does not', () => {
        expect(findOrderItemsSplitIndex([row(250, 10), row(260, 10), row(270, 10)], 297, 9, 300))
            .toEqual({ rowIndex: 2, boundaryMm: 288 })
    })

    it('keeps totals ending exactly at the printable bottom and tolerates sub-pixel rounding', () => {
        const rows = [row(250, 10), row(260, 10)]
        expect(findOrderItemsSplitIndex(rows, 297, 9, 288)).toBeNull()
        expect(findOrderItemsSplitIndex(rows, 297, 9, 288.04)).toBeNull()
        expect(findOrderItemsSplitIndex(rows, 297, 9, 288.06)).toEqual({ rowIndex: 1, boundaryMm: 288 })
    })

    it('ignores invalid footer measurements and never splits the first row away from its totals', () => {
        expect(findOrderItemsSplitIndex([row(250)], 297, 9, 300)).toBeNull()
        expect(findOrderItemsSplitIndex([row(250), row(258)], 297, 9, Number.NaN)).toBeNull()
        expect(findOrderItemsSplitIndex([row(250), row(258)], 297, 9, 200)).toBeNull()
    })
})

describe('planOrderItemsTableHeaderSpacer', () => {
    it('moves a continuation title and its first wrapped row together to the next printable page', () => {
        // The current page ends at 297mm and its printable bottom is 283mm.
        // A table at 270mm whose first row ends at 310mm would otherwise leave
        // its repeated title/header on page 1 and its row on page 2.
        expect(planOrderItemsTableHeaderSpacer(270, 310, 297, 14)).toEqual({ spacerMm: 41 })
    })

    it('does not waste space when the measured header and first row already fit', () => {
        expect(planOrderItemsTableHeaderSpacer(312, 360, 297, 14)).toBeNull()
    })

    it('does not attempt to keep an unavoidably taller-than-page row together', () => {
        expect(planOrderItemsTableHeaderSpacer(270, 560, 297, 14)).toBeNull()
    })
})

describe('order items pagination markers', () => {
    it('exposes the attribute names the template and paginator agree on', () => {
        expect(ORDER_ITEMS_PAGINATED_ATTR).toBe('data-order-items-paginated')
        expect(ORDER_ITEMS_CONTINUATION_ATTR).toBe('data-order-items-continuation')
        expect(ORDER_ITEMS_TABLE_HEADER_SPACER_ATTR).toBe('data-order-items-table-header-spacer')
    })
})

describe('planOrderItemsStatementSpacers', () => {
    const PAGE = 297
    const PADDING = 10

    it('packs every order that fits on a page and moves only the overflow', () => {
        // Content area of page 1 is 10mm..287mm; blocks 1-3 are naturally at
        // 60, 160, 260 (100mm each). The third would end at 360 > 287, so it
        // is pushed to page 2's content top (307mm) with a 47mm spacer.
        const tops = [60, 160, 260]
        const heights = [100, 100, 100]
        expect(planOrderItemsStatementSpacers(tops, heights, PAGE, PADDING)).toEqual([
            { blockIndex: 2, spacerMm: 47 }
        ])
    })

    it('keeps everything on one page when the total fits', () => {
        const tops = [60, 100, 140]
        const heights = [40, 40, 40]
        expect(planOrderItemsStatementSpacers(tops, heights, PAGE, PADDING)).toEqual([])
    })

    it('restarts the running shift so later pages align to exact boundaries', () => {
        // Page 1: 60-160, 160-260 (two orders). Page 2: 604-704 (block 3
        // pushed there with a 47mm spacer, then block 4 pushed with 97mm).
        // Block 5 lands at 704 and fits on page 3 (594-881).
        const tops = [60, 160, 260, 460, 560]
        const heights = [100, 100, 100, 100, 100]
        expect(planOrderItemsStatementSpacers(tops, heights, PAGE, PADDING)).toEqual([
            { blockIndex: 2, spacerMm: 47 },
            { blockIndex: 3, spacerMm: 97 }
        ])
    })

    it('lets an order taller than one page span pages alone', () => {
        // The second block is 400mm tall: it is pushed to page 2 (top 307)
        // and spans into page 3. The third block then starts on page 3.
        const tops = [60, 160, 590]
        const heights = [80, 400, 60]
        expect(planOrderItemsStatementSpacers(tops, heights, PAGE, PADDING)).toEqual([
            { blockIndex: 1, spacerMm: 147 }
        ])
    })

    it('does not split the first block even when it overflows into the next page', () => {
        // The first block runs from 60mm to 300mm, past the page 1 content
        // bottom (287mm). Later blocks are placed by their own page lines.
        const tops = [60, 660]
        const heights = [240, 60]
        expect(planOrderItemsStatementSpacers(tops, heights, PAGE, PADDING)).toEqual([])
    })

    it('returns no placements for invalid inputs', () => {
        expect(planOrderItemsStatementSpacers([], [], PAGE, PADDING)).toEqual([])
        expect(planOrderItemsStatementSpacers([60], [60, 60], PAGE, PADDING)).toEqual([])
        expect(planOrderItemsStatementSpacers([60], [60], 0, PADDING)).toEqual([])
        expect(planOrderItemsStatementSpacers([60], [60], PAGE, Number.NaN)).toEqual([])
    })
})
