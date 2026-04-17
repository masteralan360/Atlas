import { CalendarClock, Phone, ShoppingBag, UserRound } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatCurrency, formatDateTime, cn } from '@/lib/utils'
import type { IQDDisplayPreference } from '@/local-db/models'
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from '@/ui/components'

export interface MarketplaceOrderReminderItem {
    orderId: string
    orderNumber: string
    customerName: string
    customerPhone: string
    customerCity?: string | null
    total: number
    currency: string
    itemCount: number
    createdAt: string
}

interface MarketplaceOrderReminderModalProps {
    isOpen: boolean
    item: MarketplaceOrderReminderItem | null
    queuePosition?: number
    queueTotal?: number
    iqdPreference: IQDDisplayPreference
    onReview: () => void
    onSnooze: () => void
    onOpenChange: (open: boolean) => void
}

export function MarketplaceOrderReminderModal({
    isOpen,
    item,
    queuePosition,
    queueTotal,
    iqdPreference,
    onReview,
    onSnooze,
    onOpenChange
}: MarketplaceOrderReminderModalProps) {
    const { t } = useTranslation()

    if (!item) {
        return null
    }

    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader className="space-y-3">
                    <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-300">
                            <ShoppingBag className="h-6 w-6" />
                        </div>
                        <div className="space-y-1">
                            <DialogTitle>{t('ecommerce.pendingOrders', { defaultValue: 'Pending Orders' })}</DialogTitle>
                            <DialogDescription>
                                {t('ecommerce.pendingOrderReminder', {
                                    defaultValue: 'A marketplace order is still waiting for review.'
                                })}
                            </DialogDescription>
                        </div>
                    </div>
                    {queueTotal && queueTotal > 1 && (
                        <div className="text-xs font-medium text-muted-foreground">
                            {t('ecommerce.queueProgress', {
                                current: queuePosition || 1,
                                total: queueTotal,
                                defaultValue: '{{current}} of {{total}}'
                            }) || `${queuePosition || 1} of ${queueTotal}`}
                        </div>
                    )}
                </DialogHeader>

                <div className="rounded-2xl border bg-muted/20 p-4">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <div className="text-lg font-bold">{item.customerName}</div>
                            <div className="text-sm text-muted-foreground">{item.orderNumber}</div>
                        </div>
                        <div className={cn(
                            'rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide',
                            'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                        )}>
                            {t('ecommerce.status.pending', { defaultValue: 'pending' })}
                        </div>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl border bg-background/80 p-3">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                <UserRound className="h-4 w-4" />
                                {t('ecommerce.customer', { defaultValue: 'Customer' })}
                            </div>
                            <div className="mt-1 text-base font-bold">{item.customerName}</div>
                            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                                <Phone className="h-3.5 w-3.5" />
                                <span>{item.customerPhone}</span>
                            </div>
                            {item.customerCity && (
                                <div className="mt-1 text-xs text-muted-foreground">{item.customerCity}</div>
                            )}
                        </div>

                        <div className="rounded-xl border bg-background/80 p-3">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                <CalendarClock className="h-4 w-4" />
                                {t('common.date', { defaultValue: 'Date' })}
                            </div>
                            <div className="mt-1 text-base font-bold">{formatDateTime(item.createdAt)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {t('ecommerce.itemsSummary', {
                                    count: item.itemCount,
                                    defaultValue: `${item.itemCount} item(s)`
                                })}
                            </div>
                        </div>
                    </div>

                    <div className="mt-3 rounded-xl border bg-background/80 p-3">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {t('common.amount', { defaultValue: 'Amount' })}
                        </div>
                        <div className="mt-1 text-lg font-bold">
                            {formatCurrency(item.total, item.currency, iqdPreference)}
                        </div>
                    </div>
                </div>

                <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
                    <Button variant="outline" onClick={onSnooze}>
                        {t('common.snooze', { defaultValue: 'Snooze' })}
                    </Button>
                    <Button onClick={onReview}>
                        {t('ecommerce.reviewOrder', { defaultValue: 'Review Order' })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
