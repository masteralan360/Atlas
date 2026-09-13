import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useLocation, useRoute } from 'wouter'
import {
    BadgeCheck,
    CircleDollarSign,
    Clock3,
    Eye,
    LayoutGrid,
    List,
    ListFilter,
    Loader2,
    Package,
    PackageCheck,
    PackageSearch,
    RefreshCw,
    Search,
    ShoppingBag,
    Truck,
    XCircle,
    type LucideIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { useDateRange, type DateRangeType } from '@/context/DateRangeContext'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { getLanguageDirection } from '@/lib/i18nRouting'
import {
    getMarketplaceOrderDisplayStatus,
    type MarketplaceSalesOrderReturnStatus
} from '@/lib/marketplaceOrderPresentation'
import { formatLocalizedMonthYear } from '@/lib/monthDisplay'
import { getDateRangeBounds } from '@/lib/dateRangeFilters'
import { convertCurrencyAmountWithLiveRates } from '@/lib/orderCurrency'
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { isMobile } from '@/lib/platform'
import { normalizeSupabaseActionError, runSupabaseAction } from '@/lib/supabaseRequest'
import {
    db,
    fetchTableFromSupabase,
    recordObligationSettlement,
    type CurrencyCode,
    type PaymentObligation,
    type SalesOrder,
    type WorkspacePaymentMethod
} from '@/local-db'
import { useWorkspace } from '@/workspace'
import { EcommerceDetailView } from '@/ui/components/ecommerce/EcommerceDetailView'
import {
    EcommerceStatusBadge,
    MarketplaceDeliveryFeeBadge
} from '@/ui/components/ecommerce/MarketplaceOrderPresentation'
import { getMarketplaceDisplayItems } from '@/ui/components/ecommerce/MarketplaceOrderDisplayItems'
import type {
    MarketplaceOrderItemRecord,
    MarketplaceOrderRecord,
    MarketplaceOrderStatus
} from '@/ui/components/ecommerce/MarketplaceOrderTypes'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DateRangeFilters,
    Input,
    SettlementDialog,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    useToast
} from '@/ui/components'
import { FilterDropdown } from '@/ui/components/FilterDropdown'

type MarketplaceOrderFilter = 'all' | MarketplaceOrderStatus

const JUMLA_KHALEEJ_STOREFRONT_KEY = 'jumla-khaleej'
const JUMLA_KHALEEJ_DELIVERY_METADATA_TYPE = 'jumla_khaleej_delivery_fee'

type MarketplaceTransitionResponse = {
    warning?: string | null
    sales_order_id?: string | null
    customer_id?: string | null
    business_partner_id?: string | null
}

type MarketplaceOrderDatabaseRecord = Omit<MarketplaceOrderRecord, 'delivery_fee' | 'sales_order_return_status' | 'sales_order_returned_at'> & {
    website_storefront_key: string | null
}

type MarketplaceSalesOrderReturnRecord = {
    id: string
    return_status: MarketplaceSalesOrderReturnStatus
    returned_at: string | null
}

const MARKETPLACE_ORDER_SELECT = `
    id,
    workspace_id,
    order_number,
    business_partner_id,
    customer_id,
    sales_order_id,
    customer_name,
    customer_phone,
    customer_email,
    customer_address,
    customer_city,
    customer_notes,
    inquiry_pdf_storage_id,
    inquiry_pdf_document_number,
    inquiry_pdf_uploaded_at,
    website_storefront_key,
    items,
    subtotal,
    total,
    currency,
    status,
    confirmed_at,
    processing_at,
    shipped_at,
    delivered_at,
    cancelled_at,
    cancel_reason,
    inventory_deducted,
    created_at,
    updated_at
`

function isMarketplaceOrderItem(value: unknown): value is MarketplaceOrderItemRecord {
    return Boolean(value
        && typeof value === 'object'
        && typeof (value as { product_id?: unknown }).product_id === 'string'
        && (value as { product_id: string }).product_id.length > 0)
}

function getJumlaKhaleejDeliveryFee(items: unknown[], storefrontKey: string | null) {
    if (storefrontKey !== JUMLA_KHALEEJ_STOREFRONT_KEY) return null

    const metadata = items.find((item) => Boolean(
        item
        && typeof item === 'object'
        && (item as { metadata_type?: unknown }).metadata_type === JUMLA_KHALEEJ_DELIVERY_METADATA_TYPE
    )) as { delivery_fee?: unknown } | undefined
    const fee = Number(metadata?.delivery_fee)
    return Number.isInteger(fee) && fee > 0 ? fee : null
}

const MARKETPLACE_ORDER_REFRESH_EVENT = 'marketplace-orders:changed'

