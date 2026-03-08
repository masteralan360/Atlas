import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { Sale, SaleItem } from '@/types'
import { useSales, toUISale } from '@/local-db'
import { formatCurrency, formatDateTime, formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { isMobile } from '@/lib/platform'
import { useWorkspace } from '@/workspace'
import { useDateRange } from '@/context/DateRangeContext'
import { DateRangeFilters } from '@/ui/components/DateRangeFilters'
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipTrigger,
    TooltipContent,
    TooltipProvider,
    SaleDetailsModal,
    MetricDetailModal,
    TopProductsModal,
    SalesOverviewModal,
    PeakTradingModal,
    ReturnsAnalysisModal,
    PrintPreviewModal,
    AppPagination
} from '@/ui/components'
import { MiniHeatmap } from '@/ui/components/revenue/MiniHeatmap'
import type { MetricType } from '@/ui/components/MetricDetailModal'
import {
    Check,
    Square,
    X,
    FileSpreadsheet,
    TrendingDown,
    DollarSign,
    TrendingUp,
    Package,
    Percent,
    BarChart3,
    Clock,
    ArrowRight,
    RotateCcw,
    Printer,
    Info,
    Grid3X3,
    LayoutGrid,
    List
} from 'lucide-react'
import { useTheme } from '@/ui/components/theme-provider'
import { Button, ExportPreviewModal, Progress } from '@/ui/components'
import { Area, AreaChart, Bar, BarChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis } from 'recharts'

