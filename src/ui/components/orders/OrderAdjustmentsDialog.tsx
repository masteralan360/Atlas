import { useRef, useState } from 'react'
import { AlertTriangle, Check, Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
    type OrderAdjustmentDraft,
    createOrderAdjustment,
    isValidOrderAdjustmentDraft
} from '@/lib/orderAdjustments'
import { formatNumericInput, generateId, sanitizeNumericInput } from '@/lib/utils'
import { getAppliedCurrencyConversion } from '@/lib/orderCurrency'
import type { CurrencyCode, ExchangeRateSnapshot, OrderAdjustment, OrderAdjustmentType } from '@/local-db'
import { Input } from '@/ui/components/input'
import {
  Button,
  CurrencySelector,
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components'

type EditableAdjustment = OrderAdjustmentDraft & {
    original?: OrderAdjustment
}

interface OrderAdjustmentsDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    adjustments: OrderAdjustment[]
    onAdjustmentsChange: (adjustments: OrderAdjustment[]) => void
    orderCurrency: CurrencyCode
    exchangeRates: ExchangeRateSnapshot[]
    availableCurrencies: CurrencyCode[]
    iqdDisplayPreference?: Parameters<typeof CurrencySelector>[0]['iqdDisplayPreference']
    /**
     * Reuses the adjustment workflow for other document types while keeping
     * its language specific to the parent record.
     */
    translationKeyPrefix?: string
}

const DEDUCTION_SIGN = '\u2212'

function createDraft(orderCurrency: CurrencyCode, original?: OrderAdjustment): EditableAdjustment {
    return {
        id: original?.id || generateId(),
        type: original?.type || '',
        name: original?.name || '',
        currency: original?.currency || orderCurrency,
        amount: original ? String(original.amount) : '',
        original
    }
}

