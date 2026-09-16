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
  const measurements: {
    element: HTMLElement; probe: HTMLElement; labels: string[]; availableHeight: number
    moreLabel: (count: number) => string; low: number; high: number; middle: number
  }[] = []
  // Read every row before adding probes. Interleaving a probe/text mutation
  // with the next row's bounds forced layout of the complete statement.
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
    measurements.push({ element, probe, labels, availableHeight, moreLabel,
      low: 0, high: labels.length - 1, middle: 0 })
  })
  try {
    measurements.forEach(({ element, probe, labels }) => {
      probe.textContent = labels.join(' - ')
      element.appendChild(probe)
    })
    measurements.forEach(measurement => {
      if (!measurement.labels.length || measurement.probe.getBoundingClientRect().height <= measurement.availableHeight + 0.5) {
        measurement.low = measurement.high = measurement.labels.length
      }
    })
    // Each binary-search round writes all candidates, then reads all heights.
    // Thus the browser lays out once per round instead of once per product.
    for (;;) {
      const pending = measurements.filter(({ low, high }) => low < high)
      if (!pending.length) break
      pending.forEach(measurement => {
        measurement.middle = Math.ceil((measurement.low + measurement.high) / 2)
        measurement.probe.textContent = formatPrintReferenceList(
          measurement.labels, measurement.middle, measurement.moreLabel
        )
      })
      pending.forEach(measurement => {
        if (measurement.probe.getBoundingClientRect().height <= measurement.availableHeight + 0.5) measurement.low = measurement.middle
        else measurement.high = measurement.middle - 1
      })
    }
    measurements.forEach(({ element, probe, labels, low, moreLabel }) => {
      probe.remove()
      element.textContent = formatPrintReferenceList(labels, low, moreLabel)
    })
  } finally {
    measurements.forEach(({ probe }) => probe.remove())
  }
}
