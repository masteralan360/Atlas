import { useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
    ArrowDown,
    ArrowDownLeft,
    ArrowUpRight,
    Check,
    ChevronDown,
    ChevronUp,
    CircleDollarSign,
    EyeOff,
    HandCoins,
    Landmark,
    Layers3,
    Loader2,
    LockKeyhole,
    Minus,
    Plus,
    ReceiptText,
    RotateCcw,
    Settings2,
    Undo2,
    WalletCards,
} from 'lucide-react'

import {
    DEFAULT_LEDGER_DASHBOARD_CONFIG,
    LEDGER_CASH_GROUP_IDS,
    getLedgerCashGroupEntryCount,
    normalizeLedgerDashboardConfig,
    type LedgerCashDrilldownId,
    type LedgerCashCurrencySummary,
    type LedgerCashGroupId,
    type LedgerCashSummary,
    type LedgerDashboardConfig,
} from '@/lib/ledgerCashSummary'
import { cn, formatCurrency } from '@/lib/utils'
import type { CurrencyCode, IQDDisplayPreference } from '@/local-db'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogDescription,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/ui/components'

interface LedgerCashSummaryDashboardProps {
    summaries: readonly LedgerCashCurrencySummary<CurrencyCode>[]
    iqdPreference: IQDDisplayPreference
    activeDrilldown: LedgerCashDrilldownId | null
    isLoading: boolean
    config: LedgerDashboardConfig
    eligibleGroups: LedgerCashGroupId[]
    enabledGroups: LedgerCashGroupId[]
    onSaveConfig: (config: LedgerDashboardConfig) => Promise<void>
    onDrilldown: (drilldownId: LedgerCashDrilldownId) => void
}

type MetricTone = 'incoming' | 'outgoing' | 'result' | 'neutral'

interface CurrencyAmount {
    currency: CurrencyCode
    amount: number
}

interface MetricCardProps {
    title: string
    description: string
    amounts: readonly CurrencyAmount[]
    iqdPreference: IQDDisplayPreference
    icon: ComponentType<{ className?: string }>
    tone: MetricTone
    result?: boolean
    resultLabel?: string
    selected?: boolean
    onClick: () => void
}

const GROUP_ICONS: Record<LedgerCashGroupId, ComponentType<{ className?: string }>> = {
    operating: ReceiptText,
    borrowing: Landmark,
    lending: HandCoins,
}

function getGroupAmount(summary: LedgerCashSummary, groupId: LedgerCashGroupId) {
    if (groupId === 'operating') return summary.cashOperatingSurplus
    if (groupId === 'borrowing') return summary.netBorrowingMovement
    return summary.netLendingMovement
}

function getGroupEntryCount(
    summaries: readonly LedgerCashCurrencySummary<CurrencyCode>[],
    groupId: LedgerCashGroupId,
) {
    return summaries.reduce((total, { summary }) => total + getLedgerCashGroupEntryCount(summary, groupId), 0)
}

type SummaryAmountSelector = (summary: LedgerCashSummary) => number

function getCurrencyAmounts(
    summaries: readonly LedgerCashCurrencySummary<CurrencyCode>[],
    selectAmount: SummaryAmountSelector,
): CurrencyAmount[] {
    return summaries.map(({ currency, summary }) => ({ currency, amount: selectAmount(summary) }))
}

function getCurrencyDisplayLabel(currency: CurrencyCode, iqdPreference: IQDDisplayPreference) {
    return currency === 'iqd' ? iqdPreference : currency.toUpperCase()
}

function CurrencyAmountLines({
    amounts,
    iqdPreference,
    size = 'card',
}: {
    amounts: readonly CurrencyAmount[]
    iqdPreference: IQDDisplayPreference
    size?: 'hero' | 'card' | 'compact'
}) {
    return (
        <span className={cn('grid', size === 'compact' ? 'gap-1' : 'gap-2')}>
            {amounts.map(({ currency, amount }) => (
                <span
                    key={currency}
                    className={cn(
                        'flex min-w-0 items-baseline justify-between gap-3 rounded-xl border border-current/10 bg-background/55',
                        size === 'hero' ? 'px-3 py-2' : size === 'card' ? 'px-2.5 py-2' : 'border-0 bg-transparent px-0 py-0',
                    )}
                >
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-muted-foreground">
                        {getCurrencyDisplayLabel(currency, iqdPreference)}
                    </span>
                    <span
                        className={cn(
                            'min-w-0 break-words text-end font-black tabular-nums tracking-tight',
                            size === 'hero' ? 'text-2xl sm:text-3xl' : size === 'card' ? 'text-lg sm:text-xl' : 'text-sm',
                            amount < 0 ? 'text-rose-600' : 'text-foreground',
                        )}
                    >
                        {formatCurrency(amount, currency, iqdPreference)}
                    </span>
                </span>
            ))}
        </span>
    )
}

