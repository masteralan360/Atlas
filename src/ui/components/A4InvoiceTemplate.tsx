import { forwardRef } from 'react'
import { UniversalInvoice } from '@/types'
import { formatCurrency, formatDateTime, cn } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'

interface A4InvoiceTemplateProps {
    data: UniversalInvoice
    features: any
    workspaceId?: string
    workspaceName?: string
}

export const A4InvoiceTemplate = forwardRef<HTMLDivElement, A4InvoiceTemplateProps>(
    ({ data, features, workspaceId: propWorkspaceId, workspaceName }, ref) => {
        const { i18n } = useTranslation()
        const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
        const t = i18n.getFixedT(printLang)
        const isRTL = printLang === 'ar' || printLang === 'ku'
        const items = data.items || []
        const effectiveWorkspaceId = propWorkspaceId || data.workspaceId

        // Extract Multi-Currency Data for Footer
        const settlementCurrency = data.settlement_currency || 'usd'
        const uniqueOriginalCurrencies = Array.from(new Set(items.map(i => i.original_currency || 'usd')))
            .filter(c => c !== settlementCurrency)

        const currencyTotals: Record<string, number> = {}
        uniqueOriginalCurrencies.forEach(curr => {
            currencyTotals[curr] = items
                .filter(i => (i.original_currency || 'usd') === curr)
                .reduce((sum, i) => sum + ((i.original_unit_price || 0) * (i.quantity || 0)), 0)
        })

        // Brand Color from Template
        const BRAND_COLOR = '#5c6ac4'

        return (
            <div
                ref={ref}
                dir={isRTL ? 'rtl' : 'ltr'}
                className="bg-white text-black text-sm font-sans relative flex flex-col min-h-[297mm] text-start"
                style={{ width: '210mm', padding: '0', margin: '0 auto' }}
            >
                {/* Internal Styles for Print Exactness */}
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

                {/* TOP HEADER SECTION */}
                <div className="px-14 py-6">
                    <div className="flex justify-between items-start">
                        {/* Logo / Left */}
                        <div className="w-1/3 flex flex-col justify-start items-start gap-1">
                            {/* Logo container - max width constraint but allow height to fit */}
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

                            {/* Workspace Name in Purple */}
                            {workspaceName && (
                                <h1 className="text-main font-bold text-xl leading-tight">
                                    {workspaceName}
                                </h1>
                            )}
                        </div>

                        {/* QR Code / Center */}
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

                        {/* Invoice Details / Right */}
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

                {/* ADDRESS / INFO SECTION */}
                <div className="bg-slate-100 px-14 py-6 text-sm">
                    <table className="w-full border-collapse">
                        <tbody>
                            <tr>
                                <td className="w-1/2 align-top text-neutral-600 text-start">
                                    <p className="font-bold text-black mb-1">{t('invoice.soldTo')}</p>
                                    <p className="font-medium text-black">{data.customer_name}</p>
                                    <div className="h-6 w-full border-b border-gray-300 mb-1"></div>
                                    <div className="h-6 w-full border-b border-gray-300 mb-1"></div>
                                </td>
                                <td className={cn("w-1/2 align-top text-neutral-600", isRTL ? "text-left" : "text-right")}>
                                    <p className="font-bold text-black mb-1">{t('invoice.soldBy')} </p>
                                    <p className="font-mono font-bold text-main text-lg">{data.cashier_name?.slice(0, 8) || 'STAFF'}</p>
                                    <p className="text-xs mt-1">{t('invoice.shippedTo')} ________________</p>
                                    <p className="text-xs">{t('invoice.via')} ______________________</p>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                {/* MAIN PRODUCTS TABLE - Grows dynamically */}
                <div className="px-14 py-8 flex-grow" >
                    <table className="w-full border-collapse">
                        <thead>
                            <tr>
                                <th className="border-b-2 border-main pb-3 px-2 text-center font-bold text-main w-[60px]">{t('invoice.qty')}</th>
                                <th className="border-b-2 border-main pb-3 px-2 text-start font-bold text-main">{t('invoice.productName')}</th>
                                <th className="border-b-2 border-main pb-3 px-2 text-start font-bold text-main">{t('invoice.description')}</th>
                                <th className="border-b-2 border-main pb-3 px-2 text-end font-bold text-main w-[100px]">{t('invoice.price')}</th>
                                <th className="border-b-2 border-main pb-3 px-2 text-center font-bold text-main w-[80px]">{t('invoice.discount')}</th>
                                <th className="border-b-2 border-main pb-3 px-2 text-end font-bold text-main w-[110px]">{t('invoice.total')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {items.map((item, idx) => {
                                const finalUnitPrice = item.unit_price || 0
                                const total = item.total_price || (finalUnitPrice * item.quantity)
                                const discountAmount = item.discount_amount || 0
                                const priceToShow = finalUnitPrice + (discountAmount / item.quantity)

                                return (
                                    <tr key={idx} className="text-neutral-700">
                                        <td className="border-b py-2 px-2 text-center font-bold">{item.quantity}</td>
                                        <td className="border-b py-2 px-2 font-bold text-start">{item.product_name}</td>
                                        <td className="border-b py-2 px-2 text-sm text-neutral-500 truncate max-w-[200px] text-start"></td>
                                        <td className="border-b py-2 px-2 text-end">
                                            {formatCurrency(priceToShow, settlementCurrency, features.iqd_display_preference)}
                                        </td>
                                        <td className="border-b py-2 px-2 text-center text-neutral-400">
                                            {discountAmount > 0 ? formatCurrency(discountAmount, settlementCurrency, features.iqd_display_preference) : '-'}
                                        </td>
                                        <td className="border-b py-2 px-2 text-end font-bold text-black">
                                            {formatCurrency(total, settlementCurrency, features.iqd_display_preference)}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div >

                {/* FOOTER - Pushed to bottom or flows after content */}
                < div className="px-14 pb-12 mt-auto" >
                    <div className="flex gap-8 items-start page-break-inside-avoid">
                        {/* Left: Notes & Terms */}
                        <div className="flex-1 text-sm text-neutral-700 space-y-6 text-start">
                            <div>
                                <p className={cn("text-main font-bold text-xs mb-3", !isRTL && "uppercase")}>{t('invoice.terms')}</p>
                                <div className="border border-dashed border-gray-300 h-20 rounded">
                                </div>
                            </div>

                            {data.exchange_rates && data.exchange_rates.length > 0 && (
                                <div>
                                    <p className={cn("text-main font-bold text-xs mb-3", !isRTL && "uppercase")}>{t('invoice.exchangeRates')}</p>
                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                        {data.exchange_rates.slice(0, 4).map((rate: any, i: number) => (
                                            <div key={i} className="flex justify-between bg-white px-2 py-1 rounded-full border border-gray-100 shadow-sm">
                                                <span className="text-[10px] font-bold text-slate-400">{rate.pair}</span>
                                                <span className="font-mono font-black text-main">{rate.rate}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Right: Totals Table */}
                        <div className="w-[350px]">
                            <table className="w-full border-collapse border-spacing-0">
                                <tbody>
                                    <tr>
                                        <td className="border-b p-3 text-start">
                                            <div className="whitespace-nowrap text-slate-400 text-sm">{t('invoice.subtotal')}:</div>
                                        </td>
                                        <td className="border-b p-3 text-end">
                                            <div className="whitespace-nowrap font-bold text-main text-lg">
                                                {formatCurrency(data.subtotal_amount || data.total_amount, settlementCurrency, features.iqd_display_preference)}
                                            </div>
                                        </td>
                                    </tr>

                                    {Object.entries(currencyTotals).map(([code, amount], idx) => (
                                        <tr key={idx}>
                                            <td className="p-2 border-b border-dashed border-gray-100 text-start">
                                                <div className="whitespace-nowrap text-slate-300 text-[10px] font-bold lowercase italic">{t('common.total')} ({code}):</div>
                                            </td>
                                            <td className="p-2 border-b border-dashed border-gray-100 text-end">
                                                <div className="whitespace-nowrap font-bold text-slate-400 text-xs tabular-nums">
                                                    {formatCurrency(amount, code, features.iqd_display_preference)}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}

                                    <tr>
                                        <td className="bg-main p-3 text-start">
                                            <div className={cn("whitespace-nowrap font-black text-white text-lg", !isRTL && "tracking-tighter uppercase")}>{t('invoice.total')}:</div>
                                        </td>
                                        <td className="bg-main p-3 text-end">
                                            <div className="whitespace-nowrap font-bold text-white text-xl">
                                                {formatCurrency(data.total_amount, settlementCurrency, features.iqd_display_preference)}
                                            </div>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Site Footer */}
                    <div className="mt-8 border-t border-gray-200 pt-3 text-center text-xs text-neutral-500">
                        {data.origin === 'pos' ? t('invoice.posSystem') : 'Atlas'}
                        <span className="text-slate-300 px-2">|</span>
                        {t('invoice.generated')}
                    </div>
                </div >
            </div >
        )
    }
)

A4InvoiceTemplate.displayName = 'A4InvoiceTemplate'
