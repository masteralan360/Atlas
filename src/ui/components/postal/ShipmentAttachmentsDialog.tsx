import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Expand, Image as ImageIcon, Images, Loader2, RefreshCw } from 'lucide-react'
import { r2Service } from '@/services/r2Service'
import { fetchPostalShipmentAttachments, type PostalShipmentAttachment } from '@/local-db/postalAttachments'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
} from '@/ui/components'

interface LoadedShipmentAttachment extends PostalShipmentAttachment {
  previewUrl: string | null
}

export function ShipmentAttachmentsDialog({
  open,
  onOpenChange,
  workspaceId,
  shipmentId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  shipmentId: string
}) {
  const { t } = useTranslation()
  const [attachments, setAttachments] = useState<LoadedShipmentAttachment[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<LoadedShipmentAttachment | null>(null)

  useEffect(() => {
    if (!open || !workspaceId || !shipmentId) {
      setAttachments([])
      setIsLoading(false)
      setHasError(false)
      setSelected(null)
      return
    }

    let cancelled = false
    const objectUrls = new Set<string>()
    setIsLoading(true)
    setHasError(false)
    setAttachments([])
    setSelected(null)

    void (async () => {
      try {
        const metadata = await fetchPostalShipmentAttachments(workspaceId, shipmentId)
        const loaded = await Promise.all(metadata.map(async (attachment) => {
          try {
            const bytes = await r2Service.download(attachment.object_key)
            if (!bytes) throw new Error('postal_attachment_unavailable')
            const previewUrl = URL.createObjectURL(
              new Blob([bytes], { type: attachment.content_type }),
            )
            objectUrls.add(previewUrl)
            return { ...attachment, previewUrl }
          } catch {
            return { ...attachment, previewUrl: null }
          }
        }))
        if (cancelled) {
          for (const url of objectUrls) URL.revokeObjectURL(url)
          return
        }
        setAttachments(loaded)
        setHasError(loaded.some((item) => item.previewUrl === null))
      } catch {
        if (!cancelled) setHasError(true)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()

    return () => {
      cancelled = true
      for (const url of objectUrls) URL.revokeObjectURL(url)
    }
  }, [open, retry, shipmentId, workspaceId])

  const closePreview = (nextOpen: boolean) => {
    if (!nextOpen) setSelected(null)
  }

  return (
    <>
      <AppDialog open={open} onOpenChange={onOpenChange}>
        <AppDialogContent className="max-w-5xl">
          <AppDialogHeader>
            <AppDialogTitle className="flex items-center gap-2">
              <Images className="h-5 w-5 text-primary" aria-hidden="true" />
              {t('postal.attachments.dialogTitle')}
            </AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody className="space-y-4">
            {isLoading ? (
              <div role="status" className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                {t('postal.attachments.loading')}
              </div>
            ) : hasError && attachments.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
                <ImageIcon className="h-8 w-8 text-destructive" aria-hidden="true" />
                <p className="text-sm text-destructive" role="alert">{t('postal.attachments.loadFailed')}</p>
                <Button variant="outline" className="gap-2" onClick={() => setRetry((value) => value + 1)}>
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  {t('postal.retry')}
                </Button>
              </div>
            ) : attachments.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                <Images className="h-8 w-8" aria-hidden="true" />
                <p className="text-sm">{t('postal.attachments.empty')}</p>
              </div>
            ) : (
              <>
                {hasError && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                    <span>{t('postal.attachments.someImagesFailed')}</span>
                    <Button variant="outline" size="sm" className="gap-2" onClick={() => setRetry((value) => value + 1)}>
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                      {t('postal.retry')}
                    </Button>
                  </div>
                )}
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label={t('postal.attachments.gallery')}>
                  {attachments.map((attachment, index) => (
                    <li key={attachment.id}>
                      {attachment.previewUrl ? (
                        <button
                          type="button"
                          className="group relative block aspect-square w-full overflow-hidden rounded-xl border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                          onClick={() => setSelected(attachment)}
                          aria-label={t('postal.attachments.openPreview', { count: index + 1 })}
                        >
                          <img
                            src={attachment.previewUrl}
                            alt={t('postal.attachments.photoAlt', { count: index + 1 })}
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
                          />
                          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-black/60 px-2 py-2 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                            <Expand className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('postal.attachments.enlarge')}
                          </span>
                        </button>
                      ) : (
                        <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-center text-sm text-destructive" role="img" aria-label={t('postal.attachments.imageUnavailable')}>
                          <ImageIcon className="h-6 w-6" aria-hidden="true" />
                          {t('postal.attachments.imageUnavailable')}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.close')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>

      <AppDialog open={selected !== null} onOpenChange={closePreview}>
        <AppDialogContent className="max-w-6xl">
          <AppDialogHeader>
            <AppDialogTitle>{t('postal.attachments.previewTitle')}</AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody className="flex min-h-0 items-center justify-center">
            {selected?.previewUrl && (
              <img
                src={selected.previewUrl}
                alt={t('postal.attachments.previewTitle')}
                className="max-h-[70dvh] w-full rounded-lg object-contain"
              />
            )}
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>
              {t('common.close')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>
    </>
  )
}
