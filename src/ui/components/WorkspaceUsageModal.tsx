import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip as RechartsTooltip, XAxis, YAxis, Bar, BarChart } from 'recharts'
import { Activity, CalendarDays, CircleDollarSign, Database, Gauge, HardDrive, RefreshCw, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceUsageInsights } from '@/lib/workspaceUsageHistory'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './dialog'
import type { WorkspacePaygSummary } from '@/lib/workspacePayments'
import { openWorkspacePaymentDialog } from '@/lib/workspacePayments'
import { getPaygInterpolationSegment } from '@/lib/paygPricing'

export type WorkspaceUsageMeterSegment = {
    key: 'storage' | 'chargedUsage'
    label: string
    percent: number
    widthPercent: number
    className: string
}

export type WorkspaceUsageMeterMetric = {
    key: 'storage' | 'chargedUsage'
    label: string
    percent: number
    barClassName: string
    badgeClassName: string
}

export type WorkspaceUsageMeter = {
    percent: number
    label: string
    title: string
    segments: WorkspaceUsageMeterSegment[]
    metrics: WorkspaceUsageMeterMetric[]
    details: {
        storageUnits: number
        storageUnitLimit: number | null
        /** Plan consumption after commercial weighting; used for quota progress. */
        chargedUsageBytes: number
        /** Allowance compared only with chargedUsageBytes. */
        chargedUsageLimitBytes: number | null
        transferPeriodStart: string
        insights: WorkspaceUsageInsights
    }
}

type WorkspaceUsageModalProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    usageMeter: WorkspaceUsageMeter | null
    onRefresh: () => void | Promise<void>
    isRefreshing: boolean
    paygSummary?: WorkspacePaygSummary | null
}

type WorkspaceUsageButtonProps = {
    usageMeter: WorkspaceUsageMeter
    onClick: () => void
    className?: string
}

type WorkspacePaygChargeButtonProps = {
    summary: WorkspacePaygSummary
    onClick: () => void
    compact?: boolean
    className?: string
}

type UsageStatCardProps = {
    icon: ReactNode
    label: string
    value: string
    detail: string
    toneClassName: string
}

function formatBytes(value: number | null | undefined, locale: string): string {
    const bytes = Number(value ?? 0)
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'

    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1000)))
    const amount = bytes / (1000 ** unitIndex)
    return `${new Intl.NumberFormat(locale, {
        maximumFractionDigits: amount >= 100 ? 0 : amount >= 10 ? 1 : 2
    }).format(amount)} ${units[unitIndex]}`
}