export function Revenue() {
    const { user } = useAuth()
    const { t, i18n } = useTranslation()
    const { features } = useWorkspace()
    const rawSales = useSales(user?.workspaceId)
    const allSales = useMemo<Sale[]>(() => rawSales.map(toUISale), [rawSales])
    const [selectedSale, setSelectedSale] = useState<Sale | null>(null)
    const [selectedMetric, setSelectedMetric] = useState<MetricType | null>(null)
    const [isMetricModalOpen, setIsMetricModalOpen] = useState(false)
    const [isTopProductsOpen, setIsTopProductsOpen] = useState(false)
    const [isSalesOverviewOpen, setIsSalesOverviewOpen] = useState(false)
    const [isPeakTradingOpen, setIsPeakTradingOpen] = useState(false)
    const [isReturnsOpen, setIsReturnsOpen] = useState(false)
    const { dateRange, customDates } = useDateRange()
    const { style } = useTheme()
    const [showPrintPreview, setShowPrintPreview] = useState(false)
    const [selectedSaleIds, setSelectedSaleIds] = useState<Set<string>>(new Set())
    const [showPeakHeatmap, setShowPeakHeatmap] = useState(false)

    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('revenue_view_mode') as 'table' | 'grid') || 'table'
    })

    useEffect(() => {
        localStorage.setItem('revenue_view_mode', viewMode)
    }, [viewMode])

    const [isExportModalOpen, setIsExportModalOpen] = useState(false)
    const [currentPage, setCurrentPage] = useState(1)
    const itemsPerPage = 25
    const listRef = useRef<HTMLDivElement>(null)

    const sales = useMemo(() => {
        let result = allSales
        const now = new Date()

        if (dateRange === 'today') {
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
            result = result.filter(s => new Date(s.created_at) >= startOfDay)
        } else if (dateRange === 'month') {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
            result = result.filter(s => new Date(s.created_at) >= startOfMonth)
        } else if (dateRange === 'custom' && customDates.start && customDates.end) {
            const start = new Date(customDates.start)
            start.setHours(0, 0, 0, 0)
            const end = new Date(customDates.end)
            end.setHours(23, 59, 59, 999)
            result = result.filter(s => {
                const d = new Date(s.created_at)
                return d >= start && d <= end
            })
        }

        return [...result].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    }, [allSales, dateRange, customDates])

    // Clear selection when date filters change
    useEffect(() => {
        setSelectedSaleIds(new Set())
        setCurrentPage(1)
    }, [dateRange, customDates])


    const getDateDisplay = () => {
        if (dateRange === 'today') {
            return formatDate(new Date())
        }
        if (dateRange === 'month') {
            const now = new Date()
            return formatLocalizedMonthYear(now, i18n.language)
        }
        if (dateRange === 'custom') {
            if (sales && sales.length > 0) {
                // Find oldest and newest sale strictly from the current dataset
                const dates = sales.map(s => new Date(s.created_at).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }
            if (customDates.start && customDates.end) {
                return `${t('performance.filters.from')} ${formatDate(customDates.start)} ${t('performance.filters.to')} ${formatDate(customDates.end)}`
            }
        }
        if (dateRange === 'allTime') {
            if (sales && sales.length > 0) {
                const dates = sales.map(s => new Date(s.created_at).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.allTime')}, ${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }
            return t('performance.filters.allTime') || 'All Time'
        }
        return ''
    }

    const handleOpenPrintPreview = () => {
        setShowPrintPreview(true)
    }

    const openMetricModal = (type: MetricType) => {
        setSelectedMetric(type)
        setIsMetricModalOpen(true)
    }

    const trendStats = useMemo(() => {
        const calcTrend = (current: number, previous: number) => {
            if (previous === 0) return current > 0 ? 100 : 0
            return ((current - previous) / previous) * 100
        }

        const now = new Date()
        const currentStart = new Date(now)
        currentStart.setDate(currentStart.getDate() - 7)
        const previousStart = new Date(currentStart)
        previousStart.setDate(previousStart.getDate() - 7)

        let currentRevenue = 0
        let currentCost = 0
        let previousRevenue = 0
        let previousCost = 0

        allSales.forEach((sale) => {
            if (sale.is_returned) return
            const saleDate = new Date(sale.created_at)
            if (saleDate < previousStart || saleDate > now) return

            let saleRevenue = 0
            let saleCost = 0
            sale.items?.forEach((item: SaleItem) => {
                const netQty = item.quantity - (item.returned_quantity || 0)
                if (netQty <= 0) return
                saleRevenue += item.converted_unit_price * netQty
                saleCost += (item.converted_cost_price || 0) * netQty
            })

            if (saleDate >= currentStart) {
                currentRevenue += saleRevenue
                currentCost += saleCost
            } else {
                previousRevenue += saleRevenue
                previousCost += saleCost
            }
        })

        return {
            revenue: calcTrend(currentRevenue, previousRevenue),
            cost: calcTrend(currentCost, previousCost),
            profit: calcTrend(currentRevenue - currentCost, previousRevenue - previousCost),
            margin: 0
        }
    }, [allSales])

    const calculateStats = (salesData: Sale[], defaultCurrency: string) => {
        const statsByCurrency: Record<string, {
            revenue: number,
            cost: number,
            salesCount: number,
            dailyTrend: Record<string, { revenue: number, cost: number, profit: number }>,
            categoryRevenue: Record<string, number>,
            productPerformance: Record<string, { name: string, revenue: number, cost: number, quantity: number }>,
            hourlySales: Record<number, number>
        }> = {}
        const saleStats: {
            id: string,
            date: string,
            revenue: number,
            cost: number,
            profit: number,
            margin: number,
            currency: string,
            origin: string,
            cashier: string,
            sequenceId?: number,
            hasPartialReturn?: boolean
        }[] = []

        salesData.forEach(sale => {
            if (sale.is_returned) return

            const currency = sale.settlement_currency || defaultCurrency
            if (!statsByCurrency[currency]) {
                statsByCurrency[currency] = {
                    revenue: 0,
                    cost: 0,
                    salesCount: 0,
                    dailyTrend: {},
                    categoryRevenue: {},
                    productPerformance: {},
                    hourlySales: {}
                }
            }
            statsByCurrency[currency].salesCount++

            let saleRevenue = 0
            let saleCost = 0
            const date = new Date(sale.created_at).toISOString().split('T')[0]

            if (!statsByCurrency[currency].dailyTrend[date]) {
                statsByCurrency[currency].dailyTrend[date] = { revenue: 0, cost: 0, profit: 0 }
            }

            sale.items?.forEach((item: SaleItem) => {
                const netQuantity = item.quantity - (item.returned_quantity || 0)
                if (netQuantity <= 0) return

                const itemRevenue = item.converted_unit_price * netQuantity
                const itemCost = (item.converted_cost_price || 0) * netQuantity

                saleRevenue += itemRevenue
                saleCost += itemCost

                // Category tracking
                const cat = item.product_category || 'Uncategorized'
                statsByCurrency[currency].categoryRevenue[cat] = (statsByCurrency[currency].categoryRevenue[cat] || 0) + itemRevenue

                // Product performance tracking
                const prodId = item.product_id
                if (!statsByCurrency[currency].productPerformance[prodId]) {
                    statsByCurrency[currency].productPerformance[prodId] = {
                        name: item.product_name || 'Unknown Product',
                        revenue: 0,
                        cost: 0,
                        quantity: 0
                    }
                }
                statsByCurrency[currency].productPerformance[prodId].revenue += itemRevenue
                statsByCurrency[currency].productPerformance[prodId].cost += itemCost
                statsByCurrency[currency].productPerformance[prodId].quantity += netQuantity
            })

            // Hourly tracking
            const hour = new Date(sale.created_at).getHours()
            statsByCurrency[currency].hourlySales[hour] = (statsByCurrency[currency].hourlySales[hour] || 0) + saleRevenue

            statsByCurrency[currency].revenue += saleRevenue
            statsByCurrency[currency].cost += saleCost
            statsByCurrency[currency].dailyTrend[date].revenue += saleRevenue
            statsByCurrency[currency].dailyTrend[date].cost += saleCost
            statsByCurrency[currency].dailyTrend[date].profit += (saleRevenue - saleCost)

            saleStats.push({
                id: sale.id,
                date: sale.created_at,
                revenue: saleRevenue,
                cost: saleCost,
                profit: saleRevenue - saleCost,
                margin: saleRevenue > 0 ? ((saleRevenue - saleCost) / saleRevenue) * 100 : 0,
                currency: currency,
                origin: sale.origin,
                cashier: sale.cashier_name || 'Staff',
                sequenceId: sale.sequenceId,
                hasPartialReturn: sale.has_partial_return
            })
        })

        return {
            statsByCurrency,
            saleStats
        }
    }

    const stats = useMemo(() => {
        if (!sales) return { statsByCurrency: {}, saleStats: [] }
        const { statsByCurrency, saleStats } = calculateStats(sales, features.default_currency || 'usd')
        return { statsByCurrency, saleStats }
    }, [sales, features.default_currency])

    const currencySettings = useMemo(() => ({
        currency: Object.keys(stats.statsByCurrency)[0] || features.default_currency || 'usd',
        iqdPreference: features.iqd_display_preference
    }), [stats.statsByCurrency, features.default_currency, features.iqd_display_preference])

    const primaryStats = useMemo(() => stats.statsByCurrency[currencySettings.currency] || {
        revenue: 0,
        cost: 0,
        salesCount: 0,
        dailyTrend: {},
        categoryRevenue: {},
        productPerformance: {}
    }, [stats.statsByCurrency, currencySettings.currency])

    const trendData = useMemo(() => {
        const dailyTrend = primaryStats.dailyTrend || {}
        return Object.entries(dailyTrend)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, values]) => ({
                date,
                revenue: values.revenue,
                cost: values.cost,
                profit: values.profit
            }))
    }, [primaryStats.dailyTrend])

    const topProductsData = useMemo(() => {
        const perf = primaryStats.productPerformance || {}
        const totalRevenue = primaryStats.revenue || 1
        return Object.values(perf)
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 3)
            .map(p => ({
                name: p.name,
                revenue: p.revenue,
                percentage: Math.min((p.revenue / totalRevenue) * 100, 100)
            }))
    }, [primaryStats.productPerformance, primaryStats.revenue])

    const peakTradingData = useMemo(() => {
        const hourly = primaryStats.hourlySales || {}
        const hours = [12, 17, 20, 22] // Example hours mapping to 12 PM, 05 PM, 08 PM, 10 PM
        const maxSales = Math.max(...Object.values(hourly), 1)

        const hourFormatter = new Intl.DateTimeFormat(i18n.language, {
            hour: 'numeric',
            hour12: true
        })

        return hours.map(h => {
            const date = new Date()
            date.setHours(h, 0, 0, 0)
            return {
                hour: hourFormatter.format(date),
                value: ((hourly[h] || 0) / maxSales) * 100
            }
        })
    }, [primaryStats.hourlySales, i18n.language])

    const SparklineArea = ({ data, dataKey, color }: { data: any[], dataKey: string, color: string }) => (
        <div className="h-12 w-full mt-4 -mx-2">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data}>
                    <defs>
                        <linearGradient id={`gradient-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <Area
                        type="monotone"
                        dataKey={dataKey}
                        stroke={color}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill={`url(#gradient-${dataKey})`}
                        isAnimationActive={true}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    )

    // Calculate aggregated stats for selected sales (grouped by currency)
    const selectionSummary = useMemo(() => {
        if (selectedSaleIds.size === 0) return null

        const summaryByCurrency: Record<string, { revenue: number; cost: number; profit: number }> = {}

        stats.saleStats.forEach(sale => {
            if (selectedSaleIds.has(sale.id)) {
                const currency = sale.currency || 'usd'
                if (!summaryByCurrency[currency]) {
                    summaryByCurrency[currency] = { revenue: 0, cost: 0, profit: 0 }
                }
                summaryByCurrency[currency].revenue += sale.revenue
                summaryByCurrency[currency].cost += sale.cost
                summaryByCurrency[currency].profit += sale.profit
            }
        })

        return {
            count: selectedSaleIds.size,
            byCurrency: summaryByCurrency
        }
    }, [selectedSaleIds, stats.saleStats])

    // Selection toggle handlers
    const toggleSaleSelection = (saleId: string) => {
        setSelectedSaleIds(prev => {
            const newSet = new Set(prev)
            if (newSet.has(saleId)) {
                newSet.delete(saleId)
            } else {
                newSet.add(saleId)
            }
            return newSet
        })
    }

    const toggleSelectAll = () => {
        if (selectedSaleIds.size === stats.saleStats.length) {
            setSelectedSaleIds(new Set())
        } else {
            setSelectedSaleIds(new Set(stats.saleStats.map(s => s.id)))
        }
    }

    const clearSelection = () => {
        setSelectedSaleIds(new Set())
    }

    const paginatedSales = useMemo(() => {
        const startIndex = (currentPage - 1) * itemsPerPage
        return stats.saleStats.slice(startIndex, startIndex + itemsPerPage)
    }, [stats.saleStats, currentPage])
    const salesById = useMemo(() => new Map(sales.map(s => [s.id, s])), [sales])

    return (
        <TooltipProvider>
            <div className="space-y-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-3">
                            <h1 className="text-3xl font-bold tracking-tight">{t('revenue.title')}</h1>
                            {getDateDisplay() && (
                                <div className={cn(
                                    "px-3 py-1 text-sm font-bold bg-primary text-primary-foreground shadow-sm animate-pop-in",
                                    style === 'neo-orange' ? "rounded-[var(--radius)] neo-border" : "rounded-lg"
                                )}>
                                    {getDateDisplay()}
                                </div>
                            )}
                        </div>
                        <p className="text-muted-foreground">{t('revenue.subtitle')}</p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        <div className="hidden md:flex items-center bg-background/30 p-1 rounded-xl border border-border/50 backdrop-blur-md">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setViewMode('table')}
                                className={cn(
                                    "h-8 px-4 font-black uppercase tracking-widest text-[10px] flex items-center gap-2 transition-all",
                                    viewMode === 'table'
                                        ? "bg-primary text-primary-foreground shadow-lg"
                                        : "text-muted-foreground hover:bg-background/50"
                                )}
                            >
                                <List className="w-3.5 h-3.5" />
                                {t('sales.view.table')}
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setViewMode('grid')}
                                className={cn(
                                    "h-8 px-4 font-black uppercase tracking-widest text-[10px] flex items-center gap-2 transition-all",
                                    viewMode === 'grid'
                                        ? "bg-primary text-primary-foreground shadow-lg"
                                        : "text-muted-foreground hover:bg-background/50"
                                )}
                            >
                                <LayoutGrid className="w-3.5 h-3.5" />
                                {t('sales.view.grid')}
                            </Button>
                        </div>
                        <DateRangeFilters />
                    </div>
                </div>

                <div className="space-y-6">

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        {/* Gross Revenue */}
                        <Card
                            className="bg-card dark:bg-card border-border/50 shadow-sm cursor-pointer hover:shadow-md transition-all group relative overflow-hidden rounded-3xl"
                            onClick={() => openMetricModal('grossRevenue')}
                        >
                            <CardHeader className="pb-2">
                                <div className="flex justify-between items-start">
                                    <CardTitle className="text-[10px] font-black text-blue-500 flex items-center gap-2 uppercase tracking-[0.2em]">
                                        <div className="p-1.5 bg-blue-500/10 rounded-lg">
                                            <DollarSign className="w-3.5 h-3.5" />
                                        </div>
                                        {t('revenue.grossRevenue')}
                                    </CardTitle>
                                    <div className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 text-[10px] font-bold flex items-center gap-1">
                                        {trendStats.revenue > 0 ? '+' : ''}{trendStats.revenue.toFixed(1)}%
                                        {trendStats.revenue >= 0 ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="pb-0">
                                <div className="space-y-1">
                                    {Object.entries(stats.statsByCurrency).map(([curr, s]) => (
                                        <div key={curr} className="text-2xl font-black tracking-tight tabular-nums text-foreground leading-none">
                                            {formatCurrency(s.revenue, curr as any, currencySettings.iqdPreference)}
                                        </div>
                                    ))}
                                </div>
                                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-1">
                                    {Object.values(stats.statsByCurrency).reduce((acc, s) => acc + s.salesCount, 0)} {t('pos.totalItems')}
                                </p>
                                <SparklineArea data={trendData} dataKey="revenue" color="#3b82f6" />
                            </CardContent>
                        </Card>

                        {/* Total Cost */}
                        <Card
                            className="bg-card dark:bg-card border-border/50 shadow-sm cursor-pointer hover:shadow-md transition-all group relative overflow-hidden rounded-3xl"
                            onClick={() => openMetricModal('totalCost')}
                        >
                            <CardHeader className="pb-2">
                                <div className="flex justify-between items-start">
                                    <CardTitle className="text-[10px] font-black text-orange-500 flex items-center gap-2 uppercase tracking-[0.2em]">
                                        <div className="p-1.5 bg-orange-500/10 rounded-lg">
                                            <Package className="w-3.5 h-3.5" />
                                        </div>
                                        {t('revenue.totalCost')} (COGS)
                                    </CardTitle>
                                    <div className={cn(
                                        "px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1",
                                        trendStats.cost <= 0 ? "bg-emerald-500/10 text-emerald-500" : "bg-orange-500/10 text-orange-500"
                                    )}>
                                        {trendStats.cost > 0 ? '+' : ''}{trendStats.cost.toFixed(1)}%
                                        {trendStats.cost <= 0 ? <TrendingDown className="w-2.5 h-2.5" /> : <TrendingUp className="w-2.5 h-2.5" />}
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="pb-0">
                                <div className="space-y-1">
                                    {Object.entries(stats.statsByCurrency).map(([curr, s]) => (
                                        <div key={curr} className="text-2xl font-black tracking-tight tabular-nums text-foreground leading-none">
                                            {formatCurrency(s.cost, curr as any, currencySettings.iqdPreference)}
                                        </div>
                                    ))}
                                </div>
                                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-1">
                                    {((Object.values(stats.statsByCurrency).reduce((acc, s) => acc + s.cost, 0) / (Object.values(stats.statsByCurrency).reduce((acc, s) => acc + s.revenue, 0) || 1)) * 100).toFixed(1)}% {t('revenue.table.cost')} Ratio
                                </p>
                                <SparklineArea data={trendData} dataKey="cost" color="#f97316" />
                            </CardContent>
                        </Card>

                        {/* Net Profit */}
                        <Card
                            className="bg-card dark:bg-card border-border/50 shadow-sm cursor-pointer hover:shadow-md transition-all group relative overflow-hidden rounded-3xl"
                            onClick={() => openMetricModal('netProfit')}
                        >
                            <CardHeader className="pb-2">
                                <div className="flex justify-between items-start">
                                    <CardTitle className="text-[10px] font-black text-emerald-500 flex items-center gap-2 uppercase tracking-[0.2em]">
                                        <div className="p-1.5 bg-emerald-500/10 rounded-lg">
                                            <TrendingUp className="w-3.5 h-3.5" />
                                        </div>
                                        {t('revenue.netProfit')}
                                    </CardTitle>
                                    <div className={cn(
                                        "px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1",
                                        trendStats.profit >= 0 ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"
                                    )}>
                                        {trendStats.profit > 0 ? '+' : ''}{trendStats.profit.toFixed(1)}%
                                        {trendStats.profit >= 0 ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="pb-0">
                                <div className="space-y-1">
                                    {Object.entries(stats.statsByCurrency).map(([curr, s]) => (
                                        <div key={curr} className="text-2xl font-black tracking-tight tabular-nums text-foreground leading-none">
                                            {formatCurrency(s.revenue - s.cost, curr as any, currencySettings.iqdPreference)}
                                        </div>
                                    ))}
                                </div>
                                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mt-1">
                                    {t('revenue.detailedAnalysis')}
                                </p>
                                <SparklineArea data={trendData} dataKey="profit" color="#10b981" />
                            </CardContent>
                        </Card>

                        {/* Profit Margin */}
                        <Card
                            className="bg-card dark:bg-card border-border/50 shadow-sm cursor-pointer hover:shadow-md transition-all group relative overflow-hidden rounded-3xl"
                            onClick={() => openMetricModal('profitMargin')}
                        >
                            <CardHeader className="pb-2">
                                <CardTitle className="text-[10px] font-black text-purple-600 flex items-center gap-2 uppercase tracking-[0.2em]">
                                    <div className="p-1.5 bg-purple-500/10 rounded-lg text-purple-500">
                                        <Percent className="w-3.5 h-3.5" />
                                    </div>
                                    {t('revenue.profitMargin')}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="text-3xl font-black tracking-tighter tabular-nums text-foreground">
                                    {((primaryStats.revenue - primaryStats.cost) / (primaryStats.revenue || 1) * 100).toFixed(1)}%
                                </div>
                                <div className="space-y-2 mt-4">
                                    <Progress
                                        value={Math.min(((primaryStats.revenue - primaryStats.cost) / (primaryStats.revenue || 1)) * 100, 100)}
                                        className="h-2 bg-purple-500/10"
                                        indicatorClassName="bg-gradient-to-r from-purple-500 to-pink-500"
                                    />
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Preview Section - Charts & Highlights */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        {/* Top Products */}
                        <Card className="rounded-[2.5rem] border-border/40 shadow-sm bg-card overflow-hidden">
                            <CardHeader className="pb-4">
                                <div className="flex justify-between items-center">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 bg-emerald-500/10 rounded-xl text-emerald-500">
                                            <Package className="w-5 h-5" />
                                        </div>
                                        <CardTitle className="text-sm font-black uppercase tracking-widest text-foreground">
                                            Top Products
                                        </CardTitle>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-primary font-bold text-xs hover:bg-primary/5 rounded-full"
                                        onClick={() => setIsTopProductsOpen(true)}
                                    >
                                        View All
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-6 pt-2">
                                {topProductsData.length > 0 ? topProductsData.map((prod, i) => (
                                    <div key={i} className="space-y-2 group">
                                        <div className="flex justify-between items-end">
                                            <div className="flex items-center justify-between w-full">
                                                <div className="text-[11px] font-black text-foreground uppercase tracking-wider">
                                                    {prod.name}
                                                </div>
                                                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                                                    {formatCurrency(prod.revenue, currencySettings.currency as any, currencySettings.iqdPreference)}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <div className="text-xs font-black text-foreground">
                                                {prod.percentage.toFixed(0)}%
                                            </div>
                                            <Button
                                                variant="link"
                                                className="h-auto p-0 text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-primary transition-colors"
                                                onClick={() => setIsTopProductsOpen(true)}
                                            >
                                                {t('common.viewAll') || 'View All'}
                                            </Button>
                                        </div>
                                        <Progress
                                            value={prod.percentage}
                                            className="h-1.5 bg-muted/50"
                                            indicatorClassName={cn(
                                                "rounded-full transition-all duration-1000",
                                                i === 0 ? "bg-blue-500" : i === 1 ? "bg-emerald-500" : "bg-orange-500"
                                            )}
                                        />
                                    </div>
                                )) : (
                                    <div className="h-40 flex flex-col items-center justify-center text-muted-foreground/50 border-2 border-dashed border-border/50 rounded-3xl">
                                        <Package className="w-8 h-8 mb-2 opacity-20" />
                                        <p className="text-xs font-bold uppercase tracking-widest">No Data Available</p>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Sales Overview */}
                        <Card className="rounded-[2.5rem] border-border/40 shadow-sm bg-card overflow-hidden">
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 bg-blue-500/10 rounded-xl text-blue-500">
                                            <BarChart3 className="w-5 h-5" />
                                        </div>
                                        <CardTitle className="text-sm font-black uppercase tracking-widest text-foreground">
                                            {t('revenue.salesOverview') || 'Sales Overview'}
                                        </CardTitle>
                                    </div>
                                    <div className="flex items-center gap-3 text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-muted-foreground mr-2">
                                        <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-emerald-500" />{t('revenue.table.profit') || 'Profit'}</div>
                                        <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-orange-500" />{t('revenue.table.cost') || 'Cost'}</div>
                                        <div className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-blue-500" />{t('revenue.table.revenue') || 'Revenue'}</div>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="h-56 w-full -ml-4">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={trendData.slice(-7)}>
                                            <XAxis
                                                dataKey="date"
                                                axisLine={false}
                                                tickLine={false}
                                                tick={{ fill: '#888888', fontSize: 10, fontWeight: 700 }}
                                                tickFormatter={(str) => {
                                                    const date = new Date(str)
                                                    return date.toLocaleDateString(i18n.language, { weekday: 'short' }).toUpperCase()
                                                }}
                                            />
                                            <RechartsTooltip
                                                cursor={{ fill: 'rgba(59, 130, 246, 0.05)', radius: 8 }}
                                                content={({ active, payload }) => {
                                                    if (active && payload && payload.length) {
                                                        return (
                                                            <div className="bg-background/95 backdrop-blur-sm border border-border shadow-xl p-3 rounded-2xl">
                                                                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-1.5 flex justify-center">
                                                                    {payload[0].payload.date}
                                                                </p>
                                                                <div className="space-y-0.5 flex flex-col items-center">
                                                                    <p className="text-sm font-black text-blue-500">
                                                                        {formatCurrency(payload[0].payload.revenue as number, currencySettings.currency as any, currencySettings.iqdPreference)}
                                                                    </p>
                                                                    <p className="text-sm font-black text-orange-500">
                                                                        {formatCurrency(payload[0].payload.cost as number, currencySettings.currency as any, currencySettings.iqdPreference)}
                                                                    </p>
                                                                    <p className="text-sm font-black text-emerald-500">
                                                                        {formatCurrency(payload[0].payload.profit as number, currencySettings.currency as any, currencySettings.iqdPreference)}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        )
                                                    }
                                                    return null
                                                }}
                                            />
                                            <Bar dataKey="revenue" stackId="stack" fill="#3b82f6" radius={[4, 4, 4, 4]} stroke="hsl(var(--card))" strokeWidth={2} maxBarSize={24} />
                                            <Bar dataKey="cost" stackId="stack" fill="#f97316" radius={[4, 4, 4, 4]} stroke="hsl(var(--card))" strokeWidth={2} maxBarSize={24} />
                                            <Bar dataKey="profit" stackId="stack" fill="#10b981" radius={[4, 4, 4, 4]} stroke="hsl(var(--card))" strokeWidth={2} maxBarSize={24} />
                                        </BarChart>
                                    </ResponsiveContainer>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Peak Times */}
                        <Card className="rounded-[2.5rem] border-border/40 shadow-sm bg-card overflow-hidden">
                            <CardHeader className="pb-4">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 bg-purple-500/10 rounded-xl text-purple-500">
                                            {showPeakHeatmap ? <Grid3X3 className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
                                        </div>
                                        <CardTitle className="text-sm font-black uppercase tracking-widest text-foreground">
                                            {t('revenue.peakTradingTimes') || 'Peak Times'}
                                        </CardTitle>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 rounded-full hover:bg-purple-500/10 text-muted-foreground hover:text-purple-500 transition-colors"
                                        onClick={() => setShowPeakHeatmap(!showPeakHeatmap)}
                                        title={showPeakHeatmap ? t('revenue.showHourlyBars') || "Show Hourly Bars" : t('revenue.showWeeklyHeatmap') || "Show Weekly Heatmap"}
                                    >
                                        {showPeakHeatmap ? <BarChart3 className="w-4 h-4" /> : <Grid3X3 className="w-4 h-4" />}
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-6 pt-2">
                                {showPeakHeatmap ? (
                                    <MiniHeatmap sales={sales} />
                                ) : (
                                    <>
                                        {peakTradingData.map((peak, i) => (
                                            <div key={i} className="space-y-2">
                                                <div className="flex items-center gap-4">
                                                    <div className="text-[11px] font-black text-muted-foreground w-12 tabular-nums">
                                                        {peak.hour}
                                                    </div>
                                                    <div className="flex-1">
                                                        <Progress
                                                            value={peak.value}
                                                            className="h-2.5 bg-muted/50"
                                                            indicatorClassName="bg-purple-500 rounded-full"
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                        <div className="pt-4 border-t border-border/50">
                                            <div className="text-center text-xs font-bold text-muted-foreground">
                                                {t('revenue.busiestHour') || 'Busiest hour'}: <span className="text-purple-500 font-black">
                                                    {peakTradingData.length > 0 ? (
                                                        (() => {
                                                            const hour = parseInt(peakTradingData[0].hour.match(/\d+/)![0])
                                                            const isPM = peakTradingData[0].hour.toLowerCase().includes('pm')
                                                            const startH = isPM && hour !== 12 ? hour + 12 : (!isPM && hour === 12 ? 0 : hour)

                                                            const formatter = new Intl.DateTimeFormat(i18n.language, {
                                                                hour: 'numeric',
                                                                minute: 'numeric',
                                                                hour12: true
                                                            })

                                                            const startDate = new Date()
                                                            startDate.setHours(startH, 0, 0, 0)
                                                            const endDate = new Date()
                                                            endDate.setHours(startH + 1, 0, 0, 0)

                                                            return `${formatter.format(startDate)} - ${formatter.format(endDate)}`
                                                        })()
                                                    ) : '--:--'}
                                                </span>
                                            </div>
                                        </div>
                                    </>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    {/* Analytics Quick Actions */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        {/* Top Products */}
                        <Card
                            className="bg-emerald-500/5 dark:bg-emerald-500/10 border-emerald-500/20 cursor-pointer hover:scale-[1.02] transition-all hover:bg-emerald-500/10 hover:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] active:scale-95 group relative overflow-hidden rounded-3xl"
                            onClick={() => setIsTopProductsOpen(true)}
                        >
                            <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                <ArrowRight className="w-4 h-4 text-emerald-500" />
                            </div>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-black text-emerald-600 dark:text-emerald-400 flex items-center gap-2 uppercase tracking-widest">
                                    <Package className="w-4 h-4" />
                                    {t('revenue.topProducts') || 'Top Products'}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-xs text-muted-foreground font-medium">
                                    {t('revenue.topProductsDesc') || 'Best sellers by revenue, quantity, or cost'}
                                </p>
                            </CardContent>
                        </Card>

                        {/* Sales Overview */}
                        <Card
                            className="bg-blue-500/5 dark:bg-blue-500/10 border-blue-500/20 cursor-pointer hover:scale-[1.02] transition-all hover:bg-blue-500/10 hover:shadow-[0_0_20px_-5px_rgba(59,130,246,0.3)] active:scale-95 group relative overflow-hidden rounded-3xl"
                            onClick={() => setIsSalesOverviewOpen(true)}
                        >
                            <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                <ArrowRight className="w-4 h-4 text-blue-500" />
                            </div>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-black text-blue-600 dark:text-blue-400 flex items-center gap-2 uppercase tracking-widest">
                                    <BarChart3 className="w-4 h-4" />
                                    {t('revenue.salesOverview') || 'Sales Overview'}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-xs text-muted-foreground font-medium">
                                    {t('revenue.salesOverviewDesc') || 'Revenue, cost & profit combined'}
                                </p>
                            </CardContent>
                        </Card>

                        {/* Peak Times */}
                        <Card
                            className="bg-violet-500/5 dark:bg-violet-500/10 border-violet-500/20 cursor-pointer hover:scale-[1.02] transition-all hover:bg-violet-500/10 hover:shadow-[0_0_20px_-5px_rgba(139,92,246,0.3)] active:scale-95 group relative overflow-hidden rounded-3xl"
                            onClick={() => setIsPeakTradingOpen(true)}
                        >
                            <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                <ArrowRight className="w-4 h-4 text-violet-500" />
                            </div>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-black text-violet-600 dark:text-violet-400 flex items-center gap-2 uppercase tracking-widest">
                                    <Clock className="w-4 h-4" />
                                    {t('revenue.peakTimes') || 'Peak Times'}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-xs text-muted-foreground font-medium">
                                    {t('revenue.peakTimesDesc') || 'Busiest hours of the day'}
                                </p>
                            </CardContent>
                        </Card>

                        {/* Returns */}
                        <Card
                            className="bg-red-500/5 dark:bg-red-500/10 border-red-500/20 cursor-pointer hover:scale-[1.02] transition-all hover:bg-red-500/10 hover:shadow-[0_0_20px_-5px_rgba(239,68,68,0.3)] active:scale-95 group relative overflow-hidden rounded-3xl"
                            onClick={() => setIsReturnsOpen(true)}
                        >
                            <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                <ArrowRight className="w-4 h-4 text-red-500" />
                            </div>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-black text-red-600 dark:text-red-400 flex items-center gap-2 uppercase tracking-widest">
                                    <RotateCcw className="w-4 h-4" />
                                    {t('revenue.returns') || 'Returns'}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-xs text-muted-foreground font-medium">
                                    {t('revenue.returnsDesc') || 'Track refunds and product returns'}
                                </p>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Sale Profitability Table */}
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                            <div className="flex flex-col gap-1">
                                <CardTitle className="text-lg flex items-center gap-2 flex-wrap">
                                    <TrendingUp className="w-5 h-5 text-primary" />
                                    {t('revenue.listTitle') || 'Recent Sales Profit Analysis'}
                                    {getDateDisplay() && (
                                        <span className="ml-2 px-2 py-0.5 text-xs font-semibold bg-primary/10 text-primary border border-primary/20 rounded-full">
                                            {getDateDisplay()}
                                        </span>
                                    )}
                                </CardTitle>
                                {stats.saleStats.length > 0 && (
                                    <p className="text-[10px] text-muted-foreground font-black uppercase tracking-[0.2em] opacity-70">
                                        {t('sales.pagination.total', { count: stats.saleStats.length }) || `${stats.saleStats.length} Sales Found`}
                                    </p>
                                )}
                                {selectionSummary && (
                                    <div className="flex items-center gap-2 mt-2 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 transition-all animate-in fade-in slide-in-from-left-2 duration-200 w-fit">
                                        <Check className="w-4 h-4" />
                                        <div className="text-xs font-bold font-mono flex items-center gap-3">
                                            <span>{selectionSummary.count} {t('common.selected') || 'selected'}</span>
                                            <span className="w-px h-3 bg-emerald-500/20" />
                                            {Object.entries(selectionSummary.byCurrency).map(([currency, data], idx) => (
                                                <div key={currency} className="flex items-center gap-3">
                                                    {idx > 0 && <span className="w-px h-3 bg-emerald-500/20" />}
                                                    <span>{t('revenue.table.revenue') || 'Rev'}: {formatCurrency(data.revenue, currency, features.iqd_display_preference)}</span>
                                                    <span className="w-px h-3 bg-emerald-500/20" />
                                                    <span>{t('revenue.table.profit') || 'Prof'}: {formatCurrency(data.profit, currency, features.iqd_display_preference)}</span>
                                                </div>
                                            ))}
                                        </div>
                                        <button onClick={clearSelection} className="p-0.5 rounded hover:bg-emerald-500/20 transition-colors">
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-4">
                                <AppPagination
                                    currentPage={currentPage}
                                    totalCount={stats.saleStats.length}
                                    pageSize={itemsPerPage}
                                    onPageChange={setCurrentPage}
                                    className="w-auto"
                                />
                                <div className="flex items-center gap-2">
                                    <Button
                                        onClick={() => setIsExportModalOpen(true)}
                                        disabled={sales.length === 0}
                                        className={cn(
                                            "h-10 px-6 rounded-full font-black transition-all flex gap-3 items-center group relative overflow-hidden",
                                            "bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400",
                                            "hover:bg-emerald-100 dark:hover:bg-emerald-500/20 hover:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] hover:scale-[1.02] active:scale-95",
                                            "uppercase tracking-widest text-[10px]"
                                        )}
                                    >
                                        <FileSpreadsheet className="w-4 h-4 transition-transform group-hover:rotate-12" />
                                        <span className="hidden sm:inline">
                                            {t('sales.export.button')}
                                        </span>
                                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 dark:via-white/5 to-transparent -translate-x-full group-hover:animate-shimmer" />
                                    </Button>

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleOpenPrintPreview}
                                        className="gap-2 h-10 px-6 rounded-full font-black bg-primary/5 hover:bg-primary/10 border-primary/20 text-primary transition-all duration-200 uppercase tracking-widest text-[10px]"
                                    >
                                        <Printer className="w-4 h-4" />
                                        <span className="hidden lg:inline">{t('revenue.printList') || 'Print List'}</span>
                                    </Button>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent ref={listRef} className="print:p-0 [print-color-adjust:exact] -webkit-print-color-adjust:exact">
                            {(isMobile() || viewMode === 'grid') ? (
                                <div className={cn(
                                    "grid gap-4",
                                    viewMode === 'grid' && !isMobile() ? "grid-cols-1 lg:grid-cols-2 xl:grid-cols-3" : "grid-cols-1"
                                )}>
                                    {paginatedSales.map((sale, idx) => {
                                        const originalSale = salesById.get(sale.id)
                                        const isFullyReturned = originalSale ? (originalSale.is_returned || (originalSale.items && originalSale.items.length > 0 && originalSale.items.every((item: any) =>
                                            item.is_returned || (item.returned_quantity || 0) >= item.quantity
                                        ))) : false

                                        const returnedItemsCount = originalSale?.items?.filter((item: any) => item.is_returned).length || 0
                                        const partialReturnedItemsCount = originalSale?.items?.filter((item: any) => (item.returned_quantity || 0) > 0 && !item.is_returned).length || 0
                                        const hasAnyReturn = returnedItemsCount > 0 || partialReturnedItemsCount > 0
                                        const totalReturnedQuantity = originalSale?.items?.reduce((sum: number, item: any) => {
                                            if (item.is_returned) return sum + (item.quantity || 0)
                                            if ((item.returned_quantity || 0) > 0) return sum + (item.returned_quantity || 0)
                                            return sum
                                        }, 0) || 0

                                        return (
                                            <div
                                                key={sale.id || idx}
                                                className={cn(
                                                    "p-4 border shadow-sm space-y-4 transition-all active:scale-[0.98]",
                                                    style === 'neo-orange' ? "rounded-[var(--radius)] border-2 border-black dark:border-white shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]" : "rounded-[2rem] md:rounded-2xl border-border",
                                                    isFullyReturned ? 'bg-destructive/5 border-destructive/20' : hasAnyReturn ? 'bg-orange-500/5 border-orange-500/20 dark:bg-orange-500/5 dark:border-orange-500/10' : 'bg-card'
                                                )}
                                                onClick={() => {
                                                    if (originalSale) setSelectedSale(originalSale)
                                                }}
                                            >
                                                <div className="flex justify-between items-start">
                                                    <div className="space-y-1">
                                                        <div className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
                                                            {formatDateTime(sale.date)}
                                                        </div>
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <span className="text-xs font-mono font-black text-primary">
                                                                #{sale.sequenceId ? String(sale.sequenceId).padStart(5, '0') : sale.id.split('-')[0]}
                                                            </span>
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    <Info className="w-3.5 h-3.5 text-muted-foreground hover:text-primary transition-colors cursor-pointer" />
                                                                </TooltipTrigger>
                                                                <TooltipContent>
                                                                    {t('revenue.viewDetails') || 'View Sale Details'}
                                                                </TooltipContent>
                                                            </Tooltip>

                                                            {isFullyReturned && (
                                                                <span className="px-1.5 py-0.5 text-[8px] font-bold bg-destructive/20 text-destructive dark:bg-destructive/30 dark:text-destructive-foreground rounded-full border border-destructive/30 uppercase">
                                                                    {t('sales.return.returnedStatus') || 'RETURNED'}
                                                                </span>
                                                            )}

                                                            {!isFullyReturned && hasAnyReturn && (
                                                                <span className="px-1.5 py-0.5 rounded-full text-[8px] font-bold bg-orange-500/10 text-orange-600 border border-orange-500/20 uppercase whitespace-nowrap">
                                                                    -{totalReturnedQuantity} {t('sales.return.returnedLabel') || 'returned'}
                                                                </span>
                                                            )}

                                                            <span className="px-1.5 py-0.5 rounded-full text-[8px] font-bold bg-secondary uppercase">
                                                                {sale.origin}
                                                            </span>
                                                        </div>
                                                    </div>
                                                    <div className="text-right">
                                                        <span className={cn(
                                                            "px-2 py-1 rounded-full text-xs font-black",
                                                            sale.margin > 20 ? "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20" :
                                                                sale.margin > 0 ? "bg-orange-500/10 text-orange-600 border border-orange-500/20" :
                                                                    "bg-destructive/10 text-destructive border border-destructive/20"
                                                        )}>
                                                            {sale.margin.toFixed(1)}%
                                                        </span>
                                                    </div>
                                                </div>

                                                <div className="grid grid-cols-3 gap-2 pt-3 border-t border-border/50">
                                                    <div className="space-y-0.5 text-start">
                                                        <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-tight">{t('revenue.table.revenue')}</div>
                                                        <div className="text-sm font-black text-foreground">
                                                            {formatCurrency(sale.revenue, sale.currency, features.iqd_display_preference)}
                                                        </div>
                                                    </div>
                                                    <div className="space-y-0.5 text-center">
                                                        <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-tight">{t('revenue.table.cost')}</div>
                                                        <div className="text-sm font-bold text-muted-foreground">
                                                            {formatCurrency(sale.cost, sale.currency, features.iqd_display_preference)}
                                                        </div>
                                                    </div>
                                                    <div className="space-y-0.5 text-end">
                                                        <div className="text-[9px] uppercase font-bold text-muted-foreground tracking-tight">{t('revenue.table.profit')}</div>
                                                        <div className="text-sm font-black text-emerald-600">
                                                            {formatCurrency(sale.profit, sale.currency, features.iqd_display_preference)}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            {/* Master Checkbox */}
                                            <TableHead className="w-10 text-center print:hidden">
                                                <button
                                                    onClick={toggleSelectAll}
                                                    className="p-1.5 rounded hover:bg-secondary transition-colors"
                                                    title={selectedSaleIds.size === stats.saleStats.length ? 'Deselect all' : 'Select all'}
                                                >
                                                    {selectedSaleIds.size === stats.saleStats.length && stats.saleStats.length > 0 ? (
                                                        <Check className="w-4 h-4 text-emerald-500" />
                                                    ) : selectedSaleIds.size > 0 ? (
                                                        <div className="w-4 h-4 border-2 border-emerald-500 rounded flex items-center justify-center">
                                                            <div className="w-2 h-1 bg-emerald-500" />
                                                        </div>
                                                    ) : (
                                                        <Square className="w-4 h-4 text-muted-foreground" />
                                                    )}
                                                </button>
                                            </TableHead>
                                            <TableHead className="text-start">{t('sales.date') || 'Date'}</TableHead>
                                            <TableHead className="text-start">{t('sales.id') || 'Sale ID'}</TableHead>
                                            <TableHead className="text-start">{t('sales.origin') || 'Origin'}</TableHead>
                                            <TableHead className="text-end">{t('revenue.table.revenue')}</TableHead>
                                            <TableHead className="text-end">{t('revenue.table.cost')}</TableHead>
                                            <TableHead className="text-end">{t('revenue.table.profit')}</TableHead>
                                            <TableHead className="text-end">{t('revenue.table.margin')}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {paginatedSales.map((sale, idx) => {
                                            const originalSale = salesById.get(sale.id)
                                            const isFullyReturned = originalSale ? (originalSale.is_returned || (originalSale.items && originalSale.items.length > 0 && originalSale.items.every((item: any) =>
                                                item.is_returned || (item.returned_quantity || 0) >= item.quantity
                                            ))) : false

                                            const returnedItemsCount = originalSale?.items?.filter((item: any) => item.is_returned).length || 0
                                            const partialReturnedItemsCount = originalSale?.items?.filter((item: any) => (item.returned_quantity || 0) > 0 && !item.is_returned).length || 0
                                            const hasAnyReturn = returnedItemsCount > 0 || partialReturnedItemsCount > 0
                                            const totalReturnedQuantity = originalSale?.items?.reduce((sum: number, item: any) => {
                                                if (item.is_returned) return sum + (item.quantity || 0)
                                                if ((item.returned_quantity || 0) > 0) return sum + (item.returned_quantity || 0)
                                                return sum
                                            }, 0) || 0

                                            return (
                                                <TableRow
                                                    key={sale.id || idx}
                                                    className={cn(
                                                        "group",
                                                        isFullyReturned ? 'bg-red-500/10 dark:bg-red-500/20 border-red-500/20' :
                                                            hasAnyReturn ? 'bg-orange-500/10 border-orange-500/20 dark:bg-orange-500/5 dark:border-orange-500/10' : '',
                                                        selectedSaleIds.has(sale.id) && 'bg-emerald-500/5 hover:bg-emerald-500/10',
                                                        "print:bg-opacity-100"
                                                    )}
                                                >
                                                    {/* Row Checkbox - visible on hover or when selected */}
                                                    <TableCell className="w-10 text-center print:hidden">
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation()
                                                                toggleSaleSelection(sale.id)
                                                            }}
                                                            className={cn(
                                                                "p-1.5 rounded transition-all",
                                                                selectedSaleIds.has(sale.id)
                                                                    ? "opacity-100"
                                                                    : "opacity-0 group-hover:opacity-100",
                                                                "hover:bg-secondary"
                                                            )}
                                                        >
                                                            {selectedSaleIds.has(sale.id) ? (
                                                                <Check className="w-4 h-4 text-emerald-500" />
                                                            ) : (
                                                                <Square className="w-4 h-4 text-muted-foreground" />
                                                            )}
                                                        </button>
                                                    </TableCell>
                                                    <TableCell className="text-start font-mono text-xs">
                                                        {formatDateTime(sale.date)}
                                                    </TableCell>
                                                    <TableCell className="text-start">
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                onClick={() => {
                                                                    if (originalSale) setSelectedSale(originalSale)
                                                                }}
                                                                className="font-mono text-[10px] text-primary hover:underline"
                                                            >
                                                                #{sale.sequenceId ? String(sale.sequenceId).padStart(5, '0') : sale.id.split('-')[0]}
                                                            </button>
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    <Info
                                                                        className="w-3.5 h-3.5 text-muted-foreground hover:text-primary transition-colors cursor-pointer"
                                                                        onClick={() => {
                                                                            if (originalSale) setSelectedSale(originalSale)
                                                                        }}
                                                                    />
                                                                </TooltipTrigger>
                                                                <TooltipContent>
                                                                    {t('revenue.viewDetails') || 'View Sale Details'}
                                                                </TooltipContent>
                                                            </Tooltip>

                                                            {isFullyReturned && (
                                                                <span className="px-1.5 py-0.5 text-[8px] font-bold bg-destructive/20 text-destructive dark:bg-destructive/30 dark:text-destructive-foreground rounded-full border border-destructive/30 uppercase">
                                                                    {t('sales.return.returnedStatus') || 'RETURNED'}
                                                                </span>
                                                            )}

                                                            {!isFullyReturned && hasAnyReturn && (
                                                                <span className="px-1.5 py-0.5 rounded-full text-[8px] font-bold bg-orange-500/10 text-orange-600 border border-orange-500/20 uppercase whitespace-nowrap">
                                                                    -{totalReturnedQuantity} {t('sales.return.returnedLabel') || 'returned'}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-start">
                                                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-secondary uppercase">
                                                            {sale.origin}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell className="text-end font-medium">
                                                        {formatCurrency(sale.revenue, sale.currency, features.iqd_display_preference)}
                                                    </TableCell>
                                                    <TableCell className="text-end text-muted-foreground">
                                                        {formatCurrency(sale.cost, sale.currency, features.iqd_display_preference)}
                                                    </TableCell>
                                                    <TableCell className="text-end font-bold text-emerald-600">
                                                        {formatCurrency(sale.profit, sale.currency, features.iqd_display_preference)}
                                                    </TableCell>
                                                    <TableCell className="text-end">
                                                        <span className={cn(
                                                            "px-2 py-0.5 rounded-full text-[10px] font-bold",
                                                            sale.margin > 20 ? "bg-emerald-500/10 text-emerald-600" :
                                                                sale.margin > 0 ? "bg-orange-500/10 text-orange-600" :
                                                                    "bg-destructive/10 text-destructive"
                                                        )}>
                                                            {sale.margin.toFixed(1)}%
                                                        </span>
                                                    </TableCell>
                                                </TableRow>
                                            )
                                        })}
                                    </TableBody>
                                </Table>
                            )}
                        </CardContent>
                    </Card>

                    {/* Sale Details Modal */}
                    <SaleDetailsModal
                        isOpen={!!selectedSale}
                        onClose={() => setSelectedSale(null)}
                        sale={selectedSale}
                    />

                    {/* Metric Analytics Deep-Dive Modal */}
                    <MetricDetailModal
                        isOpen={isMetricModalOpen}
                        onClose={() => setIsMetricModalOpen(false)}
                        metricType={selectedMetric}
                        currency={Object.keys(stats.statsByCurrency)[0] || features.default_currency || 'usd'}
                        iqdPreference={features.iqd_display_preference}
                        data={stats.statsByCurrency}
                    />

                    {/* Top Products Modal */}
                    <TopProductsModal
                        isOpen={isTopProductsOpen}
                        onClose={() => setIsTopProductsOpen(false)}
                        data={stats.statsByCurrency}
                        iqdPreference={features.iqd_display_preference}
                    />

                    {/* Sales Overview Modal */}
                    <SalesOverviewModal
                        isOpen={isSalesOverviewOpen}
                        onClose={() => setIsSalesOverviewOpen(false)}
                        data={stats.statsByCurrency}
                        iqdPreference={features.iqd_display_preference}
                    />

                    {/* Peak Trading Times Modal */}
                    <PeakTradingModal
                        isOpen={isPeakTradingOpen}
                        onClose={() => setIsPeakTradingOpen(false)}
                        sales={sales}
                    />

                    {/* Returns Analysis Modal */}
                    <ReturnsAnalysisModal
                        isOpen={isReturnsOpen}
                        onClose={() => setIsReturnsOpen(false)}
                        sales={sales}
                        iqdPreference={features.iqd_display_preference}
                        defaultCurrency={features.default_currency || 'usd'}
                    />

                    {/* Print Preview Modal */}
                    <PrintPreviewModal
                        isOpen={showPrintPreview}
                        onClose={() => setShowPrintPreview(false)}
                        title={t('revenue.printList') || 'Print Revenue List'}
                        onConfirm={() => setShowPrintPreview(false)}
                    >
                        <div ref={listRef} className="p-4 bg-white dark:bg-zinc-900">
                            <h2 className="text-xl font-bold mb-4">{t('revenue.listTitle') || 'Revenue List'}</h2>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t('sales.date') || 'Date'}</TableHead>
                                        <TableHead>{t('sales.id') || 'Sale ID'}</TableHead>
                                        <TableHead className="text-end">{t('revenue.table.revenue')}</TableHead>
                                        <TableHead className="text-end">{t('revenue.table.cost')}</TableHead>
                                        <TableHead className="text-end">{t('revenue.table.profit')}</TableHead>
                                        <TableHead className="text-end">{t('revenue.table.margin')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {stats.saleStats.map((sale, idx) => (
                                        <TableRow key={sale.id || idx}>
                                            <TableCell className="font-mono text-xs">
                                                {formatDateTime(sale.date)}
                                            </TableCell>
                                            <TableCell className="font-mono text-xs">
                                                #{sale.sequenceId ? sale.sequenceId.toString().padStart(5, '0') : sale.id.split('-')[0]}
                                            </TableCell>
                                            <TableCell className="text-end">
                                                {formatCurrency(sale.revenue, sale.currency, features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell className="text-end text-muted-foreground">
                                                {formatCurrency(sale.cost, sale.currency, features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell className="text-end font-bold text-emerald-600">
                                                {formatCurrency(sale.profit, sale.currency, features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell className="text-end">
                                                <span className={cn(
                                                    "px-2 py-0.5 rounded-full text-[10px] font-bold",
                                                    sale.margin > 20 ? "bg-emerald-500/10 text-emerald-600" :
                                                        sale.margin > 0 ? "bg-orange-500/10 text-orange-600" :
                                                            "bg-destructive/10 text-destructive"
                                                )}>
                                                    {sale.margin.toFixed(1)}%
                                                </span>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </PrintPreviewModal>
                </div>
            </div>

            <ExportPreviewModal
                isOpen={isExportModalOpen}
                onClose={() => setIsExportModalOpen(false)}
                type="revenue"
                filters={{
                    dateRange,
                    customDates,
                    selectedCashier: 'all'
                }}
            />
        </TooltipProvider >
    )
}
