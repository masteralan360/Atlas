import { useEffect, useMemo, useState } from 'react'
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
    ResponsiveContainer,
    Tooltip as RechartsTooltip,
    XAxis,
    YAxis,
} from 'recharts'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { cn, formatCurrency } from '@/lib/utils'
import { convertToStoreBase as convertToStoreBaseUtil } from '@/lib/currency'
import { useSales, toUISale, useExpenses, useEmployees, useBudgetAllocations } from '@/local-db'
import type { BudgetAllocation, Employee, Expense } from '@/local-db'
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

const normalizeExpenseField = (value?: string | null) => (value || '').trim().toLowerCase()

const isRecurringOccurrenceMatch = (
    recurringTemplate: Expense,
    expenseRecord: Expense,
    monthStart: Date,
    monthEnd: Date
): boolean => {
    if (!recurringTemplate || !expenseRecord || expenseRecord.type !== 'one-time') return false

    const expenseDueDate = new Date(expenseRecord.dueDate)
    if (isNaN(expenseDueDate.getTime()) || expenseDueDate < monthStart || expenseDueDate > monthEnd) return false

    if (expenseRecord.category !== recurringTemplate.category) return false
    if (normalizeExpenseField(expenseRecord.description) !== normalizeExpenseField(recurringTemplate.description)) return false
    if (normalizeExpenseField(expenseRecord.subcategory) !== normalizeExpenseField(recurringTemplate.subcategory)) return false

    const recurringDay = new Date(recurringTemplate.dueDate).getDate()
    if (isNaN(recurringDay)) return false

    const projectedDay = Math.min(
        recurringDay,
        new Date(expenseDueDate.getFullYear(), expenseDueDate.getMonth() + 1, 0).getDate()
    )

    return expenseDueDate.getDate() === projectedDay
}

