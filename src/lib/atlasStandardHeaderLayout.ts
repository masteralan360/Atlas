export const ATLAS_STANDARD_HEADER_HEIGHT_FIELD_KEY = 'atlasStandardHeaderHeightMm'
export const ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM = 13
export const ATLAS_STANDARD_HEADER_STEP_MM = 0.5
export const ATLAS_STANDARD_PAGE_HEIGHT_MM = 297
export const ATLAS_STANDARD_PAGE_PADDING_MM = 8
export const ATLAS_STANDARD_HEADER_TOP_MM = 8
export const ATLAS_STANDARD_HEADER_ABSOLUTE_MAX_MM = (
    ATLAS_STANDARD_PAGE_HEIGHT_MM
    - ATLAS_STANDARD_PAGE_PADDING_MM
    - ATLAS_STANDARD_HEADER_TOP_MM
)

const EPSILON_MM = 0.05

export type AtlasStandardHeaderRange = {
    requestedHeightMm: number
    effectiveHeightMm: number
    minHeightMm: number
    maxHeightMm: number
    naturalPageCount: number
}

export type AtlasStandardOverlayAnchor = 'header' | 'body' | 'crossing'

function finiteNumber(value: unknown, fallback: number) {
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

function roundMm(value: number) {
    return Number(value.toFixed(3))
}

export function floorAtlasStandardHeaderStep(value: number, step = ATLAS_STANDARD_HEADER_STEP_MM) {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0
    return roundMm(Math.floor((value + 1e-9) / step) * step)
}

export function parseAtlasStandardHeaderHeightMm(value: unknown) {
    return Math.max(
        ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM,
        finiteNumber(value, ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM)
    )
}

export function getAtlasStandardHeaderDeltaMm(value: unknown) {
    return Math.max(
        0,
        parseAtlasStandardHeaderHeightMm(value) - ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM
    )
}

export function classifyAtlasStandardOverlay(
    topMm: number,
    bottomMm: number,
    dividerMm = ATLAS_STANDARD_HEADER_TOP_MM + ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM
): AtlasStandardOverlayAnchor {
    if (topMm >= dividerMm - EPSILON_MM) return 'body'
    if (bottomMm <= dividerMm + EPSILON_MM) return 'header'
    return 'crossing'
}

export function resolveAtlasStandardOverlayDrag({
    visualTopMm,
    heightMm,
    headerHeightMm
}: {
    visualTopMm: number
    heightMm: number
    headerHeightMm: number
}): { anchor: AtlasStandardOverlayAnchor; storedTopMm: number } {
    const safeVisualTopMm = finiteNumber(visualTopMm, 0)
    const safeHeightMm = Math.max(0, finiteNumber(heightMm, 0))
    const effectiveHeaderHeightMm = parseAtlasStandardHeaderHeightMm(headerHeightMm)
    const anchor = classifyAtlasStandardOverlay(
        safeVisualTopMm,
        safeVisualTopMm + safeHeightMm,
        ATLAS_STANDARD_HEADER_TOP_MM + effectiveHeaderHeightMm
    )

    return {
        anchor,
        storedTopMm: anchor === 'body'
            ? safeVisualTopMm - getAtlasStandardHeaderDeltaMm(effectiveHeaderHeightMm)
            : safeVisualTopMm
    }
}

export function getAtlasStandardOverlayPageSnapMm(
    topMm: number,
    bottomMm: number,
    pageHeightMm = ATLAS_STANDARD_PAGE_HEIGHT_MM,
    pagePaddingMm = ATLAS_STANDARD_PAGE_PADDING_MM
) {
    if (![topMm, bottomMm, pageHeightMm, pagePaddingMm].every(Number.isFinite)
        || bottomMm <= topMm
        || pageHeightMm <= 0
        || pagePaddingMm < 0
    ) return 0

    const heightMm = bottomMm - topMm
    const printableHeightMm = pageHeightMm - (pagePaddingMm * 2)
    if (heightMm > printableHeightMm + EPSILON_MM) return 0

    const pageStartMm = Math.floor(topMm / pageHeightMm) * pageHeightMm
    const pageEndMm = pageStartMm + pageHeightMm - pagePaddingMm
    if (bottomMm <= pageEndMm + EPSILON_MM) return 0

    return roundMm(pageStartMm + pageHeightMm + pagePaddingMm - topMm)
}

export function resolveAtlasStandardHeaderRange({
    requestedHeightMm,
    currentHeightMm,
    minHeightMm,
    contentBottomMm,
    headerTopMm = ATLAS_STANDARD_HEADER_TOP_MM,
    pageHeightMm = ATLAS_STANDARD_PAGE_HEIGHT_MM,
    pagePaddingMm = ATLAS_STANDARD_PAGE_PADDING_MM,
    stepMm = ATLAS_STANDARD_HEADER_STEP_MM
}: {
    requestedHeightMm: number
    currentHeightMm: number
    minHeightMm: number
    contentBottomMm: number
    headerTopMm?: number
    pageHeightMm?: number
    pagePaddingMm?: number
    stepMm?: number
}): AtlasStandardHeaderRange {
    const requested = parseAtlasStandardHeaderHeightMm(requestedHeightMm)
    const minimum = Math.max(
        ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM,
        finiteNumber(minHeightMm, ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM)
    )
    const current = Math.max(minimum, finiteNumber(currentHeightMm, minimum))
    const currentBottom = Math.max(0, finiteNumber(contentBottomMm, 0))
    const baselineBottom = Math.max(0, currentBottom - Math.max(0, current - minimum))
    const safePageHeight = Math.max(1, finiteNumber(pageHeightMm, ATLAS_STANDARD_PAGE_HEIGHT_MM))
    const safePadding = Math.max(0, finiteNumber(pagePaddingMm, ATLAS_STANDARD_PAGE_PADDING_MM))
    const naturalPageCount = Math.max(
        1,
        Math.ceil(((baselineBottom + safePadding) - EPSILON_MM) / safePageHeight)
    )
    const contentBoundaryMm = naturalPageCount * safePageHeight - safePadding
    const contentSafeMaximum = minimum + Math.max(0, contentBoundaryMm - baselineBottom)
    const firstPageMaximum = safePageHeight - safePadding - Math.max(0, finiteNumber(headerTopMm, 0))
    const rawMaximum = Math.max(
        minimum,
        Math.min(contentSafeMaximum, firstPageMaximum, ATLAS_STANDARD_HEADER_ABSOLUTE_MAX_MM)
    )
    const maximum = Math.max(minimum, floorAtlasStandardHeaderStep(rawMaximum, stepMm))
    const steppedRequested = floorAtlasStandardHeaderStep(requested, stepMm)
    const effective = Math.min(maximum, Math.max(minimum, steppedRequested))

    return {
        requestedHeightMm: roundMm(requested),
        effectiveHeightMm: roundMm(effective),
        minHeightMm: roundMm(minimum),
        maxHeightMm: roundMm(maximum),
        naturalPageCount
    }
}

function getElementBottomMm(element: Element, rootTopPx: number, pxToMm: number) {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 && rect.height <= 0) return null
    const bottomMm = (rect.bottom - rootTopPx) * pxToMm
    return Number.isFinite(bottomMm) ? bottomMm : null
}

