import { useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import {
    ArrowLeft,
    BadgeCheck,
    CalendarDays,
    CircleDollarSign,
    FileText,
    LayoutGrid,
    List,
    Loader2,
    MapPin,
    Package,
    PackageCheck,
    PackageSearch,
    Pencil,
    ShoppingBag,
    Truck,
    UsersRound,
    XCircle,
    type LucideIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import {
    getMarketplaceInventoryDisplayStatus,
    getMarketplaceOrderDisplayStatus
} from '@/lib/marketplaceOrderPresentation'
import { ORDER_STATUS_ADVANCE_HOLD_DURATION_MS } from '@/lib/pressAndHold'
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { buildWorkflowGradientFill } from '@/lib/workflowProgressGradient'
import { generateJumlaKhaleejInquiryPdf } from '@/lib/jumlaKhaleejInquiryPdf'
import { setPrintPreviewEditorSource } from '@/lib/printPreviewEditorStore'
import { printPdfBlob } from '@/services/pdfPrintService'
import { PressAndHoldButton } from '@/ui/components/PressAndHoldButton'
import { PdfJsViewer } from '@/ui/components/PdfJsViewer'
import { useWorkspace } from '@/workspace'
import { EditMarketplaceOrderItemsDialog, type EditableMarketplaceOrderItem } from '@/ui/components/ecommerce/EditMarketplaceOrderItemsDialog'
import {
    EcommerceStatusBadge,
    MarketplaceDeliveryFeeBadge
} from './MarketplaceOrderPresentation'
import { getMarketplaceDisplayItems } from './MarketplaceOrderDisplayItems'
import type { MarketplaceOrderRecord, MarketplaceOrderStatus } from './MarketplaceOrderTypes'
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
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea
} from '@/ui/components'

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

function transitionActionIcon(nextStatus: MarketplaceOrderStatus | null): LucideIcon {
    if (nextStatus === 'confirmed') return BadgeCheck
    if (nextStatus === 'processing') return Package
    if (nextStatus === 'shipped') return Truck
    if (nextStatus === 'delivered') return PackageCheck
    return PackageSearch
}

function marketplaceWorkflowProgress(status: MarketplaceOrderStatus, isReturned = false) {
    if (isReturned) return 100
    if (status === 'pending') return 20
    if (status === 'confirmed') return 40
    if (status === 'processing') return 60
    if (status === 'shipped') return 80
    return 100
}

function marketplaceWorkflowFill(status: MarketplaceOrderStatus, isReturned = false) {
    if (status === 'cancelled') {
        return { width: 100, background: 'linear-gradient(90deg, #f43f5e, #f43f5e)', backgroundSize: '100% 100%' }
    }

    const colors = ['#3b82f6', '#f59e0b', '#6366f1', 'hsl(var(--primary))', '#10b981']
    if (isReturned) colors.push('#f43f5e')
    const reached = isReturned
        ? colors.length
        : Math.max(1, Math.round(marketplaceWorkflowProgress(status) / 20))
    return buildWorkflowGradientFill(colors.map((color, index) => ({ color, reached: index < reached })))
}

function MarketplaceInquiryPdfCard({ order }: { order: MarketplaceOrderRecord }) {
    const { t } = useTranslation()
    const { session } = useAuth()
    const [, navigate] = useLocation()
    const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null)
    const [isGenerating, setIsGenerating] = useState(false)
    const [isOpeningEditor, setIsOpeningEditor] = useState(false)
    const [generationFailed, setGenerationFailed] = useState(false)

    const documentNumber = order.inquiry_pdf_document_number || order.order_number
    const isJumlaKhaleejInquiry = order.website_storefront_key === 'jumla-khaleej' && /^MKT-[0-9]{5,}$/.test(documentNumber)

    useEffect(() => {
        let cancelled = false
        if (!isJumlaKhaleejInquiry || !session?.access_token) {
            setPdfBytes(null)
            setGenerationFailed(false)
            setIsGenerating(false)
            return () => { cancelled = true }
        }

        setPdfBytes(null)
        setGenerationFailed(false)
        setIsGenerating(true)
        void generateJumlaKhaleejInquiryPdf({
            accessToken: session.access_token,
            orderId: order.id
        }).then((result) => {
            if (!cancelled) setPdfBytes(result.bytes)
        }).catch((error) => {
            console.error('[ecommerce] inquiry viewer preparation failed', error)
            if (!cancelled) setGenerationFailed(true)
        }).finally(() => {
            if (!cancelled) setIsGenerating(false)
        })

        return () => { cancelled = true }
    }, [documentNumber, isJumlaKhaleejInquiry, order.id, order.updated_at, session?.access_token])

    const handleView = async () => {
        if (!session?.access_token || isOpeningEditor) return

        setIsOpeningEditor(true)
        setGenerationFailed(false)
        try {
            // View intentionally generates again instead of reusing the card's
            // bytes, so the editor always receives the newest order/branding.
            const result = await generateJumlaKhaleejInquiryPdf({
                accessToken: session.access_token,
                orderId: order.id
            })
            setPdfBytes(result.bytes)
            setPrintPreviewEditorSource({
                title: `${t('ecommerce.inquiryPdf')} ${result.documentNumber}`,
                pdfBytes: result.bytes,
                onPrint: (blob) => printPdfBlob(blob, { title: result.documentNumber }),
                printActionLabel: t('common.print')
            })
            navigate('/print-preview-editor')
        } catch (error) {
            console.error('[ecommerce] inquiry editor preparation failed', error)
            setPdfBytes(null)
            setGenerationFailed(true)
        } finally {
            setIsOpeningEditor(false)
        }
    }

    if (!isJumlaKhaleejInquiry) return null

    return (
        <Card className="border-border/60 bg-card/80">
            <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
                <div>
                    <CardTitle>{t('ecommerce.inquiryPdf', { defaultValue: 'Inquiry PDF' })}</CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {documentNumber} • {formatDateTime(order.created_at)}
                    </p>
                </div>
                <Button
                    variant="outline"
                    className="gap-2 rounded-xl"
                    onClick={() => void handleView()}
                    disabled={isGenerating || isOpeningEditor || !session?.access_token}
                >
                    {isOpeningEditor ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                    {t('common.view', { defaultValue: 'View' })}
                </Button>
            </CardHeader>

            <CardContent className="h-[min(72dvh,900px)] min-h-[28rem] overflow-hidden border-t border-border/60 p-0">
                {isGenerating && <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />{t('ecommerce.generatingInquiryPdf', { defaultValue: 'Generating inquiry PDF…' })}</div>}
                {generationFailed && <div className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{t('ecommerce.inquiryPdfUnavailable', { defaultValue: 'This inquiry PDF could not be generated.' })}</div>}
                {pdfBytes && <PdfJsViewer bytes={pdfBytes} title={documentNumber} />}
            </CardContent>
        </Card>
    )
}

export function EcommerceDetailView({
    order,
    isSaving,
    isOpeningCollection,
    onAdvance,
    onCancel,
    onRecordCollection,
    onSaveItems
}: {
    order: MarketplaceOrderRecord
    isSaving: boolean
    isOpeningCollection: boolean
    onAdvance: (nextStatus: MarketplaceOrderStatus) => Promise<void>
    onCancel: (reason: string) => Promise<void>
    onRecordCollection: (salesOrderId: string) => Promise<void>
    onSaveItems: (orderId: string, items: EditableMarketplaceOrderItem[]) => Promise<void>
}) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const [, navigate] = useLocation()
    const [cancelDialogOpen, setCancelDialogOpen] = useState(false)
    const [cancelReason, setCancelReason] = useState('')
    const [editItemsOpen, setEditItemsOpen] = useState(false)
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => (
        localStorage.getItem('ecommerce_details_view_mode') === 'grid' ? 'grid' : 'table'
    ))
    const nextStatus = nextActionForStatus(order.status)
    const displayItems = getMarketplaceDisplayItems(order.items)
    const canEditItems = order.status !== 'delivered' && order.status !== 'cancelled'
    const AdvanceActionIcon = nextStatus ? transitionActionIcon(nextStatus) : null
    const displayStatus = getMarketplaceOrderDisplayStatus(order.status, order.sales_order_return_status)
    const inventoryDisplayStatus = getMarketplaceInventoryDisplayStatus(
        order.status,
        order.sales_order_return_status,
        order.inventory_deducted
    )
    const isReturned = displayStatus === 'returned'
    const workflowProgress = marketplaceWorkflowProgress(order.status, isReturned)
    const workflowFill = marketplaceWorkflowFill(order.status, isReturned)
    const activityRows = [
        { id: 'created', date: order.created_at, label: t('ecommerce.timelineSubmitted', { defaultValue: 'Submitted' }), amount: order.total, kind: 'created' },
        { id: 'confirmed', date: order.confirmed_at, label: t('ecommerce.status.confirmed', { defaultValue: 'Confirmed' }), amount: null, kind: 'confirmed' },
        { id: 'processing', date: order.processing_at, label: t('ecommerce.status.processing', { defaultValue: 'Processing' }), amount: null, kind: 'processing' },
        { id: 'shipped', date: order.shipped_at, label: t('ecommerce.status.shipped', { defaultValue: 'Shipped' }), amount: null, kind: 'shipped' },
        { id: 'delivered', date: order.delivered_at, label: t('ecommerce.status.delivered', { defaultValue: 'Delivered' }), amount: null, kind: 'delivered' },
        ...(isReturned ? [{
            id: 'returned',
            date: order.sales_order_returned_at ?? order.updated_at,
            label: t('ecommerce.status.returned', { defaultValue: 'Returned' }),
            amount: null,
            kind: 'returned'
        }] : []),
        { id: 'cancelled', date: order.cancelled_at, label: t('ecommerce.status.cancelled', { defaultValue: 'Cancelled' }), amount: null, kind: 'cancelled' }
    ]
        .filter((row) => Boolean(row.date))
        .sort((a, b) => new Date(b.date ?? '').getTime() - new Date(a.date ?? '').getTime())

    useEffect(() => {
        localStorage.setItem('ecommerce_details_view_mode', viewMode)
    }, [viewMode])

    const submitCancel = async () => {
        await onCancel(cancelReason)
        setCancelReason('')
        setCancelDialogOpen(false)
    }

    const renderTable = () => (
        <div className="overflow-x-auto rounded-2xl border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>{t('products.title', { defaultValue: 'Product' })}</TableHead>
                        <TableHead className="text-end">{t('orders.form.table.qty', { defaultValue: 'Qty' })}</TableHead>
                        <TableHead className="text-end">{t('orders.details.lineTotal', { defaultValue: 'Line Total' })}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {displayItems.map((item, index) => (
                        <TableRow key={`${item.product_id}-${index}`}>
                            <TableCell>
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/40">
                                        {item.image_url ? (
                                            <img
                                                src={item.image_url}
                                                alt=""
                                                className="h-full w-full object-contain p-1"
                                                loading="lazy"
                                            />
                                        ) : (
                                            <PackageSearch className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                                        )}
                                    </div>
                                    <div>
                                        <div className="font-semibold">{item.name}</div>
                                        <div className="text-xs text-muted-foreground">{item.sku}</div>
                                    </div>
                                </div>
                            </TableCell>
                            <TableCell className="text-end">× {item.quantity}</TableCell>
                            <TableCell className="text-end font-semibold">
                                {formatCurrency(item.line_total, item.currency, features.iqd_display_preference)}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    )

    const renderGrid = () => (
        <div className="grid gap-4 md:grid-cols-2">
            {displayItems.map((item, index) => (
                <div key={`${item.product_id}-${index}`} className="rounded-3xl border bg-background/80 p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/40">
                                {item.image_url ? (
                                    <img
                                        src={item.image_url}
                                        alt=""
                                        className="h-full w-full object-contain p-1"
                                        loading="lazy"
                                    />
                                ) : (
                                    <PackageSearch className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                                )}
                            </div>
                            <div className="min-w-0">
                                <div className="truncate text-lg font-semibold">{item.name}</div>
                                <div className="truncate text-xs text-muted-foreground">{item.sku}</div>
                            </div>
                        </div>
                        <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-primary">
                            × {item.quantity}
                        </span>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-2xl border bg-muted/20 p-3">
                            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.units', { defaultValue: 'Units' })}</div>
                            <div className="mt-1 font-medium">× {item.quantity}</div>
                        </div>
                        <div className="rounded-2xl border bg-muted/20 p-3">
                            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.lineTotal', { defaultValue: 'Line Total' })}</div>
                            <div className="mt-1 font-medium">{formatCurrency(item.line_total, item.currency, features.iqd_display_preference)}</div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Link href="/ecommerce" className="inline-flex items-center gap-1 hover:text-foreground">
                        <ArrowLeft className="h-4 w-4" />
                        {t('ecommerce.title', { defaultValue: 'E-Commerce' })}
                    </Link>
                    <span>/</span>
                    <span className="font-semibold text-foreground">{order.order_number}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {canEditItems && (
                        <Button variant="outline" disabled={isSaving} onClick={() => setEditItemsOpen(true)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            {t('ecommerce.actions.editItems', { defaultValue: 'Edit Items' })}
                        </Button>
                    )}
                    {nextStatus && AdvanceActionIcon ? (
                        <PressAndHoldButton
                            icon={<AdvanceActionIcon className="mr-2 h-4 w-4" aria-hidden="true" />}
                            disabled={isSaving}
                            onComplete={() => onAdvance(nextStatus)}
                            idleLabel={transitionActionLabel(t as any, nextStatus)}
                            holdingLabel={t('orders.actions.keepHolding', { defaultValue: 'Keep holding…' })}
                            loadingLabel={transitionActionLabel(t as any, nextStatus)}
                            isLoading={isSaving}
                            durationMs={ORDER_STATUS_ADVANCE_HOLD_DURATION_MS}
                        />
                    ) : null}
                    {(order.status === 'pending' || order.status === 'confirmed' || order.status === 'processing') && (
                        <Button
                            variant="outline"
                            className="border-rose-500/30 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 hover:text-rose-800"
                            disabled={isSaving}
                            onClick={() => setCancelDialogOpen(true)}
                        >
                            <XCircle className="mr-2 h-4 w-4" />
                            {t('ecommerce.actions.cancel', { defaultValue: 'Cancel Order' })}
                        </Button>
                    )}
                    {order.status === 'delivered' && order.sales_order_id ? (
                        <Button
                            variant="outline"
                            disabled={isSaving || isOpeningCollection}
                            onClick={() => navigate(`/orders/${order.sales_order_id}`)}
                        >
                            <FileText className="mr-2 h-4 w-4" aria-hidden="true" />
                            {t('ecommerce.actions.viewSalesOrder', { defaultValue: 'View Sales Order' })}
                        </Button>
                    ) : null}
                    {order.status === 'delivered' && order.sales_order_id ? (
                        <Button variant="outline" disabled={isSaving || isOpeningCollection} onClick={() => onRecordCollection(order.sales_order_id as string)}>
                            {isOpeningCollection
                                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                                : <CircleDollarSign className="mr-2 h-4 w-4" aria-hidden="true" />}
                            {isOpeningCollection
                                ? t('common.loading', { defaultValue: 'Loading…' })
                                : t('ecommerce.actions.collect', { defaultValue: 'Record Collection' })}
                        </Button>
                    ) : null}
                </div>
            </div>

            <Card className={cn(
                'overflow-hidden border-sky-500/20',
                order.status === 'cancelled' || isReturned
                    ? 'bg-gradient-to-br from-rose-500/15 via-background to-rose-500/10'
                    : order.status === 'delivered'
                        ? 'bg-gradient-to-br from-emerald-500/10 via-background to-primary/10'
                        : 'bg-gradient-to-br from-sky-500/10 via-background to-primary/10'
            )}>
                <CardContent className="p-6">
                    <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
                        <div className="flex items-start gap-4">
                            <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-sky-500/30 bg-sky-500/10 sm:flex">
                                <ShoppingBag className="h-6 w-6 text-sky-700 dark:text-sky-300" aria-hidden="true" />
                            </div>
                            <div className="space-y-4">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="inline-flex items-center rounded-full border border-sky-500/20 bg-sky-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-sky-700 dark:text-sky-300">
                                        {t('ecommerce.title', { defaultValue: 'E-Commerce' })}
                                    </span>
                                    <EcommerceStatusBadge status={displayStatus} />
                                    <MarketplaceDeliveryFeeBadge fee={order.delivery_fee} />
                                    {inventoryDisplayStatus && (
                                        <span className={cn(
                                            'inline-flex items-center rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em]',
                                            inventoryDisplayStatus === 'returned'
                                                ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                                                : inventoryDisplayStatus === 'deducted'
                                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                                : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                        )}>
                                            {inventoryDisplayStatus === 'returned'
                                                ? t('ecommerce.inventoryReturned', { defaultValue: 'Inventory Returned' })
                                                : inventoryDisplayStatus === 'deducted'
                                                    ? t('ecommerce.inventoryDeducted', { defaultValue: 'Inventory Deducted' })
                                                    : t('ecommerce.inventoryWarning', { defaultValue: 'Not Fully Deducted' })}
                                        </span>
                                    )}
                                </div>
                                <div>
                                    <div className="text-sm font-medium text-muted-foreground">{t('ecommerce.orderNumber', { defaultValue: 'E-commerce order number' })}</div>
                                    <div className="mt-1 text-3xl font-black tracking-tight">{order.order_number}</div>
                                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                        <span className="inline-flex items-center gap-1.5"><UsersRound className="h-4 w-4" />{order.customer_name}</span>
                                        <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                                        <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" />{formatDate(order.created_at)}</span>
                                        {order.customer_city && (
                                            <>
                                                <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                                                <span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4" />{order.customer_city}</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="rounded-3xl border border-border/50 bg-background/80 p-5 shadow-sm">
                            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{t('common.total', { defaultValue: 'Total' })}</div>
                            <div className="mt-2 text-4xl font-black tracking-tight">{formatCurrency(order.total, order.currency, features.iqd_display_preference)}</div>
                            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                                <div>
                                    <div className="text-xs text-muted-foreground">{t('orders.details.subtotal', { defaultValue: 'Subtotal' })}</div>
                                    <div className="font-semibold">{formatCurrency(order.subtotal, order.currency, features.iqd_display_preference)}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-muted-foreground">{t('ecommerce.currency', { defaultValue: 'Currency' })}</div>
                                    <div className="font-semibold">{order.currency.toUpperCase()}</div>
                                </div>
                            </div>
                            {order.delivery_fee !== null ? (
                                <div className="mt-4 flex items-center justify-between gap-3 border-t border-violet-500/20 pt-3">
                                    <div>
                                        <div className="text-xs font-bold uppercase tracking-[0.14em] text-violet-700 dark:text-violet-300">{t('ecommerce.deliveryFee', { defaultValue: 'Delivery fee' })}</div>
                                        <div className="mt-1 text-xs text-muted-foreground">{t('ecommerce.deliveryFeeExcluded', { defaultValue: 'Shown separately; not included in the order total.' })}</div>
                                    </div>
                                    <MarketplaceDeliveryFeeBadge fee={order.delivery_fee} />
                                </div>
                            ) : null}
                        </div>
                    </div>

                    <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                        <div className="rounded-2xl border bg-background/70 p-4">
                            <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('ecommerce.customer', { defaultValue: 'Customer' })}</div>
                            <div className="mt-2 truncate text-2xl font-black">{order.customer_name}</div>
                        </div>
                        <div className="rounded-2xl border bg-background/70 p-4">
                            <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('ecommerce.customerPhone', { defaultValue: 'Phone' })}</div>
                            <div className="mt-2 truncate text-2xl font-black">{order.customer_phone}</div>
                        </div>
                        <div className="rounded-2xl border bg-background/70 p-4">
                            <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('ecommerce.customerCity', { defaultValue: 'City' })}</div>
                            <div className="mt-2 text-2xl font-black">{order.customer_city || '—'}</div>
                        </div>
                        <div className="rounded-2xl border bg-background/70 p-4">
                            <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('ecommerce.customerAddress', { defaultValue: 'Delivery Address' })}</div>
                            <div className="mt-2 truncate text-2xl font-black">{order.customer_address || '—'}</div>
                        </div>
                    </div>

                    <div className="mt-6 space-y-2">
                        <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                            <span>{t('orders.details.workflowProgress', { defaultValue: 'Workflow Progress' })}</span>
                            <span>{workflowProgress}%</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-background/80">
                            <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{
                                    width: `${workflowFill.width}%`,
                                    background: workflowFill.background,
                                    backgroundSize: workflowFill.backgroundSize,
                                    backgroundRepeat: 'no-repeat'
                                }}
                            />
                        </div>
                    </div>
                </CardContent>
            </Card>

            <div className="grid items-start gap-4 lg:grid-cols-3">
                <div className="space-y-4 lg:col-span-2">
                    <Card>
                        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <CardTitle>{t('ecommerce.orderItems', { defaultValue: 'Order Items' })}</CardTitle>
                            <div className="hidden items-center rounded-lg border bg-muted/30 p-1 md:flex">
                                <Button variant="ghost" size="sm" onClick={() => setViewMode('table')} className={cn('h-8 gap-1.5 px-3 text-[10px] font-black uppercase tracking-[0.16em]', viewMode === 'table' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground')}>
                                    <List className="h-3 w-3" />{t('common.table', { defaultValue: 'Table' })}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setViewMode('grid')} className={cn('h-8 gap-1.5 px-3 text-[10px] font-black uppercase tracking-[0.16em]', viewMode === 'grid' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground')}>
                                    <LayoutGrid className="h-3 w-3" />{t('common.grid', { defaultValue: 'Grid' })}
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {viewMode === 'grid' ? renderGrid() : renderTable()}
                            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/10 bg-primary/5 p-4">
                                <div className="text-sm text-muted-foreground">
                                    {t('orders.details.subtotal', { defaultValue: 'Subtotal' })}
                                </div>
                                <div className="text-sm font-bold">
                                    {formatCurrency(order.subtotal, order.currency, features.iqd_display_preference)}
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <MarketplaceInquiryPdfCard order={order} />
                </div>

                <div className="space-y-4">
                    <Card>
                        <CardHeader><CardTitle>{t('ecommerce.customer', { defaultValue: 'Customer' })}</CardTitle></CardHeader>
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
                                <div className="rounded-2xl border-2 border-amber-500/40 bg-amber-500/5 p-4">
                                    <div className="mb-1 flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-300">
                                        <FileText className="h-4 w-4" aria-hidden="true" />
                                        {t('ecommerce.customerNote', { defaultValue: 'Note' })}:
                                    </div>
                                    <div className="whitespace-pre-wrap">{order.customer_notes}</div>
                                </div>
                            )}
                            {order.cancel_reason && (
                                <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4 text-rose-700 dark:text-rose-300">
                                    {t('ecommerce.cancelReason', { defaultValue: 'Cancellation reason' })}: {order.cancel_reason}
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {order.sales_order_id || order.customer_id || order.business_partner_id ? (
                        <Card className="border-sky-500/20 bg-sky-500/5">
                            <CardHeader className="pb-3"><CardTitle className="text-sky-700 dark:text-sky-300">{t('ecommerce.erpRegistration', { defaultValue: 'Registered in ERP' })}</CardTitle></CardHeader>
                            <CardContent className="flex flex-wrap gap-2">
                                {order.sales_order_id ? (
                                    <Button variant="outline" className="rounded-xl" onClick={() => navigate(`/orders/${order.sales_order_id}`)}>
                                        {t('orders.title', { defaultValue: 'Orders' })}
                                    </Button>
                                ) : null}
                                {order.customer_id ? (
                                    <Button variant="outline" className="rounded-xl" onClick={() => navigate(`/customers/${order.customer_id}`)}>
                                        {t('customers.title', { defaultValue: 'Customers' })}
                                    </Button>
                                ) : null}
                                {order.business_partner_id ? (
                                    <Button variant="outline" className="rounded-xl" onClick={() => navigate(`/business-partners/${order.business_partner_id}`)}>
                                        {t('businessPartners.title', { defaultValue: 'Business Partners' })}
                                    </Button>
                                ) : null}
                            </CardContent>
                        </Card>
                    ) : null}

                    <Card>
                        <CardHeader><CardTitle>{t('orders.details.commercials', { defaultValue: 'Commercials' })}</CardTitle></CardHeader>
                        <CardContent className="grid gap-3 text-sm">
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                                <div className="rounded-2xl border bg-muted/20 p-3">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('orders.details.created', { defaultValue: 'Created' })}</div>
                                    <div className="mt-1 font-medium">{formatDateTime(order.created_at)}</div>
                                </div>
                                <div className="rounded-2xl border bg-muted/20 p-3">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('ecommerce.lastUpdated', { defaultValue: 'Last Updated' })}</div>
                                    <div className="mt-1 font-medium">{formatDateTime(order.updated_at)}</div>
                                </div>
                                <div className="rounded-2xl border bg-muted/20 p-3">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('common.currency', { defaultValue: 'Currency' })}</div>
                                    <div className="mt-1 font-medium">{order.currency.toUpperCase()}</div>
                                </div>
                                <div className="rounded-2xl border bg-muted/20 p-3">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('orders.details.items', { defaultValue: 'Items' })}</div>
                                    <div className="mt-1 font-medium">{displayItems.length}</div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader><CardTitle>{t('loans.recentActivity', { defaultValue: 'Recent Activity' })}</CardTitle></CardHeader>
                        <CardContent>
                            <div className="relative ps-4 space-y-6 before:absolute before:start-0 before:top-2 before:bottom-2 before:w-0.5 before:bg-border/60">
                                {activityRows.slice(0, 8).map(row => {
                                    return (
                                        <div key={row.id} className="relative group">
                                            <div className={cn(
                                                "absolute -start-[1.375rem] top-1.5 w-3 h-3 rounded-full border-2 border-background z-10 transition-transform group-hover:scale-125",
                                                row.kind === 'cancelled' || row.kind === 'returned'
                                                    ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.4)]'
                                                    : row.kind === 'confirmed'
                                                        ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                                                    : row.kind === 'processing'
                                                        ? 'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.4)]'
                                                    : row.kind === 'created'
                                                        ? "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.4)]"
                                                        : row.kind === 'delivered'
                                                            ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]"
                                                            : "bg-primary"
                                            )} />
                                            <div className="space-y-0.5">
                                                <div className={cn(
                                                    'font-bold text-sm leading-none transition-colors group-hover:text-primary',
                                                    row.kind === 'returned' && 'text-rose-700 dark:text-rose-300 group-hover:text-rose-700 dark:group-hover:text-rose-300'
                                                )}>
                                                    {row.label}
                                                </div>
                                                <div className="text-muted-foreground text-xs font-medium flex items-center gap-1.5 pt-1">
                                                    <span>{formatDateTime(row.date ?? '')}</span>
                                                    {row.amount !== null ? (
                                                        <>
                                                            <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                                                            <span className="font-bold text-foreground/80">
                                                                {formatCurrency(row.amount, order.currency, features.iqd_display_preference)}
                                                            </span>
                                                        </>
                                                    ) : null}
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
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

            <EditMarketplaceOrderItemsDialog
                isOpen={editItemsOpen}
                order={order}
                isSaving={isSaving}
                onOpenChange={setEditItemsOpen}
                onSave={(items) => onSaveItems(order.id, items)}
            />
        </div>
    )
}
