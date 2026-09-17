import { forwardRef } from 'react'
import { UniversalInvoice, UniversalInvoiceItem } from '@/types'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import { localizeReturnReason } from '@/lib/returnReasons'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'
import { Mail, MapPin, Phone, X, RotateCw, Scaling, Move } from 'lucide-react'
import { resolveIsolatedTextDirection } from '@/lib/textDirection'
import { AttachedShapesOverlay } from '@/ui/components/AttachedShapesOverlay'

interface WorkspaceContactPair {
    primary?: string
    nonPrimary?: string
}

interface WorkspaceFooterContacts {
    address?: WorkspaceContactPair
    email?: WorkspaceContactPair
    phone?: WorkspaceContactPair
}

interface RefundPrimaryA4InvoiceTemplateProps {
    data: UniversalInvoice
    features: any
    workspaceId?: string
    workspaceName?: string
    workspaceFooterContacts?: WorkspaceFooterContacts
    onDataChange?: (data: UniversalInvoice) => void
    drawingMode?: string
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
    ({ data, features, workspaceId: propWorkspaceId, workspaceName, workspaceFooterContacts, onDataChange, drawingMode }, ref) => {
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
                className="a4-container bg-white text-black text-sm relative flex flex-col min-h-[297mm] text-start"
                style={{ width: '210mm', padding: '0', margin: '0 auto' }}
            >
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
                                                if (!onDataChange) return
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
                                                        if (!onDataChange) return
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
                                                        if (!onDataChange) return
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
                                            {/* Move Handle */}
                                            <div 
                                                className="absolute -bottom-7 left-1/2 -translate-x-1/2 w-6 h-6 bg-white border border-slate-200 rounded-full shadow-sm flex items-center justify-center cursor-move opacity-0 group-hover:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
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
                                                <Move className="w-3 h-3 text-main" />
                                            </div>

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
                                                className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity shadow-md hover:bg-red-600 active:scale-95"
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

                    <div className="mt-4 border-t border-gray-200 pt-3 text-center text-xs text-neutral-500">
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
