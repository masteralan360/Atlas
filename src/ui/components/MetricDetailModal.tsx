import { useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
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
    Button,
} from '@/ui/components'
import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    PieChart,
    Pie,
    Cell,
    Legend
} from 'recharts'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { DollarSign, TrendingUp, BarChart3, PieChart as PieChartIcon, Printer } from 'lucide-react'
import { useReactToPrint } from 'react-to-print'

export type MetricType = 'grossRevenue' | 'totalCost' | 'netProfit' | 'profitMargin'

interface CurrencyStats {
    revenue: number
    cost: number
    salesCount: number
    dailyTrend: Record<string, { revenue: number, cost: number, profit: number }>
    categoryRevenue: Record<string, number>
    productPerformance: Record<string, { name: string, revenue: number, cost: number, quantity: number }>
}

interface MetricDetailModalProps {
    isOpen: boolean
    onClose: () => void
    metricType: MetricType | null
    currency: string
    iqdPreference: 'IQD' | 'د.ع'
    data: Record<string, CurrencyStats> | null
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316']

// Map of currency to color for multi-line charts
const CURRENCY_COLORS: Record<string, string> = {
    usd: '#3b82f6', // Blue
    iqd: '#10b981', // Emerald
    eur: '#8b5cf6', // Violet
    try: '#f59e0b', // Amber
}

export function MetricDetailModal({ isOpen, onClose, metricType, currency, iqdPreference, data }: MetricDetailModalProps) {
    const { t, i18n } = useTranslation()
    const isRtl = i18n.dir() === 'rtl'
    const printRef = useRef<HTMLDivElement>(null)

    const getMetricTitle = () => {
        switch (metricType) {
            case 'grossRevenue': return t('revenue.grossRevenue')
            case 'totalCost': return t('revenue.totalCost')
            case 'netProfit': return t('revenue.netProfit')
            case 'profitMargin': return t('revenue.profitMargin')
            default: return ''
        }
    }

    const getMetricIcon = () => {
        switch (metricType) {
            case 'grossRevenue': return <DollarSign className="w-5 h-5 text-blue-500" />
            case 'totalCost': return <BarChart3 className="w-5 h-5 text-orange-500" />
            case 'netProfit': return <TrendingUp className="w-5 h-5 text-emerald-500" />
            case 'profitMargin': return <PieChartIcon className="w-5 h-5 text-purple-500" />
        }
    }

    const handlePrint = useReactToPrint({
        contentRef: printRef,
        documentTitle: `${getMetricTitle()}_Report_${new Date().toISOString().split('T')[0]}`,
    })

    const activeCurrencies = useMemo(() => data ? Object.keys(data) : [], [data])

    const trendData = useMemo(() => {
        if (!data) return []

        // Collect all unique dates across all currencies
        const allDates = new Set<string>()
        Object.values(data).forEach(currData => {
            Object.keys(currData.dailyTrend).forEach(date => allDates.add(date))
        })

        return Array.from(allDates)
            .sort()
            .map(date => {
                const row: any = {
                    date: formatDate(date),
                }

                activeCurrencies.forEach(curr => {
                    const values = data[curr].dailyTrend[date] || { revenue: 0, cost: 0, profit: 0 }
                    if (metricType === 'profitMargin') {
                        row[`${curr}_value`] = values.revenue > 0 ? ((values.revenue - values.cost) / values.revenue) * 100 : 0
                        // For percentage, normalized is the same
                        row[`${curr}_normalized`] = row[`${curr}_value`]
                    } else {
                        const rawVal = metricType === 'netProfit' ? values.profit : metricType === 'totalCost' ? values.cost : values.revenue
                        row[`${curr}_value`] = rawVal

                        let normalized = rawVal
                        // Simple normalization for visualization purposes
                        if (curr === 'iqd') {
                            // Assuming ~1500 IQD = 1 USD for visual scaling
                            normalized = normalized / 1500
                        } else if (curr === 'eur') {
                            // Assuming ~1.1 USD = 1 EUR
                            normalized = normalized * 1.1
                        } else if (curr === 'try') {
                            // Assuming ~30 TRY = 1 USD
                            normalized = normalized / 30
                        }
                        row[`${curr}_normalized`] = normalized
                    }
                })
                return row
            })
    }, [data, metricType, activeCurrencies])

    const categoryData = useMemo(() => {
        if (!data) return []

        // Aggregating by category across ALL currencies for now, 
        // using primary currency as base or just showing count? 
        // Let's just aggregate values—ideally they'd be converted, 
        // but for a pie chart of 'Revenue Share', we just show the selected or sum.
        // User asked for "different lines" in graphs (Trend), 
        // for pie/table we'll just show the main currency or first active one.
        const mainCurr = activeCurrencies[0] || currency
        return Object.entries(data[mainCurr]?.categoryRevenue || {})
            .map(([name, value]) => ({ name, value }))
            .sort((a, b) => b.value - a.value)
    }, [data, currency, activeCurrencies])

    const topProducts = useMemo(() => {
        const mainCurr = activeCurrencies[0] || currency
        if (!data?.[mainCurr]?.productPerformance) return []
        return Object.entries(data[mainCurr].productPerformance)
            .map(([id, stats]) => ({
                id,
                ...stats,
                profit: stats.revenue - stats.cost,
                margin: stats.revenue > 0 ? ((stats.revenue - stats.cost) / stats.revenue) * 100 : 0
            }))
            .sort((a, b) => {
                if (metricType === 'profitMargin') return b.margin - a.margin
                if (metricType === 'totalCost') return b.cost - a.cost
                return b.revenue - a.revenue
            })
            .slice(0, 5)
    }, [data, metricType, currency, activeCurrencies])

    if (!metricType || !data) return null


    const getPrimaryValue = () => {
        return (
            <div className="space-y-1">
                {activeCurrencies.map(curr => {
                    const currData = data[curr]
                    let val = 0
                    if (metricType === 'grossRevenue') val = currData.revenue
                    else if (metricType === 'totalCost') val = currData.cost
                    else if (metricType === 'netProfit') val = currData.revenue - currData.cost
                    else if (metricType === 'profitMargin') {
                        val = currData.revenue > 0 ? ((currData.revenue - currData.cost) / currData.revenue) * 100 : 0
                        return <div key={curr} className="text-3xl font-black tabular-nums tracking-tighter text-purple-600 dark:text-purple-400">{val.toFixed(1)}% ({curr.toUpperCase()})</div>
                    }

                    return (
                        <div key={curr} className={cn(
                            "text-3xl font-black tabular-nums tracking-tighter leading-none",
                            metricType === 'grossRevenue' && "text-blue-600 dark:text-blue-400",
                            metricType === 'totalCost' && "text-orange-600 dark:text-orange-400",
                            metricType === 'netProfit' && "text-emerald-600 dark:text-emerald-400"
                        )}>
                            {formatCurrency(val, curr as any, iqdPreference)}
                        </div>
                    )
                })}
            </div>
        )
    }

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className={cn(
                "max-w-5xl p-0 bg-background/95 backdrop-blur-3xl overflow-hidden rounded-[2.5rem] shadow-2xl transition-all duration-500",
                "border-[3px]",
                metricType === 'grossRevenue' && "border-blue-500/50 shadow-blue-500/10",
                metricType === 'totalCost' && "border-orange-500/50 shadow-orange-500/10",
                metricType === 'netProfit' && "border-emerald-500/50 shadow-emerald-500/10",
                metricType === 'profitMargin' && "border-purple-500/50 shadow-purple-500/10"
            )}>
                <div ref={printRef} className="p-6 md:p-8 space-y-8 max-h-[90vh] overflow-y-auto custom-scrollbar [print-color-adjust:exact] -webkit-print-color-adjust:exact">
                    <DialogHeader className="flex flex-row items-center justify-between space-y-0">
                        <div className="flex items-center gap-4">
                            <div className={cn(
                                "p-4 rounded-2xl shadow-inner",
                                metricType === 'grossRevenue' && "bg-blue-500/10",
                                metricType === 'totalCost' && "bg-orange-500/10",
                                metricType === 'netProfit' && "bg-emerald-500/10",
                                metricType === 'profitMargin' && "bg-purple-500/10"
                            )}>
                                {getMetricIcon()}
                            </div>
                            <div>
                                <DialogTitle className="text-2xl font-black tracking-tight">{getMetricTitle()}</DialogTitle>
                                <DialogDescription className="text-sm font-semibold text-muted-foreground/80">
                                    {t('revenue.detailedAnalysis')}
                                </DialogDescription>
                            </div>
                            {/* Desktop Print Button (Metric Designated Color Placement) */}
                            <Button
                                variant="outline"
                                size="icon"
                                onClick={() => handlePrint()}
                                className={cn(
                                    "hidden md:flex w-9 h-9 rounded-xl transition-all duration-300 border-2 ml-2",
                                    metricType === 'grossRevenue' && "bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20",
                                    metricType === 'totalCost' && "bg-orange-500/10 border-orange-500/20 text-orange-600 dark:text-orange-400 hover:bg-orange-500/20",
                                    metricType === 'netProfit' && "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20",
                                    metricType === 'profitMargin' && "bg-purple-500/10 border-purple-500/20 text-purple-600 dark:text-purple-400 hover:bg-purple-500/20"
                                )}
                            >
                                <Printer className="w-4 h-4" />
                            </Button>
                        </div>
                        <div className="flex items-center gap-3">
                            <div className="text-right">
                                {getPrimaryValue()}
                            </div>
                            {/* Mobile Print Button */}
                            <Button
                                variant="outline"
                                size="icon"
                                onClick={() => handlePrint()}
                                className={cn(
                                    "md:hidden w-9 h-9 rounded-xl transition-all duration-300 border-2",
                                    metricType === 'grossRevenue' && "bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400",
                                    metricType === 'totalCost' && "bg-orange-500/10 border-orange-500/20 text-orange-600 dark:text-orange-400",
                                    metricType === 'netProfit' && "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400",
                                    metricType === 'profitMargin' && "bg-purple-500/10 border-purple-500/20 text-purple-600 dark:text-purple-400"
                                )}
                            >
                                <Printer className="w-4 h-4" />
                            </Button>
                        </div>
                    </DialogHeader>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        {/* Primary Trend Chart */}
                        <Card className="lg:col-span-2 bg-card/40 border-border/30 backdrop-blur-md overflow-hidden rounded-[2.5rem] shadow-sm">
                            <CardHeader className="pb-2 flex flex-row items-center justify-between">
                                <CardTitle className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground/70 flex items-center gap-2">
                                    <TrendingUp className="w-3.5 h-3.5" />
                                    {t('revenue.trendTitle')}
                                </CardTitle>
                                {/* Multi-Currency Legend */}
                                <div className="flex items-center gap-2">
                                    {activeCurrencies.map(curr => (
                                        <div
                                            key={curr}
                                            className="px-2 py-1 rounded-full bg-background/50 border border-border/50 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-tight shadow-sm"
                                        >
                                            <div
                                                className="w-2 h-2 rounded-full"
                                                style={{ backgroundColor: CURRENCY_COLORS[curr] || '#94a3b8' }}
                                            />
                                            {curr.toUpperCase()}{curr === 'usd' ? '$' : curr === 'iqd' ? 'د.ع' : ''}
                                        </div>
                                    ))}
                                </div>
                            </CardHeader>
                            <CardContent className="h-[320px] p-0 pr-6 pb-6">
                                <ResponsiveContainer width="100%" height="100%">
                                    <AreaChart data={trendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                        <defs>
                                            {activeCurrencies.map(curr => (
                                                <linearGradient key={`grad-${curr}`} id={`color-${curr}`} x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="5%" stopColor={CURRENCY_COLORS[curr] || '#94a3b8'} stopOpacity={0.3} />
                                                    <stop offset="95%" stopColor={CURRENCY_COLORS[curr] || '#94a3b8'} stopOpacity={0} />
                                                </linearGradient>
                                            ))}
                                        </defs>

                                        <CartesianGrid strokeDasharray="4 4" vertical={false} stroke="currentColor" className="text-border/50" />
                                        <XAxis
                                            dataKey="date"
                                            axisLine={false}
                                            tickLine={false}
                                            tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }}
                                            className="text-muted-foreground/60"
                                            dy={10}
                                            reversed={isRtl}
                                        />
                                        <YAxis
                                            axisLine={false}
                                            tickLine={false}
                                            tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }}
                                            className="text-muted-foreground/60"
                                            tickFormatter={(val) => metricType === 'profitMargin' ? `${val}%` : val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val}
                                            orientation={isRtl ? 'right' : 'left'}
                                        />
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: 'hsl(var(--card))',
                                                borderRadius: '20px',
                                                border: '1px solid hsl(var(--border))',
                                                boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                                                padding: '12px',
                                                textAlign: isRtl ? 'right' : 'left'
                                            }}
                                            itemStyle={{ fontSize: '11px', fontWeight: 'bold', padding: '2px 0' }}
                                            labelStyle={{ fontSize: '10px', fontWeight: 'black', textTransform: 'uppercase', marginBottom: '8px', opacity: 0.6 }}
                                            formatter={(value: any, name: any, props: any) => {
                                                const curr = String(name).split('_')[0]
                                                const originalValue = props.payload[`${curr}_value`] || value

                                                return [
                                                    metricType === 'profitMargin'
                                                        ? `${Number(originalValue).toFixed(1)}%`
                                                        : formatCurrency(originalValue, curr.toLowerCase() as any, iqdPreference),
                                                    curr.toUpperCase()
                                                ]
                                            }}
                                        />
                                        {activeCurrencies.map(curr => (
                                            <Area
                                                key={curr}
                                                type="monotone"
                                                dataKey={`${curr}_normalized`}
                                                stroke={CURRENCY_COLORS[curr] || '#94a3b8'}
                                                strokeWidth={3}
                                                fillOpacity={1}
                                                fill={`url(#color-${curr})`}
                                                animationDuration={1500}
                                            />
                                        ))}
                                    </AreaChart>
                                </ResponsiveContainer>
                            </CardContent>
                        </Card>

                        {/* Category Breakdown */}
                        <Card className="bg-card/40 border-border/30 backdrop-blur-md overflow-hidden rounded-[2.5rem] shadow-sm">
                            <CardHeader className="pb-0">
                                <CardTitle className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground/70 flex items-center gap-2">
                                    <PieChartIcon className="w-3.5 h-3.5" />
                                    {t('revenue.categorySplit')}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="h-[320px] flex items-center justify-center p-4">
                                <div dir="ltr" className="w-full h-full">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <PieChart>
                                            <Pie
                                                data={categoryData}
                                                cx="50%"
                                                cy="50%"
                                                innerRadius={65}
                                                outerRadius={85}
                                                paddingAngle={8}
                                                dataKey="value"
                                                stroke="none"
                                            >
                                                {categoryData.map((_, index) => (
                                                    <Cell
                                                        key={`cell-${index}`}
                                                        fill={COLORS[index % COLORS.length]}
                                                        className="hover:opacity-80 transition-opacity cursor-pointer"
                                                    />
                                                ))}
                                            </Pie>
                                            <Tooltip
                                                contentStyle={{
                                                    backgroundColor: 'hsl(var(--card))',
                                                    borderRadius: '20px',
                                                    border: '1px solid hsl(var(--border))',
                                                    padding: '12px',
                                                    textAlign: 'left',
                                                    color: 'hsl(var(--foreground))'
                                                }}
                                                itemStyle={{
                                                    color: 'hsl(var(--foreground))',
                                                    fontSize: '11px',
                                                    fontWeight: 'bold'
                                                }}
                                                formatter={(value: any) => formatCurrency(value, (activeCurrencies[0] || currency) as any, iqdPreference)}
                                            />
                                            <Legend
                                                verticalAlign="bottom"
                                                align="center"
                                                iconType="circle"
                                                wrapperStyle={{ fontSize: '11px', fontWeight: 800, paddingTop: '20px' }}
                                            />
                                        </PieChart>
                                    </ResponsiveContainer>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Top Performers Table */}
                        <Card className="lg:col-span-3 bg-card/40 border-border/30 backdrop-blur-md overflow-hidden rounded-[2.5rem] shadow-sm">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground/70">
                                    {metricType === 'totalCost' ? t('revenue.highestCost') : t('revenue.topPerforming')}
                                    <span className="ml-2 text-[9px] lowercase font-medium opacity-60">
                                        ({t('common.showingIn')} {(activeCurrencies[0] || currency).toUpperCase()})
                                    </span>
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-0">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="hover:bg-transparent border-border/40">
                                            <TableHead className={cn("text-[10px] font-black uppercase tracking-widest", isRtl ? "text-right pr-8" : "text-left pl-8")}>{t('products.name')}</TableHead>
                                            <TableHead className="text-center text-[10px] font-black uppercase tracking-widest">{t('inventory.quantity')}</TableHead>
                                            <TableHead className="text-right text-[10px] font-black uppercase tracking-widest">{t('revenue.table.revenue')}</TableHead>
                                            <TableHead className="text-right text-[10px] font-black uppercase tracking-widest">{t('revenue.table.cost')}</TableHead>
                                            <TableHead className="text-right text-[10px] font-black uppercase tracking-widest">{t('revenue.table.profit')}</TableHead>
                                            <TableHead className={cn("text-right text-[10px] font-black uppercase tracking-widest", isRtl ? "pl-8" : "pr-8")}>{t('revenue.table.margin')}</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {topProducts.map((p) => (
                                            <TableRow key={p.id} className="hover:bg-primary/5 transition-colors border-border/40 group">
                                                <TableCell className={cn("font-bold py-4 group-hover:text-primary transition-colors", isRtl ? "text-right pr-8" : "text-left pl-8")}>{p.name}</TableCell>
                                                <TableCell className="text-center font-black tabular-nums">{p.quantity}</TableCell>
                                                <TableCell className="text-right tabular-nums font-semibold">{formatCurrency(p.revenue, (activeCurrencies[0] || currency) as any, iqdPreference)}</TableCell>
                                                <TableCell className="text-right tabular-nums text-muted-foreground font-medium">{formatCurrency(p.cost, (activeCurrencies[0] || currency) as any, iqdPreference)}</TableCell>
                                                <TableCell className="text-right tabular-nums font-black text-emerald-600 dark:text-emerald-400">
                                                    {formatCurrency(p.profit, (activeCurrencies[0] || currency) as any, iqdPreference)}
                                                </TableCell>
                                                <TableCell className={cn("text-right", isRtl ? "pl-8" : "pr-8")}>
                                                    <span className={cn(
                                                        "px-3 py-1 rounded-xl text-[11px] font-black shadow-sm",
                                                        p.margin > 20 ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20" :
                                                            p.margin > 0 ? "bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20" :
                                                                "bg-destructive/10 text-destructive border border-destructive/20"
                                                    )}>
                                                        {p.margin.toFixed(1)}%
                                                    </span>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
