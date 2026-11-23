import { useEffect, useMemo, useRef, useState } from 'react'
import { Package } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { r2Service } from '@/services/r2Service'
import { cn } from '@/lib/utils'
import type { PostalShipmentAttachment } from '@/local-db/postalAttachments'
import { ShipmentAttachmentsDialog } from './ShipmentAttachmentsDialog'

export function ShipmentAttachmentMosaic({
  workspaceId,
  shipmentId,
  attachments,
}: {
  workspaceId: string
  shipmentId: string
  attachments: PostalShipmentAttachment[]
}) {
  const { t } = useTranslation()
  const mosaicItems = useMemo(() => attachments.slice(0, 4), [attachments])
  const attachmentKey = mosaicItems.map((item) => item.object_key).join('|')
  const containerRef = useRef<HTMLButtonElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({})
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    if (!attachmentKey) return
    const target = containerRef.current
    if (!target) return
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true)
        observer.disconnect()
      }
    }, { rootMargin: '120px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [attachmentKey])

  useEffect(() => {
    if (!nearViewport || !attachmentKey) {
      setImageUrls({})
      return
    }

    let cancelled = false
    const objectUrls: string[] = []
    setImageUrls({})
    void Promise.all(mosaicItems.map(async (attachment) => {
      try {
        const bytes = await r2Service.download(attachment.object_key)
        if (!bytes) throw new Error('postal_attachment_unavailable')
        const url = URL.createObjectURL(new Blob([bytes], { type: attachment.content_type }))
        objectUrls.push(url)
        return [attachment.id, url] as const
      } catch {
        return [attachment.id, null] as const
      }
    })).then((results) => {
      if (cancelled) {
        for (const url of objectUrls) URL.revokeObjectURL(url)
        return
      }
      setImageUrls(Object.fromEntries(
        results.filter((result): result is readonly [string, string] => result[1] !== null),
      ))
    })

    return () => {
      cancelled = true
      for (const url of objectUrls) URL.revokeObjectURL(url)
    }
  }, [attachmentKey, mosaicItems, nearViewport, shipmentId, workspaceId])

  if (mosaicItems.length === 0) return null
  const layoutClass = mosaicItems.length === 1
    ? 'grid-cols-1 grid-rows-1'
    : mosaicItems.length === 2
      ? 'grid-cols-2 grid-rows-1'
      : 'grid-cols-2 grid-rows-2'
  const label = t('postal.attachments.mosaicButtonLabel', { count: attachments.length })

  return (
    <>
      <button
        ref={containerRef}
        type="button"
        className={cn(
          'grid h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/40 p-0 transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          layoutClass,
        )}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => setDialogOpen(true)}
      >
        {mosaicItems.map((attachment, index) => {
          const imageUrl = imageUrls[attachment.id]
          const hasStartDivider = mosaicItems.length === 2
            ? index === 1
            : mosaicItems.length === 3
              ? index > 0
              : index === 1 || index === 3
          const hasTopDivider = mosaicItems.length > 2 && index >= 2

          return (
            <span
              key={attachment.id}
              className={cn(
                'relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-muted',
                mosaicItems.length === 3 && index === 0 && 'row-span-2',
                hasStartDivider && 'border-s border-border',
                hasTopDivider && 'border-t border-border',
              )}
            >
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt={t('postal.attachments.photoAlt', { count: index + 1 })}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : (
                <Package className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              )}
            </span>
          )
        })}
      </button>
      <ShipmentAttachmentsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspaceId={workspaceId}
        shipmentId={shipmentId}
      />
    </>
  )
}
