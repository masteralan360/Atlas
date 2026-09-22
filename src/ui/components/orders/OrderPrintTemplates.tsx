import {
    getOrderBalanceAmount,
    getOrderPaidAmount,
    getOrderPaymentStatus,
    type SalesOrder,
    type PurchaseOrder,
    type OrderInstallment,
    type IQDDisplayPreference,
    type OrderAdjustment
} from '@/local-db'
import { getOrderLineFreeBonusQuantity, getOrderLinePaidInventoryQuantity, getOrderLinePaidQuantity, hasOrderLineFreeBonus } from '@/lib/orderLineItems'
import {
    getOrderTotalWithPostReturnAdjustments,
    isPostReturnOrderAdjustment,
    normalizeOrderAdjustments
} from '@/lib/orderAdjustments'
import {
    getA4OrderPrintReturnRowStyle,
    getOrderPrintOriginalTotal,
    getOrderPrintReturnState,
    type OrderPrintVersion
} from '@/lib/orderPrintReturnState'
import { cn, formatCurrency, formatDate, formatDateTime, formatSnapshotTime } from '@/lib/utils'
import { normalizeUnitCode } from '@/local-db/models'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ReactQRCode } from '@lglab/react-qr-code'
import { MapPin, Phone } from 'lucide-react'
import { EditableField } from '@/ui/components/EditableField'
import type { ReactNode } from 'react'
import type { CustomTemplateComponentPosition } from '@/lib/printPreviewEditorStore'
import { MovableOrderPrintBlock } from '../MovableComponentPrint'
import { HideablePrintFieldCard } from '@/ui/components/print/HideablePrintFieldCard'
import { OrderPrintReturnValue } from './OrderPrintReturnValue'

type OrderTab = 'sales' | 'purchase'

interface OrderListPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    salesOrders: SalesOrder[]
    purchaseOrders: PurchaseOrder[]
    activeTab: OrderTab
    iqdPreference?: IQDDisplayPreference
    metrics: {
        totalOrders: number
        totalValue: number
        paidCount: number
        unpaidCount: number
    }
    logoUrl?: string | null
    qrValue?: string | null
}

interface WorkspaceContactPair {
    primary?: string
    nonPrimary?: string
}

interface WorkspaceFooterContacts {
    address?: WorkspaceContactPair
    email?: WorkspaceContactPair
    phone?: WorkspaceContactPair
}

interface OrderDetailsPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    order: SalesOrder | PurchaseOrder
    installments?: OrderInstallment[]
    kind: 'sales' | 'purchase'
    iqdPreference?: IQDDisplayPreference
    logoUrl?: string | null
    qrValue?: string | null
    hideUnit?: boolean
    /** Current product units used only as a fallback for orders created before unit snapshots existed. */
    productUnits?: Record<string, string | null | undefined>
    hideDiscount?: boolean
    templateFields?: Record<string, string>
    counterpartyPhone?: string
    counterpartyAddress?: string
    tableRowCount?: number
    componentPositions?: Record<string, CustomTemplateComponentPosition>
    hiddenFields?: Record<string, boolean>
    editableComponents?: boolean
    onComponentPositionChange?: (key: string, position: CustomTemplateComponentPosition) => void
    onHiddenFieldChange?: (key: string, hidden: boolean) => void
    workspaceFooterContacts?: WorkspaceFooterContacts
    /** Whether to show adjusted values or the original pre-return order. */
    printVersion?: OrderPrintVersion
}

export const ORDER_PRINT_COMMON_FIELD_KEYS = {
    showOrderAdjustments: 'showOrderAdjustments'
} as const

export const ORDER_RECEIPT_TEMPLATE_FIELD_KEYS = {
    showExchangeRateSnapshots: 'orderReceipt.showExchangeRateSnapshots',
    showOriginalCurrencyPrice: 'orderReceipt.showOriginalCurrencyPrice',
    showOrderAdjustments: ORDER_PRINT_COMMON_FIELD_KEYS.showOrderAdjustments,
    hideUnit: 'orderReceipt.hideUnit',
    hideDiscount: 'orderReceipt.hideDiscount',
    showNotes: 'orderReceipt.showNotes',
    showContacts: 'orderReceipt.showContacts',
    thankYou: 'orderReceipt.thankYou',
    keepRecord: 'orderReceipt.keepRecord',
    labelOpacity: 'orderReceipt.labelOpacity',
} as const

export const ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS = {
    logo: 'orderReceiptLogo',
    workspaceName: 'orderReceiptWorkspaceName',
    qrCode: 'orderReceiptQrCode',
    orderMeta: 'orderReceiptOrderMeta',
    counterparty: 'orderReceiptCounterparty',
    payment: 'orderReceiptPayment',
    exchangeRateSnapshots: 'orderReceiptExchangeRateSnapshots',
    itemsTable: 'orderReceiptItemsTable',
    totals: 'orderReceiptTotals',
    notes: 'orderReceiptNotes',
    contacts: 'orderReceiptContacts',
    thankYou: 'orderReceiptThankYou',
    keepRecord: 'orderReceiptKeepRecord',
} as const

interface OrderReceiptPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    order: SalesOrder | PurchaseOrder
    installments?: OrderInstallment[]
    kind: 'sales' | 'purchase'
    iqdPreference?: IQDDisplayPreference
    logoUrl?: string | null
    qrValue?: string | null
    /** Current product units used only as a fallback for orders created before unit snapshots existed. */
    productUnits?: Record<string, string | null | undefined>
    counterpartyPhone?: string
    workspaceFooterContacts?: WorkspaceFooterContacts
    templateFields?: Record<string, string>
    editableFields?: boolean
    onTemplateFieldChange?: (key: string, value: string) => void
    componentPositions?: Record<string, CustomTemplateComponentPosition>
    editableComponents?: boolean
    onComponentPositionChange?: (key: string, position: CustomTemplateComponentPosition) => void
    /** Whether to show adjusted values or the original pre-return order. */
    printVersion?: OrderPrintVersion
}

export const ORDER_DETAILS_MOVABLE_COMPONENT_KEYS = {
    customer: 'customer',
    commercials: 'commercials',
    created: 'created',
    expectedDelivery: 'expectedDelivery',
    orderItems: 'orderItems',
    totals: 'totals',
    workspaceName: 'workspaceName',
    title: 'title',
    subtitle: 'subtitle',
    qrCode: 'qrCode',
    logo: 'logo',
    contacts: 'contacts',
    notes: 'notes'
} as const

function isRTL(lang: string): boolean {
    const baseLang = (lang || 'en').split('-')[0]
    return baseLang === 'ar' || baseLang === 'ku'
}

function resolveLogoSrc(logoUrl?: string | null) {
    if (!logoUrl) return null
    return logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl)
}

const DEFAULT_ORDER_TABLE_ROW_COUNT = 10

function getOrderLineUnit(
    item: { productId: string; unit?: string | null },
    productUnits?: Record<string, string | null | undefined>
) {
    return normalizeUnitCode(item.unit) || normalizeUnitCode(productUnits?.[item.productId]) || ''
}

function formatOrderLineUnit(
    t: TFunction<'translation', undefined>,
    item: { productId: string; unit?: string | null; unitRef?: string | null; unitNameSnapshot?: string | null },
    productUnits?: Record<string, string | null | undefined>
) {
    if (item.unitRef?.startsWith('custom:') && item.unitNameSnapshot) return item.unitNameSnapshot
    const unit = getOrderLineUnit(item, productUnits)
    return unit ? t(`products.units.${unit}`, { defaultValue: unit }) : ''
}

function formatOrderLineBaseEquivalent(
    t: TFunction<'translation', undefined>,
    item: { quantity?: unknown; inventoryQuantity?: unknown; unitFactor?: unknown; baseUnitRef?: string | null; baseUnitCode?: string | null; baseUnitNameSnapshot?: string | null }
) {
    const factor = Number(item.unitFactor ?? 1)
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return ''
    const unit = item.baseUnitRef?.startsWith('custom:') && item.baseUnitNameSnapshot
        ? item.baseUnitNameSnapshot
        : item.baseUnitCode ? t(`products.units.${item.baseUnitCode}`, { defaultValue: item.baseUnitCode }) : ''
    return `${getOrderLinePaidInventoryQuantity(item)}${unit ? ` ${unit}` : ''}`
}

