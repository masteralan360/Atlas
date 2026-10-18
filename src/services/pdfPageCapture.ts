/**
 * html-to-image recursively copies computed styles and embeds images, including
 * content outside the requested canvas. Temporarily empty off-page table chunks
 * while preserving their measured boxes so later pages keep their positions.
 * This operates on the disposable PDF render tree, never the preview editor.
 */
export function alignPdfPageChunksToPageBoundaries(
    container: HTMLElement,
    options: { pageHeightMm: number; pageWidthMm: number }
) {
    const spacerSelector = '[data-pdf-page-chunk-spacer]'
    container.querySelectorAll(spacerSelector).forEach((spacer) => spacer.remove())

    const containerRect = container.getBoundingClientRect()
    if (containerRect.width <= 0 || options.pageHeightMm <= 0 || options.pageWidthMm <= 0) return

    const pxToMm = options.pageWidthMm / containerRect.width
    const epsilonMm = 0.05

    for (const chunk of container.querySelectorAll<HTMLElement>('table[data-pdf-page-chunk]')) {
        const rect = chunk.getBoundingClientRect()
        const topMm = (rect.top - containerRect.top) * pxToMm
        const bottomMm = (rect.bottom - containerRect.top) * pxToMm
        const pageStartMm = Math.floor(Math.max(0, topMm) / options.pageHeightMm) * options.pageHeightMm
        const pageEndMm = pageStartMm + options.pageHeightMm
        const heightMm = bottomMm - topMm
        const crossesPageBoundary = topMm > pageStartMm + epsilonMm
            && topMm < pageEndMm - epsilonMm
            && bottomMm > pageEndMm + epsilonMm
            && heightMm <= options.pageHeightMm + epsilonMm

        if (!crossesPageBoundary) continue

        const spacerMm = pageEndMm - topMm
        if (spacerMm <= epsilonMm) continue

        const spacer = document.createElement('div')
        spacer.setAttribute('data-pdf-page-chunk-spacer', '')
        spacer.style.height = `${spacerMm}mm`
        chunk.insertAdjacentElement('beforebegin', spacer)
    }
}

export function preparePdfPageCapture(container: HTMLElement) {
    const origin = container.getBoundingClientRect().top
    const chunks = Array.from(container.querySelectorAll<HTMLElement>(
        'table[data-pdf-page-chunk], [data-pdf-repeated-watermark-layer]'
    )).filter((element) => !element.parentElement?.closest(
        'table[data-pdf-page-chunk], [data-pdf-repeated-watermark-layer]'
    ) && !element.querySelector('style, defs')).map((element) => {
        const rect = element.getBoundingClientRect()
        // Include overflowing descendants, such as positioned images, rather
        // than assuming that everything paints inside its enclosing table.
        let top = rect.top
        let bottom = rect.bottom
        element.querySelectorAll('*').forEach((child) => {
            const bounds = child.getBoundingClientRect()
            if (bounds.width > 0 || bounds.height > 0) {
                top = Math.min(top, bounds.top)
                bottom = Math.max(bottom, bounds.bottom)
            }
        })
        const style = getComputedStyle(element)
        return { element, top: top - origin, bottom: bottom - origin,
            width: style.width, height: style.height }
    })

    return (offsetPx: number, heightPx: number) => {
        const restorations: Array<() => void> = []
        for (const chunk of chunks) {
            // Keep boundary-adjacent borders/shadows and all crossing chunks.
            if (chunk.bottom >= offsetPx - 16 && chunk.top <= offsetPx + heightPx + 16) continue
            const { element } = chunk
            const originalStyle = element.getAttribute('style')
            const children = container.ownerDocument.createDocumentFragment()
            while (element.firstChild) children.appendChild(element.firstChild)
            element.style.setProperty('width', chunk.width, 'important')
            element.style.setProperty('height', chunk.height, 'important')
            restorations.push(() => {
                if (originalStyle === null) element.removeAttribute('style')
                else element.setAttribute('style', originalStyle)
                element.appendChild(children)
            })
        }
        return () => restorations.forEach((restore) => restore())
    }
}
