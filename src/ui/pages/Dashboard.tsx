import { useDashboardStats, useSales } from '@/local-db'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components'
import { formatCurrency, formatDate, formatOriginLabel } from '@/lib/utils'
import { Package, FileText, DollarSign, AlertTriangle, Receipt } from 'lucide-react'
import { Link } from 'wouter'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { DashboardSalesOverview } from '@/ui/components/DashboardSalesOverview'

export function Dashboard() {
    const { user } = useAuth()
    const { features } = useWorkspace()
    useSales(user?.workspaceId) // Background sync for sales
    const stats = useDashboardStats(user?.workspaceId)
    const { t } = useTranslation()

    if (!stats) return null

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
            title: t('revenue.grossRevenue'),
            value: stats.grossRevenueByCurrency,
            icon: DollarSign,
            color: 'text-primary',
            bgColor: 'bg-primary/10',
            href: '/revenue',
            isRevenue: true
        }
    ]

    return (
        <div className="space-y-6 pb-12">
            {/* Page Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-black tracking-tight">{t('dashboard.title')}</h1>
                    <p className="text-muted-foreground font-medium">{t('dashboard.subtitle') || 'Overview of your business metrics'}</p>
                </div>
            </div>

            {/* Stats Grid */}
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-2">
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
                                    {stat.isRevenue ? (
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

            <div className="grid gap-6 lg:grid-cols-3">
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
    )
}