function getOrderLineFreeBonusUnit(
    item: { productId: string; unit?: string | null; freeBonusUnit?: string | null },
    productUnits?: Record<string, string | null | undefined>
) {
    return normalizeUnitCode(item.freeBonusUnit) || getOrderLineUnit(item, productUnits)
}

function formatOrderLineFreeBonusUnit(
    t: TFunction<'translation', undefined>,
    item: { productId: string; unit?: string | null; freeBonusUnit?: string | null },
    productUnits?: Record<string, string | null | undefined>
) {
    const unit = getOrderLineFreeBonusUnit(item, productUnits)
    return unit ? t(`products.units.${unit}`, { defaultValue: unit }) : ''
}

function buildOrderItemRows(items: Array<{ id: string; productId: string; productName: string; productSku?: string | null; quantity: number; freeBonusQuantity?: number | null; freeBonusUnit?: string | null; convertedUnitPrice: number; lineTotal: number; unit?: string | null }>, rowCount: number) {
    const overflowItems = items.slice(rowCount - 1)
    return Array.from({ length: rowCount }, (_, index) => {
        if (index < rowCount - 1) return items[index] || null
        if (items.length <= rowCount) return items[index] || null
        const overflowTotal = overflowItems.reduce((sum, item) => sum + item.lineTotal, 0)
        const overflowQty = overflowItems.reduce((sum, item) => sum + getOrderLinePaidQuantity(item), 0)
        const overflowFreeBonus = overflowItems.reduce((sum, item) => sum + getOrderLineFreeBonusQuantity(item), 0)
        return {
            id: 'additional-items',
            productId: '',
            productName: `Additional ${overflowItems.length} item${overflowItems.length === 1 ? '' : 's'}`,
            productSku: '',
            quantity: overflowQty,
            freeBonusQuantity: overflowFreeBonus,
            convertedUnitPrice: 0,
            lineTotal: overflowTotal,
        }
    })
}

function getOrderAdjustmentRowLabel(t: TFunction<'translation', undefined>, adjustment: OrderAdjustment) {
    const rowLabel = isPostReturnOrderAdjustment(adjustment)
        ? t('orders.adjustments.postReturn.printRow', { defaultValue: 'Post-return adjustment' })
        : t('orders.adjustments.printRow', { defaultValue: 'Order adjustment' })
    const typeLabel = adjustment.type === 'addition'
        ? t('orders.adjustments.addition', { defaultValue: 'Addition (+)' })
        : t('orders.adjustments.deduction', { defaultValue: 'Deduction (−)' })

    return `${rowLabel} — ${adjustment.name} (${typeLabel})`
}

function formatSignedOrderAdjustment(adjustment: OrderAdjustment, currency: string, iqdPreference: IQDDisplayPreference) {
    const sign = adjustment.type === 'addition' ? '+' : '−'
    return `${sign}${formatCurrency(adjustment.convertedAmount, currency, iqdPreference)}`
}

interface OrderPrintHeaderProps {
    workspaceName?: string | null
    title: string
    subtitle?: ReactNode
    logoUrl?: string | null
    qrValue?: string | null
    componentPositions?: Record<string, CustomTemplateComponentPosition>
    editableComponents?: boolean
    onComponentPositionChange?: (key: string, position: CustomTemplateComponentPosition) => void
}

function OrderPrintHeader({
    workspaceName,
    title,
    subtitle,
    logoUrl,
    qrValue,
    componentPositions,
    editableComponents,
    onComponentPositionChange
}: OrderPrintHeaderProps) {
    const { t } = useTranslation()
    const logoSrc = resolveLogoSrc(logoUrl)

    return (
        <div className="border-b border-slate-300 pb-3 mb-4">
            <div className="flex items-start justify-between gap-3">
                <div className="w-1/3 flex flex-col items-start">
                    <MovableOrderPrintBlock
                        componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.logo}
                        label={t('customTemplates.movable.logo', { defaultValue: 'Logo' })}
                        position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.logo]}
                        editable={editableComponents}
                        onPositionChange={onComponentPositionChange}
                        resizable
                        maxScale={4}
                    >
                        <div className="flex items-start w-full max-w-[180px]">
                            {logoSrc ? (
                                <img
                                    src={logoSrc}
                                    alt="Workspace Logo"
                                    className="max-h-16 max-w-full object-contain object-left"
                                />
                            ) : (
                                <div className="h-10 flex items-center bg-gray-100 border border-gray-200 justify-center w-40 text-gray-400 font-bold tracking-wider uppercase">
                                    LOGO
                                </div>
                            )}
                        </div>
                    </MovableOrderPrintBlock>
                </div>

                <div className="w-1/3 flex justify-center pt-1">
                    {qrValue ? (
                        <MovableOrderPrintBlock
                            componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.qrCode}
                            label={t('customTemplates.movable.qrCode', { defaultValue: 'QR Code' })}
                            position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.qrCode]}
                            editable={editableComponents}
                            onPositionChange={onComponentPositionChange}
                        >
                            <div className="p-1.5 bg-white border border-slate-200 rounded" data-qr-sharp="true">
                                <ReactQRCode
                                    value={qrValue}
                                    size={64}
                                    level="M"
                                />
                            </div>
                        </MovableOrderPrintBlock>
                    ) : null}
                </div>

                <div className="w-1/3 flex flex-col items-center text-center">
                    <MovableOrderPrintBlock
                        componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.workspaceName}
                        label={t('customTemplates.movable.workspaceName', { defaultValue: 'Workspace Name' })}
                        position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.workspaceName]}
                        editable={editableComponents}
                        onPositionChange={onComponentPositionChange}
                        fontSizeEditable
                        defaultFontSize={20}
                    >
                        <h1 className="text-xl font-bold">{workspaceName || 'Atlas'}</h1>
                    </MovableOrderPrintBlock>
                    <MovableOrderPrintBlock
                        componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.title}
                        label={t('customTemplates.movable.title', { defaultValue: 'Title' })}
                        position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.title]}
                        editable={editableComponents}
                        onPositionChange={onComponentPositionChange}
                    >
                        <p className="text-sm font-semibold">{title}</p>
                    </MovableOrderPrintBlock>
                    {subtitle ? (
                        <MovableOrderPrintBlock
                            componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.subtitle}
                            label={t('customTemplates.movable.subtitle', { defaultValue: 'Subtitle' })}
                            position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.subtitle]}
                            editable={editableComponents}
                            onPositionChange={onComponentPositionChange}
                        >
                            <p className="text-[11px] text-slate-600">{subtitle}</p>
                        </MovableOrderPrintBlock>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

function resolveStatusLabel(t: (key: string) => string, status: string): string {
    const translated = t(`orders.status.${status}`)
    return translated && translated !== `orders.status.${status}` ? translated : status
}

function resolvePaymentLabel(t: (key: string) => string, method?: string | null): string {
    switch (method) {
        case 'cash': return t('pos.cash') || 'Cash'
        case 'fib': return 'FIB'
        case 'qicard': return 'Qi Card'
        case 'zaincash': return 'Zain Cash'
        case 'fastpay': return 'FastPay'
        case 'bank_transfer': return 'Bank Transfer'
        case 'loan': return t('nav.loans') || 'Loans'
        case 'installments': return t('nav.installments') || 'Installments'
        default: return method || '-'
    }
}

function resolvePaymentStatusLabel(
    t: (key: string, options?: Record<string, unknown>) => string,
    order: SalesOrder | PurchaseOrder
) {
    const status = getOrderPaymentStatus(order)
    if (status === 'paid') return t('orders.status.paid', { defaultValue: 'Paid' })
    if (status === 'partial') return t('orders.status.partial', { defaultValue: 'Partially Paid' })
    return t('orders.status.unpaid', { defaultValue: 'Unpaid' })
}

