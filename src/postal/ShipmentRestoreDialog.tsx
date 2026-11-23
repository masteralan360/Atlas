import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RotateCcw } from 'lucide-react'
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
import { restorePostalShipmentToDraft } from '@/local-db/postal'
import type { PostalScope } from '@/local-db/postal'
import { formatPostalShipmentId, type PostalShipment } from './domain'

export function ShipmentRestoreDialog({
  scope,
  shipment,
  onClose,
}: {
  scope: PostalScope
  shipment: PostalShipment | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const pendingRequest = useRef<{ signature: string; id: string }>()

  const handleConfirm = async () => {
    if (!shipment || shipment.state !== 'cancelled' || lock.current) return
    lock.current = true
    setBusy(true)
    const signature = `${scope.workspaceId}:${scope.userId}:${shipment.id}:${shipment.revision}`
    if (pendingRequest.current?.signature !== signature) {
      pendingRequest.current = { signature, id: crypto.randomUUID() }
    }
    const requestId = pendingRequest.current.id
    let errorKey = 'failed'
    let saved = false
    try {
      await restorePostalShipmentToDraft(
        scope,
        shipment.id,
        shipment.revision,
        requestId,
      )
      pendingRequest.current = undefined
      saved = true
    } catch (error) {
      const message =
        error && typeof error === 'object' && 'message' in error
          ? String(error.message)
          : ''
      errorKey = message.includes('stale_shipment') || message.includes('conflict')
        ? 'conflict'
        : message.includes('invalid_transition')
          ? 'notAllowed'
          : message.includes('restore_has_financial_activity')
            ? 'financialActivity'
            : message.includes('unavailable')
              ? 'notFound'
              : 'failed'
    } finally {
      lock.current = false
      setBusy(false)
    }

    if (saved) {
      toast({ title: t('postal.restoreDraft.success') })
      onClose()
      return
    }
    toast({
      title: t('common.error'),
      description: t(`postal.restoreDraft.${errorKey}`),
      variant: 'destructive',
    })
  }

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
            <RotateCcw className="h-5 w-5 text-primary" aria-hidden="true" />
            {t('postal.restoreDraft.title')}
          </AppDialogTitle>
        </AppDialogHeader>
        <AppDialogBody>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('postal.restoreDraft.description')}
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
          <Button
            onClick={() => void handleConfirm()}
            disabled={busy || !shipment || shipment.state !== 'cancelled'}
          >
            {busy ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="me-2 h-4 w-4" aria-hidden="true" />
            )}
            {busy ? t('postal.restoreDraft.restoring') : t('postal.restoreDraft.action')}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}
