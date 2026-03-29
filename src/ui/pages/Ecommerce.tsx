import { useEffect, useState } from 'react'
import { useLocation, useRoute } from 'wouter'
import { ArrowLeft, Loader2, PackageSearch, RefreshCw, Search, ShoppingBag } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import { formatCurrency, formatDateTime } from '@/lib/utils'
import { runSupabaseAction } from '@/lib/supabaseRequest'
import { useWorkspace } from '@/workspace'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Textarea,
    useToast
} from '@/ui/components'

type MarketplaceOrderStatus = 'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'cancelled'
type MarketplaceOrderFilter = 'all' | MarketplaceOrderStatus

type MarketplaceOrderItemRecord = {
    product_id: string
    name: string
    sku: string
    unit_price: number
    currency: string
    quantity: number
    line_total: number
    image_url?: string | null
    storage_id?: string | null
}

type MarketplaceOrderRecord = {
    id: string
    order_number: string
    customer_name: string
    customer_phone: string
    customer_email: string | null
    customer_address: string | null
    customer_city: string | null
    customer_notes: string | null
    items: MarketplaceOrderItemRecord[]
    subtotal: number
    total: number
    currency: string
    status: MarketplaceOrderStatus
    confirmed_at: string | null
    processing_at: string | null
    shipped_at: string | null
    delivered_at: string | null
    cancelled_at: string | null
    cancel_reason: string | null
    inventory_deducted: boolean
    created_at: string
    updated_at: string
}

const MARKETPLACE_ORDER_SELECT = `
    id,
    order_number,
    customer_name,
    customer_phone,
    customer_email,
    customer_address,
    customer_city,
    customer_notes,
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

function EcommerceStatusBadge({ status }: { status: MarketplaceOrderStatus }) {
    const { t } = useTranslation()

    const classes: Record<MarketplaceOrderStatus, string> = {
        pending: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
        confirmed: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
        processing: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
        shipped: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
        delivered: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        cancelled: 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
    }

    return (
        <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] ${classes[status]}`}>
            {t(`ecommerce.status.${status}`, { defaultValue: status })}
        </span>
    )
}

function EcommerceStats({ orders }: { orders: MarketplaceOrderRecord[] }) {
    const { t } = useTranslation()
    const stats: Array<{ key: MarketplaceOrderStatus; count: number }> = [
        { key: 'pending', count: orders.filter((order) => order.status === 'pending').length },
        { key: 'confirmed', count: orders.filter((order) => order.status === 'confirmed').length },
        { key: 'processing', count: orders.filter((order) => order.status === 'processing').length },
        { key: 'shipped', count: orders.filter((order) => order.status === 'shipped').length },
        { key: 'delivered', count: orders.filter((order) => order.status === 'delivered').length }
    ]

    return (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {stats.map((stat) => (
                <Card key={stat.key} className="border-border/60 bg-card/80">
                    <CardContent className="space-y-1 p-5">
                        <div className="text-3xl font-black">{stat.count}</div>
                        <div className="text-sm text-muted-foreground">
                            {t(`ecommerce.status.${stat.key}`, { defaultValue: stat.key })}
                        </div>
                    </CardContent>
                </Card>
            ))}
        </div>
    )
}

function nextActionForStatus(status: MarketplaceOrderStatus) {
    if (status === 'pending') return 'confirmed'
    if (status === 'confirmed') return 'processing'
    if (status === 'processing') return 'shipped'
    if (status === 'shipped') return 'delivered'
    return null
}

function transitionActionLabel(t: (key: string, options?: Record<string, unknown>) => string, nextStatus: MarketplaceOrderStatus | null) {
    if (nextStatus === 'confirmed') return t('ecommerce.actions.confirm', { defaultValue: 'Confirm Order' })
    if (nextStatus === 'processing') return t('ecommerce.actions.process', { defaultValue: 'Start Processing' })
    if (nextStatus === 'shipped') return t('ecommerce.actions.ship', { defaultValue: 'Mark as Shipped' })
    if (nextStatus === 'delivered') return t('ecommerce.actions.deliver', { defaultValue: 'Mark as Delivered' })
    return ''
}

