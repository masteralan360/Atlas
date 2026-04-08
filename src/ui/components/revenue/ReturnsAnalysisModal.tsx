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
    PieChart,
    Pie,
    Cell
} from 'recharts'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { RotateCcw, TrendingDown, Package, Percent } from 'lucide-react'
import { Sale } from '@/types'

interface ReturnsAnalysisModalProps {
    isOpen: boolean
    onClose: () => void
    sales: Sale[]
    iqdPreference: 'IQD' | 'د.ع'
    defaultCurrency: string
}

const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6']

export function ReturnsAnalysisModal({ isOpen, onClose, sales, iqdPreference, defaultCurrency }: ReturnsAnalysisModalProps) {
    const { t, i18n } = useTranslation()
    const isRtl = i18n.dir() === 'rtl'

    const returnsData = useMemo(() => {
        let totalReturns = 0
        let totalRefunded = 0
        const dailyReturns: Record<string, { count: number, amount: number }> = {}
        const productReturns: Record<string, { name: string, count: number, amount: number }> = {}

        sales.forEach(sale => {
            let isSaleWithReturn = false
            let currentSaleRefundedAmount = 0
            const date = new Date(sale.created_at).toISOString().split('T')[0]

            // 1. Check if the sale is fully returned (Legacy or explicit flag)
            if (sale.is_returned) {
                isSaleWithReturn = true
                currentSaleRefundedAmount = sale.total_amount
            }

            // 2. Analyze items for partial returns or to populate product stats
            let itemsRefundSum = 0

            sale.items?.forEach(item => {
                let qtyReturned = 0

                if (sale.is_returned) {
                    // If sale is flagged returned, assume all items are returned
                    qtyReturned = item.quantity
                } else if (item.is_returned) {
                    // Item explicitly flagged
                    qtyReturned = item.quantity
                } else if (item.returned_quantity && item.returned_quantity > 0) {
                    // Partial quantity returned
                    qtyReturned = item.returned_quantity
                }

                if (qtyReturned > 0) {
                    // Calculate refund value for this item
                    const itemRefundValue = item.converted_unit_price * qtyReturned
                    itemsRefundSum += itemRefundValue

                    // Update Product Stats
                    const prodId = item.product_id
                    if (!productReturns[prodId]) {
                        productReturns[prodId] = { name: item.product_name || 'Unknown', count: 0, amount: 0 }
                    }
                    productReturns[prodId].count += qtyReturned
                    productReturns[prodId].amount += itemRefundValue
                }
            })

            // 3. If not fully returned by flag, but has item returns, it's a partial return
            if (!sale.is_returned && itemsRefundSum > 0) {
                isSaleWithReturn = true
                currentSaleRefundedAmount = itemsRefundSum
            }

            // 4. Update Aggregates and Trend Data
            if (isSaleWithReturn) {
                totalReturns++
                totalRefunded += currentSaleRefundedAmount

                if (!dailyReturns[date]) dailyReturns[date] = { count: 0, amount: 0 }
                dailyReturns[date].count++
                dailyReturns[date].amount += currentSaleRefundedAmount
            }
        })

        const totalSales = sales.filter(s => !s.is_returned).length
        const returnRate = totalSales > 0 ? (totalReturns / totalSales) * 100 : 0

        const trendData = Object.entries(dailyReturns)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, data]) => ({
                date: formatDate(date),
                count: data.count,
                amount: data.amount
            }))

        const topReturnedProducts = Object.values(productReturns)
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)

        return {
            totalReturns,
            totalRefunded,
            returnRate,
            trendData,
            topReturnedProducts
        }
    }, [sales])

    if (!sales) return null

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className={cn(
                "max-w-4xl p-0 bg-background/95 backdrop-blur-3xl overflow-hidden rounded-[2.5rem] shadow-2xl transition-all duration-500",
                "border-[3px] border-red-500/50 shadow-red-500/10"
            )}>
                <div className="p-6 md:p-8 space-y-6 max-h-[90vh] overflow-y-auto custom-scrollbar [print-color-adjust:exact] -webkit-print-color-adjust:exact">
                    <DialogHeader className="flex flex-row items-center justify-between space-y-0">
                        <div className="flex items-center gap-4">
                            <div className="p-4 rounded-2xl shadow-inner bg-red-500/10">
                                <RotateCcw className="w-5 h-5 text-red-500" />
                            </div>
                            <div>
                                <DialogTitle className="text-2xl font-black tracking-tight">
                                    {t('revenue.returns') || 'Returns Analysis'}
                                </DialogTitle>
                                <DialogDescription className="text-sm font-semibold text-muted-foreground/80">
                                    {t('revenue.returnsDesc') || 'Track refunds and product returns'}
                                </DialogDescription>
                            </div>
                        </div>
                    </DialogHeader>

                    {/* Summary Stats */}
                    <div className="grid grid-cols-3 gap-4">
                        <Card className="bg-red-500/10 border-red-500/20 rounded-2xl">
                            <CardContent className="p-4 flex items-center gap-3">
                                <RotateCcw className="w-6 h-6 text-red-500" />
                                <div>
                                    <p className="text-xs font-bold uppercase text-muted-foreground">{t('revenue.totalReturns') || 'Total Returns'}</p>
                                    <p className="text-2xl font-black text-red-600 dark:text-red-400 tabular-nums">
                                        {returnsData.totalReturns}
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="bg-orange-500/10 border-orange-500/20 rounded-2xl">
                            <CardContent className="p-4 flex items-center gap-3">
                                <TrendingDown className="w-6 h-6 text-orange-500" />
                                <div>
                                    <p className="text-xs font-bold uppercase text-muted-foreground">{t('revenue.refundedAmount') || 'Refunded'}</p>
                                    <p className="text-xl font-black text-orange-600 dark:text-orange-400 tabular-nums">
                                        {formatCurrency(returnsData.totalRefunded, defaultCurrency as any, iqdPreference)}
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                        <Card className="bg-yellow-500/10 border-yellow-500/20 rounded-2xl">
                            <CardContent className="p-4 flex items-center gap-3">
                                <Percent className="w-6 h-6 text-yellow-500" />
                                <div>
                                    <p className="text-xs font-bold uppercase text-muted-foreground">{t('revenue.returnRate') || 'Return Rate'}</p>
                                    <p className="text-2xl font-black text-yellow-600 dark:text-yellow-400 tabular-nums">
                                        {returnsData.returnRate.toFixed(1)}%
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Trend Chart */}
                        <Card className="bg-card/40 border-border/30 backdrop-blur-md overflow-hidden rounded-[2rem] shadow-sm">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground/70 flex items-center gap-2">
                                    <TrendingDown className="w-3.5 h-3.5" />
                                    {t('revenue.returnTrend') || 'Return Trend'}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pt-4">
                                <ResponsiveContainer width="100%" height={250}>
                                    <AreaChart data={returnsData.trendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                        <defs>
                                            <linearGradient id="colorReturns" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                                                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                                        <XAxis
                                            dataKey="date"
                                            axisLine={false}
                                            tickLine={false}
                                            tick={{ fontSize: 9, fontWeight: 700, fill: 'currentColor' }}
                                            className="text-muted-foreground/60"
                                            reversed={isRtl}
                                        />
                                        <YAxis
                                            axisLine={false}
                                            tickLine={false}
                                            tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }}
                                            className="text-muted-foreground/60"
                                            allowDecimals={false}
                                            orientation={isRtl ? 'right' : 'left'}
                                        />
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: 'hsl(var(--card))',
                                                borderRadius: '16px',
                                                border: '1px solid hsl(var(--border))',
                                                padding: '10px'
                                            }}
                                            formatter={(value: any) => [value, t('revenue.returns') || 'Returns']}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="count"
                                            stroke="#ef4444"
                                            strokeWidth={3}
                                            fillOpacity={1}
                                            fill="url(#colorReturns)"
                                        />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </CardContent>
                        </Card>

                        {/* Top Returned Products */}
                        <Card className="bg-card/40 border-border/30 backdrop-blur-md overflow-hidden rounded-[2rem] shadow-sm">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground/70 flex items-center gap-2">
                                    <Package className="w-3.5 h-3.5" />
                                    {t('revenue.topReturned') || 'Top Returned Products'}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pt-4">
                                {returnsData.topReturnedProducts.length > 0 ? (
                                    <div dir="ltr" className="w-full h-[250px]">
                                        <ResponsiveContainer width="100%" height={250}>
                                            <PieChart>
                                                <Pie
                                                    data={returnsData.topReturnedProducts}
                                                    dataKey="count"
                                                    nameKey="name"
                                                    cx="50%"
                                                    cy="50%"
                                                    outerRadius={80}
                                                    innerRadius={40}
                                                    paddingAngle={2}
                                                    label={(props: { name?: string, percent?: number }) => {
                                                        const n = props.name || 'Unknown'
                                                        const p = props.percent || 0
                                                        return `${n.substring(0, 10)}${n.length > 10 ? '...' : ''} (${(p * 100).toFixed(0)}%)`
                                                    }}
                                                    labelLine={false}
                                                >
                                                    {returnsData.topReturnedProducts.map((_, i) => (
                                                        <Cell key={`cell-${i}`} fill={COLORS[i % COLORS.length]} />
                                                    ))}
                                                </Pie>
                                                <Tooltip
                                                    contentStyle={{
                                                        backgroundColor: 'hsl(var(--card))',
                                                        borderRadius: '16px',
                                                        border: '1px solid hsl(var(--border))',
                                                        padding: '10px'
                                                    }}
                                                    formatter={(value: any, name: any) => [value, name]}
                                                />
                                            </PieChart>
                                        </ResponsiveContainer>
                                    </div>
                                ) : (
                                    <div className="h-[250px] flex items-center justify-center text-muted-foreground/60 text-sm font-medium">
                                        {t('revenue.noReturns') || 'No returns recorded'}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
