import { forwardRef } from 'react'
import { UniversalInvoice } from '@/types'
import { cn, formatCurrency, formatDate, formatTime } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'
import { Mail, MapPin, Phone, X, RotateCw, Scaling, Move } from 'lucide-react'
import { EditableField } from '@/ui/components/EditableField'
import { AttachedShapesOverlay } from '@/ui/components/AttachedShapesOverlay'
import { MovableOrderPrintBlock } from '@/ui/components/MovableComponentPrint'
import type { CustomTemplateComponentPosition } from '@/lib/printPreviewEditorStore'
import { resolveIsolatedTextDirection } from '@/lib/textDirection'

export const MODERN_A4_MOVABLE_COMPONENT_KEYS = {
    logo: 'logo',
    workspaceName: 'workspaceName',
    qrCode: 'qrCode',
    date: 'date',
    time: 'time',
    invoiceNumber: 'invoiceNumber',
    soldTo: 'soldTo',
    soldBy: 'soldBy',
    itemsTable: 'itemsTable',
    terms: 'terms',
    exchangeRate: 'exchangeRate',
    totalSummary: 'totalSummary',
    generatedBy: 'generatedBy',
    contacts: 'contacts'
} as const

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
    onDataChange?: (data: UniversalInvoice) => void
    drawingMode?: string
    hideUnit?: boolean
    hideDiscount?: boolean
    componentPositions?: Record<string, CustomTemplateComponentPosition>
    editableComponents?: boolean
    onComponentPositionChange?: (key: string, position: CustomTemplateComponentPosition) => void
}

