import { forwardRef, useState, type ReactNode } from 'react'
import { ReactQRCode } from '@lglab/react-qr-code'
import { MapPin, Phone } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { CustomTemplateBackground, CustomTemplateComponentPosition } from '@/lib/printPreviewEditorStore'
import { resolveIsolatedTextDirection } from '@/lib/textDirection'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import type { UniversalInvoice, UniversalInvoiceItem } from '@/types'
import { EditableField } from '@/ui/components/EditableField'
import { MovableOrderPrintBlock } from '@/ui/components/MovableComponentPrint'
import { HideablePrintFieldCard } from '@/ui/components/print/HideablePrintFieldCard'
import { AttachedShapesOverlay } from '@/ui/components/AttachedShapesOverlay'
import { ProductPrintImage, type ProductPrintImageUrls } from '@/ui/components/print/ProductPrintImage'

export const PROFESSIONAL_A4_TABLE_ROW_COUNT = 10

export const PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS = {
    logo: 'logo',
    qrCode: 'qrCode',
    workspaceName: 'workspaceName',
    title: 'title',
    subtitle: 'subtitle',
    customer: 'customer',
    saleSummary: 'saleSummary',
    created: 'created',
    payment: 'payment',
    itemsTable: 'itemsTable',
    totals: 'totals',
    terms: 'terms',
    exchangeRates: 'exchangeRates',
    contacts: 'contacts',
    generatedBy: 'generatedBy',
    notes: 'notes'
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

interface ProfessionalA4InvoiceTemplateProps {
    data: UniversalInvoice
    features: any
    workspaceId?: string
    workspaceName?: string
    workspaceFooterContacts?: WorkspaceFooterContacts
    onDataChange?: (data: UniversalInvoice) => void
    drawingMode?: string
    hideUnit?: boolean
    hideDiscount?: boolean
    showProductImages?: boolean
    productImageSizeMm?: number
    productImageUrls?: ProductPrintImageUrls
    showNotes?: boolean
    tableRowCount?: number
    componentPositions?: Record<string, CustomTemplateComponentPosition>
    hiddenFields?: Record<string, boolean>
    editableComponents?: boolean
    onComponentPositionChange?: (key: string, position: CustomTemplateComponentPosition) => void
    onHiddenFieldChange?: (key: string, hidden: boolean) => void
    background?: CustomTemplateBackground | null
}

function isRTL(lang: string): boolean {
    const baseLang = (lang || 'en').split('-')[0]
    return baseLang === 'ar' || baseLang === 'ku'
}

function resolveLogoSrc(logoUrl?: string | null) {
    if (!logoUrl) return null
    return logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl)
}

function resolvePaymentLabel(t: (key: string, options?: Record<string, unknown>) => string, method?: string | null) {
    switch (method) {
        case 'cash': return t('pos.cash', { defaultValue: 'Cash' })
        case 'fib': return 'FIB'
        case 'qicard': return 'Qi Card'
        case 'zaincash': return 'Zain Cash'
        case 'fastpay': return 'FastPay'
        case 'bank_transfer': return t('payments.bankTransfer', { defaultValue: 'Bank Transfer' })
        case 'loan': return t('nav.loans', { defaultValue: 'Loans' })
        case 'installments': return t('nav.installments', { defaultValue: 'Installments' })
        default: return method || '-'
    }
}