const statusFilterIcons = {
    all: ListFilter,
    pending: Clock3,
    confirmed: BadgeCheck,
    processing: Package,
    shipped: Truck,
    delivered: PackageCheck,
    cancelled: XCircle
} satisfies Record<MarketplaceOrderFilter, LucideIcon>

function filterEcommerceOrdersByDate<T>(
    orders: T[],
    dateRange: DateRangeType,
    customDates: { start: string; end: string },
    getDate: (order: T) => string | null | undefined
) {
    const { start, end } = getDateRangeBounds(dateRange, customDates)
    if (!start && !end) return orders

    return orders.filter((order) => {
        const date = getDate(order)
        if (!date) return false
        const orderDate = new Date(date)
        if (start && orderDate < start) return false
        if (end && orderDate >= end) return false
        return true
    })
}

function getPreviousDateRange(dateRange: DateRangeType, customDates: { start: string; end: string }) {
    const { start, end } = getDateRangeBounds(dateRange, customDates)
    if (!start || !end) return null

    const duration = end.getTime() - start.getTime()
    return {
        start: new Date(start.getTime() - duration),
        end: start
    }
}

async function hydrateMarketplaceCollectionDependencies(workspaceId: string, salesOrderId: string) {
    await fetchTableFromSupabase('sales_orders', db.sales_orders, workspaceId, { includeDeleted: true })

    const order = await db.sales_orders.get(salesOrderId)
    return order as SalesOrder | undefined
}

function buildMarketplaceCollectionObligation(order: SalesOrder): PaymentObligation {
    return {
        id: `sales-order:${order.id}`,
        workspaceId: order.workspaceId,
        sourceModule: 'orders',
        sourceType: 'sales_order',
        sourceRecordId: order.id,
        sourceSubrecordId: null,
        direction: 'incoming',
        amount: order.total,
        currency: order.currency,
        dueDate: (order.actualDeliveryDate || order.expectedDeliveryDate || order.updatedAt).slice(0, 10),
        counterpartyName: order.customerName,
        referenceLabel: order.orderNumber,
        title: order.customerName,
        subtitle: order.sourceChannel === 'marketplace'
            ? 'Delivered E-Commerce order'
            : 'Completed sales order',
        status: 'open',
        routePath: `/orders/${order.id}`,
        metadata: {
            orderStatus: order.status,
            sourceChannel: order.sourceChannel || 'marketplace'
        }
    }
}

function getEcommerceOrderSummary(items: MarketplaceOrderItemRecord[]) {
    const displayItems = getMarketplaceDisplayItems(items)
    const firstItems = displayItems.slice(0, 2).map((item) => item.name)
    if (displayItems.length <= 2) return firstItems.join(', ')
    return `${firstItems.join(', ')} +${displayItems.length - 2}`
}

function EcommerceProductMosaic({ items }: { items: MarketplaceOrderItemRecord[] }) {
    const [failedProductIds, setFailedProductIds] = useState<Set<string>>(() => new Set())
    const products = Array.from(new Map(items.map((item) => [item.product_id, item])).values()).slice(0, 4)
    const layoutClass = products.length === 1
        ? 'grid-cols-1 grid-rows-1'
        : products.length === 2
            ? 'grid-cols-2 grid-rows-1'
            : 'grid-cols-2 grid-rows-2'

    return (
        <div
            className={cn('grid h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/40', layoutClass)}
            title={products.map((item) => item.name).join(', ')}
            aria-label={products.map((item) => item.name).join(', ')}
        >
            {products.map((item, index) => {
                const hasImage = Boolean(item.image_url && !failedProductIds.has(item.product_id))
                const hasStartDivider = products.length === 2
                    ? index === 1
                    : products.length === 3
                        ? index > 0
                        : index === 1 || index === 3
                const hasTopDivider = products.length > 2 && index >= 2

                return (
                    <div
                        key={item.product_id}
                        className={cn(
                            'relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-muted',
                            products.length === 3 && index === 0 && 'row-span-2',
                            hasStartDivider && 'border-s border-border',
                            hasTopDivider && 'border-t border-border'
                        )}
                    >
                        {hasImage ? (
                            <img
                                src={item.image_url as string}
                                alt={item.name}
                                loading="lazy"
                                decoding="async"
                                className="h-full w-full object-cover"
                                onError={() => setFailedProductIds((current) => new Set(current).add(item.product_id))}
                            />
                        ) : (
                            <Package className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                        )}
                    </div>
                )
            })}
        </div>
    )
}

