import { usePostalAction } from './usePostalAccess'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownLeft, ArrowUpRight, Loader2, Wallet } from 'lucide-react'
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
  summary: {
    collected: number
    settled: number
    deliveryFeeCollected?: number
  }
  kind: 'collection' | 'settlement' | 'delivery_fee'
  onClose: () => void
}) {
  const { t } = useTranslation()
  const feeCollected = Number(summary.deliveryFeeCollected ?? 0)
  const remaining =
    kind === 'delivery_fee'
      ? Number(shipment.delivery_fee ?? 0) - feeCollected
      : kind === 'collection'
        ? shipment.cod_amount - summary.collected
        : summary.collected - summary.settled
  const [digits, setDigits] = useState(String(Math.abs(remaining)))
  const [method, setMethod] = useState<PaymentMethodOption>('cash')
  const [account, setAccount] = useState<PaymentAccount | null>(null)
  const [notes, setNotes] = useState('')
  const action = usePostalAction()
  const amount = signedIqd(digits, remaining < 0)
  const directionSign = amount ?? (remaining < 0 ? -1 : 1)
  const direction: 'incoming' | 'outgoing' =
    kind === 'delivery_fee'
      ? 'incoming'
      : kind === 'settlement'
        ? directionSign < 0
          ? 'incoming'
          : 'outgoing'
        : directionSign < 0
          ? 'outgoing'
          : 'incoming'
  const directionAction =
    kind === 'delivery_fee'
      ? 'deliveryFeeCollectFromRecipient'
      : kind === 'settlement'
        ? direction === 'outgoing'
          ? 'settlementPayMerchant'
          : 'settlementReceiveFromMerchant'
        : direction === 'outgoing'
          ? 'collectionPayRecipient'
          : 'collectionCollectFromRecipient'
  const valid =
    amount !== null &&
    amount !== 0 &&
    Math.abs(amount) <= Math.abs(remaining) &&
    (kind === 'delivery_fee'
      ? amount > 0 && direction === 'incoming'
      : kind !== 'collection' ||
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
            {t(
              kind === 'delivery_fee'
                ? 'postal.deliveryFeeCollection'
                : `postal.${kind}`,
            )}
          </AppDialogTitle>
        </AppDialogHeader>
        <AppDialogBody className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t(
              kind === 'delivery_fee'
                ? 'postal.deliveryFeePaymentHint'
                : kind === 'settlement'
                  ? 'postal.settlementPaymentHint'
                  : 'postal.paymentHint',
            )}
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
          <div
            aria-live="polite"
            className="flex items-start gap-3 rounded-xl border bg-muted/30 p-3"
          >
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${direction === 'outgoing' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}>
              {direction === 'outgoing' ? (
                <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
              ) : (
                <ArrowDownLeft className="h-5 w-5" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              <p className="font-semibold">
                {t(`postal.${directionAction}`)}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t(`postal.${directionAction}Hint`)}
              </p>
            </div>
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
                await postalCommand(
                  scope,
                  kind === 'delivery_fee' ? 'delivery_fee_collection' : kind,
                  payload,
                  id,
                )
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
