import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'wouter'
import {
    AlertTriangle,
    ArrowUpRight,
    BarChart3,
    CalendarDays,
    DollarSign,
    FileSpreadsheet,
    HandCoins,
    Plane,
    TrendingUp,
    UsersRound,
    Wallet
} from 'lucide-react'
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
    XAxis,
    YAxis
} from 'recharts'

import { useAuth } from '@/auth'
import { useDateRange } from '@/context/DateRangeContext'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import {
    db,
    ensureExpenseItemsForMonth,
    fetchTableFromSupabase,
    toUISale,
    toUISaleFromTravelAgency,
    useBudgetAllocations,
    useBudgetSettings,
    useBusinessPartners,
    useDividendStatuses,
    useEmployees,
    useExpenseItems,
    useExpenseSeries,
    useLoans,
    usePayrollStatuses,
    useSales,
    useSalesOrders,
    useTravelAgencySales
} from '@/local-db'
import type { CurrencyCode, LoanInstallment, LoanPayment } from '@/local-db/models'
import {
    addMonths,
    buildConversionRates,
    buildDividendItems,
    buildPayrollItems,
    formatMonthLabel,
    monthKeyFromDate,
    type MonthKey
} from '@/lib/budget'
import { convertToStoreBase } from '@/lib/currency'
import {
    buildLoanAnalytics,
    buildMonthlyFinanceTrend,
    buildPartnerCommissionAnalytics,
    buildSalesAnalytics,
    buildSpendAnalytics
} from '@/lib/financeAnalysis'
import {
    buildRevenueAnalysisRecords,
    calculateRevenueAnalysisNetProfitBase,
    filterRevenueAnalysisRecords,
    type RevenueAnalysisRecord
} from '@/lib/revenueAnalysis'
import { cn, formatCurrency, formatDate, formatOriginLabel } from '@/lib/utils'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    ExportPreviewModal,
    Progress,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger
} from '@/ui/components'
import { useWorkspace } from '@/workspace'

type FinanceTabKey = 'overview' | 'sales' | 'spend' | 'loans' | 'partners'

function MetricCard({
    label,
    value,
    subtitle,
    icon: Icon,
    tone = 'slate',
    progress
}: {
    label: string
    value: string
    subtitle?: string
    icon: React.ComponentType<{ className?: string }>
    tone?: 'emerald' | 'amber' | 'sky' | 'rose' | 'slate'
    progress?: number
}) {
    const toneClass = tone === 'emerald'
        ? 'text-emerald-600'
        : tone === 'amber'
            ? 'text-amber-600'
            : tone === 'sky'
                ? 'text-sky-600'
                : tone === 'rose'
                    ? 'text-rose-600'
                    : 'text-slate-700 dark:text-slate-200'
    const indicatorClass = tone === 'emerald'
        ? 'bg-emerald-500'
        : tone === 'amber'
            ? 'bg-amber-500'
            : tone === 'sky'
                ? 'bg-sky-500'
                : tone === 'rose'
                    ? 'bg-rose-500'
                    : 'bg-slate-500'

    return (
        <Card className="rounded-2xl border border-border/60 bg-card/60 backdrop-blur-sm">
            <CardContent className="space-y-3 p-5">
                <div className="flex items-center gap-2">
                    <Icon className={cn('h-4 w-4', toneClass)} />
                    <p className={cn('text-xs font-black uppercase tracking-[0.12em]', toneClass)}>{label}</p>
                </div>
                <div className="space-y-1">
                    <p className="text-3xl font-black tracking-tight text-foreground">{value}</p>
                    {subtitle ? (
                        <p className="text-xs font-medium text-muted-foreground">{subtitle}</p>
                    ) : (
                        <div className="h-4" />
                    )}
                </div>
                {typeof progress === 'number' ? (
                    <Progress
                        value={Math.max(0, Math.min(progress, 100))}
                        className="h-1.5 bg-muted/40"
                        indicatorClassName={indicatorClass}
                    />
                ) : (
                    <div className="h-1.5" />
                )}
            </CardContent>
        </Card>
    )
}

function TableEmptyRow({ colSpan, label }: { colSpan: number; label: string }) {
    return (
        <TableRow>
            <TableCell colSpan={colSpan} className="py-10 text-center text-sm text-muted-foreground">
                {label}
            </TableCell>
        </TableRow>
    )
}

function buildDateRangeLabel(
    dateRange: string,
    customDates: { start: string | null; end: string | null },
    t: (key: string, options?: Record<string, unknown>) => string
) {
    if (dateRange === 'today') {
        return t('performance.filters.today', { defaultValue: 'Today' })
    }

    if (dateRange === 'month') {
        return t('performance.filters.thisMonth', { defaultValue: 'This Month' })
    }

    if (dateRange === 'allTime') {
        return t('performance.filters.allTime', { defaultValue: 'All Time' })
    }

    if (customDates.start && customDates.end) {
        return `${formatDate(customDates.start)} - ${formatDate(customDates.end)}`
    }

    return t('performance.filters.custom', { defaultValue: 'Custom Range' })
}

