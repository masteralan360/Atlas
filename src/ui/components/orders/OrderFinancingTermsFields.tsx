import { useTranslation } from 'react-i18next'

import type { CurrencyCode, InstallmentFrequency } from '@/local-db'
import { getRemainingFinancedBalance } from '@/lib/orderFinancing'
import {
    formatCurrency,
    formatLocalDateValue,
    formatNumericInput,
    parseLocalDateValue,
    sanitizeNumericInput
} from '@/lib/utils'
import { DateTimePicker, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/components'

export type OrderFinancingTermsMode = 'loan' | 'installments'

type OrderFinancingTermsFieldsProps = {
    mode: OrderFinancingTermsMode
    idPrefix: string
    orderTotal: number
    currency: CurrencyCode
    iqdPreference: 'IQD' | 'د.ع'
    initialPaymentAmount: string
    onInitialPaymentAmountChange: (value: string) => void
    firstDueDate: string
    onFirstDueDateChange: (value: string) => void
    installmentCount: string
    onInstallmentCountChange: (value: string) => void
    installmentFrequency: InstallmentFrequency
    onInstallmentFrequencyChange: (value: InstallmentFrequency) => void
    initialPaymentRequired?: boolean
    disabled?: boolean
}

export function OrderFinancingTermsFields({
    mode,
    idPrefix,
    orderTotal,
    currency,
    iqdPreference,
    initialPaymentAmount,
    onInitialPaymentAmountChange,
    firstDueDate,
    onFirstDueDateChange,
    installmentCount,
    onInstallmentCountChange,
    installmentFrequency,
    onInstallmentFrequencyChange,
    initialPaymentRequired = false,
    disabled = false
}: OrderFinancingTermsFieldsProps) {
    const { t } = useTranslation()
    const isInstallmentBased = mode === 'installments'
    const requiredMark = <span className="text-destructive">*</span>
    const initialPaymentLabel = isInstallmentBased
        ? t('orders.form.initialPayment')
        : t('orders.form.initialLoanRepayment')
    const dueDateLabel = isInstallmentBased
        ? t('orders.form.firstDueDate')
        : t('orders.form.dueDate')

    return (
        <div className="grid gap-4 rounded-2xl border p-4 sm:grid-cols-2">
            {isInstallmentBased ? (
                <>
                    <div className="space-y-2">
                        <Label htmlFor={`${idPrefix}-installment-count`}>
                            {t('orders.form.installmentCount')} {requiredMark}
                        </Label>
                        <Input
                            id={`${idPrefix}-installment-count`}
                            type="number"
                            min="1"
                            max="120"
                            value={installmentCount}
                            onChange={(event) => onInstallmentCountChange(event.target.value)}
                            disabled={disabled}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor={`${idPrefix}-installment-frequency`}>
                            {t('orders.form.installmentFrequency')} {requiredMark}
                        </Label>
                        <Select
                            value={installmentFrequency}
                            onValueChange={(value) => onInstallmentFrequencyChange(value as InstallmentFrequency)}
                            disabled={disabled}
                        >
                            <SelectTrigger id={`${idPrefix}-installment-frequency`}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="weekly">{t('orders.form.weekly')}</SelectItem>
                                <SelectItem value="biweekly">{t('orders.form.biweekly')}</SelectItem>
                                <SelectItem value="monthly">{t('orders.form.monthly')}</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </>
            ) : null}
            <div className="min-w-0 space-y-2">
                <Label className="block break-words" htmlFor={`${idPrefix}-initial-payment`}>
                    {initialPaymentLabel} {initialPaymentRequired ? requiredMark : null}
                </Label>
                <Input
                    id={`${idPrefix}-initial-payment`}
                    inputMode="decimal"
                    placeholder="0"
                    value={formatNumericInput(initialPaymentAmount)}
                    onChange={(event) => onInitialPaymentAmountChange(
                        sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 })
                    )}
                    disabled={disabled}
                />
            </div>
            <div className="min-w-0 space-y-2">
                <Label className="block break-words" htmlFor={`${idPrefix}-first-due`}>
                    {dueDateLabel} {isInstallmentBased ? requiredMark : null}
                </Label>
                <DateTimePicker
                    id={`${idPrefix}-first-due`}
                    mode="date"
                    date={parseLocalDateValue(firstDueDate)}
                    setDate={(value) => onFirstDueDateChange(formatLocalDateValue(value))}
                    placeholder={isInstallmentBased ? dueDateLabel : t('orders.form.dueDatePlaceholder')}
                    disabled={disabled}
                />
            </div>
            <div className="flex items-center justify-between text-sm sm:col-span-2">
                <span className="text-muted-foreground">
                    {t(isInstallmentBased ? 'orders.form.financedBalance' : 'orders.form.remainingLoanBalance')}
                </span>
                <span className="font-semibold">
                    {formatCurrency(getRemainingFinancedBalance(orderTotal, initialPaymentAmount), currency, iqdPreference)}
                </span>
            </div>
        </div>
    )
}