function refreshOverlayAnchors(root: ParentNode, pxToMm: number) {
    root.querySelectorAll<Element>('[data-atlas-standard-overlay-base-top-mm]').forEach((element) => {
        if (element.getAttribute('data-atlas-standard-overlay-anchor-locked') === 'true') return

        const baseTopMm = Number(element.getAttribute('data-atlas-standard-overlay-base-top-mm'))
        const rect = element.getBoundingClientRect()
        if (!Number.isFinite(baseTopMm) || rect.height <= 0) return

        const anchor = classifyAtlasStandardOverlay(baseTopMm, baseTopMm + rect.height * pxToMm)
        element.setAttribute('data-atlas-standard-overlay-anchor', anchor)
        if (element.getAttribute('data-atlas-standard-overlay-can-translate') === 'true') {
            if (anchor === 'body') {
                element.setAttribute('data-atlas-standard-overlay-translation', 'css')
            } else {
                element.removeAttribute('data-atlas-standard-overlay-translation')
                if (element instanceof HTMLElement || element instanceof SVGElement) {
                    element.style.translate = ''
                }
            }
        }
    })
}

function applyOverlayOffset(root: ParentNode, deltaMm: number) {
    root.querySelectorAll<Element>(
        '[data-atlas-standard-overlay-applied-offset-mm]:not([data-atlas-standard-overlay-anchor="body"])'
    ).forEach((element) => {
        element.removeAttribute('data-atlas-standard-overlay-applied-offset-mm')
    })

    root.querySelectorAll<Element>(
        '[data-atlas-standard-overlay-anchor="body"][data-atlas-standard-overlay-translation]'
    ).forEach((element) => {
        element.setAttribute('data-atlas-standard-overlay-applied-offset-mm', String(deltaMm))
        if (element.getAttribute('data-atlas-standard-overlay-translation') === 'svg') {
            element.setAttribute('transform', `translate(0 ${deltaMm})`)
            return
        }

        if (element instanceof HTMLElement || element instanceof SVGElement) {
            element.style.translate = `0 ${deltaMm}mm`
        }
    })
}