export function Finance() {
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { t, i18n } = useTranslation()
    const [, navigate] = useLocation()
    const { dateRange, customDates } = useDateRange()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()

    const workspaceId = user?.workspaceId
    const baseCurrency = (features.default_currency || 'usd') as CurrencyCode
    const iqdPreference = features.iqd_display_preference
    const today = useMemo(() => new Date(), [])
    const currentMonthKey = monthKeyFromDate(today)

    const hasFinanceSurface = features.net_revenue
        || features.budget
        || features.loans
        || features.crm
        || features.travel_agency
        || features.hr
    const canSeeSpend = features.budget || features.hr

    const [activeTab, setActiveTab] = useState<FinanceTabKey>('overview')
    const [selectedSpendMonth, setSelectedSpendMonth] = useState<MonthKey>(currentMonthKey)
    const [isExportOpen, setIsExportOpen] = useState(false)

    const normalizedCustomDates = useMemo(
        () => ({
            start: customDates.start || null,
            end: customDates.end || null
        }),
        [customDates.end, customDates.start]
    )

    const rawSales = useSales(workspaceId)
    const salesOrders = useSalesOrders(workspaceId)
    const rawTravelSales = useTravelAgencySales(workspaceId)
    const budgetSettingsList = useBudgetSettings(workspaceId)
    const budgetSettings = budgetSettingsList?.[0]
    const budgetAllocations = useBudgetAllocations(workspaceId)
    const expenseSeries = useExpenseSeries(workspaceId)
    const expenseItems = useExpenseItems(workspaceId, selectedSpendMonth) ?? []
    const employees = useEmployees(workspaceId)
    const payrollStatuses = usePayrollStatuses(workspaceId)
    const dividendStatuses = useDividendStatuses(workspaceId)
    const loans = useLoans(workspaceId)
    const partners = useBusinessPartners(workspaceId)

    const loanInstallments = useLiveQuery(async () => {
        if (!workspaceId) return [] as LoanInstallment[]
        const items = await db.loan_installments.where('workspaceId').equals(workspaceId).toArray()
        return items
            .filter((item) => !item.isDeleted)
            .sort((left, right) => left.dueDate.localeCompare(right.dueDate))
    }, [workspaceId]) ?? []

    const loanPayments = useLiveQuery(async () => {
        if (!workspaceId) return [] as LoanPayment[]
        const items = await db.loan_payments.where('workspaceId').equals(workspaceId).toArray()
        return items
            .filter((item) => !item.isDeleted)
            .sort((left, right) => left.paidAt.localeCompare(right.paidAt))
    }, [workspaceId]) ?? []

    useEffect(() => {
        if (!workspaceId || !features.loans) return

        void Promise.all([
            fetchTableFromSupabase('loan_installments', db.loan_installments, workspaceId),
            fetchTableFromSupabase('loan_payments', db.loan_payments, workspaceId)
        ]).catch((error) => {
            console.error('[Finance] Failed to hydrate loan analytics tables', error)
        })
    }, [features.loans, workspaceId])

    useEffect(() => {
        if (!workspaceId || !features.budget) return

        void ensureExpenseItemsForMonth(workspaceId, selectedSpendMonth).catch((error) => {
            console.error('[Finance] ensureExpenseItemsForMonth failed', error)
        })
    }, [features.budget, selectedSpendMonth, workspaceId, expenseSeries.length])

    useEffect(() => {
        if (budgetSettings?.startMonth && selectedSpendMonth < budgetSettings.startMonth) {
            setSelectedSpendMonth(budgetSettings.startMonth as MonthKey)
        }
    }, [budgetSettings?.startMonth, selectedSpendMonth])

    const rates = useMemo(
        () => buildConversionRates(exchangeData, eurRates, tryRates),
        [eurRates, exchangeData, tryRates]
    )

    const sales = useMemo(() => rawSales.map(toUISale), [rawSales])
    const paidTravelSales = useMemo(
        () => rawTravelSales
            .filter((sale) => sale.isPaid && !sale.isDeleted)
            .map(toUISaleFromTravelAgency),
        [rawTravelSales]
    )
    const allRevenueRecords = useMemo(
        () => buildRevenueAnalysisRecords(sales, salesOrders, paidTravelSales),
        [paidTravelSales, sales, salesOrders]
    )
    const filteredRevenueRecords = useMemo(
        () => filterRevenueAnalysisRecords(allRevenueRecords, dateRange, normalizedCustomDates, today),
        [allRevenueRecords, dateRange, normalizedCustomDates, today]
    )
    const filteredCompletedTravelSales = useMemo(
        () => rawTravelSales.filter((sale) => !sale.isDeleted && sale.status === 'completed'),
        [rawTravelSales]
    )
    const monthRevenueRecords = useMemo(
        () => allRevenueRecords.filter((record) => monthKeyFromDate(record.date) === selectedSpendMonth),
        [allRevenueRecords, selectedSpendMonth]
    )

    const seriesById = useMemo(
        () => new Map(expenseSeries.map((series) => [series.id, series] as const)),
        [expenseSeries]
    )
    const expenseRows = useMemo(
        () => expenseItems.map((item) => ({
            item,
            series: seriesById.get(item.seriesId) ?? null
        })),
        [expenseItems, seriesById]
    )

    const payrollItems = useMemo(
        () => buildPayrollItems(employees, payrollStatuses, selectedSpendMonth),
        [employees, payrollStatuses, selectedSpendMonth]
    )

    const spendFoundation = useMemo(() => {
        const operationalTotalBase = expenseRows.reduce((sum, row) => (
            sum + convertToStoreBase(row.item.amount, row.item.currency, baseCurrency, rates)
        ), 0)
        const payrollTotalBase = payrollItems.reduce((sum, item) => (
            sum + convertToStoreBase(item.amount, item.currency, baseCurrency, rates)
        ), 0)

        return {
            operationalTotalBase,
            payrollTotalBase
        }
    }, [baseCurrency, expenseRows, payrollItems, rates])

    const monthNetProfitBase = useMemo(
        () => calculateRevenueAnalysisNetProfitBase(monthRevenueRecords, baseCurrency, rates),
        [baseCurrency, monthRevenueRecords, rates]
    )
    const surplusPoolBase = monthNetProfitBase - spendFoundation.operationalTotalBase - spendFoundation.payrollTotalBase
    const dividendResult = useMemo(
        () => buildDividendItems(employees, dividendStatuses, selectedSpendMonth, baseCurrency, rates, surplusPoolBase),
        [baseCurrency, dividendStatuses, employees, rates, selectedSpendMonth, surplusPoolBase]
    )

    const salesAnalytics = useMemo(
        () => buildSalesAnalytics(filteredRevenueRecords, baseCurrency, rates),
        [baseCurrency, filteredRevenueRecords, rates]
    )
    const spendAnalytics = useMemo(
        () => buildSpendAnalytics({
            expenseRows: features.budget ? expenseRows : [],
            payrollItems: features.hr ? payrollItems : [],
            dividendItems: features.hr ? dividendResult.items : [],
            budgetAllocation: features.budget
                ? budgetAllocations.find((entry) => entry.month === selectedSpendMonth)
                : undefined,
            monthNetProfitBase,
            selectedMonth: selectedSpendMonth,
            baseCurrency,
            rates,
            today
        }),
        [
            baseCurrency,
            budgetAllocations,
            dividendResult.items,
            expenseRows,
            features.budget,
            features.hr,
            monthNetProfitBase,
            payrollItems,
            rates,
            selectedSpendMonth,
            today
        ]
    )
    const monthlyFinanceTrend = useMemo(
        () => buildMonthlyFinanceTrend({
            monthRevenueRecords,
            expenseRows: features.budget ? expenseRows : [],
            payrollItems: features.hr ? payrollItems : [],
            dividendItems: features.hr ? dividendResult.items : [],
            selectedMonth: selectedSpendMonth,
            baseCurrency,
            rates
        }),
        [
            baseCurrency,
            dividendResult.items,
            expenseRows,
            features.budget,
            features.hr,
            monthRevenueRecords,
            payrollItems,
            rates,
            selectedSpendMonth
        ]
    )
    const loanAnalytics = useMemo(
        () => buildLoanAnalytics({
            loans: features.loans ? loans : [],
            installments: features.loans ? loanInstallments : [],
            payments: features.loans ? loanPayments : [],
            baseCurrency,
            rates,
            dateRange,
            customDates: normalizedCustomDates,
            today
        }),
        [
            baseCurrency,
            dateRange,
            features.loans,
            loanInstallments,
            loanPayments,
            loans,
            normalizedCustomDates,
            rates,
            today
        ]
    )
    const partnerAnalytics = useMemo(
        () => buildPartnerCommissionAnalytics({
            partners: features.crm ? partners : [],
            travelSales: features.travel_agency ? filteredCompletedTravelSales : [],
            baseCurrency,
            rates,
            dateRange,
            customDates: normalizedCustomDates,
            today
        }),
        [
            baseCurrency,
            dateRange,
            features.crm,
            features.travel_agency,
            filteredCompletedTravelSales,
            normalizedCustomDates,
            partners,
            rates,
            today
        ]
    )

    const visibleTabs = useMemo(() => ([
        { key: 'overview' as const, label: t('finance.tabs.overview', { defaultValue: 'Overview' }), visible: hasFinanceSurface },
        { key: 'sales' as const, label: t('finance.tabs.sales', { defaultValue: 'Sales' }), visible: features.net_revenue },
        { key: 'spend' as const, label: t('finance.tabs.spend', { defaultValue: 'Spend' }), visible: canSeeSpend },
        { key: 'loans' as const, label: t('finance.tabs.loans', { defaultValue: 'Loans' }), visible: features.loans },
        {
            key: 'partners' as const,
            label: t('finance.tabs.partners', { defaultValue: 'Partners & Commissions' }),
            visible: features.crm || features.travel_agency
        }
    ].filter((tab) => tab.visible)), [canSeeSpend, features.crm, features.loans, features.net_revenue, features.travel_agency, hasFinanceSurface, t])

    useEffect(() => {
        if (visibleTabs.length === 0) return
        if (!visibleTabs.some((tab) => tab.key === activeTab)) {
            setActiveTab(visibleTabs[0].key)
        }
    }, [activeTab, visibleTabs])

    const monthOptions = useMemo(() => {
        const startMonth = (budgetSettings?.startMonth || currentMonthKey) as MonthKey
        const candidates = new Set<MonthKey>([
            startMonth,
            currentMonthKey,
            selectedSpendMonth,
            addMonths(currentMonthKey, 6)
        ])

        budgetAllocations.forEach((entry) => candidates.add(entry.month as MonthKey))
        expenseSeries.forEach((series) => {
            candidates.add(series.startMonth as MonthKey)
            if (series.endMonth) {
                candidates.add(series.endMonth as MonthKey)
            }
        })

        let maxMonth = Array.from(candidates).reduce((max, value) => value > max ? value : max, startMonth)
        if (selectedSpendMonth > maxMonth) {
            maxMonth = selectedSpendMonth
        }

        const options: Array<{ value: MonthKey; label: string }> = []
        let cursor = startMonth
        while (cursor <= maxMonth) {
            options.push({
                value: cursor,
                label: formatMonthLabel(cursor, i18n.language)
            })
            cursor = addMonths(cursor, 1)
        }

        return options
    }, [budgetAllocations, budgetSettings?.startMonth, currentMonthKey, expenseSeries, i18n.language, selectedSpendMonth])

    const activeTabLabel = visibleTabs.find((tab) => tab.key === activeTab)?.label || t('finance.tabs.overview', { defaultValue: 'Overview' })
    const dateRangeLabel = buildDateRangeLabel(dateRange, normalizedCustomDates, t)
    const spendMonthLabel = formatMonthLabel(selectedSpendMonth, i18n.language)

    const overviewCards = useMemo(() => {
        const cards: Array<{
            label: string
            value: string
            subtitle?: string
            icon: React.ComponentType<{ className?: string }>
            tone?: 'emerald' | 'amber' | 'sky' | 'rose' | 'slate'
            progress?: number
        }> = []

        if (features.net_revenue) {
            cards.push({
                label: t('finance.cards.revenue', { defaultValue: 'Revenue' }),
                value: formatCurrency(salesAnalytics.totals.revenueBase, baseCurrency, iqdPreference),
                subtitle: `${salesAnalytics.totals.recordCount} ${t('finance.cards.records', { defaultValue: 'records' })}`,
                icon: DollarSign,
                tone: 'emerald'
            })
            cards.push({
                label: t('finance.cards.grossProfit', { defaultValue: 'Gross Profit' }),
                value: formatCurrency(salesAnalytics.totals.profitBase, baseCurrency, iqdPreference),
                subtitle: `${salesAnalytics.totals.margin.toFixed(1)}% ${t('finance.cards.margin', { defaultValue: 'margin' })}`,
                icon: TrendingUp,
                tone: salesAnalytics.totals.profitBase >= 0 ? 'emerald' : 'rose'
            })
        }

        if (canSeeSpend) {
            cards.push({
                label: t('finance.cards.plannedSpend', { defaultValue: 'Planned Spend' }),
                value: formatCurrency(
                    spendAnalytics.totals.totalAllocatedBase + spendAnalytics.totals.dividendTotalBase,
                    baseCurrency,
                    iqdPreference
                ),
                subtitle: spendMonthLabel,
                icon: Wallet,
                tone: spendAnalytics.totals.usageRatio > 100 ? 'rose' : 'amber',
                progress: spendAnalytics.totals.usageRatio
            })
            cards.push({
                label: t('finance.cards.projectedRemainder', { defaultValue: 'Projected Remainder' }),
                value: formatCurrency(spendAnalytics.totals.surplusAfterDistributionBase, baseCurrency, iqdPreference),
                subtitle: t('finance.cards.afterDividends', { defaultValue: 'after payroll, expenses, and dividends' }),
                icon: BarChart3,
                tone: spendAnalytics.totals.surplusAfterDistributionBase >= 0 ? 'sky' : 'rose'
            })
        }

        if (features.loans) {
            cards.push({
                label: t('finance.cards.outstandingLoans', { defaultValue: 'Outstanding Loans' }),
                value: formatCurrency(loanAnalytics.totals.outstandingBase, baseCurrency, iqdPreference),
                subtitle: `${loanAnalytics.totals.activeCount} ${t('finance.cards.activeLoans', { defaultValue: 'active loans' })}`,
                icon: HandCoins,
                tone: loanAnalytics.totals.overdueCount > 0 ? 'rose' : 'sky'
            })
        }

        if (features.crm) {
            cards.push({
                label: t('finance.cards.partnerExposure', { defaultValue: 'Net Partner Exposure' }),
                value: formatCurrency(partnerAnalytics.totals.netExposureBase, baseCurrency, iqdPreference),
                subtitle: `${partnerAnalytics.partnerRows.length} ${t('finance.cards.partners', { defaultValue: 'partners' })}`,
                icon: UsersRound,
                tone: Math.abs(partnerAnalytics.totals.netExposureBase) > 0 ? 'amber' : 'slate'
            })
        }

        if (features.travel_agency) {
            cards.push({
                label: t('finance.cards.travelCommission', { defaultValue: 'Travel Commission' }),
                value: formatCurrency(partnerAnalytics.totals.travelCommissionBase, baseCurrency, iqdPreference),
                subtitle: `${partnerAnalytics.totals.completedTravelSalesCount} ${t('finance.cards.completedSales', { defaultValue: 'completed sales' })}`,
                icon: Plane,
                tone: 'sky'
            })
        }

        return cards
    }, [
        baseCurrency,
        canSeeSpend,
        features.crm,
        features.loans,
        features.net_revenue,
        features.travel_agency,
        iqdPreference,
        loanAnalytics.totals.activeCount,
        loanAnalytics.totals.outstandingBase,
        loanAnalytics.totals.overdueCount,
        partnerAnalytics.partnerRows.length,
        partnerAnalytics.totals.completedTravelSalesCount,
        partnerAnalytics.totals.netExposureBase,
        partnerAnalytics.totals.travelCommissionBase,
        salesAnalytics.totals.margin,
        salesAnalytics.totals.profitBase,
        salesAnalytics.totals.recordCount,
        salesAnalytics.totals.revenueBase,
        spendAnalytics.totals.dividendTotalBase,
        spendAnalytics.totals.surplusAfterDistributionBase,
        spendAnalytics.totals.totalAllocatedBase,
        spendAnalytics.totals.usageRatio,
        spendMonthLabel,
        t
    ])

    const overviewAlerts = useMemo(() => {
        const alerts: Array<{ title: string; description: string; tone: 'rose' | 'amber' | 'sky' }> = []

        if (canSeeSpend && spendAnalytics.totals.usageRatio > 100) {
            alerts.push({
                title: t('finance.alerts.budgetExceeded', { defaultValue: 'Budget limit exceeded' }),
                description: t('finance.alerts.budgetExceededDesc', {
                    defaultValue: '{{planned}} planned against {{limit}} available for {{month}}',
                    planned: formatCurrency(spendAnalytics.totals.totalAllocatedBase, baseCurrency, iqdPreference),
                    limit: formatCurrency(spendAnalytics.totals.budgetLimitBase, baseCurrency, iqdPreference),
                    month: spendMonthLabel
                }),
                tone: 'rose'
            })
        }

        if (canSeeSpend && spendAnalytics.totals.overdueCount > 0) {
            alerts.push({
                title: t('finance.alerts.budgetOverdue', { defaultValue: 'Budget items overdue' }),
                description: t('finance.alerts.budgetOverdueDesc', {
                    defaultValue: '{{count}} unpaid items worth {{amount}} are overdue',
                    count: spendAnalytics.totals.overdueCount,
                    amount: formatCurrency(spendAnalytics.totals.overdueBase, baseCurrency, iqdPreference)
                }),
                tone: 'amber'
            })
        }

        if (features.loans && loanAnalytics.totals.overdueCount > 0) {
            alerts.push({
                title: t('finance.alerts.loanOverdue', { defaultValue: 'Loan installments overdue' }),
                description: t('finance.alerts.loanOverdueDesc', {
                    defaultValue: '{{count}} installments worth {{amount}} are overdue',
                    count: loanAnalytics.totals.overdueCount,
                    amount: formatCurrency(loanAnalytics.totals.overdueBase, baseCurrency, iqdPreference)
                }),
                tone: 'rose'
            })
        }

        if (features.loans && loanAnalytics.totals.dueSoonCount > 0) {
            alerts.push({
                title: t('finance.alerts.loanDueSoon', { defaultValue: 'Loan installments due soon' }),
                description: t('finance.alerts.loanDueSoonDesc', {
                    defaultValue: '{{count}} installments worth {{amount}} are due within 7 days',
                    count: loanAnalytics.totals.dueSoonCount,
                    amount: formatCurrency(loanAnalytics.totals.dueSoonBase, baseCurrency, iqdPreference)
                }),
                tone: 'sky'
            })
        }

        return alerts
    }, [
        baseCurrency,
        canSeeSpend,
        features.loans,
        iqdPreference,
        loanAnalytics.totals.dueSoonBase,
        loanAnalytics.totals.dueSoonCount,
        loanAnalytics.totals.overdueBase,
        loanAnalytics.totals.overdueCount,
        spendAnalytics.totals.budgetLimitBase,
        spendAnalytics.totals.overdueBase,
        spendAnalytics.totals.overdueCount,
        spendAnalytics.totals.totalAllocatedBase,
        spendAnalytics.totals.usageRatio,
        spendMonthLabel,
        t
    ])

    const healthIndicators = useMemo(() => {
        const budgetHeadroom = canSeeSpend
            ? Math.max(0, 100 - Math.min(spendAnalytics.totals.usageRatio, 100))
            : null
        const loanHealth = features.loans
            ? (loanAnalytics.totals.outstandingBase > 0
                ? Math.max(0, 100 - ((loanAnalytics.totals.overdueBase / loanAnalytics.totals.outstandingBase) * 100))
                : 100)
            : null
        const collectionCoverage = canSeeSpend
            ? (salesAnalytics.totals.profitBase > 0
                ? Math.min(
                    100,
                    ((spendAnalytics.totals.totalPaidBase + spendAnalytics.totals.dividendTotalBase) / salesAnalytics.totals.profitBase) * 100
                )
                : 0)
            : null

        return [
            budgetHeadroom != null ? {
                label: t('finance.health.budgetHeadroom', { defaultValue: 'Budget headroom' }),
                value: budgetHeadroom,
                description: t('finance.health.budgetHeadroomDesc', {
                    defaultValue: '{{usage}} of planned capacity is already committed',
                    usage: `${spendAnalytics.totals.usageRatio.toFixed(0)}%`
                })
            } : null,
            loanHealth != null ? {
                label: t('finance.health.loanHealth', { defaultValue: 'Loan book health' }),
                value: loanHealth,
                description: t('finance.health.loanHealthDesc', {
                    defaultValue: '{{overdue}} of the active balance is overdue',
                    overdue: formatCurrency(loanAnalytics.totals.overdueBase, baseCurrency, iqdPreference)
                })
            } : null,
            collectionCoverage != null ? {
                label: t('finance.health.profitCoverage', { defaultValue: 'Profit coverage' }),
                value: collectionCoverage,
                description: t('finance.health.profitCoverageDesc', {
                    defaultValue: '{{paid}} has already been paid out or collected against current gross profit',
                    paid: formatCurrency(
                        spendAnalytics.totals.totalPaidBase + spendAnalytics.totals.dividendTotalBase,
                        baseCurrency,
                        iqdPreference
                    )
                })
            } : null
        ].filter(Boolean) as Array<{ label: string; value: number; description: string }>
    }, [
        baseCurrency,
        canSeeSpend,
        features.loans,
        iqdPreference,
        loanAnalytics.totals.outstandingBase,
        loanAnalytics.totals.overdueBase,
        salesAnalytics.totals.profitBase,
        spendAnalytics.totals.dividendTotalBase,
        spendAnalytics.totals.totalPaidBase,
        spendAnalytics.totals.usageRatio,
        t
    ])

    const operationalLinks = useMemo(() => ([
        features.net_revenue ? {
            label: t('nav.revenue', { defaultValue: 'Revenue' }),
            href: '/revenue'
        } : null,
        features.budget ? {
            label: t('nav.budget', { defaultValue: 'Accounting' }),
            href: '/budget'
        } : null,
        features.loans ? {
            label: t('nav.loans', { defaultValue: 'Loans' }),
            href: '/loans'
        } : null,
        features.loans ? {
            label: t('nav.installments', { defaultValue: 'Installments' }),
            href: '/installments'
        } : null,
        features.hr ? {
            label: t('nav.hr', { defaultValue: 'HR' }),
            href: '/hr'
        } : null,
        features.crm ? {
            label: t('businessPartners.title', { defaultValue: 'Business Partners' }),
            href: '/business-partners'
        } : null,
        features.travel_agency ? {
            label: t('nav.travelAgency', { defaultValue: 'Travel Agency' }),
            href: '/travel-agency'
        } : null
    ].filter(Boolean) as Array<{ label: string; href: string }>), [features.budget, features.crm, features.hr, features.loans, features.net_revenue, features.travel_agency, t])

    const salesRecordRoutes = useMemo(() => {
        const routes = new Map<string, string>()
        filteredRevenueRecords.forEach((record: RevenueAnalysisRecord) => {
            if (record.source === 'travel_agency') {
                routes.set(record.key, `/travel-agency/${record.id}/view`)
                return
            }

            if (record.source === 'sales_order') {
                routes.set(record.key, `/orders/${record.id}`)
                return
            }

            routes.set(record.key, '/sales')
        })
        return routes
    }, [filteredRevenueRecords])

    const activeExportRows = useMemo(() => {
        if (activeTab === 'overview') {
            const rows = overviewCards.map((card) => ({
                Section: 'Overview KPI',
                Metric: card.label,
                Value: card.value,
                Subtitle: card.subtitle || ''
            }))

            overviewAlerts.forEach((alert) => {
                rows.push({
                    Section: 'Overview Alert',
                    Metric: alert.title,
                    Value: alert.description,
                    Subtitle: alert.tone
                })
            })

            return rows
        }

        if (activeTab === 'sales') {
            return salesAnalytics.recordRows.map((row) => ({
                Reference: row.referenceCode,
                Date: formatDate(row.date),
                Source: formatOriginLabel(row.origin),
                Member: row.member,
                Partner: row.partner,
                Revenue: formatCurrency(row.revenueBase, baseCurrency, iqdPreference),
                Cost: formatCurrency(row.costBase, baseCurrency, iqdPreference),
                Profit: formatCurrency(row.profitBase, baseCurrency, iqdPreference),
                Margin: `${row.margin.toFixed(1)}%`
            }))
        }

        if (activeTab === 'spend') {
            return [
                ...spendAnalytics.categoryRows.map((row) => ({
                    Section: 'Expense Category',
                    Label: row.label,
                    Planned: formatCurrency(row.valueBase, baseCurrency, iqdPreference),
                    Paid: formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference),
                    Count: row.count
                })),
                ...spendAnalytics.departmentRows.map((row) => ({
                    Section: 'Payroll Department',
                    Label: row.label,
                    Planned: formatCurrency(row.valueBase, baseCurrency, iqdPreference),
                    Paid: formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference),
                    Count: row.count
                })),
                ...spendAnalytics.dividendRows.map((row) => ({
                    Section: 'Dividend',
                    Label: row.label,
                    Planned: formatCurrency(row.valueBase, baseCurrency, iqdPreference),
                    BaseAmount: formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference),
                    Count: row.count
                }))
            ]
        }

        if (activeTab === 'loans') {
            return [
                ...loanAnalytics.loanRows.map((row) => ({
                    Section: 'Loan',
                    Reference: row.loanNo,
                    Borrower: row.borrowerName,
                    LinkedParty: row.linkedPartyName,
                    Direction: row.direction,
                    Status: row.status,
                    Balance: formatCurrency(row.balanceBase, baseCurrency, iqdPreference),
                    Principal: formatCurrency(row.principalBase, baseCurrency, iqdPreference),
                    NextDueDate: row.nextDueDate || ''
                })),
                ...loanAnalytics.installmentRows.map((row) => ({
                    Section: 'Installment',
                    Reference: row.loanNo,
                    Borrower: row.borrowerName,
                    LinkedParty: row.linkedPartyName,
                    Status: row.status,
                    Balance: formatCurrency(row.balanceBase, baseCurrency, iqdPreference),
                    DueDate: row.dueDate
                }))
            ]
        }

        return [
            ...partnerAnalytics.partnerRows.map((row) => ({
                Section: 'Partner Exposure',
                Partner: row.partnerName,
                Role: row.role,
                Receivable: formatCurrency(row.receivableBase, baseCurrency, iqdPreference),
                Payable: formatCurrency(row.payableBase, baseCurrency, iqdPreference),
                LoanExposure: formatCurrency(row.loanExposureBase, baseCurrency, iqdPreference),
                NetExposure: formatCurrency(row.netExposureBase, baseCurrency, iqdPreference)
            })),
            ...partnerAnalytics.supplierRows.map((row) => ({
                Section: 'Travel Supplier',
                Label: row.label,
                Revenue: formatCurrency(row.revenueBase, baseCurrency, iqdPreference),
                Cost: formatCurrency(row.costBase, baseCurrency, iqdPreference),
                Commission: formatCurrency(row.commissionBase, baseCurrency, iqdPreference),
                Count: row.count
            })),
            ...partnerAnalytics.groupRows.map((row) => ({
                Section: 'Travel Group',
                Label: row.label,
                Revenue: formatCurrency(row.revenueBase, baseCurrency, iqdPreference),
                Cost: formatCurrency(row.costBase, baseCurrency, iqdPreference),
                Commission: formatCurrency(row.commissionBase, baseCurrency, iqdPreference),
                Count: row.count
            }))
        ]
    }, [
        activeTab,
        baseCurrency,
        iqdPreference,
        loanAnalytics.installmentRows,
        loanAnalytics.loanRows,
        overviewAlerts,
        overviewCards,
        partnerAnalytics.groupRows,
        partnerAnalytics.partnerRows,
        partnerAnalytics.supplierRows,
        salesAnalytics.recordRows,
        spendAnalytics.categoryRows,
        spendAnalytics.departmentRows,
        spendAnalytics.dividendRows
    ])

    if (visibleTabs.length === 0) {
        return (
            <div className="space-y-6">
                <div className="space-y-2">
                    <h1 className="text-3xl font-bold tracking-tight">{t('finance.title', { defaultValue: 'Finance Analytics Hub' })}</h1>
                    <p className="text-muted-foreground">
                        {t('finance.subtitle', {
                            defaultValue: 'A read-only hub for finance analysis across revenue, accounting, loans, partners, and travel activity.'
                        })}
                    </p>
                </div>

                <Card className="rounded-3xl border border-dashed border-border/70 bg-card/50">
                    <CardContent className="flex flex-col items-center gap-4 px-6 py-16 text-center">
                        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
                            <AlertTriangle className="h-8 w-8" />
                        </div>
                        <div className="space-y-2">
                            <h2 className="text-xl font-bold">
                                {t('finance.empty.noTabsTitle', { defaultValue: 'Finance analytics is not available here' })}
                            </h2>
                            <p className="max-w-xl text-sm text-muted-foreground">
                                {t('finance.empty.noTabsDescription', {
                                    defaultValue: 'This workspace does not currently expose any finance-related modules for your account.'
                                })}
                            </p>
                        </div>
                        <Button onClick={() => navigate('/')}>
                            <ArrowUpRight className="mr-2 h-4 w-4" />
                            {t('finance.actions.backHome', { defaultValue: 'Return to Dashboard' })}
                        </Button>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-3">
                        <h1 className="text-3xl font-bold tracking-tight">{t('finance.title', { defaultValue: 'Finance Analytics Hub' })}</h1>
                        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-black uppercase tracking-[0.16em] text-primary">
                            {activeTabLabel}
                        </span>
                        <span className="rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-muted-foreground">
                            {activeTab === 'spend' ? spendMonthLabel : dateRangeLabel}
                        </span>
                    </div>
                    <p className="max-w-3xl text-muted-foreground">
                        {t('finance.subtitle', {
                            defaultValue: 'A read-only hub for finance analysis across revenue, accounting, loans, partners, and travel activity.'
                        })}
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    {activeTab !== 'spend' ? (
                        <DateRangeFilters className="justify-end" />
                    ) : (
                        <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/50 px-3 py-2">
                            <CalendarDays className="h-4 w-4 text-muted-foreground" />
                            <Select value={selectedSpendMonth} onValueChange={(value) => setSelectedSpendMonth(value as MonthKey)}>
                                <SelectTrigger className="min-w-[190px] border-none bg-transparent px-0 shadow-none">
                                    <SelectValue placeholder={t('finance.controls.month', { defaultValue: 'Select month' })} />
                                </SelectTrigger>
                                <SelectContent>
                                    {monthOptions.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}

                    <Button variant="outline" onClick={() => setIsExportOpen(true)}>
                        <FileSpreadsheet className="mr-2 h-4 w-4" />
                        {t('finance.actions.export', { defaultValue: 'Export' })}
                    </Button>
                </div>
            </div>

            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as FinanceTabKey)} className="space-y-6">
                <TabsList className="grid w-full grid-cols-2 gap-2 rounded-2xl bg-secondary/50 p-1 lg:grid-cols-5">
                    {visibleTabs.map((tab) => (
                        <TabsTrigger key={tab.key} value={tab.key} className="rounded-xl text-xs font-black uppercase tracking-[0.12em]">
                            {tab.label}
                        </TabsTrigger>
                    ))}
                </TabsList>

                <TabsContent value="overview" className="space-y-6">
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {overviewCards.map((card) => (
                            <MetricCard
                                key={card.label}
                                label={card.label}
                                value={card.value}
                                subtitle={card.subtitle}
                                icon={card.icon}
                                tone={card.tone}
                                progress={card.progress}
                            />
                        ))}
                    </div>

                    <div className="grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader className="space-y-2">
                                <CardTitle>{t('finance.sections.monthlyTrend', { defaultValue: 'Revenue, Spend, and Profit Trend' })}</CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    {t('finance.sections.monthlyTrendDesc', {
                                        defaultValue: 'Daily view for {{month}} in workspace base currency.',
                                        month: spendMonthLabel
                                    })}
                                </p>
                            </CardHeader>
                            <CardContent className="h-[340px] pt-0">
                                <ResponsiveContainer width="100%" height="100%">
                                    <AreaChart data={monthlyFinanceTrend}>
                                        <defs>
                                            <linearGradient id="financeRevenue" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                                                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                            </linearGradient>
                                            <linearGradient id="financeSpend" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.35} />
                                                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/50" />
                                        <XAxis dataKey="label" tickLine={false} axisLine={false} />
                                        <YAxis
                                            tickLine={false}
                                            axisLine={false}
                                            tickFormatter={(value) => formatCurrency(Number(value || 0), baseCurrency, iqdPreference)}
                                            width={90}
                                        />
                                        <RechartsTooltip
                                            formatter={(value: number | string | undefined, name: string | undefined) => [formatCurrency(Number(value || 0), baseCurrency, iqdPreference), name || '']}
                                        />
                                        <Area type="monotone" dataKey="revenueBase" name={t('finance.cards.revenue', { defaultValue: 'Revenue' })} stroke="#10b981" fill="url(#financeRevenue)" strokeWidth={2.2} />
                                        <Area type="monotone" dataKey="spendBase" name={t('finance.cards.plannedSpend', { defaultValue: 'Spend' })} stroke="#f59e0b" fill="url(#financeSpend)" strokeWidth={2.2} />
                                        <Line type="monotone" dataKey="profitBase" name={t('finance.cards.projectedRemainder', { defaultValue: 'Net Outcome' })} stroke="#2563eb" strokeWidth={2.4} dot={false} />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </CardContent>
                        </Card>

                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader className="space-y-2">
                                <CardTitle>{t('finance.sections.alerts', { defaultValue: 'Exposure Alerts' })}</CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    {t('finance.sections.alertsDesc', {
                                        defaultValue: 'Overdue items and limit breaches that need attention first.'
                                    })}
                                </p>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                {overviewAlerts.length === 0 ? (
                                    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-5 text-sm text-emerald-700 dark:text-emerald-300">
                                        {t('finance.empty.alerts', { defaultValue: 'No critical finance alerts are active right now.' })}
                                    </div>
                                ) : overviewAlerts.map((alert) => (
                                    <div
                                        key={alert.title}
                                        className={cn(
                                            'rounded-2xl border px-4 py-4',
                                            alert.tone === 'rose'
                                                ? 'border-rose-500/20 bg-rose-500/5'
                                                : alert.tone === 'amber'
                                                    ? 'border-amber-500/20 bg-amber-500/5'
                                                    : 'border-sky-500/20 bg-sky-500/5'
                                        )}
                                    >
                                        <div className="flex items-start gap-3">
                                            <div className={cn(
                                                'mt-0.5 rounded-full p-1.5',
                                                alert.tone === 'rose'
                                                    ? 'bg-rose-500/10 text-rose-600'
                                                    : alert.tone === 'amber'
                                                        ? 'bg-amber-500/10 text-amber-600'
                                                        : 'bg-sky-500/10 text-sky-600'
                                            )}>
                                                <AlertTriangle className="h-4 w-4" />
                                            </div>
                                            <div className="space-y-1">
                                                <p className="font-semibold">{alert.title}</p>
                                                <p className="text-sm text-muted-foreground">{alert.description}</p>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </CardContent>
                        </Card>
                    </div>

                    <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader className="space-y-2">
                                <CardTitle>{t('finance.sections.health', { defaultValue: 'Financial Health' })}</CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    {t('finance.sections.healthDesc', {
                                        defaultValue: 'Operational ratios based on the currently visible finance modules.'
                                    })}
                                </p>
                            </CardHeader>
                            <CardContent className="space-y-5">
                                {healthIndicators.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">
                                        {t('finance.empty.health', { defaultValue: 'Enable more finance modules to unlock health indicators.' })}
                                    </p>
                                ) : healthIndicators.map((item) => (
                                    <div key={item.label} className="space-y-2">
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <p className="font-semibold">{item.label}</p>
                                                <p className="text-sm text-muted-foreground">{item.description}</p>
                                            </div>
                                            <span className="text-sm font-black">{item.value.toFixed(0)}%</span>
                                        </div>
                                        <Progress value={item.value} className="h-2 bg-muted/40" />
                                    </div>
                                ))}
                            </CardContent>
                        </Card>

                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader className="space-y-2">
                                <CardTitle>{t('finance.sections.quickLinks', { defaultValue: 'Operational Pages' })}</CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    {t('finance.sections.quickLinksDesc', {
                                        defaultValue: 'Use the hub for analysis, then jump into the source modules for detail and action.'
                                    })}
                                </p>
                            </CardHeader>
                            <CardContent className="grid gap-3 sm:grid-cols-2">
                                {operationalLinks.map((link) => (
                                    <Button
                                        key={link.href}
                                        variant="outline"
                                        className="justify-between rounded-2xl"
                                        onClick={() => navigate(link.href)}
                                    >
                                        <span>{link.label}</span>
                                        <ArrowUpRight className="h-4 w-4" />
                                    </Button>
                                ))}
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                <TabsContent value="sales" className="space-y-6">
                    <div className="flex flex-wrap gap-3">
                        <Button variant="outline" onClick={() => navigate('/revenue')}>
                            <ArrowUpRight className="mr-2 h-4 w-4" />
                            {t('nav.revenue', { defaultValue: 'Revenue' })}
                        </Button>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <MetricCard
                            label={t('finance.cards.revenue', { defaultValue: 'Revenue' })}
                            value={formatCurrency(salesAnalytics.totals.revenueBase, baseCurrency, iqdPreference)}
                            subtitle={`${salesAnalytics.totals.recordCount} ${t('finance.cards.records', { defaultValue: 'records' })}`}
                            icon={DollarSign}
                            tone="emerald"
                        />
                        <MetricCard
                            label={t('finance.cards.cost', { defaultValue: 'Cost' })}
                            value={formatCurrency(salesAnalytics.totals.costBase, baseCurrency, iqdPreference)}
                            subtitle={dateRangeLabel}
                            icon={Wallet}
                            tone="amber"
                        />
                        <MetricCard
                            label={t('finance.cards.grossProfit', { defaultValue: 'Gross Profit' })}
                            value={formatCurrency(salesAnalytics.totals.profitBase, baseCurrency, iqdPreference)}
                            subtitle={`${salesAnalytics.totals.margin.toFixed(1)}% ${t('finance.cards.margin', { defaultValue: 'margin' })}`}
                            icon={TrendingUp}
                            tone={salesAnalytics.totals.profitBase >= 0 ? 'emerald' : 'rose'}
                        />
                        <MetricCard
                            label={t('finance.cards.recordCount', { defaultValue: 'Sales Records' })}
                            value={salesAnalytics.totals.recordCount.toLocaleString()}
                            subtitle={dateRangeLabel}
                            icon={BarChart3}
                            tone="sky"
                        />
                    </div>

                    <Card className="rounded-3xl border border-border/60">
                        <CardHeader className="space-y-2">
                            <CardTitle>{t('finance.sections.salesTrend', { defaultValue: 'Revenue by Day' })}</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t('finance.sections.salesTrendDesc', {
                                    defaultValue: 'Base-currency revenue, cost, and profit for the active range.'
                                })}
                            </p>
                        </CardHeader>
                        <CardContent className="h-[340px] pt-0">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={salesAnalytics.trend}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/50" />
                                    <XAxis dataKey="label" tickLine={false} axisLine={false} />
                                    <YAxis
                                        tickLine={false}
                                        axisLine={false}
                                        tickFormatter={(value) => formatCurrency(Number(value || 0), baseCurrency, iqdPreference)}
                                        width={90}
                                    />
                                    <RechartsTooltip
                                        formatter={(value: number | string | undefined, name: string | undefined) => [formatCurrency(Number(value || 0), baseCurrency, iqdPreference), name || '']}
                                    />
                                    <Bar dataKey="revenueBase" name={t('finance.cards.revenue', { defaultValue: 'Revenue' })} fill="#10b981" radius={[10, 10, 0, 0]} />
                                    <Line type="monotone" dataKey="profitBase" name={t('finance.cards.grossProfit', { defaultValue: 'Profit' })} stroke="#2563eb" strokeWidth={2.5} dot={false} />
                                </BarChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>

                    <div className="grid gap-6 xl:grid-cols-2">
                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.topProducts', { defaultValue: 'Top Products' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('common.item', { defaultValue: 'Item' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.revenue', { defaultValue: 'Revenue' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.grossProfit', { defaultValue: 'Profit' })}</TableHead>
                                            <TableHead className="text-end">{t('common.quantity', { defaultValue: 'Quantity' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {salesAnalytics.productRows.length === 0 ? (
                                            <TableEmptyRow colSpan={4} label={t('finance.empty.salesProducts', { defaultValue: 'No sales products available for the selected range.' })} />
                                        ) : salesAnalytics.productRows.slice(0, 10).map((row) => (
                                            <TableRow key={row.label}>
                                                <TableCell className="font-medium">{row.label}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.valueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end text-emerald-600">{formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{row.count}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>

                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.originMix', { defaultValue: 'Origin Mix' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('sales.origin', { defaultValue: 'Origin' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.revenue', { defaultValue: 'Revenue' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.grossProfit', { defaultValue: 'Profit' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.records', { defaultValue: 'Records' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {salesAnalytics.originRows.length === 0 ? (
                                            <TableEmptyRow colSpan={4} label={t('finance.empty.salesOrigins', { defaultValue: 'No sales origins available for the selected range.' })} />
                                        ) : salesAnalytics.originRows.map((row) => (
                                            <TableRow key={row.label}>
                                                <TableCell className="font-medium">{row.label}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.valueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end text-emerald-600">{formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{row.count}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>

                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.memberPerformance', { defaultValue: 'Member Performance' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('finance.columns.member', { defaultValue: 'Member' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.revenue', { defaultValue: 'Revenue' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.grossProfit', { defaultValue: 'Profit' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.records', { defaultValue: 'Records' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {salesAnalytics.memberRows.length === 0 ? (
                                            <TableEmptyRow colSpan={4} label={t('finance.empty.salesMembers', { defaultValue: 'No member analytics are available for the selected range.' })} />
                                        ) : salesAnalytics.memberRows.map((row) => (
                                            <TableRow key={row.label}>
                                                <TableCell className="font-medium">{row.label}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.valueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end text-emerald-600">{formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{row.count}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>

                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.partnerPerformance', { defaultValue: 'Partner Performance' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('finance.columns.partner', { defaultValue: 'Partner' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.revenue', { defaultValue: 'Revenue' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.grossProfit', { defaultValue: 'Profit' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.records', { defaultValue: 'Records' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {salesAnalytics.partnerRows.length === 0 ? (
                                            <TableEmptyRow colSpan={4} label={t('finance.empty.salesPartners', { defaultValue: 'No partner analytics are available for the selected range.' })} />
                                        ) : salesAnalytics.partnerRows.slice(0, 10).map((row) => (
                                            <TableRow key={row.label}>
                                                <TableCell className="font-medium">{row.label}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.valueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end text-emerald-600">{formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{row.count}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    </div>

                    <Card className="rounded-3xl border border-border/60">
                        <CardHeader className="space-y-2">
                            <CardTitle>{t('finance.sections.salesRecords', { defaultValue: 'Sales Drilldown' })}</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t('finance.sections.salesRecordsDesc', {
                                    defaultValue: 'Open the linked operational page for each record when you need to inspect source details.'
                                })}
                            </p>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('common.date', { defaultValue: 'Date' })}</TableHead>
                                            <TableHead>{t('sales.id', { defaultValue: 'Reference' })}</TableHead>
                                            <TableHead>{t('sales.origin', { defaultValue: 'Origin' })}</TableHead>
                                            <TableHead>{t('finance.columns.member', { defaultValue: 'Member' })}</TableHead>
                                            <TableHead>{t('finance.columns.partner', { defaultValue: 'Partner' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.revenue', { defaultValue: 'Revenue' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.cost', { defaultValue: 'Cost' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.grossProfit', { defaultValue: 'Profit' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.margin', { defaultValue: 'Margin' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {salesAnalytics.recordRows.length === 0 ? (
                                            <TableEmptyRow colSpan={9} label={t('finance.empty.salesRecords', { defaultValue: 'No revenue records are available for the selected range.' })} />
                                        ) : salesAnalytics.recordRows.map((row) => (
                                            <TableRow key={row.key}>
                                                <TableCell className="font-mono text-xs">{formatDate(row.date)}</TableCell>
                                                <TableCell>
                                                    <Button
                                                        variant="ghost"
                                                        className="h-auto p-0 font-mono text-xs text-primary hover:bg-transparent"
                                                        onClick={() => {
                                                            const route = salesRecordRoutes.get(row.key)
                                                            if (route) navigate(route)
                                                        }}
                                                    >
                                                        {row.referenceCode}
                                                    </Button>
                                                </TableCell>
                                                <TableCell>{row.origin}</TableCell>
                                                <TableCell>{row.member}</TableCell>
                                                <TableCell>{row.partner}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.revenueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.costBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end text-emerald-600">{formatCurrency(row.profitBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{row.margin.toFixed(1)}%</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="spend" className="space-y-6">
                    <div className="flex flex-wrap gap-3">
                        {features.budget && (
                            <Button variant="outline" onClick={() => navigate('/budget')}>
                                <ArrowUpRight className="mr-2 h-4 w-4" />
                                {t('nav.budget', { defaultValue: 'Accounting' })}
                            </Button>
                        )}
                        {features.hr && (
                            <Button variant="outline" onClick={() => navigate('/hr')}>
                                <ArrowUpRight className="mr-2 h-4 w-4" />
                                {t('nav.hr', { defaultValue: 'HR' })}
                            </Button>
                        )}
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        <MetricCard
                            label={t('finance.cards.budgetLimit', { defaultValue: 'Budget Limit' })}
                            value={formatCurrency(spendAnalytics.totals.budgetLimitBase, baseCurrency, iqdPreference)}
                            subtitle={spendMonthLabel}
                            icon={Wallet}
                            tone="sky"
                        />
                        <MetricCard
                            label={t('finance.cards.plannedSpend', { defaultValue: 'Planned Spend' })}
                            value={formatCurrency(spendAnalytics.totals.totalAllocatedBase, baseCurrency, iqdPreference)}
                            subtitle={`${spendAnalytics.totals.usageRatio.toFixed(1)}% ${t('finance.cards.used', { defaultValue: 'used' })}`}
                            icon={CalendarDays}
                            tone={spendAnalytics.totals.usageRatio > 100 ? 'rose' : 'amber'}
                            progress={spendAnalytics.totals.usageRatio}
                        />
                        <MetricCard
                            label={t('finance.cards.paidSpend', { defaultValue: 'Paid Spend' })}
                            value={formatCurrency(spendAnalytics.totals.totalPaidBase, baseCurrency, iqdPreference)}
                            subtitle={`${spendAnalytics.totals.burnRate.toFixed(1)}% ${t('finance.cards.burnRate', { defaultValue: 'burn rate' })}`}
                            icon={DollarSign}
                            tone="emerald"
                            progress={spendAnalytics.totals.burnRate}
                        />
                        <MetricCard
                            label={t('finance.cards.outstanding', { defaultValue: 'Outstanding' })}
                            value={formatCurrency(spendAnalytics.totals.totalOutstandingBase, baseCurrency, iqdPreference)}
                            subtitle={`${spendAnalytics.totals.overdueCount} ${t('finance.cards.overdueItems', { defaultValue: 'overdue items' })}`}
                            icon={AlertTriangle}
                            tone={spendAnalytics.totals.overdueCount > 0 ? 'rose' : 'amber'}
                        />
                        <MetricCard
                            label={t('finance.cards.dividends', { defaultValue: 'Dividends' })}
                            value={formatCurrency(spendAnalytics.totals.dividendTotalBase, baseCurrency, iqdPreference)}
                            subtitle={t('finance.cards.profitShare', { defaultValue: 'profit-share distribution' })}
                            icon={UsersRound}
                            tone="sky"
                        />
                        <MetricCard
                            label={t('finance.cards.runRate', { defaultValue: 'Run-Rate Projection' })}
                            value={formatCurrency(spendAnalytics.totals.projectedRunRateBase, baseCurrency, iqdPreference)}
                            subtitle={t('finance.cards.endOfMonth', { defaultValue: 'projected paid spend by month end' })}
                            icon={TrendingUp}
                            tone="slate"
                        />
                    </div>

                    <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader className="space-y-2">
                                <CardTitle>{t('finance.sections.spendTrend', { defaultValue: 'Monthly Spend Flow' })}</CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    {t('finance.sections.spendTrendDesc', {
                                        defaultValue: 'Daily revenue-derived profit against operational spend, payroll, and dividends.'
                                    })}
                                </p>
                            </CardHeader>
                            <CardContent className="h-[340px] pt-0">
                                <ResponsiveContainer width="100%" height="100%">
                                    <AreaChart data={monthlyFinanceTrend}>
                                        <defs>
                                            <linearGradient id="spendProfit" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#2563eb" stopOpacity={0.35} />
                                                <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/50" />
                                        <XAxis dataKey="label" tickLine={false} axisLine={false} />
                                        <YAxis
                                            tickLine={false}
                                            axisLine={false}
                                            tickFormatter={(value) => formatCurrency(Number(value || 0), baseCurrency, iqdPreference)}
                                            width={90}
                                        />
                                        <RechartsTooltip
                                            formatter={(value: number | string | undefined, name: string | undefined) => [formatCurrency(Number(value || 0), baseCurrency, iqdPreference), name || '']}
                                        />
                                        <Bar dataKey="spendBase" name={t('finance.cards.plannedSpend', { defaultValue: 'Spend' })} fill="#f59e0b" radius={[10, 10, 0, 0]} />
                                        <Area type="monotone" dataKey="profitBase" name={t('finance.cards.projectedRemainder', { defaultValue: 'Net Outcome' })} stroke="#2563eb" fill="url(#spendProfit)" strokeWidth={2.2} />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </CardContent>
                        </Card>

                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader className="space-y-2">
                                <CardTitle>{t('finance.sections.spendHealth', { defaultValue: 'Spend Health' })}</CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    {t('finance.sections.spendHealthDesc', {
                                        defaultValue: 'Budget ratio, month net profit, and projected remainder for the selected month.'
                                    })}
                                </p>
                            </CardHeader>
                            <CardContent className="space-y-5">
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="font-medium">{t('finance.cards.usageRatio', { defaultValue: 'Usage ratio' })}</span>
                                        <span className="text-sm font-black">{spendAnalytics.totals.usageRatio.toFixed(1)}%</span>
                                    </div>
                                    <Progress value={spendAnalytics.totals.usageRatio} className="h-2 bg-muted/40" />
                                </div>
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="font-medium">{t('finance.cards.burnRate', { defaultValue: 'Burn rate' })}</span>
                                        <span className="text-sm font-black">{spendAnalytics.totals.burnRate.toFixed(1)}%</span>
                                    </div>
                                    <Progress value={spendAnalytics.totals.burnRate} className="h-2 bg-muted/40" />
                                </div>

                                <div className="grid gap-3 rounded-2xl bg-secondary/40 p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-sm text-muted-foreground">{t('finance.cards.monthNetProfit', { defaultValue: 'Month Net Profit' })}</span>
                                        <span className="font-semibold">{formatCurrency(spendAnalytics.totals.monthNetProfitBase, baseCurrency, iqdPreference)}</span>
                                    </div>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-sm text-muted-foreground">{t('finance.cards.surplusAfterDistribution', { defaultValue: 'Surplus After Distribution' })}</span>
                                        <span className={cn(
                                            'font-semibold',
                                            spendAnalytics.totals.surplusAfterDistributionBase >= 0 ? 'text-emerald-600' : 'text-rose-600'
                                        )}>
                                            {formatCurrency(spendAnalytics.totals.surplusAfterDistributionBase, baseCurrency, iqdPreference)}
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-sm text-muted-foreground">{t('finance.cards.overdueExposure', { defaultValue: 'Overdue Exposure' })}</span>
                                        <span className="font-semibold">{formatCurrency(spendAnalytics.totals.overdueBase, baseCurrency, iqdPreference)}</span>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    <div className="grid gap-6 xl:grid-cols-3">
                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.expenseCategories', { defaultValue: 'Expense Categories' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('common.category', { defaultValue: 'Category' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.plannedSpend', { defaultValue: 'Planned' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.paidSpend', { defaultValue: 'Paid' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {spendAnalytics.categoryRows.length === 0 ? (
                                            <TableEmptyRow colSpan={3} label={t('finance.empty.expenseCategories', { defaultValue: 'No expense categories are available for the selected month.' })} />
                                        ) : spendAnalytics.categoryRows.map((row) => (
                                            <TableRow key={row.label}>
                                                <TableCell className="font-medium">{row.label}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.valueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference)}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>

                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.payrollDepartments', { defaultValue: 'Payroll by Department' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('common.description', { defaultValue: 'Department' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.plannedSpend', { defaultValue: 'Planned' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.paidSpend', { defaultValue: 'Paid' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {spendAnalytics.departmentRows.length === 0 ? (
                                            <TableEmptyRow colSpan={3} label={t('finance.empty.payrollDepartments', { defaultValue: 'No payroll items are available for the selected month.' })} />
                                        ) : spendAnalytics.departmentRows.map((row) => (
                                            <TableRow key={row.label}>
                                                <TableCell className="font-medium">{row.label}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.valueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference)}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>

                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.dividends', { defaultValue: 'Dividend Distribution' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('common.item', { defaultValue: 'Employee' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.dividends', { defaultValue: 'Payout' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.baseAmount', { defaultValue: 'Base Amount' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {spendAnalytics.dividendRows.length === 0 ? (
                                            <TableEmptyRow colSpan={3} label={t('finance.empty.dividends', { defaultValue: 'No dividend items are available for the selected month.' })} />
                                        ) : spendAnalytics.dividendRows.map((row) => (
                                            <TableRow key={row.label}>
                                                <TableCell className="font-medium">{row.label}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.valueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference)}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                <TabsContent value="loans" className="space-y-6">
                    <div className="flex flex-wrap gap-3">
                        <Button variant="outline" onClick={() => navigate('/loans')}>
                            <ArrowUpRight className="mr-2 h-4 w-4" />
                            {t('nav.loans', { defaultValue: 'Loans' })}
                        </Button>
                        <Button variant="outline" onClick={() => navigate('/installments')}>
                            <ArrowUpRight className="mr-2 h-4 w-4" />
                            {t('nav.installments', { defaultValue: 'Installments' })}
                        </Button>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <MetricCard
                            label={t('finance.cards.outstandingLoans', { defaultValue: 'Outstanding Balance' })}
                            value={formatCurrency(loanAnalytics.totals.outstandingBase, baseCurrency, iqdPreference)}
                            subtitle={`${loanAnalytics.totals.activeCount} ${t('finance.cards.activeLoans', { defaultValue: 'active loans' })}`}
                            icon={HandCoins}
                            tone="sky"
                        />
                        <MetricCard
                            label={t('finance.cards.collections', { defaultValue: 'Collections' })}
                            value={formatCurrency(loanAnalytics.totals.collectedBase, baseCurrency, iqdPreference)}
                            subtitle={dateRangeLabel}
                            icon={DollarSign}
                            tone="emerald"
                        />
                        <MetricCard
                            label={t('finance.cards.dueSoon', { defaultValue: 'Due Soon' })}
                            value={formatCurrency(loanAnalytics.totals.dueSoonBase, baseCurrency, iqdPreference)}
                            subtitle={`${loanAnalytics.totals.dueSoonCount} ${t('finance.cards.installments', { defaultValue: 'installments' })}`}
                            icon={CalendarDays}
                            tone="amber"
                        />
                        <MetricCard
                            label={t('finance.cards.overdue', { defaultValue: 'Overdue' })}
                            value={formatCurrency(loanAnalytics.totals.overdueBase, baseCurrency, iqdPreference)}
                            subtitle={`${loanAnalytics.totals.overdueCount} ${t('finance.cards.installments', { defaultValue: 'installments' })}`}
                            icon={AlertTriangle}
                            tone={loanAnalytics.totals.overdueCount > 0 ? 'rose' : 'amber'}
                        />
                    </div>

                    <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader className="space-y-2">
                                <CardTitle>{t('finance.sections.loanCollections', { defaultValue: 'Loan Collection Trend' })}</CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    {t('finance.sections.loanCollectionsDesc', {
                                        defaultValue: 'Payments received in the active date range.'
                                    })}
                                </p>
                            </CardHeader>
                            <CardContent className="h-[320px] pt-0">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={loanAnalytics.paymentTrend}>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/50" />
                                        <XAxis dataKey="label" tickLine={false} axisLine={false} />
                                        <YAxis
                                            tickLine={false}
                                            axisLine={false}
                                            tickFormatter={(value) => formatCurrency(Number(value || 0), baseCurrency, iqdPreference)}
                                            width={90}
                                        />
                                        <RechartsTooltip
                                            formatter={(value: number | string | undefined) => formatCurrency(Number(value || 0), baseCurrency, iqdPreference)}
                                        />
                                        <Line type="monotone" dataKey="revenueBase" name={t('finance.cards.collections', { defaultValue: 'Collections' })} stroke="#10b981" strokeWidth={2.8} dot={false} />
                                    </LineChart>
                                </ResponsiveContainer>
                            </CardContent>
                        </Card>

                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.directionSplit', { defaultValue: 'Direction Split' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('finance.columns.direction', { defaultValue: 'Direction' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.outstandingLoans', { defaultValue: 'Outstanding' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.principal', { defaultValue: 'Principal' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {loanAnalytics.directionRows.length === 0 ? (
                                            <TableEmptyRow colSpan={3} label={t('finance.empty.loanDirections', { defaultValue: 'No active loan balances are available.' })} />
                                        ) : loanAnalytics.directionRows.map((row) => (
                                            <TableRow key={row.label}>
                                                <TableCell className="font-medium">{row.label}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.valueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference)}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    </div>

                    <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.loanPartners', { defaultValue: 'Linked Partner Exposure' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('finance.columns.partner', { defaultValue: 'Partner' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.outstandingLoans', { defaultValue: 'Outstanding' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.principal', { defaultValue: 'Principal' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {loanAnalytics.partnerRows.length === 0 ? (
                                            <TableEmptyRow colSpan={3} label={t('finance.empty.loanPartners', { defaultValue: 'No linked loan exposure is available.' })} />
                                        ) : loanAnalytics.partnerRows.map((row) => (
                                            <TableRow key={row.label}>
                                                <TableCell className="font-medium">{row.label}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.valueBase, baseCurrency, iqdPreference)}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.secondaryValueBase, baseCurrency, iqdPreference)}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>

                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.loanBook', { defaultValue: 'Loan Book' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="overflow-x-auto">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>{t('sales.id', { defaultValue: 'Loan' })}</TableHead>
                                                <TableHead>{t('finance.columns.direction', { defaultValue: 'Direction' })}</TableHead>
                                                <TableHead>{t('finance.columns.borrower', { defaultValue: 'Borrower' })}</TableHead>
                                                <TableHead>{t('finance.columns.partner', { defaultValue: 'Linked Party' })}</TableHead>
                                                <TableHead>{t('common.status', { defaultValue: 'Status' })}</TableHead>
                                                <TableHead className="text-end">{t('finance.cards.outstandingLoans', { defaultValue: 'Balance' })}</TableHead>
                                                <TableHead className="text-end">{t('common.date', { defaultValue: 'Next Due' })}</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {loanAnalytics.loanRows.length === 0 ? (
                                                <TableEmptyRow colSpan={7} label={t('finance.empty.loanBook', { defaultValue: 'No loan rows are available.' })} />
                                            ) : loanAnalytics.loanRows.map((row) => (
                                                <TableRow key={row.loanNo}>
                                                    <TableCell>
                                                        <Button
                                                            variant="ghost"
                                                            className="h-auto p-0 font-mono text-xs text-primary hover:bg-transparent"
                                                            onClick={() => navigate(`/loans/${row.loanId}`)}
                                                        >
                                                            {row.loanNo}
                                                        </Button>
                                                    </TableCell>
                                                    <TableCell>{row.direction}</TableCell>
                                                    <TableCell>{row.borrowerName}</TableCell>
                                                    <TableCell>{row.linkedPartyName}</TableCell>
                                                    <TableCell>{row.status}</TableCell>
                                                    <TableCell className="text-end">{formatCurrency(row.balanceBase, baseCurrency, iqdPreference)}</TableCell>
                                                    <TableCell className="text-end">{row.nextDueDate ? formatDate(row.nextDueDate) : '-'}</TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    <Card className="rounded-3xl border border-border/60">
                        <CardHeader className="space-y-2">
                            <CardTitle>{t('finance.sections.installments', { defaultValue: 'Upcoming & Overdue Installments' })}</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t('finance.sections.installmentsDesc', {
                                    defaultValue: 'Sorted with overdue installments first, then by due date.'
                                })}
                            </p>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{t('sales.id', { defaultValue: 'Loan' })}</TableHead>
                                            <TableHead>{t('finance.columns.borrower', { defaultValue: 'Borrower' })}</TableHead>
                                            <TableHead>{t('finance.columns.partner', { defaultValue: 'Linked Party' })}</TableHead>
                                            <TableHead>{t('common.status', { defaultValue: 'Status' })}</TableHead>
                                            <TableHead>{t('common.date', { defaultValue: 'Due Date' })}</TableHead>
                                            <TableHead className="text-end">{t('finance.cards.outstandingLoans', { defaultValue: 'Balance' })}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {loanAnalytics.installmentRows.length === 0 ? (
                                            <TableEmptyRow colSpan={6} label={t('finance.empty.installments', { defaultValue: 'No installment rows are available.' })} />
                                        ) : loanAnalytics.installmentRows.map((row) => (
                                            <TableRow key={`${row.loanNo}-${row.dueDate}`}>
                                                <TableCell>
                                                    <Button
                                                        variant="ghost"
                                                        className="h-auto p-0 font-mono text-xs text-primary hover:bg-transparent"
                                                        onClick={() => navigate(`/installments/${row.loanId}`)}
                                                    >
                                                        {row.loanNo}
                                                    </Button>
                                                </TableCell>
                                                <TableCell>{row.borrowerName}</TableCell>
                                                <TableCell>{row.linkedPartyName}</TableCell>
                                                <TableCell>{row.status}</TableCell>
                                                <TableCell>{formatDate(row.dueDate)}</TableCell>
                                                <TableCell className="text-end">{formatCurrency(row.balanceBase, baseCurrency, iqdPreference)}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="partners" className="space-y-6">
                    <div className="flex flex-wrap gap-3">
                        {features.crm && (
                            <Button variant="outline" onClick={() => navigate('/business-partners')}>
                                <ArrowUpRight className="mr-2 h-4 w-4" />
                                {t('businessPartners.title', { defaultValue: 'Business Partners' })}
                            </Button>
                        )}
                        {features.travel_agency && (
                            <Button variant="outline" onClick={() => navigate('/travel-agency')}>
                                <ArrowUpRight className="mr-2 h-4 w-4" />
                                {t('nav.travelAgency', { defaultValue: 'Travel Agency' })}
                            </Button>
                        )}
                    </div>

                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <MetricCard
                            label={t('finance.cards.receivables', { defaultValue: 'Receivables' })}
                            value={formatCurrency(partnerAnalytics.totals.receivableBase, baseCurrency, iqdPreference)}
                            subtitle={t('finance.cards.partnerOutstanding', { defaultValue: 'customer-side partner exposure' })}
                            icon={UsersRound}
                            tone="sky"
                        />
                        <MetricCard
                            label={t('finance.cards.payables', { defaultValue: 'Payables' })}
                            value={formatCurrency(partnerAnalytics.totals.payableBase, baseCurrency, iqdPreference)}
                            subtitle={t('finance.cards.partnerOutstanding', { defaultValue: 'supplier-side partner exposure' })}
                            icon={Wallet}
                            tone="amber"
                        />
                        <MetricCard
                            label={t('finance.cards.loanExposure', { defaultValue: 'Loan Exposure' })}
                            value={formatCurrency(partnerAnalytics.totals.loanExposureBase, baseCurrency, iqdPreference)}
                            subtitle={`${partnerAnalytics.partnerRows.length} ${t('finance.cards.partners', { defaultValue: 'partners' })}`}
                            icon={HandCoins}
                            tone="slate"
                        />
                        <MetricCard
                            label={t('finance.cards.travelCommission', { defaultValue: 'Travel Commission' })}
                            value={formatCurrency(partnerAnalytics.totals.travelCommissionBase, baseCurrency, iqdPreference)}
                            subtitle={`${partnerAnalytics.totals.completedTravelSalesCount} ${t('finance.cards.completedSales', { defaultValue: 'completed sales' })}`}
                            icon={Plane}
                            tone="emerald"
                        />
                    </div>

                    <Card className="rounded-3xl border border-border/60">
                        <CardHeader className="space-y-2">
                            <CardTitle>{t('finance.sections.commissionTrend', { defaultValue: 'Commission Trend' })}</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t('finance.sections.commissionTrendDesc', {
                                    defaultValue: 'Completed travel-agency revenue, supplier cost, and commission over the active range.'
                                })}
                            </p>
                        </CardHeader>
                        <CardContent className="h-[320px] pt-0">
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={partnerAnalytics.commissionTrend}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border/50" />
                                    <XAxis dataKey="label" tickLine={false} axisLine={false} />
                                    <YAxis
                                        tickLine={false}
                                        axisLine={false}
                                        tickFormatter={(value) => formatCurrency(Number(value || 0), baseCurrency, iqdPreference)}
                                        width={90}
                                    />
                                    <RechartsTooltip
                                        formatter={(value: number | string | undefined, name: string | undefined) => [formatCurrency(Number(value || 0), baseCurrency, iqdPreference), name || '']}
                                    />
                                    <Line type="monotone" dataKey="revenueBase" name={t('finance.cards.revenue', { defaultValue: 'Revenue' })} stroke="#0ea5e9" strokeWidth={2.4} dot={false} />
                                    <Line type="monotone" dataKey="commissionBase" name={t('finance.cards.travelCommission', { defaultValue: 'Commission' })} stroke="#10b981" strokeWidth={2.4} dot={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>

                    <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
                        <Card className="rounded-3xl border border-border/60">
                            <CardHeader>
                                <CardTitle>{t('finance.sections.partnerExposureTable', { defaultValue: 'Partner Exposure Table' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="overflow-x-auto">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>{t('finance.columns.partner', { defaultValue: 'Partner' })}</TableHead>
                                                <TableHead>{t('common.status', { defaultValue: 'Role' })}</TableHead>
                                                <TableHead className="text-end">{t('finance.cards.receivables', { defaultValue: 'Receivable' })}</TableHead>
                                                <TableHead className="text-end">{t('finance.cards.payables', { defaultValue: 'Payable' })}</TableHead>
                                                <TableHead className="text-end">{t('finance.cards.loanExposure', { defaultValue: 'Loan' })}</TableHead>
                                                <TableHead className="text-end">{t('finance.cards.partnerExposure', { defaultValue: 'Net Exposure' })}</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {partnerAnalytics.partnerRows.length === 0 ? (
                                                <TableEmptyRow colSpan={6} label={t('finance.empty.partnerExposure', { defaultValue: 'No partner exposure rows are available.' })} />
                                            ) : partnerAnalytics.partnerRows.map((row) => (
                                                <TableRow key={row.partnerId}>
                                                    <TableCell>
                                                        <Button
                                                            variant="ghost"
                                                            className="h-auto p-0 font-medium text-primary hover:bg-transparent"
                                                            onClick={() => navigate(`/business-partners/${row.partnerId}`)}
                                                        >
                                                            {row.partnerName}
                                                        </Button>
                                                    </TableCell>
                                                    <TableCell>{row.role}</TableCell>
                                                    <TableCell className="text-end">{formatCurrency(row.receivableBase, baseCurrency, iqdPreference)}</TableCell>
                                                    <TableCell className="text-end">{formatCurrency(row.payableBase, baseCurrency, iqdPreference)}</TableCell>
                                                    <TableCell className="text-end">{formatCurrency(row.loanExposureBase, baseCurrency, iqdPreference)}</TableCell>
                                                    <TableCell className={cn(
                                                        'text-end font-semibold',
                                                        row.netExposureBase >= 0 ? 'text-emerald-600' : 'text-rose-600'
                                                    )}>
                                                        {formatCurrency(row.netExposureBase, baseCurrency, iqdPreference)}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            </CardContent>
                        </Card>

                        <div className="space-y-6">
                            <Card className="rounded-3xl border border-border/60">
                                <CardHeader>
                                    <CardTitle>{t('finance.sections.topSuppliers', { defaultValue: 'Top Travel Suppliers' })}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>{t('finance.columns.supplier', { defaultValue: 'Supplier' })}</TableHead>
                                                <TableHead className="text-end">{t('finance.cards.travelCommission', { defaultValue: 'Commission' })}</TableHead>
                                                <TableHead className="text-end">{t('finance.cards.completedSales', { defaultValue: 'Sales' })}</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {partnerAnalytics.supplierRows.length === 0 ? (
                                                <TableEmptyRow colSpan={3} label={t('finance.empty.travelSuppliers', { defaultValue: 'No travel supplier totals are available.' })} />
                                            ) : partnerAnalytics.supplierRows.slice(0, 10).map((row) => (
                                                <TableRow key={row.label}>
                                                    <TableCell className="font-medium">{row.label}</TableCell>
                                                    <TableCell className="text-end text-emerald-600">{formatCurrency(row.commissionBase, baseCurrency, iqdPreference)}</TableCell>
                                                    <TableCell className="text-end">{row.count}</TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </CardContent>
                            </Card>

                            <Card className="rounded-3xl border border-border/60">
                                <CardHeader>
                                    <CardTitle>{t('finance.sections.topGroups', { defaultValue: 'Top Groups' })}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>{t('finance.columns.group', { defaultValue: 'Group' })}</TableHead>
                                                <TableHead className="text-end">{t('finance.cards.travelCommission', { defaultValue: 'Commission' })}</TableHead>
                                                <TableHead className="text-end">{t('finance.cards.completedSales', { defaultValue: 'Sales' })}</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {partnerAnalytics.groupRows.length === 0 ? (
                                                <TableEmptyRow colSpan={3} label={t('finance.empty.travelGroups', { defaultValue: 'No travel group totals are available.' })} />
                                            ) : partnerAnalytics.groupRows.slice(0, 10).map((row) => (
                                                <TableRow key={row.label}>
                                                    <TableCell className="font-medium">{row.label}</TableCell>
                                                    <TableCell className="text-end text-emerald-600">{formatCurrency(row.commissionBase, baseCurrency, iqdPreference)}</TableCell>
                                                    <TableCell className="text-end">{row.count}</TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                </TabsContent>
            </Tabs>

            <ExportPreviewModal
                isOpen={isExportOpen}
                onClose={() => setIsExportOpen(false)}
                type="finance"
                records={activeExportRows}
            />
        </div>
    )
}
