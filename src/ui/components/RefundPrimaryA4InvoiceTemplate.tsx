import { forwardRef } from 'react'
import { UniversalInvoice, UniversalInvoiceItem } from '@/types'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import { localizeReturnReason } from '@/lib/returnReasons'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'

interface RefundPrimaryA4InvoiceTemplateProps {
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

export const RefundPrimaryA4InvoiceTemplate = forwardRef<HTMLDivElement, RefundPrimaryA4InvoiceTemplateProps>(
    ({ data, features, workspaceId: propWorkspaceId, workspaceName }, ref) => {
        const { i18n } = useTranslation()
        const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
        const t = i18n.getFixedT(printLang)
        const tWithFallback = (key: string, fallback: string) => (
            i18n.exists(key, { lng: printLang }) ? t(key) : fallback
        )
        const isRTL = printLang === 'ar' || printLang === 'ku'
        const rows = (data.items || []).map(resolveRow)
        const settlementCurrency = data.settlement_currency || 'usd'
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
        const watermarkText = isFullyReturned
            ? tWithFallback('invoice.refund.watermark', tWithFallback('invoice.refund.status.full', 'RETURNED'))
            : tWithFallback('invoice.refund.watermarkPartial', tWithFallback('invoice.refund.status.partial', 'PARTIALLY RETURNED'))
        const watermarkColor = isFullyReturned ? 'rgba(92, 106, 196, 0.12)' : 'rgba(217, 119, 6, 0.14)'
        const watermarkLetterSpacing = isRTL ? '0' : '0.2em'

        const BRAND_COLOR = '#5c6ac4'

        return (
            <div
                ref={ref}
                dir={isRTL ? 'rtl' : 'ltr'}
                className="bg-white text-black text-sm relative flex flex-col min-h-[297mm] text-start"
                style={{ width: '210mm', padding: '0', margin: '0 auto' }}
            >
                <style dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; margin: 0; padding: 0; }
}
.text-main { color: ${BRAND_COLOR}; }
.bg-main { background-color: ${BRAND_COLOR}; }
.border-main { border-color: ${BRAND_COLOR}; }
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

                <div className="relative z-[1] px-14 py-6">
                    <div className="flex justify-between items-start">
                        <div className="w-1/3 flex flex-col gap-1">
                            <div className="flex items-start w-full max-w-[200px] mb-1">
                                {features.logo_url ? (
                                    <img
                                        src={features.logo_url.startsWith('http') ? features.logo_url : platformService.convertFileSrc(features.logo_url)}
                                        alt="Workspace Logo"
                                        className="max-h-16 max-w-full object-contain object-left"
                                    />
                                ) : (
                                    <div className="h-12 flex items-center bg-gray-100 border border-gray-200 justify-center w-48 text-gray-400 font-bold tracking-wider uppercase">
                                        LOGO
                                    </div>
                                )}
                            </div>
                            {workspaceName && (
                                <h1 className="text-main font-bold text-xl leading-tight">
                                    {workspaceName}
                                </h1>
                            )}
                            <p className="text-main font-black text-sm">{t('invoice.refund.title') || 'Refund Invoice'}</p>
                        </div>

                        <div className="w-1/3 flex justify-center pt-2">
                            {features.print_qr && effectiveWorkspaceId && (data.sequenceId || data.invoiceid) && (
                                <div className="p-1.5 bg-white border border-slate-100 rounded" data-qr-sharp="true">
                                    <ReactQRCode
                                        value={`https://asaas-r2-proxy.alanepic360.workers.dev/${effectiveWorkspaceId}/printed-invoices/A4/${data.id}.pdf`}
                                        size={64}
                                        level="M"
                                    />
                                </div>
                            )}
                        </div>

                        <div className={cn("w-1/3 flex flex-col items-end space-y-2", isRTL ? "text-left" : "text-right")}>
                            <div className="flex flex-col gap-1 border-r-4 border-main pr-4">
                                <div>
                                    <p className={cn("whitespace-nowrap text-slate-400 text-xs font-semibold leading-tight", !isRTL && "uppercase")}>{t('invoice.date')}</p>
                                    <p className="whitespace-nowrap font-bold text-main text-sm leading-tight">{formatDateTime(data.created_at)}</p>
                                </div>
                                <div className="mt-1">
                                    <p className={cn("whitespace-nowrap text-slate-400 text-xs font-semibold leading-tight", !isRTL && "uppercase")}>{t('invoice.number')}</p>
                                    <p className="whitespace-nowrap font-bold text-main text-lg leading-tight">
                                        {data.invoiceid || `#${String(data.id).slice(0, 8)}`}
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="relative z-[1] bg-slate-100 px-14 py-4 text-xs">
                    <div className="flex items-center justify-between gap-4">
                        <span className={cn(
                            'inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-bold',
                            isFullyReturned ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'
                        )}>
                            {isFullyReturned
                                ? (t('invoice.refund.status.full') || 'Fully Returned')
                                : (t('invoice.refund.status.partial') || 'Partially Returned')}
                        </span>
                        <span className="text-slate-600">
                            <span className="font-bold">{t('invoice.refund.returnedAt') || 'Returned At'}:</span>{' '}
                            {returnedAt ? formatDateTime(returnedAt) : notProvidedText}
                        </span>
                    </div>
                    <div className="mt-2 text-slate-700">
                        <span className="font-bold">{t('invoice.refund.reason') || 'Refund Reason'}:</span> {returnReason}
                    </div>
                </div>

                <div className="relative z-[1] px-14 py-8 flex-grow">
                    <table className="w-full border-collapse">
                        <thead>
                            <tr>
                                <th className="border-b-2 border-main pb-2 px-2 text-start font-bold text-main">{t('invoice.refund.table.product') || 'Product'}</th>
                                <th className="border-b-2 border-main pb-2 px-2 text-center font-bold text-main w-[70px]">{t('invoice.refund.table.qtySold') || 'Qty Sold'}</th>
                                <th className="border-b-2 border-main pb-2 px-2 text-center font-bold text-main w-[70px]">{t('invoice.refund.table.refundedQty') || 'Refunded Qty'}</th>
                                <th className="border-b-2 border-main pb-2 px-2 text-center font-bold text-main w-[70px]">{t('invoice.refund.table.activeQty') || 'Active Qty'}</th>
                                <th className="border-b-2 border-main pb-2 px-2 text-end font-bold text-main w-[100px]">{t('invoice.refund.table.unitPrice') || 'Unit Price'}</th>
                                <th className="border-b-2 border-main pb-2 px-2 text-end font-bold text-main w-[110px]">{t('invoice.refund.table.refundedAmount') || 'Refunded Amount'}</th>
                                <th className="border-b-2 border-main pb-2 px-2 text-end font-bold text-main w-[110px]">{t('invoice.refund.table.activeAmount') || 'Active Amount'}</th>
                                <th className="border-b-2 border-main pb-2 px-2 text-center font-bold text-main w-[95px]">{t('invoice.refund.table.status') || 'Status'}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, idx) => (
                                <tr key={`${row.item.product_id || row.item.product_name}-${idx}`} className="text-neutral-700">
                                    <td className="border-b py-2 px-2 font-bold text-start">{row.item.product_name}</td>
                                    <td className="border-b py-2 px-2 text-center font-bold">{row.originalQuantity}</td>
                                    <td className="border-b py-2 px-2 text-center font-bold text-red-700">{row.refundedQuantity}</td>
                                    <td className="border-b py-2 px-2 text-center font-bold text-emerald-700">{row.activeQuantity}</td>
                                    <td className="border-b py-2 px-2 text-end">{formatCurrency(row.unitPrice, settlementCurrency, features.iqd_display_preference)}</td>
                                    <td className="border-b py-2 px-2 text-end font-semibold text-red-700">{formatCurrency(row.refundedAmount, settlementCurrency, features.iqd_display_preference)}</td>
                                    <td className="border-b py-2 px-2 text-end font-semibold text-emerald-700">{formatCurrency(row.activeAmount, settlementCurrency, features.iqd_display_preference)}</td>
                                    <td className="border-b py-2 px-2 text-center">
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

                <div className="relative z-[1] px-14 pb-12 mt-auto">
                    <div className="w-[360px] ml-auto">
                        <table className="w-full border-collapse border-spacing-0">
                            <tbody>
                                <tr>
                                    <td className="border-b p-3 text-start">
                                        <div className="whitespace-nowrap text-slate-400 text-sm">{t('invoice.refund.totals.original') || 'Original Total'}:</div>
                                    </td>
                                    <td className="border-b p-3 text-end">
                                        <div className="whitespace-nowrap font-bold text-main text-lg">
                                            {formatCurrency(originalTotal, settlementCurrency, features.iqd_display_preference)}
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td className="border-b p-3 text-start">
                                        <div className="whitespace-nowrap text-red-600 text-sm">{t('invoice.refund.totals.refunded') || 'Refunded Total'}:</div>
                                    </td>
                                    <td className="border-b p-3 text-end">
                                        <div className="whitespace-nowrap font-bold text-red-700 text-lg">
                                            {formatCurrency(refundedTotal, settlementCurrency, features.iqd_display_preference)}
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td className="bg-main p-3 text-start">
                                        <div className={cn("whitespace-nowrap font-black text-white text-lg", !isRTL && "tracking-tighter uppercase")}>{t('invoice.refund.totals.remaining') || 'Remaining Total'}:</div>
                                    </td>
                                    <td className="bg-main p-3 text-end">
                                        <div className="whitespace-nowrap font-bold text-white text-xl">
                                            {formatCurrency(activeTotal, settlementCurrency, features.iqd_display_preference)}
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div className="mt-8 border-t border-gray-200 pt-3 text-center text-xs text-neutral-500">
                        {data.origin === 'pos' ? (t('invoice.posSystem') || 'Issued via Atlas ERP System') : 'Atlas'}
                        <span className="text-slate-300 px-2">|</span>
                        {t('invoice.generated') || 'Generated Automatically'}
                    </div>
                </div>
            </div>
        )
    }
)

RefundPrimaryA4InvoiceTemplate.displayName = 'RefundPrimaryA4InvoiceTemplate'
