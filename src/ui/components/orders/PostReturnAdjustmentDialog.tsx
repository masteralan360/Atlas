import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, LockKeyhole, Save } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
    type OrderAdjustmentDraft,
    isValidOrderAdjustmentDraft
} from '@/lib/orderAdjustments'
import { getAppliedCurrencyConversion } from '@/lib/orderCurrency'
import { formatNumericInput, generateId, sanitizeNumericInput } from '@/lib/utils'
import type { CurrencyCode, ExchangeRateSnapshot, OrderAdjustmentType, OrderReturn } from '@/local-db'
import { Input } from '@/ui/components/input'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  CurrencySelector,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/ui/components'

type PostReturnAdjustmentDialogProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    returns: readonly OrderReturn[]
    orderCurrency: CurrencyCode
    exchangeRates: ExchangeRateSnapshot[]
    availableCurrencies: CurrencyCode[]
    iqdDisplayPreference?: Parameters<typeof CurrencySelector>[0]['iqdDisplayPreference']
    isSaving?: boolean
    onSubmit: (input: { returnId: string; adjustment: OrderAdjustmentDraft; notes: string }) => void | Promise<void>
}

function createDraft(orderCurrency: CurrencyCode): OrderAdjustmentDraft {
    return {
        id: generateId(),
        type: '',
        name: '',
        currency: orderCurrency,
        amount: ''
    }
}

export function PostReturnAdjustmentDialog({
    open,
    onOpenChange,
    returns,
    orderCurrency,
    exchangeRates,
    availableCurrencies,
    iqdDisplayPreference,
    isSaving = false,
    onSubmit
}: PostReturnAdjustmentDialogProps) {
    const { t } = useTranslation()
    const [returnId, setReturnId] = useState('')
    const [draft, setDraft] = useState<OrderAdjustmentDraft>(() => createDraft(orderCurrency))
    const [notes, setNotes] = useState('')

    useEffect(() => {
        if (!open) return
        setReturnId(returns[0]?.id || '')
        setDraft(createDraft(orderCurrency))
        setNotes('')
    }, [open, orderCurrency, returns])

    const conversion = useMemo(
        () => getAppliedCurrencyConversion(Number(draft.amount), draft.currency, orderCurrency, exchangeRates),
        [draft.amount, draft.currency, exchangeRates, orderCurrency]
    )
    const isValid = Boolean(returnId) && isValidOrderAdjustmentDraft(draft) && Boolean(conversion)

    const updateDraft = (changes: Partial<OrderAdjustmentDraft>) => {
        setDraft((current) => ({ ...current, ...changes }))
    }

    const handleSubmit = async () => {
        if (!isValid || isSaving) return
        await onSubmit({ returnId, adjustment: draft, notes })
    }

    return (
        <AppDialog open={open} onOpenChange={onOpenChange}>
            <AppDialogContent className="max-w-xl">
                <AppDialogHeader>
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300">
                            <LockKeyhole className="h-5 w-5" />
                        </div>
                        <div>
                            <AppDialogTitle>{t('orders.adjustments.postReturn.title', { defaultValue: 'Post-return adjustment' })}</AppDialogTitle>
                            <p className="mt-1 text-sm text-muted-foreground">
                                {t('orders.adjustments.postReturn.description', { defaultValue: 'Add a correction to one posted return. It is permanently recorded and never changes the original order document.' })}
                            </p>
                        </div>
                    </div>
                </AppDialogHeader>

                <AppDialogBody className="space-y-5">
                    <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-900 dark:text-amber-200">
                        {t('orders.adjustments.postReturn.immutableNotice', { defaultValue: 'This correction is immutable after saving. Use the reason and note to make its cause clear.' })}
                    </div>

                    <div className="space-y-2">
                        <Label>{t('orders.adjustments.postReturn.return', { defaultValue: 'Posted return' })}</Label>
                        <Select value={returnId} onValueChange={setReturnId}>
                            <SelectTrigger><SelectValue placeholder={t('orders.adjustments.postReturn.selectReturn', { defaultValue: 'Select a return' })} /></SelectTrigger>
                            <SelectContent>
                                {returns.map((orderReturn) => (
                                    <SelectItem key={orderReturn.id} value={orderReturn.id}>
                                        {orderReturn.reason} — {new Date(orderReturn.returnedAt).toLocaleDateString()}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label>{t('orders.adjustments.type', { defaultValue: 'Adjustment type' })}</Label>
                            <Select value={draft.type} onValueChange={(value) => updateDraft({ type: value as OrderAdjustmentType })}>
                                <SelectTrigger><SelectValue placeholder={t('common.select', { defaultValue: 'Select' })} /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="deduction">{t('orders.adjustments.deduction', { defaultValue: 'Deduction (−)' })}</SelectItem>
                                    <SelectItem value="addition">{t('orders.adjustments.addition', { defaultValue: 'Addition (+)' })}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <CurrencySelector
                            value={draft.currency}
                            onChange={(currency) => updateDraft({ currency })}
                            label={t('orders.form.currency', { defaultValue: 'Currency' })}
                            iqdDisplayPreference={iqdDisplayPreference}
                            allowedCurrencies={availableCurrencies}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label>{t('orders.adjustments.postReturn.reason', { defaultValue: 'Reason' })}</Label>
                        <Input
                            value={draft.name}
                            onChange={(event) => updateDraft({ name: event.target.value })}
                            placeholder={t('orders.adjustments.postReturn.reasonPlaceholder', { defaultValue: 'Restocking fee, damaged packaging…' })}
                        />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-[1fr_minmax(170px,0.8fr)] sm:items-end">
                        <div className="space-y-2">
                            <Label>{t('common.amount', { defaultValue: 'Amount' })}</Label>
                            <Input
                                inputMode="decimal"
                                value={formatNumericInput(draft.amount)}
                                onChange={(event) => updateDraft({
                                    amount: sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 })
                                })}
                                placeholder="0"
                            />
                        </div>
                        <div className="rounded-xl border bg-muted/30 px-3 py-2.5">
                            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                                {t('orders.adjustments.convertedAmount', { defaultValue: 'Applied to order' })}
                            </div>
                            <div className="mt-1 text-sm font-bold text-foreground">
                                {conversion
                                    ? `${formatNumericInput(String(conversion.convertedAmount))} ${orderCurrency.toUpperCase()}`
                                    : t('orders.adjustments.exchangeRateUnavailable', { defaultValue: 'Exchange rate unavailable' })}
                            </div>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label>{t('orders.adjustments.postReturn.notes', { defaultValue: 'Note (optional)' })}</Label>
                        <Textarea
                            value={notes}
                            onChange={(event) => setNotes(event.target.value)}
                            placeholder={t('orders.adjustments.postReturn.notesPlaceholder', { defaultValue: 'Add context for this correction…' })}
                            rows={3}
                        />
                    </div>

                    {!isValid ? (
                        <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            {t('orders.adjustments.postReturn.validation', { defaultValue: 'Choose a return, type, currency, reason, and amount greater than zero.' })}
                        </div>
                    ) : null}
                </AppDialogBody>

                <AppDialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
                        {t('common.cancel', { defaultValue: 'Cancel' })}
                    </Button>
                    <Button type="button" onClick={() => { void handleSubmit() }} disabled={!isValid || isSaving}>
                        <Save className="mr-2 h-4 w-4" />
                        {isSaving
                            ? t('common.saving', { defaultValue: 'Saving…' })
                            : t('orders.adjustments.postReturn.save', { defaultValue: 'Save immutable correction' })}
                    </Button>
                </AppDialogFooter>
            </AppDialogContent>
        </AppDialog>
    )
}
