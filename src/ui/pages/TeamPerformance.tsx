import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { User } from '@/local-db/models'
import { db } from '@/local-db/database'
import { Sale } from '@/types'
import { formatCurrency, formatDateTime, formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
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
    Button,
    Input,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/ui/components'
import {
    BarChart3,
    TrendingUp,
    Users,
    UsersRound,
    Target,
    Printer,
    Loader2,
    PieChart as PieIcon
} from 'lucide-react'
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
import { useReactToPrint } from 'react-to-print'

interface StaffPerformance {
    id: string
    name: string
    role: string
    salesCount: number
    totalRevenue: number // In USD (settlement or converted)
    revenueByCurrency: Record<string, number>
    target: number
    progress: number
    dailySales: Record<string, number>
    dailySalesCount: Record<string, number>
}

export function TeamPerformance() {
    const { user } = useAuth()
    const { t, i18n } = useTranslation()
    const { features, workspaceName, isLocalMode } = useWorkspace()
    const [sales, setSales] = useState<Sale[]>([])
    const [members, setMembers] = useState<User[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const { dateRange, customDates } = useDateRange()
    const [isTargetDialogOpen, setIsTargetDialogOpen] = useState(false)
    const [selectedMember, setSelectedMember] = useState<User | null>(null)
    const [newTarget, setNewTarget] = useState('')

    const reportRef = useRef<HTMLDivElement>(null)

    const handlePrint = useReactToPrint({
        contentRef: reportRef,
        documentTitle: `Team_Performance_Report_${new Date().toISOString().split('T')[0]}`,
    })

    const fetchData = async () => {
        setIsLoading(true)
        try {
            // Initial load from local Dexie for fast start
            const workspaceId = user?.workspaceId || ''
            const localProfiles = await db.users.where('workspaceId').equals(workspaceId).toArray()
            if (localProfiles.length > 0 && members.length === 0) {
                setMembers(localProfiles)
            }

            if (isLocalMode) {
                const fallbackMembers = localProfiles.length > 0
                    ? localProfiles
                    : (user ? [{
                        id: user.id,
                        workspaceId,
                        email: user.email,
                        name: user.name,
                        role: user.role,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        syncStatus: 'synced' as const,
                        lastSyncedAt: null,
                        version: 1,
                        isDeleted: false
                    } as User] : [])

                const localSales = await db.sales.where('workspaceId').equals(workspaceId).toArray()
                const filteredLocalSales = localSales.filter((sale) => {
                    const saleDate = new Date(sale.createdAt)
                    const now = new Date()

                    if (dateRange === 'today') {
                        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
                        return saleDate >= startOfDay
                    }

                    if (dateRange === 'month') {
                        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
                        return saleDate >= startOfMonth
                    }

                    if (dateRange === 'custom' && customDates.start && customDates.end) {
                        const start = new Date(customDates.start)
                        start.setHours(0, 0, 0, 0)
                        const end = new Date(customDates.end)
                        end.setHours(23, 59, 59, 999)
                        return saleDate >= start && saleDate <= end
                    }

                    return true
                })

                const saleIds = filteredLocalSales.map((sale) => sale.id)
                const localSaleItems = saleIds.length > 0
                    ? await db.sale_items.where('saleId').anyOf(saleIds).toArray()
                    : []
                const saleItemsBySaleId = localSaleItems.reduce<Record<string, typeof localSaleItems>>((acc, item) => {
                    if (!acc[item.saleId]) {
                        acc[item.saleId] = []
                    }
                    acc[item.saleId].push(item)
                    return acc
                }, {})

                setMembers(fallbackMembers)
                setSales(filteredLocalSales
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                    .map((sale) => ({
                        ...sale,
                        cashier_id: sale.cashierId,
                        total_amount: sale.totalAmount,
                        settlement_currency: sale.settlementCurrency,
                        created_at: sale.createdAt,
                        exchange_rate: sale.exchangeRate,
                        is_returned: sale.isReturned,
                        sale_items: (saleItemsBySaleId[sale.id] || []).map((item) => ({
                            ...item,
                            converted_unit_price: item.convertedUnitPrice,
                            returned_quantity: item.returnedQuantity
                        }))
                    })) as unknown as Sale[])
                return
            }

            // Fetch members from Supabase
            const { data: profiles, error: pError } = await supabase
                .from('profiles')
                .select('*')
                .eq('workspace_id', workspaceId)

            if (pError) throw pError

            // Map Supabase property 'monthly_target' to local 'monthlyTarget'
            const profilesData = (profiles || []).map(p => ({
                ...p,
                monthlyTarget: p.monthly_target
            }))

            setMembers(profilesData)

            // Sync to local Dexie
            if (profilesData.length > 0) {
                const profilesToSync = profilesData.map(p => {
                    const local = localProfiles.find(lp => lp.id === p.id)
                    return {
                        ...p,
                        monthlyProgress: local?.monthlyProgress
                    }
                })
                await db.users.bulkPut(profilesToSync)
            }

            // Fetch sales within range
            let query = supabase
                .from('sales')
                .select('*, sale_items(*)')
                .eq('workspace_id', user?.workspaceId)

            const now = new Date()
            if (dateRange === 'today') {
                const startOfDay = new Date(now.setHours(0, 0, 0, 0)).toISOString()
                query = query.gte('created_at', startOfDay)
            } else if (dateRange === 'month') {
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
                query = query.gte('created_at', startOfMonth)
            } else if (dateRange === 'custom' && customDates.start && customDates.end) {
                const start = new Date(customDates.start)
                start.setHours(0, 0, 0, 0)
                const end = new Date(customDates.end)
                end.setHours(23, 59, 59, 999)
                query = query.gte('created_at', start.toISOString()).lte('created_at', end.toISOString())
            } else if (dateRange === 'allTime') {
                // No date filtering needed
            }

            const { data: salesData, error: sError } = await query.order('created_at', { ascending: true })
            if (sError) throw sError
            setSales(salesData || [])
        } catch (err) {
            console.error('Error fetching performance data:', err)
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => {
        if (user?.workspaceId) {
            fetchData()
        }
    }, [customDates, dateRange, isLocalMode, user?.workspaceId])

    const calculatePerformance = () => {
        const perfMap: Record<string, StaffPerformance> = {}
        const statsByCurrency: Record<string, number> = {}
        const globalDailyTrend: Record<string, Record<string, number>> = {}

        // Initialize with all members if admin, or just self if staff
        members.forEach(m => {
            if (user?.role !== 'admin' && user?.role !== 'viewer' && m.id !== user?.id) return

            perfMap[m.id] = {
                id: m.id,
                name: m.name,
                role: m.role,
                salesCount: 0,
                totalRevenue: 0,
                revenueByCurrency: {},
                target: m.monthlyTarget || 0,
                progress: 0,
                dailySales: {},
                dailySalesCount: {}
            }
        })

        sales.forEach(sale => {
            // Skip returned sales from performance calculations
            if (sale.is_returned) return

            const cashierId = sale.cashier_id
            if (!perfMap[cashierId]) return

            perfMap[cashierId].salesCount++

            // Calculate net revenue (accounting for partial returns)
            let saleRevenue = 0
            const saleItems = (sale as any).sale_items || []

            if (saleItems.length > 0) {
                saleItems.forEach((item: any) => {
                    const netQuantity = item.quantity - (item.returned_quantity || 0)
                    if (netQuantity > 0) {
                        saleRevenue += (item.converted_unit_price || 0) * netQuantity
                    }
                })
            } else {
                // Fallback to total_amount if items are missing from query/data
                saleRevenue = sale.total_amount
            }

            // Multi-currency aggregation
            const currency = sale.settlement_currency || 'usd'
            statsByCurrency[currency] = (statsByCurrency[currency] || 0) + saleRevenue
            perfMap[cashierId].revenueByCurrency[currency] = (perfMap[cashierId].revenueByCurrency[currency] || 0) + saleRevenue

            // Project revenue into DEFAULT CURRENCY for the trend chart
            const defaultCurrency = features.default_currency || 'usd'
            let revenueInDefault = saleRevenue

            if (currency !== defaultCurrency) {
                if (defaultCurrency === 'iqd' && currency === 'usd' && sale.exchange_rate) {
                    revenueInDefault = saleRevenue * (sale.exchange_rate / 100)
                } else if (defaultCurrency === 'usd' && currency === 'iqd' && sale.exchange_rate) {
                    revenueInDefault = saleRevenue / (sale.exchange_rate / 100)
                } else {
                    let revenueInUsd = saleRevenue
                    if (currency !== 'usd' && sale.exchange_rate) {
                        revenueInUsd = saleRevenue / (sale.exchange_rate / 100)
                    }

                    if (defaultCurrency === 'usd') {
                        revenueInDefault = revenueInUsd
                    } else if (defaultCurrency === 'iqd' && sale.exchange_rate) {
                        revenueInDefault = revenueInUsd * (sale.exchange_rate / 100)
                    }
                }
            }

            // Global Daily Trend by Member (Sales Count)
            const date = new Date(sale.created_at).toISOString().split('T')[0]
            if (!globalDailyTrend[date]) {
                globalDailyTrend[date] = {}
                // Initialize all tracked members to 0 for this date
                Object.keys(perfMap).forEach(mid => {
                    globalDailyTrend[date][mid] = 0
                })
            }

            // Member-based count (for graph)
            globalDailyTrend[date][cashierId] = (globalDailyTrend[date][cashierId] || 0) + 1

            perfMap[cashierId].totalRevenue += revenueInDefault
            perfMap[cashierId].dailySales[date] = (perfMap[cashierId].dailySales[date] || 0) + revenueInDefault
            perfMap[cashierId].dailySalesCount[date] = (perfMap[cashierId].dailySalesCount[date] || 0) + 1
        })

        // Finalize progress
        Object.values(perfMap).forEach(p => {
            if (p.target > 0) {
                p.progress = (p.salesCount / p.target) * 100
                db.users.update(p.id, { monthlyProgress: p.progress }).catch(console.error)
            }
        })

        return {
            performanceData: Object.values(perfMap).sort((a, b) => {
                if (b.salesCount !== a.salesCount) return b.salesCount - a.salesCount
                return b.totalRevenue - a.totalRevenue
            }),
            statsByCurrency,
            globalDailyTrend
        }
    }

    const getDateRangeDisplay = () => {
        if (dateRange === 'today') return t('performance.filters.today')
        if (dateRange === 'month') return t('performance.filters.thisMonth')
        if (dateRange === 'allTime') {
            if (sales && sales.length > 0) {
                const dates = sales.map(s => new Date(s.created_at).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.allTime')}, ${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }
            return t('performance.filters.allTime') || 'All Time'
        }
        if (dateRange === 'custom') {
            if (customDates.start && customDates.end) {
                return `${formatDate(customDates.start)} ${t('common.to') || 'to'} ${formatDate(customDates.end)}`
            }
            return t('performance.filters.custom')
        }
        return ''
    }

    const getDateDisplay = () => {
        if (dateRange === 'today') {
            return formatDate(new Date())
        }
        if (dateRange === 'month') {
            const now = new Date()
            return formatLocalizedMonthYear(now, i18n.language)
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
        if (dateRange === 'custom') {
            if (sales && sales.length > 0) {
                const dates = sales.map(s => new Date(s.created_at).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }
            if (customDates.start && customDates.end) {
                return `${t('performance.filters.from')} ${formatDate(customDates.start)} ${t('performance.filters.to')} ${formatDate(customDates.end)}`
            }
        }
        return ''
    }

    const { performanceData, statsByCurrency, globalDailyTrend } = calculatePerformance()

    // Chart Data Preparation
    const pieData = performanceData.map(p => ({
        name: p.name,
        value: p.salesCount
    }))

    const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d']

    const trendData = useMemo(() => {
        return Object.entries(globalDailyTrend)
            .map(([date, currencies]) => ({
                date,
                ...currencies
            }))
            .sort((a, b) => a.date.localeCompare(b.date))
    }, [globalDailyTrend])


    const handleUpdateTarget = async () => {
        if (!selectedMember) return

        const targetValue = parseFloat(newTarget)
        if (isNaN(targetValue)) return

        try {
            if (!isLocalMode) {
                const { error } = await supabase
                    .from('profiles')
                    .update({ monthly_target: targetValue })
                    .eq('id', selectedMember.id)

                if (error) throw error
            }

            // Update local Dexie
            await db.users.update(selectedMember.id, {
                monthlyTarget: targetValue
            })

            // Refresh local state
            setMembers(prev => prev.map(m => m.id === selectedMember.id ? { ...m, monthlyTarget: targetValue } : m))
            setIsTargetDialogOpen(false)
            setSelectedMember(null)
            setNewTarget('')
        } catch (err) {
            console.error('Error updating target:', err)
        }
    }

    if (isLoading && members.length === 0) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                    <div>
                        <div className="flex items-center gap-3">
                            <h1 className="text-2xl font-bold flex items-center gap-2">
                                <BarChart3 className="w-6 h-6 text-primary" />
                                {t('performance.title')}
                                {isLoading && (
                                    <Loader2 className="w-4 h-4 animate-spin text-primary/50 ml-1" />
                                )}
                            </h1>
                            {getDateDisplay() && (
                                <div className="px-3 py-1 text-sm font-bold bg-primary text-primary-foreground rounded-lg shadow-sm animate-pop-in">
                                    {getDateDisplay()}
                                </div>
                            )}
                        </div>
                        <p className="text-muted-foreground">{t('performance.subtitle')}</p>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <DateRangeFilters />

                    {(user?.role === 'admin' || user?.role === 'viewer') && (
                        <Button variant="outline" size="sm" allowViewer={true} onClick={() => handlePrint()} className="gap-2 h-9">
                            <Printer className="w-4 h-4" />
                            {t('report.print') || 'Print Report'}
                        </Button>
                    )}
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card className="bg-primary/5 border-primary/20">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-primary flex items-center gap-2">
                            <TrendingUp className="w-4 h-4" />
                            {t('performance.stats.totalSales')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        {Object.entries(statsByCurrency).map(([curr, amount]) => (
                            <div key={curr}>
                                <div className="text-2xl font-bold">
                                    {formatCurrency(amount, curr as any, features.iqd_display_preference)}
                                </div>
                            </div>
                        ))}
                        {Object.keys(statsByCurrency).length === 0 && (
                            <div className="text-2xl font-bold">
                                {formatCurrency(0, 'usd', features.iqd_display_preference)}
                            </div>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                            {sales.length} {t('performance.stats.totalTransactions')}
                        </p>
                    </CardContent>
                </Card>

                <Card className="bg-emerald-500/5 border-emerald-500/20">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-emerald-600 flex items-center gap-2">
                            <Target className="w-4 h-4" />
                            {t('performance.stats.meetingTarget')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-emerald-600">
                            {performanceData.filter(p => p.progress >= 100).length} / {performanceData.length}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                            {t('performance.stats.aboveTarget')}
                        </p>
                    </CardContent>
                </Card>

                <Card className="bg-purple-500/5 border-purple-500/20">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-purple-600 flex items-center gap-2">
                            <UsersRound className="w-4 h-4" />
                            {t('performance.stats.topPerformer')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold text-purple-600 truncate">
                            {performanceData[0]?.name || 'N/A'}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                            {t('performance.stats.topContributor')}
                        </p>
                    </CardContent>
                </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Performance Table */}
                <Card className="lg:col-span-2">
                    <CardHeader>
                        <CardTitle className="text-lg flex items-center gap-2">
                            <Users className="w-5 h-5 text-primary" />
                            {t('performance.title')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="text-start">{t('performance.table.name')}</TableHead>
                                    <TableHead className="text-end">{t('performance.table.salesCount')}</TableHead>
                                    <TableHead className="text-end">{t('performance.table.totalRevenue')}</TableHead>
                                    <TableHead className="text-end">{t('performance.table.target')}</TableHead>
                                    <TableHead className="text-end">{t('performance.table.progress')}</TableHead>
                                    {user?.role === 'admin' && <TableHead className="w-[50px]"></TableHead>}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {performanceData.map((p) => (
                                    <TableRow key={p.id}>
                                        <TableCell className="text-start">
                                            <div className="font-medium">{p.name}</div>
                                            <div className="text-[10px] text-muted-foreground capitalize">{p.role}</div>
                                        </TableCell>
                                        <TableCell className="text-end font-mono">
                                            {p.salesCount}
                                        </TableCell>
                                        <TableCell className="text-end font-bold space-y-1 py-3">
                                            {Object.entries(p.revenueByCurrency).map(([curr, amount]) => (
                                                <div key={curr}>
                                                    {formatCurrency(amount, curr as any, features.iqd_display_preference)}
                                                </div>
                                            ))}
                                            {Object.keys(p.revenueByCurrency).length === 0 && (
                                                <div>
                                                    {formatCurrency(0, 'usd', features.iqd_display_preference)}
                                                </div>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-end text-muted-foreground font-mono">
                                            {p.target > 0 ? p.target : '-'}
                                        </TableCell>
                                        <TableCell className="text-end">
                                            <div className="flex flex-col items-end gap-1">
                                                <span className={cn(
                                                    "text-[10px] font-bold px-1.5 py-0.5 rounded-full",
                                                    p.progress >= 100 ? "bg-emerald-500/10 text-emerald-600" :
                                                        p.progress >= 50 ? "bg-orange-500/10 text-orange-600" :
                                                            "bg-destructive/10 text-destructive"
                                                )}>
                                                    {p.progress.toFixed(1)}%
                                                </span>
                                                <div className="w-24 h-1 bg-secondary rounded-full overflow-hidden">
                                                    <div
                                                        className={cn(
                                                            "h-full transition-all",
                                                            p.progress >= 100 ? "bg-emerald-500" :
                                                                p.progress >= 50 ? "bg-orange-500" :
                                                                    "bg-destructive"
                                                        )}
                                                        style={{ width: `${Math.min(p.progress, 100)}%` }}
                                                    />
                                                </div>
                                            </div>
                                        </TableCell>
                                        {user?.role === 'admin' && (
                                            <TableCell className="text-end">
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => {
                                                        const member = members.find(m => m.id === p.id)
                                                        if (member) {
                                                            setSelectedMember(member)
                                                            setNewTarget(member.monthlyTarget?.toString() || '')
                                                            setIsTargetDialogOpen(true)
                                                        }
                                                    }}
                                                >
                                                    <Target className="w-4 h-4 opacity-50 hover:opacity-100" />
                                                </Button>
                                            </TableCell>
                                        )}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>

                {/* Sales Share Pie Chart */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg flex items-center gap-2">
                            <PieIcon className="w-5 h-5 text-primary" />
                            {t('performance.charts.share')}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground">Based on number of sales</p>
                    </CardHeader>
                    <CardContent className="h-[300px]">
                        <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                                <Pie
                                    data={pieData}
                                    cx="50%"
                                    cy="50%"
                                    innerRadius={60}
                                    outerRadius={80}
                                    paddingAngle={5}
                                    dataKey="value"
                                >
                                    {pieData.map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                                    ))}
                                </Pie>
                                <Tooltip
                                    contentStyle={{
                                        backgroundColor: 'hsl(var(--card))',
                                        borderColor: 'hsl(var(--border))',
                                        borderRadius: '8px'
                                    }}
                                />
                                <Legend verticalAlign="bottom" height={36} />
                            </PieChart>
                        </ResponsiveContainer>
                    </CardContent>
                </Card>
            </div>

            {/* Performance Trend Chart */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg flex items-center gap-2">
                        <TrendingUp className="w-5 h-5 text-primary" />
                        {t('performance.charts.trendCount') || 'Sales Count Trend'}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">{t('performance.charts.salesTrendDesc') || 'Transaction volume across team members'}</p>
                </CardHeader>
                <CardContent className="h-[400px]">
                    <div className="flex flex-wrap gap-4 mb-4 px-2">
                        {performanceData.map((p, idx) => (
                            <div key={p.id} className="flex items-center gap-1.5 bg-secondary/30 px-2 py-1 rounded-lg border border-border/50">
                                <div
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: COLORS[idx % COLORS.length] }}
                                />
                                <span className="text-[10px] font-black uppercase tracking-tight opacity-70">
                                    {p.name}
                                </span>
                            </div>
                        ))}
                    </div>
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={trendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                            <defs>
                                {performanceData.map((p, idx) => (
                                    <linearGradient key={`grad-${p.id}`} id={`color-${p.id}`} x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor={COLORS[idx % COLORS.length]} stopOpacity={0.3} />
                                        <stop offset="95%" stopColor={COLORS[idx % COLORS.length]} stopOpacity={0} />
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
                                tickFormatter={(val) => formatDate(val)}
                                dy={10}
                            />
                            <YAxis
                                axisLine={false}
                                tickLine={false}
                                tick={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }}
                                className="text-muted-foreground/60"
                                allowDecimals={false}
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
                                labelFormatter={(label) => formatDate(String(label))}
                                formatter={(value: any, name: any) => {
                                    const member = performanceData.find(p => p.id === name)
                                    return [
                                        `${value} ${t('common.sales') || 'sales'}`,
                                        member?.name || name
                                    ]
                                }}
                            />
                            {performanceData.map((p, idx) => (
                                <Area
                                    key={p.id}
                                    type="monotone"
                                    dataKey={p.id}
                                    stroke={COLORS[idx % COLORS.length]}
                                    strokeWidth={3}
                                    fillOpacity={1}
                                    fill={`url(#color-${p.id})`}
                                    animationDuration={1500}
                                />
                            ))}
                        </AreaChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>

            {/* Set Target Dialog */}
            <Dialog open={isTargetDialogOpen} onOpenChange={setIsTargetDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('performance.form.setTarget')}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <label className="text-sm font-medium">{t('performance.form.targetAmount')}</label>
                            <Input
                                type="number"
                                value={newTarget}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewTarget(e.target.value)}
                                placeholder="0"
                                className="font-mono"
                            />
                            <p className="text-xs text-muted-foreground">
                                {t('performance.form.settingTargetFor')}: <span className="font-bold">{selectedMember?.name}</span>
                            </p>
                        </div>
                        <Button onClick={handleUpdateTarget} className="w-full">
                            {t('common.save')}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Hidden Report Container for Printing */}
            <div style={{ display: 'none' }}>
                <div ref={reportRef} className="p-12 space-y-8 bg-white text-black font-sans">
                    <div className="flex justify-between items-start border-b-2 border-black pb-4">
                        <div>
                            <h1 className="text-3xl font-black uppercase tracking-tighter">{t('performance.report.title')}</h1>
                            <p className="text-sm opacity-70 italic">{workspaceName || 'Atlas'}</p>
                        </div>
                        <div className="text-right">
                            <p className="text-xs uppercase font-bold text-gray-500">{t('performance.report.period')}</p>
                            <p className="text-sm font-black">{getDateRangeDisplay()}</p>
                            <div className="mt-2">
                                <p className="text-[9px] uppercase font-bold text-gray-400">{t('performance.report.generatedOn')}</p>
                                <p className="text-xs">{formatDateTime(new Date())}</p>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                        <div className="p-4 border border-black bg-gray-50 flex flex-col gap-1">
                            <p className="text-[10px] uppercase font-bold">{t('performance.table.totalRevenue')}</p>
                            {Object.entries(statsByCurrency).map(([curr, amount]) => (
                                <p key={curr} className="text-xl font-black">
                                    {formatCurrency(amount, curr as any, features.iqd_display_preference)}
                                </p>
                            ))}
                            {Object.keys(statsByCurrency).length === 0 && (
                                <p className="text-xl font-black">{formatCurrency(0, 'usd', features.iqd_display_preference)}</p>
                            )}
                        </div>
                        <div className="p-4 border border-black bg-gray-50">
                            <p className="text-[10px] uppercase font-bold">{t('performance.table.salesCount')}</p>
                            <p className="text-xl font-black">{sales.length}</p>
                        </div>
                        <div className="p-4 border border-black bg-gray-50">
                            <p className="text-[10px] uppercase font-bold">{t('performance.stats.topPerformer')}</p>
                            <p className="text-xl font-black">{performanceData[0]?.name || 'N/A'}</p>
                        </div>
                    </div>

                    <table className="w-full border-collapse">
                        <thead>
                            <tr className="border-b-2 border-black">
                                <th className="text-left py-2 text-xs uppercase">{t('performance.table.name')}</th>
                                <th className="text-right py-2 text-xs uppercase">{t('performance.table.salesCount')}</th>
                                <th className="text-right py-2 text-xs uppercase">{t('performance.table.totalRevenue')}</th>
                                <th className="text-right py-2 text-xs uppercase">{t('performance.table.target')}</th>
                                <th className="text-right py-2 text-xs uppercase">{t('performance.table.progress')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {performanceData.map(p => (
                                <tr key={p.id} className="border-b border-gray-200">
                                    <td className="py-2 text-sm font-bold">{p.name}</td>
                                    <td className="py-2 text-right text-sm font-mono">{p.salesCount}</td>
                                    <td className="py-2 text-right text-sm font-bold flex flex-col items-end">
                                        {Object.entries(p.revenueByCurrency).map(([curr, amount]) => (
                                            <div key={curr}>
                                                {formatCurrency(amount, curr as any, features.iqd_display_preference)}
                                            </div>
                                        ))}
                                        {Object.keys(p.revenueByCurrency).length === 0 && (
                                            <div>
                                                {formatCurrency(0, 'usd', features.iqd_display_preference)}
                                            </div>
                                        )}
                                    </td>
                                    <td className="py-2 text-right text-sm font-mono">{p.target > 0 ? p.target : '-'}</td>
                                    <td className="py-2 text-right text-sm font-black">{p.progress.toFixed(1)}%</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <div className="mt-8 border-t-2 border-black pt-4 grid grid-cols-2 gap-8">
                        <div>
                            <p className="text-xs font-bold uppercase mb-2">{t('performance.report.summary')}</p>
                            <p className="text-[10px] leading-relaxed italic opacity-70">
                                {t('performance.report.description')}
                            </p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                            <div className="text-[10px] uppercase font-bold">{t('performance.report.signature')}</div>
                            <div className="w-48 h-12 border-b border-black mt-2"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