function EcommerceSummaryCards({ orders, totalOrdersTrend }: { orders: MarketplaceOrderRecord[]; totalOrdersTrend: number | null }) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const liveRates = useMemo(() => ({
        exchangeData,
        eurRates,
        tryRates
    }), [exchangeData, eurRates, tryRates])
    const workspaceCurrency = (features.default_currency || 'usd') as CurrencyCode
    const orderValueOrders = orders.filter((order) => order.status !== 'cancelled')
    const orderValueByCurrency = orderValueOrders.reduce<Record<string, number>>((totals, order) => {
        totals[order.currency] = (totals[order.currency] || 0) + order.total
        return totals
    }, {})
    const orderValueEntries = Object.entries(orderValueByCurrency).sort(([left], [right]) => {
        if (left === workspaceCurrency) return -1
        if (right === workspaceCurrency) return 1
        return left.localeCompare(right)
    })
    const orderValueInWorkspaceCurrency = orderValueOrders.reduce(
        (total, order) => total + convertCurrencyAmountWithLiveRates(order.total, order.currency as CurrencyCode, workspaceCurrency, liveRates),
        0
    )
    const pendingCount = orders.filter((order) => order.status === 'pending').length
    const pendingFulfillmentCount = orders.filter((order) =>
        order.status === 'pending' || order.status === 'confirmed' || order.status === 'processing'
    ).length
    const deliveredCount = orders.filter((order) => order.status === 'delivered').length
    const cancelledCount = orders.filter((order) => order.status === 'cancelled').length

    return (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card className="rounded-2xl border-border/80 shadow-none">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="text-sm font-semibold text-muted-foreground">
                        {t('ecommerce.summary.totalOrders', { defaultValue: 'Total orders' })}
                    </CardTitle>
                    <span className="rounded-xl bg-muted/60 p-2 text-muted-foreground">
                        <ShoppingBag className="h-4 w-4" />
                    </span>
                </CardHeader>
                <CardContent className="pt-0">
                    <div className="flex items-center gap-2">
                        <div className="text-3xl font-black tracking-tight">{orders.length}</div>
                        {totalOrdersTrend !== null ? (
                            <span className={cn(
                                'rounded-full px-2 py-1 text-xs font-bold',
                                totalOrdersTrend >= 0
                                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                    : 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                            )}>
                                {totalOrdersTrend >= 0 ? '+' : ''}{totalOrdersTrend.toFixed(1)}%
                            </span>
                        ) : null}
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                        {pendingCount} {t('ecommerce.summary.pending', { defaultValue: 'pending' })}
                        <span className="px-1.5">·</span>
                        {deliveredCount} {t('ecommerce.summary.delivered', { defaultValue: 'delivered' })}
                    </p>
                </CardContent>
            </Card>

            <Card className="rounded-2xl border-border/80 shadow-none">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="text-sm font-semibold text-muted-foreground">
                        {t('orders.summary.orderValue', { defaultValue: 'Order value' })}
                    </CardTitle>
                    <span className="rounded-xl bg-muted/60 p-2 text-muted-foreground">
                        <CircleDollarSign className="h-4 w-4" />
                    </span>
                </CardHeader>
                <CardContent className="pt-0">
                    <TooltipProvider delayDuration={300}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="cursor-help">
                                    {orderValueEntries.length > 0 ? orderValueEntries.map(([currency, value], index) => (
                                        <div
                                            key={currency}
                                            className={cn(
                                                'font-black leading-tight tracking-tight',
                                                index === 0 ? 'text-3xl' : 'mt-1 text-base text-muted-foreground'
                                            )}
                                        >
                                            {formatCurrency(value, currency, features.iqd_display_preference)}
                                        </div>
                                    )) : (
                                        <div className="text-3xl font-black tracking-tight">
                                            {formatCurrency(0, workspaceCurrency, features.iqd_display_preference)}
                                        </div>
                                    )}
                                </div>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" align="start" className="space-y-1 p-3">
                                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                    {t('orders.summary.totalIn', {
                                        defaultValue: 'Total in {{currency}}',
                                        currency: workspaceCurrency.toUpperCase()
                                    })}
                                </div>
                                <div className="text-base font-black">
                                    {formatCurrency(orderValueInWorkspaceCurrency, workspaceCurrency, features.iqd_display_preference)}
                                </div>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                </CardContent>
            </Card>

            <Card className="rounded-2xl border-border/80 shadow-none">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="text-sm font-semibold text-muted-foreground">
                        {t('orders.summary.pendingFulfillment', { defaultValue: 'Pending fulfillment' })}
                    </CardTitle>
                    <span className="rounded-xl bg-muted/60 p-2 text-muted-foreground">
                        <Clock3 className="h-4 w-4" />
                    </span>
                </CardHeader>
                <CardContent className="pt-0">
                    <div className="text-3xl font-black tracking-tight">{pendingFulfillmentCount}</div>
                </CardContent>
            </Card>

            <Card className="rounded-2xl border-border/80 shadow-none">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                    <CardTitle className="text-sm font-semibold text-muted-foreground">
                        {t('ecommerce.summary.delivered', { defaultValue: 'Delivered' })}
                    </CardTitle>
                    <span className="rounded-xl bg-muted/60 p-2 text-muted-foreground">
                        <PackageCheck className="h-4 w-4" />
                    </span>
                </CardHeader>
                <CardContent className="pt-0">
                    <div className="text-3xl font-black tracking-tight">{deliveredCount}</div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                        {cancelledCount > 0
                            ? `${cancelledCount} ${t('ecommerce.summary.cancelled', { defaultValue: 'cancelled' })}`
                            : t('ecommerce.summary.noCancellations', { defaultValue: 'No cancellations' })}
                    </p>
                </CardContent>
            </Card>
        </div>
    )
}

