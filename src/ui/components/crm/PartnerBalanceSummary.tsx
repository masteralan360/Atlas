import { TrendingDown, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { BusinessPartner } from '@/local-db'
import { useBusinessPartner } from '@/local-db/businessPartners'
import { cn, formatCurrency } from '@/lib/utils'

export type CurrencyAmountItem = { currency: string; amount: number }

type PartnerBalanceSummaryProps = {
    partner: Pick<BusinessPartner, 'defaultCurrency' | 'receivableBalance' | 'payableBalance'> & Partial<Pick<BusinessPartner, 'id'>>
    iqdPreference: Parameters<typeof formatCurrency>[2]
    receivableTotals?: CurrencyAmountItem[]
    payableTotals?: CurrencyAmountItem[]
    className?: string
    compact?: boolean
}

export function MultiCurrencyDisplay({
    totals,
    fallbackAmount,
    fallbackCurrency,
    iqdPreference,
    className,
    inline = false
}: {
    totals: CurrencyAmountItem[] | undefined
    fallbackAmount: number
    fallbackCurrency: string
    iqdPreference: Parameters<typeof formatCurrency>[2]
    className?: string
    inline?: boolean
}) {
    const items = (totals || []).filter((item) => Math.abs(item.amount) > 0.000001)

    if (items.length === 0) {
        return (
            <span className={className} dir="ltr">
                {formatCurrency(fallbackAmount || 0, fallbackCurrency, iqdPreference)}
            </span>
        )
    }

    if (items.length === 1) {
        return (
            <span className={className} dir="ltr">
                {formatCurrency(items[0].amount, items[0].currency, iqdPreference)}
            </span>
        )
    }

    if (inline) {
        return (
            <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
                {items
                    .sort((a, b) => a.currency.localeCompare(b.currency))
                    .map((item, idx) => (
                        <span key={item.currency || idx} dir="ltr" className="tabular-nums">
                            {formatCurrency(item.amount, item.currency, iqdPreference)}
                            {idx < items.length - 1 ? ' •' : ''}
                        </span>
                    ))}
            </span>
        )
    }

    return (
        <div className="flex flex-col gap-1 text-left">
            {items
                .sort((a, b) => a.currency.localeCompare(b.currency))
                .map((item, idx) => (
                    <div key={item.currency || idx} className={cn('tabular-nums leading-tight', className)} dir="ltr">
                        {formatCurrency(item.amount, item.currency, iqdPreference)}
                    </div>
                ))}
        </div>
    )
}

export function formatMultiCurrencySummarySentence(
    totals: CurrencyAmountItem[] | undefined,
    fallbackAmount: number,
    fallbackCurrency: string,
    iqdPreference: Parameters<typeof formatCurrency>[2],
    andWord: string = 'and'
): string {
    if (!totals || totals.length === 0) {
        return formatCurrency(fallbackAmount || 0, fallbackCurrency, iqdPreference)
    }

    const nonZero = totals.filter((item) => Math.abs(item.amount) > 0.000001)

    if (nonZero.length === 0) {
        return formatCurrency(0, fallbackCurrency, iqdPreference)
    }

    const formattedList = nonZero
        .sort((a, b) => a.currency.localeCompare(b.currency))
        .map((item) => formatCurrency(item.amount, item.currency, iqdPreference))

    if (formattedList.length === 1) {
        return formattedList[0]
    }

    if (formattedList.length === 2) {
        return `${formattedList[0]} ${andWord} ${formattedList[1]}`
    }

    return `${formattedList.slice(0, -1).join(', ')}, ${andWord} ${formattedList[formattedList.length - 1]}`
}

export function formatMultiCurrencySummary(
    totals: CurrencyAmountItem[] | undefined,
    fallbackAmount: number,
    fallbackCurrency: string,
    iqdPreference: Parameters<typeof formatCurrency>[2]
): string {
    if (!totals || totals.length === 0) {
        return formatCurrency(fallbackAmount || 0, fallbackCurrency, iqdPreference)
    }

    const nonZero = totals.filter((item) => Math.abs(item.amount) > 0.000001)

    if (nonZero.length === 0) {
        return formatCurrency(0, fallbackCurrency, iqdPreference)
    }

    return nonZero
        .sort((a, b) => a.currency.localeCompare(b.currency))
        .map((item) => formatCurrency(item.amount, item.currency, iqdPreference))
        .join(' • ')
}

/**
 * The receivable/payable presentation shared by partner details and linked-order forms.
 * Supports per-currency totals when available, defaulting to defaultCurrency stored balances.
 */
export function PartnerBalanceSummary({
    partner: fallbackPartner,
    iqdPreference,
    receivableTotals: fallbackReceivableTotals,
    payableTotals: fallbackPayableTotals,
    className,
    compact = false
}: PartnerBalanceSummaryProps) {
    const { t } = useTranslation()
    const livePartner = useBusinessPartner(fallbackPartner.id)
    const partner = livePartner ?? fallbackPartner
    const confirmed = livePartner?.summarySource === 'server' ? livePartner : undefined
    const receivableTotals = confirmed?.receivableCurrencyTotals ?? fallbackReceivableTotals
    const payableTotals = confirmed?.payableCurrencyTotals ?? fallbackPayableTotals

    if (compact) {
        return (
            <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
                <div className="inline-flex min-h-7 items-center gap-1.5 rounded-lg border border-emerald-200/50 bg-emerald-500/[0.06] px-2 py-1 text-emerald-600 dark:text-emerald-400">
                    <TrendingUp className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-[9px] font-bold uppercase tracking-wide">
                        {t('businessPartners.receivable', { defaultValue: 'Receivable' })}
                    </span>
                    <MultiCurrencyDisplay
                        totals={receivableTotals}
                        fallbackAmount={partner.receivableBalance || 0}
                        fallbackCurrency={partner.defaultCurrency}
                        iqdPreference={iqdPreference}
                        className="text-xs font-black tabular-nums"
                        inline
                    />
                </div>
                <div className="inline-flex min-h-7 items-center gap-1.5 rounded-lg border border-amber-200/50 bg-amber-500/[0.06] px-2 py-1 text-amber-600 dark:text-amber-400">
                    <TrendingDown className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-[9px] font-bold uppercase tracking-wide">
                        {t('businessPartners.payable', { defaultValue: 'Payable' })}
                    </span>
                    <MultiCurrencyDisplay
                        totals={payableTotals}
                        fallbackAmount={partner.payableBalance || 0}
                        fallbackCurrency={partner.defaultCurrency}
                        iqdPreference={iqdPreference}
                        className="text-xs font-black tabular-nums"
                        inline
                    />
                </div>
            </div>
        )
    }

    return (
        <div className={cn('grid gap-4 sm:grid-cols-2', className)}>
            <div className="rounded-3xl border border-emerald-200/50 bg-emerald-500/[0.04] p-6">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-emerald-600 dark:text-emerald-400">
                    <TrendingUp className="h-5 w-5" />
                    {t('businessPartners.receivable', { defaultValue: 'Receivable' })}
                    <span className="ml-auto flex flex-col items-end gap-1">
                        <span className="rounded-full border border-emerald-200/50 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                            {t('businessPartners.theyOweUs', { defaultValue: 'They owe us' })}
                        </span>
                        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                            {t('businessPartners.allTime', { defaultValue: 'All Time' })}
                        </span>
                    </span>
                </div>
                <div className="mt-3 text-2xl sm:text-4xl font-black tracking-tight text-emerald-600 dark:text-emerald-400">
                    <MultiCurrencyDisplay
                        totals={receivableTotals}
                        fallbackAmount={partner.receivableBalance || 0}
                        fallbackCurrency={partner.defaultCurrency}
                        iqdPreference={iqdPreference}
                    />
                </div>
            </div>
            <div className="rounded-3xl border border-amber-200/50 bg-amber-500/[0.04] p-6">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-amber-600 dark:text-amber-400">
                    <TrendingDown className="h-5 w-5" />
                    {t('businessPartners.payable', { defaultValue: 'Payable' })}
                    <span className="ml-auto flex flex-col items-end gap-1">
                        <span className="rounded-full border border-amber-200/50 bg-amber-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-600 dark:text-amber-400">
                            {t('businessPartners.weOweThem', { defaultValue: 'We owe them' })}
                        </span>
                        <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                            {t('businessPartners.allTime', { defaultValue: 'All Time' })}
                        </span>
                    </span>
                </div>
                <div className="mt-3 text-2xl sm:text-4xl font-black tracking-tight text-amber-600 dark:text-amber-400">
                    <MultiCurrencyDisplay
                        totals={payableTotals}
                        fallbackAmount={partner.payableBalance || 0}
                        fallbackCurrency={partner.defaultCurrency}
                        iqdPreference={iqdPreference}
                    />
                </div>
            </div>
        </div>
    )
}
