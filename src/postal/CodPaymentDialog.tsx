import { usePostalAction } from './usePostalAccess'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Wallet } from 'lucide-react'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Input,
  Label,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/components'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import { PaymentMethodSelector } from '@/ui/components/PaymentMethodSelector'
import type { PaymentMethodOption } from '@/lib/paymentMethods'
import type { PaymentAccount } from '@/local-db/models'
import { postalCommand, type PostalScope } from '@/local-db/postal'
import { signedIqd, type PostalShipment } from './domain'

const methods = [
  'cash',
  'fib',
  'qicard',
  'zaincash',
  'fastpay',
  'bank_transfer',
] as const
export function CodPaymentDialog({
  scope,
  shipment,
  summary,
  kind,
  onClose,
}: {
  scope: PostalScope
  shipment: PostalShipment
  summary: { collected: number; settled: number }
  kind: 'collection' | 'settlement'
  onClose: () => void
}) {
  const { t } = useTranslation()
  const remaining =
    kind === 'collection'
      ? shipment.cod_amount - summary.collected
      : summary.collected - summary.settled
  const [digits, setDigits] = useState(String(Math.abs(remaining)))
  const [direction, setDirection] = useState('')
  const [method, setMethod] = useState<PaymentMethodOption>('cash')
  const [account, setAccount] = useState<PaymentAccount | null>(null)
  const [notes, setNotes] = useState('')
  const action = usePostalAction()
  const amount = signedIqd(digits, remaining < 0)
  const valid =
    amount !== null &&
    amount !== 0 &&
    Math.abs(amount) <= Math.abs(remaining) &&
    !!direction &&
    (kind !== 'collection' ||
      direction === (amount < 0 ? 'outgoing' : 'incoming'))
  const payload = {
    id: shipment.id,
    revision: shipment.revision,
    signed_amount: amount,
    direction,
    payment_method: method,
    account_id: account?.id,
    account_name_snapshot: account?.name,
    notes: notes.trim(),
  }
  return (
    <AppDialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) onClose()
      }}
    >
      <AppDialogContent className="max-w-xl" showCloseButton={!action.busy}>
        <AppDialogHeader>
          <AppDialogTitle className="flex gap-2">
            <Wallet className="h-5 w-5" />
            {t(`postal.${kind}`)}
          </AppDialogTitle>
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('postal.paymentHint')}
          </p>
          <p className="font-semibold">
            {t('postal.remaining')}: {remaining.toLocaleString()}{' '}
            {t('postal.iqd')}
          </p>
          <div className="space-y-2">
            <Label htmlFor="postal-payment-amount">
              {t('postal.paymentAmount')} *
            </Label>
            <Input
              id="postal-payment-amount"
              placeholder="0"
              inputMode="numeric"
              dir="ltr"
              disabled={action.busy}
              value={digits ? Number(digits).toLocaleString('en-US') : ''}
              onChange={(e) => {
                const value = e.target.value.replace(/,/g, '')
                if (/^\d{0,12}$/.test(value)) setDigits(value)
              }}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('postal.cashDirection')} *</Label>
            <Select
              value={direction}
              onValueChange={setDirection}
              disabled={action.busy}
            >
              <SelectTrigger>
                <SelectValue placeholder={t('postal.select')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="incoming">{t('postal.incoming')}</SelectItem>
                <SelectItem value="outgoing">{t('postal.outgoing')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t('postal.paymentMethod')} *</Label>
            <PaymentMethodSelector
              value={method}
              methods={methods}
              disabled={action.busy}
              onValueChange={setMethod}
            />
          </div>
          <PaymentAccountSelector
            balanceCurrency="iqd"
            workspaceId={scope.workspaceId}
            value={account?.id ?? null}
            disabled={action.busy}
            onValueChange={setAccount}
          />
          <Label htmlFor="postal-payment-notes">{t('postal.notes')}</Label>
          <Textarea
            id="postal-payment-notes"
            maxLength={2000}
            value={notes}
            disabled={action.busy}
            onChange={(e) => setNotes(e.target.value)}
          />
        </AppDialogBody>
        <AppDialogFooter>
          <Button variant="outline" disabled={action.busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={action.busy || !valid}
            onClick={() =>
              void action.run(kind + JSON.stringify(payload), async (id) => {
                await postalCommand(scope, kind, payload, id)
                onClose()
              })
            }
          >
            {action.busy && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t('postal.recordPayment')}
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </AppDialog>
  )
}