export function OrderListPrintTemplate({
    workspaceName,
    printLang,
    salesOrders,
    purchaseOrders,
    activeTab,
    iqdPreference = 'IQD',
    metrics,
    logoUrl,
    qrValue
}: OrderListPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const isSales = activeTab === 'sales'
    const title = isSales
        ? (t('orders.tabs.sales') || 'Sales Orders')
        : (t('orders.tabs.purchase') || 'Purchase Orders')

    return (
        <div
            dir={isRTL(printLang) ? 'rtl' : 'ltr'}
            className="bg-white text-black"
            style={{ width: '210mm', minHeight: '297mm', padding: '14mm 12mm' }}
        >
            <style
                dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; margin: 0; padding: 0; }
}
`
                }}
            />

            <OrderPrintHeader
                workspaceName={workspaceName}
                title={title}
                subtitle={formatDateTime(new Date().toISOString())}
                logoUrl={logoUrl}
                qrValue={qrValue}
            />

            <div className="grid grid-cols-2 items-start gap-3 mb-4 text-xs">
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500 text-center">{t('orders.print.totalOrders') || 'Total Orders'}</p>
                    <p className="font-bold text-center">{metrics.totalOrders}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500 text-center">{t('orders.print.totalValue') || 'Total Value'}</p>
                    <p className="font-bold text-center">
                        {isSales && salesOrders.length > 0
                            ? formatCurrency(metrics.totalValue, salesOrders[0].currency, iqdPreference)
                            : !isSales && purchaseOrders.length > 0
                                ? formatCurrency(metrics.totalValue, purchaseOrders[0].currency, iqdPreference)
                                : metrics.totalValue}
                    </p>
                </div>
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500 text-center">{t('budget.status.paid') || 'Paid'}</p>
                    <p className="font-bold text-center">{metrics.paidCount}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500 text-center">{t('budget.status.pending') || 'Unpaid'}</p>
                    <p className="font-bold text-center">{metrics.unpaidCount}</p>
                </div>
            </div>

            {isSales ? (
                <table className="w-full border-collapse text-xs">
                    <thead>
                        <tr className="bg-slate-100">
                            <th className="border border-slate-300 p-2 text-start">{t('orders.table.orderNumber') || 'Order #'}</th>
                            <th className="border border-slate-300 p-2 text-start">{t('orders.table.customer') || 'Customer'}</th>
                            <th className="border border-slate-300 p-2 text-center">{t('orders.table.items') || 'Items'}</th>
                            <th className="border border-slate-300 p-2 text-start">{t('common.status') || 'Status'}</th>
                            <th className="border border-slate-300 p-2 text-end">{t('common.total') || 'Total'}</th>
                            <th className="border border-slate-300 p-2 text-start">{t('orders.form.date') || 'Date'}</th>
                            <th className="border border-slate-300 p-2 text-start">{t('pos.paymentMethod') || 'Payment'}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {salesOrders.length === 0 ? (
                            <tr>
                                <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={7}>
                                    {t('common.noData') || 'No data'}
                                </td>
                            </tr>
                        ) : salesOrders.map((order) => (
                            <tr key={order.id}>
                                <td className="border border-slate-300 p-2 font-semibold">{order.orderNumber}</td>
                                <td className="border border-slate-300 p-2">{order.customerName}</td>
                                <td className="border border-slate-300 p-2 text-center">{order.items.length}</td>
                                <td className="border border-slate-300 p-2">{resolveStatusLabel(t, order.status)}</td>
                                <td className="border border-slate-300 p-2 text-end font-semibold">{formatCurrency(order.total, order.currency, iqdPreference)}</td>
                                <td className="border border-slate-300 p-2">{formatDate(order.createdAt)}</td>
                                <td className="border border-slate-300 p-2">
                                    <span className={getOrderPaymentStatus(order) !== 'unpaid' ? 'font-semibold' : ''}>
                                        {resolvePaymentStatusLabel(t, order)}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : (
                <table className="w-full border-collapse text-xs">
                    <thead>
                        <tr className="bg-slate-100">
                            <th className="border border-slate-300 p-2 text-start">{t('orders.table.orderNumber') || 'Order #'}</th>
                            <th className="border border-slate-300 p-2 text-start">{t('suppliers.title') || 'Supplier'}</th>
                            <th className="border border-slate-300 p-2 text-center">{t('orders.table.items') || 'Items'}</th>
                            <th className="border border-slate-300 p-2 text-start">{t('common.status') || 'Status'}</th>
                            <th className="border border-slate-300 p-2 text-end">{t('common.total') || 'Total'}</th>
                            <th className="border border-slate-300 p-2 text-start">{t('orders.form.date') || 'Date'}</th>
                            <th className="border border-slate-300 p-2 text-start">{t('pos.paymentMethod') || 'Payment'}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {purchaseOrders.length === 0 ? (
                            <tr>
                                <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={7}>
                                    {t('common.noData') || 'No data'}
                                </td>
                            </tr>
                        ) : purchaseOrders.map((order) => (
                            <tr key={order.id}>
                                <td className="border border-slate-300 p-2 font-semibold">{order.orderNumber}</td>
                                <td className="border border-slate-300 p-2">{order.supplierName}</td>
                                <td className="border border-slate-300 p-2 text-center">{order.items.length}</td>
                                <td className="border border-slate-300 p-2">{resolveStatusLabel(t, order.status)}</td>
                                <td className="border border-slate-300 p-2 text-end font-semibold">{formatCurrency(order.total, order.currency, iqdPreference)}</td>
                                <td className="border border-slate-300 p-2">{formatDate(order.createdAt)}</td>
                                <td className="border border-slate-300 p-2">
                                    <span className={getOrderPaymentStatus(order) !== 'unpaid' ? 'font-semibold' : ''}>
                                        {resolvePaymentStatusLabel(t, order)}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    )
}

export function OrderReceiptPrintTemplate({
    workspaceName,
    printLang,
    order,
    installments = [],
    kind,
    iqdPreference = 'IQD',
    logoUrl,
    qrValue,
    productUnits,
    counterpartyPhone,
    workspaceFooterContacts,
    templateFields,
    editableFields = false,
    onTemplateFieldChange,
    componentPositions,
    editableComponents,
    onComponentPositionChange,
    printVersion = 'adjusted',
}: OrderReceiptPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const isSales = kind === 'sales'
    const isOriginalPrint = isSales && printVersion === 'original'
    const salesOrder = isSales ? order as SalesOrder : null
    const purchaseOrder = !isSales ? order as PurchaseOrder : null
    const isReceiptRtl = isRTL(printLang)
    const counterpartyLabel = isSales
        ? (t('orders.details.customer') || 'Customer')
        : (t('orders.details.supplier') || 'Supplier')
    const counterpartyName = isSales ? salesOrder?.customerName : purchaseOrder?.supplierName
    const title = isSales
        ? (t('orders.details.salesOrder') || 'Sales Order')
        : (t('orders.details.purchaseOrder') || 'Purchase Order')
    const fieldValue = (key: string) => templateFields?.[key]
    const isFieldEnabled = (key: string) => fieldValue(key) !== 'false'
    const showOrderAdjustments = isFieldEnabled(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showOrderAdjustments)
    const normalizedOrderAdjustments = normalizeOrderAdjustments(order.orderAdjustments, order.currency)
    const orderAdjustments = showOrderAdjustments && printVersion !== 'returned'
        ? normalizedOrderAdjustments.filter((adjustment) => !isOriginalPrint || !isPostReturnOrderAdjustment(adjustment))
        : []
    const displayedTotal = isOriginalPrint
        ? getOrderPrintOriginalTotal(order)
        : showOrderAdjustments
            ? getOrderTotalWithPostReturnAdjustments(order.total, normalizedOrderAdjustments)
            : order.total
    const showExchangeRateSnapshots = isFieldEnabled(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showExchangeRateSnapshots)
    const showOriginalCurrencyPrice = isFieldEnabled(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showOriginalCurrencyPrice)
    const hideUnit = fieldValue(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.hideUnit) === 'true'
    const hideDiscount = fieldValue(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.hideDiscount) === 'true'
    const showNotes = isFieldEnabled(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showNotes)
    const showContacts = isFieldEnabled(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showContacts)
    const thankYouText = fieldValue(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.thankYou)?.trim()
        || t('sales.receipt.thankYou', { defaultValue: 'Thank you for your order!' })
    const keepRecordText = fieldValue(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.keepRecord)?.trim()
        || t('sales.receipt.keepRecord', { defaultValue: 'Please keep this receipt for your records.' })
    const labelOpacity = Math.min(100, Math.max(0, parseInt(fieldValue(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.labelOpacity) || '100', 10)))
    const showFreeBonus = hasOrderLineFreeBonus(order.items || [])
    const hasExchangeRates = Boolean(
        showExchangeRateSnapshots
        && order.items.some((item) => item.originalCurrency !== item.settlementCurrency)
        && order.exchangeRates?.length
    )
    const paymentStatus = resolvePaymentStatusLabel(t, order)
    const paidAmount = getOrderPaidAmount(order)
    const balanceAmount = getOrderBalanceAmount(order)
    const noteValue = order.notes?.trim()
    const nextInstallment = installments
        .filter((installment) => installment.balanceAmount > 0)
        .sort((left, right) => left.dueDate.localeCompare(right.dueDate))[0]
    const logoSrc = resolveLogoSrc(logoUrl)
    const mp = (
        key: string,
        label: string,
        children: ReactNode,
        wrapperClassName?: string,
        handleSide?: 'left' | 'right',
        minY?: number,
        pushFlow?: boolean,
        options?: { resizable?: boolean; fontSizeEditable?: boolean; defaultFontSize?: number }
    ) => (
        <MovableOrderPrintBlock
            componentKey={key}
            label={label}
            position={componentPositions?.[key]}
            editable={editableComponents}
            onPositionChange={onComponentPositionChange}
            wrapperClassName={wrapperClassName}
            handleSide={handleSide}
            minY={minY}
            pushFlow={pushFlow}
            resizable={options?.resizable}
            maxScale={4}
            fontSizeEditable={options?.fontSizeEditable}
            defaultFontSize={options?.defaultFontSize}
        >
            {children}
        </MovableOrderPrintBlock>
    )

    const formatReceiptPrice = (amount: number, currency: string, showSign = false) => {
        const code = currency.toLowerCase()
        const absoluteAmount = showSign ? Math.abs(amount) : amount
        const formatted = code === 'iqd'
            ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 }).format(absoluteAmount)
            : code === 'eur'
                ? new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(absoluteAmount)
                : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(absoluteAmount)
        const currencyLabel = code === 'iqd'
            ? (iqdPreference === 'IQD' ? 'IQD' : 'IQD')
            : code.toUpperCase()
        const sign = showSign ? amount < 0 ? '−' : amount > 0 ? '+' : '' : ''

        return (
            <div className="flex max-w-full min-w-0 flex-col items-end leading-none">
                <span className="break-all text-end font-bold">{sign}{formatted}</span>
                <span className="mt-0.5 text-[9px] font-medium text-black" style={{ opacity: labelOpacity / 100 }}>
                    {currencyLabel}
                </span>
            </div>
        )
    }

    return (
        <div
            dir={isReceiptRtl ? 'rtl' : 'ltr'}
            className="a4-container bg-white p-8 text-black print:w-[80mm] print:p-0 print:text-sm"
            style={{ width: '80mm', minHeight: '200mm' }}
            data-order-print-page
            data-page-width-mm="80"
        >
            <style dangerouslySetInnerHTML={{
                __html: `