/**
 * Measures and clamps the live Atlas Standard header against the document's
 * natural page count. The DOM markers are shared by the editor and PDF renderer,
 * so the red preview boundary and the exported result use the same calculation.
 */
export function applyAtlasStandardHeaderLayout(
    container: HTMLElement,
    options?: { pageWidthMm?: number; pageHeightMm?: number; pagePaddingMm?: number }
): AtlasStandardHeaderRange | null {
    const layoutRoot = typeof container.matches === 'function'
        && container.matches('[data-atlas-standard-layout]')
        ? container
        : typeof container.querySelector === 'function'
            ? container.querySelector<HTMLElement>('[data-atlas-standard-layout]')
            : null
    if (!layoutRoot) return null

    const header = layoutRoot.querySelector<HTMLElement>('[data-atlas-standard-header]')
    const contentEnd = layoutRoot.querySelector<HTMLElement>('[data-atlas-standard-content-end]')
    if (!header || !contentEnd) return null

    const rootRect = layoutRoot.getBoundingClientRect()
    if (rootRect.width <= 0) return null

    const pageWidthMm = Math.max(1, finiteNumber(options?.pageWidthMm, 210))
    const pxToMm = pageWidthMm / rootRect.width
    refreshOverlayAnchors(container, pxToMm)
    const requestedHeightMm = parseAtlasStandardHeaderHeightMm(
        layoutRoot.dataset.atlasStandardHeaderHeightMm || header.dataset.atlasStandardHeaderHeightMm
    )
    applyOverlayOffset(container, requestedHeightMm - ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM)
    const headerRect = header.getBoundingClientRect()
    const headerContent = header.querySelector<HTMLElement>('[data-atlas-standard-header-content]')
    const contentCandidates = headerContent
        ? [
            headerContent,
            ...Array.from(headerContent.querySelectorAll<HTMLElement>('[data-order-print-component]'))
        ]
        : []
    const intrinsicContentBottomMm = contentCandidates.reduce((maximum, element) => {
        const bottomMm = getElementBottomMm(element, headerRect.top, pxToMm)
        return bottomMm === null ? maximum : Math.max(maximum, bottomMm)
    }, ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM)

    let minimumHeightMm = Math.max(
        ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM,
        intrinsicContentBottomMm
    )
    const dividerAtDefaultMm = ATLAS_STANDARD_HEADER_TOP_MM + ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM
    container.querySelectorAll<Element>('[data-atlas-standard-overlay-anchor="crossing"]').forEach((element) => {
        const bottomMm = getElementBottomMm(element, rootRect.top, pxToMm)
        if (bottomMm !== null && bottomMm > dividerAtDefaultMm) {
            minimumHeightMm = Math.max(minimumHeightMm, bottomMm - ATLAS_STANDARD_HEADER_TOP_MM)
        }
    })
    minimumHeightMm = Math.ceil((minimumHeightMm - EPSILON_MM) / ATLAS_STANDARD_HEADER_STEP_MM)
        * ATLAS_STANDARD_HEADER_STEP_MM

    let contentBottomMm = getElementBottomMm(contentEnd, rootRect.top, pxToMm) || 0
    container.querySelectorAll<Element>([
        '[data-atlas-standard-overlay-anchor="body"]',
        '[data-atlas-standard-overlay-anchor="crossing"]'
    ].join(',')).forEach((element) => {
        const bottomMm = getElementBottomMm(element, rootRect.top, pxToMm)
        if (bottomMm !== null) contentBottomMm = Math.max(contentBottomMm, bottomMm)
    })

    const currentHeightMm = headerRect.height * pxToMm
    const headerTopMm = (headerRect.top - rootRect.top) * pxToMm
    const range = resolveAtlasStandardHeaderRange({
        requestedHeightMm,
        currentHeightMm,
        minHeightMm: minimumHeightMm,
        contentBottomMm,
        headerTopMm,
        pageHeightMm: options?.pageHeightMm,
        pagePaddingMm: options?.pagePaddingMm
    })

    header.style.height = `${range.effectiveHeightMm}mm`
    header.style.minHeight = `${range.minHeightMm}mm`
    header.dataset.atlasStandardHeaderHeightMm = String(range.effectiveHeightMm)
    layoutRoot.dataset.atlasStandardHeaderHeightMm = String(range.effectiveHeightMm)
    layoutRoot.dataset.atlasStandardHeaderEffectiveHeightMm = String(range.effectiveHeightMm)
    applyOverlayOffset(container, range.effectiveHeightMm - ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM)

    return range
}

