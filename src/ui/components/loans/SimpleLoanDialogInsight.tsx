import { useTranslation } from 'react-i18next'
import { CircleAlert } from 'lucide-react'

import type { CurrencyCode, LoanDirection } from '@/local-db'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils'

export interface SimpleLoanSavePreviewProps {
    canSubmit: boolean
    counterpartyName: string
    direction: LoanDirection
    principalAmount: number
    currency: CurrencyCode
    iqdDisplayPreference: 'IQD' | 'د.ع'
    createdAt: Date | null
    dueDate: Date | null
    paymentAccountName: string | null
}

export function SimpleLoanDialogInsight() {
    const { t } = useTranslation()

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <h3 className="text-2xl font-semibold">{t('loans.simpleLoanInsightTitle')}</h3>
                <p className="text-sm text-emerald-100/85">
                    {t('loans.simpleLoanInsightDescription')}
                </p>
            </div>
        </div>
    )
}

export function SimpleLoanSavePreview({
    canSubmit,
    counterpartyName,
    direction,
    principalAmount,
    currency,
    iqdDisplayPreference,
    createdAt,
    dueDate,
    paymentAccountName,
}: SimpleLoanSavePreviewProps) {
    const { t } = useTranslation()

    if (!canSubmit || !createdAt) {
        return (
            <div className="flex items-start gap-2 leading-relaxed text-emerald-100/85">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-emerald-100/80" />
                <p>{t('loans.simpleLoanPreviewIncomplete')}</p>
            </div>
        )
    }

    const amount = formatCurrency(principalAmount, currency, iqdDisplayPreference)
    const paidAmount = formatCurrency(0, currency, iqdDisplayPreference)
    const movement = direction === 'borrowed'
        ? t('loans.simpleLoanPreviewIncoming')
        : t('loans.simpleLoanPreviewOutgoing')
    const dueDescription = dueDate
        ? t('loans.simpleLoanPreviewDueDate', { date: formatDate(dueDate) })
        : t('loans.simpleLoanPreviewNoDueDate')
    const accountEffect = paymentAccountName
        ? t(direction === 'borrowed'
            ? 'loans.simpleLoanPreviewAccountIncoming'
            : 'loans.simpleLoanPreviewAccountOutgoing', { account: paymentAccountName, amount })
        : t('loans.simpleLoanPreviewNoAccount')

    return (
        <p className="leading-relaxed text-white/95">
            {t('loans.simpleLoanPreviewLoan', {
                counterparty: counterpartyName,
                direction: t(`loans.directions.${direction}`),
                date: formatDateTime(createdAt),
            })}{' '}
            {t('loans.simpleLoanPreviewAmounts', { amount, paid: paidAmount, due: dueDescription })}{' '}
            {t('loans.simpleLoanPreviewTransaction', { movement, amount, accountEffect })}
        </p>
    )
}
