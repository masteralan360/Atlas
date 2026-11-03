import { useLayoutEffect, useRef, useState } from 'react'

/** Scales a postal label vertically to keep its full content inside the fixed print page. */
export function useFitPostalLabel(pageHeightMm = 100) {
  const labelRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useLayoutEffect(() => {
    const label = labelRef.current
    if (!label) return

    let isActive = true
    const maxHeightPx = Math.max(1, ((pageHeightMm - 1) * 96) / 25.4)
    const updateScale = () => {
      const contentHeightPx = Math.max(label.offsetHeight, label.scrollHeight)
      if (!isActive || contentHeightPx <= 0) return

      const nextScale = Math.min(1, maxHeightPx / contentHeightPx)
      setScale((currentScale) =>
        Math.abs(currentScale - nextScale) < 0.001 ? currentScale : nextScale,
      )
    }

    updateScale()
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateScale)
    resizeObserver?.observe(label)
    if (typeof document !== 'undefined') void document.fonts?.ready.then(updateScale)

    return () => {
      isActive = false
      resizeObserver?.disconnect()
    }
  }, [pageHeightMm])

  return {
    labelRef,
    fitTransform: scale < 1 ? `scaleY(${scale})` : undefined,
  }
}