export function OrderAdjustmentsDialog({
    open,
    onOpenChange,
    adjustments,
    onAdjustmentsChange,
    orderCurrency,
    exchangeRates,
    availableCurrencies,
    iqdDisplayPreference,
    translationKeyPrefix = 'orders.adjustments'
}: OrderAdjustmentsDialogProps) {
    const { t } = useTranslation()
    const adjustmentT = (key: string, defaultValue: string) => t(`${translationKeyPrefix}.${key}`, { defaultValue })
    const [drafts, setDrafts] = useState<EditableAdjustment[]>([])
    const [isDiscardConfirmOpen, setIsDiscardConfirmOpen] = useState(false)
    const confirmedDraftIds = useRef(new Set<string>())

    const updateDraft = (id: string, changes: Partial<EditableAdjustment>) => {
        setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...changes } : draft))
    }

    const addDraft = () => {
        setDrafts((current) => [...current, createDraft(orderCurrency)])
    }

    const confirmDraft = (draft: EditableAdjustment) => {
        if (
            confirmedDraftIds.current.has(draft.id)
            || adjustments.some((adjustment) => adjustment.id === draft.id)
            || !isValidOrderAdjustmentDraft(draft)
        ) return

        confirmedDraftIds.current.add(draft.id)

        const confirmed = createOrderAdjustment(draft, orderCurrency, exchangeRates)
        if (!confirmed) return

        onAdjustmentsChange([...adjustments.filter((adjustment) => adjustment.id !== confirmed.id), confirmed])
        setDrafts((current) => current.filter((currentDraft) => currentDraft.id !== draft.id))
    }

    const editAdjustment = (adjustment: OrderAdjustment) => {
        confirmedDraftIds.current.delete(adjustment.id)
        onAdjustmentsChange(adjustments.filter((current) => current.id !== adjustment.id))
        setDrafts((current) => [...current.filter((draft) => draft.id !== adjustment.id), createDraft(orderCurrency, adjustment)])
    }

    const deleteAdjustment = (id: string) => {
        onAdjustmentsChange(adjustments.filter((adjustment) => adjustment.id !== id))
    }

    const discardDraft = (draft: EditableAdjustment) => {
        confirmedDraftIds.current.delete(draft.id)
        if (draft.original) {
            onAdjustmentsChange([
                ...adjustments.filter((adjustment) => adjustment.id !== draft.original!.id),
                draft.original
            ])
        }
        setDrafts((current) => current.filter((currentDraft) => currentDraft.id !== draft.id))
    }

    const discardDraftsAndClose = () => {
        const originals = drafts.flatMap((draft) => draft.original ? [draft.original] : [])
        if (originals.length > 0) {
            onAdjustmentsChange([...adjustments.filter((adjustment) => !originals.some((original) => original.id === adjustment.id)), ...originals])
        }
        setDrafts([])
        setIsDiscardConfirmOpen(false)
        onOpenChange(false)
    }

    const requestClose = () => {
        if (drafts.length > 0) {
            setIsDiscardConfirmOpen(true)
            return
        }
        discardDraftsAndClose()
    }

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => nextOpen ? onOpenChange(true) : requestClose()}>
            <DialogContent layout="structured" className="max-w-4xl" showCloseButton={true}>
                <DialogHeader layout="structured">
                    <DialogTitle>{adjustmentT('title', 'Order Adjustments')}</DialogTitle>
                    <DialogDescription>
                        {adjustmentT('description', 'Confirm each row before it affects the order total.')}
                    </DialogDescription>
                </DialogHeader>

                <DialogBody className="space-y-4">
                    {adjustments.length === 0 && drafts.length === 0 ? (
                        <div className="rounded-2xl border border-dashed bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                            {adjustmentT('empty', 'No confirmed order adjustments.')}
                        </div>
                    ) : null}

                    {adjustments.map((adjustment) => (
                        <div key={adjustment.id} className="grid gap-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/5 p-3 sm:grid-cols-[minmax(120px,0.8fr)_minmax(150px,1.3fr)_90px_110px_minmax(130px,1fr)_auto] sm:items-end">
                            <AdjustmentTypeValue
                                type={adjustment.type}
                                label={adjustmentT('type', 'Adjustment type')}
                                additionLabel={adjustmentT('addition', 'Addition (+)')}
                                deductionLabel={adjustmentT('deduction', `Deduction (${DEDUCTION_SIGN})`)}
                            />
                            <AdjustmentValue label={t('common.name', { defaultValue: 'Name' })} value={adjustment.name} />
                            <AdjustmentValue label={t('orders.form.currency', { defaultValue: 'Currency' })} value={adjustment.currency.toUpperCase()} />
                            <AdjustmentValue label={t('common.amount', { defaultValue: 'Amount' })} value={formatNumericInput(String(adjustment.amount))} />
                            <AdjustmentValue
                                label={adjustmentT('convertedAmount', 'Applied to order')}
                                value={`${formatNumericInput(String(adjustment.convertedAmount))} ${adjustment.orderCurrency.toUpperCase()}`}
                            />
                            <div className="flex gap-1 sm:justify-end">
                                <Button type="button" variant="ghost" size="icon" className="h-9 w-9" onClick={() => editAdjustment(adjustment)} aria-label={t('common.edit', { defaultValue: 'Edit' })}>
                                    <Pencil className="h-4 w-4" />
                                </Button>
                                <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => deleteAdjustment(adjustment.id)} aria-label={t('common.delete', { defaultValue: 'Delete' })}>
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    ))}

                    {drafts.map((draft) => {
                        const conversion = getAppliedCurrencyConversion(Number(draft.amount), draft.currency, orderCurrency, exchangeRates)
                        const isValid = isValidOrderAdjustmentDraft(draft) && Boolean(conversion)
                        return (
                            <div key={draft.id} className="grid gap-3 rounded-2xl border border-amber-500/35 bg-amber-500/5 p-3 sm:grid-cols-[minmax(120px,0.8fr)_minmax(150px,1.3fr)_130px_110px_minmax(150px,1fr)_auto] sm:items-end">
                                <div className="space-y-2">
                                    <Label>{adjustmentT('type', 'Adjustment type')}</Label>
                                    <Select value={draft.type} onValueChange={(value) => updateDraft(draft.id, { type: value as OrderAdjustmentType })}>
                                        <SelectTrigger><SelectValue placeholder={t('common.select', { defaultValue: 'Select' })} /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="deduction">{adjustmentT('deduction', `Deduction (${DEDUCTION_SIGN})`)}</SelectItem>
                                            <SelectItem value="addition">{adjustmentT('addition', 'Addition (+)')}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label>{t('common.name', { defaultValue: 'Name' })}</Label>
                                    <Input value={draft.name} onChange={(event) => updateDraft(draft.id, { name: event.target.value })} placeholder={adjustmentT('namePlaceholder', 'Shipping, Handling Fee…')} />
                                </div>
                                <CurrencySelector
                                    value={draft.currency}
                                    onChange={(value) => updateDraft(draft.id, { currency: value })}
                                    label={t('orders.form.currency', { defaultValue: 'Currency' })}
                                    iqdDisplayPreference={iqdDisplayPreference}
                                    allowedCurrencies={availableCurrencies}
                                />
                                <div className="space-y-2">
                                    <Label>{t('common.amount', { defaultValue: 'Amount' })}</Label>
                                    <Input
                                        inputMode="decimal"
                                        value={formatNumericInput(draft.amount)}
                                        onChange={(event) => updateDraft(draft.id, {
                                            amount: sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 })
                                        })}
                                        placeholder="0"
                                    />
                                </div>
                                <AdjustmentValue
                                    label={adjustmentT('convertedAmount', 'Applied to order')}
                                    value={conversion
                                        ? `${formatNumericInput(String(conversion.convertedAmount))} ${orderCurrency.toUpperCase()}`
                                        : adjustmentT('exchangeRateUnavailable', 'Exchange rate unavailable')}
                                    valueClassName={conversion ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}
                                />
                                <div className="flex gap-1 sm:justify-end">
                                    <Button type="button" size="icon" className="h-9 w-9" disabled={!isValid} onClick={() => confirmDraft(draft)} aria-label={t('common.confirm', { defaultValue: 'Confirm' })}>
                                        <Check className="h-4 w-4" />
                                    </Button>
                                    <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => discardDraft(draft)} aria-label={t('common.remove', { defaultValue: 'Remove' })}>
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                                {!isValid ? (
                                    <div className="sm:col-span-6 flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-300">
                                        <AlertTriangle className="h-3.5 w-3.5" />
                                        {isValidOrderAdjustmentDraft(draft)
                                            ? adjustmentT('exchangeRateUnavailable', 'Exchange rate unavailable for the selected currency.')
                                            : adjustmentT('validation', 'Select a type, enter a name, choose a currency, and enter an amount greater than zero.')}
                                    </div>
                                ) : null}
                            </div>
                        )
                    })}

                    <Button type="button" variant="outline" className="w-full border-dashed" onClick={addDraft}>
                        <Plus className="mr-2 h-4 w-4" />
                        {adjustmentT('addRow', 'Add Row')}
                    </Button>
                </DialogBody>

                <DialogFooter layout="structured">
                    <span className="text-xs text-muted-foreground">
                        {adjustments.length} {adjustmentT('confirmed', 'confirmed')}
                    </span>
                    <Button type="button" onClick={requestClose}>{t('common.done', { defaultValue: 'Done' })}</Button>
                </DialogFooter>
            </DialogContent>

            <Dialog open={isDiscardConfirmOpen} onOpenChange={setIsDiscardConfirmOpen}>
                <DialogContent className="sm:max-w-md" showCloseButton={false}>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="h-5 w-5" />
                            {adjustmentT('discardTitle', 'Discard incomplete adjustments?')}
                        </DialogTitle>
                        <DialogDescription>
                            {adjustmentT('discardWarning', 'You have incomplete Order Adjustments. Closing now will discard those unsaved rows.')}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button type="button" variant="outline" onClick={() => setIsDiscardConfirmOpen(false)}>
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button type="button" variant="destructive" onClick={discardDraftsAndClose}>
                            {adjustmentT('discardAndClose', 'Discard and close')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Dialog>
    )
}

function AdjustmentTypeValue({
    type,
    label,
    additionLabel,
    deductionLabel
}: {
    type: OrderAdjustmentType
    label: string
    additionLabel: string
    deductionLabel: string
}) {
    return (
        <AdjustmentValue
            label={label}
            value={type === 'addition' ? additionLabel : deductionLabel}
            valueClassName={type === 'addition' ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}
        />
    )
}

function AdjustmentValue({ label, value, valueClassName }: { label: string, value: string, valueClassName?: string }) {
    return (
        <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
            <div className={`mt-1 truncate text-sm font-semibold ${valueClassName || ''}`}>{value}</div>
        </div>
    )
}
