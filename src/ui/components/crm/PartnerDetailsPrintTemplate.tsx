import { useTranslation } from 'react-i18next'
import { useLayoutEffect, useRef } from 'react'

import type { BusinessPartnerRole, IQDDisplayPreference } from '@/local-db'
import { cn, formatCurrency, formatDate, formatDateTime } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import type { CustomTemplateComponentPosition } from '@/lib/printPreviewEditorStore'
import { MovableOrderPrintBlock } from '@/ui/components/MovableComponentPrint'
import { HideablePrintFieldCard } from '@/ui/components/print/HideablePrintFieldCard'

export type PartnerDetailsPrintTransactionSource =
    | 'sales_order'
    | 'purchase_order'
    | 'loan'
    | 'simple_loan'
    | 'direct_transaction'
    | 'clinical_appointment'
    | 'pos_sale_loan'
    | 'pos_sale_installment_loan'
    | 'delivery_shipment'
    | 'delivery_settlement'
    | 'delivery_recipient_payout'

export type PartnerDetailsPrintTransaction = {
    id: string
    source: PartnerDetailsPrintTransactionSource
    reference: string
    displayDate: string
    status: string
    statusLabel: string
    summary: string
    originalAmount: number
    paidAmount: number
    remainingAmount: number
    currency: string
}

export type PartnerDetailsPrintData = {
    partner: {
        partnerName: string
        role: BusinessPartnerRole
        phone?: string
        address?: string
        city?: string
        defaultCurrency: string
        createdAt: string
        notes?: string
    }
    period: {
        type: 'today' | 'month' | 'lastMonth' | 'allTime' | 'custom'
        start?: string
        end?: string
    }
    generatedAt: string
    loanSummary: {
        remainingReceivable: number
        remainingPayable: number
        paymentsReceived: number
        paymentsMade: number
    }
    metrics: {
        moneyIn: number
        moneyOut: number
    }
    relationshipSummary: {
        receivable: number
        payable: number
    }
    providedByYou: PartnerDetailsPrintTransaction[]
    providedByPartner: PartnerDetailsPrintTransaction[]
    salesOrders: PartnerDetailsPrintTransaction[]
    purchaseOrders: PartnerDetailsPrintTransaction[]
    topProducts: Array<{
        id: string
        name: string
        quantity: number
        amount: number
    }>
}

interface PartnerDetailsPrintTemplateProps {
    workspaceName?: string | null
    printLang: string
    data: PartnerDetailsPrintData
    iqdPreference?: IQDDisplayPreference
    logoUrl?: string | null
    showWhoOwesWhom?: boolean
    showOrders?: boolean
    componentPositions?: Record<string, CustomTemplateComponentPosition>
    hiddenFields?: Record<string, boolean>
    editableComponents?: boolean
    onComponentPositionChange?: (key: string, position: CustomTemplateComponentPosition) => void
    onHiddenFieldChange?: (key: string, hidden: boolean) => void
}

export const PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS = {
    logo: 'partnerDetailsLogo',
    workspaceName: 'partnerDetailsWorkspaceName',
    printType: 'partnerDetailsPrintType',
    printInfo: 'partnerDetailsPrintInfo',
    businessPartnerCard: 'partnerDetailsBusinessPartnerCard',
    financialSummary: 'partnerDetailsFinancialSummary',
    incomingCash: 'partnerDetailsIncomingCash',
    outgoingCash: 'partnerDetailsOutgoingCash',
    netFlow: 'partnerDetailsNetFlow',
    whoOwesWhom: 'partnerDetailsWhoOwesWhom',
    providedByYou: 'partnerDetailsProvidedByYou',
    providedByPartner: 'partnerDetailsProvidedByPartner',
    topProducts: 'partnerDetailsTopProducts',
    notes: 'partnerDetailsNotes',
    ordersHeader: 'partnerDetailsOrdersHeader',
    salesOrders: 'partnerDetailsSalesOrders',
    purchaseOrders: 'partnerDetailsPurchaseOrders'
} as const

const PARTNER_PAGE_BREAK_SELECTOR = [
    '[data-pdf-keep-together]',
    '[data-qr-sharp="true"]',
    'table',
    '.break-inside-avoid',
    '.page-break-inside-avoid'
].join(', ')
const PARTNER_PAGE_HEIGHT_MM = 297
const PARTNER_PAGE_BREAK_EPSILON_MM = 0.05
const PARTNER_PAGE_BREAK_MARGIN = 'partnerPageBreakMargin'
const PARTNER_PAGE_BREAK_ORIGINAL_MARGIN = 'partnerPageBreakOriginalMargin'

function resetPartnerPageBreakMargins(root: HTMLElement) {
    root.querySelectorAll<HTMLElement>('[data-partner-page-break-margin]').forEach((element) => {
        element.style.marginTop = element.dataset[PARTNER_PAGE_BREAK_ORIGINAL_MARGIN] || ''
        delete element.dataset[PARTNER_PAGE_BREAK_MARGIN]
        delete element.dataset[PARTNER_PAGE_BREAK_ORIGINAL_MARGIN]
    })
}

