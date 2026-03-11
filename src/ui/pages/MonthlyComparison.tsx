import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
    Activity,
    ArrowDownRight,
    ArrowUpRight,
    BarChart3,
    CalendarDays,
    Clock,
    DollarSign,
    Package,
    Percent,
    RotateCcw,
    Sparkles,
    TrendingDown,
    TrendingUp,
    Wallet,
} from 'lucide-react'
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Legend,
    Line,
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
    XAxis,
    YAxis,
} from 'recharts'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { db } from '@/local-db/database'
import { cn, formatCurrency } from '@/lib/utils'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { convertToStoreBase as convertToStoreBaseUtil } from '@/lib/currency'
import { useSales, toUISale, useBudgetAllocations, useExpenseSeries, useEmployees, usePayrollStatuses, useDividendStatuses, ensureExpenseItemsForMonth } from '@/local-db'
import type { BudgetAllocation, ExpenseItem, ExpenseSeries, Employee, PayrollStatus, DividendStatus } from '@/local-db/models'
import { buildPayrollItems, buildDividendItems, calculateNetProfitForMonth, buildConversionRates } from '@/lib/budget'
import type { Sale, SaleItem } from '@/types'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
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
    TabsTrigger,
} from '@/ui/components'
import { MiniHeatmap } from '@/ui/components/revenue/MiniHeatmap'

type MonthKey = `${number}-${string}`
type ComparisonMetric = 'revenue' | 'profit' | 'spend'
type PeakView = 'hourly' | 'heatmap'

interface MonthOption {
    value: MonthKey
    label: string
    hasSales: boolean
    hasExpenses: boolean
    hasAllocation: boolean
}

interface CurrencyTotals {
    revenue: number
    cost: number
    profit: number
    transactions: number
}

interface ProductSummary {
    id: string
    name: string
    revenue: number
    quantity: number
    share: number
}

interface ReturnsSummary {
    totalReturns: number
    refundedAmount: number
    returnRate: number
    topProducts: Array<{ name: string; count: number; amount: number }>
}

interface SalesSnapshot {
    month: MonthKey
    sales: Sale[]
    currencyTotals: Record<string, CurrencyTotals>
    baseTotals: {
        revenue: number
        cost: number
        profit: number
        margin: number
        transactions: number
    }
    cumulativeRevenue: number[]
    cumulativeProfit: number[]
    categories: Array<{ name: string; value: number }>
    topProducts: ProductSummary[]
    returns: ReturnsSummary
    hourly: Array<{ hour: number; label: string; count: number }>
    peakHourLabel: string
}

interface BudgetSnapshot {
    totalAllocated: number
    paid: number
    outstanding: number
    dividends: number
    retained: number
    isDeficit: boolean
    budgetLimit: number
    operationalTotal: number
    personnelTotal: number
    expenseCategories: Array<{ name: string; value: number }>
    cumulativeSpend: number[]
}

interface MonthSnapshot {
    option: MonthOption
    sales: SalesSnapshot
    budget: BudgetSnapshot
}

interface DeltaCardConfig {
    key: string
    label: string
    leftValue: number
    rightValue: number
    format: 'currency' | 'percent'
    icon: React.ComponentType<{ className?: string }>
    tone: 'blue' | 'emerald' | 'violet' | 'orange' | 'sky'
}

interface PaceDataPoint {
    day: number
    leftActual: number | null
    leftProjected: number | null
    rightActual: number | null
    rightProjected: number | null
}

interface MonthlyComparisonFallbackLabels {
    uncategorized: string
    unknownProduct: string
    payroll: string
}

const LEFT_ACCENT = {
    badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/20',
    soft: 'bg-blue-500/5 border-blue-500/15',
    text: 'text-blue-600 dark:text-blue-400',
    line: '#3b82f6',
}

const RIGHT_ACCENT = {
    badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20',
    soft: 'bg-amber-500/5 border-amber-500/15',
    text: 'text-amber-600 dark:text-amber-400',
    line: '#f59e0b',
}


