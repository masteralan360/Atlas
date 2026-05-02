import type { SalesOrder, PurchaseOrder, IQDDisplayPreference } from '@/local-db'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'

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

interface OrderDetailsPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    order: SalesOrder | PurchaseOrder
    kind: 'sales' | 'purchase'
    iqdPreference?: IQDDisplayPreference
    logoUrl?: string | null
    qrValue?: string | null
}

function isRTL(lang: string): boolean {
    const baseLang = (lang || 'en').split('-')[0]
    return baseLang === 'ar' || baseLang === 'ku'
}

function resolveLogoSrc(logoUrl?: string | null) {
    if (!logoUrl) return null
    return logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl)
}

interface OrderPrintHeaderProps {
    workspaceName?: string | null
    title: string
    subtitle?: React.ReactNode
    logoUrl?: string | null
    qrValue?: string | null
}

function OrderPrintHeader({
    workspaceName,
    title,
    subtitle,
    logoUrl,
    qrValue
}: OrderPrintHeaderProps) {
    const logoSrc = resolveLogoSrc(logoUrl)

    return (
        <div className="border-b border-slate-300 pb-3 mb-4">
            <div className="flex items-start justify-between gap-3">
                <div className="w-1/3 flex flex-col items-start">
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
                </div>

                <div className="w-1/3 flex justify-center pt-1">
                    {qrValue ? (
                        <div className="p-1.5 bg-white border border-slate-200 rounded" data-qr-sharp="true">
                            <ReactQRCode
                                value={qrValue}
                                size={64}
                                level="M"
                            />
                        </div>
                    ) : null}
                </div>

                <div className="w-1/3 flex flex-col items-center text-center">
                    <h1 className="text-xl font-bold">{workspaceName || 'Atlas'}</h1>
                    <p className="text-sm font-semibold">{title}</p>
                    {subtitle ? (
                        <p className="text-[11px] text-slate-600">{subtitle}</p>
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
        default: return 'Credit'
    }
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

            <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
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
                                    <span className={order.isPaid ? 'font-semibold' : ''}>
                                        {order.isPaid ? (t('budget.status.paid') || 'Paid') : (t('budget.status.pending') || 'Pending')}
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
                                    <span className={order.isPaid ? 'font-semibold' : ''}>
                                        {order.isPaid ? (t('budget.status.paid') || 'Paid') : (t('budget.status.pending') || 'Pending')}
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

export function OrderDetailsPrintTemplate({
    workspaceName,
    printLang,
    order,
    kind,
    iqdPreference = 'IQD',
    logoUrl,
    qrValue
}: OrderDetailsPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const isSales = kind === 'sales'
    const salesOrder = isSales ? (order as SalesOrder) : null
    const purchaseOrder = !isSales ? (order as PurchaseOrder) : null
    const currency = order.currency
    const noteValue = order.notes?.trim()

    const counterpartyLabel = isSales
        ? (t('orders.details.customer') || 'Customer')
        : (t('orders.details.supplier') || 'Supplier')
    const counterpartyName = isSales
        ? salesOrder!.customerName
        : purchaseOrder!.supplierName
    const title = isSales
        ? (t('orders.details.salesOrder') || 'Sales Order')
        : (t('orders.details.purchaseOrder') || 'Purchase Order')

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
                subtitle={
                    <span className="flex items-center justify-center gap-1">
                        <span className="font-semibold">{order.orderNumber}</span>
                        <span>•</span>
                        <span>{formatDateTime(new Date().toISOString())}</span>
                    </span>
                }
                logoUrl={logoUrl}
                qrValue={qrValue}
            />

            <div className="grid grid-cols-2 gap-4 mb-4 text-xs text-center">
                <div className="border border-slate-300 rounded-md p-3">
                    <h2 className="font-semibold mb-2">{counterpartyLabel}</h2>
                    <p className="font-bold text-sm">{counterpartyName}</p>
                    {isSales && salesOrder?.shippingAddress ? (
                        <p className="text-slate-600 mt-1">{salesOrder.shippingAddress}</p>
                    ) : null}
                </div>
                <div className="border border-slate-300 rounded-md p-3">
                    <h2 className="font-semibold mb-2">{t('orders.details.commercials') || 'Order Summary'}</h2>
                    <p>{t('orders.details.subtotal') || 'Subtotal'}: {formatCurrency(order.subtotal, currency, iqdPreference)}</p>
                    <p>{t('orders.details.discount') || 'Discount'}: {formatCurrency(order.discount, currency, iqdPreference)}</p>
                    {isSales && salesOrder ? (
                        <p>{t('orders.details.tax') || 'Tax'}: {formatCurrency(salesOrder.tax, currency, iqdPreference)}</p>
                    ) : null}
                    <p className="font-bold">{t('common.total') || 'Total'}: {formatCurrency(order.total, currency, iqdPreference)}</p>
                    <p>{t('common.status') || 'Status'}: {resolveStatusLabel(t, order.status)}</p>
                    <p>{t('pos.paymentMethod') || 'Payment'}: {resolvePaymentLabel(t, order.paymentMethod)}</p>
                    <p>{order.isPaid ? (t('budget.status.paid') || 'Paid') : (t('budget.status.pending') || 'Unpaid')}{order.paidAt ? ` • ${formatDate(order.paidAt)}` : ''}</p>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500 text-center">{t('orders.details.created') || 'Created'}</p>
                    <p className="font-bold text-center">{formatDateTime(order.createdAt)}</p>
                </div>
                <div className="border border-slate-300 rounded-md p-2">
                    <p className="text-slate-500 text-center">{t('orders.details.expectedDelivery') || 'Expected Delivery'}</p>
                    <p className="font-bold text-center">{order.expectedDeliveryDate ? formatDateTime(order.expectedDeliveryDate) : 'N/A'}</p>
                </div>
            </div>

            <h3 className="font-semibold mb-2 text-sm">{t('orders.details.orderItems') || 'Order Items'}</h3>
            <table className="w-full border-collapse text-xs mb-5">
                <thead>
                    <tr className="bg-slate-100">
                        <th className="border border-slate-300 p-2 text-start">{t('products.title') || 'Product'}</th>
                        <th className="border border-slate-300 p-2 text-start">SKU</th>
                        <th className="border border-slate-300 p-2 text-end">{t('orders.form.table.qty') || 'Qty'}</th>
                        <th className="border border-slate-300 p-2 text-end">{t('orders.form.table.price') || 'Unit Price'}</th>
                        <th className="border border-slate-300 p-2 text-end">{t('common.total') || 'Total'}</th>
                    </tr>
                </thead>
                <tbody>
                    {order.items.length === 0 ? (
                        <tr>
                            <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={5}>
                                {t('common.noData') || 'No data'}
                            </td>
                        </tr>
                    ) : order.items.map((item) => (
                        <tr key={item.id}>
                            <td className="border border-slate-300 p-2 font-medium">{item.productName}</td>
                            <td className="border border-slate-300 p-2 text-slate-600">{item.productSku || '-'}</td>
                            <td className="border border-slate-300 p-2 text-end">{item.quantity}</td>
                            <td className="border border-slate-300 p-2 text-end">{formatCurrency(item.convertedUnitPrice, currency, iqdPreference)}</td>
                            <td className="border border-slate-300 p-2 text-end font-semibold">{formatCurrency(item.lineTotal, currency, iqdPreference)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <div className="flex justify-end mb-5">
                <div className="w-60 text-xs space-y-1">
                    <div className="flex justify-between">
                        <span className="text-slate-600">{t('orders.details.subtotal') || 'Subtotal'}</span>
                        <span className="font-semibold">{formatCurrency(order.subtotal, currency, iqdPreference)}</span>
                    </div>
                    <div className="flex justify-between">
                        <span className="text-slate-600">{t('orders.details.discount') || 'Discount'}</span>
                        <span className="font-semibold">{formatCurrency(order.discount, currency, iqdPreference)}</span>
                    </div>
                    {isSales && salesOrder ? (
                        <div className="flex justify-between">
                            <span className="text-slate-600">{t('orders.details.tax') || 'Tax'}</span>
                            <span className="font-semibold">{formatCurrency(salesOrder.tax, currency, iqdPreference)}</span>
                        </div>
                    ) : null}
                    <div className="flex justify-between border-t border-slate-300 pt-1 mt-1">
                        <span className="font-bold">{t('common.total') || 'Total'}</span>
                        <span className="font-bold">{formatCurrency(order.total, currency, iqdPreference)}</span>
                    </div>
                </div>
            </div>

            {noteValue ? (
                <div className="mt-6 text-xs">
                    <div className="font-semibold text-slate-600">{t('orders.details.notes') || 'Notes'}:</div>
                    <div className="mt-2 whitespace-pre-wrap break-words text-[11px] text-slate-800">
                        {noteValue}
                    </div>
                </div>
            ) : null}
        </div>
    )
}