export const ModernA4InvoiceTemplate = forwardRef<HTMLDivElement, ModernA4InvoiceTemplateProps>(
    ({ data, features, workspaceId: propWorkspaceId, workspaceName, workspaceFooterContacts, onDataChange, drawingMode, hideUnit, hideDiscount, componentPositions, editableComponents, onComponentPositionChange }, ref) => {
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
            ? formatDate(createdAt)
            : '--/--/--'
        const timeLabel = hasValidCreatedAt
            ? formatTime(createdAt)
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
        const footerDensity = Object.keys(currencyTotals).length
            + (data.exchange_rates && data.exchange_rates.length > 0 ? 1 : 0)
            + footerContactGroups.length
        const minimumTableRows = Math.max(8, (hasFooterContacts ? 10 : 12) - Math.min(4, footerDensity))

        // Brand Color from reference
        const BRAND_COLOR = '#197fe6'

        const positionFor = (key: string) => componentPositions?.[key]
        const mp = (
            key: string,
            label: string,
            wrapperClassName?: string,
            children?: React.ReactNode,
            options?: { resizable?: boolean; fontSizeEditable?: boolean; defaultFontSize?: number }
        ) => (
            <MovableOrderPrintBlock
                componentKey={key}
                label={label}
                position={positionFor(key)}
                editable={editableComponents}
                onPositionChange={onComponentPositionChange}
                wrapperClassName={wrapperClassName}
                resizable={options?.resizable}
                maxScale={4}
                fontSizeEditable={options?.fontSizeEditable}
                defaultFontSize={options?.defaultFontSize}
            >
                {children}
            </MovableOrderPrintBlock>
        )

        return (
            <div
                ref={ref}
                dir={isRTL ? 'rtl' : 'ltr'}
                className="a4-container relative p-[15mm] md:p-[20mm] bg-white text-slate-900 antialiased overflow-visible flex flex-col"
                style={{ width: '210mm', minHeight: '297mm', margin: '0 auto' }}
                data-order-print-page=""
                data-page-width-mm="210"
            >
                <style dangerouslySetInnerHTML={{
                    __html: `
.a4-container {
    color-scheme: light !important;
    background-color: white !important;
    color: #0f172a !important;
}
@media print {
    @page { size: A4; margin: 0; }
    body { background: white !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; display: block; padding: 0; margin: 0; }
    .no-print { display: none; }
    .a4-container { margin: 0 !important; box-shadow: none !important; width: 100% !important; min-height: 100% !important; overflow: visible !important; page-break-after: avoid; }
}
.a4-container .text-primary { color: ${BRAND_COLOR} !important; }
.a4-container .bg-primary { background-color: ${BRAND_COLOR} !important; }
.a4-container .border-primary { border-color: ${BRAND_COLOR} !important; }
.a4-container .border-slate-200 { border-color: #e2e8f0 !important; }
.a4-container .bg-slate-50 { background-color: #f8fafc !important; }
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
                    {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.logo, 'Logo', 'w-20 h-20 flex-shrink-0',
                        features.logo_url ? (
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
                        ),
                        { resizable: true }
                    )}
                    {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.workspaceName, 'Workspace Name', 'flex-1 text-center px-4 pt-1',
                        <h1 className="text-2xl font-extrabold text-primary tracking-tight mb-1">{workspaceName || 'Atlas'}</h1>,
                        { fontSizeEditable: true, defaultFontSize: 24 }
                    )}
                    {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.qrCode, 'QR Code', 'w-16 flex flex-col items-end gap-1 flex-shrink-0',
                        <>
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
                        </>
                    )}
                </header>

                {/* INFO GRID */}
                <div className="grid grid-cols-3 gap-3 mb-4 shrink-0">
                    {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.date, 'Date', undefined,
                        <div className="flex flex-col items-center justify-center text-center gap-1 p-3 rounded-lg bg-slate-50 border border-slate-100 min-h-[60px]">
                            <span className={cn("text-[10px] font-semibold text-slate-400", !isRTL && "uppercase tracking-wider")}>
                                {tr('invoice.date', 'Date')}
                            </span>
                            <span className="text-sm font-bold text-slate-800 leading-none">{dateLabel}</span>
                        </div>
                    )}
                    {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.time, 'Time', undefined,
                        <div className="flex flex-col items-center justify-center text-center gap-1 p-3 rounded-lg bg-slate-50 border border-slate-100 min-h-[60px]">
                            <span className={cn("text-[10px] font-semibold text-slate-400", !isRTL && "uppercase tracking-wider")}>
                                {tr('common.time', 'Time')}
                            </span>
                            <span className="text-sm font-bold text-slate-800 leading-none">{timeLabel}</span>
                        </div>
                    )}
                    {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.invoiceNumber, 'Invoice #', undefined,
                        <div className="flex flex-col items-center justify-center text-center gap-1 p-3 rounded-lg bg-slate-50 border border-slate-100 min-h-[60px]">
                            <span className={cn("text-[10px] font-semibold text-slate-400", !isRTL && "uppercase tracking-wider")}>
                                {tr('invoice.number', 'Invoice #')}
                            </span>
                            <span className="text-sm font-bold text-slate-800 leading-none">{data.invoiceid || `#${String(data.id).slice(0, 8)}`}</span>
                        </div>
                    )}
                </div>

                {/* PARTIES */}
                <div className="grid grid-cols-2 gap-8 mb-4 shrink-0">
                    {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.soldTo, 'Sold To', undefined,
                        <div className="flex flex-col gap-2">
                            <div>
                                <h3 className={cn("text-primary text-[10px] font-bold border-b border-primary/20 pb-1 mb-1", !isRTL && "uppercase tracking-wide")}>
                                    {tr('invoice.soldTo', 'Sold To:')}
                                </h3>
                                <div className="mt-1">
                                    <EditableField
                                        value={data.customer_address || data.customer_name || ''}
                                        onChange={(v) => onDataChange?.({ ...data, customer_address: v })}
                                        type="textarea"
                                        placeholder={tr('invoice.enterCustomerDetails', 'Enter customer details...')}
                                        className="font-bold text-slate-800 text-xs w-full"
                                        editable={!!onDataChange}
                                        display={(val) => val ? (
                                            <div className="whitespace-pre-wrap">{val}</div>
                                        ) : (
                                            <div className="flex flex-col gap-1 w-full opacity-40">
                                                <div className="border-b border-slate-200 w-full h-4"></div>
                                                <div className="border-b border-slate-200 w-full h-4"></div>
                                            </div>
                                        )}
                                    />
                                </div>
                            </div>
                        </div>
                    )}
                    {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.soldBy, 'Sold By', undefined,
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
                    )}
                </div>

                {/* ITEMS TABLE */}
                <div className="flex-grow mb-4 flex flex-col min-h-0">
                    {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.itemsTable, 'Table', 'flex-grow flex flex-col',
                        <div className="overflow-hidden rounded border border-slate-200 flex-grow">
                            <table className={cn("w-full border-collapse table-fixed", isRTL ? "text-right" : "text-left")}>
                                <thead>
                                    <tr className={cn("bg-slate-50 text-slate-500 text-[11px] font-bold border-b border-slate-200 h-10", !isRTL && "uppercase tracking-wider")}>
                                        <th className="px-2 w-1/3 border-r border-slate-200">{tr('invoice.productName', 'Product Name')}</th>
                                        <th className="px-2 w-12 text-center border-r border-slate-200">{tr('invoice.qty', 'Qty')}</th>
                                        <th className="px-2 w-24 text-end border-r border-slate-200">{tr('invoice.price', 'Price')}</th>
                                        {!hideDiscount && <th className="px-2 w-16 text-center border-r border-slate-200">{tr('invoice.discount', 'Discount')}</th>}
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
                                            <tr key={idx} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50 transition-colors h-9">
                                                <td className="px-2 font-semibold text-slate-800 border-r border-slate-100 truncate">
                                                    {item.product_name}
                                                </td>
                                                <td className="px-2 text-center text-slate-500 border-r border-slate-100 font-bold">
                                                    {quantity}{(!hideUnit && item.unit) ? ` ${t(`products.units.${item.unit}`, item.unit)}` : ''}
                                                </td>
                                                <td className="px-2 text-end font-medium text-slate-700 border-r border-slate-100 tabular-nums">
                                                    {formatCurrency(priceToShow, settlementCurrency, iqdDisplayPreference)}
                                                </td>
                                                {!hideDiscount && (
                                                    <td className="px-2 text-center text-green-600 font-medium border-r border-slate-100">
                                                        {discountAmount > 0 ? formatCurrency(discountAmount, settlementCurrency, iqdDisplayPreference) : '-'}
                                                    </td>
                                                )}
                                                <td className="px-2 text-end font-bold text-slate-900 tabular-nums">
                                                    {formatCurrency(total, settlementCurrency, iqdDisplayPreference)}
                                                </td>
                                            </tr>
                                        )
                                    })}
                                    {items.length < minimumTableRows && Array.from({ length: minimumTableRows - items.length }).map((_, i) => (
                                        <tr key={`empty-${i}`} className="border-b border-slate-50 last:border-0 h-9 opacity-20">
                                            <td className="px-2 border-r border-slate-50">&nbsp;</td>
                                            <td className="px-2 border-r border-slate-50">&nbsp;</td>
                                            <td className="px-2 border-r border-slate-50">&nbsp;</td>
                                            {!hideDiscount && <td className="px-2 border-r border-slate-50">&nbsp;</td>}
                                            <td className="px-2">&nbsp;</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* FOOTER */}
                <div className="pt-4 border-t border-slate-200 flex flex-row gap-6 shrink-0">
                    <div className="flex-1 pr-4 flex flex-col justify-between">
                        {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.terms, 'Terms & Conditions', undefined,
                            <div>
                                <h4 className={cn("text-[10px] font-bold text-slate-800 mb-1", !isRTL && "uppercase tracking-wider")}>
                                    {tr('invoice.terms', 'Terms & Conditions')}
                                </h4>
                                <div className="mt-1 w-full">
                                    <EditableField
                                        value={data.terms || ''}
                                        onChange={(v) => onDataChange?.({ ...data, terms: v })}
                                        type="textarea"
                                        placeholder={tr('invoice.termsContent', 'Enter terms and conditions')}
                                        className="text-[9px] text-slate-500 w-full"
                                        editable={!!onDataChange}
                                        display={(val) => val ? (
                                            <div className="whitespace-pre-wrap">{val}</div>
                                        ) : (
                                            <div className="flex flex-col gap-3 w-full opacity-40">
                                                <div className="border-b border-slate-200 w-full h-3"></div>
                                                <div className="border-b border-slate-200 w-full h-3"></div>
                                            </div>
                                        )}
                                    />
                                </div>
                            </div>
                        )}

                        {data.exchange_rates && data.exchange_rates.length > 0 && mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.exchangeRate, 'Exchange Rate', undefined,
                            <div className="flex flex-col gap-2 mt-4">
                                <div className={cn("text-[9px] font-semibold text-slate-400", !isRTL && "uppercase tracking-widest")}>
                                    {tr('invoice.exchangeRates', 'Exchange Rates')}
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {data.exchange_rates.slice(0, 3).map((rate: any, i: number) => (
                                        <div key={i} className={cn("px-2 py-1 bg-slate-50 rounded text-[9px] font-medium text-slate-600 border border-slate-100 tabular-nums", !isRTL && "font-mono")}>
                                            {rate.priceBasisAmount || 100} {rate.pair.split('/')[0]} = {rate.rate} {rate.pair.split('/')[1]}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="w-[280px]">
                        {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.totalSummary, 'Total Summary', undefined,
                            <div className="bg-slate-50 rounded-lg p-4 border border-slate-100">
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
                        )}

                        {mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.generatedBy, 'Generated By', undefined,
                            <div className={cn("mt-4 text-center text-[8px] text-slate-400 font-bold", !isRTL && "uppercase tracking-widest")}>
                                {data.origin === 'pos' ? tr('invoice.posSystem', 'POS System') : 'Atlas'} | {tr('invoice.generated', 'Generated Automatically')}
                            </div>
                        )}
                    </div>
                </div>

                {hasFooterContacts && mp(MODERN_A4_MOVABLE_COMPONENT_KEYS.contacts, 'Contacts', undefined,
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

                {((data.attached_images && data.attached_images.length > 0) || (data.attached_texts && data.attached_texts.length > 0)) && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden print:overflow-visible">
                        {(data.attached_images || []).map((img, idx) => (
                            <div
                                key={idx}
                                className="absolute pointer-events-auto group"
                                style={{
                                    left: `${img.x}mm`,
                                    top: `${img.y}mm`,
                                    width: `${img.width}mm`,
                                    transform: `rotate(${img.rotation || 0}deg)`,
                                    cursor: onDataChange ? 'move' : 'default',
                                    zIndex: 50 + idx
                                }}
                                onPointerDown={(e) => {
                                    if (!onDataChange) return
                                    e.preventDefault()
                                    e.stopPropagation()

                                    const el = e.currentTarget
                                    const startX = e.clientX
                                    const startY = e.clientY
                                    const initialX = img.x
                                    const initialY = img.y

                                    const rect = el.offsetParent?.getBoundingClientRect()
                                    if (!rect) return
                                    const scale = 210 / rect.width

                                    const onPointerMove = (moveEvent: PointerEvent) => {
                                        const dx = (moveEvent.clientX - startX) * scale
                                        const dy = (moveEvent.clientY - startY) * scale

                                        const newImages = [...(data.attached_images || [])]
                                        newImages[idx] = {
                                            ...img,
                                            x: initialX + dx,
                                            y: initialY + dy
                                        }
                                        onDataChange({ ...data, attached_images: newImages })
                                    }

                                    const onPointerUp = () => {
                                        window.removeEventListener('pointermove', onPointerMove)
                                        window.removeEventListener('pointerup', onPointerUp)
                                    }

                                    window.addEventListener('pointermove', onPointerMove)
                                    window.addEventListener('pointerup', onPointerUp)
                                }}
                            >
                                <img
                                    src={platformService.convertFileSrc(img.path)}
                                    alt=""
                                    className="w-full h-auto object-contain block ring-1 ring-transparent group-hover:ring-primary transition-shadow"
                                    style={{ maxHeight: '1000mm' }}
                                />

                                {onDataChange && (
                                    <>
                                        <div
                                            className="absolute -top-8 left-1/2 -translate-x-1/2 w-6 h-6 bg-white border border-slate-200 rounded-full shadow-sm flex items-center justify-center cursor-alias opacity-0 group-hover:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
                                            onPointerDown={(e) => {
                                                e.stopPropagation()
                                                e.preventDefault()
                                                const rect = e.currentTarget.parentElement?.getBoundingClientRect()
                                                if (!rect) return
                                                const centerX = rect.left + rect.width / 2
                                                const centerY = rect.top + rect.height / 2
                                                const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX)
                                                const initialRotation = img.rotation || 0

                                                const onPointerMove = (mE: PointerEvent) => {
                                                    const currentAngle = Math.atan2(mE.clientY - centerY, mE.clientX - centerX)
                                                    const delta = (currentAngle - startAngle) * (180 / Math.PI)
                                                    const newImages = [...(data.attached_images || [])]
                                                    newImages[idx] = { ...img, rotation: initialRotation + delta }
                                                    onDataChange({ ...data, attached_images: newImages })
                                                }
                                                const onPointerUp = () => {
                                                    window.removeEventListener('pointermove', onPointerMove)
                                                    window.removeEventListener('pointerup', onPointerUp)
                                                }
                                                window.addEventListener('pointermove', onPointerMove)
                                                window.addEventListener('pointerup', onPointerUp)
                                            }}
                                        >
                                            <RotateCw className="w-3 h-3 text-primary" />
                                        </div>

                                        <div
                                            className="absolute -bottom-2 -right-2 w-5 h-5 bg-white border border-slate-200 rounded shadow-sm flex items-center justify-center cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
                                            onPointerDown={(e) => {
                                                e.stopPropagation()
                                                e.preventDefault()
                                                const startX = e.clientX
                                                const initialWidth = img.width
                                                const rect = e.currentTarget.parentElement?.offsetParent?.getBoundingClientRect()
                                                if (!rect) return
                                                const scale = 210 / rect.width

                                                const onPointerMove = (mE: PointerEvent) => {
                                                    const dx = (mE.clientX - startX) * scale
                                                    const newWidth = Math.max(10, initialWidth + dx)
                                                    const newImages = [...(data.attached_images || [])]
                                                    newImages[idx] = { ...img, width: newWidth }
                                                    onDataChange({ ...data, attached_images: newImages })
                                                }
                                                const onPointerUp = () => {
                                                    window.removeEventListener('pointermove', onPointerMove)
                                                    window.removeEventListener('pointerup', onPointerUp)
                                                }
                                                window.addEventListener('pointermove', onPointerMove)
                                                window.addEventListener('pointerup', onPointerUp)
                                            }}
                                        >
                                            <Scaling className="w-3 h-3 text-primary" />
                                        </div>

                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                const newImages = (data.attached_images || []).filter((_, i) => i !== idx)
                                                onDataChange({ ...data, attached_images: newImages })
                                            }}
                                            className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity shadow-md hover:bg-red-600 active:scale-95"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </>
                                )}
                            </div>
                        ))}

                        {(data.attached_texts || []).map((txt, idx) => (
                            <div
                                key={txt.id}
                                className="absolute pointer-events-auto group"
                                style={{
                                    left: `${txt.x}mm`,
                                    top: `${txt.y}mm`,
                                    width: `${txt.width}mm`,
                                    transform: `rotate(${txt.rotation || 0}deg)`,
                                    zIndex: 100 + idx
                                }}
                            >
                                <textarea
                                    value={txt.text}
                                    dir={resolveIsolatedTextDirection(txt.text)}
                                    onChange={(e) => {
                                        if (!onDataChange) return
                                        const newTexts = [...(data.attached_texts || [])]
                                        newTexts[idx] = { ...txt, text: e.target.value }
                                        onDataChange({ ...data, attached_texts: newTexts })
                                    }}
                                    className="w-full bg-transparent border-none outline-none resize-none p-1 block ring-1 ring-transparent group-hover:ring-primary transition-shadow text-inherit font-bold overflow-hidden"
                                    style={{
                                        height: 'auto',
                                        fontSize: `${txt.fontSize || 16}px`,
                                        color: txt.color || 'inherit'
                                    }}
                                    onBlur={(e) => {
                                        if (!onDataChange) return
                                        if (!e.target.value.trim()) {
                                            const newTexts = (data.attached_texts || []).filter(t => t.id !== txt.id)
                                            onDataChange({ ...data, attached_texts: newTexts })
                                        }
                                    }}
                                    rows={1}
                                    spellCheck={false}
                                />

                                {onDataChange && (
                                    <>
                                        <div
                                            className="absolute -top-16 left-1/2 -translate-x-1/2 h-7 bg-white border border-slate-200 rounded-md shadow-sm flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity z-10 px-1"
                                            onPointerDown={(e) => e.stopPropagation()}
                                        >
                                            <input
                                                type="text"
                                                lang="en"
                                                inputMode="numeric"
                                                min="8"
                                                max="72"
                                                value={txt.fontSize === '' ? '' : (txt.fontSize ?? 16)}
                                                onChange={(e) => {
                                                    if (!onDataChange) return
                                                    const newTexts = [...(data.attached_texts || [])]
                                                    const val = e.target.value
                                                    newTexts[idx] = { ...txt, fontSize: val === '' ? '' : parseInt(val) }
                                                    onDataChange({ ...data, attached_texts: newTexts })
                                                }}
                                                className="w-12 h-5 text-center text-xs outline-none font-medium text-slate-700 bg-transparent"
                                            />
                                            <span className="text-[10px] text-slate-400 font-medium pr-1 select-none pointer-events-none">px</span>
                                        </div>

                                        <div
                                            className="absolute -bottom-7 left-1/2 -translate-x-1/2 w-6 h-6 bg-white border border-slate-200 rounded-full shadow-sm flex items-center justify-center cursor-move opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
                                            onPointerDown={(e) => {
                                                if (!onDataChange) return
                                                e.preventDefault()
                                                e.stopPropagation()
                                                const el = e.currentTarget.parentElement!
                                                const startX = e.clientX
                                                const startY = e.clientY
                                                const initialX = txt.x
                                                const initialY = txt.y
                                                const rect = el.offsetParent?.getBoundingClientRect()
                                                if (!rect) return
                                                const scale = 210 / rect.width
                                                const onPointerMove = (moveEvent: PointerEvent) => {
                                                    if (!onDataChange) return
                                                    const dx = (moveEvent.clientX - startX) * scale
                                                    const dy = (moveEvent.clientY - startY) * scale
                                                    const newTexts = [...(data.attached_texts || [])]
                                                    newTexts[idx] = { ...txt, x: initialX + dx, y: initialY + dy }
                                                    onDataChange({ ...data, attached_texts: newTexts })
                                                }
                                                const onPointerUp = () => {
                                                    window.removeEventListener('pointermove', onPointerMove)
                                                    window.removeEventListener('pointerup', onPointerUp)
                                                }
                                                window.addEventListener('pointermove', onPointerMove)
                                                window.addEventListener('pointerup', onPointerUp)
                                            }}
                                        >
                                            <Move className="w-3 h-3 text-primary" />
                                        </div>
                                        <div
                                            className="absolute -top-8 left-1/2 -translate-x-1/2 w-6 h-6 bg-white border border-slate-200 rounded-full shadow-sm flex items-center justify-center cursor-alias opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
                                            onPointerDown={(e) => {
                                                e.stopPropagation()
                                                e.preventDefault()
                                                const rect = e.currentTarget.parentElement?.getBoundingClientRect()
                                                if (!rect) return
                                                const centerX = rect.left + rect.width / 2
                                                const centerY = rect.top + rect.height / 2
                                                const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX)
                                                const initialRotation = txt.rotation || 0

                                                const onPointerMove = (mE: PointerEvent) => {
                                                    if (!onDataChange) return
                                                    const currentAngle = Math.atan2(mE.clientY - centerY, mE.clientX - centerX)
                                                    const delta = (currentAngle - startAngle) * (180 / Math.PI)
                                                    const newTexts = [...(data.attached_texts || [])]
                                                    newTexts[idx] = { ...txt, rotation: initialRotation + delta }
                                                    onDataChange({ ...data, attached_texts: newTexts })
                                                }
                                                const onPointerUp = () => {
                                                    window.removeEventListener('pointermove', onPointerMove)
                                                    window.removeEventListener('pointerup', onPointerUp)
                                                }
                                                window.addEventListener('pointermove', onPointerMove)
                                                window.addEventListener('pointerup', onPointerUp)
                                            }}
                                        >
                                            <RotateCw className="w-3 h-3 text-primary" />
                                        </div>

                                        <div
                                            className="absolute -bottom-2 -right-2 w-5 h-5 bg-white border border-slate-200 rounded shadow-sm flex items-center justify-center cursor-nwse-resize opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
                                            onPointerDown={(e) => {
                                                e.stopPropagation()
                                                e.preventDefault()
                                                const startX = e.clientX
                                                const initialWidth = txt.width
                                                const rect = e.currentTarget.parentElement?.offsetParent?.getBoundingClientRect()
                                                if (!rect) return
                                                const scale = 210 / rect.width

                                                const onPointerMove = (mE: PointerEvent) => {
                                                    if (!onDataChange) return
                                                    const dx = (mE.clientX - startX) * scale
                                                    const newWidth = Math.max(20, initialWidth + dx)
                                                    const newTexts = [...(data.attached_texts || [])]
                                                    newTexts[idx] = { ...txt, width: newWidth }
                                                    onDataChange({ ...data, attached_texts: newTexts })
                                                }
                                                const onPointerUp = () => {
                                                    window.removeEventListener('pointermove', onPointerMove)
                                                    window.removeEventListener('pointerup', onPointerUp)
                                                }
                                                window.addEventListener('pointermove', onPointerMove)
                                                window.addEventListener('pointerup', onPointerUp)
                                            }}
                                        >
                                            <Scaling className="w-3 h-3 text-primary" />
                                        </div>

                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                const newTexts = (data.attached_texts || []).filter(t => t.id !== txt.id)
                                                onDataChange({ ...data, attached_texts: newTexts })
                                            }}
                                            className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shadow-md hover:bg-red-600 active:scale-95 z-10"
                                        >
                                            <X className="w-3 h-3" />
                                        </button>
                                    </>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                <AttachedShapesOverlay
                    shapes={data.attached_shapes}
                    onShapesChange={onDataChange ? (attached_shapes) => onDataChange({ ...data, attached_shapes }) : undefined}
                />

                <svg
                    className="absolute inset-0 z-[40] pointer-events-none"
                    viewBox="0 0 210 297"
                >
                    {(data.annotations || []).map((ann, i) => (
                        <path
                            key={i}
                            d={`M ${ann.points.map(p => `${p.x},${p.y}`).join(' L ')}`}
                            stroke={ann.color}
                            strokeWidth={ann.brushSize}
                            fill="none"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={cn(drawingMode === 'eraser' && "cursor-pointer hover:stroke-destructive transition-colors")}
                            style={{ pointerEvents: drawingMode === 'eraser' ? 'all' : 'none' }}
                            onPointerDown={(e) => {
                                if (drawingMode === 'eraser' && onDataChange) {
                                    e.stopPropagation()
                                    const newAnnotations = (data.annotations || []).filter((_, idx) => idx !== i)
                                    onDataChange({ ...data, annotations: newAnnotations })
                                }
                            }}
                        />
                    ))}
                </svg>
            </div>
        )
    }
)

ModernA4InvoiceTemplate.displayName = 'ModernA4InvoiceTemplate'
