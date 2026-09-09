import { useMemo } from 'react'
import { useDashboardStats, useSales, usePaymentTransactions, usePaymentObligations, useExpenseItems, useEmployees, usePayrollStatuses, useDividendStatuses, useExchangeTransactions, useLoans } from '@/local-db'
import { convertToStoreBase } from '@/lib/currency'
import { calculateNetProfitForMonth, buildPayrollItems, buildDividendItems } from '@/lib/budget'
import { getLedgerCashMovementEntries } from '@/lib/ledgerCashMovementEntries'
import { summarizeLedgerCashMovementsByCurrency } from '@/lib/ledgerCashSummary'
import { isLedgerCashFlowDirection } from '@/lib/ledgerFlow'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components'
import { cn, formatCurrency, formatDate, formatOriginLabel } from '@/lib/utils'
import { Package, FileText, DollarSign, AlertTriangle, Receipt, ArrowUpRight, Wallet, ClipboardCheck } from 'lucide-react'
import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { DashboardSalesOverview } from '@/ui/components/DashboardSalesOverview'
import { useDateRange } from '@/context/DateRangeContext'
import { useWorkspacePermissions } from '@/permissions'
import { isDateInDateRange } from '@/lib/dateRangeFilters'

function isEntryInDateRange(
    date: string,
    dateRange: 'today' | 'yesterday' | 'month' | 'lastMonth' | 'allTime' | 'custom',
    customDates: { start: string; end: string },
    now = new Date()
) {
    return isDateInDateRange(date, dateRange, customDates, now)
}