function EcommerceListView({
    orders,
    isLoading,
    onRefresh
}: {
    orders: MarketplaceOrderRecord[]
    isLoading: boolean
    onRefresh: () => Promise<void>
}) {
    const { t, i18n } = useTranslation()
    const pageDirection = getLanguageDirection(i18n.resolvedLanguage || i18n.language)
    const [, navigate] = useLocation()
    const { features } = useWorkspace()
    const { dateRange, customDates, setDateRange, setCustomDates } = useDateRange()
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => (localStorage.getItem('ecommerce_view_mode') as 'table' | 'grid') || 'table')
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState<MarketplaceOrderFilter>('all')

    useEffect(() => {
        localStorage.setItem('ecommerce_view_mode', viewMode)
    }, [viewMode])

    const dateFilteredOrders = useMemo(
        () => filterEcommerceOrdersByDate(orders, dateRange, customDates, (order) => order.created_at),
        [orders, dateRange, customDates]
    )

    const filteredOrders = useMemo(() => {
        let items = [...dateFilteredOrders]

        if (statusFilter !== 'all') {
            items = items.filter((order) => order.status === statusFilter)
        }

        const query = search.trim().toLowerCase()
        if (!query) return items

        return items.filter((order) =>
            `${order.order_number} ${order.customer_name} ${order.customer_phone} ${order.customer_city || ''}`
                .toLowerCase()
                .includes(query)
        )
    }, [dateFilteredOrders, search, statusFilter])

    const previousDateRange = useMemo(
        () => getPreviousDateRange(dateRange, customDates),
        [dateRange, customDates]
    )
    const previousOrderCount = useMemo(() => {
        if (!previousDateRange) return null
        return orders.filter((order) => {
            const createdAt = new Date(order.created_at)
            return createdAt >= previousDateRange.start && createdAt < previousDateRange.end
        }).length
    }, [previousDateRange, orders])
    const totalOrdersTrend = previousOrderCount && previousOrderCount > 0
        ? ((dateFilteredOrders.length - previousOrderCount) / previousOrderCount) * 100
        : null

    const getDateDisplay = () => {
        if (dateRange === 'today') {
            return formatDate(new Date())
        }
        if (dateRange === 'month') {
            return formatLocalizedMonthYear(new Date(), i18n.language)
        }
        if (dateRange === 'lastMonth') {
            return formatLocalizedMonthYear(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1), i18n.language)
        }
        if (dateRange === 'custom') {
            if (dateFilteredOrders.length > 0) {
                const dates = dateFilteredOrders.map((order) => new Date(order.created_at).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }
            if (customDates.start || customDates.end) {
                const parts = []
                if (customDates.start) parts.push(`${t('performance.filters.from')} ${formatDate(customDates.start)}`)
                if (customDates.end) parts.push(`${t('performance.filters.to')} ${formatDate(customDates.end)}`)
                return parts.join(' ')
            }
        }
        if (dateRange === 'allTime') {
            if (dateFilteredOrders.length > 0) {
                const dates = dateFilteredOrders.map((order) => new Date(order.created_at).getTime())
                const minDate = new Date(Math.min(...dates))
                const maxDate = new Date(Math.max(...dates))
                return `${t('performance.filters.from')} ${formatDate(minDate)} ${t('performance.filters.to')} ${formatDate(maxDate)}`
            }
            return t('performance.filters.allTime') || 'All Time'
        }
        return ''
    }

    function renderOrderTable() {
        return (
            <div className="overflow-x-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t('orders.table.orderNumber') || 'Order #'}</TableHead>
                            <TableHead>{t('ecommerce.customer', { defaultValue: 'Customer' })}</TableHead>
                            <TableHead>{t('orders.table.items') || 'Items'}</TableHead>
                            <TableHead>{t('common.status') || 'Status'}</TableHead>
                            <TableHead>{t('common.total') || 'Total'}</TableHead>
                            <TableHead>{t('orders.form.date') || 'Date'}</TableHead>
                            <TableHead className="text-end">{t('common.actions') || 'Actions'}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {filteredOrders.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                                    {t('common.noData') || 'No data available'}
                                </TableCell>
                            </TableRow>
                        ) : filteredOrders.map((order) => (
                            <TableRow key={order.id} className="hover:bg-muted/40">
                                <TableCell className="font-semibold">
                                    <div className="flex min-w-[11rem] items-center gap-3">
                                        <EcommerceProductMosaic items={order.items} />
                                        <div className="min-w-0">
                                            <span>{order.order_number}</span>
                                            <div className="truncate text-xs text-muted-foreground">
                                                {getEcommerceOrderSummary(order.items)}
                                            </div>
                                            {order.delivery_fee !== null ? <div className="mt-1"><MarketplaceDeliveryFeeBadge fee={order.delivery_fee} /></div> : null}
                                        </div>
                                    </div>
                                </TableCell>
                                <TableCell>{order.customer_name}</TableCell>
                                <TableCell>{getMarketplaceDisplayItems(order.items).length}</TableCell>
                                <TableCell>
                                    <EcommerceStatusBadge status={getMarketplaceOrderDisplayStatus(order.status, order.sales_order_return_status)} />
                                </TableCell>
                                <TableCell>{formatCurrency(order.total, order.currency, features.iqd_display_preference)}</TableCell>
                                <TableCell className="whitespace-nowrap">{formatDateTime(order.created_at)}</TableCell>
                                <TableCell className="text-end">
                                    <div className="flex flex-wrap justify-end gap-2">
                                        <Button variant="outline" size="sm" allowViewer={true} onClick={() => navigate(`/ecommerce/${order.id}`)}>
                                            <Eye className="me-1 h-3.5 w-3.5" />
                                            {t('common.view') || 'View'}
                                        </Button>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        )
    }

    function renderOrderGrid() {
        return (
            <div className={cn(
                "grid gap-4 p-4 bg-muted/5",
                viewMode === 'grid' && !isMobile() ? "md:grid-cols-2 xl:grid-cols-3" : "grid-cols-1"
            )}>
                {filteredOrders.length === 0 ? (
                    <div className="text-center text-muted-foreground py-12 bg-background rounded-lg border">
                        {t('common.noData') || 'No data available'}
                    </div>
                ) : filteredOrders.map((order) => (
                    <div
                        key={order.id}
                        className="p-4 border shadow-sm space-y-4 transition-all active:scale-[0.98] rounded-2xl bg-background"
                    >
                        <div className="flex justify-between items-start">
                            <div className="flex min-w-0 items-start gap-3">
                                <EcommerceProductMosaic items={order.items} />
                                <div className="min-w-0 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-sm font-bold text-primary">{order.order_number}</span>
                                        <MarketplaceDeliveryFeeBadge fee={order.delivery_fee} />
                                    </div>
                                    <div className="text-base font-bold text-foreground">{order.customer_name}</div>
                                    <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                                        {getEcommerceOrderSummary(order.items)}
                                    </div>
                                </div>
                            </div>
                            <div className="flex flex-col items-end gap-1.5 text-end">
                                <EcommerceStatusBadge status={getMarketplaceOrderDisplayStatus(order.status, order.sales_order_return_status)} />
                                <div className="mt-2 grid gap-1 text-[10px] font-medium text-muted-foreground">
                                    <div>
                                        <span className="me-1 uppercase tracking-tight">{t('orders.dateFilters.created', { defaultValue: 'Created' })}</span>
                                        {formatDateTime(order.created_at)}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2 py-3 border-y border-border/50">
                            <div className="text-center">
                                <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('orders.table.items') || 'Items'}</div>
                                <div className="text-[11px] font-bold">{getMarketplaceDisplayItems(order.items).length}</div>
                            </div>
                            <div className="text-center border-s border-border/50">
                                <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('common.total') || 'Total'}</div>
                                <div className="text-[11px] font-bold text-primary">{formatCurrency(order.total, order.currency, features.iqd_display_preference)}</div>
                            </div>
                            <div className="text-center border-s border-border/50">
                                <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('ecommerce.city', { defaultValue: 'City' })}</div>
                                <div className="text-[11px] font-bold">{order.customer_city || '—'}</div>
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                            <Button variant="outline" size="sm" allowViewer={true} className="flex-1 h-9 rounded-xl font-bold gap-2 text-xs" onClick={() => navigate(`/ecommerce/${order.id}`)}>
                                <Eye className="w-3.5 h-3.5" />
                                {t('common.view') || 'View'}
                            </Button>
                        </div>
                    </div>
                ))}
            </div>
        )
    }

    return (
        <div className="space-y-6" dir={pageDirection}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold">
                        <ShoppingBag className="h-6 w-6 text-primary" />
                        {t('ecommerce.title', { defaultValue: 'E-Commerce' })}
                        {getDateDisplay() && (
                            <span className="animate-pop-in rounded-lg bg-primary px-3 py-1 text-sm font-bold text-primary-foreground shadow-sm">
                                {getDateDisplay()}
                            </span>
                        )}
                    </h1>
                    <p className="text-muted-foreground">
                        {t('ecommerce.subtitle', { defaultValue: 'Track and manage marketplace orders' })} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
                <div className="flex flex-col sm:flex-row lg:items-center gap-4 self-start lg:self-auto w-full lg:w-auto">
                    <div className="relative w-full lg:w-auto">
                        <DateRangeFilters
                            label={t('orders.dateFilters.created', { defaultValue: 'Created date' })}
                            dateRange={dateRange}
                            customDates={customDates}
                            onDateRangeChange={setDateRange}
                            onCustomDatesChange={setCustomDates}
                        />
                    </div>
                    <Button variant="outline" className="gap-2 self-start rounded-xl sm:self-auto" onClick={onRefresh}>
                        <RefreshCw className="h-4 w-4" />
                        {t('common.refresh', { defaultValue: 'Refresh' })}
                    </Button>
                </div>
            </div>

            {(features.data_mode === 'local' || features.data_mode === 'demo') && (
                <Card className="border-amber-500/20 bg-amber-500/5">
                    <CardContent className="p-5 text-sm text-amber-700 dark:text-amber-300">
                        {t('settings.marketplace.localUnsupported', {
                            defaultValue: 'Marketplace publishing and order management are available only for cloud and hybrid workspaces.'
                        })}
                    </CardContent>
                </Card>
            )}

            <EcommerceSummaryCards orders={dateFilteredOrders} totalOrdersTrend={totalOrdersTrend} />

            <Card>
                <CardHeader className="gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="w-full space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                                <CardTitle>{t('ecommerce.orders', { defaultValue: 'Orders' })}</CardTitle>

                                {!isMobile() && (
                                    <div className="flex items-center self-start rounded-xl border border-border/60 bg-muted/30 p-1 sm:self-auto">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            allowViewer={true}
                                            onClick={() => setViewMode('table')}
                                            className={cn(
                                                'h-8 gap-1.5 rounded-lg px-3 text-[10px] font-bold uppercase tracking-wide transition-all',
                                                viewMode === 'table'
                                                    ? 'bg-primary text-primary-foreground shadow-sm'
                                                    : 'text-muted-foreground hover:bg-background hover:text-foreground'
                                            )}
                                        >
                                            <List className="h-3.5 w-3.5" />
                                            {t('orders.view.table') || 'Details'}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            allowViewer={true}
                                            onClick={() => setViewMode('grid')}
                                            className={cn(
                                                'h-8 gap-1.5 rounded-lg px-3 text-[10px] font-bold uppercase tracking-wide transition-all',
                                                viewMode === 'grid'
                                                    ? 'bg-primary text-primary-foreground shadow-sm'
                                                    : 'text-muted-foreground hover:bg-background hover:text-foreground'
                                            )}
                                        >
                                            <LayoutGrid className="h-3.5 w-3.5" />
                                            {t('orders.view.grid') || 'Grid'}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
                            <div className="relative min-w-0 flex-1">
                                <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    allowViewer={true}
                                    placeholder={t('marketplace.searchOrders', { defaultValue: 'Search orders...' })}
                                    className="h-10 rounded-xl border-border/70 bg-background ps-10 shadow-sm transition-shadow focus-visible:shadow-md"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                                <FilterDropdown
                                    dir={pageDirection}
                                    value={statusFilter}
                                    label={t('common.status') || 'Status'}
                                    hasActiveFilter={statusFilter !== 'all'}
                                    options={(['all', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'] as MarketplaceOrderFilter[]).map((value) => ({
                                        value,
                                        icon: statusFilterIcons[value],
                                        label: value === 'all'
                                            ? (t('common.all') || 'All')
                                            : t(`ecommerce.status.${value}`, { defaultValue: value }),
                                    }))}
                                    onValueChange={setStatusFilter}
                                />
                            </div>
                        </div>
                    </div>
                </CardHeader>

                {isLoading ? (
                    <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/70 p-5 text-muted-foreground mx-5 mb-5">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('common.loading', { defaultValue: 'Loading...' })}
                    </div>
                ) : filteredOrders.length === 0 ? (
                    <div className="px-5 pb-5">
                        <Card className="border-dashed border-border/60 bg-card/50">
                            <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
                                <PackageSearch className="h-10 w-10 text-muted-foreground/50" />
                                <div className="space-y-1">
                                    <h2 className="text-xl font-black">{t('ecommerce.noOrders', { defaultValue: 'No marketplace orders yet' })}</h2>
                                    <p className="text-sm text-muted-foreground">
                                        {t('ecommerce.noOrdersHint', { defaultValue: 'New inquiry orders from your public store will appear here.' })}
                                    </p>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                ) : (isMobile() || viewMode === 'grid') ? renderOrderGrid() : renderOrderTable()}
            </Card>
        </div>
    )
}

