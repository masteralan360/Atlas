import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QrCode, ScanLine } from 'lucide-react'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogHeader,
  AppDialogTitle,
  AppDialogFooter,
  Button,
  useToast,
} from '@/ui/components'
import { CameraBarcodeScannerModal } from '@/ui/components/pos/CameraBarcodeScannerModal'
import { ShipmentForm } from './ShipmentForm'
import { resolvePostalQr, type PostalScope } from '@/local-db/postal'
import type { PostalShipment } from './domain'

const SINGLE = ['single'] as const
export function CreateShipmentFlow({
  scope,
  onClose,
  onSaved,
}: {
  scope: PostalScope
  onClose: () => void
  onSaved: (shipment: PostalShipment) => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [step, setStep] = useState<'choose' | 'scan' | 'form'>('choose')
  const [source, setSource] = useState<PostalShipment>()
  const scanned = useRef<PostalShipment>()
  return (
    <>
      <AppDialog
        open={step === 'choose'}
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <AppDialogContent className="max-w-md">
          <AppDialogHeader>
            <AppDialogTitle>{t('postal.createShipment')}</AppDialogTitle>
          </AppDialogHeader>
          <AppDialogBody className="grid gap-3">
            <Button
              className="min-h-14 justify-start"
              onClick={() => setStep('form')}
            >
              <QrCode className="me-3 h-5 w-5" />
              {t('postal.createShipmentQr')}
            </Button>
            <Button
              className="min-h-14 justify-start"
              variant="outline"
              onClick={() => setStep('scan')}
            >
              <ScanLine className="me-3 h-5 w-5" />
              {t('postal.readShipmentQr')}
            </Button>
          </AppDialogBody>
          <AppDialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </AppDialogFooter>
        </AppDialogContent>
      </AppDialog>
      {step === 'scan' && (
        <CameraBarcodeScannerModal
          open
          qrMode
          modes={SINGLE}
          title={t('postal.readShipmentQr')}
          onScan={async (raw) => {
            try {
              scanned.current = await resolvePostalQr(scope, raw)
              return true
            } catch {
              toast({
                title: t('common.error'),
                description: t('postal.errors.qrUnavailable'),
                variant: 'destructive',
              })
              return false
            }
          }}
          onOpenChange={(open) => {
            if (!open) {
              if (scanned.current) {
                setSource(scanned.current)
                setStep('form')
              } else onClose()
            }
          }}
        />
      )}
      {step === 'form' && (
        <ShipmentForm
          scope={scope}
          source={source}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </>
  )
}
