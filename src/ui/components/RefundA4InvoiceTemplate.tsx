import { forwardRef } from 'react'
import { UniversalInvoice, UniversalInvoiceItem } from '@/types'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import { localizeReturnReason } from '@/lib/returnReasons'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'

interface RefundA4InvoiceTemplateProps {
    data: UniversalInvoice
    features: any
    workspaceId?: string
    workspaceName?: string
}

type RefundRow = {
    item: UniversalInvoiceItem
    originalQuantity: number
    refundedQuantity: number
    activeQuantity: number
    unitPrice: number
    refundedAmount: number
    activeAmount: number
    status: 'fully_refunded' | 'partially_refunded' | 'not_refunded'
}

function toSafeNumber(value: unknown): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}

function resolveRow(item: UniversalInvoiceItem): RefundRow {
    const originalQuantity = Math.max(0, toSafeNumber(item.original_quantity ?? item.quantity))
    const fallbackRefundedQty = item.refund_status === 'fully_refunded' ? originalQuantity : 0
    const refundedQuantity = Math.max(0, Math.min(originalQuantity, toSafeNumber(item.refunded_quantity ?? fallbackRefundedQty)))
    const activeQuantity = Math.max(0, toSafeNumber(item.active_quantity ?? (originalQuantity - refundedQuantity)))
    const unitPrice = toSafeNumber(item.unit_price)
    const refundedAmount = Math.max(0, toSafeNumber(item.refunded_amount ?? (unitPrice * refundedQuantity)))
    const activeAmount = Math.max(0, toSafeNumber(item.active_amount ?? (unitPrice * activeQuantity)))

    const status = item.refund_status
        || (refundedQuantity <= 0
            ? 'not_refunded'
            : activeQuantity <= 0
                ? 'fully_refunded'
                : 'partially_refunded')

    return {
        item,
        originalQuantity,
        refundedQuantity,
        activeQuantity,
        unitPrice,
        refundedAmount,
        activeAmount,
        status
    }
}