function moveGroup(config: LedgerDashboardConfig, groupId: LedgerCashGroupId, direction: -1 | 1) {
    const currentIndex = config.groupOrder.indexOf(groupId)
    const nextIndex = currentIndex + direction
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= config.groupOrder.length) return config

    const groupOrder = [...config.groupOrder]
    ;[groupOrder[currentIndex], groupOrder[nextIndex]] = [groupOrder[nextIndex], groupOrder[currentIndex]]
    return { ...config, groupOrder }
}

function MetricCard({
    title,
    description,
    amounts,
    iqdPreference,
    icon: Icon,
    tone,
    result = false,
    resultLabel,
    selected = false,
    onClick,
}: MetricCardProps) {
    const toneClasses: Record<MetricTone, string> = {
        incoming: 'border-emerald-500/20 bg-emerald-500/[0.035] hover:border-emerald-500/45',
        outgoing: 'border-amber-500/20 bg-amber-500/[0.035] hover:border-amber-500/45',
        result: 'border-primary/35 bg-primary/[0.055] hover:border-primary/60',
        neutral: 'border-border/60 bg-card hover:border-primary/35',
    }
    const iconClasses: Record<MetricTone, string> = {
        incoming: 'bg-emerald-500/10 text-emerald-600',
        outgoing: 'bg-amber-500/10 text-amber-600',
        result: 'bg-primary/10 text-primary',
        neutral: 'bg-muted text-muted-foreground',
    }

    return (
        <button
            type="button"
            className={cn(
                'group min-h-40 w-full rounded-3xl border p-5 text-start shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                toneClasses[tone],
                result && 'ring-1 ring-primary/10',
                selected && 'border-primary bg-primary/[0.12] ring-2 ring-primary/45 shadow-md shadow-primary/10',
            )}
            onClick={onClick}
            aria-label={title}
            aria-pressed={selected}
        >
            <span className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                    <span className="block text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">{title}</span>
                    {result ? (
                        <span className="mt-1 inline-flex rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                            {resultLabel}
                        </span>
                    ) : null}
                </span>
                <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl', iconClasses[tone])}>
                    <Icon className="h-4 w-4" />
                </span>
            </span>
            <span className="mt-5 block">
                <CurrencyAmountLines amounts={amounts} iqdPreference={iqdPreference} />
            </span>
            <span className="mt-3 block text-xs leading-relaxed text-muted-foreground">{description}</span>
        </button>
    )
}

function FormulaOperator({ symbol }: { symbol: '−' | '=' | '+' }) {
    return (
        <div className="flex h-8 items-center justify-center md:h-auto" aria-hidden="true">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background text-lg font-black text-muted-foreground shadow-sm">
                {symbol}
            </span>
        </div>
    )
}

function FormulaRow({ children }: { children: ReactNode }) {
    return <div className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_2.25rem_minmax(0,1fr)_2.25rem_minmax(0,1fr)]">{children}</div>
}

function CalculationConnector({ label }: { label: string }) {
    return (
        <div className="relative my-2 h-16 md:h-12" role="img" aria-label={label}>
            <svg
                className="hidden h-full w-full overflow-visible md:block rtl:-scale-x-100"
                viewBox="0 0 1000 48"
                preserveAspectRatio="none"
                aria-hidden="true"
            >
                <path
                    d="M 835 1 V 15 Q 835 20 830 20 H 170 Q 165 20 165 25 V 39"
                    className="fill-none stroke-primary/65"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                />
                <path
                    d="M 158 32 L 165 40 L 172 32"
                    className="fill-none stroke-primary/65"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                />
            </svg>
            <div className="pointer-events-none absolute inset-x-0 top-5 hidden -translate-y-1/2 items-center justify-center md:flex" aria-hidden="true">
                <span className="bg-card px-3 text-[9px] font-black uppercase tracking-[0.12em] text-primary">
                    {label}
                </span>
            </div>
            <div className="relative flex h-full items-center justify-center md:hidden" aria-hidden="true">
                <span className="absolute inset-y-0 start-1/2 w-0.5 -translate-x-1/2 rounded-full bg-primary/65 rtl:translate-x-1/2" />
                <span className="relative hidden bg-card px-2 text-center text-[9px] font-black uppercase tracking-[0.08em] text-primary min-[360px]:inline-flex">
                    {label}
                </span>
                <span className="absolute bottom-0 start-1/2 h-2 w-2 -translate-x-1/2 -translate-y-0.5 rotate-45 border-b-2 border-r-2 border-primary/65 rtl:translate-x-1/2" />
            </div>
        </div>
    )
}