export function Dashboard() {
    const { user } = useAuth()
    const firstName = user?.name?.split(' ')[0] || ''
    const { features, hasFeature } = useWorkspace()
    const { hasPermission } = useWorkspacePermissions()
    const sales = useSales(user?.workspaceId)
    const { dateRange, customDates } = useDateRange()
    const { t } = useTranslation()
    const workspaceId = user?.workspaceId
    
    // Budget & Outstanding data
    const currentMonth = useMemo(() => {
        const d = new Date()
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    }, [])

    const expenseItems = useExpenseItems(workspaceId, currentMonth)
    const employees = useEmployees(workspaceId)
    const payrollStatuses = usePayrollStatuses(workspaceId)
    const dividendStatuses = useDividendStatuses(workspaceId)

    // Ledger-backed movements shared by the desktop headline and mobile money overview.
    const transactions = usePaymentTransactions(workspaceId, { includeReversals: true }, { hydrateSourceTables: false })
    const obligations = usePaymentObligations(workspaceId)
    const loans = useLoans(workspaceId)
    const exchangeTransactions = useExchangeTransactions(workspaceId)

    const totalOutstanding = useMemo(() => {
        if (!workspaceId) return {}
        
        // Match MonthlyComparison/Accounting Outstanding logic
        const baseCurrency = 'iqd' // Usually the store base
        const rates = { usd_iqd: 1500, eur_iqd: 1600, try_iqd: 50 } // Fallback rates if snapshot missing
        
        const payrollItems = buildPayrollItems(employees || [], payrollStatuses || [], currentMonth as any)
        const netProfitBase = calculateNetProfitForMonth(sales as any || [], currentMonth as any, baseCurrency as any, rates)
        
        let operationalTotal = 0
        let operationalPaid = 0
        expenseItems?.forEach(item => {
            const base = convertToStoreBase(item.amount, item.currency, baseCurrency, rates)
            operationalTotal += base
            if (item.status === 'paid') operationalPaid += base
        })

        let payrollTotal = 0
        let payrollPaid = 0
        payrollItems.forEach(item => {
            const base = convertToStoreBase(item.amount, item.currency, baseCurrency, rates)
            payrollTotal += base
            if (item.status === 'paid') payrollPaid += base
        })

        const surplusPoolBase = netProfitBase - operationalTotal - payrollTotal
        const dividendResult = buildDividendItems(employees || [], dividendStatuses || [], currentMonth as any, baseCurrency as any, rates, surplusPoolBase)
        const dividendsTotal = dividendResult.totalBase
        const dividendsPaid = dividendResult.items.reduce((sum, item) => item.status === 'paid' ? sum + item.baseAmount : sum, 0)

        const totalAllocated = operationalTotal + payrollTotal
        const paid = operationalPaid + payrollPaid + dividendsPaid
        const outstanding = (totalAllocated + dividendsTotal) - paid
        
        return { [baseCurrency]: Math.max(0, outstanding) }
    }, [workspaceId, expenseItems, employees, payrollStatuses, dividendStatuses, sales, currentMonth])

    const netRecordedCashMovement = useMemo(() => {
        const now = new Date()
        const entries = getLedgerCashMovementEntries({ sales, paymentTransactions: transactions, loans, exchangeTransactions })
        const summaries = summarizeLedgerCashMovementsByCurrency(
            entries.filter(
                (entry) =>
                    isLedgerCashFlowDirection(entry.direction) &&
                    isEntryInDateRange(entry.date, dateRange, customDates, now),
            ),
        )

        return Object.fromEntries(
            summaries.map(({ currency, summary }) => [currency, summary.netRecordedCashMovement]),
        )
    }, [sales, transactions, loans, exchangeTransactions, dateRange, customDates])

    const pendingPaymentsCount = obligations?.filter(o => o.status === 'open' || o.status === 'overdue').length || 0
    const stats = useDashboardStats(workspaceId)

    const showNetFlow = hasPermission('ledger.access')
    const showOutstanding = hasFeature('budget') && hasPermission('budget.access')
    const showPendingPayments = hasPermission('payment.access')
    const visibleCardsCount = [showNetFlow, showOutstanding, showPendingPayments].filter(Boolean).length

    if (!stats) return null

    if (visibleCardsCount === 0) return (
        <div className="space-y-6 pb-12" data-tour-id="demo-basic-dashboard">
            {firstName && (
                <div className="block md:hidden -mx-4 -mt-6 px-5 pt-8 pb-6 bg-primary rounded-b-[2rem] shadow-lg shadow-primary/20 dark:shadow-primary/10">
                    <h1 className="text-3xl font-black tracking-tight text-primary-foreground">
                        {t('dashboard.greeting', { name: firstName })}
                    </h1>
                    <p className="text-sm font-medium text-primary-foreground/70 mt-1">
                        {t('dashboard.greetingSubtitle')}
                    </p>
                </div>
            )}
            <div className="hidden md:contents">
                {/* Desktop-only content rendering... */}
            </div>
        </div>
    )

    const statCards = [
        {
            title: t('dashboard.totalProducts') || 'Total Products',
            value: stats.productCount,
            icon: Package,
            color: 'text-blue-500',
            bgColor: 'bg-blue-500/10',
            href: '/products'
        },
        {
            title: t('ledger.cashSummary.headline.title'),
            value: netRecordedCashMovement,
            icon: DollarSign,
            color: 'text-primary',
            bgColor: 'bg-primary/10',
            href: '/ledger',
            isCurrencySummary: true
        }
    ]


    return (
        <div className="space-y-6 md:space-y-12 pb-12" data-tour-id="demo-basic-dashboard">
            {/* Mobile Hero Header — visually linked to the sticky bar */}
            {firstName && (
                <div className="block md:hidden -mx-4 -mt-6 px-5 pt-8 pb-6 bg-primary rounded-b-[2rem] shadow-lg shadow-primary/20 dark:shadow-primary/10">
                    <h1 className="text-3xl font-black tracking-tight text-primary-foreground">
                        {t('dashboard.greeting', { name: firstName })}
                    </h1>
                    <p className="text-sm font-medium text-primary-foreground/70 mt-1">
                        {t('dashboard.greetingSubtitle')}
                    </p>
                </div>
            )}

            {/* Money Overview Section - Mobile Only */}
            <div className="block md:hidden space-y-4 px-2 pb-8">
                <div className="flex items-center justify-between px-1">
                    <h2 className="text-xl font-black tracking-tight">{t('dashboard.moneyOverview')}</h2>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
                        <Package className="w-3.5 h-3.5 text-emerald-600" />
                        <span className="text-[10px] font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                            {dateRange === 'month'
                                ? t('common.thisMonth') || 'This Month'
                                : dateRange === 'lastMonth'
                                    ? t('performance.filters.lastMonth')
                                    : t(`common.${dateRange}`)}
                        </span>
                    </div>
                </div>
                
                <div className={cn(
                    "grid gap-3.5",
                    visibleCardsCount === 3 && "grid-cols-3",
                    visibleCardsCount === 2 && "grid-cols-2",
                    visibleCardsCount === 1 && "grid-cols-1"
                )}>
                    {/* Net Flow Card */}
                    {showNetFlow && (
                        <Link href="/ledger">
                            <Card className="bg-card/40 backdrop-blur-xl rounded-3xl border-border/40 shadow-xl shadow-black/5 overflow-hidden h-48 flex flex-col items-center justify-between p-5 transition-all active:scale-95 text-center cursor-pointer">
                                <div className="flex flex-col items-center gap-3">
                                    <div className="text-emerald-500 bg-emerald-500/10 w-9 h-9 rounded-xl flex items-center justify-center shadow-inner">
                                        <Wallet className="w-4.5 h-4.5" />
                                    </div>
                                    <p className="text-[10px] font-black tracking-tight text-muted-foreground/70 leading-tight uppercase">
                                        {t('ledger.netFlow')}
                                    </p>
                                </div>
                                <div className="w-full space-y-0.5">
                                    {Object.keys(netRecordedCashMovement).length > 0 ? (
                                        Object.entries(netRecordedCashMovement).map(([curr, val]) => (
                                            <p key={curr} className={cn(
                                                "text-lg font-black tracking-tighter tabular-nums truncate",
                                                val >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"
                                            )}>
                                                {formatCurrency(val, curr as any, features.iqd_display_preference)}
                                            </p>
                                        ))
                                    ) : (
                                        <p className="text-lg font-black tracking-tighter tabular-nums text-muted-foreground/30">
                                            {formatCurrency(0, 'usd')}
                                        </p>
                                    )}
                                </div>
                            </Card>
                        </Link>
                    )}

                    {/* Outstanding Card */}
                    {showOutstanding && (
                        <Link href="/budget">
                            <Card className="bg-card/40 backdrop-blur-xl rounded-3xl border-border/40 shadow-xl shadow-black/5 overflow-hidden h-48 flex flex-col items-center justify-between p-5 transition-all active:scale-95 text-center cursor-pointer">
                                <div className="flex flex-col items-center gap-3">
                                    <div className="text-amber-500 bg-amber-500/10 w-9 h-9 rounded-xl flex items-center justify-center shadow-inner">
                                        <ArrowUpRight className="w-4.5 h-4.5" />
                                    </div>
                                    <p className="text-[10px] font-black tracking-tight text-muted-foreground/70 leading-tight uppercase">
                                        {t('dashboard.outstanding')}
                                    </p>
                                </div>
                                <div className="w-full space-y-0.5">
                                    {Object.keys(totalOutstanding).length > 0 ? (
                                        Object.entries(totalOutstanding).map(([curr, val]) => (
                                            <p key={curr} className="text-lg font-black tracking-tighter tabular-nums text-foreground/90 truncate">
                                                {formatCurrency(val, curr as any, features.iqd_display_preference)}
                                            </p>
                                        ))
                                    ) : (
                                        <p className="text-lg font-black tracking-tighter tabular-nums text-muted-foreground/30">
                                            {formatCurrency(0, 'usd')}
                                        </p>
                                    )}
                                </div>
                            </Card>
                        </Link>
                    )}

                    {/* Pending Payments Card */}
                    {showPendingPayments && (
                        <Link href="/payments">
                            <Card className="bg-card/40 backdrop-blur-xl rounded-3xl border-border/40 shadow-xl shadow-black/5 overflow-hidden h-48 flex flex-col items-center justify-between p-5 transition-all active:scale-95 text-center cursor-pointer">
                                <div className="flex flex-col items-center gap-3">
                                    <div className="text-blue-500 bg-blue-500/10 w-9 h-9 rounded-xl flex items-center justify-center shadow-inner">
                                        <ClipboardCheck className="w-4.5 h-4.5" />
                                    </div>
                                    <p className="text-[10px] font-black tracking-tight text-muted-foreground/70 leading-tight uppercase">
                                        {t('dashboard.pendingPayments')}
                                    </p>
                                </div>
                                <div className="w-full space-y-0.5">
                                    <p className="text-lg font-black tracking-tighter tabular-nums text-blue-600 dark:text-blue-400 truncate">
                                        {pendingPaymentsCount}
                                    </p>
                                    <p className="text-[9px] font-bold text-muted-foreground/40 uppercase tracking-widest">
                                        {pendingPaymentsCount === 1 ? t('payments.payment') : t('payments.payments')}
                                    </p>
                                </div>
                            </Card>
                        </Link>
                    )}
                </div>
            </div>

            {/* Desktop-only content */}
            <div className="hidden md:flex md:flex-col md:gap-12">

            {/* Stats Grid */}
            <div className="grid gap-4 md:gap-10 grid-cols-1 sm:grid-cols-2 lg:grid-cols-2">
                {statCards.map((stat) => (
                    <Link key={stat.title} href={stat.href}>
                        <Card className="cursor-pointer card-hover border-border/50 bg-card/50 backdrop-blur-sm rounded-[1.5rem] overflow-hidden">
                            <CardHeader className="flex flex-row items-center justify-between pb-2">
                                <CardTitle className="text-xs font-black uppercase tracking-widest text-muted-foreground/70">
                                    {stat.title}
                                </CardTitle>
                                <div className={`p-2.5 rounded-xl ${stat.bgColor} shadow-inner`}>
                                    <stat.icon className={`w-4 h-4 ${stat.color}`} />
                                </div>
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-black tracking-tight">
                                    {stat.isCurrencySummary ? (
                                        <div className="flex flex-col gap-0.5">
                                            {Object.entries(stat.value || {}).map(([curr, val]) => (
                                                <div key={curr} className="text-lg md:text-xl text-primary line-clamp-1 tabular-nums">
                                                    {formatCurrency(val as number, curr as any, features.iqd_display_preference)}
                                                </div>
                                            ))}
                                            {Object.keys(stat.value || {}).length === 0 && (
                                                <div className="text-lg md:text-xl tabular-nums">{formatCurrency(0, 'usd')}</div>
                                            )}
                                        </div>
                                    ) : (
                                        <span className="tabular-nums">{stat.value as any}</span>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </Link>
                ))}
            </div>

            <div className="grid gap-6 md:gap-10 lg:grid-cols-3">
                {/* Recent Sales (Replaces Recent Orders) */}
                <Card className="bg-card/40 border-border/30 backdrop-blur-md rounded-[2rem] overflow-hidden">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-3 text-lg font-black">
                            <div className="p-2 rounded-xl bg-primary/10">
                                <Receipt className="w-5 h-5 text-primary" />
                            </div>
                            {t('dashboard.recentSales') || 'Recent Sales'}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {stats.recentSales.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 opacity-40">
                                <Receipt className="w-12 h-12 mb-2" />
                                <p className="text-sm font-bold uppercase tracking-widest">
                                    {t('common.noData') || 'No sales yet'}
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {stats.recentSales.map((sale) => (
                                    <div
                                        key={sale.id}
                                        className="flex items-center justify-between p-4 rounded-3xl bg-secondary/30 hover:bg-secondary/50 transition-colors border border-transparent hover:border-border/50"
                                    >
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 rounded-full bg-background flex items-center justify-center font-black text-xs shadow-sm border border-border/20">
                                                #{sale.sequenceId || sale.id.slice(0, 4)}
                                            </div>
                                            <div>
                                                <p className="font-black text-sm uppercase tracking-tight">{t('common.sales')}</p>
                                                <p className="text-xs font-bold text-muted-foreground/60">
                                                    {formatDate(sale.createdAt)}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="font-black text-primary tabular-nums">
                                                {formatCurrency(sale.totalAmount, sale.settlementCurrency, features.iqd_display_preference)}
                                            </p>
                                            <p className="text-[10px] font-bold uppercase text-muted-foreground/60 tracking-wider">
                                                {formatOriginLabel(sale.origin, (sale as any)._sourceChannel ?? null)}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        <Link href="/sales" className="block mt-6 text-center text-xs font-black uppercase tracking-[0.2em] text-primary hover:text-primary/70 transition-colors">
                            {t('common.viewAll') || 'View All Sales'}
                        </Link>
                    </CardContent>
                </Card>

                {/* Low Stock Alert */}
                <Card className="bg-card/40 border-border/30 backdrop-blur-md rounded-[2rem] overflow-hidden">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-3 text-lg font-black">
                            <div className="p-2 rounded-xl bg-amber-500/10">
                                <AlertTriangle className="w-5 h-5 text-amber-500" />
                            </div>
                            {t('dashboard.lowStock')}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {stats.lowStockProducts.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 opacity-40">
                                <Package className="w-12 h-12 mb-2" />
                                <p className="text-sm font-bold uppercase tracking-widest">
                                    {t('dashboard.allStocked') || 'All products well stocked'}
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {stats.lowStockProducts.slice(0, 3).map((product) => (
                                    <div
                                        key={product.id}
                                        className="flex items-center justify-between p-4 rounded-3xl bg-amber-500/5 border border-amber-500/10"
                                    >
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 rounded-full bg-background flex items-center justify-center font-black text-xs shadow-sm border border-amber-500/20 text-amber-600">
                                                {product.quantity}
                                            </div>
                                            <div>
                                                <p className="font-black text-sm tracking-tight line-clamp-1">{product.name}</p>
                                                <p className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-widest">SKU: {product.sku}</p>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-xs font-black text-amber-600 dark:text-amber-400">
                                                {t('products.table.lowStock')}
                                            </p>
                                            <p className="text-[10px] font-bold text-muted-foreground/40 uppercase tracking-wider">
                                                Limit: {product.minStockLevel}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                                <Link href="/products" className="block mt-6 text-center text-xs font-black uppercase tracking-[0.2em] text-amber-500 hover:text-amber-600 transition-colors">
                                    {t('common.view') || 'Manage Inventory'}
                                </Link>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Recent Invoices */}
                <Card className="bg-card/40 border-border/30 backdrop-blur-md rounded-[2rem] overflow-hidden">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-3 text-lg font-black">
                            <div className="p-2 rounded-xl bg-primary/10">
                                <FileText className="w-5 h-5 text-primary" />
                            </div>
                            {t('dashboard.recentInvoices') || 'Recent Invoices'}
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {stats.recentInvoices.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 opacity-40">
                                <FileText className="w-12 h-12 mb-2" />
                                <p className="text-sm font-bold uppercase tracking-widest text-center">
                                    {t('dashboard.noInvoices') || 'No invoices yet'}
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {stats.recentInvoices.slice(0, 4).map((invoice) => (
                                    <div
                                        key={invoice.id}
                                        className="flex items-center justify-between p-4 rounded-3xl bg-secondary/30 hover:bg-secondary/50 transition-colors border border-transparent hover:border-border/50"
                                    >
                                        <div className="flex items-center gap-4">
                                            <div className="w-10 h-10 rounded-full bg-background flex items-center justify-center font-black text-xs shadow-sm border border-border/20">
                                                #{invoice.invoiceid.slice(-4)}
                                            </div>
                                            <div>
                                                <p className="font-black text-sm uppercase tracking-tight">{t('common.invoice') || 'Invoice'}</p>
                                                <p className="text-xs font-bold text-muted-foreground/60">
                                                    {formatDate(invoice.createdAt)}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="text-right">
                                            <p className="font-black text-primary tabular-nums">
                                                {formatCurrency(invoice.totalAmount, invoice.settlementCurrency || 'usd', features.iqd_display_preference)}
                                            </p>
                                            <p className="text-[10px] font-bold uppercase text-muted-foreground/60 tracking-wider">
                                                {formatOriginLabel(invoice.origin)}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        <Link href="/invoices-history" className="block mt-6 text-center text-xs font-black uppercase tracking-[0.2em] text-primary hover:text-primary/70 transition-colors">
                            {t('common.viewAll') || 'View All Invoices'}
                        </Link>
                    </CardContent>
                </Card>
            </div>

            {/* Dashboard Sales Overview (Full width below the widgets) */}
            <DashboardSalesOverview
                data={stats.statsByCurrency}
                iqdPreference={features.iqd_display_preference}
            />
            </div>
        </div>
    )
}
