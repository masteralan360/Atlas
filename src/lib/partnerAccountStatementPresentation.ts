import type { i18n as I18n } from 'i18next'

import {
    getPartnerAccountStatementDescriptionTranslationKey,
    type PartnerAccountStatementEntry
} from '@/lib/partnerAccountStatement'
import { localizeReturnReason } from '@/lib/returnReasons'
import { formatCurrency } from '@/lib/utils'

type Translate = (key: string, options?: Record<string, unknown>) => string
type StatementPaymentMethod = NonNullable<PartnerAccountStatementEntry['paymentMethod']>

const statementPaymentMethodDefaults: Record<StatementPaymentMethod, string> = {
    cash: 'Cash',
    fib: 'FIB',
    qicard: 'QiCard',
    zaincash: 'ZainCash',
    fastpay: 'FastPay',
    bank_transfer: 'Bank Transfer',
    loan: 'Loan',
    installments: 'Installments',
    unknown: 'Unknown'
}

function getStatementPaymentMethodLabel(
    paymentMethod: PartnerAccountStatementEntry['paymentMethod'],
    t: Translate
) {
    const method = paymentMethod || 'unknown'
    return t(`businessPartners.accountStatement.descriptions.paymentMethods.${method}`, {
        defaultValue: statementPaymentMethodDefaults[method]
    })
}

/**
 * Keeps the statement's language-independent event data separate from its
 * localized, user-facing wording. Both the on-screen statement and print
 * template use this so system identifiers are never rendered as descriptions.
 */
export function getPartnerAccountStatementEntryDescription(
    entry: Pick<PartnerAccountStatementEntry, 'description' | 'descriptionKey' | 'paymentMethod'>,
    t: Translate
) {
    const translationKey = getPartnerAccountStatementDescriptionTranslationKey(entry)
    if (!translationKey) return entry.description
    if (entry.descriptionKey === 'saleOrderByPaymentMethod') {
        return t(translationKey, {
            defaultValue: entry.description,
            paymentMethod: getStatementPaymentMethodLabel(entry.paymentMethod, t)
        })
    }
    return t(translationKey, { defaultValue: entry.description })
}

export function getPartnerAccountStatementEntryDetail(
    entry: Pick<PartnerAccountStatementEntry, 'note' | 'returnReason'>
        & Partial<Pick<PartnerAccountStatementEntry, 'salesActivityAmount' | 'currency'>>,
    options: { t: Translate; i18n: I18n; language: string; iqdPreference?: Parameters<typeof formatCurrency>[2] }
) {
    if (entry.returnReason?.trim()) {
        const reason = localizeReturnReason(
            entry.returnReason,
            options.i18n,
            options.language,
            options.t('businessPartners.accountStatement.reasonNotProvided', { defaultValue: 'Not provided' })
        )
        return `${options.t('businessPartners.accountStatement.reason', { defaultValue: 'Reason' })}: ${reason}`
    }

    const details: string[] = []
    if (entry.salesActivityAmount != null) {
        details.push(options.t('businessPartners.accountStatement.descriptions.sellerSalesAmount', {
            defaultValue: 'Sale total: {{amount}}',
            amount: formatCurrency(entry.salesActivityAmount, entry.currency || 'usd', options.iqdPreference || 'IQD')
        }))
    }
    if (entry.note?.trim()) details.push(entry.note.trim())
    return details.length ? details.join(' · ') : null
}
