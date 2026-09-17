import { forwardRef } from 'react'
import { UniversalInvoice, UniversalInvoiceItem } from '@/types'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import { localizeReturnReason } from '@/lib/returnReasons'
import { platformService } from '@/services/platformService'
import { useTranslation } from 'react-i18next'
import { ReactQRCode } from '@lglab/react-qr-code'
import { X, RotateCw, Scaling, Move } from 'lucide-react'
import { resolveIsolatedTextDirection } from '@/lib/textDirection'
import { AttachedShapesOverlay } from '@/ui/components/AttachedShapesOverlay'

interface RefundA4InvoiceTemplateProps {
    data: UniversalInvoice
    features: any
    workspaceId?: string
    workspaceName?: string
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

export const RefundA4InvoiceTemplate = forwardRef<HTMLDivElement, RefundA4InvoiceTemplateProps>(
    ({ data, features, workspaceId: propWorkspaceId, workspaceName, onDataChange, drawingMode }, ref) => {
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
                className="a4-container bg-white text-black relative flex flex-col min-h-[297mm] text-start"
                style={{ width: '210mm', padding: '0', margin: '0 auto' }}
            >
                <style dangerouslySetInnerHTML={{
                    __html: `
.a4-container {
    color-scheme: light !important;
    background-color: white !important;
    color: black !important;
}
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
                                            <Move className="w-3 h-3 text-main" />
                                        </div>
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
                                            className="absolute -bottom-2 -right-2 w-5 h-5 bg-white border border-slate-200 rounded shadow-sm flex items-center justify-center cursor-nwse-resize opacity-0 group-hover:opacity-100 transition-opacity hover:bg-slate-50 active:bg-slate-100"
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