.a4-container { color-scheme: light !important; background-color: white !important; color: black !important; }
@media print {
    @page { margin: 0; size: 80mm auto; }
    body { background: white !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    .order-template-move-handle { display: none !important; }
}
`
            }} />

            <div className="mb-4 flex items-center justify-between">
                {mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.logo, 'Logo',
                    logoSrc ? (
                        <img src={logoSrc} alt="Workspace Logo" className="h-16 w-auto object-contain" />
                    ) : null,
                    'flex flex-1 justify-center', undefined, undefined, undefined,
                    { resizable: true }
                )}
                {mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.qrCode, 'QR Code',
                    qrValue ? (
                        <div className="rounded-sm border border-gray-100 bg-white p-1" data-qr-sharp="true">
                            <ReactQRCode value={qrValue} size={64} level="M" />
                        </div>
                    ) : null,
                    'flex justify-end'
                )}
            </div>

            {mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.workspaceName, 'Workspace Name',
                <div className="mb-1 text-center">
                    <h1 className="text-2xl font-bold">{workspaceName || 'Atlas'}</h1>
                    <p className="mt-1 text-xs font-semibold">{title}</p>
                </div>, undefined, undefined, undefined, undefined, { fontSizeEditable: true, defaultFontSize: 24 }
            )}

            <div className="mb-4 grid grid-cols-2 gap-4 text-xs">
                {mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.orderMeta, 'Order Details',
                    <div className="space-y-2">
                        <div>
                            <span className={cn('block text-[10px] font-semibold text-black', !isReceiptRtl && 'uppercase tracking-wider')} style={{ opacity: labelOpacity / 100 }}>
                                {t('orders.table.orderNumber', { defaultValue: 'Order #' })}
                            </span>
                            <span className="font-mono font-medium">{order.orderNumber}</span>
                        </div>
                        <div>
                            <span className={cn('block text-[10px] font-semibold text-black', !isReceiptRtl && 'uppercase tracking-wider')} style={{ opacity: labelOpacity / 100 }}>
                                {t('orders.details.created', { defaultValue: 'Created' })}
                            </span>
                            <span className="font-mono">{formatDateTime(order.createdAt)}</span>
                        </div>
                        {order.expectedDeliveryDate ? (
                            <div>
                                <span className={cn('block text-[10px] font-semibold text-black', !isReceiptRtl && 'uppercase tracking-wider')} style={{ opacity: labelOpacity / 100 }}>
                                    {t('orders.details.expectedDelivery', { defaultValue: 'Expected Delivery' })}
                                </span>
                                <span className="font-mono">{formatDate(order.expectedDeliveryDate)}</span>
                            </div>
                        ) : null}
                    </div>,
                    'w-full', 'left'
                )}
                <div className="space-y-3 text-end">
                    {mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.counterparty, counterpartyLabel,
                        <div>
                            <span className={cn('block text-[10px] font-semibold text-black', !isReceiptRtl && 'uppercase tracking-wider')} style={{ opacity: labelOpacity / 100 }}>
                                {counterpartyLabel}
                            </span>
                            <span className="font-medium">{counterpartyName || '-'}</span>
                            {counterpartyPhone ? <span className="mt-0.5 block font-mono text-[11px]">{counterpartyPhone}</span> : null}
                            {isSales && salesOrder?.shippingAddress ? (
                                <span className="mt-1 block text-[10px] text-black" style={{ opacity: labelOpacity / 100 }}>
                                    {salesOrder.shippingAddress}
                                </span>
                            ) : null}
                        </div>,
                        'w-full', 'right'
                    )}
                    {mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.payment, 'Payment',
                        <div>
                            <span className={cn('block text-[10px] font-semibold text-black', !isReceiptRtl && 'uppercase tracking-wider')} style={{ opacity: labelOpacity / 100 }}>
                                {t('pos.paymentMethod', { defaultValue: 'Payment' })}
                            </span>
                            <span className="font-medium">{resolvePaymentLabel(t, order.paymentMethod)}</span>
                            <span className="mt-0.5 block text-[11px]">
                                {paymentStatus}{order.paidAt ? ` - ${formatDate(order.paidAt)}` : ''}
                            </span>
                        </div>,
                        'w-full', 'right'
                    )}
                </div>
            </div>

            {hasExchangeRates ? mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.exchangeRateSnapshots, 'Exchange Rate Snapshots',
                <div className="mb-5 border-t border-gray-200 pt-4 text-start">
                    <div className={cn('mb-2 text-[10px] font-bold text-black', !isReceiptRtl && 'uppercase tracking-wider')} style={{ opacity: labelOpacity / 100 }}>
                        {t('settings.exchangeRate.title', { defaultValue: 'Exchange Rates' })} {t('common.snapshots', { defaultValue: 'Snapshots' })}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {order.exchangeRates!.map((rate, index) => (
                            <div key={`${rate.pair}-${index}`} className="rounded border border-gray-200 bg-gray-50/50 p-2">
                                <div className="mb-1 flex items-center justify-between gap-2">
                                    <span className="text-[10px] font-bold">{rate.pair}</span>
                                    <span className="text-[9px] uppercase text-gray-500">{rate.source}</span>
                                </div>
                                <div className="font-mono text-[11px] font-bold">
                                    {rate.priceBasisAmount || 100} {rate.pair.split('/')[0]} = {formatCurrency(rate.rate, rate.pair.split('/')[1]?.toLowerCase() as any, iqdPreference)}
                                </div>
                                <div className="mt-1 font-mono text-[9px] text-gray-500">{formatSnapshotTime(rate.timestamp)}</div>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}

            {mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.itemsTable, 'Items Table',
                <div className="mb-4">
                    <table className="w-full table-fixed text-sm">
                        <colgroup>
                            <col style={{ width: '44%' }} />
                            <col style={{ width: '11%' }} />
                            <col style={{ width: '22.5%' }} />
                            <col style={{ width: '22.5%' }} />
                        </colgroup>
                        <thead>
                            <tr className={cn('border-b border-black text-[10px] text-black', !isReceiptRtl && 'uppercase')} style={{ opacity: labelOpacity / 100 }}>
                                <th className={cn('pb-2 text-start font-bold', !isReceiptRtl && 'tracking-wider')}>{t('products.table.name', { defaultValue: 'Product' })}</th>
                                <th className={cn('pb-2 text-center font-bold', !isReceiptRtl && 'tracking-wider')}>{t('common.quantity', { defaultValue: 'Qty' })}</th>
                                <th className={cn('pb-2 text-end font-bold', !isReceiptRtl && 'tracking-wider')}>{t('common.price', { defaultValue: 'Price' })}</th>
                                <th className={cn('pb-2 text-end font-bold', !isReceiptRtl && 'tracking-wider')}>{t('common.total', { defaultValue: 'Total' })}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-black" style={{ '--tw-divide-opacity': labelOpacity / 100 } as React.CSSProperties}>
                            {order.items.map((item) => {
                                const isConverted = item.originalCurrency && item.settlementCurrency && item.originalCurrency !== item.settlementCurrency
                                const quantity = getOrderLinePaidQuantity(item)
                                const freeBonus = getOrderLineFreeBonusQuantity(item)
                                const unit = formatOrderLineUnit(t, item, productUnits)
                                const freeBonusUnit = formatOrderLineFreeBonusUnit(t, item, productUnits)
                                const baseEquivalent = formatOrderLineBaseEquivalent(t, item)
                                const returnState = isSales && !isOriginalPrint ? getOrderPrintReturnState(item) : null
                                return (
                                    <tr key={item.id} data-order-print-return-state={returnState?.status}>
                                        <td className="py-3 align-top text-start">
                                            <div className="break-words [overflow-wrap:anywhere] text-sm font-bold">{item.productName}</div>
                                            {item.productSku ? <div className="mt-0.5 break-all font-mono text-[10px] text-black" style={{ opacity: labelOpacity / 100 }}>{item.productSku}</div> : null}
                                            {returnState && returnState.status !== 'active' ? (
                                                <div className="mt-0.5 text-[10px] font-bold uppercase">
                                                    {returnState.status === 'fully-returned'
                                                        ? (t('sales.return.returnedStatus') || 'Returned')
                                                        : (t('sales.return.partialReturn') || 'Partial Return')}
                                                </div>
                                            ) : null}
                                            {showFreeBonus && freeBonus > 0 ? (
                                                <div className="mt-0.5 text-[10px] text-black" style={{ opacity: labelOpacity / 100 }}>
                                                    {t('orders.details.freeBonus', { defaultValue: 'Free bonus' })}: {freeBonus}{!hideUnit && freeBonusUnit ? ` ${freeBonusUnit}` : ''}
                                                </div>
                                            ) : null}
                                        </td>
                                        <td className="py-3 text-center align-top font-mono">
                                            <div>{returnState
                                                ? <OrderPrintReturnValue
                                                    state={returnState}
                                                    original={`${quantity}${!hideUnit && unit ? ` ${unit}` : ''}`}
                                                    remaining={`${returnState.remainingQuantity}${!hideUnit && unit ? ` ${unit}` : ''}`}
                                                    stacked
                                                    className="items-center"
                                                />
                                                : `${quantity}${!hideUnit && unit ? ` ${unit}` : ''}`}</div>
                                            {baseEquivalent ? <div className="mt-0.5 text-[9px] opacity-60">{baseEquivalent}</div> : null}
                                        </td>
                                        <td className="min-w-0 py-3 align-top text-end">
                                            {formatReceiptPrice(item.convertedUnitPrice, order.currency)}
                                            {showOriginalCurrencyPrice && isConverted ? (
                                                <div className="mt-1 origin-right scale-90 opacity-60">
                                                    {formatReceiptPrice(item.originalUnitPrice, item.originalCurrency)}
                                                </div>
                                            ) : null}
                                        </td>
                                        <td className="min-w-0 py-3 align-top text-end">
                                            {returnState
                                                ? <OrderPrintReturnValue
                                                    state={returnState}
                                                    original={formatReceiptPrice(returnState.originalLineTotal, order.currency)}
                                                    remaining={formatReceiptPrice(returnState.remainingLineTotal, order.currency)}
                                                    stacked
                                                    className="items-end"
                                                />
                                                : formatReceiptPrice(item.lineTotal, order.currency)}
                                            {showOriginalCurrencyPrice && isConverted ? (
                                                <div className="mt-1 origin-right scale-90 opacity-60 line-through decoration-gray-400">
                                                    {formatReceiptPrice(item.originalUnitPrice * quantity, item.originalCurrency)}
                                                </div>
                                            ) : null}
                                        </td>
                                    </tr>
                                )
                            })}
                            {orderAdjustments.map((adjustment) => {
                                const signedAmount = adjustment.type === 'addition'
                                    ? adjustment.convertedAmount
                                    : -adjustment.convertedAmount
                                return (
                                    <tr key={`order-adjustment-${adjustment.id}`} data-order-print-row-type="adjustment">
                                        <td className="py-3 align-top text-start">
                                            <div className="break-words [overflow-wrap:anywhere] text-sm font-bold">
                                                {getOrderAdjustmentRowLabel(t, adjustment)}
                                            </div>
                                        </td>
                                        <td className="py-3 text-center align-top">—</td>
                                        <td className="py-3 text-end align-top">—</td>
                                        <td className="min-w-0 py-3 align-top text-end">
                                            {formatReceiptPrice(signedAmount, order.currency, true)}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                    <div className="mt-4 border-t-2 border-black" style={{ '--tw-border-opacity': labelOpacity / 100 } as React.CSSProperties} />
                </div>,
                undefined, undefined, undefined, true
            )}

            {mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.totals, 'Totals',
                <div className="mb-7 space-y-2 pt-2 text-sm">
                    <div className="flex justify-between"><span style={{ opacity: labelOpacity / 100 }}>{t('orders.details.subtotal', { defaultValue: 'Subtotal' })}</span>{formatReceiptPrice(order.subtotal, order.currency)}</div>
                    {!hideDiscount ? <div className="flex justify-between"><span style={{ opacity: labelOpacity / 100 }}>{t('orders.details.discount', { defaultValue: 'Discount' })}</span>{formatReceiptPrice(order.discount, order.currency)}</div> : null}
                    {isSales && salesOrder ? <div className="flex justify-between"><span style={{ opacity: labelOpacity / 100 }}>{t('orders.details.tax', { defaultValue: 'Tax' })}</span>{formatReceiptPrice(salesOrder.tax, order.currency)}</div> : null}
                    <div className="flex items-end justify-between border-t border-black pt-3">
                        <span className={cn('text-sm font-bold text-black', !isReceiptRtl && 'uppercase tracking-wider')} style={{ opacity: labelOpacity / 100 }}>{t('common.total', { defaultValue: 'Total' })}</span>
                        <span className="text-3xl font-black tracking-tight">{formatCurrency(displayedTotal, order.currency, iqdPreference)}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 border-t border-gray-200 pt-2 text-xs">
                        <div><span className="block text-[10px]" style={{ opacity: labelOpacity / 100 }}>{t('orders.details.paidAmount', { defaultValue: 'Paid' })}</span><span className="font-semibold">{formatCurrency(paidAmount, order.currency, iqdPreference)}</span></div>
                        <div className="text-end"><span className="block text-[10px]" style={{ opacity: labelOpacity / 100 }}>{t('orders.details.outstanding', { defaultValue: 'Outstanding' })}</span><span className="font-semibold">{formatCurrency(balanceAmount, order.currency, iqdPreference)}</span></div>
                    </div>
                    {nextInstallment ? <div className="border-t border-gray-200 pt-2 text-xs"><span style={{ opacity: labelOpacity / 100 }}>{t('orders.details.nextDueDate', { defaultValue: 'Next payment due' })}: </span><span className="font-medium">{formatDate(nextInstallment.dueDate)} - {formatCurrency(nextInstallment.balanceAmount, order.currency, iqdPreference)}</span></div> : null}
                </div>,
                undefined, 'right', 0, true
            )}

            {showNotes && noteValue ? mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.notes, 'Notes',
                <div className="mb-5 border-t border-gray-200 pt-3 text-xs">
                    <span className={cn('block text-[10px] font-semibold text-black', !isReceiptRtl && 'uppercase tracking-wider')} style={{ opacity: labelOpacity / 100 }}>{t('orders.details.notes', { defaultValue: 'Notes' })}</span>
                    <p className="mt-1 whitespace-pre-wrap break-words">{noteValue}</p>
                </div>,
                undefined, 'right', 0, true
            ) : null}

            {showContacts ? mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.contacts, 'Contacts',
                <div className="mb-5 flex flex-wrap justify-center gap-x-3 gap-y-1 border-t border-gray-100 pt-3 text-center text-[10px] text-black" style={{ opacity: labelOpacity / 100 }}>
                    {[workspaceFooterContacts?.address?.primary, workspaceFooterContacts?.phone?.primary]
                        .filter((value): value is string => Boolean(value?.trim()))
                        .map((value) => <span key={value}>{value}</span>)}
                </div>,
                undefined, 'right', 0, true
            ) : null}

            <div className="border-t border-gray-100 pt-5 text-center text-[10px] text-gray-400">
                {mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.thankYou, 'Thank You',
                    <p className="mb-1 font-medium text-gray-900">
                        <EditableField value={thankYouText} onChange={(value) => onTemplateFieldChange?.(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.thankYou, value)} editable={editableFields} />
                    </p>,
                    undefined, 'right', 0, true
                )}
                {mp(ORDER_RECEIPT_MOVABLE_COMPONENT_KEYS.keepRecord, 'Keep Record',
                    <span className="text-black" style={{ opacity: labelOpacity / 100 }}>
                        <EditableField value={keepRecordText} onChange={(value) => onTemplateFieldChange?.(ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.keepRecord, value)} editable={editableFields} />
                    </span>,
                    undefined, 'right', 0, true
                )}
            </div>
        </div>
    )
}

export function OrderDetailsPrintTemplate({
    workspaceName,
    printLang,
    order,
    installments = [],
    kind,
    iqdPreference = 'IQD',
    logoUrl,
    qrValue,
    hideUnit,
    productUnits,
    hideDiscount,
    templateFields,
    counterpartyPhone,
    counterpartyAddress,
    tableRowCount,
    componentPositions,
    hiddenFields,
    editableComponents,
    onComponentPositionChange,
    onHiddenFieldChange,
    workspaceFooterContacts,
    printVersion = 'adjusted'
}: OrderDetailsPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const isSales = kind === 'sales'
    const isOriginalPrint = isSales && printVersion === 'original'
    const showOrderAdjustments = templateFields?.[ORDER_PRINT_COMMON_FIELD_KEYS.showOrderAdjustments] !== 'false'
    const normalizedOrderAdjustments = normalizeOrderAdjustments(order.orderAdjustments, order.currency)
    const orderAdjustments = showOrderAdjustments && printVersion !== 'returned'
        ? normalizedOrderAdjustments.filter((adjustment) => !isOriginalPrint || !isPostReturnOrderAdjustment(adjustment))
        : []
    const displayedTotal = isOriginalPrint
        ? getOrderPrintOriginalTotal(order)
        : showOrderAdjustments
            ? getOrderTotalWithPostReturnAdjustments(order.total, normalizedOrderAdjustments)
            : order.total
    const salesOrder = isSales ? (order as SalesOrder) : null
    const purchaseOrder = !isSales ? (order as PurchaseOrder) : null
    const currency = order.currency
    const noteValue = order.notes?.trim()
    const rowCount = tableRowCount || DEFAULT_ORDER_TABLE_ROW_COUNT
    const itemRows = buildOrderItemRows(order.items || [], Math.max(1, rowCount - orderAdjustments.length))
    const populatedItemRows = itemRows.filter((item) => item !== null)
    const emptyItemRowCount = itemRows.length - populatedItemRows.length
    const showFreeBonus = hasOrderLineFreeBonus(order.items || [])
    const labelOpacity = Math.min(100, Math.max(0, parseInt(templateFields?.labelOpacity || '50', 10)))
    const labelOpacityStyle = { opacity: labelOpacity / 100 }
    const boldAllText = templateFields?.boldAllText === 'true'

    const counterpartyLabel = isSales
        ? (t('orders.details.customer') || 'Customer')
        : (t('orders.details.supplier') || 'Supplier')
    const counterpartyName = isSales
        ? salesOrder!.customerName
        : purchaseOrder!.supplierName
    const resolvedCounterpartyPhone = (templateFields?.counterpartyPhone || counterpartyPhone || '').trim()
    const resolvedCounterpartyAddress = (templateFields?.counterpartyAddress || counterpartyAddress || '').trim()
    const title = isSales
        ? (t('orders.details.salesOrder') || 'Sales Order')
        : (t('orders.details.purchaseOrder') || 'Purchase Order')

    return (
        <div
            dir={isRTL(printLang) ? 'rtl' : 'ltr'}
            className={cn('bg-white text-black', boldAllText && 'font-bold [&_*]:!font-bold')}
            style={{ width: '210mm', minHeight: '297mm', padding: '14mm 12mm' }}
            data-order-print-page
            data-page-width-mm="210"
            data-print-preview-editor-isolate-components
        >
            <style
                dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; margin: 0; padding: 0; }
    .order-template-move-handle { display: none !important; }
}
`
                }}
            />

            <OrderPrintHeader
                workspaceName={workspaceName}
                title={title}
                subtitle={
                    <span className="flex items-center justify-center gap-1 text-black" style={labelOpacityStyle}>
                        <span className="font-semibold">{order.orderNumber}</span>
                        <span>•</span>
                        <span>{formatDateTime(new Date().toISOString())}</span>
                    </span>
                }
                logoUrl={logoUrl}
                qrValue={qrValue}
                componentPositions={componentPositions}
                editableComponents={editableComponents}
                onComponentPositionChange={onComponentPositionChange}
            />

            <div className="grid grid-cols-2 items-start gap-4 mb-4 text-xs text-center">
                <MovableOrderPrintBlock
                    componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.customer}
                    label={counterpartyLabel}
                    position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.customer]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                <HideablePrintFieldCard
                    title={counterpartyLabel}
                    className="border border-slate-300 rounded-md p-3"
                    hiddenFields={hiddenFields}
                    onHiddenFieldChange={onHiddenFieldChange}
                    fields={[
                        {
                            key: 'orders.counterparty.name',
                            label: counterpartyLabel,
                            value: counterpartyName,
                            render: <p className="font-bold text-sm">{counterpartyName}</p>
                        },
                        ...(resolvedCounterpartyPhone ? [{
                            key: 'orders.counterparty.phone',
                            label: t('orders.details.phone', { defaultValue: 'Phone' }),
                            value: resolvedCounterpartyPhone,
                            render: (
                                <p className="mt-1 flex items-center justify-center gap-1 leading-5 text-black" style={labelOpacityStyle}>
                                    <Phone className="h-4 w-4 shrink-0" />
                                    <span>{resolvedCounterpartyPhone}</span>
                                </p>
                            )
                        }] : []),
                        ...(resolvedCounterpartyAddress ? [{
                            key: 'orders.counterparty.address',
                            label: t('common.address', { defaultValue: 'Address' }),
                            value: resolvedCounterpartyAddress,
                            render: (
                                <p className="mt-1 flex items-center justify-center gap-1 leading-5 text-black" style={labelOpacityStyle}>
                                    <MapPin className="h-4 w-4 shrink-0" />
                                    <span className="whitespace-pre-wrap break-words">{resolvedCounterpartyAddress}</span>
                                </p>
                            )
                        }] : []),
                        ...(isSales && salesOrder?.shippingAddress ? [{
                            key: 'orders.counterparty.shippingAddress',
                            label: t('orders.details.shippingAddress', { defaultValue: 'Shipping Address' }),
                            value: salesOrder.shippingAddress,
                            render: <p className="mt-1 text-black" style={labelOpacityStyle}>{salesOrder.shippingAddress}</p>
                        }] : [])
                    ]}
                />
                </MovableOrderPrintBlock>
                <MovableOrderPrintBlock
                    componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.commercials}
                    label={t('orders.details.commercials') || 'Commercials'}
                    position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.commercials]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                <HideablePrintFieldCard
                    title={t('orders.details.commercials') || 'Order Summary'}
                    className="border border-slate-300 rounded-md p-3"
                    hiddenFields={hiddenFields}
                    onHiddenFieldChange={onHiddenFieldChange}
                    fields={[
                        {
                            key: 'orders.commercials.subtotal',
                            label: t('orders.details.subtotal') || 'Subtotal',
                            value: formatCurrency(order.subtotal, currency, iqdPreference)
                        },
                        ...(!hideDiscount ? [{
                            key: 'orders.commercials.discount',
                            label: t('orders.details.discount') || 'Discount',
                            value: formatCurrency(order.discount, currency, iqdPreference)
                        }] : []),
                        ...(isSales && salesOrder ? [{
                            key: 'orders.commercials.tax',
                            label: t('orders.details.tax') || 'Tax',
                            value: formatCurrency(salesOrder.tax, currency, iqdPreference)
                        }] : []),
                        {
                            key: 'orders.commercials.total',
                            label: t('common.total') || 'Total',
                            value: formatCurrency(displayedTotal, currency, iqdPreference),
                            className: 'font-bold'
                        },
                        {
                            key: 'orders.commercials.status',
                            label: t('common.status') || 'Status',
                            value: resolveStatusLabel(t, order.status)
                        },
                        {
                            key: 'orders.commercials.paymentMethod',
                            label: t('pos.paymentMethod') || 'Payment',
                            value: resolvePaymentLabel(t, order.paymentMethod)
                        },
                        {
                            key: 'orders.commercials.paymentStatus',
                            label: t('payments.status', { defaultValue: 'Payment Status' }),
                            value: `${resolvePaymentStatusLabel(t, order)}${order.paidAt ? ` \u2022 ${formatDate(order.paidAt)}` : ''}`,
                            render: <p>{resolvePaymentStatusLabel(t, order)}{order.paidAt ? ` \u2022 ${formatDate(order.paidAt)}` : ''}</p>
                        },
                        {
                            key: 'orders.commercials.paidAmount',
                            label: t('orders.details.paidAmount', { defaultValue: 'Paid' }),
                            value: formatCurrency(getOrderPaidAmount(order), order.currency, iqdPreference)
                        },
                        {
                            key: 'orders.commercials.outstanding',
                            label: t('orders.details.outstanding', { defaultValue: 'Outstanding' }),
                            value: formatCurrency(getOrderBalanceAmount(order), order.currency, iqdPreference)
                        }
                    ]}
                />
                </MovableOrderPrintBlock>
            </div>

            <div className="grid grid-cols-2 items-start gap-3 mb-4 text-xs">
                <MovableOrderPrintBlock
                    componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.created}
                    label={t('orders.details.created') || 'Created'}
                    position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.created]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                <HideablePrintFieldCard
                    title={<span className="text-black" style={labelOpacityStyle}>{t('orders.details.created') || 'Created'}</span>}
                    className="border border-slate-300 rounded-md p-2"
                    titleClassName="text-slate-500 text-center font-normal mb-0"
                    hiddenFields={hiddenFields}
                    onHiddenFieldChange={onHiddenFieldChange}
                    fields={[
                        {
                            key: 'orders.created.createdAt',
                            label: t('orders.details.created') || 'Created',
                            value: formatDateTime(order.createdAt),
                            render: <p className="font-bold text-center">{formatDateTime(order.createdAt)}</p>
                        }
                    ]}
                />
                </MovableOrderPrintBlock>
                <MovableOrderPrintBlock
                    componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.expectedDelivery}
                    label={t('orders.details.expectedDelivery') || 'Expected Delivery'}
                    position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.expectedDelivery]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                <HideablePrintFieldCard
                    title={<span className="text-black" style={labelOpacityStyle}>{t('orders.details.expectedDelivery') || 'Expected Delivery'}</span>}
                    className="border border-slate-300 rounded-md p-2"
                    titleClassName="text-slate-500 text-center font-normal mb-0"
                    hiddenFields={hiddenFields}
                    onHiddenFieldChange={onHiddenFieldChange}
                    fields={[
                        {
                            key: 'orders.expectedDelivery.date',
                            label: t('orders.details.expectedDelivery') || 'Expected Delivery',
                            value: order.expectedDeliveryDate ? formatDateTime(order.expectedDeliveryDate) : 'N/A',
                            render: <p className="font-bold text-center">{order.expectedDeliveryDate ? formatDateTime(order.expectedDeliveryDate) : 'N/A'}</p>
                        }
                    ]}
                />
                </MovableOrderPrintBlock>
            </div>

            <MovableOrderPrintBlock
                componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.orderItems}
                label={t('orders.details.orderItems') || 'Order Items'}
                position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.orderItems]}
                editable={editableComponents}
                onPositionChange={onComponentPositionChange}
            >
            <h3 className="font-semibold mb-2 text-sm">{t('orders.details.orderItems') || 'Order Items'}</h3>
            <table className="w-full border-collapse text-xs mb-5">
                <thead className="bg-slate-300" style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
                    <tr>
                        <th className="border border-slate-500 bg-slate-300 p-2 text-start font-bold text-slate-950">{t('products.title') || 'Product'}</th>
                        <th className="border border-slate-500 bg-slate-300 p-2 text-start font-bold text-slate-950">SKU</th>
                        <th className="border border-slate-500 bg-slate-300 p-2 text-end font-bold text-slate-950">{t('orders.form.table.qty') || 'Qty'}</th>
                        {showFreeBonus ? <th className="border border-slate-500 bg-slate-300 p-2 text-end font-bold text-slate-950">{t('orders.details.freeBonus', { defaultValue: 'Free Bonus' })}</th> : null}
                        <th className="border border-slate-500 bg-slate-300 p-2 text-end font-bold text-slate-950">{t('orders.form.table.price') || 'Unit Price'}</th>
                        <th className="border border-slate-500 bg-slate-300 p-2 text-end font-bold text-slate-950">{t('common.total') || 'Total'}</th>
                    </tr>
                </thead>
                <tbody>
                    {populatedItemRows.length === 0 && orderAdjustments.length === 0 ? (
                        <tr>
                            <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={showFreeBonus ? 6 : 5}>
                                {t('common.noData') || 'No data'}
                            </td>
                        </tr>
                    ) : <>
                    {populatedItemRows.map((item, index) => {
                        const unit = item ? formatOrderLineUnit(t, item, productUnits) : ''
                        const freeBonusUnit = item ? formatOrderLineFreeBonusUnit(t, item, productUnits) : ''
                        const baseEquivalent = item ? formatOrderLineBaseEquivalent(t, item) : ''
                        const returnState = item && isSales && !isOriginalPrint ? getOrderPrintReturnState(item) : null
                        return (
                            <tr
                                key={item?.id || `empty-${index}`}
                                className="h-9"
                                style={returnState ? getA4OrderPrintReturnRowStyle(returnState.status) : undefined}
                                data-order-print-return-state={returnState?.status}
                            >
                                <td className="border border-slate-300 p-2 font-medium">{item?.productName || '\u00A0'}</td>
                                <td className="border border-slate-300 p-2 text-slate-600">
                                    {item?.productSku ? <span className="text-black" style={labelOpacityStyle}>{item.productSku}</span> : '\u00A0'}
                                </td>
                                <td className="border border-slate-300 p-2 text-end">
                                    <div>{item && returnState
                                        ? <OrderPrintReturnValue
                                            state={returnState}
                                            original={`${getOrderLinePaidQuantity(item)}${!hideUnit && unit ? ` ${unit}` : ''}`}
                                            remaining={`${returnState.remainingQuantity}${!hideUnit && unit ? ` ${unit}` : ''}`}
                                            stacked
                                            className="items-end"
                                        />
                                        : item ? `${getOrderLinePaidQuantity(item)}${!hideUnit && unit ? ` ${unit}` : ''}` : '\u00A0'}</div>
                                    {baseEquivalent ? <div className="text-[9px] text-slate-500">{baseEquivalent}</div> : null}
                                </td>
                                {showFreeBonus ? (
                                    <td className="border border-slate-300 p-2 text-end">
                                        {item ? `${getOrderLineFreeBonusQuantity(item)}${!hideUnit && freeBonusUnit ? ` ${freeBonusUnit}` : ''}` : '\u00A0'}
                                    </td>
                                ) : null}
                                <td className="border border-slate-300 p-2 text-end">{item ? formatCurrency(item.convertedUnitPrice, currency, iqdPreference) : '\u00A0'}</td>
                                <td className="border border-slate-300 p-2 text-end font-semibold">
                                    {item && returnState
                                        ? <OrderPrintReturnValue
                                            state={returnState}
                                            original={formatCurrency(returnState.originalLineTotal, currency, iqdPreference)}
                                            remaining={formatCurrency(returnState.remainingLineTotal, currency, iqdPreference)}
                                            stacked
                                            className="items-end"
                                        />
                                        : item ? formatCurrency(item.lineTotal, currency, iqdPreference) : '\u00A0'}
                                </td>
                            </tr>
                        )
                    })}
                    {orderAdjustments.map((adjustment) => (
                        <tr key={`order-adjustment-${adjustment.id}`} className="h-9" data-order-print-row-type="adjustment">
                            <td className="border border-slate-300 p-2 font-semibold">
                                {getOrderAdjustmentRowLabel(t, adjustment)}
                            </td>
                            <td className="border border-slate-300 p-2 text-slate-600">
                                {adjustment.type === 'addition'
                                    ? t('orders.adjustments.addition', { defaultValue: 'Addition (+)' })
                                    : t('orders.adjustments.deduction', { defaultValue: 'Deduction (−)' })}
                            </td>
                            <td className="border border-slate-300 p-2 text-end">—</td>
                            {showFreeBonus ? <td className="border border-slate-300 p-2 text-end">—</td> : null}
                            <td className="border border-slate-300 p-2 text-end">—</td>
                            <td className="border border-slate-300 p-2 text-end font-semibold">
                                {formatSignedOrderAdjustment(adjustment, currency, iqdPreference)}
                            </td>
                        </tr>
                    ))}
                    {Array.from({ length: emptyItemRowCount }, (_, index) => (
                        <tr key={`empty-${index}`} className="h-9">
                            <td className="border border-slate-300 p-2">{'\u00A0'}</td>
                            <td className="border border-slate-300 p-2">{'\u00A0'}</td>
                            <td className="border border-slate-300 p-2">{'\u00A0'}</td>
                            {showFreeBonus ? <td className="border border-slate-300 p-2">{'\u00A0'}</td> : null}
                            <td className="border border-slate-300 p-2">{'\u00A0'}</td>
                            <td className="border border-slate-300 p-2">{'\u00A0'}</td>
                        </tr>
                    ))}
                    </>}
                </tbody>
            </table>
            </MovableOrderPrintBlock>

            <MovableOrderPrintBlock
                componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.totals}
                label={t('common.total') || 'Totals'}
                position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.totals]}
                editable={editableComponents}
                onPositionChange={onComponentPositionChange}
                wrapperClassName="ms-auto mb-5 w-60"
                previewPageBreakMode="transform"
            >
            <div className="text-xs space-y-1">
                    <div className="flex justify-between">
                        <span className="text-black" style={labelOpacityStyle}>{t('orders.details.subtotal') || 'Subtotal'}</span>
                        <span className="font-semibold">{formatCurrency(order.subtotal, currency, iqdPreference)}</span>
                    </div>
                    {!hideDiscount && (
                        <div className="flex justify-between">
                            <span className="text-black" style={labelOpacityStyle}>{t('orders.details.discount') || 'Discount'}</span>
                            <span className="font-semibold">{formatCurrency(order.discount, currency, iqdPreference)}</span>
                        </div>
                    )}
                    {isSales && salesOrder ? (
                        <div className="flex justify-between">
                            <span className="text-black" style={labelOpacityStyle}>{t('orders.details.tax') || 'Tax'}</span>
                            <span className="font-semibold">{formatCurrency(salesOrder.tax, currency, iqdPreference)}</span>
                        </div>
                    ) : null}
                    <div className="flex justify-between border-t border-slate-300 pt-1 mt-1">
                        <span className="font-bold">{t('common.total') || 'Total'}</span>
                        <span className="font-bold">{formatCurrency(displayedTotal, currency, iqdPreference)}</span>
                    </div>
            </div>
            </MovableOrderPrintBlock>

            {installments.length > 0 ? (
                <>
                    <h3 className="font-semibold mb-2 text-sm">
                        {t('orders.details.installmentSchedule', { defaultValue: 'Installment Schedule' })}
                    </h3>
                    <table className="w-full border-collapse text-xs mb-5">
                        <thead>
                            <tr className="bg-slate-100">
                                <th className="border border-slate-300 p-2 text-start">
                                    {t('orders.details.installmentNumber', { defaultValue: 'Installment' })}
                                </th>
                                <th className="border border-slate-300 p-2 text-start">
                                    {t('orders.details.dueDate', { defaultValue: 'Due Date' })}
                                </th>
                                <th className="border border-slate-300 p-2 text-end">
                                    {t('orders.details.plannedAmount', { defaultValue: 'Planned' })}
                                </th>
                                <th className="border border-slate-300 p-2 text-end">
                                    {t('orders.details.paidAmount', { defaultValue: 'Paid' })}
                                </th>
                                <th className="border border-slate-300 p-2 text-end">
                                    {t('orders.details.outstanding', { defaultValue: 'Outstanding' })}
                                </th>
                                <th className="border border-slate-300 p-2 text-start">
                                    {t('common.status', { defaultValue: 'Status' })}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {installments.map((installment) => (
                                <tr key={installment.id}>
                                    <td className="border border-slate-300 p-2 font-medium">#{installment.installmentNo}</td>
                                    <td className="border border-slate-300 p-2">{formatDate(installment.dueDate)}</td>
                                    <td className="border border-slate-300 p-2 text-end">
                                        {formatCurrency(installment.plannedAmount, currency, iqdPreference)}
                                    </td>
                                    <td className="border border-slate-300 p-2 text-end">
                                        {formatCurrency(installment.paidAmount, currency, iqdPreference)}
                                    </td>
                                    <td className="border border-slate-300 p-2 text-end font-semibold">
                                        {formatCurrency(installment.balanceAmount, currency, iqdPreference)}
                                    </td>
                                    <td className="border border-slate-300 p-2">
                                        {installment.status === 'paid' 
                                            ? t('budget.status.paid', { defaultValue: 'Paid' })
                                            : installment.status === 'unpaid'
                                                ? t('budget.status.pending', { defaultValue: 'Unpaid' })
                                                : t(`orders.Status.${installment.status}`, { defaultValue: installment.status })}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            ) : null}

            <MovableOrderPrintBlock
                componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.notes}
                label={t('orders.details.notes') || 'Notes'}
                position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.notes]}
                editable={editableComponents}
                onPositionChange={onComponentPositionChange}
            >
                {noteValue ? (
                    <div className="mt-6 text-xs">
                        <div className="font-semibold text-slate-600">{t('orders.details.notes') || 'Notes'}:</div>
                        <div className="mt-2 whitespace-pre-wrap break-words text-[11px] text-slate-800">
                            {noteValue}
                        </div>
                    </div>
                ) : null}
            </MovableOrderPrintBlock>

            <MovableOrderPrintBlock
                componentKey={ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.contacts}
                label={t('orders.print.contacts', { defaultValue: 'Contacts' })}
                position={componentPositions?.[ORDER_DETAILS_MOVABLE_COMPONENT_KEYS.contacts]}
                editable={editableComponents}
                onPositionChange={onComponentPositionChange}
            >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                    {[
                        {
                            key: 'address',
                            primary: workspaceFooterContacts?.address?.primary?.trim() || '',
                            nonPrimary: workspaceFooterContacts?.address?.nonPrimary?.trim() || '',
                            icon: MapPin,
                        },
                        {
                            key: 'phone',
                            primary: workspaceFooterContacts?.phone?.primary?.trim() || '',
                            nonPrimary: workspaceFooterContacts?.phone?.nonPrimary?.trim() || '',
                            icon: Phone,
                        },
                    ].map((group) => {
                        const entries: Array<{ value: string }> = []
                        if (group.primary) entries.push({ value: group.primary })
                        if (group.nonPrimary) entries.push({ value: group.nonPrimary })
                        return { ...group, entries }
                    }).filter((group) => group.entries.length > 0)
                    .map((group, groupIndex, arr) => (
                        <div key={group.key} className="inline-flex items-center gap-1">
                            <group.icon className="w-3.5 h-3.5 shrink-0" />
                            {group.entries.map((entry, entryIndex) => (
                                <span key={entryIndex}>
                                    {entryIndex > 0 && <span className="mx-0.5 select-none">●</span>}
                                    <span>{entry.value}</span>
                                </span>
                            ))}
                            {groupIndex < arr.length - 1 && (
                                <span className="mx-1 text-slate-300 select-none">│</span>
                            )}
                        </div>
                    ))}
                </div>
            </MovableOrderPrintBlock>
        </div>
    )
}