function getPartnerPageBreakAnchor(block: HTMLElement, root: HTMLElement, millimetersPerPixel: number) {
    const movableComponent = block.closest<HTMLElement>('[data-order-print-component]')
    if (!movableComponent || !root.contains(movableComponent)) return block

    const parent = movableComponent.parentElement
    if (!parent || parent === root) return movableComponent

    const display = window.getComputedStyle(parent).display
    if (!display.includes('grid') && !display.includes('flex')) return movableComponent

    const rootTop = root.getBoundingClientRect().top
    const parentTopMm = (parent.getBoundingClientRect().top - rootTop) * millimetersPerPixel
    const componentTopMm = (movableComponent.getBoundingClientRect().top - rootTop) * millimetersPerPixel

    return Math.abs(parentTopMm - componentTopMm) < PARTNER_PAGE_BREAK_EPSILON_MM
        ? parent
        : movableComponent
}

function isRTL(lang: string) {
    const baseLang = (lang || 'en').split('-')[0]
    return baseLang === 'ar' || baseLang === 'ku'
}

function resolveLogoSrc(logoUrl?: string | null) {
    if (!logoUrl) return null
    return logoUrl.startsWith('http') ? logoUrl : platformService.convertFileSrc(logoUrl)
}

function resolveRoleLabel(role: BusinessPartnerRole, t: (key: string, options?: Record<string, unknown>) => string) {
    switch (role) {
        case 'customer':
            return t('customers.title', { defaultValue: 'Customer' })
        case 'supplier':
            return t('suppliers.title', { defaultValue: 'Supplier' })
        case 'buyer':
            return t('businessPartners.roles.buyer', { defaultValue: 'Buyer' })
        case 'seller':
            return t('businessPartners.roles.seller', { defaultValue: 'Seller' })
        case 'agent':
            return t('businessPartners.roles.agent', { defaultValue: 'Agent' })
        case 'online_customer':
            return t('businessPartners.roles.onlineCustomer', { defaultValue: 'Online Customer' })
        default:
            return t('businessPartners.roles.both', { defaultValue: 'Both' })
    }
}

function resolveSourceLabel(
    source: PartnerDetailsPrintTransactionSource,
    t: (key: string, options?: Record<string, unknown>) => string
) {
    switch (source) {
        case 'sales_order':
            return t('orders.tabs.sales', { defaultValue: 'Sales Order' })
        case 'purchase_order':
            return t('orders.tabs.purchase', { defaultValue: 'Purchase Order' })
        case 'simple_loan':
            return t('loans.simpleTab', { defaultValue: 'Loans' })
        case 'direct_transaction':
            return t('ledger.type.direct_transaction', { defaultValue: 'Direct Transaction' })
        case 'clinical_appointment':
            return t('clinicalAppointments.title', { defaultValue: 'Appointment' })
        case 'pos_sale_loan':
            return t('loans.posSaleLoan', { defaultValue: 'POS Sale Loan' })
        case 'pos_sale_installment_loan':
            return t('loans.posSaleInstallmentLoan', { defaultValue: 'POS Sale Installment Loan' })
        case 'delivery_shipment':
            return t('postService.title', { defaultValue: 'Post Service' })
        case 'delivery_settlement':
            return t('businessPartners.sources.settlement', { defaultValue: 'Settlement' })
        case 'delivery_recipient_payout':
            return t('ledger.type.deliveryRecipientPayout', { defaultValue: 'Recipient Payout' })
        default:
            return t('loans.installmentRepayment', { defaultValue: 'Installment Repayment' })
    }
}

function resolvePeriodLabel(
    period: PartnerDetailsPrintData['period'],
    t: (key: string, options?: Record<string, unknown>) => string
) {
    if (period.start || period.end) {
        const start = period.start ? formatDate(period.start) : '-'
        const end = period.end ? formatDate(period.end) : '-'
        return t('businessPartners.fromDateToDate', {
            defaultValue: 'from {{start}} to {{end}}',
            start,
            end
        })
    }
    return t('performance.filters.allTime', { defaultValue: 'All Time' })
}

function ContactLine({ label, value }: { label: string; value?: string }) {
    return (
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 py-1.5 last:border-0">
            <span className="text-slate-500">{label}</span>
            <span className="max-w-[65%] text-end font-medium">{value?.trim() || '-'}</span>
        </div>
    )
}

function MetricBox({ label, value, isRtl }: { label: string; value: string; isRtl: boolean }) {
    return (
        <div className="rounded-md border border-slate-300 p-2 text-center">
            <div className={cn('text-[10px] text-slate-500', !isRtl && 'uppercase tracking-wide')}>{label}</div>
            <div className="mt-1 text-xs font-bold">{value}</div>
        </div>
    )
}

