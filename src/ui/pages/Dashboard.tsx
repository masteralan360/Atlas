import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'wouter'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
    ArrowDownLeft,
    ArrowRight,
    BarChart3,
    CircleDollarSign,
    Eye,
    ReceiptText,
    RotateCcw,
    TrendingUp,
    Users,
    Wallet,
} from 'lucide-react'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { useWorkspacePermissions } from '@/permissions'
import {
    applySalesOrderReturnQuantities,
    useActivityTransactionLinesForWorkspace,
    useActivityTransactions,
    useAgents,
    useBusinessPartners,
    useClinicalAppointments,
    useDeliveryMerchantProfiles,
    useDeliveryShipments,
    useExchangeTransactions,
    useLoans,
    usePaymentTransactions,
    useRentalContracts,
    useRentalVehicles,
    useSales,
    useSalesOrderReturnItemsForWorkspace,
    useSalesOrders,
    useWorkspaceUsers,
} from '@/local-db'
import type { CurrencyCode, IQDDisplayPreference } from '@/local-db'
import type { Sale } from '@/types'
import { getLedgerCashMovementEntries } from '@/lib/ledgerCashMovementEntries'
import { getLedgerPaymentTransactions } from '@/lib/ledgerPaymentTransactions'
import { buildRevenueAnalysisRecords } from '@/lib/revenueAnalysis'
import { buildRevenueSourceSales } from '@/lib/revenueSourceSales'
import {
    getDashboardCashSummaries,
    getDashboardCashTrend,
    getDashboardMetricValue,
    getDashboardPartnerProfit,
    getDashboardTransactions,
    type DashboardMetric,
    type DashboardPeriod,
} from '@/lib/dashboardOverview'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    SaleDetailsModal,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/ui/components'
import { CurrencySelector } from '@/ui/components/CurrencySelector'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'

const PERIODS: DashboardPeriod[] = ['today', 'thisWeek', 'lastMonth', 'thisMonth']
const DASHBOARD_PANEL_CLASS = 'overflow-hidden rounded-[2.5rem] border-border/40 bg-card shadow-sm'
const DASHBOARD_CASH_FRESHNESS_TABLES = ['sales', 'payment_transactions', 'loans'] as const
const DASHBOARD_REVENUE_FRESHNESS_TABLES = [
    'sales',
    'payment_transactions',
    'exchange_transactions',
    'sales_orders',
    'order_return_items',
    'business_partners',
    'agents',
    'delivery_merchant_profiles',
    'delivery_shipments',
    'rental_contracts',
    'rental_vehicles',
    'clinical_appointments',
    'activity_transactions',
    'activity_transaction_lines',
] as const
const METRICS = [
    {
        id: 'cashRevenueReceived',
        icon: ArrowDownLeft,
        tone: 'text-blue-500',
        accent: 'bg-blue-500/10',
        chartColor: '#3b82f6',
    },
    {
        id: 'cashRefundsPaid',
        icon: RotateCcw,
        tone: 'text-rose-500',
        accent: 'bg-rose-500/10',
        chartColor: '#f43f5e',
    },
    {
        id: 'netCashRevenue',
        icon: CircleDollarSign,
        tone: 'text-emerald-500',
        accent: 'bg-emerald-500/10',
        chartColor: '#10b981',
    },
    {
        id: 'operatingCashPaid',
        icon: Wallet,
        tone: 'text-orange-500',
        accent: 'bg-orange-500/10',
        chartColor: '#f97316',
    },
    {
        id: 'cashOperatingSurplus',
        icon: TrendingUp,
        tone: 'text-violet-500',
        accent: 'bg-violet-500/10',
        chartColor: '#8b5cf6',
    },
] as const

type CashMetric = (typeof METRICS)[number]

const amountFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 })

