import { useMemo } from 'react'
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
} from '@/ui/components'
import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Legend
} from 'recharts'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { TrendingUp, DollarSign, TrendingDown, BarChart3 } from 'lucide-react'

interface SalesOverviewModalProps {
    isOpen: boolean
    onClose: () => void
    data: Record<string, {
        revenue: number
        cost: number
        dailyTrend: Record<string, { revenue: number, cost: number, profit: number }>
    }> | null
    iqdPreference: 'IQD' | 'د.ع'
}

const METRIC_COLORS = {
    revenue: { stroke: '#3b82f6', fill: '#3b82f6' }, // Blue
    cost: { stroke: '#f97316', fill: '#f97316' },     // Orange
    profit: { stroke: '#10b981', fill: '#10b981' },    // Emerald
}

export function SalesOverviewModal({ isOpen, onClose, data, iqdPreference }: SalesOverviewModalProps) {
    const { t, i18n } = useTranslation()
    const isRtl = i18n.dir() === 'rtl'

    const activeCurrencies = useMemo(() => data ? Object.keys(data) : [], [data])

    const totals = useMemo(() => {
        if (!data) return { revenue: 0, cost: 0, profit: 0 }
        let revenue = 0, cost = 0
        Object.values(data).forEach(d => {
            revenue += d.revenue
            cost += d.cost
        })
        return { revenue, cost, profit: revenue - cost }
    }, [data])

    const chartData = useMemo(() => {
        if (!data) return []

        // Collect all unique dates across all currencies
        const allDates = new Set<string>()
        Object.values(data).forEach(currData => {
            Object.keys(currData.dailyTrend).forEach(date => allDates.add(date))
        })

        return Array.from(allDates)
            .sort()
            .map(date => {
                let revenue = 0, cost = 0, profit = 0

                // Aggregate all currencies' daily values
                Object.values(data).forEach(currData => {
                    const values = currData.dailyTrend[date] || { revenue: 0, cost: 0, profit: 0 }
                    revenue += values.revenue
                    cost += values.cost
                    profit += values.profit
                })

                return {
                    date: formatDate(date),
                    revenue,
                    cost,
                    profit
                }
            })
    }, [data])

    if (!data) return null

    const margin = totals.revenue > 0 ? ((totals.profit / totals.revenue) * 100).toFixed(1) : '0.0'

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className={cn(
                "max-w-5xl p-0 bg-background/95 backdrop-blur-3xl overflow-hidden rounded-[2.5rem] shadow-2xl transition-all duration-500",
                "border-[3px] border-blue-500/50 shadow-blue-500/10"
            )}>
                <div className="p-6 md:p-8 space-y-6 max-h-[90vh] overflow-y-auto custom-scrollbar [print-color-adjust:exact] -webkit-print-color-adjust:exact">
                    <DialogHeader className="flex flex-row items-center justify-between space-y-0">
                        <div className="flex items-center gap-4">
                            <div className="p-4 rounded-2xl shadow-inner bg-blue-500/10">
                                <BarChart3 className="w-5 h-5 text-blue-500" />
                            </div>
                            <div>
                                <DialogTitle className="text-2xl font-black tracking-tight">
                                    {t('revenue.salesOverview') || 'Sales Overview'}
                                </DialogTitle>
                                <DialogDescription className="text-sm font-semibold text-muted-foreground/80">
                                    {t('revenue.combinedTrends') || 'Combined revenue, cost & profit trends'}
                                </DialogDescription>
                            </div>
                        </div>
                    </DialogHeader>

                    {/* Summary Cards */}
                    <div className="grid grid-cols-3 gap-4">
                        <Card className="bg-blue-500/10 border-blue-500/20 rounded-2xl">
                            <CardContent className="p-4 flex items-center gap-3">
                                <DollarSign className="w-6 h-6 text-blue-500" />
                                <div>
                                    <p className="text-xs font-bold uppercase text-muted-foreground">{t('revenue.grossRevenue')}</p>
                                    <p className="text-lg font-black text-blue-600 dark:text-blue-400 tabular-nums">
                                        {formatCurrency(totals.revenue, activeCurrencies[0] as any, iqdPreference)}
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="bg-orange-500/10 border-orange-500/20 rounded-2xl">
                            <CardContent className="p-4 flex items-center gap-3">
                                <TrendingDown className="w-6 h-6 text-orange-500" />
                                <div>
                                    <p className="text-xs font-bold uppercase text-muted-foreground">{t('revenue.totalCost')}</p>
                                    <p className="text-lg font-black text-orange-600 dark:text-orange-400 tabular-nums">
                                        {formatCurrency(totals.cost, activeCurrencies[0] as any, iqdPreference)}
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="bg-emerald-500/10 border-emerald-500/20 rounded-2xl">
                            <CardContent className="p-4 flex items-center gap-3">
                                <TrendingUp className="w-6 h-6 text-emerald-500" />
                                <div>
                                    <p className="text-xs font-bold uppercase text-muted-foreground">{t('revenue.netProfit')}</p>
                                    <p className="text-lg font-black text-emerald-600 dark:text-emerald-400 tabular-nums">
                                        {formatCurrency(totals.profit, activeCurrencies[0] as any, iqdPreference)} ({margin}%)
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Multi-line Chart */}
                    <Card className="bg-card/40 border-border/30 backdrop-blur-md overflow-hidden rounded-[2rem] shadow-sm">
                        <CardHeader className="pb-2">
                            <CardTitle className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground/70 flex items-center gap-2">
                                <TrendingUp className="w-3.5 h-3.5" />
                                {t('revenue.dailyTrend') || 'Daily Trends'}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="pt-4">
                            <ResponsiveContainer width="100%" height={350}>
                                <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id="colorRevenueOverview" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                        </linearGradient>
                                        <linearGradient id="colorCostOverview" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                                        </linearGradient>
                                        <linearGradient id="colorProfitOverview" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                                    <XAxis
                                        dataKey="date"
                                        axisLine={false}
                                        tickLine={false}
                                        tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }}
                                        className="text-muted-foreground/60"
                                        reversed={isRtl}
                                    />
                                    <YAxis
                                        axisLine={false}
                                        tickLine={false}
                                        tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }}
                                        className="text-muted-foreground/60"
                                        tickFormatter={(val) => val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val}
                                        orientation={isRtl ? 'right' : 'left'}
                                    />
                                    <Tooltip
                                        contentStyle={{
                                            backgroundColor: 'hsl(var(--card))',
                                            borderRadius: '20px',
                                            border: '1px solid hsl(var(--border))',
                                            boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                                            padding: '12px'
                                        }}
                                        itemStyle={{ fontSize: '11px', fontWeight: 'bold', padding: '2px 0' }}
                                        labelStyle={{ fontSize: '10px', fontWeight: 'black', textTransform: 'uppercase', marginBottom: '8px', opacity: 0.6 }}
                                        formatter={(value: any, name: any) => [
                                            formatCurrency(value, activeCurrencies[0] as any, iqdPreference),
                                            t(`revenue.${name}`) || name
                                        ]}
                                    />
                                    <Legend
                                        wrapperStyle={{ paddingTop: '20px' }}
                                        formatter={(value) => t(`revenue.${value}`) || value}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="revenue"
                                        name="grossRevenue"
                                        stroke={METRIC_COLORS.revenue.stroke}
                                        strokeWidth={3}
                                        fillOpacity={1}
                                        fill="url(#colorRevenueOverview)"
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="cost"
                                        name="totalCost"
                                        stroke={METRIC_COLORS.cost.stroke}
                                        strokeWidth={3}
                                        fillOpacity={1}
                                        fill="url(#colorCostOverview)"
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="profit"
                                        name="netProfit"
                                        stroke={METRIC_COLORS.profit.stroke}
                                        strokeWidth={3}
                                        fillOpacity={1}
                                        fill="url(#colorProfitOverview)"
                                    />
                                </AreaChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>
                </div>
            </DialogContent>
        </Dialog>
    )
}
