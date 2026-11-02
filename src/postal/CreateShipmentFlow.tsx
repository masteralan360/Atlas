import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { QrCode, ScanLine, Link2 } from 'lucide-react'
import {
  SmallDialog,
  SmallDialogBody,
  SmallDialogContent,
  SmallDialogFooter,
  SmallDialogHeader,
  SmallDialogTitle,
  Button,
  useToast,
} from '@/ui/components'
import { CameraBarcodeScannerModal } from '@/ui/components/pos/CameraBarcodeScannerModal'
import { ShipmentForm } from './ShipmentForm'
import { resolvePostalQr, type PostalScope } from '@/local-db/postal'
import type { PostalShipment } from './domain'
import { validateGeneratedPostalQr, postalQrErrorKey } from '@/local-db/postalQrBatches'

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
  const [step, setStep] = useState<'choose' | 'scan' | 'claim' | 'form'>('choose')
  const [source, setSource] = useState<PostalShipment>()
  const scanned = useRef<PostalShipment>()
  const scannedClaim = useRef<string>()
  const [generatedQrId, setGeneratedQrId] = useState<string>()
  return (
    <>
      <SmallDialog
        open={step === 'choose'}
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <SmallDialogContent className="max-w-md">
          <SmallDialogHeader>
            <SmallDialogTitle>
              {t(
                scope.role === 'merchant'
                  ? 'postal.createShipment'
                  : 'postal.createShipmentForOrganization',
              )}
            </SmallDialogTitle>
          </SmallDialogHeader>
          <SmallDialogBody className="grid gap-3">
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
            {scope.role === 'merchant' && <Button className="min-h-14 justify-start" variant="outline" onClick={() => setStep('claim')}>
              <Link2 className="me-3 h-5 w-5" />{t('postal.qr.claim')}
            </Button>}
          </SmallDialogBody>
          <SmallDialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </SmallDialogFooter>
        </SmallDialogContent>
      </SmallDialog>
      {(step === 'scan' || step === 'claim') && (
        <CameraBarcodeScannerModal
          open
          qrMode
          allowImageUpload
          modes={SINGLE}
          title={t(step === 'claim' ? 'postal.qr.claim' : 'postal.readShipmentQr')}
          onScan={async (raw) => {
            try {
              if (step === 'claim') scannedClaim.current = await validateGeneratedPostalQr(scope, raw)
              else scanned.current = await resolvePostalQr(scope, raw)
              return true
            } catch (error) {
              toast({
                title: t('common.error'),
                description: t(step === 'claim' ? `postal.qr.errors.${postalQrErrorKey(error) ?? 'failed'}` : 'postal.errors.qrUnavailable'),
                variant: 'destructive',
              })
              return false
            }
          }}
          onOpenChange={(open) => {
            if (!open) {
              if (step === 'claim' && scannedClaim.current) {
                setGeneratedQrId(scannedClaim.current)
                setStep('form')
              } else if (scanned.current) {
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
          generatedQrId={generatedQrId}
          onClose={onClose}
          onSaved={onSaved}
        />
      )}
    </>
  )
}
