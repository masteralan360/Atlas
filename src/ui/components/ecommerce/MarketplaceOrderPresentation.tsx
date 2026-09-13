import { Truck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { MarketplaceOrderDisplayStatus } from '@/lib/marketplaceOrderPresentation'
import { formatCurrency } from '@/lib/utils'
import { useWorkspace } from '@/workspace'

export function EcommerceStatusBadge({ status }: { status: MarketplaceOrderDisplayStatus }) {
    const { t } = useTranslation()

    const classes: Record<MarketplaceOrderDisplayStatus, string> = {
        pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
        confirmed: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
        processing: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
        shipped: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
        delivered: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        returned: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
        cancelled: 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
    }

    return (
        <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] ${classes[status]}`}>
            {t(`ecommerce.status.${status}`, { defaultValue: status })}
        </span>
    )
}

export function MarketplaceDeliveryFeeBadge({ fee }: { fee: number | null }) {
    const { t } = useTranslation()
    const { features } = useWorkspace()

    if (fee === null) return null

    return (
        <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/25 bg-violet-500/10 px-2.5 py-1 text-[10px] font-black tracking-wide text-violet-700 dark:text-violet-300">
            <Truck className="h-3 w-3" aria-hidden="true" />
            {t('ecommerce.deliveryFeeBadge', {
                amount: formatCurrency(fee, 'iqd', features.iqd_display_preference),
                defaultValue: '+{{amount}} Delivery'
            })}
        </span>
    )
}
