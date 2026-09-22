import { useEffect, useState } from 'react'
import { RefreshCw, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './button'
import {
  applyPreparedPwaUpdate,
  getPendingPwaUpdate,
  PWA_UPDATE_READY_EVENT,
  type PendingPwaUpdate,
} from '@/lib/pwaUpdateControl'

export function PwaUpdateReadyBanner() {
  const { t } = useTranslation()
  const [update, setUpdate] = useState<PendingPwaUpdate | null>(() => getPendingPwaUpdate())
  const [isApplying, setIsApplying] = useState(false)
  const [applyFailed, setApplyFailed] = useState(false)

  useEffect(() => {
    const handleUpdateReady = (event: Event) => {
      setUpdate((event as CustomEvent<PendingPwaUpdate>).detail ?? {})
      setApplyFailed(false)
    }
    window.addEventListener(PWA_UPDATE_READY_EVENT, handleUpdateReady)
    return () => window.removeEventListener(PWA_UPDATE_READY_EVENT, handleUpdateReady)
  }, [])

  if (!update) return null

  const handleRestart = async () => {
    setIsApplying(true)
    setApplyFailed(false)
    const applied = await applyPreparedPwaUpdate()
    if (!applied) {
      setIsApplying(false)
      setApplyFailed(true)
    }
  }

  return (
    <section
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 bottom-[calc(0.75rem+var(--safe-area-bottom))] z-[190] mx-auto flex max-w-2xl flex-col gap-3 rounded-2xl border border-primary/25 bg-card/95 p-4 text-card-foreground shadow-2xl backdrop-blur-xl sm:flex-row sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <RefreshCw className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="font-semibold">{t('pwaUpdater.readyTitle')}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('pwaUpdater.readyDescription')}
          </p>
          {update.version && (
            <p className="mt-1 text-xs font-medium text-primary">
              {t('pwaUpdater.readyVersion', { version: update.version })}
            </p>
          )}
          {applyFailed && (
            <p className="mt-1 text-xs text-destructive">{t('pwaUpdater.restartFailed')}</p>
          )}
        </div>
      </div>
      <Button
        type="button"
        allowViewer
        className="shrink-0"
        disabled={isApplying}
        onClick={handleRestart}
      >
        <RotateCw className={isApplying ? 'animate-spin' : ''} aria-hidden="true" />
        {isApplying ? t('pwaUpdater.restarting') : t('pwaUpdater.restartNow')}
      </Button>
    </section>
  )
}
