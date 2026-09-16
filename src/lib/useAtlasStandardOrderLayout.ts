import { useLayoutEffect, useRef, useState } from 'react'

import {
    fitAtlasStandardOrderRows,
    getAtlasStandardAvailableTableAreaMm
} from '@/lib/atlasStandardOrderTablePagination'

const REFRESH_EVENT = 'atlas-standard-refresh-layout'
type RowFit = ReturnType<typeof fitAtlasStandardOrderRows>

export function measureAtlasStandardOrderRowFit(page: HTMLElement, rowCount: number, minimumRowHeightMm: number): RowFit | null {
    const table = page.querySelector<HTMLTableElement>('[data-atlas-standard-first-table]')
    const summary = page.querySelector<HTMLElement>('[data-atlas-standard-summary]')
    if (!table || !summary) return null
    const pageRect = page.getBoundingClientRect()
    if (pageRect.width <= 0) return null
    const mmPerPx = 210 / pageRect.width
    const tableRect = table.getBoundingClientRect()
    const heightMm = (element: Element | null) => element ? element.getBoundingClientRect().height * mmPerPx : 0
    const rowHeights = Array.from({ length: rowCount }, () => minimumRowHeightMm)
    page.querySelectorAll<HTMLElement>('[data-atlas-standard-row-index]').forEach((row) => {
        const index = Number(row.dataset.atlasStandardRowIndex)
        if (Number.isInteger(index) && index >= 0 && index < rowCount) rowHeights[index] = Math.max(minimumRowHeightMm, heightMm(row))
    })
    const textRoot = page.closest('[data-template-layout-root]')
    const textBounds = Array.from(textRoot?.querySelectorAll<HTMLElement>('[data-template-custom-text]') || []).map((text) => {
        const rect = text.getBoundingClientRect()
        return { topMm: (rect.top - pageRect.top) * mmPerPx, bottomMm: (rect.bottom - pageRect.top) * mmPerPx }
    })
    const tableGapMm = Math.max(0, (summary.getBoundingClientRect().top - tableRect.bottom) * mmPerPx)
    // The summary padding is our previous fit's unused remainder, not document
    // content. Exclude it so repeated measurements don't alternate between fits.
    const summaryOffsetMm = Math.max(0, Number(summary.dataset?.atlasStandardSummaryOffsetMm) || 0)
    const availableMm = getAtlasStandardAvailableTableAreaMm({
        tableTopMm: (tableRect.top - pageRect.top) * mmPerPx,
        // Retain a small subpixel/border allowance in addition to the existing page margin.
        tableChromeMm: heightMm(table.tHead) + heightMm(table.querySelector('[data-atlas-standard-table-total]')) + tableGapMm + 0.3,
        tailHeightMm: Math.max(0, heightMm(summary) - summaryOffsetMm) + heightMm(page.querySelector('[data-atlas-standard-contacts]')),
        textBounds
    })
    const emptyHeightMm = Math.max(minimumRowHeightMm, heightMm(table.querySelector('[data-order-print-row-type="empty"]')))
    return fitAtlasStandardOrderRows(rowHeights, availableMm, emptyHeightMm)
}

/** Shared by the editor and the mounted PDF template; no preview-only geometry. */
export function useAtlasStandardOrderLayout(enabled: boolean, rowCount: number, minimumRowHeightMm: number) {
    const pageRef = useRef<HTMLDivElement>(null)
    const [fit, setFit] = useState<RowFit | null>(null)

    // Measure each commit, including parent edits to text, contacts, field order and sizing.
    // Only a changed fit schedules another render, so this converges before painting.
    useLayoutEffect(() => {
        const page = pageRef.current
        if (!enabled || !page) return
        let disposed = false
        const measure = () => {
            if (disposed) return
            const next = measureAtlasStandardOrderRowFit(page, rowCount, minimumRowHeightMm)
            if (!next) return
            setFit((current) => current
                && current.firstPageRows === next.firstPageRows
                && current.fillerRows === next.fillerRows
                && Math.abs(current.summaryOffsetMm - next.summaryOffsetMm) < 0.01
                && current.continuationRows.join(',') === next.continuationRows.join(',')
                && current.rowHeightsMm.length === next.rowHeightsMm.length
                && current.rowHeightsMm.every((height, index) => Math.abs(height - next.rowHeightsMm[index]) < 0.01)
                ? current : next)
        }
        measure()
        page.addEventListener(REFRESH_EVENT, measure)
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
        // Observe content, not pagination spacers or the expanding page stack.
        page.querySelectorAll('[data-atlas-standard-first-table], [data-atlas-standard-summary], header, [data-atlas-standard-contacts]')
            .forEach((element) => observer?.observe(element))
        page.closest('[data-template-layout-root]')?.querySelectorAll('[data-template-custom-text]')
            .forEach((element) => observer?.observe(element))
        if (document.fonts?.ready) void document.fonts.ready.then(measure)
        const images = Array.from(page.querySelectorAll('img'))
        images.forEach((image) => image.addEventListener('load', measure))
        return () => {
            disposed = true
            observer?.disconnect()
            page.removeEventListener(REFRESH_EVENT, measure)
            images.forEach((image) => image.removeEventListener('load', measure))
        }
    })

    return { pageRef, fit: enabled && fit?.rowHeightsMm.length === rowCount ? fit : null }
}

/** Fonts/images have settled; flush the same measured fit before PDF pagination/capture. */
export async function settleAtlasStandardOrderLayouts(container: HTMLElement) {
    if (!container.querySelector('[data-atlas-standard-smart-rows="true"]')) return
    for (let pass = 0; pass < 4; pass++) {
        container.querySelectorAll('[data-atlas-standard-smart-rows="true"]').forEach((page) => page.dispatchEvent(new Event(REFRESH_EVENT)))
        await new Promise(requestAnimationFrame)
    }
}
