import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Loader2, RotateCcw } from 'lucide-react'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  useToast,
} from '@/ui/components'
import { setPostalShipmentArchived } from '@/local-db/postal'
import {
  formatPostalShipmentId,
  type PostalShipment,
} from '@/postal/domain'
import type { PostalScope } from '@/local-db/postal'

interface ShipmentArchiveDialogProps {
  scope: PostalScope
  shipment: PostalShipment | null
  isArchive: boolean
  onClose: () => void
}

export function ShipmentArchiveDialog({
  scope,
  shipment,
  isArchive,
  onClose,
}: ShipmentArchiveDialogProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)

  const handleConfirm = async () => {
    if (!shipment || busy) return
    setBusy(true)
    let saved = false
    let errorKey = isArchive ? 'archiveError' : 'unarchiveError'
    try {
      await setPostalShipmentArchived(
        scope,
        shipment.id,
        isArchive,
        crypto.randomUUID(),
      )
      saved = true
    } catch (error) {
      const message =
        error && typeof error === 'object' && 'message' in error
          ? String(error.message)
          : ''
      errorKey = message.includes('archive_not_allowed')
        ? 'notAllowed'
        : message.includes('unavailable')
          ? 'notFound'
          : message.includes('conflict')
            ? 'conflict'
            : errorKey
    } finally {
      setBusy(false)
    }

    if (saved) {
      toast({
        title: t(`postal.archive.${isArchive ? 'archiveSuccess' : 'unarchiveSuccess'}`),
      })
      onClose()
      return
    }
    toast({
      title: t('common.error'),
      description: t(`postal.archive.${errorKey}`),
      variant: 'destructive',
    })
  }

  const actionLabel = t(
    `postal.archive.${isArchive ? 'archiveAction' : 'unarchiveAction'}`,
  )

  return (
    <AppDialog
      open={shipment !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <AppDialogContent className="max-w-md" showCloseButton={!busy}>
        <AppDialogHeader>
          <AppDialogTitle className="flex items-center gap-2">
            {isArchive ? (
              <Archive className="h-5 w-5 text-primary" />
            ) : (
              <RotateCcw className="h-5 w-5 text-primary" />
            )}
            {t(
              `postal.archive.${isArchive ? 'archiveConfirmTitle' : 'unarchiveConfirmTitle'}`,
            )}
          </AppDialogTitle>
        </AppDialogHeader>
        <AppDialogBody>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t(
              `postal.archive.${isArchive ? 'archiveConfirm' : 'unarchiveConfirm'}`,
            )}
          </p>
          {shipment && (
            <div className="mt-4 rounded-lg border bg-muted/30 px-3 py-2 text-sm font-semibold">
              <bdi dir="ltr">{formatPostalShipmentId(shipment)}</bdi>
              <span className="mx-2 text-muted-foreground">·</span>
              {shipment.recipient_name}
            </div>
          )}
        </AppDialogBody>
        <AppDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={busy || !shipment}>
            {busy ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : isArchive ? (
              <Archive className="me-2 h-4 w-4" aria-hidden="true" />
            ) : (
              <RotateCcw className="me-2 h-4 w-4" aria-hidden="true" />
            )}
            {busy
              ? t(`postal.archive.${isArchive ? 'archiving' : 'unarchiving'}`)
              : actionLabel}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}