function formatCompactBytes(value: number, locale: string): string {
    const bytes = Number(value)
    if (!Number.isFinite(bytes) || bytes <= 0) return '0'
    if (bytes < 1000) return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes)

    const units = ['KB', 'MB', 'GB', 'TB']
    let amount = bytes / 1000
    let unitIndex = 0
    while (amount >= 1000 && unitIndex < units.length - 1) {
        amount /= 1000
        unitIndex += 1
    }
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(amount)} ${units[unitIndex]}`
}

function formatDay(day: string, locale: string, options?: Intl.DateTimeFormatOptions): string {
    const date = new Date(`${day}T00:00:00.000Z`)
    if (!Number.isFinite(date.getTime())) return day
    return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
        ...options
    }).format(date)
}

function formatTimestamp(value: string | null, locale: string): string {
    if (!value) return '—'
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return '—'
    return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    }).format(date)
}

function UsageStatCard({ icon, label, value, detail, toneClassName }: UsageStatCardProps) {
    return (
        <div className="rounded-2xl border border-border/60 bg-background/90 p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                        {label}
                    </p>
                    <p className="mt-2 truncate text-xl font-black tabular-nums tracking-tight text-foreground">
                        {value}
                    </p>
                </div>
                <div className={cn('rounded-xl p-2.5', toneClassName)}>
                    {icon}
                </div>
            </div>
            <p className="mt-2 truncate text-xs text-muted-foreground" title={detail}>
                {detail}
            </p>
        </div>
    )
}

function getSegmentProgressColor(segment: WorkspaceUsageMeterSegment) {
    return segment.key === 'chargedUsage'
        ? '#f59e0b'
        : 'hsl(var(--primary))'
}

function buildCircleProgressBackground(usageMeter: WorkspaceUsageMeter) {
    let cursor = 0
    const parts = usageMeter.segments.flatMap((segment) => {
        const absoluteWidth = (Math.min(100, Math.max(0, usageMeter.percent)) * segment.widthPercent) / 100
        const start = cursor
        const end = Math.min(100, cursor + absoluteWidth)
        cursor = end

        if (end <= start) return []
        return `${getSegmentProgressColor(segment)} ${start}% ${end}%`
    })

    const mutedColor = 'hsl(var(--muted))'
    if (!parts.length) {
        return mutedColor
    }

    return `conic-gradient(${parts.join(', ')}, ${mutedColor} ${cursor}% 100%)`
}

export function WorkspaceUsageButton({ usageMeter, onClick, className }: WorkspaceUsageButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'flex h-8 min-w-[190px] items-center gap-2 rounded-full border border-border/70 bg-background/75 px-2.5 shadow-sm backdrop-blur transition-colors hover:bg-accent/60 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background',
                className
            )}
            title={usageMeter.title}
            aria-label={usageMeter.title}
        >
            <div className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted ring-1 ring-border/50">
                <div
                    className="absolute inset-y-0 left-0 flex overflow-hidden transition-all duration-300"
                    style={{ width: `${Math.min(100, Math.max(0, usageMeter.percent))}%` }}
                >
                    {usageMeter.segments.map((segment) => (
                        <div
                            key={segment.key}
                            className={cn('h-full transition-all duration-300', segment.className)}
                            style={{ width: `${segment.widthPercent}%` }}
                            title={`${segment.label}: ${Math.round(segment.percent)}%`}
                        />
                    ))}
                </div>
            </div>
            <span className="min-w-9 text-right text-[11px] font-bold tabular-nums text-foreground/80">
                {usageMeter.label}
            </span>
        </button>
    )
}

export function WorkspaceUsageCircleButton({ usageMeter, onClick, className }: WorkspaceUsageButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/75 shadow-sm backdrop-blur transition-colors hover:bg-accent/60 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background',
                className
            )}
            title={usageMeter.title}
            aria-label={usageMeter.title}
        >
            <span
                aria-hidden="true"
                className="absolute inset-1 rounded-full"
                style={{ background: buildCircleProgressBackground(usageMeter) }}
            />
            <span aria-hidden="true" className="absolute inset-[5px] rounded-full bg-background" />
            <span className="relative text-[9px] font-black tabular-nums text-foreground">
                {Math.round(usageMeter.percent)}
                <span className="text-[7px]">%</span>
            </span>
        </button>
    )
}

export function WorkspacePaygChargeButton({
    summary,
    onClick,
    compact = false,
    className
}: WorkspacePaygChargeButtonProps) {
    const { t, i18n } = useTranslation()
    const amount = new Intl.NumberFormat(i18n.language || 'en', {
        maximumFractionDigits: 0
    }).format(Number(summary.amountIqd))
    const label = summary.cycleStatus === 'awaiting_payment'
        ? t('workspaceUsage.payg.amountDue')
        : t('workspaceUsage.payg.accruedCharge')

    return (
        <button
            type="button"
            onClick={onClick}
            title={`${label}: ${amount} ${summary.currency}`}
            aria-label={`${label}: ${amount} ${summary.currency}`}
            className={cn(
                'relative z-0 flex shrink-0 items-center rounded-full border border-amber-600/30 bg-[#f59e0b] text-black shadow-sm transition-colors hover:bg-[#e69008] focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-background',
                compact ? 'h-7 min-w-[66px] gap-1 px-2 text-[9px] font-black' : '-me-2 h-6 min-w-20 gap-1 pe-4 ps-2 text-[10px] font-bold',
                className
            )}
        >
            <CircleDollarSign className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
            <span className="tabular-nums">{amount}</span>
            {!compact && <span className="text-[8px] font-black">{summary.currency}</span>}
        </button>
    )
}

export function WorkspaceUsageModal({
    open,
    onOpenChange,
    usageMeter,
    onRefresh,
    isRefreshing,
    paygSummary
}: WorkspaceUsageModalProps) {
    const { t, i18n } = useTranslation()

    if (!usageMeter) return null

    const locale = i18n.language || 'en'
    const isRtl = i18n.dir() === 'rtl'
    const { details } = usageMeter
    const { insights } = details
    const chargedUsageLimitLabel = details.chargedUsageLimitBytes === null
        ? t('workspaceUsage.unlimited')
        : formatBytes(details.chargedUsageLimitBytes, locale)
    const chargedUsageRemainingLabel = insights.remainingChargedUsageBytes === null
        ? t('workspaceUsage.noLimit')
        : t('workspaceUsage.remainingValue', {
            value: formatBytes(insights.remainingChargedUsageBytes, locale)
        })
    const dailyBudgetLabel = insights.dailyChargedUsageBudgetBytes === null
        ? '—'
        : formatBytes(insights.dailyChargedUsageBudgetBytes, locale)
    const numberFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
    const paygAmountFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
    const paygUsageGb = Number(paygSummary?.chargedUsageGb ?? 0)
    const paygGraphUsageGb = Math.min(100, Math.max(0, paygUsageGb))
    const paygGraphData = paygSummary
        ? [
            ...paygSummary.pricingCheckpoints.map((checkpoint) => ({
                gb: checkpoint.gb,
                amountIqd: checkpoint.amountIqd,
                traversedAmount: checkpoint.gb <= paygGraphUsageGb ? checkpoint.amountIqd : null,
                protected: checkpoint.protected,
                current: false
            })),
            {
                gb: paygGraphUsageGb,
                amountIqd: Number(paygSummary.amountIqd),
                traversedAmount: Number(paygSummary.amountIqd),
                protected: false,
                current: true
            }
        ].sort((left, right) => left.gb - right.gb)
        : []
    const paygGraphMaximumIqd = Math.max(
        1,
        ...(paygSummary?.pricingCheckpoints.map((checkpoint) => checkpoint.amountIqd) ?? [0]),
    )
    const interpolationSegment = paygSummary?.pricingCheckpoints.length
        ? getPaygInterpolationSegment(paygGraphUsageGb, paygSummary.pricingCheckpoints)
        : null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent layout="structured" className="max-w-5xl">
                <DialogHeader layout="structured">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                            <div className="rounded-2xl bg-amber-500/10 p-3 text-amber-600 ring-1 ring-amber-500/20 dark:text-amber-300">
                                <Activity className="h-5 w-5" />
                            </div>
                            <div className="min-w-0">
                                <DialogTitle>
                                    {paygSummary ? t('workspaceUsage.payg.modalTitle') : t('workspaceUsage.modalTitle')}
                                </DialogTitle>
                                <DialogDescription>
                                    {paygSummary ? t('workspaceUsage.payg.modalDescription') : t('workspaceUsage.modalDescription')}
                                </DialogDescription>
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => void onRefresh()}
                            disabled={isRefreshing}
                            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-border/70 bg-background px-3 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                            title={t('common.refresh', { defaultValue: 'Refresh' })}
                            aria-label={t('common.refresh', { defaultValue: 'Refresh' })}
                        >
                            <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
                            <span className="hidden sm:inline">{t('common.refresh', { defaultValue: 'Refresh' })}</span>
                        </button>
                    </div>
                </DialogHeader>

                <DialogBody className="space-y-5">
                    {paygSummary && (
                        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-4 shadow-sm sm:p-5">
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                <UsageStatCard
                                    icon={<Activity className="h-4 w-4" />}
                                    label={t('workspaceUsage.payg.chargedUsage')}
                                    value={`${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(paygUsageGb)} GB`}
                                    detail={t('workspaceUsage.payg.nativeCounter')}
                                    toneClassName="bg-amber-500/15 text-amber-800 dark:text-amber-200"
                                />
                                <UsageStatCard
                                    icon={<CircleDollarSign className="h-4 w-4" />}
                                    label={paygSummary.cycleStatus === 'awaiting_payment'
                                        ? t('workspaceUsage.payg.amountDue')
                                        : t('workspaceUsage.payg.accruedCharge')}
                                    value={`${paygAmountFormatter.format(Number(paygSummary.amountIqd))} IQD`}
                                    detail={t('workspaceUsage.payg.roundingHint')}
                                    toneClassName="bg-amber-500/15 text-amber-800 dark:text-amber-200"
                                />
                                <UsageStatCard
                                    icon={<CalendarDays className="h-4 w-4" />}
                                    label={t('workspaceUsage.payg.renewalDue')}
                                    value={formatTimestamp(paygSummary.renewalDueAt, locale)}
                                    detail={t('workspaceUsage.payg.cycleStarted', {
                                        value: formatTimestamp(paygSummary.cycleStartedAt, locale)
                                    })}
                                    toneClassName="bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                />
                                <UsageStatCard
                                    icon={<Gauge className="h-4 w-4" />}
                                    label={t('workspaceUsage.payg.pricingProfile')}
                                    value={paygSummary.pricingProfileName ?? t('workspaceUsage.payg.pricingProfileFallback', { version: paygSummary.pricingVersion ?? '—' })}
                                    detail={t('workspaceUsage.payg.pricingFrozen')}
                                    toneClassName="bg-violet-500/10 text-violet-700 dark:text-violet-300"
                                />
                            </div>

                            <div className="mt-5 min-w-0 rounded-2xl border border-border/60 bg-background p-4">
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-sm font-bold">{t('workspaceUsage.payg.graphTitle')}</h3>
                                        <p className="mt-1 text-xs text-muted-foreground">{t('workspaceUsage.payg.graphDescription')}</p>
                                    </div>
                                    <span className="rounded-full bg-[#f59e0b] px-3 py-1.5 text-xs font-black text-black">
                                        {new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(paygUsageGb)} GB · {paygAmountFormatter.format(Number(paygSummary.amountIqd))} IQD
                                    </span>
                                </div>
                                <p className="mt-2 text-[11px] text-muted-foreground">
                                    {t('workspaceUsage.payg.serverLastUpdated', {
                                        value: formatTimestamp(paygSummary.lastUpdatedAt, locale)
                                    })}
                                </p>
                                <div className="mt-4 h-72 min-w-0 w-full" dir="ltr">
                                    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={1}>
                                        <ComposedChart data={paygGraphData} margin={{ top: 12, right: 12, bottom: 4, left: 4 }}>
                                            <CartesianGrid strokeDasharray="4 4" stroke="hsl(var(--border))" opacity={0.6} />
                                            <XAxis dataKey="gb" type="number" domain={[0, 100]} unit=" GB" tick={{ fontSize: 10 }} />
                                            <YAxis domain={[0, paygGraphMaximumIqd]} tickFormatter={(value) => paygAmountFormatter.format(Number(value))} tick={{ fontSize: 10 }} width={72} />
                                            <RechartsTooltip
                                                contentStyle={{
                                                    backgroundColor: 'hsl(var(--card))',
                                                    border: '1px solid hsl(var(--border))',
                                                    borderRadius: '12px'
                                                }}
                                                labelFormatter={(value) => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(Number(value))} GB`}
                                                formatter={(value) => [`${paygAmountFormatter.format(Number(value))} IQD`, t('workspaceUsage.payg.price')]}
                                            />
                                            <Area type="linear" dataKey="traversedAmount" stroke="none" fill="#f59e0b" fillOpacity={0.22} connectNulls={false} />
                                            <Line type="linear" dataKey="amountIqd" stroke="#f59e0b" strokeWidth={3} dot={{ r: 5, fill: '#f59e0b', stroke: '#111827', strokeWidth: 1.5 }} isAnimationActive={false} />
                                            <Scatter data={paygGraphData.filter((point) => point.current)} dataKey="amountIqd" fill="#111827" shape="star" />
                                        </ComposedChart>
                                    </ResponsiveContainer>
                                </div>
                            </div>

                            {interpolationSegment && (
                                <div className="mt-4 rounded-xl border border-border/60 bg-background p-4 text-sm">
                                    <div className="font-bold">{t('workspaceUsage.payg.interpolationBreakdown')}</div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {t('workspaceUsage.payg.betweenCheckpoints', {
                                            lowerGb: interpolationSegment.lower.gb,
                                            lowerAmount: paygAmountFormatter.format(interpolationSegment.lower.amountIqd),
                                            upperGb: interpolationSegment.upper.gb,
                                            upperAmount: paygAmountFormatter.format(interpolationSegment.upper.amountIqd)
                                        })}
                                    </p>
                                </div>
                            )}

                            <div className="mt-4 rounded-xl border border-border/60 bg-background p-4">
                                <h3 className="text-sm font-bold">{t('workspaceUsage.payg.historyTitle')}</h3>
                                <div className="mt-3 space-y-2">
                                    {paygSummary.history.length ? paygSummary.history.slice(0, 8).map((cycle) => (
                                        <div key={cycle.id} className="grid grid-cols-[1fr_auto] gap-3 rounded-lg border border-border/50 bg-muted/15 p-3 text-xs sm:grid-cols-[1fr_auto_auto]">
                                            <div><div className="font-semibold">{formatTimestamp(cycle.periodStartedAt, locale)}</div><div className="mt-0.5 text-muted-foreground">{cycle.pricingProfileName ?? t('workspaceUsage.payg.pricingProfileFallback', { version: cycle.pricingVersion })}</div></div>
                                            <div className="text-end font-semibold tabular-nums">{new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(cycle.chargedUsageGb))} GB<br />{paygAmountFormatter.format(Number(cycle.amountIqd))} IQD</div>
                                            <div className="col-span-2 rounded-full bg-muted px-2 py-1 text-center font-semibold sm:col-span-1">{t(`workspaceUsage.payg.statuses.${cycle.status}`)}</div>
                                        </div>
                                    )) : <p className="text-xs text-muted-foreground">{t('workspaceUsage.payg.noHistory')}</p>}
                                    {paygSummary.paymentHistory.slice(0, 8).map((payment) => (
                                        <div key={payment.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background p-3 text-xs">
                                            <div><div className="font-semibold">{t('workspaceUsage.payg.paymentSubmission')}</div><div className="mt-0.5 text-muted-foreground">{formatTimestamp(payment.createdAt, locale)}</div></div>
                                            <div className="text-end"><div className="font-semibold tabular-nums">{paygAmountFormatter.format(Number(payment.amount))} IQD</div><div className="mt-0.5 text-muted-foreground">{t(`workspacePayments.statuses.${payment.status}`)}</div></div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {paygSummary.cycleStatus === 'awaiting_payment' && (
                                <div className="mt-4 flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-background p-4 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <p className="text-sm font-bold">{t('workspaceUsage.payg.paymentSubmission')}</p>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            {paygSummary.canSubmitPayment
                                                ? t('workspaceUsage.payg.submitExactAmount')
                                                : t('workspaceUsage.payg.workspaceAdminRequired')}
                                        </p>
                                    </div>
                                    {paygSummary.canSubmitPayment && (
                                        <button
                                            type="button"
                                            onClick={openWorkspacePaymentDialog}
                                            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#f59e0b] px-4 text-sm font-black text-black hover:bg-[#e69008]"
                                        >
                                            <CircleDollarSign className="h-4 w-4" />
                                            {t('workspaceUsage.payg.submitPayment')}
                                        </button>
                                    )}
                                </div>
                            )}
                        </section>
                    )}

                    <div className="rounded-2xl border border-border/60 bg-background/80 p-4 shadow-sm backdrop-blur">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold text-muted-foreground">
                                    {t('workspaceUsage.overall')}
                                </p>
                                <p className="mt-1 text-2xl font-black tabular-nums text-foreground">
                                    {usageMeter.label}
                                </p>
                            </div>
                            <div className="text-end">
                                <p className="text-[11px] font-semibold text-muted-foreground">{t('workspaceUsage.chargedUsage')}</p>
                                <p className="text-sm font-semibold tabular-nums text-foreground">
                                    {formatBytes(details.chargedUsageBytes, locale)} / {chargedUsageLimitLabel}
                                </p>
                            </div>
                        </div>
                        {!paygSummary && <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-muted ring-1 ring-border/50">
                            <div
                                className="flex h-full transition-all duration-300"
                                style={{ width: `${Math.min(100, Math.max(0, usageMeter.percent))}%` }}
                            >
                                {usageMeter.segments.map((segment) => (
                                    <div
                                        key={segment.key}
                                        className={cn('h-full transition-all duration-300', segment.className)}
                                        style={{ width: `${segment.widthPercent}%` }}
                                    />
                                ))}
                            </div>
                        </div>}
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <UsageStatCard
                            icon={<Database className="h-4 w-4" />}
                            label={t('workspaceUsage.currentChargedUsage')}
                            value={formatBytes(details.chargedUsageBytes, locale)}
                            detail={chargedUsageRemainingLabel}
                            toneClassName="bg-amber-500/10 text-amber-700 dark:text-amber-300"
                        />
                        <UsageStatCard
                            icon={<Activity className="h-4 w-4" />}
                            label={t('workspaceUsage.averageDailyCharged')}
                            value={formatBytes(insights.averageDailyChargedUsageBytes, locale)}
                            detail={t('workspaceUsage.elapsedDaysValue', { count: insights.daysElapsed })}
                            toneClassName="bg-sky-500/10 text-sky-700 dark:text-sky-300"
                        />
                        <UsageStatCard
                            icon={<TrendingUp className="h-4 w-4" />}
                            label={t('workspaceUsage.projectedChargedUsage')}
                            value={formatBytes(insights.projectedChargedUsageBytes, locale)}
                            detail={t('workspaceUsage.projectionHint')}
                            toneClassName="bg-violet-500/10 text-violet-700 dark:text-violet-300"
                        />
                        <UsageStatCard
                            icon={<Gauge className="h-4 w-4" />}
                            label={t('workspaceUsage.dailyChargedBudget')}
                            value={dailyBudgetLabel}
                            detail={t('workspaceUsage.remainingDaysValue', { count: insights.daysRemaining })}
                            toneClassName="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        />
                    </div>

                    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.65fr)_minmax(260px,0.75fr)]">
                        <section className="min-w-0 rounded-2xl border border-border/60 bg-background p-4 shadow-sm sm:p-5">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <h3 className="text-sm font-bold text-foreground">
                                        {t('workspaceUsage.consumptionTitle')}
                                    </h3>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {t('workspaceUsage.consumptionDescription')}
                                    </p>
                                </div>
                                <div className="rounded-full bg-amber-500/10 px-3 py-1.5 text-xs font-bold tabular-nums text-amber-700 ring-1 ring-amber-500/20 dark:text-amber-300">
                                    {t('workspaceUsage.peakChargedDayValue', {
                                        value: formatBytes(insights.peakDailyChargedUsageBytes, locale)
                                    })}
                                </div>
                            </div>

                            <div className="mt-5 h-64 min-w-0 w-full" dir="ltr">
                                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={1}>
                                    <BarChart data={insights.chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                                        <CartesianGrid
                                            strokeDasharray="4 4"
                                            vertical={false}
                                            stroke="hsl(var(--border))"
                                            opacity={0.55}
                                        />
                                        <XAxis
                                            dataKey="date"
                                            axisLine={false}
                                            tickLine={false}
                                            minTickGap={24}
                                            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                                            tickFormatter={(value) => formatDay(String(value), locale)}
                                            reversed={isRtl}
                                        />
                                        <YAxis
                                            axisLine={false}
                                            tickLine={false}
                                            width={64}
                                            orientation={isRtl ? 'right' : 'left'}
                                            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                                            tickFormatter={(value) => formatCompactBytes(Number(value), locale)}
                                        />
                                        <RechartsTooltip
                                            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.45 }}
                                            contentStyle={{
                                                backgroundColor: 'hsl(var(--card))',
                                                border: '1px solid hsl(var(--border))',
                                                borderRadius: '12px',
                                                boxShadow: '0 10px 30px rgb(0 0 0 / 0.12)'
                                            }}
                                            labelFormatter={(label) => formatDay(String(label), locale, {
                                                year: 'numeric',
                                                month: 'long',
                                                day: 'numeric'
                                            })}
                                            formatter={(value) => [
                                                formatBytes(Number(value), locale),
                                                t('workspaceUsage.chargedUsage')
                                            ]}
                                        />
                                        <Bar
                                            dataKey="cumulativeChargedUsageBytes"
                                            fill="#f59e0b"
                                            radius={[5, 5, 1, 1]}
                                            maxBarSize={18}
                                            isAnimationActive={false}
                                        />
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </section>

                        <section className="rounded-2xl border border-border/60 bg-muted/20 p-4 shadow-sm sm:p-5">
                            <div className="flex items-center gap-2">
                                <CalendarDays className="h-4 w-4 text-primary" />
                                <h3 className="text-sm font-bold text-foreground">
                                    {t('workspaceUsage.periodDetails')}
                                </h3>
                            </div>
                            <dl className="mt-4 space-y-3">
                                <div className="flex items-center justify-between gap-4 border-b border-border/50 pb-3">
                                    <dt className="text-xs text-muted-foreground">{t('workspaceUsage.periodStart')}</dt>
                                    <dd className="text-xs font-bold tabular-nums text-foreground">
                                        {formatDay(details.transferPeriodStart, locale, { year: 'numeric' })}
                                    </dd>
                                </div>
                                <div className="flex items-center justify-between gap-4 border-b border-border/50 pb-3">
                                    <dt className="text-xs text-muted-foreground">{t('workspaceUsage.nextReset')}</dt>
                                    <dd className="text-xs font-bold tabular-nums text-foreground">
                                        {formatDay(insights.nextPeriodStart, locale, { year: 'numeric' })}
                                    </dd>
                                </div>
                                <div className="flex items-center justify-between gap-4 border-b border-border/50 pb-3">
                                    <dt className="text-xs text-muted-foreground">{t('workspaceUsage.localTrackingStarted')}</dt>
                                    <dd className="text-xs font-bold tabular-nums text-foreground">
                                        {formatTimestamp(insights.trackedFrom, locale)}
                                    </dd>
                                </div>
                                <div className="flex items-center justify-between gap-4">
                                    <dt className="text-xs text-muted-foreground">{t('workspaceUsage.lastUpdated')}</dt>
                                    <dd className="text-xs font-bold tabular-nums text-foreground">
                                        {formatTimestamp(insights.lastUpdatedAt, locale)}
                                    </dd>
                                </div>
                            </dl>

                        </section>
                    </div>

                    <section>
                        <div className="mb-3 flex items-center gap-2">
                            <HardDrive className="h-4 w-4 text-primary" />
                            <h3 className="text-sm font-bold text-foreground">
                                {t('workspaceUsage.currentLimits')}
                            </h3>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                            {usageMeter.metrics.map((metric) => {
                                const isStorage = metric.key === 'storage'
                                const usedLabel = isStorage
                                    ? numberFormatter.format(details.storageUnits)
                                    : formatBytes(details.chargedUsageBytes, locale)
                                const limitLabel = isStorage
                                    ? details.storageUnitLimit === null
                                        ? t('workspaceUsage.unlimited')
                                        : numberFormatter.format(details.storageUnitLimit)
                                    : chargedUsageLimitLabel

                                return (
                                    <div
                                        key={metric.key}
                                        className="rounded-2xl border border-border/60 bg-background p-4 shadow-sm"
                                    >
                                        <div className="flex items-center justify-between gap-4">
                                            <div className="min-w-0">
                                                <p className="truncate text-sm font-semibold text-foreground">
                                                    {metric.label}
                                                </p>
                                                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                                                    {t('workspaceUsage.usedOfLimit', {
                                                        used: usedLabel,
                                                        limit: limitLabel
                                                    })}
                                                </p>
                                            </div>
                                            <span className={cn(
                                                'inline-flex min-w-14 items-center justify-center rounded-full px-2.5 py-1 text-xs font-black tabular-nums ring-1',
                                                metric.badgeClassName
                                            )}>
                                                {Math.round(metric.percent)}%
                                            </span>
                                        </div>
                                        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted ring-1 ring-border/50">
                                            <div
                                                className={cn('h-full rounded-full transition-all duration-300', metric.barClassName)}
                                                style={{ width: `${Math.min(100, Math.max(0, metric.percent))}%` }}
                                            />
                                        </div>
                                        {isStorage && (
                                            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                                <Database className="h-3 w-3" />
                                                {t('workspaceUsage.storageRecords', { count: details.storageUnits })}
                                            </p>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </section>
                </DialogBody>
            </DialogContent>
        </Dialog>
    )
}