export function Ecommerce() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const [detailMatch, params] = useRoute('/ecommerce/:orderId')
    const [orders, setOrders] = useState<MarketplaceOrderRecord[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isSaving, setIsSaving] = useState(false)
    const [settlementTarget, setSettlementTarget] = useState<PaymentObligation | null>(null)
    const [isSubmittingSettlement, setIsSubmittingSettlement] = useState(false)
    const [isOpeningCollection, setIsOpeningCollection] = useState(false)
    const isOpeningCollectionRef = useRef(false)

    const loadOrders = useCallback(async () => {
        if (!user?.workspaceId) {
            return
        }

        setIsLoading(true)
        try {
            const { data, error } = await runSupabaseAction('ecommerce.fetchOrders', () =>
                supabase
                    .from('marketplace_orders')
                    .select(MARKETPLACE_ORDER_SELECT)
                    .order('created_at', { ascending: false })
            ) as { data: MarketplaceOrderDatabaseRecord[] | null; error: Error | null }

            if (error) {
                throw error
            }

            const marketplaceOrders = data ?? []
            const salesOrderIds = [...new Set(
                marketplaceOrders
                    .map((order) => order.sales_order_id)
                    .filter((salesOrderId): salesOrderId is string => Boolean(salesOrderId))
            )]
            const salesOrderReturnsById = new Map<string, MarketplaceSalesOrderReturnRecord>()

            if (salesOrderIds.length > 0) {
                const { data: salesOrderReturns, error: salesOrderReturnsError } = await runSupabaseAction(
                    'ecommerce.fetchLinkedSalesOrderReturns',
                    () => supabase
                        .schema('crm')
                        .from('sales_orders')
                        .select('id, return_status, returned_at')
                        .eq('workspace_id', user.workspaceId)
                        .in('id', salesOrderIds)
                ) as { data: MarketplaceSalesOrderReturnRecord[] | null; error: Error | null }

                if (salesOrderReturnsError) {
                    throw salesOrderReturnsError
                }

                for (const salesOrder of salesOrderReturns ?? []) {
                    salesOrderReturnsById.set(salesOrder.id, salesOrder)
                }
            }

            setOrders(marketplaceOrders.map((order) => {
                const rawItems: unknown[] = Array.isArray(order.items) ? order.items : []
                const salesOrderReturn = order.sales_order_id
                    ? salesOrderReturnsById.get(order.sales_order_id)
                    : undefined
                return {
                    ...order,
                    items: rawItems.filter(isMarketplaceOrderItem),
                    delivery_fee: getJumlaKhaleejDeliveryFee(rawItems, order.website_storefront_key),
                    sales_order_return_status: salesOrderReturn?.return_status ?? 'none',
                    sales_order_returned_at: salesOrderReturn?.returned_at ?? null
                }
            }))
        } catch (error) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error ? error.message : 'Failed to load marketplace orders',
                variant: 'destructive'
            })
        } finally {
            setIsLoading(false)
        }
    }, [t, toast, user?.workspaceId])

    useEffect(() => {
        void loadOrders()
    }, [loadOrders])

    const openRecordCollection = async (salesOrderId: string) => {
        if (!user?.workspaceId) {
            return
        }

        if (isOpeningCollectionRef.current) {
            return
        }

        isOpeningCollectionRef.current = true
        setIsOpeningCollection(true)

        try {
            let salesOrder = await db.sales_orders.get(salesOrderId)

            if (!salesOrder || salesOrder.isDeleted) {
                await hydrateMarketplaceCollectionDependencies(user.workspaceId, salesOrderId)
                salesOrder = await db.sales_orders.get(salesOrderId)
            }

            if (!salesOrder || salesOrder.isDeleted) {
                toast({
                    title: t('common.error', { defaultValue: 'Error' }),
                    description: 'The delivered sales order could not be loaded for collection.',
                    variant: 'destructive'
                })
                return
            }

            if (salesOrder.isPaid) {
                toast({
                    title: t('common.success', { defaultValue: 'Success' }),
                    description: t('orders.details.fullySettled', { defaultValue: 'Fully settled' })
                })
                return
            }

            setSettlementTarget(buildMarketplaceCollectionObligation(salesOrder))
        } catch (error) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error ? error.message : 'Failed to open collection dialog',
                variant: 'destructive'
            })
        } finally {
            isOpeningCollectionRef.current = false
            setIsOpeningCollection(false)
        }
    }

    const handleCollectionSettlement = async (input: {
        paymentMethod: WorkspacePaymentMethod
        paidAt: string
        note?: string
        accountId?: string | null
        accountNameSnapshot?: string | null
    }) => {
        if (!user?.workspaceId || !settlementTarget) {
            return
        }

        setIsSubmittingSettlement(true)
        try {
            await recordObligationSettlement(user.workspaceId, settlementTarget, {
                ...input,
                createdBy: user?.id || null
            })

            toast({
                title: t('common.success', { defaultValue: 'Success' }),
                description: t('ecommerce.collectionRecorded', { defaultValue: 'Collection recorded and the order is now marked as paid.' })
            })

            setSettlementTarget(null)
            await loadOrders()
            window.dispatchEvent(new CustomEvent(MARKETPLACE_ORDER_REFRESH_EVENT))
        } catch (error) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error ? error.message : 'Failed to record collection',
                variant: 'destructive'
            })
        } finally {
            setIsSubmittingSettlement(false)
        }
    }

    const transitionOrder = async (orderId: string, nextStatus: MarketplaceOrderStatus, cancelReason?: string) => {
        setIsSaving(true)
        try {
            const { data, error } = await runSupabaseAction('ecommerce.transitionOrder', () =>
                supabase.rpc('transition_marketplace_order', {
                    order_id: orderId,
                    next_status: nextStatus,
                    cancel_reason: cancelReason || null
                })
            ) as { data: MarketplaceTransitionResponse | null; error: unknown | null }

            if (error) {
                // Supabase RPC errors are plain PostgREST objects rather than
                // native Error instances. Normalize them before the toast so
                // database validation messages (including the exact product)
                // are never replaced by the generic fallback below.
                throw normalizeSupabaseActionError(error)
            }

            await loadOrders()
            window.dispatchEvent(new CustomEvent(MARKETPLACE_ORDER_REFRESH_EVENT))

            if (nextStatus === 'delivered' && data?.sales_order_id) {
                if (data.warning) {
                    toast({
                        title: t('common.success', { defaultValue: 'Success' }),
                        description: data.warning
                    })
                }

                await openRecordCollection(data.sales_order_id)
                return
            }

            toast({
                title: t('common.success', { defaultValue: 'Success' }),
                description: data?.warning
                    || t('ecommerce.transitionSuccess', { defaultValue: 'Marketplace order updated successfully.' })
            })
        } catch (error) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: normalizeSupabaseActionError(error).message || 'Failed to update marketplace order',
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

const editMarketplaceOrderItems = async (orderId: string, items: MarketplaceOrderItemRecord[]) => {
        try {
            const { error } = await runSupabaseAction('ecommerce.editOrderItems', () =>
                supabase.rpc('edit_marketplace_order_items', {
                    order_id: orderId,
                    items
                })
            ) as { data: unknown; error: unknown | null }

            if (error) {
                throw error
            }

            await loadOrders()
            window.dispatchEvent(new CustomEvent(MARKETPLACE_ORDER_REFRESH_EVENT))
            toast({
                title: t('common.success', { defaultValue: 'Success' }),
                description: t('ecommerce.itemsEdited', { defaultValue: 'Order items updated.' })
            })
        } catch (error) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: normalizeSupabaseActionError(error).message || 'Failed to update order items',
                variant: 'destructive'
            })
            throw error
        }
    }

    if (!user?.workspaceId) {
        return null
    }

    const activeOrder = detailMatch && params?.orderId
        ? orders.find((order) => order.id === params.orderId) || null
        : null

    if (detailMatch && params?.orderId && activeOrder) {
        return (
            <>
                <EcommerceDetailView
                    order={activeOrder}
                    isSaving={isSaving}
                    isOpeningCollection={isOpeningCollection}
                    onAdvance={(nextStatus) => transitionOrder(activeOrder.id, nextStatus)}
                    onCancel={(reason) => transitionOrder(activeOrder.id, 'cancelled', reason)}
                    onRecordCollection={openRecordCollection}
                    onSaveItems={editMarketplaceOrderItems}
                />

                <SettlementDialog
                    open={!!settlementTarget}
                    onOpenChange={(open) => {
                        if (!open) {
                            setSettlementTarget(null)
                        }
                    }}
                    obligation={settlementTarget}
                    isSubmitting={isSubmittingSettlement}
                    onSubmit={handleCollectionSettlement}
                />
            </>
        )
    }

    return (
        <>
            <EcommerceListView
                orders={orders}
                isLoading={isLoading}
                onRefresh={loadOrders}
            />

            <SettlementDialog
                open={!!settlementTarget}
                onOpenChange={(open) => {
                    if (!open) {
                        setSettlementTarget(null)
                    }
                }}
                obligation={settlementTarget}
                isSubmitting={isSubmittingSettlement}
                onSubmit={handleCollectionSettlement}
            />
        </>
    )
}