function safeNumber(value: unknown, fallback = 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

function clampProductImageSizeMm(value?: number) {
    const numericValue = Number(value)
    if (!Number.isFinite(numericValue)) return 5
    return Math.min(16, Math.max(5, numericValue))
}

function buildTwentyItemRows(items: UniversalInvoiceItem[], rowCount: number) {
    const overflowItems = items.slice(rowCount - 1)
    return Array.from({ length: rowCount }, (_, index) => {
        if (index < rowCount - 1) return items[index] || null
        if (items.length <= rowCount) return items[index] || null
        const overflowTotal = overflowItems.reduce((sum, item) => sum + safeNumber(item.total_price), 0)
        return {
            product_id: 'additional-items',
            product_name: `Additional ${overflowItems.length} item${overflowItems.length === 1 ? '' : 's'}`,
            quantity: overflowItems.reduce((sum, item) => sum + safeNumber(item.quantity), 0),
            unit_price: 0,
            total_price: overflowTotal,
            settlement_currency: overflowItems[0]?.settlement_currency,
            original_currency: overflowItems[0]?.original_currency,
            original_unit_price: 0,
            discount_amount: overflowItems.reduce((sum, item) => sum + safeNumber(item.discount_amount), 0)
        } satisfies UniversalInvoiceItem
    })
}

export const ProfessionalA4InvoiceTemplate = forwardRef<HTMLDivElement, ProfessionalA4InvoiceTemplateProps>(
    ({
        data,
        features,
        workspaceId: propWorkspaceId,
        workspaceName,
        workspaceFooterContacts,
        onDataChange,
        drawingMode,
        hideUnit,
        hideDiscount,
        showProductImages = false,
        productImageSizeMm,
        productImageUrls,
        showNotes,
        tableRowCount,
        componentPositions,
        hiddenFields,
        editableComponents,
        onComponentPositionChange,
        onHiddenFieldChange,
        background
    }, ref) => {
        const { i18n } = useTranslation()
        const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
        const t = i18n.getFixedT(printLang)
        const isRtl = isRTL(printLang)
        const items = data.items || []
        const imageSizeMm = clampProductImageSizeMm(productImageSizeMm)
        const imageColumnWidthMm = imageSizeMm + 1.5
        const itemRowHeightMm = Math.max(5.8, imageSizeMm + 1)
        const rowCount = tableRowCount || Math.max(1, items.length)
        const itemRows = buildTwentyItemRows(items, rowCount)
        const effectiveWorkspaceId = propWorkspaceId || data.workspaceId
        const logoSrc = resolveLogoSrc(features?.logo_url)
        const backgroundSrc = resolveLogoSrc(background?.path)
        const settlementCurrency = (data.settlement_currency || 'usd').toLowerCase()
        const iqdPreference = features?.iqd_display_preference
        const subtotalAmount = safeNumber(data.subtotal_amount, safeNumber(data.total_amount))
        const discountAmount = safeNumber(data.discount_amount)
        const taxAmount = safeNumber(data.tax_amount)
        const totalAmount = safeNumber(data.total_amount)
        const invoiceNumber = data.invoiceid || `#${String(data.id).slice(0, 8)}`
        const effectiveHiddenFields = hiddenFields || data.hiddenPrintFields || {}
        const qrValue = features?.print_qr && effectiveWorkspaceId && (data.sequenceId || data.invoiceid)
            ? `https://asaas-r2-proxy.alanepic360.workers.dev/${effectiveWorkspaceId}/printed-invoices/A4/${data.id}.pdf`
            : null

        const footerContactGroups = [
            {
                key: 'address',
                primary: workspaceFooterContacts?.address?.primary?.trim() || '',
                nonPrimary: workspaceFooterContacts?.address?.nonPrimary?.trim() || '',
                icon: MapPin
            },
            {
                key: 'phone',
                primary: workspaceFooterContacts?.phone?.primary?.trim() || '',
                nonPrimary: workspaceFooterContacts?.phone?.nonPrimary?.trim() || '',
                icon: Phone
            }
        ].map((group) => {
            const entries: Array<{ value: string }> = []
            if (group.primary) entries.push({ value: group.primary })
            if (group.nonPrimary) entries.push({ value: group.nonPrimary })
            return { ...group, entries }
        }).filter((group) => group.entries.length > 0)

        const noteText = data.notes?.trim()
        const [notesFontSize, setNotesFontSize] = useState(0)

        const mp = (
            key: string,
            label: string,
            children: ReactNode,
            wrapperClassName?: string,
            options?: { resizable?: boolean; fontSizeEditable?: boolean; defaultFontSize?: number }
        ) => (
            <MovableOrderPrintBlock
                componentKey={key}
                label={label}
                position={componentPositions?.[key]}
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
                dir={isRtl ? 'rtl' : 'ltr'}
                className="professional-a4-template relative bg-white text-black"
                style={{ width: '210mm', minHeight: '297mm', padding: '14mm 12mm', margin: '0 auto', position: 'relative', isolation: 'isolate' }}
                data-order-print-page=""
                data-page-width-mm="210"
            >
                <style
                    dangerouslySetInnerHTML={{
                        __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; padding: 0; }
    .order-template-move-handle { display: none !important; }
}
.professional-a4-template {
    color-scheme: light !important;
    background: #ffffff !important;
    color: #020617 !important;
}
`
                    }}
                />

                {backgroundSrc && background ? (
                    <img
                        src={backgroundSrc}
                        alt=""
                        aria-hidden="true"
                        className="pointer-events-none absolute -z-10 object-contain"
                        data-atlas-standard-background=""
                        style={{
                            left: '50%',
                            top: '50%',
                            transform: 'translate(-50%, -50%)',
                            width: `${Math.min(100, Math.max(10, background.size || 100))}%`,
                            height: 'auto',
                            opacity: Math.min(1, Math.max(0.01, (background.opacity ?? 15) / 100))
                        }}
                    />
                ) : null}

                <div className="mb-4 border-b border-slate-300 pb-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="w-1/3 flex flex-col items-start">
                            {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.logo, 'Logo', (
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
                            ), undefined, { resizable: true })}
                        </div>

                        <div className="w-1/3 flex justify-center pt-1">
                            {qrValue ? mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.qrCode, 'QR Code', (
                                <div className="p-1.5 bg-white border border-slate-200 rounded" data-qr-sharp="true">
                                    <ReactQRCode value={qrValue} size={64} level="M" />
                                </div>
                            )) : null}
                        </div>

                        <div className="w-1/3 flex flex-col items-center text-center">
                            {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.workspaceName, 'Workspace Name', (
                                <h1 className="text-xl font-bold">{workspaceName || 'Atlas'}</h1>
                            ), undefined, { fontSizeEditable: true, defaultFontSize: 20 })}
                            {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.title, 'Title', (
                                <p className="text-sm font-semibold">{t('sales.print.a4', { defaultValue: 'A4 Invoice' })}</p>
                            ))}
                            {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.subtitle, 'Subtitle', (
                                <p className="text-[11px] text-slate-600">
                                    <span className="font-semibold">{invoiceNumber}</span>
                                    <span className="px-1">|</span>
                                    <span>{formatDateTime(data.created_at)}</span>
                                </p>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-2 items-start gap-4 mb-4 text-xs text-center">
                    {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.customer, 'Customer', (
                        <div className="border border-slate-300 rounded-md p-3">
                            <h2 className="font-semibold mb-2">{t('invoice.soldTo', { defaultValue: 'Sold To' })}</h2>
                            <EditableField
                                value={data.customer_address || data.customer_name || ''}
                                onChange={(value) => onDataChange?.({ ...data, customer_address: value })}
                                type="textarea"
                                placeholder={t('invoice.enterCustomerDetails', { defaultValue: 'Enter customer details...' })}
                                className="font-bold text-sm w-full"
                                editable={!!onDataChange}
                                display={(value) => value ? (
                                    <div className="whitespace-pre-wrap">{value}</div>
                                ) : (
                                    <div className="text-slate-400">-</div>
                                )}
                            />
                        </div>
                    ))}
                    {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.saleSummary, 'Sale Summary', (
                        <HideablePrintFieldCard
                            title={t('orders.details.commercials', { defaultValue: 'Commercials' })}
                            className="border border-slate-300 rounded-md p-3"
                            hiddenFields={effectiveHiddenFields}
                            onHiddenFieldChange={onHiddenFieldChange}
                            fields={[
                                {
                                    key: 'professional.saleSummary.invoiceNumber',
                                    label: t('invoice.number', { defaultValue: 'Invoice #' }),
                                    value: <span className="font-bold">{invoiceNumber}</span>
                                },
                                {
                                    key: 'professional.saleSummary.soldBy',
                                    label: t('invoice.soldBy', { defaultValue: 'Sold By' }),
                                    value: <span className="font-bold">{data.cashier_name || '-'}</span>
                                },
                                {
                                    key: 'professional.saleSummary.status',
                                    label: t('common.status', { defaultValue: 'Status' }),
                                    value: <span className="font-bold">{data.status || 'paid'}</span>
                                },
                                {
                                    key: 'professional.saleSummary.total',
                                    label: t('common.total', { defaultValue: 'Total' }),
                                    value: <span className="font-bold">{formatCurrency(totalAmount, settlementCurrency, iqdPreference)}</span>
                                }
                            ]}
                        />
                    ))}
                </div>

                <div className="grid grid-cols-2 items-start gap-3 mb-4 text-xs">
                    {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.created, 'Created', (
                        <HideablePrintFieldCard
                            title={t('orders.details.created', { defaultValue: 'Created' })}
                            className="border border-slate-300 rounded-md p-2"
                            titleClassName="text-slate-500 text-center font-normal mb-0"
                            hiddenFields={effectiveHiddenFields}
                            onHiddenFieldChange={onHiddenFieldChange}
                            fields={[
                                {
                                    key: 'professional.created.createdAt',
                                    label: t('orders.details.created', { defaultValue: 'Created' }),
                                    value: formatDateTime(data.created_at),
                                    render: <p className="font-bold text-center">{formatDateTime(data.created_at)}</p>
                                }
                            ]}
                        />
                    ))}
                    {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.payment, 'Payment', (
                        <HideablePrintFieldCard
                            title={t('pos.paymentMethod', { defaultValue: 'Payment' })}
                            className="border border-slate-300 rounded-md p-2"
                            titleClassName="text-slate-500 text-center font-normal mb-0"
                            hiddenFields={effectiveHiddenFields}
                            onHiddenFieldChange={onHiddenFieldChange}
                            fields={[
                                {
                                    key: 'professional.payment.method',
                                    label: t('pos.paymentMethod', { defaultValue: 'Payment' }),
                                    value: resolvePaymentLabel(t, data.payment_method),
                                    render: <p className="font-bold text-center">{resolvePaymentLabel(t, data.payment_method)}</p>
                                }
                            ]}
                        />
                    ))}
                </div>

                {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.itemsTable, 'Items Table', (
                    <>
                        <h3 className="font-semibold mb-2 text-sm">{t('orders.details.orderItems', { defaultValue: 'Order Items' })}</h3>
                        <table className="w-full border-collapse text-[10px] mb-5">
                            <thead>
                                <tr className="bg-slate-100">
                                    {showProductImages ? (
                                        <th className="border border-slate-300 p-1 text-center" style={{ width: `${imageColumnWidthMm}mm` }}>
                                            {t('products.table.image', { defaultValue: 'Image' })}
                                        </th>
                                    ) : null}
                                    <th className="border border-slate-300 p-1.5 text-center w-8">#</th>
                                    <th className="border border-slate-300 p-1.5 text-start">{t('products.title', { defaultValue: 'Product' })}</th>
                                    <th className="border border-slate-300 p-1.5 text-start w-20">SKU</th>
                                    <th className="border border-slate-300 p-1.5 text-end w-16">{t('orders.form.table.qty', { defaultValue: 'Qty' })}</th>
                                    <th className="border border-slate-300 p-1.5 text-end w-24">{t('orders.form.table.price', { defaultValue: 'Unit Price' })}</th>
                                    {!hideDiscount && (
                                        <th className="border border-slate-300 p-1.5 text-end w-20">{t('invoice.discount', { defaultValue: 'Discount' })}</th>
                                    )}
                                    <th className="border border-slate-300 p-1.5 text-end w-24">{t('common.total', { defaultValue: 'Total' })}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {itemRows.map((item, index) => {
                                    const quantity = item ? safeNumber(item.quantity) : 0
                                    const unitPrice = item ? safeNumber(item.unit_price) : 0
                                    const discount = item ? safeNumber(item.discount_amount) : 0
                                    const priceToShow = item?.product_id === 'additional-items'
                                        ? null
                                        : unitPrice + (quantity > 0 ? discount / quantity : 0)

                                    return (
                                        <tr
                                            key={`${item?.product_id || 'empty'}-${index}`}
                                            className={cn(!showProductImages && 'h-[5.8mm]')}
                                            style={showProductImages ? { height: `${itemRowHeightMm}mm` } : undefined}
                                            data-professional-item-row=""
                                        >
                                            {showProductImages ? (
                                                <td className="border border-slate-300 p-[0.5mm] text-center align-middle">
                                                    {item ? (
                                                        <ProductPrintImage
                                                            imageUrl={productImageUrls?.[item.product_id]}
                                                            productName={item.product_name}
                                                            sizeMm={imageSizeMm}
                                                        />
                                                    ) : '\u00A0'}
                                                </td>
                                            ) : null}
                                            <td className="border border-slate-300 p-1 text-center text-slate-500">{index + 1}</td>
                                            <td className="border border-slate-300 p-1 font-medium">
                                                {item?.product_name || '\u00A0'}
                                            </td>
                                            <td className="border border-slate-300 p-1 text-slate-600">{item?.product_sku || '\u00A0'}</td>
                                            <td className="border border-slate-300 p-1 text-end">
                                                {item ? `${quantity || ''}${(!hideUnit && item.unit) ? ` ${t(`products.units.${item.unit}`, item.unit)}` : ''}` : '\u00A0'}
                                            </td>
                                            <td className="border border-slate-300 p-1 text-end">
                                                {item && priceToShow !== null ? formatCurrency(priceToShow, settlementCurrency, iqdPreference) : '\u00A0'}
                                            </td>
                                            {!hideDiscount && (
                                                <td className="border border-slate-300 p-1 text-end text-slate-500">
                                                    {item && discount > 0 ? formatCurrency(discount, settlementCurrency, iqdPreference) : '\u00A0'}
                                                </td>
                                            )}
                                            <td className="border border-slate-300 p-1 text-end font-semibold">
                                                {item ? formatCurrency(safeNumber(item.total_price), settlementCurrency, iqdPreference) : '\u00A0'}
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </>
                ))}

                <div className="grid grid-cols-2 gap-6 mb-5">
                    <div className="text-xs space-y-4">
                        {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.terms, 'Terms & Conditions', (
                            <div>
                                <div className="font-semibold text-slate-600">{t('invoice.terms', { defaultValue: 'Terms & Conditions' })}:</div>
                                <EditableField
                                    value={data.terms || ''}
                                    onChange={(value) => onDataChange?.({ ...data, terms: value })}
                                    type="textarea"
                                    placeholder={t('invoice.enterTerms', { defaultValue: 'Enter terms and conditions...' })}
                                    className="mt-2 w-full text-[11px] text-slate-800"
                                    editable={!!onDataChange}
                                    display={(value) => value ? (
                                        <div className="whitespace-pre-wrap">{value}</div>
                                    ) : (
                                        <div className="min-h-12 rounded border border-dashed border-slate-300" />
                                    )}
                                />
                            </div>
                        ))}

                        {showNotes && noteText ? mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.notes, 'Notes', (
                            <div>
                                <div className="font-semibold text-slate-600">{t('orders.details.notes', { defaultValue: 'Notes' })}:</div>
                                <div className={`mt-2 whitespace-pre-wrap break-words text-slate-800 ${['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl'][notesFontSize] || 'text-xs'}`}>
                                    {noteText}
                                </div>
                                {editableComponents ? (
                                    <div className="flex items-center gap-1 mt-1">
                                        <button
                                            type="button"
                                            className="inline-flex h-5 w-5 items-center justify-center rounded border border-slate-300 bg-white text-[10px] font-bold text-slate-600 hover:bg-slate-100"
                                            onClick={() => setNotesFontSize(s => Math.max(0, s - 1))}
                                            disabled={notesFontSize <= 0}
                                            aria-label="Decrease notes font size"
                                        >
                                            -
                                        </button>
                                        <span className="text-[9px] text-slate-400 w-8 text-center">{['xs', 'sm', 'base', 'lg', 'xl'][notesFontSize] || 'xs'}</span>
                                        <button
                                            type="button"
                                            className="inline-flex h-5 w-5 items-center justify-center rounded border border-slate-300 bg-white text-[10px] font-bold text-slate-600 hover:bg-slate-100"
                                            onClick={() => setNotesFontSize(s => Math.min(4, s + 1))}
                                            disabled={notesFontSize >= 4}
                                            aria-label="Increase notes font size"
                                        >
                                            +
                                        </button>
                                    </div>
                                ) : null}
                            </div>
                        )) : null}

                        {data.exchange_rates && data.exchange_rates.length > 0 ? mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.exchangeRates, 'Exchange Rates', (
                            <div>
                                <div className="font-semibold text-slate-600">{t('invoice.exchangeRates', { defaultValue: 'Exchange Rates' })}:</div>
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                    {data.exchange_rates.slice(0, 4).map((rate: any, index: number) => (
                                        <div key={index} className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[10px]">
                                            {rate.priceBasisAmount || 100} {String(rate.pair || '').split('/')[0]} = {rate.rate} {String(rate.pair || '').split('/')[1]}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )) : null}
                    </div>

                    {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.totals, 'Totals', (
                        <div className="flex justify-end">
                            <div className="w-64 text-xs space-y-1">
                                <div className="flex justify-between">
                                    <span className="text-slate-600">{t('orders.details.subtotal', { defaultValue: 'Subtotal' })}</span>
                                    <span className="font-semibold">{formatCurrency(subtotalAmount, settlementCurrency, iqdPreference)}</span>
                                </div>
                                {!hideDiscount && discountAmount > 0 ? (
                                    <div className="flex justify-between">
                                        <span className="text-slate-600">{t('orders.details.discount', { defaultValue: 'Discount' })}</span>
                                        <span className="font-semibold">{formatCurrency(discountAmount, settlementCurrency, iqdPreference)}</span>
                                    </div>
                                ) : null}
                                {taxAmount > 0 ? (
                                    <div className="flex justify-between">
                                        <span className="text-slate-600">{t('orders.details.tax', { defaultValue: 'Tax' })}</span>
                                        <span className="font-semibold">{formatCurrency(taxAmount, settlementCurrency, iqdPreference)}</span>
                                    </div>
                                ) : null}
                                <div className="flex justify-between border-t border-slate-300 pt-1 mt-1">
                                    <span className="font-bold">{t('common.total', { defaultValue: 'Total' })}</span>
                                    <span className="font-bold">{formatCurrency(totalAmount, settlementCurrency, iqdPreference)}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.contacts, 'Contacts', (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-300 pt-3 text-[11px] text-slate-500">
                        {footerContactGroups.map((group, groupIndex, arr) => (
                            <div key={group.key} className="inline-flex items-center gap-1">
                                <group.icon className="w-3.5 h-3.5 shrink-0" />
                                {group.entries.map((entry, entryIndex) => (
                                    <span key={entryIndex}>
                                        {entryIndex > 0 && <span className="mx-0.5 select-none">|</span>}
                                        <span>{entry.value}</span>
                                    </span>
                                ))}
                                {groupIndex < arr.length - 1 && (
                                    <span className="mx-1 text-slate-300 select-none">|</span>
                                )}
                            </div>
                        ))}
                    </div>
                ))}

                {mp(PROFESSIONAL_A4_MOVABLE_COMPONENT_KEYS.generatedBy, 'Generated By', (
                    <div className="mt-3 text-center text-[10px] text-slate-500">
                        {(data.origin === 'pos' ? t('invoice.posSystem', { defaultValue: 'POS System' }) : 'Atlas')}
                        <span className="px-2 text-slate-300">|</span>
                        {t('invoice.generated', { defaultValue: 'Generated' })}
                    </div>
                ))}

                <AttachedShapesOverlay
                    shapes={data.attached_shapes}
                    onShapesChange={onDataChange ? (attached_shapes) => onDataChange({ ...data, attached_shapes }) : undefined}
                />

                <svg
                    className="absolute inset-0 z-[40] pointer-events-none"
                    viewBox="0 0 210 297"
                >
                    {(data.annotations || []).map((annotation, index) => (
                        <path
                            key={index}
                            d={`M ${annotation.points.map((point) => `${point.x},${point.y}`).join(' L ')}`}
                            stroke={annotation.color}
                            strokeWidth={annotation.brushSize}
                            fill="none"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={cn(drawingMode === 'eraser' && 'cursor-pointer hover:stroke-destructive transition-colors')}
                            style={{ pointerEvents: drawingMode === 'eraser' ? 'all' : 'none' }}
                            onPointerDown={(event) => {
                                if (drawingMode === 'eraser' && onDataChange) {
                                    event.stopPropagation()
                                    const nextAnnotations = (data.annotations || []).filter((_, itemIndex) => itemIndex !== index)
                                    onDataChange({ ...data, annotations: nextAnnotations })
                                }
                            }}
                        />
                    ))}
                </svg>

                {(data.attached_texts || []).map((text, index) => (
                    <div
                        key={text.id || index}
                        dir={resolveIsolatedTextDirection(text.text)}
                        className="absolute whitespace-pre-wrap break-words font-bold leading-snug"
                        style={{
                            left: `${text.x}mm`,
                            top: `${text.y}mm`,
                            width: `${text.width}mm`,
                            transform: `rotate(${text.rotation || 0}deg)`,
                            transformOrigin: 'top left',
                            zIndex: 100 + index,
                            fontSize: `${text.fontSize || 16}px`,
                            color: text.color || '#000000'
                        }}
                    >
                        {text.text}
                    </div>
                ))}
            </div>
        )
    }
)

ProfessionalA4InvoiceTemplate.displayName = 'ProfessionalA4InvoiceTemplate'
