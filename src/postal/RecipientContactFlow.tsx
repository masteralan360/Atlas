import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Phone } from 'lucide-react'
import { Button } from '@/ui/components/button'
import {
  SmallDialog,
  SmallDialogContent,
  SmallDialogBody,
  SmallDialogHeader,
  SmallDialogTitle,
} from '@/ui/components/small-dialog'
import { internationalIraqiPhone } from './domain'

export function RecipientContactFlow({
  primary,
  backup,
  onClose,
}: {
  primary: string
  backup: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [phone, setPhone] = useState('')
  const normalized = internationalIraqiPhone(phone)
  return (
    <>
      <SmallDialog
        open={!phone}
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <SmallDialogContent>
          <SmallDialogHeader>
            <SmallDialogTitle>{t('postal.selectPhone')}</SmallDialogTitle>
          </SmallDialogHeader>
          <SmallDialogBody className="grid gap-3">
            {[
              { key: 'primary_phone', value: primary },
              { key: 'backup_phone', value: backup },
            ].map(({ key, value }) => (
              <Button
                key={key}
                variant="outline"
                className="h-auto flex-wrap justify-between gap-2 p-3"
                onClick={() => setPhone(value)}
              >
                <span>{t(`postal.${key}`)}</span>
                <span dir="ltr">{value}</span>
              </Button>
            ))}
          </SmallDialogBody>
        </SmallDialogContent>
      </SmallDialog>
      <SmallDialog
        open={!!phone}
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <SmallDialogContent>
          <SmallDialogHeader>
            <SmallDialogTitle>{t('postal.contactMethod')}</SmallDialogTitle>
          </SmallDialogHeader>
          <SmallDialogBody className="grid gap-3">
            <Button asChild disabled={!normalized}>
              <a
                href={normalized ? `tel:+${normalized}` : undefined}
                onClick={onClose}
              >
                <Phone className="me-2 h-4 w-4" />
                {t('postal.call')}
              </a>
            </Button>
            <Button asChild variant="outline" disabled={!normalized}>
              <a
                href={normalized ? `https://wa.me/${normalized}` : undefined}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onClose}
              >
                {t('postal.whatsapp')}
              </a>
            </Button>
          </SmallDialogBody>
        </SmallDialogContent>
      </SmallDialog>
    </>
  )
}
