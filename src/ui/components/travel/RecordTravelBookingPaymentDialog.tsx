import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { CreditCard, WalletCards } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { STANDARD_PAYMENT_METHODS } from '@/lib/paymentMethods'
import { formatCurrency, formatNumericInput, parseFormattedNumber, sanitizeNumericInput } from '@/lib/utils'
import {
    recordTravelBookingPayment,
    type PaymentAccount,
    type TravelBooking,
    type WorkspacePaymentMethod
} from '@/local-db'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { Input } from '@/ui/components/input'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Label,
  Textarea,
  useToast,
} from '@/ui/components'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import { PaymentMethodSelect } from '@/ui/components/payments/PaymentMethodSelect'

interface RecordTravelBookingPaymentDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    booking: TravelBooking | null
}

export function RecordTravelBookingPaymentDialog({
    open,
    onOpenChange,
    booking
}: RecordTravelBookingPaymentDialogProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const [isSaving, setIsSaving] = useState(false)
    const [amount, setAmount] = useState('')
    const [paymentMethod, setPaymentMethod] = useState<WorkspacePaymentMethod>('cash')
    const [paymentAccount, setPaymentAccount] = useState<PaymentAccount | null>(null)
    const [note, setNote] = useState('')

    const outstandingProfit = booking?.outstandingProfitAmount ?? 0
    const parsedAmount = useMemo(() => parseFormattedNumber(amount || '0'), [amount])
    const canSubmit = !!booking
        && parsedAmount > 0
        && parsedAmount <= outstandingProfit + 0.0001
        && !isSaving

    useEffect(() => {
        if (!open || !booking) return

        setIsSaving(false)
        setAmount(String(outstandingProfit))
        setPaymentMethod('cash')
        setPaymentAccount(null)
        setNote('')
    }, [booking, open, outstandingProfit])

    const requestClose = (nextOpen: boolean) => {
        if (!isSaving) onOpenChange(nextOpen)
    }

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!booking || !canSubmit) return

        setIsSaving(true)
        try {
            await recordTravelBookingPayment(booking.workspaceId, {
                bookingId: booking.id,
                amount: parsedAmount,
                paymentMethod,
                note: note.trim() || null,
                createdBy: user?.id ?? null,
                accountId: paymentAccount?.id ?? null,
                accountNameSnapshot: paymentAccount?.name ?? null
            })
            toast({
                title: t('common.success'),
                description: t('travelTransportation.paymentRecorded')
            })
            onOpenChange(false)
        } catch (error: unknown) {
            toast({
                title: t('common.error'),
                description: error instanceof Error ? error.message : t('travelTransportation.errors.paymentFailed'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <AppDialog open={open} onOpenChange={requestClose}>
            <AppDialogContent
                className="max-w-lg"
                showCloseButton={!isSaving}
                onEscapeKeyDown={(event) => {
                    if (isSaving) event.preventDefault()
                }}
                onPointerDownOutside={(event) => {
                    if (isSaving) event.preventDefault()
                }}
            >
                <AppDialogHeader>
                    <AppDialogTitle className="flex items-center gap-2">
                        <CreditCard className="h-5 w-5 text-primary" />
                        {t('travelTransportation.payment.title')}
                    </AppDialogTitle>
                    <AppDialogDescription>
                        {booking ? t('travelTransportation.payment.description', { bookingNumber: booking.bookingNumber }) : ''}
                    </AppDialogDescription>
                </AppDialogHeader>

                <form onSubmit={handleSubmit} className="contents">
                    <AppDialogBody className="space-y-5">
                        <div className="rounded-2xl border bg-muted/30 p-4">
                            <p className="text-sm text-muted-foreground">{t('travelTransportation.outstandingProfit')}</p>
                            <p className="mt-1 text-2xl font-bold">
                                {booking ? formatCurrency(outstandingProfit, booking.currency, features.iqd_display_preference) : '-'}
                            </p>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="travel-booking-payment-amount">{t('travelTransportation.payment.amount')} *</Label>
                            <Input
                                id="travel-booking-payment-amount"
                                value={formatNumericInput(amount)}
                                inputMode={booking?.currency === 'iqd' ? 'numeric' : 'decimal'}
                                placeholder="0"
                                disabled={isSaving}
                                onChange={(event) => setAmount(sanitizeNumericInput(event.target.value, {
                                    allowDecimal: booking?.currency !== 'iqd'
                                }))}
                            />
                            {booking ? (
                                <p className="text-xs text-muted-foreground">
                                    {t('travelTransportation.payment.maximum', {
                                        amount: formatCurrency(outstandingProfit, booking.currency, features.iqd_display_preference)
                                    })}
                                </p>
                            ) : null}
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="travel-booking-payment-method" className="flex items-center gap-2">
                                <WalletCards className="h-4 w-4 text-muted-foreground" />
                                {t('travelTransportation.payment.method')} *
                            </Label>
                            <PaymentMethodSelect
                                id="travel-booking-payment-method"
                                value={paymentMethod}
                                onValueChange={(value) => setPaymentMethod(value as WorkspacePaymentMethod)}
                                onLinkedPaymentAccountSelect={setPaymentAccount}
                                workspaceId={booking?.workspaceId}
                                methods={STANDARD_PAYMENT_METHODS}
                                disabled={isSaving}
                            />
                        </div>

                        <PaymentAccountSelector
                            workspaceId={booking?.workspaceId}
                            value={paymentAccount?.id ?? null}
                            onValueChange={setPaymentAccount}
                            disabled={isSaving}
                            cashDrawerOnly={paymentMethod === 'cash'}
                        />

                        <div className="space-y-2">
                            <Label htmlFor="travel-booking-payment-note">{t('travelTransportation.payment.note')}</Label>
                            <Textarea
                                id="travel-booking-payment-note"
                                value={note}
                                onChange={(event) => setNote(event.target.value)}
                                disabled={isSaving}
                                rows={3}
                            />
                        </div>
                    </AppDialogBody>

                    <AppDialogFooter>
                        <Button type="button" variant="outline" onClick={() => requestClose(false)} disabled={isSaving}>
                            {t('common.cancel')}
                        </Button>
                        <Button type="submit" disabled={!canSubmit}>
                            {isSaving ? t('common.loading') : t('travelTransportation.payment.record')}
                        </Button>
                    </AppDialogFooter>
                </form>
            </AppDialogContent>
        </AppDialog>
    )
}
