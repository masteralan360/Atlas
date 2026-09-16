/** Keep references in their product row, with an accurate count for overflow. */
export function formatPrintReferenceList(labels: readonly string[], visibleCount: number, moreLabel: (count: number) => string) {
  const count = Number.isFinite(visibleCount) ? Math.min(labels.length, Math.max(0, Math.floor(visibleCount))) : 0
  const parts = labels.slice(0, count)
  if (count < labels.length) parts.push(moreLabel(labels.length - count))
  return parts.join(' - ')
}

export function findFittingPrintReferenceCount(labels: readonly string[], fits: (text: string) => boolean, moreLabel: (count: number) => string) {
  if (!labels.length || fits(labels.join(' - '))) return labels.length
  let low = 0
  let high = labels.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(formatPrintReferenceList(labels, middle, moreLabel))) low = middle
    else high = middle - 1
  }
  return low
}

/** Run before measuring page breaks, using the same fonts and cell widths as
 * the preview/PDF. Other cell content may provide more room than three lines.
 * The complete list remains in the attribute so repeated layout passes can
 * expand as well as shorten the visible references. */
export function fitPrintReferenceLists(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-print-reference-list]').forEach(element => {
    let labels: string[]
    try { labels = JSON.parse(element.dataset.printReferenceList || '[]') as string[] } catch { return }
    if (!Array.isArray(labels) || !labels.every(label => typeof label === 'string')) return
    const width = element.getBoundingClientRect().width
    if (width <= 0) return
    const style = getComputedStyle(element)
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5
    let availableHeight = lineHeight * 3
    const cell = element.closest('td')
    const row = cell?.closest('tr')
    row?.querySelectorAll(':scope > td').forEach(otherCell => {
      if (otherCell === cell) return
      const range = document.createRange()
      range.selectNodeContents(otherCell)
      availableHeight = Math.max(availableHeight, range.getBoundingClientRect().height)
      range.detach()
    })
    const numberFormat = new Intl.NumberFormat(element.lang || 'en')
    const moreLabel = (count: number) => (element.dataset.printMoreLabel || '{count}')
      .replace('{count}', numberFormat.format(count))
    const probe = element.cloneNode(false) as HTMLElement
    probe.removeAttribute('data-print-reference-list')
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none', width: `${width}px`, left: '0', top: '0' })
    element.appendChild(probe)
    try {
      const count = findFittingPrintReferenceCount(labels, text => {
        probe.textContent = text
        return probe.getBoundingClientRect().height <= availableHeight + 0.5
      }, moreLabel)
      // Remove the measuring node before replacing the visible text.
      probe.remove()
      element.textContent = formatPrintReferenceList(labels, count, moreLabel)
    } finally { probe.remove() }
  })
}
