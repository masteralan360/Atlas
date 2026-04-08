import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
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
import { formatCurrency, formatDate } from '@/lib/utils'
import { TrendingUp, DollarSign, TrendingDown, BarChart3 } from 'lucide-react'

interface DashboardSalesOverviewProps {
    data: Record<string, {
        revenue: number
        cost: number
        profit: number
        dailyTrend: Record<string, { revenue: number, cost: number, profit: number }>
    }> | null
    iqdPreference: 'IQD' | 'د.ع'
}

const METRIC_COLORS = {
    revenue: { stroke: '#3b82f6', fill: '#3b82f6' }, // Blue
    cost: { stroke: '#f97316', fill: '#f97316' },     // Orange
    profit: { stroke: '#10b981', fill: '#10b981' },    // Emerald
}

export function DashboardSalesOverview({ data, iqdPreference }: DashboardSalesOverviewProps) {
    const { t, i18n } = useTranslation()
    const isRtl = i18n.dir() === 'rtl'

    const activeCurrencies = useMemo(() => data ? Object.keys(data) : [], [data])


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

    if (!data || activeCurrencies.length === 0) {
        return (
            <Card className="col-span-full bg-card/40 border-border/30 backdrop-blur-md rounded-[2rem] p-8 flex flex-col items-center justify-center min-h-[400px]">
                <BarChart3 className="w-12 h-12 text-muted-foreground/20 mb-4" />
                <p className="text-muted-foreground font-bold">{t('common.noData')}</p>
            </Card>
        )
    }


    return (
        <Card className="col-span-full bg-card/40 border-border/30 backdrop-blur-md overflow-hidden rounded-[2.5rem] shadow-sm">
            <CardHeader className="p-6 md:p-8 space-y-6 pb-2">
                <div className="flex items-center gap-4">
                    <div className="p-4 rounded-2xl shadow-inner bg-blue-500/10">
                        <BarChart3 className="w-5 h-5 text-blue-500" />
                    </div>
                    <div>
                        <CardTitle className="text-2xl font-black tracking-tight">
                            {t('revenue.salesOverview') || 'Sales Overview'}
                        </CardTitle>
                        <p className="text-sm font-semibold text-muted-foreground/80">
                            {t('revenue.salesOverviewDesc') || 'Combined revenue, cost & profit trends'}
                        </p>
                    </div>
                </div>

                {/* Summary Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card className="bg-blue-500/5 dark:bg-blue-500/10 border-blue-500/10 dark:border-blue-500/20 rounded-2xl shadow-none">
                        <CardContent className="p-4 flex items-center gap-3">
                            <div className="p-2 rounded-xl bg-blue-500/10">
                                <DollarSign className="w-5 h-5 text-blue-500" />
                            </div>
                            <div>
                                <p className="text-[10px] font-black uppercase text-blue-600/70 dark:text-blue-400/70 tracking-wider font-mono">{t('revenue.grossRevenue')}</p>
                                <div className="space-y-0.5">
                                    {Object.entries(data).map(([curr, d]) => (
                                        <p key={curr} className="text-lg font-black text-blue-700 dark:text-blue-300 tabular-nums leading-tight">
                                            {formatCurrency(d.revenue, curr as any, iqdPreference)}
                                        </p>
                                    ))}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                    <Card className="bg-orange-500/5 dark:bg-orange-500/10 border-orange-500/10 dark:border-orange-500/20 rounded-2xl shadow-none">
                        <CardContent className="p-4 flex items-center gap-3">
                            <div className="p-2 rounded-xl bg-orange-500/10">
                                <TrendingDown className="w-5 h-5 text-orange-500" />
                            </div>
                            <div>
                                <p className="text-[10px] font-black uppercase text-orange-600/70 dark:text-orange-400/70 tracking-wider font-mono">{t('revenue.totalCost')}</p>
                                <div className="space-y-0.5">
                                    {Object.entries(data).map(([curr, d]) => (
                                        <p key={curr} className="text-lg font-black text-orange-700 dark:text-orange-300 tabular-nums leading-tight">
                                            {formatCurrency(d.cost, curr as any, iqdPreference)}
                                        </p>
                                    ))}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                    <Card className="bg-emerald-500/5 dark:bg-emerald-500/10 border-emerald-500/10 dark:border-emerald-500/20 rounded-2xl shadow-none">
                        <CardContent className="p-4 flex items-center gap-3">
                            <div className="p-2 rounded-xl bg-emerald-500/10">
                                <TrendingUp className="w-5 h-5 text-emerald-500" />
                            </div>
                            <div>
                                <p className="text-[10px] font-black uppercase text-emerald-600/70 dark:text-emerald-400/70 tracking-wider font-mono">{t('revenue.netProfit')}</p>
                                <div className="space-y-0.5">
                                    {Object.entries(data).map(([curr, d]) => {
                                        const margin = d.revenue > 0 ? ((d.profit / d.revenue) * 100).toFixed(1) : '0.0'
                                        return (
                                            <p key={curr} className="text-lg font-black text-emerald-700 dark:text-emerald-300 tabular-nums leading-tight">
                                                {formatCurrency(d.profit, curr as any, iqdPreference)} ({margin}%)
                                            </p>
                                        )
                                    })}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </CardHeader>

            <CardContent className="p-6 md:p-8 pt-2">
                <div className="mb-4 flex items-center gap-2">
                    <TrendingUp className="w-3.5 h-3.5 text-muted-foreground/60" />
                    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/60">
                        {t('dashboard.dailyTrends') || 'Daily Trends'}
                    </span>
                </div>
                <ResponsiveContainer width="100%" height={350}>
                    <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                        <defs>
                            <linearGradient id="dashboardColorRevenue" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="dashboardColorCost" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                                <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="dashboardColorProfit" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.05} />
                        <XAxis
                            dataKey="date"
                            axisLine={false}
                            tickLine={false}
                            tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor', opacity: 0.5 }}
                            reversed={isRtl}
                        />
                        <YAxis
                            axisLine={false}
                            tickLine={false}
                            tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor', opacity: 0.5 }}
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
                            formatter={(value) => (
                                <span className="text-[11px] font-bold text-muted-foreground/80 hover:text-foreground transition-colors">
                                    {t(`revenue.${value}`) || value}
                                </span>
                            )}
                        />
                        <Area
                            type="monotone"
                            dataKey="revenue"
                            name="grossRevenue"
                            stroke={METRIC_COLORS.revenue.stroke}
                            strokeWidth={3}
                            fillOpacity={1}
                            fill="url(#dashboardColorRevenue)"
                        />
                        <Area
                            type="monotone"
                            dataKey="profit"
                            name="netProfit"
                            stroke={METRIC_COLORS.profit.stroke}
                            strokeWidth={3}
                            fillOpacity={1}
                            fill="url(#dashboardColorProfit)"
                        />
                        <Area
                            type="monotone"
                            dataKey="cost"
                            name="totalCost"
                            stroke={METRIC_COLORS.cost.stroke}
                            strokeWidth={3}
                            fillOpacity={1}
                            fill="url(#dashboardColorCost)"
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    )
}
