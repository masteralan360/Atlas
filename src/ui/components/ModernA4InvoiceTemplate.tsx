import { forwardRef } from 'react'
import { UniversalInvoice } from '@/types'
import { cn, formatCurrency } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'
import { Mail, MapPin, Phone } from 'lucide-react'

interface WorkspaceContactPair {
    primary?: string
    nonPrimary?: string
}

interface WorkspaceFooterContacts {
    address?: WorkspaceContactPair
    email?: WorkspaceContactPair
    phone?: WorkspaceContactPair
}

interface ModernA4InvoiceTemplateProps {
    data: UniversalInvoice
    features: any
    workspaceId?: string
    workspaceName?: string
    workspaceFooterContacts?: WorkspaceFooterContacts
}

export const ModernA4InvoiceTemplate = forwardRef<HTMLDivElement, ModernA4InvoiceTemplateProps>(
    ({ data, features, workspaceId: propWorkspaceId, workspaceName, workspaceFooterContacts }, ref) => {
        const { i18n } = useTranslation()
        const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
        const t = i18n.getFixedT(printLang)
        const isRTL = printLang === 'ar' || printLang === 'ku'
        const items = data.items || []
        const effectiveWorkspaceId = propWorkspaceId || data.workspaceId

        // Extract Multi-Currency Data for Footer
        const settlementCurrency = (data.settlement_currency || 'usd').toLowerCase()
        const iqdDisplayPreference = features?.iqd_display_preference
        const totalAmountRaw = Number(data.total_amount)
        const totalAmount = Number.isFinite(totalAmountRaw) ? totalAmountRaw : 0
        const subtotalAmountRaw = data.subtotal_amount == null ? totalAmount : Number(data.subtotal_amount)
        const subtotalAmount = Number.isFinite(subtotalAmountRaw) ? subtotalAmountRaw : totalAmount
        const uniqueOriginalCurrencies = Array.from(new Set(items.map(i => (i.original_currency || 'usd').toLowerCase())))
            .filter(c => c !== settlementCurrency)
        const currencyTotals: Record<string, number> = {}
        uniqueOriginalCurrencies.forEach(curr => {
            currencyTotals[curr] = items
                .filter(i => (i.original_currency || 'usd').toLowerCase() === curr)
                .reduce((sum, i) => {
                    const originalUnitPriceRaw = Number(i.original_unit_price)
                    const originalUnitPrice = Number.isFinite(originalUnitPriceRaw) ? originalUnitPriceRaw : 0
                    const quantityRaw = Number(i.quantity)
                    const quantity = Number.isFinite(quantityRaw) ? quantityRaw : 0
                    return sum + (originalUnitPrice * quantity)
                }, 0)
        })

        const tr = (key: string, fallback: string) => {
            const translated = t(key)
            return translated && translated !== key ? translated : fallback
        }

        const trimTrailingColon = (label: string) => label.replace(/\s*:+\s*$/u, '')
        const shippedToLabel = `${trimTrailingColon(tr('invoice.shippedTo', 'Shipped To'))}:`
        const viaLabel = `${trimTrailingColon(tr('invoice.via', 'Via'))}:`

        const createdAt = new Date(data.created_at)
        const hasValidCreatedAt = !Number.isNaN(createdAt.getTime())
        const dateLabel = hasValidCreatedAt
            ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(createdAt)
            : '--/--/----'
        const timeLabel = hasValidCreatedAt
            ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(createdAt)
            : '--:--'

        const footerContactGroups = [
            {
                key: 'address',
                primary: workspaceFooterContacts?.address?.primary?.trim() || '',
                nonPrimary: workspaceFooterContacts?.address?.nonPrimary?.trim() || '',
                valueDir: 'auto' as const,
                icon: MapPin,
            },
            {
                key: 'email',
                primary: workspaceFooterContacts?.email?.primary?.trim() || '',
                nonPrimary: workspaceFooterContacts?.email?.nonPrimary?.trim() || '',
                valueDir: 'ltr' as const,
                icon: Mail,
            },
            {
                key: 'phone',
                primary: workspaceFooterContacts?.phone?.primary?.trim() || '',
                nonPrimary: workspaceFooterContacts?.phone?.nonPrimary?.trim() || '',
                valueDir: 'ltr' as const,
                icon: Phone,
            }
        ].map((group) => {
            const entries: Array<{ type: 'primary' | 'nonPrimary'; value: string }> = []
            if (group.primary.length > 0) entries.push({ type: 'primary', value: group.primary })
            if (group.nonPrimary.length > 0) entries.push({ type: 'nonPrimary', value: group.nonPrimary })
            return { ...group, entries }
        }).filter((group) => group.entries.length > 0)
        const hasFooterContacts = footerContactGroups.length > 0
        const minimumTableRows = hasFooterContacts
            ? (footerContactGroups.length >= 3 ? 12 : footerContactGroups.length === 2 ? 13 : 14)
            : 15

        // Brand Color from reference
        const BRAND_COLOR = '#197fe6'

        return (
            <div
                ref={ref}
                dir={isRTL ? 'rtl' : 'ltr'}
                className="a4-container relative p-[15mm] md:p-[20mm] bg-white text-slate-900 antialiased overflow-hidden flex flex-col"
                style={{ width: '210mm', height: '297mm', margin: '0 auto' }}
            >
                {/* Internal Styles for Print Exactness */}
                <style dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { size: A4; margin: 0; }
    body { background: white !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; display: block; padding: 0; margin: 0; }
    .no-print { display: none; }
    .a4-container { margin: 0 !important; box-shadow: none !important; width: 100% !important; height: 100% !important; page-break-after: avoid; }
}

/* Scope color overrides to the container */
.a4-container .text-primary { color: ${BRAND_COLOR} !important; }
.a4-container .bg-primary { background-color: ${BRAND_COLOR} !important; }
.a4-container .border-primary { border-color: ${BRAND_COLOR} !important; }

.a4-container .modern-footer-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    row-gap: 8px;
    line-height: 1.2;
}
.a4-container .modern-footer-group {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
}
.a4-container .modern-footer-icon {
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
    line-height: 1;
    flex-shrink: 0;
    margin-right: 8px;
}
.a4-container .modern-footer-entry {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    line-height: 1.2;
}
.a4-container .modern-footer-entry + .modern-footer-entry {
    margin-left: 12px;
}
.a4-container .modern-footer-primary-dot {
    color: ${BRAND_COLOR};
    font-size: 10px;
    line-height: 1;
    display: inline;
    vertical-align: middle;
}
.a4-container .modern-footer-value {
    line-height: 1.2;
    display: inline;
}
.a4-container .modern-footer-separator {
    display: inline-flex;
    align-items: center;
    margin: 0 16px;
    color: #cbd5e1;
    font-weight: 700;
    line-height: 1.2;
}
`}} />

                {/* HEADER */}
                <header className="flex justify-between items-start border-b border-slate-200 pb-4 mb-4 shrink-0">
                    <div className="w-20 h-20 flex-shrink-0">
                        {features.logo_url ? (
                            <div className="w-full h-full rounded-xl flex items-center justify-center border border-slate-200 overflow-hidden bg-white">
                                <img
                                    src={features.logo_url.startsWith('http') ? features.logo_url : platformService.convertFileSrc(features.logo_url)}
                                    alt="Workspace Logo"
                                    className="max-h-full max-w-full object-contain"
                                />
                            </div>
                        ) : (
                            <div className="w-full h-full bg-slate-100 rounded-xl flex flex-col items-center justify-center border border-slate-200 text-slate-400 overflow-hidden">
                                <span className="text-[10px] font-bold uppercase tracking-wider">Logo Here</span>
                            </div>
                        )}
                    </div>
                    <div className="flex-1 text-center px-4 pt-1">
                        <h1 className="text-2xl font-extrabold text-primary tracking-tight mb-1">{workspaceName || 'Atlas'}</h1>
                        <p className="text-slate-500 text-[10px] font-medium">Providing Quality Solutions Since 1995</p>
                        <div className="mt-1 text-[9px] text-slate-400 flex flex-col gap-0.5">
                            {/* In a real app, these would come from workspace settings */}
                            <span>Digital solutions for modern businesses</span>
                        </div>
                    </div>
                    <div className="w-16 flex flex-col items-end gap-1 flex-shrink-0">
                        {features.print_qr && effectiveWorkspaceId && (data.sequenceId || data.invoiceid) && (
                            <div className="bg-white p-1 border border-slate-200 rounded-lg w-16 h-16 flex items-center justify-center overflow-hidden" data-qr-sharp="true">
                                <ReactQRCode
                                    value={`https://asaas-r2-proxy.alanepic360.workers.dev/${effectiveWorkspaceId}/printed-invoices/A4/${data.id}.pdf`}
                                    size={58}
                                    level="M"
                                />
                            </div>
                        )}
                        <span className={cn("text-[8px] text-slate-400 text-right", !isRTL && "font-mono")}>
                            {tr('common.scanToVerify', 'Scan to Verify')}
                        </span>
                    </div>
                </header>

                {/* INFO GRID */}
                <div className="grid grid-cols-3 gap-3 mb-4 shrink-0">
                    <div className="flex flex-col items-center justify-center text-center gap-1 p-3 rounded-lg bg-slate-50 border border-slate-100 dark:bg-slate-800/50 dark:border-slate-700 min-h-[60px]">
                        <span className={cn("text-[10px] font-semibold text-slate-400", !isRTL && "uppercase tracking-wider")}>
                            {tr('invoice.date', 'Date')}
                        </span>
                        <span className="text-sm font-bold text-slate-800 dark:text-white leading-none">{dateLabel}</span>
                    </div>
                    <div className="flex flex-col items-center justify-center text-center gap-1 p-3 rounded-lg bg-slate-50 border border-slate-100 dark:bg-slate-800/50 dark:border-slate-700 min-h-[60px]">
                        <span className={cn("text-[10px] font-semibold text-slate-400", !isRTL && "uppercase tracking-wider")}>
                            {tr('common.time', 'Time')}
                        </span>
                        <span className="text-sm font-bold text-slate-800 dark:text-white leading-none">{timeLabel}</span>
                    </div>
                    <div className="flex flex-col items-center justify-center text-center gap-1 p-3 rounded-lg bg-slate-50 border border-slate-100 dark:bg-slate-800/50 dark:border-slate-700 min-h-[60px]">
                        <span className={cn("text-[10px] font-semibold text-slate-400", !isRTL && "uppercase tracking-wider")}>
                            {tr('invoice.number', 'Invoice #')}
                        </span>
                        <span className="text-sm font-bold text-slate-800 dark:text-white leading-none">{data.invoiceid || `#${String(data.id).slice(0, 8)}`}</span>
                    </div>
                </div>

                {/* PARTIES */}
                <div className="grid grid-cols-2 gap-8 mb-4 shrink-0">
                    <div className="flex flex-col gap-2">
                        <div>
                            <h3 className={cn("text-primary text-[10px] font-bold border-b border-primary/20 pb-1 mb-1", !isRTL && "uppercase tracking-wide")}>
                                {tr('invoice.soldTo', 'Sold To:')}
                            </h3>
                            <div className="flex flex-col gap-1 mt-1">
                                <span className="font-bold text-slate-800 text-xs">{data.customer_name || ''}</span>
                                <div className="border-b border-slate-200 dark:border-slate-600 w-full h-4"></div>
                                <div className="border-b border-slate-200 dark:border-slate-600 w-full h-4"></div>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        <div>
                            <h3 className={cn("text-primary text-[10px] font-bold border-b border-primary/20 pb-1 mb-1", !isRTL && "uppercase tracking-wide")}>
                                {tr('invoice.soldBy', 'Sold By:')}
                            </h3>
                            <div className="flex flex-col gap-1 mt-1">
                                <span className="font-bold text-slate-800 text-xs">{data.cashier_name || ''}</span>
                                <div className="text-[9px] text-slate-500">{shippedToLabel}_______________________________________________________________________ </div>
                                <div className="text-[9px] text-slate-500">{viaLabel}______________________________________________________________________ </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* ITEMS TABLE */}
                <div className="flex-grow mb-4 flex flex-col min-h-0">
                    <div className="overflow-hidden rounded border border-slate-200 dark:border-slate-700 flex-grow">
                        <table className={cn("w-full border-collapse table-fixed", isRTL ? "text-right" : "text-left")}>
                            <thead>
                                <tr className={cn("bg-slate-50 text-slate-500 text-[11px] font-bold border-b border-slate-200 dark:bg-slate-800 dark:border-slate-700 h-10", !isRTL && "uppercase tracking-wider")}>
                                    <th className="px-2 w-1/3 border-r border-slate-200 dark:border-slate-700">{tr('invoice.productName', 'Product Name')}</th>
                                    <th className="px-2 w-12 text-center border-r border-slate-200 dark:border-slate-700">{tr('invoice.qty', 'Qty')}</th>
                                    <th className="px-2 w-24 text-end border-r border-slate-200 dark:border-slate-700">{tr('invoice.price', 'Price')}</th>
                                    <th className="px-2 w-16 text-center border-r border-slate-200 dark:border-slate-700">{tr('invoice.discount', 'Discount')}</th>
                                    <th className="px-2 w-28 text-end">{tr('invoice.total', 'Total')}</th>
                                </tr>
                            </thead>
                            <tbody className="text-xs">
                                {items.map((item, idx) => {
                                    const quantityRaw = Number(item.quantity)
                                    const quantity = Number.isFinite(quantityRaw) ? quantityRaw : 0
                                    const unitPriceRaw = Number(item.unit_price)
                                    const unitPrice = Number.isFinite(unitPriceRaw) ? unitPriceRaw : 0
                                    const discountRaw = Number(item.discount_amount)
                                    const discountAmount = Number.isFinite(discountRaw) ? discountRaw : 0
                                    const itemTotalRaw = Number(item.total_price)
                                    const total = (item.total_price != null && Number.isFinite(itemTotalRaw))
                                        ? itemTotalRaw
                                        : unitPrice * quantity
                                    const priceToShow = unitPrice + (quantity > 0 ? (discountAmount / quantity) : 0)

                                    return (
                                        <tr key={idx} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50 transition-colors dark:border-slate-700 h-9">
                                            <td className="px-2 font-semibold text-slate-800 dark:text-white border-r border-slate-100 dark:border-slate-700 truncate">
                                                {item.product_name}
                                            </td>
                                            <td className="px-2 text-center text-slate-500 border-r border-slate-100 dark:border-slate-700 font-bold">
                                                {quantity}
                                            </td>
                                            <td className="px-2 text-end font-medium text-slate-700 dark:text-slate-300 border-r border-slate-100 dark:border-slate-700 tabular-nums">
                                                {formatCurrency(priceToShow, settlementCurrency, iqdDisplayPreference)}
                                            </td>
                                            <td className="px-2 text-center text-green-600 font-medium border-r border-slate-100 dark:border-slate-700">
                                                {discountAmount > 0 ? formatCurrency(discountAmount, settlementCurrency, iqdDisplayPreference) : '-'}
                                            </td>
                                            <td className="px-2 text-end font-bold text-slate-900 dark:text-white tabular-nums">
                                                {formatCurrency(total, settlementCurrency, iqdDisplayPreference)}
                                            </td>
                                        </tr>
                                    )
                                })}
                                {/* Fill empty space to keep layout consistent if needed */}
                                {items.length < minimumTableRows && Array.from({ length: minimumTableRows - items.length }).map((_, i) => (
                                    <tr key={`empty-${i}`} className="border-b border-slate-50 last:border-0 h-9 opacity-20">
                                        <td className="px-2 border-r border-slate-50">&nbsp;</td>
                                        <td className="px-2 border-r border-slate-50">&nbsp;</td>
                                        <td className="px-2 border-r border-slate-50">&nbsp;</td>
                                        <td className="px-2 border-r border-slate-50">&nbsp;</td>
                                        <td className="px-2">&nbsp;</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* FOOTER */}
                <div className="mt-auto pt-4 border-t border-slate-200 flex flex-row gap-6 shrink-0">
                    <div className="flex-1 pr-4 flex flex-col justify-between">
                        <div>
                            <h4 className={cn("text-[10px] font-bold text-slate-800 mb-1 dark:text-white", !isRTL && "uppercase tracking-wider")}>
                                {tr('invoice.terms', 'Terms & Conditions')}
                            </h4>
                            <div className="flex flex-col gap-3 mt-1 w-full opacity-40">
                                <div className="border-b border-slate-200 dark:border-slate-600 w-full h-3"></div>
                                <div className="border-b border-slate-200 dark:border-slate-600 w-full h-3"></div>
                            </div>
                        </div>

                        {data.exchange_rates && data.exchange_rates.length > 0 && (
                            <div className="flex flex-col gap-2 mt-4">
                                <div className={cn("text-[9px] font-semibold text-slate-400", !isRTL && "uppercase tracking-widest")}>
                                    {tr('invoice.exchangeRates', 'Exchange Rates')}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {data.exchange_rates.slice(0, 3).map((rate: any, i: number) => (
                                        <div key={i} className={cn("px-2 py-1 bg-slate-50 rounded text-[9px] font-medium text-slate-600 border border-slate-100 tabular-nums", !isRTL && "font-mono")}>
                                            {rate.pair}: {rate.rate}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="w-[280px]">
                        <div className="bg-slate-50 rounded-lg p-4 border border-slate-100 dark:bg-slate-800/50">
                            <div className="flex justify-between items-center mb-1">
                                <span className={cn("text-[10px] text-slate-500 font-medium", !isRTL && "uppercase")}>
                                    {tr('invoice.subtotal', 'Subtotal')}
                                </span>
                                <span className="text-xs font-bold text-slate-700 tabular-nums">
                                    {formatCurrency(subtotalAmount, settlementCurrency, iqdDisplayPreference)}
                                </span>
                            </div>
                            {Object.entries(currencyTotals).map(([code, amount]) => (
                                <div key={code} className="flex justify-between items-center mb-2 pb-2 border-b border-slate-200 border-dashed">
                                    <span className={cn("text-[10px] text-slate-300 font-bold", !isRTL && "lowercase italic")}>
                                        {tr('common.total', 'Total')} ({code}):
                                    </span>
                                    <span className="text-xs font-bold text-slate-500 tabular-nums">
                                        {formatCurrency(amount, code, iqdDisplayPreference)}
                                    </span>
                                </div>
                            ))}
                            <div className="flex justify-between items-end">
                                <div className="flex flex-col">
                                    <span className={cn("text-[10px] font-black text-primary italic leading-tight", !isRTL && "uppercase tracking-wider")}>
                                        {tr('invoice.total', 'Total')}
                                    </span>
                                    <span className={cn("text-[8px] text-slate-400 font-medium", !isRTL && "uppercase")}>
                                        ({settlementCurrency.toUpperCase()})
                                    </span>
                                </div>
                                <span className="text-xl font-black text-primary leading-none tracking-tighter tabular-nums">
                                    {formatCurrency(totalAmount, settlementCurrency, iqdDisplayPreference)}
                                </span>
                            </div>
                        </div>

                        <div className={cn("mt-4 text-center text-[8px] text-slate-400 font-bold", !isRTL && "uppercase tracking-widest")}>
                            {data.origin === 'pos' ? tr('invoice.posSystem', 'POS System') : 'Atlas'} | {tr('invoice.generated', 'Generated Automatically')}
                        </div>
                    </div>
                </div>

                {hasFooterContacts && (
                    <div dir="ltr" className="mt-4 pt-4 pb-2 border-t border-slate-200 shrink-0">
                        <div className="modern-footer-row text-[11px] text-slate-500">
                            {footerContactGroups.map((group, groupIndex) => (
                                <div key={group.key} className="modern-footer-group">
                                    <span className="modern-footer-icon text-primary">
                                        <group.icon className="block w-3.5 h-3.5 text-primary shrink-0" />
                                    </span>
                                    {group.entries.map((entry, entryIndex) => (
                                        <span key={`${group.key}-${entry.type}-${entryIndex}`} className="modern-footer-entry">
                                            {entryIndex > 0 && (
                                                <span className="modern-footer-primary-dot" aria-hidden="true">{'\u25CF'}</span>
                                            )}
                                            <span dir={group.valueDir} className="modern-footer-value font-medium text-slate-500 whitespace-nowrap">
                                                {entry.value}
                                            </span>
                                        </span>
                                    ))}
                                    {groupIndex < footerContactGroups.length - 1 && (
                                        <span className="modern-footer-separator select-none" aria-hidden="true">|</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* BOTTOM ACCENT */}
                <div className="absolute bottom-0 left-0 w-full h-1.5 bg-primary"></div>
            </div>
        )
    }
)

ModernA4InvoiceTemplate.displayName = 'ModernA4InvoiceTemplate'