export const RefundA4InvoiceTemplate = forwardRef<HTMLDivElement, RefundA4InvoiceTemplateProps>(
    ({ data, features, workspaceId: propWorkspaceId, workspaceName }, ref) => {
        const { i18n } = useTranslation()
        const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
        const t = i18n.getFixedT(printLang)
        const tWithFallback = (key: string, fallback: string) => (
            i18n.exists(key, { lng: printLang }) ? t(key) : fallback
        )
        const isRTL = printLang === 'ar' || printLang === 'ku'
        const rows = (data.items || []).map(resolveRow)
        const settlementCurrency = (data.settlement_currency || 'usd').toLowerCase()
        const iqdPreference = features?.iqd_display_preference
        const effectiveWorkspaceId = propWorkspaceId || data.workspaceId

        const fallbackOriginalTotal = rows.reduce((sum, row) => sum + (row.unitPrice * row.originalQuantity), 0)
        const fallbackRefundedTotal = rows.reduce((sum, row) => sum + row.refundedAmount, 0)
        const fallbackActiveTotal = rows.reduce((sum, row) => sum + row.activeAmount, 0)

        const summary = data.refund_summary
        const originalTotal = toSafeNumber(summary?.original_total ?? fallbackOriginalTotal)
        const refundedTotal = toSafeNumber(summary?.refunded_total ?? fallbackRefundedTotal)
        const activeTotal = toSafeNumber(summary?.active_total ?? fallbackActiveTotal)
        const isFullyReturned = summary?.is_fully_returned ?? rows.every(row => row.status === 'fully_refunded')
        const notProvidedText = tWithFallback('invoice.refund.notProvided', 'Not provided')
        const returnReason = localizeReturnReason(summary?.refund_reason, i18n, printLang, notProvidedText)
        const returnedAt = summary?.returned_at

        const statusText = isFullyReturned
            ? tWithFallback('invoice.refund.status.full', 'Fully Returned')
            : tWithFallback('invoice.refund.status.partial', 'Partially Returned')
        const watermarkText = isFullyReturned
            ? tWithFallback('invoice.refund.watermark', tWithFallback('invoice.refund.status.full', 'RETURNED'))
            : tWithFallback('invoice.refund.watermarkPartial', tWithFallback('invoice.refund.status.partial', 'PARTIALLY RETURNED'))
        const watermarkColor = isFullyReturned ? 'rgba(185, 28, 28, 0.11)' : 'rgba(217, 119, 6, 0.14)'
        const watermarkLetterSpacing = isRTL ? '0' : '0.2em'

        const statusClass = isFullyReturned
            ? 'bg-red-50 text-red-700 border-red-200'
            : 'bg-amber-50 text-amber-700 border-amber-200'

        return (
            <div
                ref={ref}
                dir={isRTL ? 'rtl' : 'ltr'}
                className="bg-white text-black relative flex flex-col min-h-[297mm] text-start"
                style={{ width: '210mm', padding: '0', margin: '0 auto' }}
            >
                <style dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; margin: 0; padding: 0; }
}
`}} />

                <div dir="ltr" className="absolute inset-0 pointer-events-none select-none flex items-center justify-center">
                    <span
                        className="font-black"
                        style={{
                            fontSize: '110px',
                            transform: 'rotate(-28deg)',
                            color: watermarkColor,
                            letterSpacing: watermarkLetterSpacing,
                            direction: 'ltr',
                            unicodeBidi: 'isolate'
                        }}
                    >
                        {watermarkText}
                    </span>
                </div>

                <div className="relative z-[1] px-10 pt-8 pb-6 border-b border-slate-200">
                    <div className="flex items-start justify-between gap-6">
                        <div className="flex items-start gap-4">
                            <div className="w-20 h-20 border border-slate-200 rounded-lg bg-white overflow-hidden flex items-center justify-center">
                                {features?.logo_url ? (
                                    <img
                                        src={features.logo_url.startsWith('http') ? features.logo_url : platformService.convertFileSrc(features.logo_url)}
                                        alt="Workspace Logo"
                                        className="max-w-full max-h-full object-contain"
                                    />
                                ) : (
                                    <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Logo</span>
                                )}
                            </div>
                            <div className="pt-1">
                                <h1 className="text-2xl font-black text-slate-900">{workspaceName || 'Atlas'}</h1>
                                <p className="text-sm font-bold text-red-700 mt-1">{t('invoice.refund.title') || 'Refund Invoice'}</p>
                                <p className="text-xs text-slate-500">{t('invoice.refund.subtitle') || 'Return and refund details'}</p>
                            </div>
                        </div>

                        <div className={cn('flex flex-col gap-2 text-sm', isRTL ? 'text-left' : 'text-right')}>
                            <div>
                                <p className="text-[11px] text-slate-500 uppercase">{t('invoice.number') || 'Invoice #'}</p>
                                <p className="font-bold text-slate-900">{data.invoiceid || `#${String(data.id).slice(0, 8)}`}</p>
                            </div>
                            <div>
                                <p className="text-[11px] text-slate-500 uppercase">{t('invoice.date') || 'Date'}</p>
                                <p className="font-semibold text-slate-800">{formatDateTime(data.created_at)}</p>
                            </div>
                            <div>
                                <p className="text-[11px] text-slate-500 uppercase">{t('invoice.soldBy') || 'Sold By'}</p>
                                <p className="font-semibold text-slate-800">{data.cashier_name || 'Staff'}</p>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-3 mt-5">
                        <div className={cn('inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-bold', statusClass)}>
                            {statusText}
                        </div>
                        {features?.print_qr && effectiveWorkspaceId && (
                            <div className="p-1.5 bg-white border border-slate-200 rounded" data-qr-sharp="true">
                                <ReactQRCode
                                    value={`https://asaas-r2-proxy.alanepic360.workers.dev/${effectiveWorkspaceId}/printed-invoices/A4/${data.id}.pdf`}
                                    size={56}
                                    level="M"
                                />
                            </div>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-4 mt-4 text-xs">
                        <div className="bg-slate-50 border border-slate-200 rounded p-3">
                            <p className="font-bold text-slate-700 mb-1">{t('invoice.refund.reason') || 'Refund Reason'}</p>
                            <p className="text-slate-600 break-words">{returnReason}</p>
                        </div>
                        <div className="bg-slate-50 border border-slate-200 rounded p-3">
                            <p className="font-bold text-slate-700 mb-1">{t('invoice.refund.returnedAt') || 'Returned At'}</p>
                            <p className="text-slate-600">{returnedAt ? formatDateTime(returnedAt) : notProvidedText}</p>
                        </div>
                    </div>
                </div>

                <div className="relative z-[1] px-10 py-6 flex-grow">
                    <table className="w-full border-collapse text-xs">
                        <thead>
                            <tr className="bg-slate-50 text-slate-700">
                                <th className="border border-slate-200 px-2 py-2 text-start">{t('invoice.refund.table.product') || 'Product'}</th>
                                <th className="border border-slate-200 px-2 py-2 text-center">{t('invoice.refund.table.qtySold') || 'Qty Sold'}</th>
                                <th className="border border-slate-200 px-2 py-2 text-center">{t('invoice.refund.table.refundedQty') || 'Refunded Qty'}</th>
                                <th className="border border-slate-200 px-2 py-2 text-center">{t('invoice.refund.table.activeQty') || 'Active Qty'}</th>
                                <th className="border border-slate-200 px-2 py-2 text-end">{t('invoice.refund.table.unitPrice') || 'Unit Price'}</th>
                                <th className="border border-slate-200 px-2 py-2 text-end">{t('invoice.refund.table.refundedAmount') || 'Refunded Amount'}</th>
                                <th className="border border-slate-200 px-2 py-2 text-end">{t('invoice.refund.table.activeAmount') || 'Active Amount'}</th>
                                <th className="border border-slate-200 px-2 py-2 text-center">{t('invoice.refund.table.status') || 'Status'}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, index) => (
                                <tr key={`${row.item.product_id || row.item.product_name}-${index}`}>
                                    <td className="border border-slate-200 px-2 py-2">
                                        <p className="font-semibold text-slate-800">{row.item.product_name}</p>
                                        {row.item.product_sku && <p className="text-[10px] text-slate-500">{row.item.product_sku}</p>}
                                    </td>
                                    <td className="border border-slate-200 px-2 py-2 text-center font-semibold">{row.originalQuantity}</td>
                                    <td className="border border-slate-200 px-2 py-2 text-center text-red-700 font-semibold">{row.refundedQuantity}</td>
                                    <td className="border border-slate-200 px-2 py-2 text-center text-emerald-700 font-semibold">{row.activeQuantity}</td>
                                    <td className="border border-slate-200 px-2 py-2 text-end">{formatCurrency(row.unitPrice, settlementCurrency, iqdPreference)}</td>
                                    <td className="border border-slate-200 px-2 py-2 text-end text-red-700">{formatCurrency(row.refundedAmount, settlementCurrency, iqdPreference)}</td>
                                    <td className="border border-slate-200 px-2 py-2 text-end text-emerald-700">{formatCurrency(row.activeAmount, settlementCurrency, iqdPreference)}</td>
                                    <td className="border border-slate-200 px-2 py-2 text-center">
                                        <span className={cn(
                                            'inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold border',
                                            row.status === 'fully_refunded'
                                                ? 'bg-red-50 border-red-200 text-red-700'
                                                : row.status === 'partially_refunded'
                                                    ? 'bg-amber-50 border-amber-200 text-amber-700'
                                                    : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                        )}>
                                            {row.status === 'fully_refunded'
                                                ? (t('invoice.refund.table.statusFully') || 'Fully Refunded')
                                                : row.status === 'partially_refunded'
                                                    ? (t('invoice.refund.table.statusPartial') || 'Partially Refunded')
                                                    : (t('invoice.refund.table.statusNone') || 'Not Refunded')}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div className="relative z-[1] px-10 pb-10 pt-2 border-t border-slate-200">
                    <div className="ml-auto w-[360px] bg-slate-50 border border-slate-200 rounded-lg p-4 text-sm">
                        <div className="flex justify-between items-center mb-2">
                            <span className="text-slate-600">{t('invoice.refund.totals.original') || 'Original Total'}</span>
                            <span className="font-bold text-slate-900">{formatCurrency(originalTotal, settlementCurrency, iqdPreference)}</span>
                        </div>
                        <div className="flex justify-between items-center mb-2">
                            <span className="text-slate-600">{t('invoice.refund.totals.refunded') || 'Refunded Total'}</span>
                            <span className="font-bold text-red-700">{formatCurrency(refundedTotal, settlementCurrency, iqdPreference)}</span>
                        </div>
                        <div className="flex justify-between items-center pt-2 border-t border-slate-200">
                            <span className="font-bold text-slate-700">{t('invoice.refund.totals.remaining') || 'Remaining Total'}</span>
                            <span className="text-lg font-black text-emerald-700">{formatCurrency(activeTotal, settlementCurrency, iqdPreference)}</span>
                        </div>
                    </div>

                    <div className="mt-6 text-center text-[10px] text-slate-500">
                        {data.origin === 'pos' ? (t('invoice.posSystem') || 'Issued via Atlas ERP System') : 'Atlas'}
                        <span className="px-2 text-slate-300">|</span>
                        {t('invoice.generated') || 'Generated Automatically'}
                    </div>
                </div>
            </div>
        )
    }
)

RefundA4InvoiceTemplate.displayName = 'RefundA4InvoiceTemplate'