interface GroupFrameProps {
    title: string
    description: string
    icon: ComponentType<{ className?: string }>
    children: ReactNode
}

function GroupFrame({ title, description, icon: Icon, children }: GroupFrameProps) {
    return (
        <section className="rounded-[2rem] border border-border/60 bg-card/45 p-3 shadow-sm sm:p-5">
            <div className="mb-4 flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                </span>
                <div>
                    <h2 className="font-bold tracking-tight">{title}</h2>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
                </div>
            </div>
            {children}
        </section>
    )
}

interface CalculationGroupProps {
    groupId: LedgerCashGroupId
    summaries: readonly LedgerCashCurrencySummary<CurrencyCode>[]
    iqdPreference: IQDDisplayPreference
    activeDrilldown: LedgerCashDrilldownId | null
    onDrilldown: (drilldownId: LedgerCashDrilldownId) => void
}

function CalculationGroup({ groupId, summaries, iqdPreference, activeDrilldown, onDrilldown }: CalculationGroupProps) {
    const { t } = useTranslation()

    if (groupId === 'operating') {
        return (
            <GroupFrame
                title={t('ledger.cashSummary.groups.operating.title')}
                description={t('ledger.cashSummary.groups.operating.description')}
                icon={ReceiptText}
            >
                <FormulaRow>
                    <MetricCard
                        title={t('ledger.cashSummary.metrics.cashRevenueReceived.title')}
                        description={t('ledger.cashSummary.metrics.cashRevenueReceived.description')}
                        amounts={getCurrencyAmounts(summaries, (summary) => summary.buckets.cashRevenueReceived.amount)}
                        iqdPreference={iqdPreference}
                        icon={ArrowDownLeft}
                        tone="incoming"
                        selected={activeDrilldown === 'cashRevenueReceived'}
                        onClick={() => onDrilldown('cashRevenueReceived')}
                    />
                    <FormulaOperator symbol="−" />
                    <MetricCard
                        title={t('ledger.cashSummary.metrics.cashRefundsPaid.title')}
                        description={t('ledger.cashSummary.metrics.cashRefundsPaid.description')}
                        amounts={getCurrencyAmounts(summaries, (summary) => summary.buckets.cashRefundsPaid.amount)}
                        iqdPreference={iqdPreference}
                        icon={Undo2}
                        tone="outgoing"
                        selected={activeDrilldown === 'cashRefundsPaid'}
                        onClick={() => onDrilldown('cashRefundsPaid')}
                    />
                    <FormulaOperator symbol="=" />
                    <MetricCard
                        title={t('ledger.cashSummary.metrics.netCashRevenue.title')}
                        description={t('ledger.cashSummary.metrics.netCashRevenue.description')}
                        amounts={getCurrencyAmounts(summaries, (summary) => summary.netCashRevenue)}
                        iqdPreference={iqdPreference}
                        icon={WalletCards}
                        tone="result"
                        result
                        resultLabel={t('ledger.cashSummary.result')}
                        selected={activeDrilldown === 'netCashRevenue'}
                        onClick={() => onDrilldown('netCashRevenue')}
                    />
                </FormulaRow>

                <CalculationConnector label={t('ledger.cashSummary.feedsNext')} />

                <FormulaRow>
                    <MetricCard
                        title={t('ledger.cashSummary.metrics.netCashRevenue.title')}
                        description={t('ledger.cashSummary.fromPreviousCalculation')}
                        amounts={getCurrencyAmounts(summaries, (summary) => summary.netCashRevenue)}
                        iqdPreference={iqdPreference}
                        icon={ArrowDown}
                        tone="neutral"
                        selected={activeDrilldown === 'netCashRevenue'}
                        onClick={() => onDrilldown('netCashRevenue')}
                    />
                    <FormulaOperator symbol="−" />
                    <MetricCard
                        title={t('ledger.cashSummary.metrics.operatingCashPaid.title')}
                        description={t('ledger.cashSummary.metrics.operatingCashPaid.description')}
                        amounts={getCurrencyAmounts(summaries, (summary) => summary.buckets.operatingCashPaid.amount)}
                        iqdPreference={iqdPreference}
                        icon={ArrowUpRight}
                        tone="outgoing"
                        selected={activeDrilldown === 'operatingCashPaid'}
                        onClick={() => onDrilldown('operatingCashPaid')}
                    />
                    <FormulaOperator symbol="=" />
                    <MetricCard
                        title={t('ledger.cashSummary.metrics.cashOperatingSurplus.title')}
                        description={t('ledger.cashSummary.metrics.cashOperatingSurplus.description')}
                        amounts={getCurrencyAmounts(summaries, (summary) => summary.cashOperatingSurplus)}
                        iqdPreference={iqdPreference}
                        icon={CircleDollarSign}
                        tone="result"
                        result
                        resultLabel={t('ledger.cashSummary.result')}
                        selected={activeDrilldown === 'operating'}
                        onClick={() => onDrilldown('operating')}
                    />
                </FormulaRow>
            </GroupFrame>
        )
    }

    if (groupId === 'borrowing') {
        return (
            <GroupFrame
                title={t('ledger.cashSummary.groups.borrowing.title')}
                description={t('ledger.cashSummary.groups.borrowing.description')}
                icon={Landmark}
            >
                <FormulaRow>
                    <MetricCard
                        title={t('ledger.cashSummary.metrics.loansReceived.title')}
                        description={t('ledger.cashSummary.metrics.loansReceived.description')}
                        amounts={getCurrencyAmounts(summaries, (summary) => summary.buckets.loansReceived.amount)}
                        iqdPreference={iqdPreference}
                        icon={ArrowDownLeft}
                        tone="incoming"
                        selected={activeDrilldown === 'loansReceived'}
                        onClick={() => onDrilldown('loansReceived')}
                    />
                    <FormulaOperator symbol="−" />
                    <MetricCard
                        title={t('ledger.cashSummary.metrics.loanRepaymentsPaid.title')}
                        description={t('ledger.cashSummary.metrics.loanRepaymentsPaid.description')}
                        amounts={getCurrencyAmounts(summaries, (summary) => summary.buckets.loanRepaymentsPaid.amount)}
                        iqdPreference={iqdPreference}
                        icon={ArrowUpRight}
                        tone="outgoing"
                        selected={activeDrilldown === 'loanRepaymentsPaid'}
                        onClick={() => onDrilldown('loanRepaymentsPaid')}
                    />
                    <FormulaOperator symbol="=" />
                    <MetricCard
                        title={t('ledger.cashSummary.metrics.netBorrowingMovement.title')}
                        description={t('ledger.cashSummary.metrics.netBorrowingMovement.description')}
                        amounts={getCurrencyAmounts(summaries, (summary) => summary.netBorrowingMovement)}
                        iqdPreference={iqdPreference}
                        icon={Landmark}
                        tone="result"
                        result
                        resultLabel={t('ledger.cashSummary.result')}
                        selected={activeDrilldown === 'borrowing'}
                        onClick={() => onDrilldown('borrowing')}
                    />
                </FormulaRow>
            </GroupFrame>
        )
    }

    return (
        <GroupFrame
            title={t('ledger.cashSummary.groups.lending.title')}
            description={t('ledger.cashSummary.groups.lending.description')}
            icon={HandCoins}
        >
            <FormulaRow>
                <MetricCard
                    title={t('ledger.cashSummary.metrics.repaymentsCollected.title')}
                    description={t('ledger.cashSummary.metrics.repaymentsCollected.description')}
                    amounts={getCurrencyAmounts(summaries, (summary) => summary.buckets.repaymentsCollected.amount)}
                    iqdPreference={iqdPreference}
                    icon={ArrowDownLeft}
                    tone="incoming"
                    selected={activeDrilldown === 'repaymentsCollected'}
                    onClick={() => onDrilldown('repaymentsCollected')}
                />
                <FormulaOperator symbol="−" />
                <MetricCard
                    title={t('ledger.cashSummary.metrics.loansAdvanced.title')}
                    description={t('ledger.cashSummary.metrics.loansAdvanced.description')}
                    amounts={getCurrencyAmounts(summaries, (summary) => summary.buckets.loansAdvanced.amount)}
                    iqdPreference={iqdPreference}
                    icon={ArrowUpRight}
                    tone="outgoing"
                    selected={activeDrilldown === 'loansAdvanced'}
                    onClick={() => onDrilldown('loansAdvanced')}
                />
                <FormulaOperator symbol="=" />
                <MetricCard
                    title={t('ledger.cashSummary.metrics.netLendingMovement.title')}
                    description={t('ledger.cashSummary.metrics.netLendingMovement.description')}
                    amounts={getCurrencyAmounts(summaries, (summary) => summary.netLendingMovement)}
                    iqdPreference={iqdPreference}
                    icon={HandCoins}
                    tone="result"
                    result
                    resultLabel={t('ledger.cashSummary.result')}
                    selected={activeDrilldown === 'lending'}
                    onClick={() => onDrilldown('lending')}
                />
            </FormulaRow>
        </GroupFrame>
    )
}

