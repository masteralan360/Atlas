import {
    BadgeCheck,
    CheckCircle2,
    Clock3,
    Loader2,
    LockKeyhole,
    Package,
    PackageCheck,
    Route,
    ShoppingBag,
    Truck,
    XCircle,
    type LucideIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Progress
} from '@/ui/components'
import { getMarketplaceOrderAdvancementProgressMetrics } from './MarketplaceOrderWorkflow'
import type { MarketplaceOrderStatus } from './MarketplaceOrderTypes'

export interface MarketplaceOrderAdvancementProgress {
    orderId: string
    orderNumber: string
    targetStatus: MarketplaceOrderStatus
    path: readonly MarketplaceOrderStatus[]
    completedCount: number
}

const STATUS_ICONS = {
    pending: Clock3,
    confirmed: BadgeCheck,
    processing: Package,
    shipped: Truck,
    delivered: PackageCheck,
    cancelled: XCircle
} satisfies Record<MarketplaceOrderStatus, LucideIcon>

export function MarketplaceOrderAdvancementDialog({
    progress
}: {
    progress: MarketplaceOrderAdvancementProgress | null
}) {
    const { t } = useTranslation()

    if (!progress) return null

    const metrics = getMarketplaceOrderAdvancementProgressMetrics(
        progress.completedCount,
        progress.path.length
    )
    const activeStatus = metrics.activeStepIndex === null
        ? progress.targetStatus
        : progress.path[metrics.activeStepIndex]

    return (
        <AppDialog open>
            <AppDialogContent
                className="max-w-xl border-sky-500/30 shadow-2xl shadow-sky-950/30"
                overlayClassName="bg-slate-950/80 backdrop-blur-sm"
                showCloseButton={false}
                onEscapeKeyDown={(event) => event.preventDefault()}
                onPointerDownOutside={(event) => event.preventDefault()}
                onInteractOutside={(event) => event.preventDefault()}
            >
                <AppDialogHeader className="border-sky-500/20 bg-gradient-to-r from-sky-500/15 via-indigo-500/10 to-transparent">
                    <div className="flex items-start gap-3">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-sky-500/15 text-sky-600 ring-1 ring-inset ring-sky-500/25 dark:text-sky-300">
                            <Route className="h-5 w-5" aria-hidden="true" />
                        </div>
                        <div className="min-w-0 space-y-1">
                            <AppDialogTitle>{t('ecommerce.autoAdvance.title')}</AppDialogTitle>
                            <AppDialogDescription>
                                {t('ecommerce.autoAdvance.description')}
                            </AppDialogDescription>
                        </div>
                    </div>
                </AppDialogHeader>

                <AppDialogBody className="space-y-5">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="rounded-2xl border border-border/70 bg-muted/25 p-3.5">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                <ShoppingBag className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('ecommerce.autoAdvance.order')}
                            </div>
                            <p className="mt-2 truncate text-base font-bold text-foreground">{progress.orderNumber}</p>
                        </div>
                        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-3.5">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
                                <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('ecommerce.autoAdvance.target')}
                            </div>
                            <p className="mt-2 text-base font-bold text-emerald-800 dark:text-emerald-200">
                                {t(`ecommerce.status.${progress.targetStatus}`)}
                            </p>
                        </div>
                    </div>

                    <section className="rounded-2xl border border-sky-500/20 bg-sky-500/[0.06] p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                            <div aria-live="polite" className="min-w-0">
                                <p className="text-sm font-bold text-foreground">
                                    {t('ecommerce.autoAdvance.currentStep', {
                                        status: t(`ecommerce.status.${activeStatus}`)
                                    })}
                                </p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    {t('ecommerce.autoAdvance.progress', {
                                        completed: metrics.completedCount,
                                        total: metrics.totalCount
                                    })}
                                </p>
                            </div>
                            <span className="shrink-0 rounded-full bg-sky-500/15 px-3 py-1 text-sm font-black tabular-nums text-sky-700 dark:text-sky-300">
                                {metrics.progressPercent}%
                            </span>
                        </div>
                        <Progress
                            value={metrics.progressPercent}
                            aria-label={t('ecommerce.autoAdvance.progressLabel')}
                            className="h-2.5 bg-sky-500/15"
                            indicatorClassName="bg-gradient-to-r from-sky-500 to-indigo-500"
                        />
                    </section>

                    <ol className="space-y-2.5" aria-label={t('ecommerce.autoAdvance.stepsLabel')}>
                        {progress.path.map((status, index) => {
                            const completed = index < metrics.completedCount
                            const active = index === metrics.activeStepIndex
                            const StatusIcon = STATUS_ICONS[status]

                            return (
                                <li
                                    key={status}
                                    className={cn(
                                        'flex items-center gap-3 rounded-2xl border px-3.5 py-3 transition-colors',
                                        completed && 'border-emerald-500/25 bg-emerald-500/10',
                                        active && 'border-sky-500/35 bg-sky-500/10 shadow-sm shadow-sky-500/10',
                                        !completed && !active && 'border-border/60 bg-muted/20'
                                    )}
                                >
                                    <div className={cn(
                                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset',
                                        completed && 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300',
                                        active && 'bg-sky-500/15 text-sky-700 ring-sky-500/25 dark:text-sky-300',
                                        !completed && !active && 'bg-muted text-muted-foreground ring-border/60'
                                    )}>
                                        <StatusIcon className="h-5 w-5" aria-hidden="true" />
                                    </div>

                                    <div className="min-w-0 flex-1">
                                        <p className={cn(
                                            'font-semibold',
                                            completed && 'text-emerald-800 dark:text-emerald-200',
                                            active && 'text-sky-800 dark:text-sky-200',
                                            !completed && !active && 'text-muted-foreground'
                                        )}>
                                            {t(`ecommerce.status.${status}`)}
                                        </p>
                                        <p className="mt-0.5 text-xs text-muted-foreground">
                                            {completed
                                                ? t('ecommerce.autoAdvance.completed')
                                                : active
                                                    ? t('ecommerce.autoAdvance.inProgress')
                                                    : t('ecommerce.autoAdvance.pending')}
                                        </p>
                                    </div>

                                    {completed ? (
                                        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                    ) : active ? (
                                        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-sky-600 dark:text-sky-400" aria-hidden="true" />
                                    ) : (
                                        <Clock3 className="h-5 w-5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                                    )}
                                </li>
                            )
                        })}
                    </ol>
                </AppDialogBody>

                <AppDialogFooter className="flex-row items-center justify-start gap-2 border-sky-500/15 bg-sky-500/[0.04] text-sm text-muted-foreground sm:justify-start">
                    <LockKeyhole className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden="true" />
                    <span>{t('ecommerce.autoAdvance.blockingHint')}</span>
                </AppDialogFooter>
            </AppDialogContent>
        </AppDialog>
    )
}