/** Keeps independently positioned body objects intact when the header moves them across an A4 boundary. */
export function snapAtlasStandardBodyOverlaysToPages(
    container: HTMLElement,
    options?: { pageWidthMm?: number; pageHeightMm?: number; pagePaddingMm?: number }
) {
    const layoutRoot = typeof container.matches === 'function'
        && container.matches('[data-atlas-standard-layout]')
        ? container
        : typeof container.querySelector === 'function'
            ? container.querySelector<HTMLElement>('[data-atlas-standard-layout]')
            : null
    if (!layoutRoot) return

    const rootRect = layoutRoot.getBoundingClientRect()
    if (rootRect.width <= 0) return

    const pageWidthMm = Math.max(1, finiteNumber(options?.pageWidthMm, 210))
    const pageHeightMm = Math.max(1, finiteNumber(options?.pageHeightMm, ATLAS_STANDARD_PAGE_HEIGHT_MM))
    const pagePaddingMm = Math.max(0, finiteNumber(options?.pagePaddingMm, ATLAS_STANDARD_PAGE_PADDING_MM))
    const pxToMm = pageWidthMm / rootRect.width
    const headerHeightMm = parseAtlasStandardHeaderHeightMm(
        layoutRoot.dataset.atlasStandardHeaderEffectiveHeightMm
        || layoutRoot.dataset.atlasStandardHeaderHeightMm
    )
    const headerDeltaMm = headerHeightMm - ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM

    container.querySelectorAll<Element>(
        '[data-atlas-standard-overlay-anchor="body"][data-atlas-standard-overlay-translation]'
    ).forEach((element) => {
        const usesSvgTranslation = element.getAttribute('data-atlas-standard-overlay-translation') === 'svg'
        if (usesSvgTranslation) {
            element.setAttribute('transform', `translate(0 ${headerDeltaMm})`)
        } else if (element instanceof HTMLElement || element instanceof SVGElement) {
            element.style.translate = `0 ${headerDeltaMm}mm`
        }

        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 && rect.height <= 0) return

        const topMm = (rect.top - rootRect.top) * pxToMm
        const bottomMm = (rect.bottom - rootRect.top) * pxToMm
        const snapMm = getAtlasStandardOverlayPageSnapMm(
            topMm,
            bottomMm,
            pageHeightMm,
            pagePaddingMm
        )
        const totalOffsetMm = headerDeltaMm + snapMm
        element.setAttribute('data-atlas-standard-overlay-applied-offset-mm', String(totalOffsetMm))

        if (usesSvgTranslation) {
            element.setAttribute('transform', `translate(0 ${totalOffsetMm})`)
        } else if (element instanceof HTMLElement || element instanceof SVGElement) {
            element.style.translate = `0 ${totalOffsetMm}mm`
        }
    })
}

export const ATLAS_STANDARD_HEADER_PREVIEW_FIELD = {
    key: ATLAS_STANDARD_HEADER_HEIGHT_FIELD_KEY,
    label: 'printPreviewEditor.atlasStandardHeaderHeight',
    value: String(ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM),
    type: 'range' as const,
    min: ATLAS_STANDARD_DEFAULT_HEADER_HEIGHT_MM,
    max: ATLAS_STANDARD_HEADER_ABSOLUTE_MAX_MM,
    step: ATLAS_STANDARD_HEADER_STEP_MM,
    unit: ' mm',
    dynamicRange: 'atlasStandardHeaderHeight' as const
}
