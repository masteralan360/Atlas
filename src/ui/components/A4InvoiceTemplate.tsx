import { forwardRef } from 'react'
import { UniversalInvoice } from '@/types'
import { formatCurrency, formatDateTime, cn } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'
import { Mail, MapPin, Phone, X, RotateCw, Scaling, Move } from 'lucide-react'
import { EditableField } from '@/ui/components/EditableField'
import { AttachedShapesOverlay } from '@/ui/components/AttachedShapesOverlay'
import { resolveIsolatedTextDirection } from '@/lib/textDirection'

interface WorkspaceContactPair {
    primary?: string
    nonPrimary?: string
}

interface WorkspaceFooterContacts {
    address?: WorkspaceContactPair
    email?: WorkspaceContactPair
    phone?: WorkspaceContactPair
}

interface A4InvoiceTemplateProps {
    data: UniversalInvoice
    features: any
    workspaceId?: string
    workspaceName?: string
    workspaceFooterContacts?: WorkspaceFooterContacts
    onDataChange?: (data: UniversalInvoice) => void
    drawingMode?: string
    hideUnit?: boolean
    hideDiscount?: boolean
    tableRowCount?: number
}

export const A4InvoiceTemplate = forwardRef<HTMLDivElement, A4InvoiceTemplateProps>(
    ({ data, features, workspaceId: propWorkspaceId, workspaceName, workspaceFooterContacts, onDataChange, drawingMode, hideUnit, hideDiscount, tableRowCount }, ref) => {
        const { i18n } = useTranslation()
        const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
        const t = i18n.getFixedT(printLang)
        const isRTL = printLang === 'ar' || printLang === 'ku'
        const items = data.items || []
        const effectiveWorkspaceId = propWorkspaceId || data.workspaceId

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
                className="a4-container bg-white text-black text-sm font-sans relative flex flex-col min-h-[297mm] text-start"
                style={{ width: '210mm', padding: '0', margin: '0 auto' }}
            >
                {/* Internal Styles for Print Exactness */}
                <style dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; margin: 0; padding: 0; }
}
.modern-footer-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    row-gap: 8px;
    line-height: 1.2;
}
.modern-footer-group {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
}
.modern-footer-icon {
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
.modern-footer-entry {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    line-height: 1.2;
}
.modern-footer-entry + .modern-footer-entry {
    margin-left: 12px;
}
.modern-footer-primary-dot {
    color: ${BRAND_COLOR};
    font-size: 10px;
    line-height: 1;
    display: inline;
    vertical-align: middle;
}
.modern-footer-value {
    line-height: 1.2;
    display: inline;
}
.modern-footer-separator {
    display: inline-flex;
    align-items: center;
    margin: 0 16px;
    color: #cbd5e1;
    font-weight: 700;
    line-height: 1.2;
}
.a4-container {
    color-scheme: light !important;
    background-color: white !important;
    color: black !important;
}
.text-main { color: ${BRAND_COLOR} !important; }
.bg-main { background-color: ${BRAND_COLOR} !important; }
.border-main { border-color: ${BRAND_COLOR} !important; }
.border-slate-100 { border-color: #f1f5f9 !important; }
.border-slate-200 { border-color: #e2e8f0 !important; }
.bg-slate-100 { background-color: #f1f5f9 !important; }
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
                                <td className="w-1/2 align-top text-neutral-600 text-start pr-4">
                                    <p className="font-bold text-black mb-1">{t('invoice.soldTo')}</p>
                                    <EditableField
                                        value={data.customer_address || data.customer_name || ''}
                                        onChange={(v) => onDataChange?.({ ...data, customer_address: v })}
                                        type="textarea"
                                        placeholder={t('invoice.enterCustomerDetails') || 'Enter customer details...'}
                                        className="font-medium text-black w-full"
                                        editable={!!onDataChange}
                                        display={(val) => val ? (
                                            <div className="whitespace-pre-wrap">{val}</div>
                                        ) : (
                                            <>
                                                <div className="h-6 w-full border-b border-gray-300 mb-1"></div>
                                                <div className="h-6 w-full border-b border-gray-300 mb-1"></div>
                                            </>
                                        )}
                                    />
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
                                <th className="border-b-2 border-main pb-3 px-2 text-start font-bold text-main">{t('invoice.productName')}</th>
                                <th className="border-b-2 border-main pb-3 px-2 text-center font-bold text-main w-[80px]">{t('invoice.qty')}</th>
                                <th className="border-b-2 border-main pb-3 px-2 text-end font-bold text-main w-[120px]">{t('invoice.price')}</th>
                                {!hideDiscount && <th className="border-b-2 border-main pb-3 px-2 text-center font-bold text-main w-[100px]">{t('invoice.discount')}</th>}
                                <th className="border-b-2 border-main pb-3 px-2 text-end font-bold text-main w-[130px]">{t('invoice.total')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(tableRowCount ? items.slice(0, tableRowCount) : items).map((item, idx) => {
                                const finalUnitPrice = item.unit_price || 0
                                const total = item.total_price || (finalUnitPrice * item.quantity)
                                const discountAmount = item.discount_amount || 0
                                const priceToShow = finalUnitPrice + (discountAmount / item.quantity)

                                return (
                                    <tr key={idx} className="text-neutral-700">
                                        <td className="border-b py-2 px-2 font-bold text-start">{item.product_name}</td>
                                        <td className="border-b py-2 px-2 text-center font-bold">{item.quantity}{(!hideUnit && item.unit) ? ` ${t(`products.units.${item.unit}`, item.unit)}` : ''}</td>
                                        <td className="border-b py-2 px-2 text-end">
                                            {formatCurrency(priceToShow, settlementCurrency, features.iqd_display_preference)}
                                        </td>
                                        {!hideDiscount && (
                                            <td className="border-b py-2 px-2 text-center text-neutral-400">
                                                {discountAmount > 0 ? formatCurrency(discountAmount, settlementCurrency, features.iqd_display_preference) : '-'}
                                            </td>
                                        )}
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
                                <EditableField
                                    value={data.terms || ''}
                                    onChange={(v) => onDataChange?.({ ...data, terms: v })}
                                    type="textarea"
                                    placeholder={t('invoice.enterTerms') || 'Enter terms and conditions...'}
                                    className="w-full text-xs text-neutral-600"
                                    inputClassName="w-full min-h-[80px]"
                                    display={(val) => val ? (
                                        <div className="whitespace-pre-wrap">{val}</div>
                                    ) : (
                                        <div className="border border-dashed border-gray-300 h-20 rounded w-full"></div>
                                    )}
                                    editable={!!onDataChange}
                                />
                            </div>

                            {data.exchange_rates && data.exchange_rates.length > 0 && (
                                <div>
                                    <p className={cn("text-main font-bold text-xs mb-3", !isRTL && "uppercase")}>{t('invoice.exchangeRates')}</p>
                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                        {data.exchange_rates.slice(0, 4).map((rate: any, i: number) => (
                                            <div key={i} className="flex justify-between bg-white px-2 py-1 rounded-full border border-gray-100 shadow-sm">
                                                <span className="text-[10px] font-bold text-slate-400">
                                                    {rate.priceBasisAmount || 100} {rate.pair.split('/')[0]}
                                                </span>
                                                <span className="font-mono font-black text-main">
                                                    {rate.rate} {rate.pair.split('/')[1]}
                                                </span>
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
                                        className="w-full h-auto object-contain block ring-1 ring-transparent group-hover:ring-main transition-shadow"
                                        style={{ maxHeight: '1000mm' }}
                                    />
                                    
                                    {onDataChange && (
                                        <>
                                            {/* Rotation Handle */}
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
                                                <RotateCw className="w-3 h-3 text-main" />
                                            </div>

                                            {/* Resize Handle */}
                                            <div 
                                                className="absolute -bottom-2 -right-2 w-5 h-5 bg-white border border-slate-200 rounded shadow-sm flex items-center justify-center cursor-nwse-resize opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
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
                                                <Scaling className="w-3 h-3 text-main" />
                                            </div>

                                            {/* Delete Handle */}
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

                        {/* Attached Texts */}
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
                                    className="w-full bg-transparent border-none outline-none resize-none p-1 block ring-1 ring-transparent group-hover:ring-main transition-shadow text-inherit font-bold overflow-hidden"
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
                                        {/* Font Size Handle */}
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
                                        {/* Move Handle */}
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
                                        {/* Rotation Handle */}
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
                                            <RotateCw className="w-3 h-3 text-main" />
                                        </div>

                                        {/* Resize (Width) Handle */}
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
                                            <Scaling className="w-3 h-3 text-main" />
                                        </div>

                                        {/* Delete Handle */}
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

                    {/* Annotations Layer */}
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

                    {hasFooterContacts && (
                        <div dir="ltr" className="mt-4 pt-4 border-t border-slate-200 shrink-0">
                            <div className="modern-footer-row text-[11px] text-slate-500">
                                {footerContactGroups.map((group, groupIndex) => (
                                    <div key={group.key} className="modern-footer-group">
                                        <span className="modern-footer-icon text-main">
                                            <group.icon className="block w-3.5 h-3.5 text-main shrink-0" />
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

                    {/* Site Footer */}
                    <div className="mt-4 border-t border-gray-200 pt-3 text-center text-xs text-neutral-500">
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