function TimelineRow({
    label,
    value,
    complete
}: {
    label: string
    value: string | null
    complete: boolean
}) {
    return (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-3">
            <div className="flex items-center gap-3">
                <span className={`h-3 w-3 rounded-full ${complete ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
                <span className="font-medium">{label}</span>
            </div>
            <span className="text-sm text-muted-foreground">
                {value ? formatDateTime(value) : '—'}
            </span>
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
    const { t } = useTranslation()
    const [, navigate] = useLocation()
    const { features } = useWorkspace()
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState<MarketplaceOrderFilter>('all')

    const filteredOrders = orders.filter((order) => {
        if (statusFilter !== 'all' && order.status !== statusFilter) {
            return false
        }

        const query = search.trim().toLowerCase()
        if (!query) {
            return true
        }

        return `${order.order_number} ${order.customer_name} ${order.customer_phone} ${order.customer_city || ''}`
            .toLowerCase()
            .includes(query)
    })

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <ShoppingBag className="h-6 w-6 text-primary" />
                        {t('ecommerce.title', { defaultValue: 'E-Commerce' })}
                    </h1>
                    <p className="text-muted-foreground">
                        {t('ecommerce.subtitle', { defaultValue: 'Track and manage marketplace orders' })}
                    </p>
                </div>
                <Button variant="outline" className="gap-2 self-start rounded-xl" onClick={onRefresh}>
                    <RefreshCw className="h-4 w-4" />
                    {t('common.refresh', { defaultValue: 'Refresh' })}
                </Button>
            </div>

            {features.data_mode === 'local' && (
                <Card className="border-amber-500/20 bg-amber-500/5">
                    <CardContent className="p-5 text-sm text-amber-700 dark:text-amber-300">
                        {t('settings.marketplace.localUnsupported', {
                            defaultValue: 'Marketplace publishing and order management are available only for cloud and hybrid workspaces.'
                        })}
                    </CardContent>
                </Card>
            )}

            <EcommerceStats orders={orders} />

            <Card className="border-border/60 bg-card/80">
                <CardHeader className="gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <CardTitle>{t('ecommerce.orders', { defaultValue: 'Orders' })}</CardTitle>
                    <div className="relative w-full max-w-sm">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('marketplace.searchOrders', { defaultValue: 'Search orders...' })}
                            className="pl-9"
                        />
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-wrap gap-2">
                        {(['all', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'] as MarketplaceOrderFilter[]).map((status) => (
                            <Button
                                key={status}
                                type="button"
                                variant={statusFilter === status ? 'default' : 'outline'}
                                className="rounded-full"
                                onClick={() => setStatusFilter(status)}
                            >
                                {status === 'all'
                                    ? t('common.all', { defaultValue: 'All' })
                                    : t(`ecommerce.status.${status}`, { defaultValue: status })}
                            </Button>
                        ))}
                    </div>

                    {isLoading ? (
                        <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/70 p-5 text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            {t('common.loading', { defaultValue: 'Loading...' })}
                        </div>
                    ) : filteredOrders.length === 0 ? (
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
                    ) : (
                        <div className="space-y-3">
                            {filteredOrders.map((order) => (
                                <Card key={order.id} className="border-border/60 bg-card/70 transition-colors hover:border-primary/30">
                                    <CardContent className="space-y-4 p-5">
                                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                            <div className="space-y-1">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <span className="text-lg font-black">{order.order_number}</span>
                                                    <EcommerceStatusBadge status={order.status} />
                                                </div>
                                                <p className="text-sm text-muted-foreground">
                                                    {order.customer_name} • {order.items.length} {t('common.items', { defaultValue: 'Items' })}
                                                </p>
                                            </div>
                                            <div className="text-sm text-muted-foreground">
                                                {formatDateTime(order.created_at)}
                                            </div>
                                        </div>
                                        <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                                            <div>
                                                {formatCurrency(order.total, order.currency, features.iqd_display_preference)} • {order.customer_city || t('common.noData', { defaultValue: 'No data available' })}
                                            </div>
                                            <Button className="self-start rounded-xl" onClick={() => navigate(`/ecommerce/${order.id}`)}>
                                                {t('common.view', { defaultValue: 'View' })}
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}

function EcommerceDetailView({
    order,
    isSaving,
    onBack,
    onAdvance,
    onCancel
}: {
    order: MarketplaceOrderRecord
    isSaving: boolean
    onBack: () => void
    onAdvance: (nextStatus: MarketplaceOrderStatus) => Promise<void>
    onCancel: (reason: string) => Promise<void>
}) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
    const [cancelReason, setCancelReason] = useState('')
    const nextStatus = nextActionForStatus(order.status)

    const submitCancel = async () => {
        await onCancel(cancelReason)
        setCancelReason('')
        setCancelDialogOpen(false)
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="space-y-2">
                    <Button variant="ghost" className="gap-2 px-0" onClick={onBack}>
                        <ArrowLeft className="h-4 w-4" />
                        {t('common.back', { defaultValue: 'Back' })}
                    </Button>
                    <div className="flex flex-wrap items-center gap-3">
                        <h1 className="text-2xl font-bold">{order.order_number}</h1>
                        <EcommerceStatusBadge status={order.status} />
                    </div>
                </div>
                <div className="text-sm text-muted-foreground">{formatDateTime(order.created_at)}</div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
                <div className="space-y-6">
                    <Card className="border-border/60 bg-card/80">
                        <CardHeader>
                            <CardTitle>{t('ecommerce.customer', { defaultValue: 'Customer' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3 text-sm">
                            <div>
                                <div className="font-semibold">{order.customer_name}</div>
                                <div className="text-muted-foreground">{order.customer_phone}</div>
                            </div>
                            {order.customer_email && (
                                <div className="text-muted-foreground">{order.customer_email}</div>
                            )}
                            {order.customer_address && (
                                <div className="text-muted-foreground">{order.customer_address}</div>
                            )}
                            {order.customer_city && (
                                <div className="text-muted-foreground">{order.customer_city}</div>
                            )}
                            {order.customer_notes && (
                                <div className="rounded-2xl border border-border/60 bg-card/60 p-4 text-muted-foreground">
                                    {order.customer_notes}
                                </div>
                            )}
                            {order.cancel_reason && (
                                <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4 text-rose-700 dark:text-rose-300">
                                    {t('ecommerce.cancelReason', { defaultValue: 'Cancellation reason' })}: {order.cancel_reason}
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    <Card className="border-border/60 bg-card/80">
                        <CardHeader>
                            <CardTitle>{t('common.items', { defaultValue: 'Items' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {order.items.map((item, index) => (
                                <div key={`${item.product_id}-${index}`} className="rounded-2xl border border-border/60 bg-card/60 p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <div className="font-semibold">{item.name}</div>
                                            <div className="text-sm text-muted-foreground">{item.sku}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="font-semibold">× {item.quantity}</div>
                                            <div className="text-sm text-muted-foreground">
                                                {formatCurrency(item.line_total, item.currency, features.iqd_display_preference)}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}

                            <div className="rounded-2xl border border-border/60 bg-primary/5 p-4">
                                <div className="flex items-center justify-between text-sm text-muted-foreground">
                                    <span>{t('common.total', { defaultValue: 'Total' })}</span>
                                    <span className="text-lg font-black text-foreground">
                                        {formatCurrency(order.total, order.currency, features.iqd_display_preference)}
                                    </span>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <div className="space-y-6">
                    <Card className="border-border/60 bg-card/80">
                        <CardHeader>
                            <CardTitle>{t('ecommerce.timeline', { defaultValue: 'Status Timeline' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <TimelineRow label={t('ecommerce.timelineSubmitted', { defaultValue: 'Submitted' })} value={order.created_at} complete={true} />
                            <TimelineRow label={t('ecommerce.status.confirmed', { defaultValue: 'Confirmed' })} value={order.confirmed_at} complete={Boolean(order.confirmed_at)} />
                            <TimelineRow label={t('ecommerce.status.processing', { defaultValue: 'Processing' })} value={order.processing_at} complete={Boolean(order.processing_at)} />
                            <TimelineRow label={t('ecommerce.status.shipped', { defaultValue: 'Shipped' })} value={order.shipped_at} complete={Boolean(order.shipped_at)} />
                            <TimelineRow label={t('ecommerce.status.delivered', { defaultValue: 'Delivered' })} value={order.delivered_at} complete={Boolean(order.delivered_at)} />
                            {order.cancelled_at && (
                                <TimelineRow label={t('ecommerce.status.cancelled', { defaultValue: 'Cancelled' })} value={order.cancelled_at} complete={true} />
                            )}
                        </CardContent>
                    </Card>

                    <Card className="border-border/60 bg-card/80">
                        <CardHeader>
                            <CardTitle>{t('common.actions', { defaultValue: 'Actions' })}</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {nextStatus && (
                                <Button className="w-full rounded-2xl" disabled={isSaving} onClick={() => onAdvance(nextStatus)}>
                                    {isSaving ? (
                                        <>
                                            <Loader2 className="me-2 h-4 w-4 animate-spin" />
                                            {t('common.loading', { defaultValue: 'Loading...' })}
                                        </>
                                    ) : transitionActionLabel(t as any, nextStatus)}
                                </Button>
                            )}

                            {(order.status === 'pending' || order.status === 'confirmed' || order.status === 'processing') && (
                                <Button
                                    variant="outline"
                                    className="w-full rounded-2xl border-rose-500/30 text-rose-700 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-300"
                                    disabled={isSaving}
                                    onClick={() => setCancelDialogOpen(true)}
                                >
                                    {t('ecommerce.actions.cancel', { defaultValue: 'Cancel Order' })}
                                </Button>
                            )}

                            {order.status === 'delivered' && (
                                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-700 dark:text-emerald-300">
                                    {order.inventory_deducted
                                        ? t('ecommerce.inventoryDeducted', { defaultValue: 'Inventory deducted' })
                                        : t('ecommerce.inventoryWarning', { defaultValue: 'Some products may not have enough stock' })}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <Dialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('ecommerce.actions.cancel', { defaultValue: 'Cancel Order' })}</DialogTitle>
                    </DialogHeader>
                    <Textarea
                        value={cancelReason}
                        onChange={(event) => setCancelReason(event.target.value)}
                        placeholder={t('ecommerce.cancelReason', { defaultValue: 'Cancellation reason' })}
                        rows={4}
                    />
                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => setCancelDialogOpen(false)}>
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button className="bg-rose-600 hover:bg-rose-700" disabled={isSaving} onClick={submitCancel}>
                            {t('ecommerce.actions.cancel', { defaultValue: 'Cancel Order' })}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

export function Ecommerce() {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const [detailMatch, params] = useRoute('/ecommerce/:orderId')
    const [, navigate] = useLocation()
    const [orders, setOrders] = useState<MarketplaceOrderRecord[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [isSaving, setIsSaving] = useState(false)

    const loadOrders = async () => {
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
            ) as { data: MarketplaceOrderRecord[] | null; error: Error | null }

            if (error) {
                throw error
            }

            setOrders((data ?? []).map((order) => ({
                ...order,
                items: Array.isArray(order.items) ? order.items : []
            })))
        } catch (error) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error ? error.message : 'Failed to load marketplace orders',
                variant: 'destructive'
            })
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => {
        loadOrders()
    }, [user?.workspaceId])

    const transitionOrder = async (orderId: string, nextStatus: MarketplaceOrderStatus, cancelReason?: string) => {
        setIsSaving(true)
        try {
            const { data, error } = await runSupabaseAction('ecommerce.transitionOrder', () =>
                supabase.rpc('transition_marketplace_order', {
                    order_id: orderId,
                    next_status: nextStatus,
                    cancel_reason: cancelReason || null
                })
            ) as { data: { warning?: string | null } | null; error: Error | null }

            if (error) {
                throw error
            }

            await loadOrders()

            toast({
                title: t('common.success', { defaultValue: 'Success' }),
                description: data?.warning
                    || t('ecommerce.transitionSuccess', { defaultValue: 'Marketplace order updated successfully.' })
            })
        } catch (error) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error ? error.message : 'Failed to update marketplace order',
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
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
            <EcommerceDetailView
                order={activeOrder}
                isSaving={isSaving}
                onBack={() => navigate('/ecommerce')}
                onAdvance={(nextStatus) => transitionOrder(activeOrder.id, nextStatus)}
                onCancel={(reason) => transitionOrder(activeOrder.id, 'cancelled', reason)}
            />
        )
    }

    return (
        <EcommerceListView
            orders={orders}
            isLoading={isLoading}
            onRefresh={loadOrders}
        />
    )
}