function monthKeyFromDate(date: Date | string): MonthKey {
    const d = new Date(date)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` as MonthKey
}

function monthDateFromKey(month: MonthKey) {
    const [year, monthIndex] = month.split('-').map(Number)
    return new Date(year, monthIndex - 1, 1)
}

const KURDISH_MONTH_NAMES = [
    'کانوونی دووەم',
    'شوبات',
    'ئازار',
    'نیسان',
    'ئایار',
    'حوزەیران',
    'تەمووز',
    'ئاب',
    'ئەیلوول',
    'تشرینی یەکەم',
    'تشرینی دووەم',
    'کانونی یەکەم',
]

void KURDISH_MONTH_NAMES

function formatMonthLabel(month: MonthKey, language: string) {
    return formatLocalizedMonthYear(monthDateFromKey(month), language)
}

function getDaysInMonth(month: MonthKey) {
    const [year, monthIndex] = month.split('-').map(Number)
    return new Date(year, monthIndex, 0).getDate()
}

function safePercentChange(next: number, prev: number) {
    if (prev === 0) return next === 0 ? 0 : 100
    return ((next - prev) / Math.abs(prev)) * 100
}

function clampPercentage(value: number) {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(value, 100))
}

function getMarginBand(margin: number, t: TFunction) {
    if (margin >= 25) return t('monthlyComparison.marginBand.strong')
    if (margin >= 12) return t('monthlyComparison.marginBand.average')
    return t('monthlyComparison.marginBand.weak')
}

function buildToolbarMeta(option: MonthOption, t: TFunction) {
    return t('monthlyComparison.meta.toolbarSummary', {
        sales: t(option.hasSales ? 'monthlyComparison.meta.sales' : 'monthlyComparison.meta.noSales'),
        expenses: t(option.hasExpenses ? 'monthlyComparison.meta.expenses' : 'monthlyComparison.meta.noExpenses'),
        budget: t(option.hasAllocation ? 'monthlyComparison.meta.budgetSet' : 'monthlyComparison.meta.budgetNotSet'),
    })
}

function buildAvailableMonths(
    sales: Sale[],
    allocations: BudgetAllocation[],
    expenseItems: ExpenseItem[],
    language: string
): MonthOption[] {
    const monthMap = new Map<MonthKey, MonthOption>()

    const ensureMonth = (key: MonthKey) => {
        if (!monthMap.has(key)) {
            monthMap.set(key, {
                value: key,
                label: formatMonthLabel(key, language),
                hasSales: false,
                hasExpenses: false,
                hasAllocation: false,
            })
        }
        return monthMap.get(key)!
    }

    sales.forEach(sale => {
        const key = monthKeyFromDate(sale.created_at)
        const entry = ensureMonth(key)
        entry.hasSales = true
    })

    allocations.forEach(allocation => {
        const key = allocation.month as MonthKey
        const entry = ensureMonth(key)
        entry.hasAllocation = true
    })

    expenseItems.forEach(item => {
        const key = item.month as MonthKey
        const entry = ensureMonth(key)
        entry.hasExpenses = true
    })

    return Array.from(monthMap.values()).sort((a, b) => b.value.localeCompare(a.value))
}

function analyzeSalesMonth(
    sales: Sale[],
    month: MonthKey,
    baseCurrency: string,
    convertToBase: (amount: number | undefined | null, currency: string | undefined | null) => number,
    labels: MonthlyComparisonFallbackLabels
): SalesSnapshot {
    const monthSales = sales.filter(sale => monthKeyFromDate(sale.created_at) === month)
    const currencyTotals: Record<string, CurrencyTotals> = {}
    const daysInMonth = getDaysInMonth(month)
    const revenueByDay = new Array(daysInMonth).fill(0)
    const profitByDay = new Array(daysInMonth).fill(0)
    const categoryRevenue: Record<string, number> = {}
    const productPerformance: Record<string, { id: string; name: string; revenue: number; quantity: number }> = {}
    const productReturns: Record<string, { name: string; count: number; amount: number }> = {}
    const hourlyCounts = new Array(24).fill(0)

    let totalRevenue = 0
    let totalCost = 0
    let transactions = 0
    let totalReturns = 0
    let totalRefunded = 0

    monthSales.forEach(sale => {
        const currency = sale.settlement_currency || baseCurrency
        const dayIndex = new Date(sale.created_at).getDate() - 1
        const hour = new Date(sale.created_at).getHours()
        const items = sale.items || []

        let saleRevenueInCurrency = 0
        let saleCostInCurrency = 0
        let saleHasReturn = false
        let saleRefundedInCurrency = 0

        items.forEach((item: SaleItem) => {
            const netQuantity = item.quantity - (item.returned_quantity || 0)

            if (!sale.is_returned && netQuantity > 0) {
                const itemRevenue = (item.converted_unit_price || 0) * netQuantity
                const itemCost = (item.converted_cost_price || 0) * netQuantity
                const itemRevenueBase = convertToBase(itemRevenue, currency)

                saleRevenueInCurrency += itemRevenue
                saleCostInCurrency += itemCost

                const category = item.product_category || item.product?.category || labels.uncategorized
                categoryRevenue[category] = (categoryRevenue[category] || 0) + itemRevenueBase

                const productId = item.product_id || item.id
                if (!productPerformance[productId]) {
                    productPerformance[productId] = {
                        id: productId,
                        name: item.product_name || item.product?.name || labels.unknownProduct,
                        revenue: 0,
                        quantity: 0,
                    }
                }
                productPerformance[productId].revenue += itemRevenueBase
                productPerformance[productId].quantity += netQuantity
            }

            let qtyReturned = 0
            if (sale.is_returned) qtyReturned = item.quantity
            else if (item.is_returned) qtyReturned = item.quantity
            else if ((item.returned_quantity || 0) > 0) qtyReturned = item.returned_quantity || 0

            if (qtyReturned > 0) {
                saleHasReturn = true
                const refundValue = (item.converted_unit_price || 0) * qtyReturned
                saleRefundedInCurrency += refundValue

                const productId = item.product_id || item.id
                if (!productReturns[productId]) {
                    productReturns[productId] = {
                        name: item.product_name || item.product?.name || labels.unknownProduct,
                        count: 0,
                        amount: 0,
                    }
                }
                productReturns[productId].count += qtyReturned
                productReturns[productId].amount += convertToBase(refundValue, currency)
            }
        })

        if (saleHasReturn) {
            totalReturns += 1
            totalRefunded += convertToBase(saleRefundedInCurrency || sale.total_amount, currency)
        }

        if (sale.is_returned) return

        if (!currencyTotals[currency]) {
            currencyTotals[currency] = { revenue: 0, cost: 0, profit: 0, transactions: 0 }
        }

        const saleRevenueBase = convertToBase(saleRevenueInCurrency, currency)
        const saleCostBase = convertToBase(saleCostInCurrency, currency)
        const saleProfitBase = saleRevenueBase - saleCostBase

        currencyTotals[currency].revenue += saleRevenueInCurrency
        currencyTotals[currency].cost += saleCostInCurrency
        currencyTotals[currency].profit += saleRevenueInCurrency - saleCostInCurrency
        currencyTotals[currency].transactions += 1

        totalRevenue += saleRevenueBase
        totalCost += saleCostBase
        transactions += 1
        revenueByDay[dayIndex] += saleRevenueBase
        profitByDay[dayIndex] += saleProfitBase
        hourlyCounts[hour] += 1
    })

    const cumulativeRevenue: number[] = []
    const cumulativeProfit: number[] = []
    let runningRevenue = 0
    let runningProfit = 0
    for (let i = 0; i < daysInMonth; i++) {
        runningRevenue += revenueByDay[i]
        runningProfit += profitByDay[i]
        cumulativeRevenue.push(runningRevenue)
        cumulativeProfit.push(runningProfit)
    }

    const topProducts = Object.values(productPerformance)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 8)
        .map(product => ({ ...product, share: totalRevenue > 0 ? (product.revenue / totalRevenue) * 100 : 0 }))

    const hourly = hourlyCounts.map((count, hour) => ({
        hour,
        label: `${String(hour).padStart(2, '0')}:00`,
        count,
    }))
    const peakHour = hourly.reduce((best, point) => (point.count > best.count ? point : best), hourly[0] || { label: '00:00', count: 0 })

    return {
        month,
        sales: monthSales,
        currencyTotals,
        baseTotals: {
            revenue: totalRevenue,
            cost: totalCost,
            profit: totalRevenue - totalCost,
            margin: totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0,
            transactions,
        },
        cumulativeRevenue,
        cumulativeProfit,
        categories: Object.entries(categoryRevenue).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
        topProducts,
        returns: {
            totalReturns,
            refundedAmount: totalRefunded,
            returnRate: transactions > 0 ? (totalReturns / transactions) * 100 : 0,
            topProducts: Object.values(productReturns).sort((a, b) => b.count - a.count).slice(0, 5),
        },
        hourly,
        peakHourLabel: peakHour?.label || '00:00',
    }
}

function analyzeBudgetMonth(
    month: MonthKey,
    params: {
        expenseItems: ExpenseItem[]
        expenseSeries: ExpenseSeries[]
        employees: Employee[]
        payrollStatuses: PayrollStatus[]
        dividendStatuses: DividendStatus[]
        sales: Sale[]
        baseCurrency: string
        rates: { usd_iqd: number; eur_iqd: number; try_iqd: number }
        allocation?: BudgetAllocation | null
        labels: MonthlyComparisonFallbackLabels
    }
): BudgetSnapshot {
    const {
        expenseItems,
        expenseSeries,
        employees,
        payrollStatuses,
        dividendStatuses,
        sales,
        baseCurrency,
        rates,
        allocation,
        labels
    } = params

    const daysInMonth = getDaysInMonth(month)
    const dailySpend = new Array(daysInMonth).fill(0)

    const seriesById = new Map(expenseSeries.map(series => [series.id, series] as const))

    let operationalTotal = 0
    let operationalPaid = 0
    const expenseCategoryTotals: Record<string, number> = {}

    expenseItems
        .filter(item => item.month === month)
        .forEach(item => {
            const base = convertToStoreBaseUtil(item.amount, item.currency, baseCurrency, rates)
            operationalTotal += base
            if (item.status === 'paid') operationalPaid += base

            const category = seriesById.get(item.seriesId)?.category || labels.uncategorized
            expenseCategoryTotals[category] = (expenseCategoryTotals[category] || 0) + base

            const dayIndex = Math.max(0, Math.min(daysInMonth - 1, new Date(item.dueDate).getDate() - 1))
            dailySpend[dayIndex] += base
        })

    const payrollItems = buildPayrollItems(employees, payrollStatuses, month)
    let payrollTotal = 0
    let payrollPaid = 0
    payrollItems.forEach(item => {
        const base = convertToStoreBaseUtil(item.amount, item.currency, baseCurrency, rates)
        payrollTotal += base
        if (item.status === 'paid') payrollPaid += base
        if (base > 0) {
            expenseCategoryTotals[labels.payroll] = (expenseCategoryTotals[labels.payroll] || 0) + base
        }

        const dayIndex = Math.max(0, Math.min(daysInMonth - 1, new Date(item.dueDate).getDate() - 1))
        dailySpend[dayIndex] += base
    })

    const netProfitBase = calculateNetProfitForMonth(sales, month, baseCurrency as any, rates)
    const surplusPoolBase = netProfitBase - operationalTotal - payrollTotal
    const dividendResult = buildDividendItems(employees, dividendStatuses, month, baseCurrency as any, rates, surplusPoolBase)
    const dividendsTotal = dividendResult.totalBase
    const dividendsPaid = dividendResult.items.reduce((sum, item) => item.status === 'paid' ? sum + item.baseAmount : sum, 0)

    const totalAllocated = operationalTotal + payrollTotal
    const paid = operationalPaid + payrollPaid + dividendsPaid
    const outstanding = (totalAllocated + dividendsTotal) - paid
    const retained = netProfitBase - operationalTotal - payrollTotal - dividendsTotal
    const isDeficit = retained < 0

    let budgetLimit = 0
    if (allocation) {
        const value = allocation.allocationValue || 0
        const isPercent = allocation.allocationType === 'percentage'
        const limitInCurrency = isPercent ? (netProfitBase * value / 100) : value
        budgetLimit = convertToStoreBaseUtil(limitInCurrency, allocation.currency, baseCurrency, rates)
    }

    const cumulativeSpend: number[] = []
    let runningSpend = 0
    for (let i = 0; i < daysInMonth; i += 1) {
        runningSpend += dailySpend[i]
        cumulativeSpend.push(runningSpend)
    }

    return {
        totalAllocated,
        paid,
        outstanding,
        dividends: dividendsTotal,
        retained,
        isDeficit,
        budgetLimit,
        operationalTotal,
        personnelTotal: payrollTotal,
        expenseCategories: Object.entries(expenseCategoryTotals)
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value),
        cumulativeSpend,
    }
}

function buildPaceSeries(
    series: number[],
    month: MonthKey,
    metric: ComparisonMetric
) {
    const daysInMonth = getDaysInMonth(month)
    const actual = new Array<number | null>(daysInMonth).fill(null)
    const projected = new Array<number | null>(daysInMonth).fill(null)
    const currentMonthKey = monthKeyFromDate(new Date())

    if (month !== currentMonthKey) {
        return {
            actual: series.map(value => value ?? 0),
            projected,
            hasProjection: false,
        }
    }

    const today = Math.min(new Date().getDate(), daysInMonth)
    const currentValue = series[Math.max(0, today - 1)] ?? 0

    for (let index = 0; index < today; index += 1) {
        actual[index] = series[index] ?? 0
    }

    if (today >= daysInMonth) {
        return { actual, projected, hasProjection: false }
    }

    projected[today - 1] = currentValue

    if (metric === 'spend') {
        for (let index = today; index < daysInMonth; index += 1) {
            projected[index] = series[index] ?? currentValue
        }
    } else {
        const averageDailyPace = today > 0 ? currentValue / today : 0

        for (let index = today; index < daysInMonth; index += 1) {
            projected[index] = currentValue + averageDailyPace * (index - today + 1)
        }
    }

    return { actual, projected, hasProjection: true }
}

function buildPaceData(left: MonthSnapshot, right: MonthSnapshot, metric: ComparisonMetric): PaceDataPoint[] {
    const maxDays = Math.max(getDaysInMonth(left.option.value), getDaysInMonth(right.option.value))
    const leftSeries = metric === 'revenue' ? left.sales.cumulativeRevenue : metric === 'profit' ? left.sales.cumulativeProfit : left.budget.cumulativeSpend
    const rightSeries = metric === 'revenue' ? right.sales.cumulativeRevenue : metric === 'profit' ? right.sales.cumulativeProfit : right.budget.cumulativeSpend
    const leftPace = buildPaceSeries(leftSeries, left.option.value, metric)
    const rightPace = buildPaceSeries(rightSeries, right.option.value, metric)

    return Array.from({ length: maxDays }, (_, index) => ({
        day: index + 1,
        leftActual: index < leftPace.actual.length ? leftPace.actual[index] : null,
        leftProjected: index < leftPace.projected.length ? leftPace.projected[index] : null,
        rightActual: index < rightPace.actual.length ? rightPace.actual[index] : null,
        rightProjected: index < rightPace.projected.length ? rightPace.projected[index] : null,
    }))
}

function PaceTooltipContent({
    active,
    payload,
    label,
    baseCurrency,
    iqdPreference,
    leftLabel,
    rightLabel,
}: {
    active?: boolean
    payload?: ReadonlyArray<{ payload?: PaceDataPoint }>
    label?: string | number
    baseCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
    leftLabel: string
    rightLabel: string
}) {
    const { t } = useTranslation()
    const point = payload?.find(entry => entry?.payload)?.payload

    if (!active || !point) return null

    const rows = [
        {
            label: leftLabel,
            value: point.leftActual ?? point.leftProjected,
            projected: point.leftActual == null && point.leftProjected != null,
            color: LEFT_ACCENT.line,
        },
        {
            label: rightLabel,
            value: point.rightActual ?? point.rightProjected,
            projected: point.rightActual == null && point.rightProjected != null,
            color: RIGHT_ACCENT.line,
        },
    ]

    return (
        <div className="min-w-[190px] rounded-[18px] border border-border bg-card px-3 py-2.5 shadow-xl">
            <p className="mb-2 text-[11px] font-black uppercase tracking-[0.16em] text-muted-foreground">
                {t('monthlyComparison.dayLabel', { label })}
            </p>
            <div className="space-y-2">
                {rows.map(row => (
                    <div key={row.label} className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                            <span className="truncate text-xs font-semibold text-foreground">{row.label}</span>
                            {row.projected ? (
                                <span className="rounded-full border border-border/60 bg-background/70 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-muted-foreground">
                                    {t('monthlyComparison.projected')}
                                </span>
                            ) : null}
                        </div>
                        <span className="text-xs font-black text-foreground">
                            {row.value == null ? '--' : formatCurrency(row.value, baseCurrency, iqdPreference)}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    )
}

function buildCategoryComparison(leftItems: Array<{ name: string; value: number }>, rightItems: Array<{ name: string; value: number }>, limit = 6) {
    const names = new Set<string>()
    leftItems.slice(0, limit).forEach(item => names.add(item.name))
    rightItems.slice(0, limit).forEach(item => names.add(item.name))

    return Array.from(names)
        .map(name => ({
            name,
            left: leftItems.find(item => item.name === name)?.value || 0,
            right: rightItems.find(item => item.name === name)?.value || 0,
        }))
        .sort((a, b) => (b.left + b.right) - (a.left + a.right))
        .slice(0, limit)
}

function buildTopProductRows(left: MonthSnapshot, right: MonthSnapshot) {
    const combined = new Map<string, { id: string; name: string; leftRevenue: number; rightRevenue: number; leftShare: number; rightShare: number }>()

    left.sales.topProducts.forEach(product => {
        combined.set(product.id, { id: product.id, name: product.name, leftRevenue: product.revenue, rightRevenue: 0, leftShare: product.share, rightShare: 0 })
    })

    right.sales.topProducts.forEach(product => {
        const existing = combined.get(product.id)
        if (existing) {
            existing.rightRevenue = product.revenue
            existing.rightShare = product.share
        } else {
            combined.set(product.id, { id: product.id, name: product.name, leftRevenue: 0, rightRevenue: product.revenue, leftShare: 0, rightShare: product.share })
        }
    })

    const leftTopIds = new Set(left.sales.topProducts.slice(0, 5).map(product => product.id))
    const rightTopIds = new Set(right.sales.topProducts.slice(0, 5).map(product => product.id))

    return Array.from(combined.values())
        .sort((a, b) => (b.leftRevenue + b.rightRevenue) - (a.leftRevenue + a.rightRevenue))
        .slice(0, 5)
        .map((product, index) => ({
            ...product,
            rank: index + 1,
            delta: product.rightRevenue - product.leftRevenue,
            state: leftTopIds.has(product.id) && !rightTopIds.has(product.id) ? 'dropped' : !leftTopIds.has(product.id) && rightTopIds.has(product.id) ? 'new' : null,
        }))
}

function formatSignedShort(value: number) {
    if (value === 0) return '0'
    const abs = Math.abs(value)
    if (abs >= 1000) return `${value > 0 ? '+' : '-'}${(abs / 1000).toFixed(1)}k`
    return `${value > 0 ? '+' : '-'}${abs.toFixed(0)}`
}

function buildInsights(left: MonthSnapshot, right: MonthSnapshot, t: TFunction) {
    const revenueDelta = right.sales.baseTotals.revenue - left.sales.baseTotals.revenue
    const profitDelta = right.sales.baseTotals.profit - left.sales.baseTotals.profit
    const marginDelta = right.sales.baseTotals.margin - left.sales.baseTotals.margin
    const returnsDelta = right.sales.returns.returnRate - left.sales.returns.returnRate
    const topMover = buildTopProductRows(left, right)[0]
    const monthA = left.option.label
    const monthB = right.option.label

    return [
        revenueDelta === 0
            ? t('monthlyComparison.insights.revenueFlat', { monthA, monthB })
            : t(
                revenueDelta > 0
                    ? 'monthlyComparison.insights.revenueOutperformed'
                    : 'monthlyComparison.insights.revenueTrailed',
                {
                    monthA,
                    monthB,
                    percent: Math.abs(safePercentChange(right.sales.baseTotals.revenue, left.sales.baseTotals.revenue)).toFixed(1),
                }
            ),
        profitDelta === 0
            ? t('monthlyComparison.insights.profitFlat', { points: Math.abs(marginDelta).toFixed(1) })
            : t('monthlyComparison.insights.profitChanged', {
                direction: t(profitDelta > 0 ? 'monthlyComparison.insights.direction.up' : 'monthlyComparison.insights.direction.down'),
                marginDirection: t(marginDelta >= 0 ? 'monthlyComparison.insights.marginDirection.expanded' : 'monthlyComparison.insights.marginDirection.compressed'),
                points: Math.abs(marginDelta).toFixed(1),
            }),
        Math.abs(returnsDelta) > 0.5
            ? t(
                returnsDelta >= 0
                    ? 'monthlyComparison.insights.returnsRose'
                    : 'monthlyComparison.insights.returnsFell',
                { points: Math.abs(returnsDelta).toFixed(1) }
            )
            : topMover
                ? t('monthlyComparison.insights.productsStrongestMover', {
                    product: topMover.name,
                    delta: formatSignedShort(topMover.delta),
                })
                : t('monthlyComparison.insights.spendFallback'),
    ]
}

function getChartSummaryLabel(data: Array<{ name: string; left: number; right: number }>, winnerLabel: string, loserLabel: string, t: TFunction) {
    if (data.length === 0) return t('monthlyComparison.chartSummary.noMeaningfulDifference')
    const strongest = [...data].sort((a, b) => Math.abs(b.right - b.left) - Math.abs(a.right - a.left))[0]
    if (!strongest || strongest.left === strongest.right) return t('monthlyComparison.chartSummary.noMeaningfulDifference')
    return t('monthlyComparison.chartSummary.favored', {
        category: strongest.name,
        winner: strongest.right > strongest.left ? winnerLabel : loserLabel,
    })
}

function MonthSelectorCard({
    title,
    accent,
    value,
    options,
    otherValue,
    onChange,
    meta,
    compact = false,
}: {
    title: string
    accent: typeof LEFT_ACCENT
    value: MonthKey
    options: MonthOption[]
    otherValue: MonthKey
    onChange: (value: MonthKey) => void
    meta: string
    compact?: boolean
}) {
    return (
        <Card className={cn(
            'min-w-0 flex-1 border shadow-sm backdrop-blur-sm transition-all duration-200 ease-out',
            compact ? 'rounded-[1.2rem] shadow-none' : 'rounded-[1.75rem]',
            accent.soft,
        )}>
            <CardContent className={cn('transition-all duration-200 ease-out', compact ? 'p-2' : 'p-4')}>
                <div className={cn('flex items-center justify-between gap-3 transition-all duration-200 ease-out', compact ? 'mb-2' : 'mb-3')}>
                    <span className={cn(
                        'inline-flex rounded-full border font-black uppercase transition-all duration-200 ease-out',
                        compact ? 'px-1.5 py-0 text-[8px] tracking-[0.12em]' : 'px-2.5 py-1 text-[10px] tracking-[0.2em]',
                        accent.badge,
                    )}>
                        {title}
                    </span>
                </div>
                <Select value={value} onValueChange={next => onChange(next as MonthKey)}>
                    <SelectTrigger className={cn(
                        'border-border/50 bg-background/70 text-left font-black transition-all duration-200 ease-out',
                        compact ? 'h-9 rounded-[0.9rem] px-3 text-[13px]' : 'h-12 rounded-2xl',
                    )}>
                        <SelectValue placeholder={title} />
                    </SelectTrigger>
                    <SelectContent className="rounded-2xl">
                        {options.map(option => (
                            <SelectItem
                                key={option.value}
                                value={option.value}
                                disabled={option.value === otherValue}
                                className="rounded-xl"
                            >
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p className={cn(
                    'overflow-hidden text-[11px] font-semibold text-muted-foreground transition-all duration-200 ease-out',
                    compact ? 'mt-0 max-h-0 opacity-0' : 'mt-3 max-h-8 opacity-100',
                )}>
                    {meta}
                </p>
            </CardContent>
        </Card>
    )
}

function ComparisonDeltaCard({
    label,
    leftValue,
    rightValue,
    format,
    icon: Icon,
    tone,
    baseCurrency,
    iqdPreference,
    leftLabel,
    rightLabel,
}: Omit<DeltaCardConfig, 'key'> & {
    baseCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
    leftLabel: string
    rightLabel: string
}) {
    const { t } = useTranslation()
    const delta = rightValue - leftValue
    const percent = safePercentChange(rightValue, leftValue)
    const isNeutral = leftValue === 0 && rightValue === 0
    const winner = delta === 0 ? null : delta > 0 ? 'right' : 'left'
    const toneClasses = {
        blue: 'border-blue-500/20 bg-blue-500/5 text-blue-600 dark:text-blue-400',
        emerald: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400',
        violet: 'border-violet-500/20 bg-violet-500/5 text-violet-600 dark:text-violet-400',
        orange: 'border-orange-500/20 bg-orange-500/5 text-orange-600 dark:text-orange-400',
        sky: 'border-sky-500/20 bg-sky-500/5 text-sky-600 dark:text-sky-400',
    }[tone]

    const valueText = format === 'currency'
        ? formatCurrency(Math.abs(delta), baseCurrency, iqdPreference)
        : `${Math.abs(delta).toFixed(1)}%`

    return (
        <Card className={cn('rounded-[1.75rem] border shadow-sm transition-all duration-300 hover:scale-[1.02] hover:shadow-md cursor-default', toneClasses, isNeutral && 'border-border bg-card text-foreground')}>
            <CardContent className="p-3.5 sm:p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <div className={cn('rounded-2xl p-2', !isNeutral && 'bg-background/70')}>
                            <Icon className="h-4 w-4" />
                        </div>
                        <span className="text-[11px] font-black uppercase tracking-[0.18em]">{label}</span>
                    </div>
                    {isNeutral ? (
                        <span className="rounded-full border border-border px-2 py-1 text-[10px] font-bold text-muted-foreground">{t('monthlyComparison.delta.noChange')}</span>
                    ) : (
                        <span className={cn(
                            'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-black',
                            winner === 'right' ? RIGHT_ACCENT.badge : LEFT_ACCENT.badge
                        )}>
                            {delta > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                            {Math.abs(percent).toFixed(1)}%
                        </span>
                    )}
                </div>
                <div className="text-xl font-black tracking-tight">
                    {isNeutral ? t('monthlyComparison.delta.flat') : valueText}
                </div>
                <p className="mt-1 text-[11px] font-medium text-muted-foreground">
                    {t('monthlyComparison.delta.versus', { left: leftLabel, right: rightLabel })}
                </p>
            </CardContent>
        </Card>
    )
}

function BreakdownChipRow({
    currencyTotals,
    iqdPreference,
}: {
    currencyTotals: Record<string, CurrencyTotals>
    iqdPreference: 'IQD' | 'د.ع'
}) {
    const entries = Object.entries(currencyTotals)
    if (entries.length <= 1) return null

    return (
        <div className="mt-3 flex flex-wrap gap-2">
            {entries.map(([currency, totals]) => (
                <span
                    key={currency}
                    className="rounded-full border border-border/60 bg-background/60 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground"
                >
                    {currency}: {formatCurrency(totals.revenue, currency, iqdPreference)}
                </span>
            ))}
        </div>
    )
}

function KpiCard({
    title,
    value,
    icon: Icon,
    tone,
    subtitle,
    progress,
    currencyTotals,
    iqdPreference,
}: {
    title: string
    value: string
    icon: React.ComponentType<{ className?: string }>
    tone: 'blue' | 'orange' | 'emerald' | 'violet' | 'amber' | 'sky' | 'red'
    subtitle: string
    progress?: number
    currencyTotals?: Record<string, CurrencyTotals>
    iqdPreference: 'IQD' | 'د.ع'
}) {
    const toneMap = {
        blue: 'border-blue-500/20 bg-blue-500/5 text-blue-600 dark:text-blue-400',
        orange: 'border-orange-500/20 bg-orange-500/5 text-orange-600 dark:text-orange-400',
        emerald: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400',
        violet: 'border-violet-500/20 bg-violet-500/5 text-violet-600 dark:text-violet-400',
        amber: 'border-amber-500/20 bg-amber-500/5 text-amber-600 dark:text-amber-400',
        sky: 'border-sky-500/20 bg-sky-500/5 text-sky-600 dark:text-sky-400',
        red: 'border-red-500/20 bg-red-500/5 text-red-600 dark:text-red-400',
    }[tone]

    return (
        <Card className={cn('rounded-[1.6rem] border shadow-sm', toneMap)}>
            <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
                        <div className="mt-2 break-words text-xl font-black leading-tight tracking-tight text-foreground sm:text-2xl">{value}</div>
                    </div>
                    <div className="rounded-2xl bg-background/70 p-2">
                        <Icon className="h-4 w-4" />
                    </div>
                </div>
                {currencyTotals ? <BreakdownChipRow currencyTotals={currencyTotals} iqdPreference={iqdPreference} /> : null}
                {typeof progress === 'number' ? <Progress value={clampPercentage(progress)} className="mt-4 h-2 bg-background/60" /> : null}
                <p className="mt-3 text-[11px] font-medium text-muted-foreground">{subtitle}</p>
            </CardContent>
        </Card>
    )
}

function MonthSummaryPanel({
    snapshot,
    accent,
    baseCurrency,
    iqdPreference,
    isCurrent,
}: {
    snapshot: MonthSnapshot
    accent: typeof LEFT_ACCENT
    baseCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
    isCurrent: boolean
}) {
    const { t } = useTranslation()
    const { sales, budget } = snapshot
    const budgetPct = budget.budgetLimit > 0 ? (budget.totalAllocated / budget.budgetLimit) * 100 : undefined
    const paidPct = budget.totalAllocated > 0 ? (budget.paid / budget.totalAllocated) * 100 : 0
    const summaryLine = t('monthlyComparison.meta.panelSummary', {
        count: sales.baseTotals.transactions,
        expenses: t(snapshot.option.hasExpenses ? 'monthlyComparison.meta.expensesTracked' : 'monthlyComparison.meta.noExpensesLogged'),
        budget: t(snapshot.option.hasAllocation ? 'monthlyComparison.meta.budgetSet' : 'monthlyComparison.meta.budgetNotSet'),
    })

    return (
        <Card className="overflow-hidden rounded-[1.7rem] border border-border/50 shadow-sm sm:rounded-[2rem]">
            <div className="h-1" style={{ backgroundColor: accent.line }} />
            <CardHeader className="pb-3 sm:pb-4">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.2em]', accent.badge)}>
                            {isCurrent ? t('monthlyComparison.status.current') : t('monthlyComparison.status.historical')}
                        </span>
                        <CardTitle className="mt-3 text-xl font-black tracking-tight sm:text-2xl">{snapshot.option.label}</CardTitle>
                        <p className="mt-1 text-xs font-medium leading-5 text-muted-foreground sm:text-sm">{summaryLine}</p>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-5 sm:space-y-6">
                <div>
                    <div className="mb-3 flex items-center gap-2">
                        <BarChart3 className={cn('h-4 w-4', accent.text)} />
                        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('monthlyComparison.kpis.revenueKpis')}</p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <KpiCard title={t('monthlyComparison.kpis.grossRevenue')} value={formatCurrency(sales.baseTotals.revenue, baseCurrency, iqdPreference)} icon={DollarSign} tone="blue" subtitle={t('monthlyComparison.kpis.transactions', { count: sales.baseTotals.transactions })} currencyTotals={sales.currencyTotals} iqdPreference={iqdPreference} />
                        <KpiCard title={t('monthlyComparison.kpis.totalCost')} value={formatCurrency(sales.baseTotals.cost, baseCurrency, iqdPreference)} icon={Package} tone="orange" subtitle={t('monthlyComparison.kpis.costRatio', { value: sales.baseTotals.revenue > 0 ? ((sales.baseTotals.cost / sales.baseTotals.revenue) * 100).toFixed(1) : '0.0' })} iqdPreference={iqdPreference} />
                        <KpiCard title={t('monthlyComparison.kpis.netProfit')} value={formatCurrency(sales.baseTotals.profit, baseCurrency, iqdPreference)} icon={TrendingUp} tone="emerald" subtitle={t('monthlyComparison.kpis.ofRevenue', { value: sales.baseTotals.revenue > 0 ? ((sales.baseTotals.profit / sales.baseTotals.revenue) * 100).toFixed(1) : '0.0' })} iqdPreference={iqdPreference} />
                        <KpiCard title={t('monthlyComparison.kpis.profitMargin')} value={`${sales.baseTotals.margin.toFixed(1)}%`} icon={Percent} tone="violet" subtitle={getMarginBand(sales.baseTotals.margin, t)} progress={sales.baseTotals.margin} iqdPreference={iqdPreference} />
                    </div>
                </div>

                <div>
                    <div className="mb-3 flex items-center gap-2">
                        <Wallet className={cn('h-4 w-4', accent.text)} />
                        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('monthlyComparison.kpis.monthHealth')}</p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        <KpiCard title={t('monthlyComparison.kpis.totalAllocated')} value={formatCurrency(budget.totalAllocated, baseCurrency, iqdPreference)} icon={BarChart3} tone={budget.budgetLimit > 0 && budgetPct && budgetPct > 100 ? 'red' : 'blue'} subtitle={budget.budgetLimit > 0 ? t('monthlyComparison.kpis.budgetLimit', { amount: formatCurrency(budget.budgetLimit, baseCurrency, iqdPreference) }) : t('monthlyComparison.meta.budgetNotSet')} progress={budgetPct} iqdPreference={iqdPreference} />
                        <KpiCard title={t('monthlyComparison.kpis.totalPaid')} value={formatCurrency(budget.paid, baseCurrency, iqdPreference)} icon={TrendingUp} tone="emerald" subtitle={t('monthlyComparison.kpis.allocatedSpend', { value: paidPct.toFixed(1) })} progress={paidPct} iqdPreference={iqdPreference} />
                        <KpiCard title={t('monthlyComparison.kpis.outstanding')} value={formatCurrency(budget.outstanding, baseCurrency, iqdPreference)} icon={Clock} tone="amber" subtitle={t('monthlyComparison.kpis.dueByMonthEnd')} iqdPreference={iqdPreference} />
                        <KpiCard title={t('monthlyComparison.kpis.dividends')} value={formatCurrency(budget.dividends, baseCurrency, iqdPreference)} icon={Wallet} tone="sky" subtitle={t('monthlyComparison.kpis.configuredDistributionTotal')} iqdPreference={iqdPreference} />
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}

function ComparisonInsightsStrip({ insights }: { insights: string[] }) {
    const { t } = useTranslation()
    return (
        <Card className="rounded-[2rem] border border-border/50 bg-card/70 shadow-sm">
            <CardContent className="p-5">
                <div className="mb-4 flex items-center gap-2">
                    <div className="rounded-2xl bg-primary/10 p-2 text-primary">
                        <Sparkles className="h-4 w-4" />
                    </div>
                    <div>
                        <p className="text-[11px] font-black uppercase tracking-[0.2em] text-muted-foreground">{t('monthlyComparison.summary.title')}</p>
                        <p className="text-sm font-medium text-muted-foreground">{t('monthlyComparison.summary.subtitle')}</p>
                    </div>
                </div>
                <div className="grid gap-3 lg:grid-cols-3">
                    {insights.map((insight, index) => (
                        <div key={index} className="rounded-[1.4rem] border border-border/50 bg-background/70 p-4 text-sm font-medium leading-6 text-foreground relative overflow-hidden">
                            <div className="absolute top-0 left-0 w-1 h-full bg-primary/30 rounded-full" />
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] font-black mr-2">{index + 1}</span>
                            {insight}
                        </div>
                    ))}
                </div>
            </CardContent>
        </Card>
    )
}

function MonthPaceComparisonChart({
    left,
    right,
    metric,
    onMetricChange,
    baseCurrency,
    iqdPreference,
}: {
    left: MonthSnapshot
    right: MonthSnapshot
    metric: ComparisonMetric
    onMetricChange: (metric: ComparisonMetric) => void
    baseCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
}) {
    const { t } = useTranslation()
    const data = useMemo(() => buildPaceData(left, right, metric), [left, right, metric])
    const hasProjection = useMemo(
        () => data.some(point => point.leftProjected != null || point.rightProjected != null),
        [data]
    )
    const label = t(`monthlyComparison.${metric}Pace`)

    return (
        <Card className="rounded-[1.7rem] border border-border/50 shadow-sm sm:rounded-[2rem] xl:col-span-2">
            <CardHeader className="pb-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <CardTitle className="text-lg font-black tracking-tight sm:text-xl">{label}</CardTitle>
                        <p className="mt-1 text-xs text-muted-foreground sm:text-sm">{t('monthlyComparison.paceSubtitle')}</p>
                        {hasProjection ? (
                            <p className="mt-1 text-[11px] font-semibold text-muted-foreground">
                                {t('monthlyComparison.projectionNote')}
                            </p>
                        ) : null}
                    </div>
                    <Tabs value={metric} onValueChange={value => onMetricChange(value as ComparisonMetric)}>
                        <TabsList className="grid h-9 w-full grid-cols-3 rounded-2xl bg-secondary/50 p-1 sm:h-10 lg:w-[360px]">
                            <TabsTrigger value="revenue" className="rounded-xl px-2 text-[11px] font-bold tracking-normal sm:text-xs sm:font-black sm:uppercase sm:tracking-wide">{t('monthlyComparison.revenue')}</TabsTrigger>
                            <TabsTrigger value="profit" className="rounded-xl px-2 text-[11px] font-bold tracking-normal sm:text-xs sm:font-black sm:uppercase sm:tracking-wide">{t('monthlyComparison.profit')}</TabsTrigger>
                            <TabsTrigger value="spend" className="rounded-xl px-2 text-[11px] font-bold tracking-normal sm:text-xs sm:font-black sm:uppercase sm:tracking-wide">{t('monthlyComparison.spend')}</TabsTrigger>
                        </TabsList>
                    </Tabs>
                </div>
            </CardHeader>
            <CardContent className="h-[280px] sm:h-[340px]">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                        <defs>
                            <linearGradient id="paceLeft" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={LEFT_ACCENT.line} stopOpacity={0.28} />
                                <stop offset="95%" stopColor={LEFT_ACCENT.line} stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="paceRight" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={RIGHT_ACCENT.line} stopOpacity={0.28} />
                                <stop offset="95%" stopColor={RIGHT_ACCENT.line} stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.35} vertical={false} />
                        <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }} className="text-muted-foreground/70" />
                        <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }} className="text-muted-foreground/70" tickFormatter={value => value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value} />
                        <RechartsTooltip
                            content={tooltipProps => (
                                <PaceTooltipContent
                                    {...tooltipProps}
                                    baseCurrency={baseCurrency}
                                    iqdPreference={iqdPreference}
                                    leftLabel={left.option.label}
                                    rightLabel={right.option.label}
                                />
                            )}
                        />
                        <Legend wrapperStyle={{ paddingTop: '16px' }} formatter={value => value === 'left' ? left.option.label : right.option.label} />
                        <Area type="monotone" dataKey="leftActual" name="left" stroke={LEFT_ACCENT.line} strokeWidth={3} fill="url(#paceLeft)" connectNulls={false} />
                        <Area type="monotone" dataKey="rightActual" name="right" stroke={RIGHT_ACCENT.line} strokeWidth={3} fill="url(#paceRight)" connectNulls={false} />
                        <Line type="monotone" dataKey="leftProjected" stroke={LEFT_ACCENT.line} strokeWidth={3} strokeDasharray="6 6" dot={false} activeDot={false} legendType="none" connectNulls={false} />
                        <Line type="monotone" dataKey="rightProjected" stroke={RIGHT_ACCENT.line} strokeWidth={3} strokeDasharray="6 6" dot={false} activeDot={false} legendType="none" connectNulls={false} />
                    </AreaChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    )
}

function CategoryComparisonChart({
    title,
    summary,
    data,
    baseCurrency,
    iqdPreference,
    leftLabel,
    rightLabel,
}: {
    title: string
    summary: string
    data: Array<{ name: string; left: number; right: number }>
    baseCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
    leftLabel: string
    rightLabel: string
}) {
    const { t } = useTranslation()
    return (
        <Card className="rounded-[1.7rem] border border-border/50 shadow-sm sm:rounded-[2rem]">
            <CardHeader className="pb-4">
                <CardTitle className="text-base font-black tracking-tight sm:text-lg">{title}</CardTitle>
                <p className="text-xs text-muted-foreground sm:text-sm">{summary}</p>
            </CardHeader>
            <CardContent className="h-[280px] sm:h-[320px]">
                {data.length === 0 ? (
                    <div className="flex h-full items-center justify-center rounded-[1.4rem] border border-dashed border-border/60 text-sm font-medium text-muted-foreground">
                        {t('monthlyComparison.empty.noDataAvailable')}
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data} layout="vertical" margin={{ top: 5, right: 10, left: 40, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} horizontal={false} />
                            <XAxis type="number" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }} className="text-muted-foreground/70" tickFormatter={value => value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value} />
                            <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} width={110} tick={{ fontSize: 11, fontWeight: 700, fill: 'currentColor' }} className="text-muted-foreground/80" />
                            <RechartsTooltip
                                contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '18px', border: '1px solid hsl(var(--border))', padding: '12px' }}
                                formatter={(value, name) => [
                                    formatCurrency(Number(value ?? 0), baseCurrency, iqdPreference),
                                    name === 'left' ? leftLabel : rightLabel,
                                ]}
                            />
                            <Legend formatter={value => value === 'left' ? leftLabel : rightLabel} />
                            <Bar dataKey="left" fill={LEFT_ACCENT.line} radius={[0, 8, 8, 0]} />
                            <Bar dataKey="right" fill={RIGHT_ACCENT.line} radius={[0, 8, 8, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                )}
            </CardContent>
        </Card>
    )
}

function TopProductsComparisonCard({
    rows,
    baseCurrency,
    iqdPreference,
    leftLabel,
    rightLabel,
}: {
    rows: ReturnType<typeof buildTopProductRows>
    baseCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
    leftLabel: string
    rightLabel: string
}) {
    const { t } = useTranslation()
    const hasRows = rows.length > 0

    return (
        <Card className="rounded-[1.7rem] border border-border/50 shadow-sm sm:rounded-[2rem]">
            <CardHeader className="pb-4">
                <CardTitle className="text-base font-black tracking-tight sm:text-lg">{t('monthlyComparison.topProducts.title')}</CardTitle>
                <p className="text-xs text-muted-foreground sm:text-sm">{t('monthlyComparison.topProducts.subtitle')}</p>
            </CardHeader>
            <CardContent className="space-y-3">
                {!hasRows ? (
                    <div className="rounded-[1.4rem] border border-dashed border-border/60 bg-background/70 p-6 text-center text-sm font-medium text-muted-foreground">
                        {t('monthlyComparison.empty.noProductRevenue')}
                    </div>
                ) : null}

                {hasRows ? (
                    <div className="space-y-3 md:hidden">
                        {rows.map(row => (
                            <div key={row.id} className="rounded-[1.3rem] border border-border/50 bg-background/70 p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-[11px] font-black">
                                                {row.rank}
                                            </span>
                                            <p className="truncate text-sm font-semibold">{row.name}</p>
                                        </div>
                                        {row.state ? (
                                            <span className={cn(
                                                'mt-2 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide',
                                                row.state === 'new' ? RIGHT_ACCENT.badge : LEFT_ACCENT.badge
                                            )}>
                                                {row.state === 'new' ? t('monthlyComparison.status.new') : t('monthlyComparison.status.dropped')}
                                            </span>
                                        ) : null}
                                    </div>
                                    <span className={cn(
                                        'shrink-0 text-sm font-black',
                                        row.delta >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                                    )}>
                                        {row.delta >= 0 ? '+' : '-'}{formatCurrency(Math.abs(row.delta), baseCurrency, iqdPreference)}
                                    </span>
                                </div>

                                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                    <div className="rounded-xl border border-border/40 px-3 py-2">
                                        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">{leftLabel}</p>
                                        <p className="mt-1 text-sm font-semibold">{formatCurrency(row.leftRevenue, baseCurrency, iqdPreference)}</p>
                                    </div>
                                    <div className="rounded-xl border border-border/40 px-3 py-2">
                                        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">{rightLabel}</p>
                                        <p className="mt-1 text-sm font-semibold">{formatCurrency(row.rightRevenue, baseCurrency, iqdPreference)}</p>
                                    </div>
                                </div>

                                <p className="mt-3 text-xs font-medium text-muted-foreground">
                                    {t('monthlyComparison.topProducts.shareInline', { left: row.leftShare.toFixed(0), right: row.rightShare.toFixed(0) })}
                                </p>
                            </div>
                        ))}
                    </div>
                ) : null}

                {hasRows ? (
                    <div className="hidden overflow-x-auto md:block">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-12">#</TableHead>
                                    <TableHead>{t('monthlyComparison.topProducts.product')}</TableHead>
                                    <TableHead className="text-end">{leftLabel}</TableHead>
                                    <TableHead className="text-end">{rightLabel}</TableHead>
                                    <TableHead className="text-end">{t('monthlyComparison.topProducts.delta')}</TableHead>
                                    <TableHead className="text-end">{t('monthlyComparison.topProducts.share')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map(row => (
                                    <TableRow key={row.id}>
                                        <TableCell className="font-black">{row.rank}</TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-2">
                                                <span className="font-semibold">{row.name}</span>
                                                {row.state ? (
                                                    <span className={cn(
                                                        'rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide',
                                                        row.state === 'new' ? RIGHT_ACCENT.badge : LEFT_ACCENT.badge
                                                    )}>
                                                        {row.state === 'new' ? t('monthlyComparison.status.new') : t('monthlyComparison.status.dropped')}
                                                    </span>
                                                ) : null}
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-end font-medium">{formatCurrency(row.leftRevenue, baseCurrency, iqdPreference)}</TableCell>
                                        <TableCell className="text-end font-medium">{formatCurrency(row.rightRevenue, baseCurrency, iqdPreference)}</TableCell>
                                        <TableCell className={cn('text-end font-black', row.delta >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                                            {row.delta >= 0 ? '+' : '-'}{formatCurrency(Math.abs(row.delta), baseCurrency, iqdPreference)}
                                        </TableCell>
                                        <TableCell className="text-end text-xs text-muted-foreground">
                                            {row.leftShare.toFixed(0)}% / {row.rightShare.toFixed(0)}%
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                ) : null}
            </CardContent>
        </Card>
    )
}

function ReturnsComparisonCard({
    left,
    right,
    baseCurrency,
    iqdPreference,
}: {
    left: MonthSnapshot
    right: MonthSnapshot
    baseCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
}) {
    const { t } = useTranslation()
    const isEmpty = left.sales.returns.totalReturns === 0 && right.sales.returns.totalReturns === 0

    return (
        <Card className="rounded-[1.7rem] border border-red-500/10 bg-red-500/5 shadow-sm sm:rounded-[2rem]">
            <CardHeader className="pb-4">
                <CardTitle className="text-base font-black tracking-tight text-red-700 dark:text-red-300 sm:text-lg">{t('monthlyComparison.returns.title')}</CardTitle>
                <p className="text-xs text-red-900/60 dark:text-red-100/60 sm:text-sm">{t('monthlyComparison.returns.subtitle')}</p>
            </CardHeader>
            <CardContent className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-3">
                    <KpiCard title={t('monthlyComparison.kpis.totalReturns')} value={`${right.sales.returns.totalReturns}`} icon={RotateCcw} tone="red" subtitle={`${left.option.label}: ${left.sales.returns.totalReturns}`} iqdPreference={iqdPreference} />
                    <KpiCard title={t('monthlyComparison.kpis.refundedAmount')} value={formatCurrency(right.sales.returns.refundedAmount, baseCurrency, iqdPreference)} icon={TrendingDown} tone="orange" subtitle={`${left.option.label}: ${formatCurrency(left.sales.returns.refundedAmount, baseCurrency, iqdPreference)}`} iqdPreference={iqdPreference} />
                    <KpiCard title={t('monthlyComparison.kpis.returnRate')} value={`${right.sales.returns.returnRate.toFixed(1)}%`} icon={Percent} tone="amber" subtitle={`${left.option.label}: ${left.sales.returns.returnRate.toFixed(1)}%`} iqdPreference={iqdPreference} />
                </div>

                {isEmpty ? (
                    <div className="rounded-[1.4rem] border border-dashed border-red-500/20 bg-background/70 p-6 text-center text-sm font-medium text-muted-foreground">
                        {t('monthlyComparison.empty.noReturnsEitherMonth')}
                    </div>
                ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                        {[left, right].map((snapshot, index) => (
                            <div key={snapshot.option.value} className="rounded-[1.4rem] border border-border/60 bg-background/70 p-4">
                                <div className="mb-3 flex items-center justify-between">
                                    <p className={cn('text-xs font-black uppercase tracking-[0.18em]', index === 0 ? LEFT_ACCENT.text : RIGHT_ACCENT.text)}>
                                        {snapshot.option.label}
                                    </p>
                                    <span className="text-xs font-medium text-muted-foreground">{t('monthlyComparison.returns.count', { count: snapshot.sales.returns.totalReturns })}</span>
                                </div>
                                <div className="space-y-2">
                                    {snapshot.sales.returns.topProducts.length > 0 ? snapshot.sales.returns.topProducts.map((product, productIndex) => (
                                        <div key={`${snapshot.option.value}-${product.name}`} className="flex items-center justify-between rounded-xl border border-border/40 px-3 py-2">
                                            <div>
                                                <p className="text-sm font-semibold">{productIndex + 1}. {product.name}</p>
                                                <p className="text-xs text-muted-foreground">{t('monthlyComparison.returns.returnedCount', { count: product.count })}</p>
                                            </div>
                                            <span className="text-sm font-black text-red-600 dark:text-red-400">
                                                {formatCurrency(product.amount, baseCurrency, iqdPreference)}
                                            </span>
                                        </div>
                                    )) : (
                                        <div className="rounded-xl border border-dashed border-border/50 px-3 py-4 text-center text-sm text-muted-foreground">
                                            {t('monthlyComparison.empty.noReturnedProducts')}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    )
}

function PeakActivityComparisonCard({
    left,
    right,
    peakView,
    onPeakViewChange,
}: {
    left: MonthSnapshot
    right: MonthSnapshot
    peakView: PeakView
    onPeakViewChange: (view: PeakView) => void
}) {
    const { t } = useTranslation()
    const peakData = useMemo(() => {
        return left.sales.hourly.map((point, index) => ({
            hour: point.label,
            left: point.count,
            right: right.sales.hourly[index]?.count || 0,
        }))
    }, [left.sales.hourly, right.sales.hourly])

    return (
        <Card className="rounded-[1.7rem] border border-border/50 shadow-sm sm:rounded-[2rem]">
            <CardHeader className="pb-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <CardTitle className="text-base font-black tracking-tight sm:text-lg">{t('monthlyComparison.peakActivity.title')}</CardTitle>
                        <p className="text-xs text-muted-foreground sm:text-sm">{t('monthlyComparison.peakActivity.subtitle')}</p>
                    </div>
                    <Tabs value={peakView} onValueChange={value => onPeakViewChange(value as PeakView)}>
                        <TabsList className="grid h-9 w-full max-w-[220px] grid-cols-2 rounded-2xl bg-secondary/50 p-1 sm:h-10">
                            <TabsTrigger value="hourly" className="rounded-xl px-2 text-[11px] font-bold tracking-normal sm:text-xs sm:font-black sm:uppercase sm:tracking-wide">{t('monthlyComparison.peakActivity.hourly')}</TabsTrigger>
                            <TabsTrigger value="heatmap" className="rounded-xl px-2 text-[11px] font-bold tracking-normal sm:text-xs sm:font-black sm:uppercase sm:tracking-wide">{t('monthlyComparison.peakActivity.heatmap')}</TabsTrigger>
                        </TabsList>
                    </Tabs>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[1.4rem] border border-border/60 bg-background/70 p-4">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{left.option.label}</span>
                            <span className={cn('rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-wide', LEFT_ACCENT.badge)}>{t('monthlyComparison.peakActivity.peakAt', { time: left.sales.peakHourLabel })}</span>
                        </div>
                    </div>
                    <div className="rounded-[1.4rem] border border-border/60 bg-background/70 p-4">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{right.option.label}</span>
                            <span className={cn('rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-wide', RIGHT_ACCENT.badge)}>{t('monthlyComparison.peakActivity.peakAt', { time: right.sales.peakHourLabel })}</span>
                        </div>
                    </div>
                </div>

                <Tabs value={peakView} onValueChange={value => onPeakViewChange(value as PeakView)}>
                    <TabsContent value="hourly" className="mt-0">
                        <div className="h-[240px] sm:h-[280px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={peakData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} vertical={false} />
                                    <XAxis dataKey="hour" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: 'currentColor' }} className="text-muted-foreground/70" interval="preserveStartEnd" minTickGap={10} />
                                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }} className="text-muted-foreground/70" allowDecimals={false} />
                                    <RechartsTooltip
                                        contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '18px', border: '1px solid hsl(var(--border))', padding: '12px' }}
                                        formatter={(value, name) => [value, name === 'left' ? left.option.label : right.option.label]}
                                    />
                                    <Legend formatter={value => value === 'left' ? left.option.label : right.option.label} />
                                    <Bar dataKey="left" fill={LEFT_ACCENT.line} radius={[6, 6, 0, 0]} />
                                    <Bar dataKey="right" fill={RIGHT_ACCENT.line} radius={[6, 6, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </TabsContent>
                    <TabsContent value="heatmap" className="mt-0">
                        <div className="grid gap-4 lg:grid-cols-2">
                            <div className="rounded-[1.4rem] border border-border/60 bg-background/70 p-4">
                                <p className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">{left.option.label}</p>
                                <MiniHeatmap sales={left.sales.sales} />
                            </div>
                            <div className="rounded-[1.4rem] border border-border/60 bg-background/70 p-4">
                                <p className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">{right.option.label}</p>
                                <MiniHeatmap sales={right.sales.sales} />
                            </div>
                        </div>
                    </TabsContent>
                </Tabs>
            </CardContent>
        </Card>
    )
}

function ProfitBridgeComparisonCard({
    left,
    right,
    baseCurrency,
    iqdPreference,
}: {
    left: MonthSnapshot
    right: MonthSnapshot
    baseCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
}) {
    const { t } = useTranslation()
    const columns = [
        {
            label: left.option.label,
            accent: LEFT_ACCENT,
            steps: [
                { label: t('monthlyComparison.profitBridge.profitFromRevenue'), value: left.sales.baseTotals.profit, tone: 'emerald' as const },
                { label: t('monthlyComparison.profitBridge.operationalExpenses'), value: -left.budget.operationalTotal, tone: 'orange' as const },
                { label: t('monthlyComparison.profitBridge.personnel'), value: -left.budget.personnelTotal, tone: 'orange' as const },
                { label: t('monthlyComparison.profitBridge.dividends'), value: left.budget.dividends, tone: 'blue' as const },
            ],
            note: left.sales.baseTotals.profit > left.budget.totalAllocated ? t('monthlyComparison.profitBridge.noteCovered') : t('monthlyComparison.profitBridge.noteExceeded'),
        },
        {
            label: right.option.label,
            accent: RIGHT_ACCENT,
            steps: [
                { label: t('monthlyComparison.profitBridge.profitFromRevenue'), value: right.sales.baseTotals.profit, tone: 'emerald' as const },
                { label: t('monthlyComparison.profitBridge.operationalExpenses'), value: -right.budget.operationalTotal, tone: 'orange' as const },
                { label: t('monthlyComparison.profitBridge.personnel'), value: -right.budget.personnelTotal, tone: 'orange' as const },
                { label: t('monthlyComparison.profitBridge.dividends'), value: right.budget.dividends, tone: 'blue' as const },
            ],
            note: right.sales.baseTotals.profit > right.budget.totalAllocated ? t('monthlyComparison.profitBridge.noteCovered') : t('monthlyComparison.profitBridge.noteExceeded'),
        },
    ]

    const isTie = right.sales.baseTotals.profit === left.sales.baseTotals.profit
    const winnerIsRight = right.sales.baseTotals.profit > left.sales.baseTotals.profit

    return (
        <Card className="rounded-[1.7rem] border border-border/50 shadow-sm sm:rounded-[2rem]">
            <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-2xl bg-primary/10 text-primary">
                        <TrendingUp className="w-5 h-5" />
                    </div>
                    <div>
                        <CardTitle className="text-lg font-black tracking-tight sm:text-xl">{t('monthlyComparison.profitBridge.title')}</CardTitle>
                        <p className="text-xs text-muted-foreground sm:text-sm">{t('monthlyComparison.profitBridge.subtitle')}</p>
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <div className="grid gap-4 lg:grid-cols-2">
                    {columns.map((column, colIdx) => {
                        const isWinner = !isTie && (colIdx === 0 ? !winnerIsRight : winnerIsRight)

                        return (
                            <div key={column.label} className={cn(
                                'rounded-[1.6rem] border border-border/50 bg-background/70 p-5 transition-all',
                                isWinner && 'ring-2 ring-emerald-500/20 shadow-emerald-500/5 shadow-lg'
                            )}>
                                <div className="mb-4 flex items-center justify-between">
                                    <span className={cn('rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.2em]', column.accent.badge)}>{column.label}</span>
                                    {isWinner && (
                                        <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.2em] text-emerald-600 dark:text-emerald-400">{t('monthlyComparison.status.winner')}</span>
                                    )}
                                </div>
                                <div className="space-y-2">
                                    {column.steps.map((step, stepIdx) => (
                                        <div key={`${column.label}-${step.label}`}>
                                            <div
                                                className={cn(
                                                    'rounded-[1.2rem] border px-4 py-3',
                                                    step.tone === 'emerald' ? 'border-emerald-500/15 bg-emerald-500/5'
                                                        : step.tone === 'blue' ? 'border-blue-500/15 bg-blue-500/5'
                                                            : 'border-orange-500/15 bg-orange-500/5'
                                                )}
                                            >
                                                <div className="flex items-center justify-between gap-3">
                                                    <span className="text-sm font-semibold">{step.label}</span>
                                                    <span className={cn(
                                                        'text-sm font-black',
                                                        step.tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400'
                                                            : step.tone === 'blue' ? 'text-blue-600 dark:text-blue-400'
                                                                : 'text-orange-600 dark:text-orange-400'
                                                    )}>
                                                        {step.value >= 0 ? '' : '-'}{formatCurrency(Math.abs(step.value), baseCurrency, iqdPreference)}
                                                    </span>
                                                </div>
                                            </div>
                                            {stepIdx < column.steps.length - 1 && (
                                                <div className="flex justify-center py-0.5">
                                                    <ArrowDownRight className="w-3 h-3 text-muted-foreground/40" />
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                                <p className="mt-4 text-sm font-medium text-muted-foreground">{column.note}</p>
                            </div>
                        )
                    })}
                </div>
            </CardContent>
        </Card>
    )
}

export function MonthlyComparison() {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const { activeWorkspace, features } = useWorkspace()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()

    const workspaceId = activeWorkspace?.id || user?.workspaceId
    const baseCurrency = (features.default_currency || 'usd') as string
    const iqdPreference = (features.iqd_display_preference || 'IQD') as 'IQD' | 'د.ع'

    const rawSales = useSales(workspaceId)
    const budgetAllocations = useBudgetAllocations(workspaceId)
    const expenseSeries = useExpenseSeries(workspaceId)
    const employees = useEmployees(workspaceId)
    const payrollStatuses = usePayrollStatuses(workspaceId)
    const dividendStatuses = useDividendStatuses(workspaceId)
    const expenseItems = useLiveQuery(
        () => workspaceId
            ? db.expense_items.where('workspaceId').equals(workspaceId).and(item => !item.isDeleted).toArray()
            : [],
        [workspaceId]
    ) ?? []

    const sales = useMemo<Sale[]>(() => rawSales.map(toUISale), [rawSales])

    const rates = useMemo(
        () => buildConversionRates(exchangeData, eurRates, tryRates),
        [exchangeData, eurRates, tryRates]
    )
    const convertToBase = useMemo(() => {
        return (amount: number | undefined | null, from: string | undefined | null) => convertToStoreBaseUtil(amount, from, baseCurrency, rates)
    }, [baseCurrency, rates])

    const monthOptions = useMemo(
        () => buildAvailableMonths(sales, budgetAllocations, expenseItems, i18n.language),
        [sales, budgetAllocations, expenseItems, i18n.language]
    )
    const localizedFallbackLabels = useMemo<MonthlyComparisonFallbackLabels>(() => ({
        uncategorized: t('monthlyComparison.fallback.uncategorized'),
        unknownProduct: t('monthlyComparison.fallback.unknownProduct'),
        payroll: t('monthlyComparison.fallback.payroll'),
    }), [t, i18n.language])
    const allocationByMonth = useMemo(
        () => new Map(budgetAllocations.map(allocation => [allocation.month, allocation] as const)),
        [budgetAllocations]
    )

    const defaultSelection = useMemo(() => ({
        right: monthOptions[0]?.value || '' as MonthKey,
        left: monthOptions[1]?.value || monthOptions[0]?.value || '' as MonthKey,
    }), [monthOptions])

    const [leftMonth, setLeftMonth] = useState<MonthKey>('' as MonthKey)
    const [rightMonth, setRightMonth] = useState<MonthKey>('' as MonthKey)
    const [paceMetric, setPaceMetric] = useState<ComparisonMetric>('profit')
    const [peakView, setPeakView] = useState<PeakView>('hourly')
    const [isToolbarCondensed, setIsToolbarCondensed] = useState(false)
    const pageRef = useRef<HTMLDivElement | null>(null)
    const pageTopBaselineRef = useRef<number | null>(null)

    useEffect(() => {
        if (!monthOptions.length) return

        const validMonths = new Set(monthOptions.map(option => option.value))
        const nextRight = validMonths.has(rightMonth) ? rightMonth : defaultSelection.right
        const nextLeftCandidate = validMonths.has(leftMonth) ? leftMonth : defaultSelection.left
        const nextLeft = nextLeftCandidate === nextRight
            ? monthOptions.find(option => option.value !== nextRight)?.value || nextLeftCandidate
            : nextLeftCandidate

        if (nextLeft && nextLeft !== leftMonth) setLeftMonth(nextLeft)
        if (nextRight && nextRight !== rightMonth) setRightMonth(nextRight)
    }, [monthOptions, defaultSelection, leftMonth, rightMonth])

    useEffect(() => {
        if (!workspaceId) return
        if (leftMonth) {
            void ensureExpenseItemsForMonth(workspaceId, leftMonth)
        }
        if (rightMonth && rightMonth !== leftMonth) {
            void ensureExpenseItemsForMonth(workspaceId, rightMonth)
        }
    }, [workspaceId, leftMonth, rightMonth])

    useEffect(() => {
        if (typeof window === 'undefined') return

        const getMainNode = () => {
            const pageNode = pageRef.current
            if (pageNode?.closest('main')) return pageNode.closest('main') as HTMLElement
            const fallbackMain = document.querySelector('main')
            return fallbackMain instanceof HTMLElement ? fallbackMain : null
        }

        const syncToolbarState = () => {
            const mainNode = getMainNode()
            const documentScrollTop = Math.max(
                window.scrollY,
                document.documentElement?.scrollTop || 0,
                document.body?.scrollTop || 0,
            )
            const mainScrollTop = mainNode?.scrollTop || 0
            const pageTop = pageRef.current?.getBoundingClientRect().top ?? 0
            if (pageTopBaselineRef.current == null || Math.max(documentScrollTop, mainScrollTop) <= 1) {
                pageTopBaselineRef.current = pageTop
            }

            const isDesktopViewport = window.innerWidth >= 768
            const movedFromBaseline = pageTopBaselineRef.current != null && pageTop < (pageTopBaselineRef.current - 4)
            const next = isDesktopViewport && (Math.max(documentScrollTop, mainScrollTop) > 4 || movedFromBaseline)
            setIsToolbarCondensed(prev => prev === next ? prev : next)
        }

        const mainNode = getMainNode()
        syncToolbarState()

        mainNode?.addEventListener('scroll', syncToolbarState, { passive: true })
        window.addEventListener('scroll', syncToolbarState, { passive: true })
        window.addEventListener('resize', syncToolbarState, { passive: true })

        const pollId = window.setInterval(syncToolbarState, 120)

        return () => {
            window.clearInterval(pollId)
            mainNode?.removeEventListener('scroll', syncToolbarState)
            window.removeEventListener('scroll', syncToolbarState)
            window.removeEventListener('resize', syncToolbarState)
        }
    }, [])

    const leftSnapshot = useMemo(() => {
        const option = monthOptions.find(item => item.value === leftMonth)
        if (!option) return null
        const salesSnapshot = analyzeSalesMonth(sales, option.value, baseCurrency, convertToBase, localizedFallbackLabels)
        return {
            option,
            sales: salesSnapshot,
            budget: analyzeBudgetMonth(option.value, {
                expenseItems,
                expenseSeries,
                employees,
                payrollStatuses,
                dividendStatuses,
                sales,
                baseCurrency,
                rates,
                allocation: allocationByMonth.get(option.value) || null,
                labels: localizedFallbackLabels
            }),
        } satisfies MonthSnapshot
    }, [monthOptions, leftMonth, sales, baseCurrency, convertToBase, localizedFallbackLabels, expenseItems, expenseSeries, employees, payrollStatuses, dividendStatuses, rates, allocationByMonth])

    const rightSnapshot = useMemo(() => {
        const option = monthOptions.find(item => item.value === rightMonth)
        if (!option) return null
        const salesSnapshot = analyzeSalesMonth(sales, option.value, baseCurrency, convertToBase, localizedFallbackLabels)
        return {
            option,
            sales: salesSnapshot,
            budget: analyzeBudgetMonth(option.value, {
                expenseItems,
                expenseSeries,
                employees,
                payrollStatuses,
                dividendStatuses,
                sales,
                baseCurrency,
                rates,
                allocation: allocationByMonth.get(option.value) || null,
                labels: localizedFallbackLabels
            }),
        } satisfies MonthSnapshot
    }, [monthOptions, rightMonth, sales, baseCurrency, convertToBase, localizedFallbackLabels, expenseItems, expenseSeries, employees, payrollStatuses, dividendStatuses, rates, allocationByMonth])

    const currentMonthKey = monthKeyFromDate(new Date())
    const yearAgoMonth = useMemo(() => {
        if (!monthOptions[0]) return null
        const baseDate = monthDateFromKey(monthOptions[0].value)
        const candidate = monthKeyFromDate(new Date(baseDate.getFullYear() - 1, baseDate.getMonth(), 1))
        return monthOptions.some(option => option.value === candidate) ? candidate : null
    }, [monthOptions])
    const previousVsCurrentLabel = t(isToolbarCondensed ? 'monthlyComparison.previousVsCurrentShort' : 'monthlyComparison.previousVsCurrent')
    const sameMonthLastYearLabel = t(isToolbarCondensed ? 'monthlyComparison.sameMonthLastYearShort' : 'monthlyComparison.sameMonthLastYear')

    const revenueCategoryData = useMemo(
        () => leftSnapshot && rightSnapshot ? buildCategoryComparison(leftSnapshot.sales.categories, rightSnapshot.sales.categories, 6) : [],
        [leftSnapshot, rightSnapshot]
    )
    const expenseCategoryData = useMemo(
        () => leftSnapshot && rightSnapshot ? buildCategoryComparison(leftSnapshot.budget.expenseCategories, rightSnapshot.budget.expenseCategories, 6) : [],
        [leftSnapshot, rightSnapshot]
    )
    const topProductRows = useMemo(
        () => leftSnapshot && rightSnapshot ? buildTopProductRows(leftSnapshot, rightSnapshot) : [],
        [leftSnapshot, rightSnapshot]
    )
    const insights = useMemo(
        () => leftSnapshot && rightSnapshot ? buildInsights(leftSnapshot, rightSnapshot, t) : [],
        [leftSnapshot, rightSnapshot, t, i18n.language]
    )

    const deltaCards = useMemo<DeltaCardConfig[]>(() => {
        if (!leftSnapshot || !rightSnapshot) return []
        return [
            { key: 'revenue', label: t('monthlyComparison.revenue'), leftValue: leftSnapshot.sales.baseTotals.revenue, rightValue: rightSnapshot.sales.baseTotals.revenue, format: 'currency', icon: DollarSign, tone: 'blue' },
            { key: 'profit', label: t('monthlyComparison.delta.netProfit'), leftValue: leftSnapshot.sales.baseTotals.profit, rightValue: rightSnapshot.sales.baseTotals.profit, format: 'currency', icon: TrendingUp, tone: 'emerald' },
            { key: 'margin', label: t('monthlyComparison.delta.profitMargin'), leftValue: leftSnapshot.sales.baseTotals.margin, rightValue: rightSnapshot.sales.baseTotals.margin, format: 'percent', icon: Percent, tone: 'violet' },
            { key: 'spend', label: t('monthlyComparison.delta.operationalSpend'), leftValue: leftSnapshot.budget.totalAllocated, rightValue: rightSnapshot.budget.totalAllocated, format: 'currency', icon: BarChart3, tone: 'orange' },
            { key: 'dividends', label: t('monthlyComparison.kpis.dividends'), leftValue: leftSnapshot.budget.dividends, rightValue: rightSnapshot.budget.dividends, format: 'currency', icon: Wallet, tone: 'sky' },
        ]
    }, [leftSnapshot, rightSnapshot, t, i18n.language])

    if (monthOptions.length < 2 || !leftSnapshot || !rightSnapshot) {
        return (
            <div className="space-y-8">
                <div className="flex items-center gap-3">
                    <div className="p-3 rounded-2xl bg-primary/10 text-primary shadow-inner">
                        <BarChart3 className="w-6 h-6" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black tracking-tight">{t('monthlyComparison.title')}</h1>
                        <p className="text-sm font-medium text-muted-foreground/80">
                            {t('monthlyComparison.subtitle')}
                        </p>
                    </div>
                </div>
                <Card className="rounded-[2rem] border border-dashed border-border/60 shadow-sm">
                    <CardContent className="flex min-h-[280px] flex-col items-center justify-center gap-4 p-8 text-center">
                        <div className="rounded-full bg-secondary/60 p-4">
                            <CalendarDays className="h-8 w-8 text-muted-foreground" />
                        </div>
                        <div>
                            <h2 className="text-xl font-black tracking-tight">{t('monthlyComparison.empty.notEnoughHistoryTitle')}</h2>
                            <p className="mt-2 max-w-md text-sm text-muted-foreground">
                                {t('monthlyComparison.empty.notEnoughHistoryDescription')}
                            </p>
                        </div>
                    </CardContent>
                </Card>
            </div>
        )
    }


    return (
        <div ref={pageRef} className="space-y-6 pb-10 sm:space-y-8">
            <div className="space-y-2">
                <div className="flex items-center gap-3">
                    <div className="rounded-2xl bg-primary/10 p-2.5 text-primary shadow-inner sm:p-3">
                        <BarChart3 className="h-5 w-5 sm:h-6 sm:w-6" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{t('monthlyComparison.title')}</h1>
                        <p className="text-xs font-medium text-muted-foreground/80 sm:text-sm">
                            {t('monthlyComparison.subtitle')}
                        </p>
                    </div>
                </div>
            </div>

            <div className={cn(
                'z-20 border border-border/60 bg-background/90 ring-1 ring-primary/5 transition-all duration-200 ease-out md:sticky',
                isToolbarCondensed ? 'rounded-[1.3rem] p-1.5 shadow-md backdrop-blur-2xl md:top-0' : 'rounded-[2rem] p-3 shadow-lg backdrop-blur-xl md:top-3',
            )}>
                <div className={cn(
                    'flex flex-col transition-all duration-200 ease-out xl:flex-row',
                    isToolbarCondensed ? 'gap-1.5 xl:items-center' : 'gap-3 xl:items-stretch',
                )}>
                    <MonthSelectorCard title={t('monthlyComparison.monthA')} accent={LEFT_ACCENT} value={leftMonth} options={monthOptions} otherValue={rightMonth} onChange={setLeftMonth} meta={buildToolbarMeta(leftSnapshot.option, t)} compact={isToolbarCondensed} />
                    <div className="flex items-center justify-center">
                        <Button type="button" variant="outline" size="icon" onClick={() => { setLeftMonth(rightMonth); setRightMonth(leftMonth) }} className={cn(
                            'border-border/50 transition-all duration-200 ease-out hover:rotate-180',
                            isToolbarCondensed ? 'h-9 w-9 rounded-[0.9rem]' : 'h-12 w-12 rounded-2xl',
                        )} title={t('monthlyComparison.swapMonths')}>
                            <Activity className="h-4 w-4" />
                        </Button>
                    </div>
                    <MonthSelectorCard title={t('monthlyComparison.monthB')} accent={RIGHT_ACCENT} value={rightMonth} options={monthOptions} otherValue={leftMonth} onChange={setRightMonth} meta={buildToolbarMeta(rightSnapshot.option, t)} compact={isToolbarCondensed} />
                    <div className={cn(
                        'flex overflow-x-auto pb-1 transition-all duration-200 ease-out [-ms-overflow-style:none] [scrollbar-width:none] md:grid md:overflow-visible md:pb-0 md:grid-cols-3 [&::-webkit-scrollbar]:hidden',
                        isToolbarCondensed ? 'gap-1.5 xl:w-[350px]' : 'gap-2.5 md:gap-3 xl:w-[420px]',
                    )}>
                        <Button type="button" variant="outline" title={t('monthlyComparison.previousVsCurrent')} onClick={() => { if (defaultSelection.left && defaultSelection.right) { setLeftMonth(defaultSelection.left); setRightMonth(defaultSelection.right) } }} className={cn(
                            'border-border/50 transition-all duration-200 ease-out hover:bg-primary/5',
                            isToolbarCondensed ? 'h-9 min-w-[122px] flex-none rounded-[0.9rem] px-2.5 text-[10px] font-bold normal-case tracking-normal text-center whitespace-nowrap md:min-w-0' : 'h-full min-h-12 min-w-[138px] flex-none rounded-[1.5rem] px-3 text-[11px] font-bold normal-case tracking-[0.01em] text-center whitespace-nowrap md:min-w-0',
                        )}>
                            {previousVsCurrentLabel}
                        </Button>
                        <Button type="button" variant="outline" title={t('monthlyComparison.sameMonthLastYear')} disabled={!yearAgoMonth || !monthOptions[0]} onClick={() => { if (yearAgoMonth && monthOptions[0]) { setLeftMonth(yearAgoMonth); setRightMonth(monthOptions[0].value) } }} className={cn(
                            'border-border/50 transition-all duration-200 ease-out hover:bg-primary/5',
                            isToolbarCondensed ? 'h-9 min-w-[122px] flex-none rounded-[0.9rem] px-2.5 text-[10px] font-bold normal-case tracking-normal text-center whitespace-nowrap md:min-w-0' : 'h-full min-h-12 min-w-[138px] flex-none rounded-[1.5rem] px-3 text-[11px] font-bold normal-case tracking-[0.01em] text-center whitespace-nowrap md:min-w-0',
                        )}>
                            {sameMonthLastYearLabel}
                        </Button>
                        <Button type="button" variant="ghost" disabled={leftMonth === defaultSelection.left && rightMonth === defaultSelection.right} onClick={() => { if (defaultSelection.left && defaultSelection.right) { setLeftMonth(defaultSelection.left); setRightMonth(defaultSelection.right) } }} className={cn(
                            'transition-all duration-200 ease-out',
                            isToolbarCondensed ? 'h-9 min-w-[96px] flex-none rounded-[0.9rem] px-2.5 text-[10px] font-bold normal-case tracking-normal text-center whitespace-nowrap md:min-w-0' : 'h-full min-h-12 min-w-[96px] flex-none rounded-[1.5rem] px-3 text-[11px] font-bold normal-case tracking-[0.01em] text-center whitespace-nowrap md:min-w-0',
                        )}>
                            {t('monthlyComparison.reset')}
                        </Button>
                    </div>
                </div>
            </div>

            <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] md:mx-0 md:grid md:gap-4 md:overflow-visible md:px-0 md:pb-0 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 [&::-webkit-scrollbar]:hidden">
                {deltaCards.map(({ key, ...card }) => (
                    <div key={key} className="min-w-[240px] snap-start md:min-w-0">
                        <ComparisonDeltaCard {...card} baseCurrency={baseCurrency} iqdPreference={iqdPreference} leftLabel={leftSnapshot.option.label} rightLabel={rightSnapshot.option.label} />
                    </div>
                ))}
            </div>

            {/* ── Month Summaries ── */}
            <div className="space-y-4">
                <div className="flex items-center gap-3 px-1">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground/60">{t('monthlyComparison.sections.monthSummaries')}</span>
                    <div className="h-px flex-1 bg-border/60" />
                </div>
                <div className="grid gap-4 sm:gap-6 xl:grid-cols-2">
                    <MonthSummaryPanel snapshot={leftSnapshot} accent={LEFT_ACCENT} baseCurrency={baseCurrency} iqdPreference={iqdPreference} isCurrent={leftSnapshot.option.value === currentMonthKey} />
                    <MonthSummaryPanel snapshot={rightSnapshot} accent={RIGHT_ACCENT} baseCurrency={baseCurrency} iqdPreference={iqdPreference} isCurrent={rightSnapshot.option.value === currentMonthKey} />
                </div>
            </div>

            <ComparisonInsightsStrip insights={insights} />

            {/* ── Charts & Analytics ── */}
            <div className="space-y-4">
                <div className="flex items-center gap-3 px-1">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground/60">{t('monthlyComparison.sections.chartsAnalytics')}</span>
                    <div className="h-px flex-1 bg-border/60" />
                </div>
                <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
                    <MonthPaceComparisonChart left={leftSnapshot} right={rightSnapshot} metric={paceMetric} onMetricChange={setPaceMetric} baseCurrency={baseCurrency} iqdPreference={iqdPreference} />
                    <CategoryComparisonChart title={t('monthlyComparison.categories.revenue')} summary={getChartSummaryLabel(revenueCategoryData, rightSnapshot.option.label, leftSnapshot.option.label, t)} data={revenueCategoryData} baseCurrency={baseCurrency} iqdPreference={iqdPreference} leftLabel={leftSnapshot.option.label} rightLabel={rightSnapshot.option.label} />
                    <CategoryComparisonChart title={t('monthlyComparison.categories.expense')} summary={expenseCategoryData.length === 0 ? t('monthlyComparison.empty.noExpenseData') : getChartSummaryLabel(expenseCategoryData, rightSnapshot.option.label, leftSnapshot.option.label, t)} data={expenseCategoryData} baseCurrency={baseCurrency} iqdPreference={iqdPreference} leftLabel={leftSnapshot.option.label} rightLabel={rightSnapshot.option.label} />
                </div>
            </div>

            {/* ── Details & Breakdown ── */}
            <div className="space-y-4">
                <div className="flex items-center gap-3 px-1">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground/60">{t('monthlyComparison.sections.detailsBreakdown')}</span>
                    <div className="h-px flex-1 bg-border/60" />
                </div>
                <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
                    <TopProductsComparisonCard rows={topProductRows} baseCurrency={baseCurrency} iqdPreference={iqdPreference} leftLabel={leftSnapshot.option.label} rightLabel={rightSnapshot.option.label} />
                    <ReturnsComparisonCard left={leftSnapshot} right={rightSnapshot} baseCurrency={baseCurrency} iqdPreference={iqdPreference} />
                    <PeakActivityComparisonCard left={leftSnapshot} right={rightSnapshot} peakView={peakView} onPeakViewChange={setPeakView} />
                </div>
            </div>

            <ProfitBridgeComparisonCard left={leftSnapshot} right={rightSnapshot} baseCurrency={baseCurrency} iqdPreference={iqdPreference} />
        </div>
    )
}