interface ContributionChipProps {
    label: string
    amounts: readonly CurrencyAmount[]
    iqdPreference: IQDDisplayPreference
    hidden?: boolean
    selected?: boolean
}

function ContributionChip({ label, amounts, iqdPreference, hidden = false, selected = false }: ContributionChipProps) {
    return (
        <div
            className={cn(
                'min-w-[11rem] flex-1 rounded-2xl border border-border/60 bg-background/70 p-3 transition-colors',
                selected && 'border-primary bg-primary/[0.10] ring-2 ring-primary/35',
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
                {hidden ? <EyeOff className="h-3.5 w-3.5 text-muted-foreground" /> : null}
            </div>
            <div className="mt-2">
                <CurrencyAmountLines amounts={amounts} iqdPreference={iqdPreference} size="compact" />
            </div>
        </div>
    )
}

export function LedgerCashSummaryDashboard({
    summaries,
    iqdPreference,
    activeDrilldown,
    isLoading,
    config,
    eligibleGroups,
    enabledGroups,
    onSaveConfig,
    onDrilldown,
}: LedgerCashSummaryDashboardProps) {
    const { t } = useTranslation()
    const [isCustomizeOpen, setIsCustomizeOpen] = useState(false)
    const [isBreakdownOpen, setIsBreakdownOpen] = useState(false)
    const [draftConfig, setDraftConfig] = useState(() => normalizeLedgerDashboardConfig(config))
    const [isSaving, setIsSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const normalizedConfig = normalizeLedgerDashboardConfig(config)
    const eligibleSet = new Set(eligibleGroups)
    const enabledSet = new Set(enabledGroups)
    const visibleGroups = normalizedConfig.groupOrder.filter(
        (groupId) => eligibleSet.has(groupId) && !normalizedConfig.hiddenGroups.includes(groupId),
    )
    const completedEntryCount = summaries.reduce((total, { summary }) => total + summary.completedEntryCount, 0)
    const hasCompletedMovements = completedEntryCount > 0
    const headlineAmounts = getCurrencyAmounts(summaries, (summary) => summary.netRecordedCashMovement)
    const hasOtherCompletedMovement = summaries.some(({ summary }) => summary.buckets.otherCompletedMovement.entryCount > 0)

    const openCustomize = () => {
        setDraftConfig(normalizedConfig)
        setSaveError(null)
        setIsCustomizeOpen(true)
    }

    const toggleDraftGroup = (groupId: LedgerCashGroupId) => {
        if (groupId === 'operating' || !eligibleSet.has(groupId)) return
        setDraftConfig((current) => ({
            ...current,
            hiddenGroups: current.hiddenGroups.includes(groupId)
                ? current.hiddenGroups.filter((hiddenGroup) => hiddenGroup !== groupId)
                : [...current.hiddenGroups, groupId],
        }))
    }

    const handleSave = async () => {
        setIsSaving(true)
        setSaveError(null)
        try {
            await onSaveConfig(normalizeLedgerDashboardConfig(draftConfig))
            setIsCustomizeOpen(false)
        } catch (error) {
            console.error('[Ledger] Failed to save cash summary configuration:', error)
            setSaveError(t('ledger.cashSummary.customize.saveError'))
        } finally {
            setIsSaving(false)
        }
    }

    const handleRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onDrilldown('netRecordedCashMovement')
        }
    }

    return (
        <div className="space-y-4" aria-busy={isLoading}>
            <Card
                className={cn(
                    'relative overflow-hidden rounded-[2rem] border-primary/30 bg-gradient-to-br from-primary/[0.09] via-card to-card shadow-sm',
                    isLoading && 'animate-pulse',
                    activeDrilldown === 'netRecordedCashMovement' && 'ring-2 ring-primary/50 shadow-md shadow-primary/10',
                )}
            >
                <div className="pointer-events-none absolute -end-10 -top-12 opacity-[0.055]">
                    <Layers3 className="h-52 w-52" />
                </div>
                <CardHeader className="relative flex-col items-stretch justify-between gap-4 pb-2 sm:flex-row sm:items-start">
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <CardTitle className="text-sm font-black uppercase tracking-[0.14em] text-primary">
                                {t('ledger.cashSummary.headline.title')}
                            </CardTitle>
                            {summaries.length > 1 ? (
                                <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                                    {t('ledger.cashSummary.currencySeparated')}
                                </span>
                            ) : null}
                        </div>
                        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
                            {t('ledger.cashSummary.headline.description')}
                        </p>
                    </div>
                    <Button type="button" variant="outline" size="sm" className="w-full shrink-0 rounded-xl sm:w-auto" onClick={openCustomize}>
                        <Settings2 className="me-2 h-4 w-4" />
                        {t('ledger.cashSummary.customize.action')}
                    </Button>
                </CardHeader>
                <CardContent className="relative pt-2">
                    <div
                        role="button"
                        tabIndex={0}
                        className="w-fit cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        onClick={() => onDrilldown('netRecordedCashMovement')}
                        onKeyDown={handleRootKeyDown}
                        aria-pressed={activeDrilldown === 'netRecordedCashMovement'}
                    >
                        <div className="min-w-[min(100%,22rem)]">
                            <CurrencyAmountLines amounts={headlineAmounts} iqdPreference={iqdPreference} size="hero" />
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                            {summaries.length > 1 ? <Layers3 className="h-4 w-4 text-primary" /> : getMovementDirectionIcon(headlineAmounts[0]?.amount ?? 0)}
                            {hasCompletedMovements
                                ? t('ledger.cashSummary.completedMovementCount', { count: completedEntryCount })
                                : t('ledger.cashSummary.noCompletedMovements')}
                        </div>
                    </div>

                    <div className="mt-5 flex flex-wrap items-stretch gap-2">
                        <ContributionChip
                            label={t('ledger.cashSummary.metrics.cashOperatingSurplus.title')}
                            amounts={getCurrencyAmounts(summaries, (summary) => summary.cashOperatingSurplus)}
                            iqdPreference={iqdPreference}
                            selected={activeDrilldown === 'operating'}
                        />
                        {eligibleSet.has('borrowing') ? (
                            <FormulaOperator symbol="+" />
                        ) : null}
                        {eligibleSet.has('borrowing') ? (
                            <ContributionChip
                                label={t('ledger.cashSummary.metrics.netBorrowingMovement.title')}
                                amounts={getCurrencyAmounts(summaries, (summary) => summary.netBorrowingMovement)}
                                iqdPreference={iqdPreference}
                                hidden={normalizedConfig.hiddenGroups.includes('borrowing')}
                                selected={activeDrilldown === 'borrowing'}
                            />
                        ) : null}
                        {eligibleSet.has('lending') ? <FormulaOperator symbol="+" /> : null}
                        {eligibleSet.has('lending') ? (
                            <ContributionChip
                                label={t('ledger.cashSummary.metrics.netLendingMovement.title')}
                                amounts={getCurrencyAmounts(summaries, (summary) => summary.netLendingMovement)}
                                iqdPreference={iqdPreference}
                                hidden={normalizedConfig.hiddenGroups.includes('lending')}
                                selected={activeDrilldown === 'lending'}
                            />
                        ) : null}
                        {hasOtherCompletedMovement ? <FormulaOperator symbol="+" /> : null}
                        {hasOtherCompletedMovement ? (
                            <ContributionChip
                                label={t('ledger.cashSummary.metrics.otherCompletedMovement.title')}
                                amounts={getCurrencyAmounts(summaries, (summary) => summary.buckets.otherCompletedMovement.amount)}
                                iqdPreference={iqdPreference}
                                selected={activeDrilldown === 'otherCompletedMovement'}
                            />
                        ) : null}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-4">
                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                            <CircleDollarSign className="h-4 w-4 text-primary" />
                            {t('ledger.cashSummary.notAccountingProfit')}
                        </p>
                        <Button type="button" variant="ghost" size="sm" className="rounded-xl" onClick={() => setIsBreakdownOpen(true)}>
                            <Layers3 className="me-2 h-4 w-4" />
                            {t('ledger.cashSummary.breakdown.action')}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {visibleGroups.map((groupId) => (
                <CalculationGroup
                    key={groupId}
                    groupId={groupId}
                    summaries={summaries}
                    iqdPreference={iqdPreference}
                    activeDrilldown={activeDrilldown}
                    onDrilldown={onDrilldown}
                />
            ))}

            <AppDialog open={isBreakdownOpen} onOpenChange={setIsBreakdownOpen}>
                <AppDialogContent className="max-w-2xl">
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <Layers3 className="h-5 w-5 text-primary" />
                            {t('ledger.cashSummary.breakdown.title')}
                        </AppDialogTitle>
                        <AppDialogDescription>{t('ledger.cashSummary.breakdown.description')}</AppDialogDescription>
                    </AppDialogHeader>
                    <AppDialogBody className="space-y-3">
                        {LEDGER_CASH_GROUP_IDS.map((groupId) => {
                            const Icon = GROUP_ICONS[groupId]
                            const isEligible = eligibleSet.has(groupId)
                            const isHidden = normalizedConfig.hiddenGroups.includes(groupId)
                            const isSelected = activeDrilldown === groupId
                            return (
                                <button
                                    key={groupId}
                                    type="button"
                                    className={cn(
                                        'flex w-full items-center gap-3 rounded-2xl border border-border/60 p-4 text-start transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50',
                                        isSelected && 'border-primary bg-primary/[0.10] ring-2 ring-primary/35',
                                    )}
                                    disabled={!isEligible}
                                    aria-pressed={isSelected}
                                    onClick={() => {
                                        setIsBreakdownOpen(false)
                                        onDrilldown(groupId)
                                    }}
                                >
                                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                                        <Icon className="h-4 w-4" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex flex-wrap items-center gap-2 font-bold">
                                            {t(`ledger.cashSummary.groups.${groupId}.title`)}
                                            {isHidden ? (
                                                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                                                    {t('ledger.cashSummary.customize.hidden')}
                                                </span>
                                            ) : null}
                                        </span>
                                        <span className="mt-0.5 block text-xs text-muted-foreground">
                                            {isEligible
                                                ? t('ledger.cashSummary.completedMovementCount', {
                                                      count: getGroupEntryCount(summaries, groupId),
                                                  })
                                                : t('ledger.cashSummary.customize.noCompletedData')}
                                        </span>
                                    </span>
                                    <span className="shrink-0">
                                        <CurrencyAmountLines
                                            amounts={getCurrencyAmounts(summaries, (summary) => getGroupAmount(summary, groupId))}
                                            iqdPreference={iqdPreference}
                                            size="compact"
                                        />
                                    </span>
                                </button>
                            )
                        })}

                        <button
                            type="button"
                            className={cn(
                                'flex w-full items-center gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.04] p-4 text-start transition-colors hover:bg-amber-500/[0.08]',
                                activeDrilldown === 'otherCompletedMovement' && 'border-primary bg-primary/[0.10] ring-2 ring-primary/35',
                            )}
                            aria-pressed={activeDrilldown === 'otherCompletedMovement'}
                            onClick={() => {
                                setIsBreakdownOpen(false)
                                onDrilldown('otherCompletedMovement')
                            }}
                        >
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
                                <WalletCards className="h-4 w-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="font-bold">{t('ledger.cashSummary.metrics.otherCompletedMovement.title')}</span>
                                <span className="mt-0.5 block text-xs text-muted-foreground">
                                    {t('ledger.cashSummary.metrics.otherCompletedMovement.description')}
                                </span>
                            </span>
                            <span className="shrink-0">
                                <CurrencyAmountLines
                                    amounts={getCurrencyAmounts(summaries, (summary) => summary.buckets.otherCompletedMovement.amount)}
                                    iqdPreference={iqdPreference}
                                    size="compact"
                                />
                            </span>
                        </button>

                        <div className="rounded-2xl bg-muted/55 p-4 text-xs leading-relaxed text-muted-foreground">
                            {t('ledger.cashSummary.breakdown.accountingNote')}
                        </div>
                    </AppDialogBody>
                    <AppDialogFooter>
                        <Button type="button" variant="outline" onClick={() => setIsBreakdownOpen(false)}>
                            {t('common.close')}
                        </Button>
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>

            <AppDialog open={isCustomizeOpen} onOpenChange={(open) => !isSaving && setIsCustomizeOpen(open)}>
                <AppDialogContent
                    className="max-w-3xl"
                    showCloseButton={!isSaving}
                    onPointerDownOutside={(event) => isSaving && event.preventDefault()}
                    onEscapeKeyDown={(event) => isSaving && event.preventDefault()}
                >
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <Settings2 className="h-5 w-5 text-primary" />
                            {t('ledger.cashSummary.customize.title')}
                        </AppDialogTitle>
                        <AppDialogDescription>{t('ledger.cashSummary.customize.description')}</AppDialogDescription>
                    </AppDialogHeader>
                    <AppDialogBody>
                        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                            {draftConfig.groupOrder.map((groupId, index) => {
                                const Icon = GROUP_ICONS[groupId]
                                const isEligible = eligibleSet.has(groupId)
                                const isHidden = draftConfig.hiddenGroups.includes(groupId)
                                const isFixed = groupId === 'operating'
                                const isSelected = isFixed || (isEligible && !isHidden)
                                const wasEnabled = enabledSet.has(groupId)

                                return (
                                    <div
                                        key={groupId}
                                        className={cn(
                                            'relative flex min-h-52 flex-col rounded-3xl border p-4 transition-colors',
                                            isSelected ? 'border-primary/45 bg-primary/[0.055]' : 'border-dashed border-border bg-muted/20',
                                            !isEligible && !isFixed && 'opacity-65',
                                        )}
                                    >
                                        <button
                                            type="button"
                                            className="flex flex-1 flex-col text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            disabled={isFixed || !isEligible || isSaving}
                                            onClick={() => toggleDraftGroup(groupId)}
                                        >
                                            <span className="flex items-start justify-between gap-3">
                                                <span className={cn('flex h-10 w-10 items-center justify-center rounded-2xl', isSelected ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
                                                    <Icon className="h-5 w-5" />
                                                </span>
                                                <span
                                                    className={cn(
                                                        'flex h-7 min-w-7 items-center justify-center rounded-full border',
                                                        isSelected
                                                            ? 'border-primary/25 bg-primary text-primary-foreground'
                                                            : 'border-border bg-background text-muted-foreground',
                                                    )}
                                                >
                                                    {isFixed ? <LockKeyhole className="h-3.5 w-3.5" /> : isSelected ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                                                </span>
                                            </span>
                                            <span className="mt-4 font-bold">{t(`ledger.cashSummary.groups.${groupId}.title`)}</span>
                                            <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                                {t(`ledger.cashSummary.groups.${groupId}.formula`)}
                                            </span>
                                            <span className="mt-auto pt-4 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                                                {isFixed
                                                    ? t('ledger.cashSummary.customize.alwaysShown')
                                                    : !isEligible
                                                      ? t('ledger.cashSummary.customize.noCompletedData')
                                                      : !wasEnabled
                                                        ? t('ledger.cashSummary.customize.historicalData')
                                                        : isSelected
                                                          ? t('ledger.cashSummary.customize.shown')
                                                          : t('ledger.cashSummary.customize.hidden')}
                                            </span>
                                        </button>

                                        <div className="mt-3 flex justify-end gap-1 border-t border-border/50 pt-3">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8"
                                                disabled={index === 0 || isSaving}
                                                onClick={() => setDraftConfig((current) => moveGroup(current, groupId, -1))}
                                                aria-label={t('ledger.cashSummary.customize.moveUp')}
                                            >
                                                <ChevronUp className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8"
                                                disabled={index === draftConfig.groupOrder.length - 1 || isSaving}
                                                onClick={() => setDraftConfig((current) => moveGroup(current, groupId, 1))}
                                                aria-label={t('ledger.cashSummary.customize.moveDown')}
                                            >
                                                <ChevronDown className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>

                        <div className="mt-4 rounded-2xl border border-border/60 bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground">
                            {t('ledger.cashSummary.customize.accountingGuardrail')}
                        </div>
                        {saveError ? <p className="mt-3 text-sm font-semibold text-destructive">{saveError}</p> : null}
                    </AppDialogBody>
                    <AppDialogFooter className="justify-between sm:justify-between">
                        <Button
                            type="button"
                            variant="ghost"
                            disabled={isSaving}
                            onClick={() => setDraftConfig(normalizeLedgerDashboardConfig(DEFAULT_LEDGER_DASHBOARD_CONFIG))}
                        >
                            <RotateCcw className="me-2 h-4 w-4" />
                            {t('ledger.cashSummary.customize.restoreDefaults')}
                        </Button>
                        <div className="flex gap-2">
                            <Button type="button" variant="outline" disabled={isSaving} onClick={() => setIsCustomizeOpen(false)}>
                                {t('common.cancel')}
                            </Button>
                            <Button type="button" disabled={isSaving} onClick={() => void handleSave()}>
                                {isSaving ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Check className="me-2 h-4 w-4" />}
                                {t('common.save')}
                            </Button>
                        </div>
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>
        </div>
    )
}

function getMovementDirectionIcon(amount: number) {
    if (amount < 0) return <ArrowDown className="h-4 w-4 text-rose-600" />
    if (amount > 0) return <ArrowUpRight className="h-4 w-4 text-primary" />
    return <Minus className="h-4 w-4 text-muted-foreground" />
}