function ActivityTable({
    title,
    rows,
    t,
    iqdPreference
}: {
    title: string
    rows: PartnerDetailsPrintTransaction[]
    t: (key: string, options?: Record<string, unknown>) => string
    iqdPreference: IQDDisplayPreference
}) {
    return (
        <div className="mb-4 break-inside-avoid" data-pdf-keep-together>
            <h2 className="mb-2 text-sm font-semibold">{title}</h2>
            <table className="w-full border-collapse text-[9px]">
                <thead>
                    <tr className="bg-slate-100">
                        <th className="border border-slate-300 p-1 text-start">{t('common.date', { defaultValue: 'Date' })}</th>
                        <th className="border border-slate-300 p-1 text-start">{t('common.type', { defaultValue: 'Type' })}</th>
                        <th className="border border-slate-300 p-1 text-start">{t('common.reference', { defaultValue: 'Reference' })}</th>
                        <th className="border border-slate-300 p-1 text-start">{t('common.details', { defaultValue: 'Details' })}</th>
                        <th className="border border-slate-300 p-1 text-end">{t('common.amount', { defaultValue: 'Amount' })}</th>
                        <th className="border border-slate-300 p-1 text-end">{t('common.paid', { defaultValue: 'Paid' })}</th>
                        <th className="border border-slate-300 p-1 text-end">{t('common.remaining', { defaultValue: 'Remaining' })}</th>
                        <th className="border border-slate-300 p-1 text-start">{t('common.status', { defaultValue: 'Status' })}</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 ? (
                        <tr>
                            <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={8}>
                                {t('businessPartners.noActivity', { defaultValue: 'No related activity yet.' })}
                            </td>
                        </tr>
                    ) : rows.map((transaction) => (
                        <tr key={transaction.id} data-pdf-keep-together>
                            <td className="border border-slate-300 p-1">{formatDate(transaction.displayDate)}</td>
                            <td className="border border-slate-300 p-1">{resolveSourceLabel(transaction.source, t)}</td>
                            <td className="border border-slate-300 p-1 font-semibold">{transaction.reference}</td>
                            <td className="border border-slate-300 p-1">{transaction.summary || '-'}</td>
                            <td className="border border-slate-300 p-1 text-end font-semibold">
                                {formatCurrency(transaction.originalAmount, transaction.currency, iqdPreference)}
                            </td>
                            <td className="border border-slate-300 p-1 text-end font-semibold">
                                {formatCurrency(transaction.paidAmount, transaction.currency, iqdPreference)}
                            </td>
                            <td className="border border-slate-300 p-1 text-end font-semibold">
                                {transaction.remainingAmount <= 0.001
                                    ? '\u2014'
                                    : formatCurrency(transaction.remainingAmount, transaction.currency, iqdPreference)}
                            </td>
                            <td className="border border-slate-300 p-1">{transaction.statusLabel}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function OrderTable({
    title,
    rows,
    t,
    iqdPreference
}: {
    title: string
    rows: PartnerDetailsPrintTransaction[]
    t: (key: string, options?: Record<string, unknown>) => string
    iqdPreference: IQDDisplayPreference
}) {
    return (
        <div className="mb-6" data-pdf-keep-together>
            <h2 className="mb-2 text-sm font-semibold">{title}</h2>
            <table className="w-full border-collapse text-[9px]">
                <thead>
                    <tr className="bg-slate-100">
                        <th className="border border-slate-300 p-1.5 text-start">{t('common.date', { defaultValue: 'Date' })}</th>
                        <th className="border border-slate-300 p-1.5 text-start">{t('common.reference', { defaultValue: 'Reference' })}</th>
                        <th className="border border-slate-300 p-1.5 text-start">{t('common.details', { defaultValue: 'Details' })}</th>
                        <th className="border border-slate-300 p-1.5 text-end">{t('common.amount', { defaultValue: 'Amount' })}</th>
                        <th className="border border-slate-300 p-1.5 text-end">{t('common.paid', { defaultValue: 'Paid' })}</th>
                        <th className="border border-slate-300 p-1.5 text-end">{t('common.remaining', { defaultValue: 'Remaining' })}</th>
                        <th className="border border-slate-300 p-1.5 text-start">{t('common.status', { defaultValue: 'Status' })}</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 ? (
                        <tr>
                            <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={7}>
                                {t('common.noData', { defaultValue: 'No data' })}
                            </td>
                        </tr>
                    ) : rows.map((order) => (
                        <tr key={order.id} data-pdf-keep-together>
                            <td className="border border-slate-300 p-1.5">{formatDate(order.displayDate)}</td>
                            <td className="border border-slate-300 p-1.5 font-semibold">{order.reference}</td>
                            <td className="border border-slate-300 p-1.5">{order.summary || '-'}</td>
                            <td className="border border-slate-300 p-1.5 text-end font-semibold">
                                {formatCurrency(order.originalAmount, order.currency, iqdPreference)}
                            </td>
                            <td className="border border-slate-300 p-1.5 text-end font-semibold">
                                {formatCurrency(order.paidAmount, order.currency, iqdPreference)}
                            </td>
                            <td className="border border-slate-300 p-1.5 text-end font-semibold">
                                {order.remainingAmount <= 0.001
                                    ? '\u2014'
                                    : formatCurrency(order.remainingAmount, order.currency, iqdPreference)}
                            </td>
                            <td className="border border-slate-300 p-1.5">{order.statusLabel}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

export function PartnerDetailsPrintTemplate({
    workspaceName,
    printLang,
    data,
    iqdPreference = 'IQD',
    logoUrl,
    showWhoOwesWhom = true,
    showOrders = false,
    componentPositions,
    hiddenFields,
    editableComponents,
    onComponentPositionChange,
    onHiddenFieldChange
}: PartnerDetailsPrintTemplateProps) {
    const { i18n } = useTranslation()
    const t = i18n.getFixedT(printLang)
    const logoSrc = resolveLogoSrc(logoUrl)
    const location = data.partner.city || ''
    const periodLabel = resolvePeriodLabel(data.period, t)
    const partnerRelationshipName = data.partner.partnerName
    const workspaceRelationshipName = workspaceName?.trim()
        || t('businessPartners.ourBusiness', { defaultValue: 'Our business' })
    const isRtl = isRTL(printLang)
    const templateRootRef = useRef<HTMLDivElement>(null)

    useLayoutEffect(() => {
        const root = templateRootRef.current
        if (!root) return

        const reconcilePageBreaks = () => {
            resetPartnerPageBreakMargins(root)

            const rootRect = root.getBoundingClientRect()
            if (rootRect.width <= 0) return

            const millimetersPerPixel = 210 / rootRect.width
            const blocks = Array.from(root.querySelectorAll<HTMLElement>(PARTNER_PAGE_BREAK_SELECTOR))

            for (const block of blocks) {
                const blockRect = block.getBoundingClientRect()
                const blockTopMm = (blockRect.top - rootRect.top) * millimetersPerPixel
                const blockHeightMm = blockRect.height * millimetersPerPixel

                // A component taller than a page must be allowed to flow across pages.
                if (blockHeightMm <= 0 || blockHeightMm > PARTNER_PAGE_HEIGHT_MM - PARTNER_PAGE_BREAK_EPSILON_MM) {
                    continue
                }

                const pageIndex = Math.floor((blockTopMm + PARTNER_PAGE_BREAK_EPSILON_MM) / PARTNER_PAGE_HEIGHT_MM)
                const nextPageStartMm = (pageIndex + 1) * PARTNER_PAGE_HEIGHT_MM
                const blockBottomMm = blockTopMm + blockHeightMm

                if (blockBottomMm <= nextPageStartMm + PARTNER_PAGE_BREAK_EPSILON_MM) continue

                const anchor = getPartnerPageBreakAnchor(block, root, millimetersPerPixel)
                const anchorRect = anchor.getBoundingClientRect()
                const anchorTopMm = (anchorRect.top - rootRect.top) * millimetersPerPixel
                const remainingPageSpaceMm = Math.max(0, nextPageStartMm - anchorTopMm)

                // The element may already have a Tailwind margin. Preserve the computed value,
                // then add the page remainder so the entire logical component starts on the next page.
                const computedMarginTopMm = Number.parseFloat(window.getComputedStyle(anchor).marginTop)
                    * millimetersPerPixel
                const targetMarginTopMm = (Number.isFinite(computedMarginTopMm) ? computedMarginTopMm : 0)
                    + remainingPageSpaceMm

                if (!(PARTNER_PAGE_BREAK_ORIGINAL_MARGIN in anchor.dataset)) {
                    anchor.dataset[PARTNER_PAGE_BREAK_ORIGINAL_MARGIN] = anchor.style.marginTop
                }
                anchor.dataset[PARTNER_PAGE_BREAK_MARGIN] = 'true'
                anchor.style.marginTop = `${targetMarginTopMm}mm`
            }
        }

        const frameIds = new Set<number>()
        const scheduleReconcile = () => {
            const frameId = window.requestAnimationFrame(() => {
                frameIds.delete(frameId)
                reconcilePageBreaks()
            })
            frameIds.add(frameId)
        }

        reconcilePageBreaks()
        scheduleReconcile()

        const settleTimeouts = [50, 200, 500].map((delay) => window.setTimeout(scheduleReconcile, delay))
        const resizeObserver = typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(scheduleReconcile)
        resizeObserver?.observe(root)

        const images = Array.from(root.querySelectorAll('img'))
        images.forEach((image) => {
            image.addEventListener('load', scheduleReconcile)
            image.addEventListener('error', scheduleReconcile)
        })
        void document.fonts?.ready.then(scheduleReconcile)

        return () => {
            frameIds.forEach((frameId) => window.cancelAnimationFrame(frameId))
            settleTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId))
            resizeObserver?.disconnect()
            images.forEach((image) => {
                image.removeEventListener('load', scheduleReconcile)
                image.removeEventListener('error', scheduleReconcile)
            })
            resetPartnerPageBreakMargins(root)
        }
    }, [
        componentPositions,
        data,
        hiddenFields,
        logoSrc,
        printLang,
        showOrders,
        showWhoOwesWhom,
        workspaceName
    ])

    return (
        <div
            ref={templateRootRef}
            dir={isRtl ? 'rtl' : 'ltr'}
            className="bg-white text-black"
            style={{ width: '210mm' }}
            data-partner-details-print
            data-order-print-page
            data-page-width-mm="210"
        >
            <style
                dangerouslySetInnerHTML={{
                    __html: `
@media print {
    @page { margin: 0; size: A4; }
    body { -webkit-print-color-adjust: exact; margin: 0; padding: 0; }
    [data-partner-details-print] [data-pdf-keep-together],
    [data-partner-details-print] tr {
        break-inside: avoid;
        page-break-inside: avoid;
    }
    [data-partner-details-print] thead { display: table-header-group; }
}
`
                }}
            />

            <section
                className="bg-white"
                style={{ minHeight: '297mm', padding: '14mm 12mm', boxSizing: 'border-box' }}
            >
            <div className="mb-4 border-b border-slate-300 pb-3" data-pdf-keep-together>
                <div className="flex items-start justify-between gap-4">
                    <div className="w-1/3">
                        <MovableOrderPrintBlock
                            componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.logo}
                            label={t('customTemplates.movable.logo', { defaultValue: 'Workspace Logo' })}
                            position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.logo]}
                            editable={editableComponents}
                            onPositionChange={onComponentPositionChange}
                            wrapperClassName="inline-block"
                            resizable
                            maxScale={4}
                        >
                            {logoSrc ? (
                                <img
                                    src={logoSrc}
                                    alt=""
                                    className="max-h-16 max-w-[180px] object-contain object-left"
                                />
                            ) : (
                                <div className="flex h-10 w-40 items-center justify-center border border-slate-200 bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-400">
                                    Logo
                                </div>
                            )}
                        </MovableOrderPrintBlock>
                    </div>
                    <div className="flex w-2/3 flex-col items-end text-end">
                        <MovableOrderPrintBlock
                            componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.workspaceName}
                            label={t('customTemplates.movable.workspaceName', { defaultValue: 'Workspace Name' })}
                            position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.workspaceName]}
                            editable={editableComponents}
                            onPositionChange={onComponentPositionChange}
                            wrapperClassName="inline-block"
                            fontSizeEditable
                            defaultFontSize={20}
                        >
                            <h1 className="text-xl font-bold">{workspaceName || 'Atlas'}</h1>
                        </MovableOrderPrintBlock>
                        <MovableOrderPrintBlock
                            componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.printType}
                            label={t('customTemplates.movable.printType', { defaultValue: 'Print Type' })}
                            position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.printType]}
                            editable={editableComponents}
                            onPositionChange={onComponentPositionChange}
                            wrapperClassName="inline-block"
                        >
                            <div className="mt-1 text-sm font-semibold">
                                {t('businessPartners.partnerDetailsPrint', { defaultValue: 'Partner Details' })}
                            </div>
                        </MovableOrderPrintBlock>
                        <MovableOrderPrintBlock
                            componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.printInfo}
                            label={t('customTemplates.movable.printInfo', { defaultValue: 'Print Information' })}
                            position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.printInfo]}
                            editable={editableComponents}
                            onPositionChange={onComponentPositionChange}
                            wrapperClassName="inline-block"
                        >
                            <div className="mt-1 text-[10px] text-slate-500">
                                {periodLabel} | {formatDateTime(data.generatedAt)}
                            </div>
                        </MovableOrderPrintBlock>
                    </div>
                </div>
            </div>

            <div className="mb-4 grid grid-cols-2 items-start gap-4 text-xs" data-pdf-keep-together>
                <MovableOrderPrintBlock
                    componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.businessPartnerCard}
                    label={t('businessPartners.businessPartner', { defaultValue: 'Business Partner Card' })}
                    position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.businessPartnerCard]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                    <HideablePrintFieldCard
                        title={(
                            <>
                                <span className="block text-base font-bold">{data.partner.partnerName}</span>
                                <span className={cn('block text-[10px] font-semibold text-slate-500', !isRtl && 'uppercase tracking-wide')}>
                                    {resolveRoleLabel(data.partner.role, t)}
                                </span>
                            </>
                        )}
                        titleClassName="border-b border-slate-200 pb-2"
                        className="rounded-md border border-slate-300 p-3"
                        hiddenFields={hiddenFields}
                        onHiddenFieldChange={onHiddenFieldChange}
                        fields={[
                            {
                                key: 'partnerDetails.partner.phone',
                                label: t('common.phone', { defaultValue: 'Phone' }),
                                value: data.partner.phone?.trim() || '-',
                                render: <ContactLine label={t('common.phone', { defaultValue: 'Phone' })} value={data.partner.phone} />
                            },
                            {
                                key: 'partnerDetails.partner.address',
                                label: t('common.address', { defaultValue: 'Address' }),
                                value: data.partner.address?.trim() || '-',
                                render: <ContactLine label={t('common.address', { defaultValue: 'Address' })} value={data.partner.address} />
                            },
                            {
                                key: 'partnerDetails.partner.location',
                                label: t('common.location', { defaultValue: 'Location' }),
                                value: location || '-',
                                render: <ContactLine label={t('common.location', { defaultValue: 'Location' })} value={location} />
                            },
                            {
                                key: 'partnerDetails.partner.memberSince',
                                label: t('businessPartners.memberSince', { defaultValue: 'Partner Since' }),
                                value: formatDate(data.partner.createdAt),
                                render: <ContactLine label={t('businessPartners.memberSince', { defaultValue: 'Partner Since' })} value={formatDate(data.partner.createdAt)} />
                            }
                        ]}
                    />
                </MovableOrderPrintBlock>

                <MovableOrderPrintBlock
                    componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.financialSummary}
                    label={t('businessPartners.financialSummary', { defaultValue: 'Financial Summary' })}
                    position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.financialSummary]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                    <HideablePrintFieldCard
                        title={t('businessPartners.financialSummary', { defaultValue: 'Financial Summary' })}
                        titleClassName="mb-2 border-b border-slate-200 pb-2 text-sm"
                        className="rounded-md border border-slate-300 p-3"
                        hiddenFields={hiddenFields}
                        onHiddenFieldChange={onHiddenFieldChange}
                        fields={[
                            {
                                key: 'partnerDetails.financial.remainingReceivable',
                                label: t('businessPartners.remainingReceivableLoans', { defaultValue: 'Remaining Receivable Loans' }),
                                value: formatCurrency(data.loanSummary.remainingReceivable, data.partner.defaultCurrency, iqdPreference),
                                render: <ContactLine label={t('businessPartners.remainingReceivableLoans', { defaultValue: 'Remaining Receivable Loans' })} value={formatCurrency(data.loanSummary.remainingReceivable, data.partner.defaultCurrency, iqdPreference)} />
                            },
                            {
                                key: 'partnerDetails.financial.remainingPayable',
                                label: t('businessPartners.remainingPayableLoans', { defaultValue: 'Remaining Payable Loans' }),
                                value: formatCurrency(data.loanSummary.remainingPayable, data.partner.defaultCurrency, iqdPreference),
                                render: <ContactLine label={t('businessPartners.remainingPayableLoans', { defaultValue: 'Remaining Payable Loans' })} value={formatCurrency(data.loanSummary.remainingPayable, data.partner.defaultCurrency, iqdPreference)} />
                            },
                            {
                                key: 'partnerDetails.financial.paymentsReceived',
                                label: t('businessPartners.loanPaymentsReceivedInPeriod', {
                                    defaultValue: 'Loan Payment Received By Us in ({{period}})',
                                    period: periodLabel
                                }),
                                value: formatCurrency(data.loanSummary.paymentsReceived, data.partner.defaultCurrency, iqdPreference),
                                render: <ContactLine label={t('businessPartners.loanPaymentsReceivedInPeriod', { defaultValue: 'Loan Payment Received By Us in ({{period}})', period: periodLabel })} value={formatCurrency(data.loanSummary.paymentsReceived, data.partner.defaultCurrency, iqdPreference)} />
                            },
                            {
                                key: 'partnerDetails.financial.paymentsMade',
                                label: t('businessPartners.loanPaymentsMadeInPeriod', {
                                    defaultValue: 'Loan Payment Made to the Partner in ({{period}})',
                                    period: periodLabel
                                }),
                                value: formatCurrency(data.loanSummary.paymentsMade, data.partner.defaultCurrency, iqdPreference),
                                render: <ContactLine label={t('businessPartners.loanPaymentsMadeInPeriod', { defaultValue: 'Loan Payment Made to the Partner in ({{period}})', period: periodLabel })} value={formatCurrency(data.loanSummary.paymentsMade, data.partner.defaultCurrency, iqdPreference)} />
                            }
                        ]}
                    />
                </MovableOrderPrintBlock>
            </div>

            <div className="mb-4 grid grid-cols-3 items-start gap-2" data-pdf-keep-together>
                <MovableOrderPrintBlock
                    componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.incomingCash}
                    label={t('businessPartners.incomingCash', { defaultValue: 'Incoming Cash' })}
                    position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.incomingCash]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                    <MetricBox
                        label={t('businessPartners.incomingCash', { defaultValue: 'Incoming Cash' })}
                        value={formatCurrency(data.metrics.moneyIn, data.partner.defaultCurrency, iqdPreference)}
                        isRtl={isRtl}
                    />
                </MovableOrderPrintBlock>
                <MovableOrderPrintBlock
                    componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.outgoingCash}
                    label={t('businessPartners.outgoingCash', { defaultValue: 'Outgoing Cash' })}
                    position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.outgoingCash]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                    <MetricBox
                        label={t('businessPartners.outgoingCash', { defaultValue: 'Outgoing Cash' })}
                        value={formatCurrency(data.metrics.moneyOut, data.partner.defaultCurrency, iqdPreference)}
                        isRtl={isRtl}
                    />
                </MovableOrderPrintBlock>
                <MovableOrderPrintBlock
                    componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.netFlow}
                    label={t('ledger.netFlow', { defaultValue: 'Net Flow' })}
                    position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.netFlow]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                    <MetricBox
                        label={t('ledger.netFlow', { defaultValue: 'Net Flow' })}
                        value={formatCurrency(
                            data.metrics.moneyIn - data.metrics.moneyOut,
                            data.partner.defaultCurrency,
                            iqdPreference
                        )}
                        isRtl={isRtl}
                    />
                </MovableOrderPrintBlock>
            </div>

            {showWhoOwesWhom ? (
                <MovableOrderPrintBlock
                    componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.whoOwesWhom}
                    label={t('businessPartners.whoOwesWhom', { defaultValue: 'Who owes whom?' })}
                    position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.whoOwesWhom]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                    <div className="mb-4 rounded-md border border-slate-300 bg-slate-50 p-3" data-pdf-keep-together>
                        <div className={cn('mb-2 text-xs font-semibold text-slate-600', !isRtl && 'uppercase tracking-wide')}>
                            {t('businessPartners.whoOwesWhom', { defaultValue: 'Who owes whom?' })}
                        </div>
                        <div className="grid gap-2">
                            {data.relationshipSummary.receivable > 0 ? (
                                <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900">
                                    {t('businessPartners.owesAmountTo', {
                                        debtor: partnerRelationshipName,
                                        amount: formatCurrency(data.relationshipSummary.receivable, data.partner.defaultCurrency, iqdPreference),
                                        creditor: workspaceRelationshipName,
                                        defaultValue: '{{debtor}} owes {{amount}} to {{creditor}}'
                                    })}
                                </div>
                            ) : null}
                            {data.relationshipSummary.payable > 0 ? (
                                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                                    {t('businessPartners.owesAmountTo', {
                                        debtor: workspaceRelationshipName,
                                        amount: formatCurrency(data.relationshipSummary.payable, data.partner.defaultCurrency, iqdPreference),
                                        creditor: partnerRelationshipName,
                                        defaultValue: '{{debtor}} owes {{amount}} to {{creditor}}'
                                    })}
                                </div>
                            ) : null}
                            {data.relationshipSummary.receivable <= 0 && data.relationshipSummary.payable <= 0 ? (
                                <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">
                                    {t('businessPartners.noOutstandingDebtBetween', {
                                        first: partnerRelationshipName,
                                        second: workspaceRelationshipName,
                                        defaultValue: '{{first}} and {{second}} do not owe each other anything.'
                                    })}
                                </div>
                            ) : null}
                        </div>
                    </div>
                </MovableOrderPrintBlock>
            ) : null}

            <MovableOrderPrintBlock
                componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.providedByYou}
                label={t('businessPartners.providedByYou', { defaultValue: 'Provided by you' })}
                position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.providedByYou]}
                editable={editableComponents}
                onPositionChange={onComponentPositionChange}
            >
                <ActivityTable
                    title={t('businessPartners.providedByYou', { defaultValue: 'What You Provided' })}
                    rows={data.providedByYou}
                    t={t}
                    iqdPreference={iqdPreference}
                />
            </MovableOrderPrintBlock>
            <MovableOrderPrintBlock
                componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.providedByPartner}
                label={t('businessPartners.providedByPartner', { defaultValue: 'Provided by partner' })}
                position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.providedByPartner]}
                editable={editableComponents}
                onPositionChange={onComponentPositionChange}
            >
                <ActivityTable
                    title={t('businessPartners.providedByPartner', { defaultValue: 'What the Partner Provided' })}
                    rows={data.providedByPartner}
                    t={t}
                    iqdPreference={iqdPreference}
                />
            </MovableOrderPrintBlock>

            <div className="grid grid-cols-2 items-start gap-4 text-xs">
                <MovableOrderPrintBlock
                    componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.topProducts}
                    label={t('products.topProducts', { defaultValue: 'Top Products' })}
                    position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.topProducts]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                    <div data-pdf-keep-together>
                        <h2 className="mb-2 text-sm font-semibold">
                            {t('products.topProducts', { defaultValue: 'Top Products' })}
                        </h2>
                        <table className="w-full border-collapse text-[10px]">
                            <thead>
                                <tr className="bg-slate-100">
                                    <th className="border border-slate-300 p-1.5 text-start">{t('common.name', { defaultValue: 'Name' })}</th>
                                    <th className="border border-slate-300 p-1.5 text-end">{t('orders.details.units', { defaultValue: 'Units' })}</th>
                                    <th className="border border-slate-300 p-1.5 text-end">{t('common.total', { defaultValue: 'Total' })}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.topProducts.length === 0 ? (
                                    <tr>
                                        <td className="border border-slate-300 p-3 text-center text-slate-500" colSpan={3}>
                                            {t('common.noData', { defaultValue: 'No data' })}
                                        </td>
                                    </tr>
                                ) : data.topProducts.map((product) => (
                                    <tr key={product.id} data-pdf-keep-together>
                                        <td className="border border-slate-300 p-1.5">{product.name}</td>
                                        <td className="border border-slate-300 p-1.5 text-end">{product.quantity}</td>
                                        <td className="border border-slate-300 p-1.5 text-end">
                                            {formatCurrency(product.amount, data.partner.defaultCurrency, iqdPreference)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </MovableOrderPrintBlock>

                <MovableOrderPrintBlock
                    componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.notes}
                    label={t('businessPartners.notes', { defaultValue: 'Notes' })}
                    position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.notes]}
                    editable={editableComponents}
                    onPositionChange={onComponentPositionChange}
                >
                    <div data-pdf-keep-together>
                        <h2 className="mb-2 text-sm font-semibold">
                            {t('businessPartners.notes', { defaultValue: 'Notes' })}
                        </h2>
                        <div className="whitespace-pre-wrap break-words rounded-md border border-slate-300 p-3 text-[10px] text-slate-700">
                            {data.partner.notes?.trim() || '-'}
                        </div>
                    </div>
                </MovableOrderPrintBlock>
            </div>
            </section>

            {showOrders ? (
                <section
                    className="bg-white"
                    style={{
                        minHeight: '297mm',
                        padding: '14mm 12mm',
                        boxSizing: 'border-box',
                        breakBefore: 'page',
                        pageBreakBefore: 'always'
                    }}
                >
                    <MovableOrderPrintBlock
                        componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.ordersHeader}
                        label={t('businessPartners.partnerOrders', { defaultValue: 'Show the orders header' })}
                        position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.ordersHeader]}
                        editable={editableComponents}
                        onPositionChange={onComponentPositionChange}
                    >
                        <div className="mb-5 border-b border-slate-300 pb-3" data-pdf-keep-together>
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <div className="text-lg font-bold">{workspaceRelationshipName}</div>
                                    <div className="mt-1 text-xs font-semibold text-slate-600">
                                        {t('businessPartners.partnerOrders', { defaultValue: 'Partner Orders' })}
                                    </div>
                                </div>
                                <div className="text-end">
                                    <div className="text-sm font-bold">{data.partner.partnerName}</div>
                                    <div className="mt-1 text-[10px] text-slate-500">{periodLabel}</div>
                                </div>
                            </div>
                        </div>
                    </MovableOrderPrintBlock>

                    <MovableOrderPrintBlock
                        componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.salesOrders}
                        label={t('businessPartners.salesOrdersFromWorkspace', {
                            workspace: workspaceRelationshipName,
                            partner: partnerRelationshipName,
                            defaultValue: 'Sales from {{workspace}} to {{partner}}'
                        })}
                        position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.salesOrders]}
                        editable={editableComponents}
                        onPositionChange={onComponentPositionChange}
                    >
                        <OrderTable
                            title={t('businessPartners.salesOrdersFromWorkspace', {
                                workspace: workspaceRelationshipName,
                                partner: partnerRelationshipName,
                                defaultValue: 'Sales from {{workspace}} to {{partner}}'
                            })}
                            rows={data.salesOrders}
                            t={t}
                            iqdPreference={iqdPreference}
                        />
                    </MovableOrderPrintBlock>
                    <MovableOrderPrintBlock
                        componentKey={PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.purchaseOrders}
                        label={t('businessPartners.purchaseOrdersFromPartner', {
                            workspace: workspaceRelationshipName,
                            partner: partnerRelationshipName,
                            defaultValue: 'Purchases supplied by {{partner}} to {{workspace}}'
                        })}
                        position={componentPositions?.[PARTNER_DETAILS_MOVABLE_COMPONENT_KEYS.purchaseOrders]}
                        editable={editableComponents}
                        onPositionChange={onComponentPositionChange}
                    >
                        <OrderTable
                            title={t('businessPartners.purchaseOrdersFromPartner', {
                                workspace: workspaceRelationshipName,
                                partner: partnerRelationshipName,
                                defaultValue: 'Purchases supplied by {{partner}} to {{workspace}}'
                            })}
                            rows={data.purchaseOrders}
                            t={t}
                            iqdPreference={iqdPreference}
                        />
                    </MovableOrderPrintBlock>
                </section>
            ) : null}
        </div>
    )
}
