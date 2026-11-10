import { useLayoutEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ModuleMaintenanceOverlayProps {
  containerRef: RefObject<HTMLElement | null>
  moduleName: string
}

interface OverlayBounds {
  top: number
  left: number
  width: number
  height: number
}

export function ModuleMaintenanceOverlay({ containerRef, moduleName }: ModuleMaintenanceOverlayProps) {
  const { t } = useTranslation()
  const [bounds, setBounds] = useState<OverlayBounds | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const wasInert = container.inert
    container.inert = true

    const updateBounds = () => {
      const rect = container.getBoundingClientRect()
      setBounds({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }

    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    observer.observe(container)
    window.addEventListener('resize', updateBounds)
    window.visualViewport?.addEventListener('resize', updateBounds)
    window.visualViewport?.addEventListener('scroll', updateBounds)

    return () => {
      container.inert = wasInert
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
      window.visualViewport?.removeEventListener('resize', updateBounds)
      window.visualViewport?.removeEventListener('scroll', updateBounds)
    }
  }, [containerRef])

  if (!bounds || typeof document === 'undefined') return null

  return createPortal(
    <section
      className="fixed z-40 flex items-center justify-center overflow-y-auto bg-background p-4"
      style={bounds}
      role="status"
      aria-labelledby="module-maintenance-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-primary/20 bg-card p-6 text-center shadow-2xl sm:p-8">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Wrench className="h-8 w-8" aria-hidden="true" />
        </div>
        <h2 id="module-maintenance-title" className="mt-5 text-xl font-bold tracking-tight">
          {t('moduleMaintenance.title', { module: moduleName })}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t('moduleMaintenance.description')}
        </p>
      </div>
    </section>,
    document.body
  )
}