function DashboardCashCard({
    metric,
    summaries,
    entries,
    period,
    now,
    defaultCurrency,
    iqdPreference,
}: {
    metric: CashMetric
    summaries: ReturnType<typeof getDashboardCashSummaries>
    entries: ReturnType<typeof getLedgerCashMovementEntries>
    period: DashboardPeriod
    now: Date
    defaultCurrency: CurrencyCode
    iqdPreference: IQDDisplayPreference
}) {
    const { t } = useTranslation()
    const amounts = summaries.map(({ currency, summary }) => ({
        currency,
        amount: getDashboardMetricValue(summary, metric.id),
    }))
    const activeAmounts = amounts.filter(({ amount }) => amount !== 0)
    const primary = activeAmounts.find(({ currency }) => currency === defaultCurrency) ||
        activeAmounts[0] ||
        amounts.find(({ currency }) => currency === defaultCurrency) ||
        amounts[0] || { currency: defaultCurrency, amount: 0 }
    const secondary = amounts.filter(({ currency }) => currency !== primary.currency)
    const sparkline = useMemo(
        () => getDashboardCashTrend(entries, period, primary.currency, metric.id, now),
        [entries, period, primary.currency, metric.id, now],
    )
    const currencyLabel = (currency: CurrencyCode) => (currency === 'iqd' ? iqdPreference : currency.toUpperCase())
    const metricTitle = t(`ledger.cashSummary.metrics.${metric.id}.title`)
    const metricDescription = t(`ledger.cashSummary.metrics.${metric.id}.description`)
    const Icon = metric.icon
    const gradientId = `dashboard-sparkline-${metric.id}`

    return (
        <Card className="flex h-full min-w-0 flex-col overflow-hidden rounded-3xl border-border/50 bg-card shadow-sm">
            <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 px-4 pb-1 pt-4">
                <CardTitle
                    className={cn(
                        'flex min-w-0 items-start gap-2 text-[10px] font-black uppercase leading-4 tracking-[0.16em]',
                        metric.tone,
                    )}
                >
                    <span
                        className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', metric.accent)}
                        aria-hidden="true"
                    >
                        <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 pt-1">{metricTitle}</span>
                </CardTitle>
                <ModulePageFreshness
                    className={cn('mt-1', metric.tone)}
                    tableNames={DASHBOARD_CASH_FRESHNESS_TABLES}
                    loadingIconOnly
                />
            </CardHeader>
            <CardContent className="flex flex-1 flex-col px-4 pb-0 pt-0">
                <div className="min-w-0 text-start">
                    <span
                        dir="ltr"
                        className="inline-flex max-w-full items-baseline gap-1.5"
                        title={formatCurrency(primary.amount, primary.currency, iqdPreference)}
                    >
                        <span
                            className={cn(
                                'min-w-0 truncate text-2xl font-black leading-none tracking-tight tabular-nums text-foreground',
                                primary.amount < 0 && 'text-rose-600 dark:text-rose-400',
                            )}
                        >
                            {amountFormatter.format(primary.amount)}
                        </span>
                        <span className="shrink-0 text-[11px] font-bold text-muted-foreground">
                            {currencyLabel(primary.currency)}
                        </span>
                    </span>
                </div>
                <p className="mt-1 line-clamp-2 h-8 text-[11px] leading-4 text-muted-foreground" title={metricDescription}>
                    {metricDescription}
                </p>

                {secondary.length > 0 && (
                    <div className="mt-1 space-y-1 border-t border-border/50 pt-1">
                        {secondary.map(({ currency, amount }) => (
                            <div
                                key={currency}
                                className="flex min-w-0 items-baseline justify-between gap-2 text-[11px]"
                            >
                                <span className="shrink-0 font-semibold text-muted-foreground">
                                    {currencyLabel(currency)}
                                </span>
                                <span
                                    dir="ltr"
                                    className={cn(
                                        'min-w-0 truncate text-end font-bold tabular-nums',
                                        amount === 0 ? 'text-muted-foreground/65' : 'text-foreground',
                                    )}
                                    title={formatCurrency(amount, currency, iqdPreference)}
                                >
                                    {amountFormatter.format(amount)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
                <div className="mt-2 h-10 w-full" aria-hidden="true">
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={sparkline}>
                            <defs>
                                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor={metric.chartColor} stopOpacity={0.3} />
                                    <stop offset="95%" stopColor={metric.chartColor} stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <Area
                                type="monotone"
                                dataKey="value"
                                stroke={metric.chartColor}
                                strokeWidth={2}
                                fillOpacity={1}
                                fill={`url(#${gradientId})`}
                                isAnimationActive={false}
                            />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    )
}

export function Dashboard() {
    const { user } = useAuth()
    const { features, hasFeature } = useWorkspace()
    const { hasPermission } = useWorkspacePermissions()
    const { t, i18n } = useTranslation()
    const [, setLocation] = useLocation()
    const [period, setPeriod] = useState<DashboardPeriod>('thisWeek')
    const [trendMetric, setTrendMetric] = useState<DashboardMetric>('netCashRevenue')
    const [selectedCurrency, setSelectedCurrency] = useState<CurrencyCode | null>(null)
    const [selectedSale, setSelectedSale] = useState<Sale | null>(null)
    const [now, setNow] = useState(() => new Date())
    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 60_000)
        return () => window.clearInterval(timer)
    }, [])
    const workspaceId = user?.workspaceId
    const canReadCash = hasFeature('ledger') && hasPermission('ledger.access')
    const canReadRevenue = hasFeature('net_revenue') && hasPermission('revenueAnalytics.access')
    const cashWorkspaceId = canReadCash ? workspaceId : undefined
    const revenueWorkspaceId = canReadRevenue ? workspaceId : undefined
    const salesWorkspaceId = canReadCash || canReadRevenue ? workspaceId : undefined

    // Ledger's existing projection handles completed receipts, payments and their reversals.
    const sales = useSales(salesWorkspaceId)
    const paymentTransactions = usePaymentTransactions(
        cashWorkspaceId,
        { includeReversals: true },
        { hydrateSourceTables: false },
    )
    const loans = useLoans(cashWorkspaceId)
    const exchangeTransactions = useExchangeTransactions(salesWorkspaceId)
    const rawOrders = useSalesOrders(revenueWorkspaceId)
    const orderReturnItems = useSalesOrderReturnItemsForWorkspace(revenueWorkspaceId)
    const orders = useMemo(
        () => applySalesOrderReturnQuantities(rawOrders, orderReturnItems),
        [rawOrders, orderReturnItems],
    )
    const partners = useBusinessPartners(revenueWorkspaceId, { includeAgentRoles: true })
    const agents = useAgents(revenueWorkspaceId)
    const workspaceUsers = useWorkspaceUsers(revenueWorkspaceId)
    const deliveryMerchantProfiles = useDeliveryMerchantProfiles(revenueWorkspaceId)
    const deliveryShipments = useDeliveryShipments(revenueWorkspaceId)
    const rentalContracts = useRentalContracts(revenueWorkspaceId)
    const rentalVehicles = useRentalVehicles(revenueWorkspaceId)
    const clinicalAppointments = useClinicalAppointments(revenueWorkspaceId)
    const clinicalAppointmentTransactions = usePaymentTransactions(
        revenueWorkspaceId,
        {
            direction: 'incoming',
            sourceModule: 'clinical_appointments',
            sourceType: 'clinical_appointment',
            includeReversals: true,
        },
        { hydrateSourceTables: false },
    )
    const realEstateCommissionTransactions = usePaymentTransactions(
        revenueWorkspaceId,
        {
            direction: 'incoming',
            sourceModule: 'real_estate',
            sourceType: 'real_estate_commission',
            includeReversals: false,
        },
        { hydrateSourceTables: false },
    )
    const travelBookingPayments = usePaymentTransactions(
        revenueWorkspaceId,
        {
            direction: 'incoming',
            sourceModule: 'travel_transportation',
            sourceType: 'travel_booking_payment',
            includeReversals: true,
        },
        { hydrateSourceTables: false },
    )
    const activityTransactions = useActivityTransactions(revenueWorkspaceId)
    const activityTransactionLines = useActivityTransactionLinesForWorkspace(revenueWorkspaceId)
    const ledgerEntries = useMemo(
        () =>
            getLedgerCashMovementEntries({
                sales,
                paymentTransactions: getLedgerPaymentTransactions(paymentTransactions),
                loans,
                exchangeTransactions: exchangeTransactions || [],
            }),
        [sales, paymentTransactions, loans, exchangeTransactions],
    )
    const cashSummaries = useMemo(
        () => getDashboardCashSummaries(ledgerEntries, period, now),
        [ledgerEntries, period, now],
    )
    const currencies = useMemo(
        () =>
            Array.from(
                new Set(
                    [
                        features.default_currency as CurrencyCode,
                        ...features.allowed_currencies,
                        ...cashSummaries.map((item) => item.currency),
                    ].filter(Boolean),
                ),
            ),
        [cashSummaries, features.default_currency, features.allowed_currencies],
    )
    const chartCurrency =
        selectedCurrency && currencies.includes(selectedCurrency) ? selectedCurrency : currencies[0] || 'usd'
    const trend = useMemo(
        () => getDashboardCashTrend(ledgerEntries, period, chartCurrency, trendMetric, now),
        [ledgerEntries, period, chartCurrency, trendMetric, now],
    )

    const partnerNameById = useMemo(
        () => new Map(partners.map((partner) => [partner.id, partner.partnerName] as const)),
        [partners],
    )
    const userNameById = useMemo(
        () => new Map(workspaceUsers.map((member) => [member.id, member.name || member.email || member.id] as const)),
        [workspaceUsers],
    )
    const uiSales = useMemo<Sale[]>(
        () =>
            buildRevenueSourceSales({
                sales,
                exchangeTransactions: exchangeTransactions || [],
                realEstateCommissionTransactions,
                travelBookingPayments,
                clinicalAppointments,
                clinicalAppointmentTransactions,
                activityTransactions,
                activityTransactionLines,
                deliveryShipments,
                deliveryMerchantProfiles,
                rentalContracts,
                rentalVehicles,
                partnerNameById,
                userNameById,
                t,
            }),
        [
            sales,
            exchangeTransactions,
            realEstateCommissionTransactions,
            travelBookingPayments,
            clinicalAppointments,
            clinicalAppointmentTransactions,
            activityTransactions,
            activityTransactionLines,
            deliveryShipments,
            deliveryMerchantProfiles,
            rentalContracts,
            rentalVehicles,
            partnerNameById,
            userNameById,
            t,
        ],
    )
    const revenueRecords = useMemo(() => buildRevenueAnalysisRecords(uiSales, orders), [uiSales, orders])
    const transactions = useMemo(() => getDashboardTransactions(revenueRecords, orders), [revenueRecords, orders])
    const agentPartnerById = useMemo(
        () => new Map(agents.map((agent) => [agent.id, agent.businessPartnerId] as const)),
        [agents],
    )
    const rankedRecords = useMemo(() => {
        const orderById = new Map(orders.map((order) => [order.id, order] as const))
        return revenueRecords.map((record) => {
            if (record.source !== 'sales_order') return record
            const agentId = orderById.get(record.id)?.salesAccountAgentId
            const agentPartnerId = agentId ? agentPartnerById.get(agentId) : null
            return agentPartnerId ? { ...record, partyId: agentPartnerId } : record
        })
    }, [revenueRecords, orders, agentPartnerById])
    const topPartners = useMemo(
        () => getDashboardPartnerProfit(rankedRecords, period, chartCurrency, partnerNameById, now),
        [rankedRecords, period, chartCurrency, partnerNameById, now],
    )
    const maxPartnerProfit = topPartners[0]?.profit || 1
    const firstName = user?.name?.split(' ')[0]
    const sourceLabel = (origin: string, channel?: string | null) => {
        if (channel === 'marketplace') return t('revenue.filters.origins.ecommerce')
        const keyByOrigin: Record<string, string> = {
            sales_order: 'revenue.filters.origins.salesOrder',
            instant_pos: 'revenue.filters.origins.instantPos',
            pos: 'revenue.filters.origins.pos',
            exchange: 'revenue.filters.origins.exchange',
            real_estate: 'revenue.filters.origins.realEstate',
            activities: 'revenue.filters.origins.activities',
            clinical_appointment: 'revenue.filters.origins.appointments',
            post_service: 'revenue.filters.origins.postService',
            car_rental: 'revenue.filters.origins.carRental',
            travel_transportation: 'travelTransportation.title',
        }
        return t(keyByOrigin[origin] || 'dashboard.unknownSource', { defaultValue: origin.replaceAll('_', ' ') })
    }
    const openTransaction = (record: (typeof transactions)[number]['record']) => {
        if (record.source === 'sales_order') setLocation(`/orders/${record.id}`)
        else if (record.source === 'exchange') setLocation('/currency-exchange')
        else if (record.source === 'real_estate') setLocation(`/real-estate/${record.sourceRecordId || record.id}`)
        else if (record.source === 'activities')
            setLocation(`/activities?transaction=${record.sourceRecordId || record.id}`)
        else if (record.source === 'clinical_appointment')
            setLocation(`/clinical-appointments/${record.sourceRecordId || record.id}/edit`)
        else if (record.source === 'post_service') setLocation('/post-service')
        else if (record.source === 'car_rental') setLocation('/car-rental/contracts')
        else if (record.source === 'travel_transportation')
            setLocation(`/travel-transportation/${record.sourceRecordId || record.id}`)
        else setSelectedSale(uiSales.find((sale) => sale.id === record.id) || null)
    }

    return (
        <div className="min-w-0 space-y-5 pb-12 md:space-y-6" data-tour-id="demo-basic-dashboard">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                    <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">{t('dashboard.title')}</p>
                    <h1 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">
                        {firstName ? t('dashboard.greeting', { name: firstName }) : t('dashboard.title')}
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">{t('dashboard.cashOverviewDescription')}</p>
                </div>
                <div
                    className="flex flex-wrap gap-1 rounded-2xl border border-border/60 bg-card p-1 shadow-sm"
                    role="group"
                    aria-label={t('dashboard.period')}
                >
                    {PERIODS.map((option) => (
                        <button
                            key={option}
                            type="button"
                            onClick={() => setPeriod(option)}
                            className={cn(
                                'rounded-xl px-3 py-2 text-xs font-bold transition-colors',
                                period === option
                                    ? 'bg-primary text-primary-foreground shadow-sm'
                                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                            )}
                            aria-pressed={period === option}
                        >
                            {t(`dashboard.periods.${option}`)}
                        </button>
                    ))}
                </div>
            </div>

            {canReadCash && (
                <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
                        {METRICS.map((metric) => (
                            <DashboardCashCard
                                key={metric.id}
                                metric={metric}
                                summaries={cashSummaries}
                                entries={ledgerEntries}
                                period={period}
                                now={now}
                                defaultCurrency={(features.default_currency || 'usd') as CurrencyCode}
                                iqdPreference={features.iqd_display_preference}
                            />
                        ))}
                    </div>
                    <div className="grid gap-4 lg:grid-cols-2">
                        <Card
                            className={cn(
                                'min-w-0',
                                DASHBOARD_PANEL_CLASS,
                                !canReadRevenue && 'lg:col-span-2',
                            )}
                        >
                            <CardHeader className="gap-4 pb-2 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                    <CardTitle className="flex items-center gap-3 text-sm font-black uppercase tracking-widest">
                                        <span className="rounded-xl bg-primary/10 p-2 text-primary" aria-hidden="true">
                                            <BarChart3 className="size-4" />
                                        </span>
                                        {t('dashboard.cashTrend')}
                                        <ModulePageFreshness
                                            className="text-primary"
                                            tableNames={DASHBOARD_CASH_FRESHNESS_TABLES}
                                            loadingIconOnly
                                        />
                                    </CardTitle>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {t('dashboard.cashTrendDescription')}
                                    </p>
                                </div>
                                {currencies.length > 1 && (
                                    <CurrencySelector
                                        value={chartCurrency}
                                        onChange={setSelectedCurrency}
                                        label={t('dashboard.currency')}
                                        iqdDisplayPreference={features.iqd_display_preference}
                                        allowedCurrencies={currencies}
                                    />
                                )}
                            </CardHeader>
                            <CardContent>
                                <div
                                    className="mb-4 inline-flex max-w-full flex-wrap gap-1 rounded-xl border border-border/50 bg-muted/40 p-1"
                                    role="tablist"
                                    aria-label={t('dashboard.cashTrend')}
                                >
                                    {(['netCashRevenue', 'cashOperatingSurplus'] as DashboardMetric[]).map((metric) => (
                                        <button
                                            key={metric}
                                            type="button"
                                            role="tab"
                                            aria-selected={trendMetric === metric}
                                            onClick={() => setTrendMetric(metric)}
                                            className={cn(
                                                'rounded-lg px-3 py-2 text-xs font-bold transition-colors',
                                                trendMetric === metric
                                                    ? 'bg-card text-primary shadow-sm'
                                                    : 'text-muted-foreground hover:bg-background/70',
                                            )}
                                        >
                                            {t(`ledger.cashSummary.metrics.${metric}.title`)}
                                        </button>
                                    ))}
                                </div>
                                <div
                                    className="h-64 w-full"
                                    aria-label={t(`ledger.cashSummary.metrics.${trendMetric}.title`)}
                                >
                                    <ResponsiveContainer width="100%" height="100%">
                                        <AreaChart data={trend} margin={{ top: 10, right: 8, left: -15, bottom: 0 }}>
                                            <defs>
                                                <linearGradient id="dashboard-cash-fill" x1="0" y1="0" x2="0" y2="1">
                                                    <stop
                                                        offset="0%"
                                                        stopColor="hsl(var(--primary))"
                                                        stopOpacity={0.24}
                                                    />
                                                    <stop
                                                        offset="100%"
                                                        stopColor="hsl(var(--primary))"
                                                        stopOpacity={0}
                                                    />
                                                </linearGradient>
                                            </defs>
                                            <CartesianGrid
                                                vertical={false}
                                                stroke="hsl(var(--border))"
                                                strokeDasharray="3 4"
                                            />
                                            <XAxis
                                                dataKey="timestamp"
                                                type="number"
                                                domain={['dataMin', 'dataMax']}
                                                tickFormatter={(value) =>
                                                    new Intl.DateTimeFormat(
                                                        i18n.language,
                                                        period === 'today'
                                                            ? { hour: 'numeric' }
                                                            : { day: 'numeric', month: 'short' },
                                                    ).format(value)
                                                }
                                                tickLine={false}
                                                axisLine={false}
                                                tick={{ fontSize: 11 }}
                                            />
                                            <YAxis
                                                tickLine={false}
                                                axisLine={false}
                                                tick={{ fontSize: 11 }}
                                                width={48}
                                            />
                                            <Tooltip
                                                content={({ active, payload, label }) => {
                                                    if (!active || !payload?.length) return null
                                                    return (
                                                        <div className="rounded-xl border border-border/70 bg-popover px-3 py-2 text-popover-foreground shadow-lg">
                                                            <p className="text-xs text-muted-foreground">
                                                                {new Intl.DateTimeFormat(
                                                                    i18n.language,
                                                                    period === 'today'
                                                                        ? { dateStyle: 'medium', timeStyle: 'short' }
                                                                        : { dateStyle: 'medium' },
                                                                ).format(Number(label))}
                                                            </p>
                                                            <p className="mt-1 text-[11px] font-bold uppercase tracking-wider">
                                                                {t(`ledger.cashSummary.metrics.${trendMetric}.title`)}
                                                            </p>
                                                            <p className="mt-0.5 text-sm font-black tabular-nums text-primary" dir="ltr">
                                                                {formatCurrency(
                                                                    Number(payload[0].value),
                                                                    chartCurrency,
                                                                    features.iqd_display_preference,
                                                                )}
                                                            </p>
                                                        </div>
                                                    )
                                                }}
                                            />
                                            <Area
                                                type="monotone"
                                                dataKey="value"
                                                stroke="hsl(var(--primary))"
                                                strokeWidth={2.5}
                                                fill="url(#dashboard-cash-fill)"
                                                dot={false}
                                                activeDot={{ r: 4 }}
                                            />
                                        </AreaChart>
                                    </ResponsiveContainer>
                                </div>
                            </CardContent>
                        </Card>
                        {canReadRevenue && (
                            <Card className={cn('min-w-0', DASHBOARD_PANEL_CLASS)}>
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-3 text-sm font-black uppercase tracking-widest">
                                        <span className="rounded-xl bg-primary/10 p-2 text-primary" aria-hidden="true">
                                            <Users className="size-4" />
                                        </span>
                                        {t('dashboard.mostProfitablePartners')}
                                        <ModulePageFreshness
                                            className="text-primary"
                                            tableNames={DASHBOARD_REVENUE_FRESHNESS_TABLES}
                                            loadingIconOnly
                                        />
                                    </CardTitle>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {t('dashboard.partnerProfitDescription', {
                                            currency: chartCurrency.toUpperCase(),
                                        })}
                                    </p>
                                </CardHeader>
                                <CardContent className="flex min-h-72 flex-col justify-center">
                                    {topPartners.length ? (
                                        <div className="space-y-5">
                                            {topPartners.map((partner, index) => (
                                                <div key={partner.id} className="space-y-2">
                                                    <div className="flex items-center justify-between gap-3 text-sm">
                                                        <span className="min-w-0 truncate font-semibold">
                                                            <span className="me-2 text-xs text-muted-foreground">
                                                                {String(index + 1).padStart(2, '0')}
                                                            </span>
                                                            {partner.name}
                                                        </span>
                                                        <span className="shrink-0 font-bold tabular-nums">
                                                            {formatCurrency(
                                                                partner.profit,
                                                                chartCurrency,
                                                                features.iqd_display_preference,
                                                            )}
                                                        </span>
                                                    </div>
                                                    <div className="h-2 rounded-full bg-muted">
                                                        <div
                                                            className="h-full rounded-full bg-gradient-to-r from-primary to-emerald-400"
                                                            style={{
                                                                width: `${Math.max(3, (partner.profit / maxPartnerProfit) * 100)}%`,
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
                                            <Users className="size-9 opacity-40" />
                                            <p className="text-sm">{t('dashboard.noPartnerProfit')}</p>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}
                    </div>
                </>
            )}

            {canReadRevenue && (
                <Card className={DASHBOARD_PANEL_CLASS}>
                    <CardHeader className="flex flex-row items-center justify-between gap-3">
                        <div>
                            <CardTitle className="flex items-center gap-3 text-sm font-black uppercase tracking-widest">
                                <span className="rounded-xl bg-primary/10 p-2 text-primary" aria-hidden="true">
                                    <ReceiptText className="size-4" />
                                </span>
                                {t('dashboard.recentTransactions')}
                                <ModulePageFreshness
                                    className="text-primary"
                                    tableNames={DASHBOARD_REVENUE_FRESHNESS_TABLES}
                                    loadingIconOnly
                                />
                            </CardTitle>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {t('dashboard.recentTransactionsDescription')}
                            </p>
                        </div>
                        <Link
                            href="/sales"
                            className="flex shrink-0 items-center gap-1 text-xs font-bold text-primary hover:underline"
                        >
                            {t('common.viewAll')}
                            <ArrowRight className="size-3.5" />
                        </Link>
                    </CardHeader>
                    <CardContent className="p-0">
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow className="bg-muted/40">
                                        <TableHead className="ps-6">{t('dashboard.orderSaleId')}</TableHead>
                                        <TableHead>{t('dashboard.source')}</TableHead>
                                        <TableHead className="text-end">{t('revenue.table.revenue')}</TableHead>
                                        <TableHead className="text-end">{t('revenue.table.profit')}</TableHead>
                                        <TableHead>{t('dashboard.status')}</TableHead>
                                        <TableHead className="pe-6 text-end">{t('dashboard.actions')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {transactions.length ? (
                                        transactions.map((transaction) => (
                                            <TableRow key={transaction.record.key} className="hover:bg-muted/30">
                                                <TableCell className="ps-6">
                                                    <div className="font-semibold">
                                                        {transaction.record.referenceCode}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {formatDateTime(transaction.record.date)}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <span className="inline-flex items-center rounded-lg bg-muted px-2 py-1 text-xs font-medium">
                                                        {sourceLabel(
                                                            transaction.record.origin,
                                                            transaction.record.sourceChannel,
                                                        )}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-end font-semibold tabular-nums">
                                                    {formatCurrency(
                                                        transaction.revenue,
                                                        transaction.record.currency as CurrencyCode,
                                                        features.iqd_display_preference,
                                                    )}
                                                </TableCell>
                                                <TableCell
                                                    className={cn(
                                                        'text-end font-semibold tabular-nums',
                                                        transaction.profit < 0 && 'text-rose-600',
                                                    )}
                                                >
                                                    {formatCurrency(
                                                        transaction.profit,
                                                        transaction.record.currency as CurrencyCode,
                                                        features.iqd_display_preference,
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    <span
                                                        className={cn(
                                                            'inline-flex rounded-full px-2.5 py-1 text-xs font-bold',
                                                            transaction.status === 'sold' ||
                                                                transaction.status === 'completed'
                                                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                                                                : transaction.status === 'cancelled' ||
                                                                    transaction.status === 'returned'
                                                                  ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
                                                                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
                                                        )}
                                                    >
                                                        {t(`dashboard.transactionStatus.${transaction.status}`)}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="pe-6 text-end">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => openTransaction(transaction.record)}
                                                        aria-label={t('dashboard.viewTransaction', {
                                                            id: transaction.record.referenceCode,
                                                        })}
                                                    >
                                                        <Eye className="me-1 size-4" />
                                                        {t('common.view')}
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        ))
                                    ) : (
                                        <TableRow>
                                            <TableCell
                                                colSpan={6}
                                                className="py-14 text-center text-sm text-muted-foreground"
                                            >
                                                {t('dashboard.noTransactions')}
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </div>
                    </CardContent>
                </Card>
            )}
            {!canReadCash && !canReadRevenue && (
                <Card className="rounded-2xl">
                    <CardContent className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                        <BarChart3 className="size-10 opacity-40" />
                        <p>{t('dashboard.noAccess')}</p>
                    </CardContent>
                </Card>
            )}
            <SaleDetailsModal sale={selectedSale} isOpen={!!selectedSale} onClose={() => setSelectedSale(null)} />
        </div>
    )
}