function monthKeyFromDate(date: Date | string): MonthKey {
    const d = new Date(date)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` as MonthKey
}

function monthDateFromKey(month: MonthKey) {
    const [year, monthIndex] = month.split('-').map(Number)
    return new Date(year, monthIndex - 1, 1)
}

function formatMonthLabel(month: MonthKey, language: string) {
    return new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' }).format(monthDateFromKey(month))
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

function humanizeExpenseCategory(name: string) {
    return name.replace(/[_-]/g, ' ').replace(/\b\w/g, char => char.toUpperCase())
}

function getMarginBand(margin: number) {
    if (margin >= 25) return 'Strong'
    if (margin >= 12) return 'Average'
    return 'Weak'
}

function buildAvailableMonths(
    sales: Sale[],
    expenses: Expense[],
    allocations: BudgetAllocation[],
    language: string
): MonthOption[] {
    const monthMap = new Map<MonthKey, MonthOption>()

    sales.forEach(sale => {
        const key = monthKeyFromDate(sale.created_at)
        const existing = monthMap.get(key)
        monthMap.set(key, {
            value: key,
            label: formatMonthLabel(key, language),
            hasSales: true,
            hasExpenses: existing?.hasExpenses ?? false,
            hasAllocation: existing?.hasAllocation ?? false,
        })
    })

    expenses.forEach(expense => {
        const key = monthKeyFromDate(expense.dueDate)
        const existing = monthMap.get(key)
        monthMap.set(key, {
            value: key,
            label: formatMonthLabel(key, language),
            hasSales: existing?.hasSales ?? false,
            hasExpenses: true,
            hasAllocation: existing?.hasAllocation ?? false,
        })
    })

    allocations.forEach(allocation => {
        const key = allocation.month as MonthKey
        const existing = monthMap.get(key)
        monthMap.set(key, {
            value: key,
            label: formatMonthLabel(key, language),
            hasSales: existing?.hasSales ?? false,
            hasExpenses: existing?.hasExpenses ?? false,
            hasAllocation: true,
        })
    })

    return Array.from(monthMap.values()).sort((a, b) => b.value.localeCompare(a.value))
}

function analyzeSalesMonth(
    sales: Sale[],
    month: MonthKey,
    baseCurrency: string,
    convertToBase: (amount: number | undefined | null, currency: string | undefined | null) => number
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

                const category = item.product_category || item.product?.category || 'Uncategorized'
                categoryRevenue[category] = (categoryRevenue[category] || 0) + itemRevenueBase

                const productId = item.product_id || item.id
                if (!productPerformance[productId]) {
                    productPerformance[productId] = {
                        id: productId,
                        name: item.product_name || item.product?.name || 'Unknown Product',
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
                        name: item.product_name || item.product?.name || 'Unknown Product',
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
    sales: SalesSnapshot,
    expenses: Expense[],
    employees: Employee[],
    allocations: BudgetAllocation[],
    convertToBase: (amount: number | undefined | null, currency: string | undefined | null) => number
): BudgetSnapshot {
    const monthDate = monthDateFromKey(month)
    const year = monthDate.getFullYear()
    const monthIndex = monthDate.getMonth()
    const monthStart = new Date(year, monthIndex, 1)
    const monthEnd = new Date(year, monthIndex + 1, 0, 23, 59, 59)
    const daysInMonth = getDaysInMonth(month)

    const recurringTemplates = expenses.filter(expense => expense.type === 'recurring')
    const monthExpenses = expenses
        .filter(expense => {
            const dueDate = new Date(expense.dueDate)
            if (expense.type !== 'one-time') return false
            if (expense.category === 'payroll' && expense.employeeId) return false
            return dueDate >= monthStart && dueDate <= monthEnd
        })
        .map(expense => ({
            ...expense,
            isRecurringLinked: recurringTemplates.some(template => isRecurringOccurrenceMatch(template, expense, monthStart, monthEnd)),
        }))

    const virtualRecurringExpenses = recurringTemplates
        .filter(template => !monthExpenses.some(expense => isRecurringOccurrenceMatch(template, expense, monthStart, monthEnd)))
        .map(template => {
            const templateDate = new Date(template.dueDate)
            const projectedDate = new Date(year, monthIndex, Math.min(templateDate.getDate(), new Date(year, monthIndex + 1, 0).getDate()))
            return {
                ...template,
                id: `virtual-${template.id}-${month}`,
                dueDate: projectedDate.toISOString(),
                status: 'pending' as const,
            }
        })

    const dailySpend = new Array(daysInMonth).fill(0)
    const expenseCategoryMap: Record<string, number> = {}

    let operationalTotal = 0
    let operationalPaid = 0
    let operationalPending = 0

        ;[...monthExpenses, ...virtualRecurringExpenses].forEach(expense => {
            const baseAmount = convertToBase(expense.amount, expense.currency)
            const dayIndex = Math.max(0, Math.min(daysInMonth - 1, new Date(expense.dueDate).getDate() - 1))
            dailySpend[dayIndex] += baseAmount
            operationalTotal += baseAmount
            if (expense.status === 'paid') operationalPaid += baseAmount
            else operationalPending += baseAmount

            const bucket = humanizeExpenseCategory(expense.subcategory || expense.category)
            expenseCategoryMap[bucket] = (expenseCategoryMap[bucket] || 0) + baseAmount
        })

    let personnelTotal = 0
    let personnelPaid = 0
    let personnelPending = 0

    employees.forEach(employee => {
        if (!employee.salary || employee.salary <= 0) return

        const existingPayrollExpense = expenses.find(expense =>
            expense.type === 'one-time' &&
            expense.category === 'payroll' &&
            expense.employeeId === employee.id &&
            new Date(expense.dueDate) >= monthStart &&
            new Date(expense.dueDate) <= monthEnd
        )

        const baseAmount = convertToBase(employee.salary, employee.salaryCurrency || 'usd')
        const payday = Number(employee.salaryPayday) || 30
        const dueDate = new Date(year, monthIndex, Math.min(payday, daysInMonth))
        const dayIndex = Math.max(0, Math.min(daysInMonth - 1, dueDate.getDate() - 1))

        personnelTotal += baseAmount
        dailySpend[dayIndex] += baseAmount

        if (existingPayrollExpense?.status === 'paid') personnelPaid += baseAmount
        else personnelPending += baseAmount
    })

    if (personnelTotal > 0) expenseCategoryMap['Payroll'] = (expenseCategoryMap['Payroll'] || 0) + personnelTotal

    const totalAllocated = operationalTotal + personnelTotal
    const referenceProfit = sales.baseTotals.profit
    const profitPool = Math.max(0, referenceProfit - totalAllocated)
    const dividends = employees.reduce((sum, employee) => {
        if (!employee.hasDividends || !employee.dividendAmount || employee.dividendAmount <= 0 || employee.isFired) return sum
        if (employee.dividendType === 'fixed') return sum + convertToBase(employee.dividendAmount, employee.dividendCurrency || 'usd')
        return sum + profitPool * ((employee.dividendAmount || 0) / 100)
    }, 0)

    const retained = profitPool - dividends
    const allocation = allocations.find(item => item.month === month)
    let budgetLimit = 0
    if (allocation) {
        budgetLimit = allocation.type === 'fixed'
            ? convertToBase(allocation.amount, allocation.currency)
            : referenceProfit * (allocation.amount / 100)
    }

    const cumulativeSpend: number[] = []
    let runningSpend = 0
    dailySpend.forEach(value => {
        runningSpend += value
        cumulativeSpend.push(runningSpend)
    })

    return {
        totalAllocated,
        paid: operationalPaid + personnelPaid,
        outstanding: operationalPending + personnelPending,
        dividends,
        retained,
        isDeficit: retained < 0,
        budgetLimit,
        operationalTotal,
        personnelTotal,
        expenseCategories: Object.entries(expenseCategoryMap).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
        cumulativeSpend,
    }
}

function buildPaceData(left: MonthSnapshot, right: MonthSnapshot, metric: ComparisonMetric) {
    const maxDays = Math.max(getDaysInMonth(left.option.value), getDaysInMonth(right.option.value))
    const leftSeries = metric === 'revenue' ? left.sales.cumulativeRevenue : metric === 'profit' ? left.sales.cumulativeProfit : left.budget.cumulativeSpend
    const rightSeries = metric === 'revenue' ? right.sales.cumulativeRevenue : metric === 'profit' ? right.sales.cumulativeProfit : right.budget.cumulativeSpend

    return Array.from({ length: maxDays }, (_, index) => ({
        day: index + 1,
        left: index < leftSeries.length ? leftSeries[index] : null,
        right: index < rightSeries.length ? rightSeries[index] : null,
    }))
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
            state: leftTopIds.has(product.id) && !rightTopIds.has(product.id) ? 'Dropped' : !leftTopIds.has(product.id) && rightTopIds.has(product.id) ? 'New' : null,
        }))
}

function formatSignedShort(value: number) {
    if (value === 0) return '0'
    const abs = Math.abs(value)
    if (abs >= 1000) return `${value > 0 ? '+' : '-'}${(abs / 1000).toFixed(1)}k`
    return `${value > 0 ? '+' : '-'}${abs.toFixed(0)}`
}

function buildInsights(left: MonthSnapshot, right: MonthSnapshot) {
    const revenueDelta = right.sales.baseTotals.revenue - left.sales.baseTotals.revenue
    const profitDelta = right.sales.baseTotals.profit - left.sales.baseTotals.profit
    const marginDelta = right.sales.baseTotals.margin - left.sales.baseTotals.margin
    const returnsDelta = right.sales.returns.returnRate - left.sales.returns.returnRate
    const topMover = buildTopProductRows(left, right)[0]
    const monthA = left.option.label
    const monthB = right.option.label

    return [
        revenueDelta === 0 ? `Revenue: ${monthA} and ${monthB} closed at nearly the same level.` : `Revenue: ${monthB} ${revenueDelta > 0 ? 'outperformed' : 'trailed'} ${monthA} by ${Math.abs(safePercentChange(right.sales.baseTotals.revenue, left.sales.baseTotals.revenue)).toFixed(1)}%.`,
        profitDelta === 0 ? `Profitability: Net profit stayed broadly flat, with margin shifting ${Math.abs(marginDelta).toFixed(1)} percentage points.` : `Profitability: Net profit moved ${profitDelta > 0 ? 'up' : 'down'} while margin ${marginDelta >= 0 ? 'expanded' : 'compressed'} by ${Math.abs(marginDelta).toFixed(1)} points.`,
        Math.abs(returnsDelta) > 0.5 ? `Returns: Return rate ${returnsDelta >= 0 ? 'rose' : 'fell'} by ${Math.abs(returnsDelta).toFixed(1)} points between the two months.` : topMover ? `Products: ${topMover.name} was the strongest visible mover, shifting ${formatSignedShort(topMover.delta)} between the selected months.` : 'Spend: Operational changes shaped the retained profit gap between the selected months.',
    ]
}

function getChartSummaryLabel(data: Array<{ name: string; left: number; right: number }>, winnerLabel: string, loserLabel: string) {
    if (data.length === 0) return 'No meaningful difference'
    const strongest = [...data].sort((a, b) => Math.abs(b.right - b.left) - Math.abs(a.right - a.left))[0]
    if (!strongest || strongest.left === strongest.right) return 'No meaningful difference'
    return `${strongest.name} favored ${strongest.right > strongest.left ? winnerLabel : loserLabel}`
}

function MonthSelectorCard({
    title,
    accent,
    value,
    options,
    otherValue,
    onChange,
    meta,
}: {
    title: string
    accent: typeof LEFT_ACCENT
    value: MonthKey
    options: MonthOption[]
    otherValue: MonthKey
    onChange: (value: MonthKey) => void
    meta: string
}) {
    return (
        <Card className={cn('min-w-0 flex-1 rounded-[1.75rem] border shadow-sm backdrop-blur-sm', accent.soft)}>
            <CardContent className="p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.2em]', accent.badge)}>
                        {title}
                    </span>
                </div>
                <Select value={value} onValueChange={next => onChange(next as MonthKey)}>
                    <SelectTrigger className="h-12 rounded-2xl border-border/50 bg-background/70 text-left font-black">
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
                <p className="mt-3 text-[11px] font-semibold text-muted-foreground">{meta}</p>
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
}: DeltaCardConfig & {
    baseCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
    leftLabel: string
    rightLabel: string
}) {
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
            <CardContent className="p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <div className={cn('rounded-2xl p-2', !isNeutral && 'bg-background/70')}>
                            <Icon className="h-4 w-4" />
                        </div>
                        <span className="text-[11px] font-black uppercase tracking-[0.18em]">{label}</span>
                    </div>
                    {isNeutral ? (
                        <span className="rounded-full border border-border px-2 py-1 text-[10px] font-bold text-muted-foreground">No change</span>
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
                    {isNeutral ? 'Flat' : valueText}
                </div>
                <p className="mt-1 text-[11px] font-medium text-muted-foreground">
                    {leftLabel} vs {rightLabel}
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
                        <div className="mt-2 text-2xl font-black tracking-tight text-foreground">{value}</div>
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
    const { sales, budget } = snapshot
    const budgetPct = budget.budgetLimit > 0 ? (budget.totalAllocated / budget.budgetLimit) * 100 : undefined
    const paidPct = budget.totalAllocated > 0 ? (budget.paid / budget.totalAllocated) * 100 : 0

    return (
        <Card className="rounded-[2rem] border border-border/50 shadow-sm overflow-hidden">
            <div className="h-1" style={{ backgroundColor: accent.line }} />
            <CardHeader className="pb-4">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <span className={cn('inline-flex rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.2em]', accent.badge)}>
                            {isCurrent ? 'Current' : 'Historical'}
                        </span>
                        <CardTitle className="mt-3 text-2xl font-black tracking-tight">{snapshot.option.label}</CardTitle>
                        <p className="mt-1 text-sm font-medium text-muted-foreground">
                            {sales.baseTotals.transactions} transactions
                            {snapshot.option.hasExpenses ? ' • expenses tracked' : ' • no expenses logged'}
                            {snapshot.option.hasAllocation ? ' • budget set' : ' • budget not set'}
                        </p>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="space-y-6">
                <div>
                    <div className="mb-3 flex items-center gap-2">
                        <BarChart3 className={cn('h-4 w-4', accent.text)} />
                        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">Revenue KPIs</p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <KpiCard title="Gross Revenue" value={formatCurrency(sales.baseTotals.revenue, baseCurrency, iqdPreference)} icon={DollarSign} tone="blue" subtitle={`${sales.baseTotals.transactions} transactions`} currencyTotals={sales.currencyTotals} iqdPreference={iqdPreference} />
                        <KpiCard title="Total Cost" value={formatCurrency(sales.baseTotals.cost, baseCurrency, iqdPreference)} icon={Package} tone="orange" subtitle={`${sales.baseTotals.revenue > 0 ? ((sales.baseTotals.cost / sales.baseTotals.revenue) * 100).toFixed(1) : '0.0'}% cost ratio`} iqdPreference={iqdPreference} />
                        <KpiCard title="Net Profit" value={formatCurrency(sales.baseTotals.profit, baseCurrency, iqdPreference)} icon={TrendingUp} tone="emerald" subtitle={`${sales.baseTotals.revenue > 0 ? ((sales.baseTotals.profit / sales.baseTotals.revenue) * 100).toFixed(1) : '0.0'}% of revenue`} iqdPreference={iqdPreference} />
                        <KpiCard title="Profit Margin" value={`${sales.baseTotals.margin.toFixed(1)}%`} icon={Percent} tone="violet" subtitle={getMarginBand(sales.baseTotals.margin)} progress={sales.baseTotals.margin} iqdPreference={iqdPreference} />
                    </div>
                </div>

                <div>
                    <div className="mb-3 flex items-center gap-2">
                        <Wallet className={cn('h-4 w-4', accent.text)} />
                        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">Month Health</p>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        <KpiCard title="Total Allocated" value={formatCurrency(budget.totalAllocated, baseCurrency, iqdPreference)} icon={BarChart3} tone={budget.budgetLimit > 0 && budgetPct && budgetPct > 100 ? 'red' : 'blue'} subtitle={budget.budgetLimit > 0 ? `${formatCurrency(budget.budgetLimit, baseCurrency, iqdPreference)} limit` : 'Budget not set'} progress={budgetPct} iqdPreference={iqdPreference} />
                        <KpiCard title="Total Paid" value={formatCurrency(budget.paid, baseCurrency, iqdPreference)} icon={TrendingUp} tone="emerald" subtitle={`${paidPct.toFixed(1)}% of allocated spend`} progress={paidPct} iqdPreference={iqdPreference} />
                        <KpiCard title="Outstanding" value={formatCurrency(budget.outstanding, baseCurrency, iqdPreference)} icon={Clock} tone="amber" subtitle="Due by month end" iqdPreference={iqdPreference} />
                        <KpiCard title="Dividends" value={formatCurrency(budget.dividends, baseCurrency, iqdPreference)} icon={Wallet} tone="sky" subtitle="Configured distribution total" iqdPreference={iqdPreference} />
                    </div>
                </div>
            </CardContent>
        </Card>
    )
}

function ComparisonInsightsStrip({ insights }: { insights: string[] }) {
    return (
        <Card className="rounded-[2rem] border border-border/50 bg-card/70 shadow-sm">
            <CardContent className="p-5">
                <div className="mb-4 flex items-center gap-2">
                    <div className="rounded-2xl bg-primary/10 p-2 text-primary">
                        <Sparkles className="h-4 w-4" />
                    </div>
                    <div>
                        <p className="text-[11px] font-black uppercase tracking-[0.2em] text-muted-foreground">What Changed</p>
                        <p className="text-sm font-medium text-muted-foreground">Three deterministic takeaways from the comparison</p>
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
    const data = useMemo(() => buildPaceData(left, right, metric), [left, right, metric])
    const label = metric === 'revenue' ? 'Revenue Pace' : metric === 'profit' ? 'Profit Pace' : 'Operational Spend Pace'

    return (
        <Card className="rounded-[2rem] border border-border/50 shadow-sm xl:col-span-2">
            <CardHeader className="pb-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <CardTitle className="text-xl font-black tracking-tight">{label}</CardTitle>
                        <p className="mt-1 text-sm text-muted-foreground">Cumulative by day of month</p>
                    </div>
                    <Tabs value={metric} onValueChange={value => onMetricChange(value as ComparisonMetric)}>
                        <TabsList className="grid h-10 w-full grid-cols-3 rounded-2xl bg-secondary/50 p-1 lg:w-[360px]">
                            <TabsTrigger value="revenue" className="rounded-xl text-xs font-black uppercase tracking-wide">Revenue</TabsTrigger>
                            <TabsTrigger value="profit" className="rounded-xl text-xs font-black uppercase tracking-wide">Profit</TabsTrigger>
                            <TabsTrigger value="spend" className="rounded-xl text-xs font-black uppercase tracking-wide">Spend</TabsTrigger>
                        </TabsList>
                    </Tabs>
                </div>
            </CardHeader>
            <CardContent className="h-[340px]">
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
                            contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '18px', border: '1px solid hsl(var(--border))', padding: '12px' }}
                            formatter={(value, name) => [
                                value == null ? '--' : formatCurrency(Number(value), baseCurrency, iqdPreference),
                                name === 'left' ? left.option.label : right.option.label,
                            ]}
                        />
                        <Legend wrapperStyle={{ paddingTop: '16px' }} formatter={value => value === 'left' ? left.option.label : right.option.label} />
                        <Area type="monotone" dataKey="left" name="left" stroke={LEFT_ACCENT.line} strokeWidth={3} fill="url(#paceLeft)" connectNulls={false} />
                        <Area type="monotone" dataKey="right" name="right" stroke={RIGHT_ACCENT.line} strokeWidth={3} fill="url(#paceRight)" connectNulls={false} />
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
}: {
    title: string
    summary: string
    data: Array<{ name: string; left: number; right: number }>
    baseCurrency: string
    iqdPreference: 'IQD' | 'د.ع'
}) {
    return (
        <Card className="rounded-[2rem] border border-border/50 shadow-sm">
            <CardHeader className="pb-4">
                <CardTitle className="text-lg font-black tracking-tight">{title}</CardTitle>
                <p className="text-sm text-muted-foreground">{summary}</p>
            </CardHeader>
            <CardContent className="h-[320px]">
                {data.length === 0 ? (
                    <div className="flex h-full items-center justify-center rounded-[1.4rem] border border-dashed border-border/60 text-sm font-medium text-muted-foreground">
                        No data available
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
                                    name === 'left' ? 'Month A' : 'Month B',
                                ]}
                            />
                            <Legend />
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
    return (
        <Card className="rounded-[2rem] border border-border/50 shadow-sm">
            <CardHeader className="pb-4">
                <CardTitle className="text-lg font-black tracking-tight">Top Products Comparison</CardTitle>
                <p className="text-sm text-muted-foreground">Top 5 products by combined revenue across the selected months</p>
            </CardHeader>
            <CardContent className="overflow-x-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-12">#</TableHead>
                            <TableHead>Product</TableHead>
                            <TableHead className="text-end">{leftLabel}</TableHead>
                            <TableHead className="text-end">{rightLabel}</TableHead>
                            <TableHead className="text-end">Delta</TableHead>
                            <TableHead className="text-end">Share</TableHead>
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
                                                row.state === 'New' ? RIGHT_ACCENT.badge : LEFT_ACCENT.badge
                                            )}>
                                                {row.state}
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
    const isEmpty = left.sales.returns.totalReturns === 0 && right.sales.returns.totalReturns === 0

    return (
        <Card className="rounded-[2rem] border border-red-500/10 bg-red-500/5 shadow-sm">
            <CardHeader className="pb-4">
                <CardTitle className="text-lg font-black tracking-tight text-red-700 dark:text-red-300">Returns Comparison</CardTitle>
                <p className="text-sm text-red-900/60 dark:text-red-100/60">Refund pressure and returned-product differences</p>
            </CardHeader>
            <CardContent className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-3">
                    <KpiCard title="Total Returns" value={`${right.sales.returns.totalReturns}`} icon={RotateCcw} tone="red" subtitle={`${left.option.label}: ${left.sales.returns.totalReturns}`} iqdPreference={iqdPreference} />
                    <KpiCard title="Refunded Amount" value={formatCurrency(right.sales.returns.refundedAmount, baseCurrency, iqdPreference)} icon={TrendingDown} tone="orange" subtitle={`${left.option.label}: ${formatCurrency(left.sales.returns.refundedAmount, baseCurrency, iqdPreference)}`} iqdPreference={iqdPreference} />
                    <KpiCard title="Return Rate" value={`${right.sales.returns.returnRate.toFixed(1)}%`} icon={Percent} tone="amber" subtitle={`${left.option.label}: ${left.sales.returns.returnRate.toFixed(1)}%`} iqdPreference={iqdPreference} />
                </div>

                {isEmpty ? (
                    <div className="rounded-[1.4rem] border border-dashed border-red-500/20 bg-background/70 p-6 text-center text-sm font-medium text-muted-foreground">
                        No returns recorded in either month
                    </div>
                ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                        {[left, right].map((snapshot, index) => (
                            <div key={snapshot.option.value} className="rounded-[1.4rem] border border-border/60 bg-background/70 p-4">
                                <div className="mb-3 flex items-center justify-between">
                                    <p className={cn('text-xs font-black uppercase tracking-[0.18em]', index === 0 ? LEFT_ACCENT.text : RIGHT_ACCENT.text)}>
                                        {snapshot.option.label}
                                    </p>
                                    <span className="text-xs font-medium text-muted-foreground">{snapshot.sales.returns.totalReturns} returns</span>
                                </div>
                                <div className="space-y-2">
                                    {snapshot.sales.returns.topProducts.length > 0 ? snapshot.sales.returns.topProducts.map((product, productIndex) => (
                                        <div key={`${snapshot.option.value}-${product.name}`} className="flex items-center justify-between rounded-xl border border-border/40 px-3 py-2">
                                            <div>
                                                <p className="text-sm font-semibold">{productIndex + 1}. {product.name}</p>
                                                <p className="text-xs text-muted-foreground">{product.count} returned</p>
                                            </div>
                                            <span className="text-sm font-black text-red-600 dark:text-red-400">
                                                {formatCurrency(product.amount, baseCurrency, iqdPreference)}
                                            </span>
                                        </div>
                                    )) : (
                                        <div className="rounded-xl border border-dashed border-border/50 px-3 py-4 text-center text-sm text-muted-foreground">
                                            No returned products
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
    const peakData = useMemo(() => {
        return left.sales.hourly.map((point, index) => ({
            hour: point.label,
            left: point.count,
            right: right.sales.hourly[index]?.count || 0,
        }))
    }, [left.sales.hourly, right.sales.hourly])

    return (
        <Card className="rounded-[2rem] border border-border/50 shadow-sm">
            <CardHeader className="pb-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <CardTitle className="text-lg font-black tracking-tight">Peak Activity Comparison</CardTitle>
                        <p className="text-sm text-muted-foreground">Busy-hour profile for both months</p>
                    </div>
                    <Tabs value={peakView} onValueChange={value => onPeakViewChange(value as PeakView)}>
                        <TabsList className="grid h-10 w-[220px] grid-cols-2 rounded-2xl bg-secondary/50 p-1">
                            <TabsTrigger value="hourly" className="rounded-xl text-xs font-black uppercase tracking-wide">Hourly</TabsTrigger>
                            <TabsTrigger value="heatmap" className="rounded-xl text-xs font-black uppercase tracking-wide">Heatmap</TabsTrigger>
                        </TabsList>
                    </Tabs>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-[1.4rem] border border-border/60 bg-background/70 p-4">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{left.option.label}</span>
                            <span className={cn('rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-wide', LEFT_ACCENT.badge)}>Peak {left.sales.peakHourLabel}</span>
                        </div>
                    </div>
                    <div className="rounded-[1.4rem] border border-border/60 bg-background/70 p-4">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{right.option.label}</span>
                            <span className={cn('rounded-full border px-2 py-1 text-[10px] font-black uppercase tracking-wide', RIGHT_ACCENT.badge)}>Peak {right.sales.peakHourLabel}</span>
                        </div>
                    </div>
                </div>

                <Tabs value={peakView} onValueChange={value => onPeakViewChange(value as PeakView)}>
                    <TabsContent value="hourly" className="mt-0">
                        <div className="h-[280px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={peakData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} vertical={false} />
                                    <XAxis dataKey="hour" axisLine={false} tickLine={false} tick={{ fontSize: 9, fontWeight: 700, fill: 'currentColor' }} className="text-muted-foreground/70" interval={1} />
                                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }} className="text-muted-foreground/70" allowDecimals={false} />
                                    <RechartsTooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '18px', border: '1px solid hsl(var(--border))', padding: '12px' }} />
                                    <Legend />
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
    const columns = [
        {
            label: left.option.label,
            accent: LEFT_ACCENT,
            steps: [
                { label: 'Profit from Revenue', value: left.sales.baseTotals.profit, tone: 'emerald' as const },
                { label: 'Operational Expenses', value: -left.budget.operationalTotal, tone: 'orange' as const },
                { label: 'Personnel', value: -left.budget.personnelTotal, tone: 'orange' as const },
                { label: 'Dividends', value: left.budget.dividends, tone: 'blue' as const },
            ],
            note: left.sales.baseTotals.profit > left.budget.totalAllocated ? 'Revenue profit covered operational costs' : 'Operational costs exceeded profit from revenue',
        },
        {
            label: right.option.label,
            accent: RIGHT_ACCENT,
            steps: [
                { label: 'Profit from Revenue', value: right.sales.baseTotals.profit, tone: 'emerald' as const },
                { label: 'Operational Expenses', value: -right.budget.operationalTotal, tone: 'orange' as const },
                { label: 'Personnel', value: -right.budget.personnelTotal, tone: 'orange' as const },
                { label: 'Dividends', value: right.budget.dividends, tone: 'blue' as const },
            ],
            note: right.sales.baseTotals.profit > right.budget.totalAllocated ? 'Revenue profit covered operational costs' : 'Operational costs exceeded profit from revenue',
        },
    ]

    const isTie = right.sales.baseTotals.profit === left.sales.baseTotals.profit
    const winnerIsRight = right.sales.baseTotals.profit > left.sales.baseTotals.profit

    return (
        <Card className="rounded-[2rem] border border-border/50 shadow-sm">
            <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-2xl bg-primary/10 text-primary">
                        <TrendingUp className="w-5 h-5" />
                    </div>
                    <div>
                        <CardTitle className="text-xl font-black tracking-tight">Profit Bridge</CardTitle>
                        <p className="text-sm text-muted-foreground">How each month moved from sales profit to retained profit</p>
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
                                        <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.2em] text-emerald-600 dark:text-emerald-400">Winner</span>
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
    const expenses = useExpenses(workspaceId)
    const employees = useEmployees(workspaceId)
    const allocations = useBudgetAllocations(workspaceId)

    const sales = useMemo<Sale[]>(() => rawSales.map(toUISale), [rawSales])

    const convertToBase = useMemo(() => {
        return (amount: number | undefined | null, from: string | undefined | null) => convertToStoreBaseUtil(amount, from, baseCurrency, {
            usd_iqd: (exchangeData?.rate || 145000) / 100,
            eur_iqd: (eurRates.eur_iqd?.rate || 160000) / 100,
            try_iqd: (tryRates.try_iqd?.rate || 4500) / 100,
        })
    }, [baseCurrency, exchangeData, eurRates, tryRates])

    const monthOptions = useMemo(
        () => buildAvailableMonths(sales, expenses, allocations, i18n.language),
        [sales, expenses, allocations, i18n.language]
    )

    const defaultSelection = useMemo(() => ({
        right: monthOptions[0]?.value || '' as MonthKey,
        left: monthOptions[1]?.value || monthOptions[0]?.value || '' as MonthKey,
    }), [monthOptions])

    const [leftMonth, setLeftMonth] = useState<MonthKey>('' as MonthKey)
    const [rightMonth, setRightMonth] = useState<MonthKey>('' as MonthKey)
    const [paceMetric, setPaceMetric] = useState<ComparisonMetric>('profit')
    const [peakView, setPeakView] = useState<PeakView>('hourly')

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

    const leftSnapshot = useMemo(() => {
        const option = monthOptions.find(item => item.value === leftMonth)
        if (!option) return null
        const salesSnapshot = analyzeSalesMonth(sales, option.value, baseCurrency, convertToBase)
        return {
            option,
            sales: salesSnapshot,
            budget: analyzeBudgetMonth(option.value, salesSnapshot, expenses, employees, allocations, convertToBase),
        } satisfies MonthSnapshot
    }, [monthOptions, leftMonth, sales, baseCurrency, convertToBase, expenses, employees, allocations])

    const rightSnapshot = useMemo(() => {
        const option = monthOptions.find(item => item.value === rightMonth)
        if (!option) return null
        const salesSnapshot = analyzeSalesMonth(sales, option.value, baseCurrency, convertToBase)
        return {
            option,
            sales: salesSnapshot,
            budget: analyzeBudgetMonth(option.value, salesSnapshot, expenses, employees, allocations, convertToBase),
        } satisfies MonthSnapshot
    }, [monthOptions, rightMonth, sales, baseCurrency, convertToBase, expenses, employees, allocations])

    const currentMonthKey = monthKeyFromDate(new Date())
    const yearAgoMonth = useMemo(() => {
        if (!monthOptions[0]) return null
        const baseDate = monthDateFromKey(monthOptions[0].value)
        const candidate = monthKeyFromDate(new Date(baseDate.getFullYear() - 1, baseDate.getMonth(), 1))
        return monthOptions.some(option => option.value === candidate) ? candidate : null
    }, [monthOptions])

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
        () => leftSnapshot && rightSnapshot ? buildInsights(leftSnapshot, rightSnapshot) : [],
        [leftSnapshot, rightSnapshot]
    )

    const deltaCards = useMemo<DeltaCardConfig[]>(() => {
        if (!leftSnapshot || !rightSnapshot) return []
        return [
            { key: 'revenue', label: 'Revenue', leftValue: leftSnapshot.sales.baseTotals.revenue, rightValue: rightSnapshot.sales.baseTotals.revenue, format: 'currency', icon: DollarSign, tone: 'blue' },
            { key: 'profit', label: 'Net Profit', leftValue: leftSnapshot.sales.baseTotals.profit, rightValue: rightSnapshot.sales.baseTotals.profit, format: 'currency', icon: TrendingUp, tone: 'emerald' },
            { key: 'margin', label: 'Profit Margin', leftValue: leftSnapshot.sales.baseTotals.margin, rightValue: rightSnapshot.sales.baseTotals.margin, format: 'percent', icon: Percent, tone: 'violet' },
            { key: 'spend', label: 'Operational Spend', leftValue: leftSnapshot.budget.totalAllocated, rightValue: rightSnapshot.budget.totalAllocated, format: 'currency', icon: BarChart3, tone: 'orange' },
            { key: 'dividends', label: 'Dividends', leftValue: leftSnapshot.budget.dividends, rightValue: rightSnapshot.budget.dividends, format: 'currency', icon: Wallet, tone: 'sky' },
        ]
    }, [leftSnapshot, rightSnapshot])

    if (monthOptions.length < 2 || !leftSnapshot || !rightSnapshot) {
        return (
            <div className="space-y-8">
                <div className="flex items-center gap-3">
                    <div className="p-3 rounded-2xl bg-primary/10 text-primary shadow-inner">
                        <BarChart3 className="w-6 h-6" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black tracking-tight">{t('monthlyComparison.title', 'Monthly Comparison')}</h1>
                        <p className="text-sm font-medium text-muted-foreground/80">
                            {t('monthlyComparison.subtitle', 'Compare two months across revenue, costs, expenses, dividends, and retained profit')}
                        </p>
                    </div>
                </div>
                <Card className="rounded-[2rem] border border-dashed border-border/60 shadow-sm">
                    <CardContent className="flex min-h-[280px] flex-col items-center justify-center gap-4 p-8 text-center">
                        <div className="rounded-full bg-secondary/60 p-4">
                            <CalendarDays className="h-8 w-8 text-muted-foreground" />
                        </div>
                        <div>
                            <h2 className="text-xl font-black tracking-tight">Not enough month history to compare</h2>
                            <p className="mt-2 max-w-md text-sm text-muted-foreground">
                                This page needs at least two months with synced sales, expense, or budget data before it can render a comparison.
                            </p>
                        </div>
                    </CardContent>
                </Card>
            </div>
        )
    }


    return (
        <div className="space-y-8 pb-10">
            <div className="space-y-2">
                <div className="flex items-center gap-3">
                    <div className="p-3 rounded-2xl bg-primary/10 text-primary shadow-inner">
                        <BarChart3 className="w-6 h-6" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-black tracking-tight">{t('monthlyComparison.title', 'Monthly Comparison')}</h1>
                        <p className="text-sm font-medium text-muted-foreground/80">
                            {t('monthlyComparison.subtitle', 'Compare two months across revenue, costs, expenses, dividends, and retained profit')}
                        </p>
                    </div>
                </div>
            </div>

            <div className="sticky top-3 z-20 rounded-[2rem] border border-border/60 bg-background/90 p-3 shadow-lg backdrop-blur-xl ring-1 ring-primary/5">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-stretch">
                    <MonthSelectorCard title={t('monthlyComparison.monthA', 'Month A')} accent={LEFT_ACCENT} value={leftMonth} options={monthOptions} otherValue={rightMonth} onChange={setLeftMonth} meta={`${leftSnapshot.option.hasSales ? 'Sales' : 'No sales'} • ${leftSnapshot.option.hasExpenses ? 'Expenses' : 'No expenses'} • ${leftSnapshot.option.hasAllocation ? 'Budget set' : 'Budget not set'}`} />
                    <div className="flex items-center justify-center">
                        <Button type="button" variant="outline" size="icon" onClick={() => { setLeftMonth(rightMonth); setRightMonth(leftMonth) }} className="h-12 w-12 rounded-2xl border-border/50 hover:rotate-180 transition-all duration-500" title="Swap months">
                            <Activity className="h-4 w-4" />
                        </Button>
                    </div>
                    <MonthSelectorCard title={t('monthlyComparison.monthB', 'Month B')} accent={RIGHT_ACCENT} value={rightMonth} options={monthOptions} otherValue={leftMonth} onChange={setRightMonth} meta={`${rightSnapshot.option.hasSales ? 'Sales' : 'No sales'} • ${rightSnapshot.option.hasExpenses ? 'Expenses' : 'No expenses'} • ${rightSnapshot.option.hasAllocation ? 'Budget set' : 'Budget not set'}`} />
                    <div className="grid gap-3 md:grid-cols-3 xl:w-[420px]">
                        <Button type="button" variant="outline" onClick={() => { if (defaultSelection.left && defaultSelection.right) { setLeftMonth(defaultSelection.left); setRightMonth(defaultSelection.right) } }} className="h-full min-h-12 rounded-[1.5rem] border-border/50 text-xs font-black uppercase tracking-[0.16em] hover:bg-primary/5 transition-colors">
                            {t('monthlyComparison.currentVsPrevious', 'Current vs Previous')}
                        </Button>
                        <Button type="button" variant="outline" disabled={!yearAgoMonth || !monthOptions[0]} onClick={() => { if (yearAgoMonth && monthOptions[0]) { setLeftMonth(yearAgoMonth); setRightMonth(monthOptions[0].value) } }} className="h-full min-h-12 rounded-[1.5rem] border-border/50 text-xs font-black uppercase tracking-[0.16em] hover:bg-primary/5 transition-colors">
                            {t('monthlyComparison.sameMonthLastYear', 'Same Month Last Year')}
                        </Button>
                        <Button type="button" variant="ghost" disabled={leftMonth === defaultSelection.left && rightMonth === defaultSelection.right} onClick={() => { if (defaultSelection.left && defaultSelection.right) { setLeftMonth(defaultSelection.left); setRightMonth(defaultSelection.right) } }} className="h-full min-h-12 rounded-[1.5rem] text-xs font-black uppercase tracking-[0.16em]">
                            {t('monthlyComparison.reset', 'Reset')}
                        </Button>
                    </div>
                </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                {deltaCards.map(({ key, ...card }) => (
                    <ComparisonDeltaCard key={key} {...card} baseCurrency={baseCurrency} iqdPreference={iqdPreference} leftLabel={leftSnapshot.option.label} rightLabel={rightSnapshot.option.label} />
                ))}
            </div>

            {/* ── Month Summaries ── */}
            <div className="space-y-4">
                <div className="flex items-center gap-3 px-1">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground/60">Month Summaries</span>
                    <div className="h-px flex-1 bg-border/60" />
                </div>
                <div className="grid gap-6 xl:grid-cols-2">
                    <MonthSummaryPanel snapshot={leftSnapshot} accent={LEFT_ACCENT} baseCurrency={baseCurrency} iqdPreference={iqdPreference} isCurrent={leftSnapshot.option.value === currentMonthKey} />
                    <MonthSummaryPanel snapshot={rightSnapshot} accent={RIGHT_ACCENT} baseCurrency={baseCurrency} iqdPreference={iqdPreference} isCurrent={rightSnapshot.option.value === currentMonthKey} />
                </div>
            </div>

            <ComparisonInsightsStrip insights={insights} />

            {/* ── Charts & Analytics ── */}
            <div className="space-y-4">
                <div className="flex items-center gap-3 px-1">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground/60">Charts & Analytics</span>
                    <div className="h-px flex-1 bg-border/60" />
                </div>
                <div className="grid gap-6 xl:grid-cols-3">
                    <MonthPaceComparisonChart left={leftSnapshot} right={rightSnapshot} metric={paceMetric} onMetricChange={setPaceMetric} baseCurrency={baseCurrency} iqdPreference={iqdPreference} />
                    <CategoryComparisonChart title="Revenue Categories" summary={getChartSummaryLabel(revenueCategoryData, rightSnapshot.option.label, leftSnapshot.option.label)} data={revenueCategoryData} baseCurrency={baseCurrency} iqdPreference={iqdPreference} />
                    <CategoryComparisonChart title="Expense Categories" summary={expenseCategoryData.length === 0 ? 'No expense data' : getChartSummaryLabel(expenseCategoryData, rightSnapshot.option.label, leftSnapshot.option.label)} data={expenseCategoryData} baseCurrency={baseCurrency} iqdPreference={iqdPreference} />
                </div>
            </div>

            {/* ── Details & Breakdown ── */}
            <div className="space-y-4">
                <div className="flex items-center gap-3 px-1">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="text-[10px] font-black uppercase tracking-[0.25em] text-muted-foreground/60">Details & Breakdown</span>
                    <div className="h-px flex-1 bg-border/60" />
                </div>
                <div className="grid gap-6 xl:grid-cols-3">
                    <TopProductsComparisonCard rows={topProductRows} baseCurrency={baseCurrency} iqdPreference={iqdPreference} leftLabel={leftSnapshot.option.label} rightLabel={rightSnapshot.option.label} />
                    <ReturnsComparisonCard left={leftSnapshot} right={rightSnapshot} baseCurrency={baseCurrency} iqdPreference={iqdPreference} />
                    <PeakActivityComparisonCard left={leftSnapshot} right={rightSnapshot} peakView={peakView} onPeakViewChange={setPeakView} />
                </div>
            </div>

            <ProfitBridgeComparisonCard left={leftSnapshot} right={rightSnapshot} baseCurrency={baseCurrency} iqdPreference={iqdPreference} />
        </div>
    )
}
