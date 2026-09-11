import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { CreditCard, Eye, Printer, Search, ShoppingCart } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'wouter'

import { useAuth } from '@/auth'
import { usePartnerAccountStatementPrintBalances } from '@/hooks/usePartnerAccountStatement'
import {
    recordObligationSettlement,
    type OrderInstallment,
    type PaymentObligation,
    type PurchaseOrder,
    type SalesOrder,
    type WorkspacePaymentMethod,
    useBusinessPartner,
    usePurchaseOrders,
    useProductsByIds,
    useSalesOrders,
    useWorkspaceOrderInstallments
} from '@/local-db'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { TemplatePreview } from '@/lib/printPreviewEditorStore'
import { generateTemplatePdf, type PrintFormat } from '@/services/pdfGenerator'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    PrintPreviewModal,
    SettlementDialog,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast
} from '@/ui/components'
import { useWorkspace } from '@/workspace'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'

import {
    ORDER_RECEIPT_TEMPLATE_FIELD_KEYS,
    OrderDetailsPrintTemplate,
    OrderReceiptPrintTemplate
} from './OrderPrintTemplates'
import { AtlasStandardOrderInvoiceTemplate } from './AtlasStandardOrderInvoiceTemplate'
import { useOrderCustomPrint } from './useOrderCustomPrint'

type OrderInstallmentRow =
    | { kind: 'sales'; order: SalesOrder; installment: OrderInstallment }
    | { kind: 'purchase'; order: PurchaseOrder; installment: OrderInstallment }

type OrderInstallmentGroup =
    | {
        kind: 'sales'
        order: SalesOrder
        installments: OrderInstallment[]
        nextInstallment: OrderInstallment | null
        dueDate: string
        plannedAmount: number
        paidAmount: number
        balanceAmount: number
        status: OrderInstallment['status']
    }
    | {
        kind: 'purchase'
        order: PurchaseOrder
        installments: OrderInstallment[]
        nextInstallment: OrderInstallment | null
        dueDate: string
        plannedAmount: number
        paidAmount: number
        balanceAmount: number
        status: OrderInstallment['status']
    }

function statusClass(status: OrderInstallment['status']) {
    if (status === 'paid') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    if (status === 'overdue') return 'bg-red-500/15 text-red-700 dark:text-red-300'
    if (status === 'partial') return 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
    return 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
}

function buildPaymentObligation(group: OrderInstallmentGroup, installment: OrderInstallment): PaymentObligation {
    const counterpartyName = group.kind === 'sales' ? group.order.customerName : group.order.supplierName
    return {
        id: `order-installment:${installment.id}`,
        workspaceId: group.order.workspaceId,
        sourceModule: 'orders',
        sourceType: group.kind === 'sales' ? 'sales_order' : 'purchase_order',
        sourceRecordId: group.order.id,
        sourceSubrecordId: installment.id,
        direction: group.kind === 'sales' ? 'incoming' : 'outgoing',
        amount: installment.balanceAmount,
        currency: group.order.currency,
        dueDate: installment.dueDate,
        counterpartyName,
        referenceLabel: `${group.order.orderNumber} / Installment ${installment.installmentNo}`,
        title: counterpartyName,
        subtitle: `Installment ${installment.installmentNo}`,
        status: installment.status === 'overdue' ? 'overdue' : 'open',
        routePath: `/orders/${group.order.id}`,
        metadata: {
            orderType: group.kind,
            installmentId: installment.id,
            installmentNo: installment.installmentNo,
            businessPartnerId: group.order.businessPartnerId || null
        }
    }
}

export function OrderInstallmentsMirror({ workspaceId }: { workspaceId: string }) {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const { features, workspaceName, isLocalMode } = useWorkspace()
    const { toast } = useToast()
    const salesOrders = useSalesOrders(workspaceId)
    const purchaseOrders = usePurchaseOrders(workspaceId)
    const installments = useWorkspaceOrderInstallments(workspaceId)
    const [search, setSearch] = useState('')
    const [settlementTarget, setSettlementTarget] = useState<PaymentObligation | null>(null)
    const [isSubmittingSettlement, setIsSubmittingSettlement] = useState(false)
    const [printTarget, setPrintTarget] = useState<OrderInstallmentGroup | null>(null)
    const printProductIds = useMemo(
        () => printTarget?.order.items.map((item) => item.productId) || [],
        [printTarget]
    )
    const printProducts = useProductsByIds(workspaceId, printProductIds)
    const productUnits = useMemo(() => printProducts.reduce<Record<string, string>>((units, product) => {
        const unit = product.unit?.trim()
        if (unit) units[product.id] = unit
        return units
    }, {}), [printProducts])
    const productImageUrls = useMemo(() => printProducts.reduce<Record<string, string>>((imageUrls, product) => {
        const imageUrl = product.imageUrl?.trim()
        if (imageUrl) imageUrls[product.id] = imageUrl
        return imageUrls
    }, {}), [printProducts])
    const printPartnerId = printTarget?.order.businessPartnerId
        || (printTarget?.kind === 'sales'
            ? (printTarget.order as SalesOrder).customerId
            : (printTarget?.order as PurchaseOrder | undefined)?.supplierId)
    const printPartner = useBusinessPartner(printPartnerId)
    const {
        currentBalances: partnerAccountStatementBalances,
        legacyOrderBalanceSnapshot
    } = usePartnerAccountStatementPrintBalances(
        printTarget ? workspaceId : undefined,
        printTarget ? printPartnerId : undefined,
        printTarget?.order
    )
    const counterpartyPhone = printPartner?.phone || ''
    const counterpartyAddress = printPartner?.address || ''

    const salesOrderById = useMemo(
        () => new Map(salesOrders.map((order) => [order.id, order])),
        [salesOrders]
    )
    const purchaseOrderById = useMemo(
        () => new Map(purchaseOrders.map((order) => [order.id, order])),
        [purchaseOrders]
    )

    const rows = useMemo(() => {
        const query = search.trim().toLowerCase()
        const installmentRows = installments
            .flatMap((installment): OrderInstallmentRow[] => {
                if (installment.orderType === 'sales') {
                    const order = salesOrderById.get(installment.orderId)
                    return order ? [{ kind: 'sales', order, installment }] : []
                }

                const order = purchaseOrderById.get(installment.orderId)
                return order ? [{ kind: 'purchase', order, installment }] : []
            })

        const rowsByOrder = new Map<string, OrderInstallmentRow[]>()
        installmentRows.forEach((row) => {
            const key = `${row.kind}:${row.order.id}`
            const orderRows = rowsByOrder.get(key) || []
            orderRows.push(row)
            rowsByOrder.set(key, orderRows)
        })

        return Array.from(rowsByOrder.values())
            .map((orderRows): OrderInstallmentGroup => {
                const firstRow = orderRows[0]
                const orderInstallments = orderRows
                    .map((row) => row.installment)
                    .sort((left, right) =>
                        left.dueDate.localeCompare(right.dueDate)
                        || left.installmentNo - right.installmentNo
                    )
                const nextInstallment = orderInstallments.find((installment) => installment.balanceAmount > 0) || null
                const dueInstallment = nextInstallment || orderInstallments[orderInstallments.length - 1]
                const plannedAmount = orderInstallments.reduce((sum, installment) => sum + installment.plannedAmount, 0)
                const paidAmount = orderInstallments.reduce((sum, installment) => sum + installment.paidAmount, 0)
                const balanceAmount = orderInstallments.reduce((sum, installment) => sum + installment.balanceAmount, 0)
                const status: OrderInstallment['status'] = balanceAmount <= 0
                    ? 'paid'
                    : orderInstallments.some((installment) => installment.status === 'overdue')
                        ? 'overdue'
                        : paidAmount > 0
                            ? 'partial'
                            : 'unpaid'
                const summary = {
                    installments: orderInstallments,
                    nextInstallment,
                    dueDate: dueInstallment.dueDate,
                    plannedAmount,
                    paidAmount,
                    balanceAmount,
                    status
                }

                return firstRow.kind === 'sales'
                    ? { kind: 'sales', order: firstRow.order, ...summary }
                    : { kind: 'purchase', order: firstRow.order, ...summary }
            })
            .filter(({ kind, order, installments: orderInstallments, status }) => {
                if (!query) return true
                const counterpartyName = kind === 'sales' ? order.customerName : order.supplierName
                return [
                    order.orderNumber,
                    counterpartyName,
                    kind,
                    status,
                    ...orderInstallments.flatMap((installment) => [
                        installment.status,
                        installment.dueDate,
                        String(installment.installmentNo)
                    ])
                ].some((value) => value.toLowerCase().includes(query))
            })
            .sort((left, right) =>
                left.dueDate.localeCompare(right.dueDate)
                || left.order.orderNumber.localeCompare(right.order.orderNumber)
            )
    }, [installments, purchaseOrderById, salesOrderById, search])

    const openRows = rows.filter(({ balanceAmount }) => balanceAmount > 0)
    const overdueRows = openRows.filter(({ status }) => status === 'overdue')
    const printInstallments = useMemo(
        () => printTarget?.installments || [],
        [printTarget]
    )
    const printLang = features.print_lang && features.print_lang !== 'auto'
        ? features.print_lang
        : i18n.language
    const buildQrValue = useCallback((effectiveId: string, format: PrintFormat = 'a4') => {
        if (!features.print_qr || isLocalWorkspaceMode(workspaceId)) return undefined
        const folder = format === 'receipt' ? 'receipts' : 'A4'
        return `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/${folder}/${effectiveId}.pdf`
    }, [features.print_qr, workspaceId])
    const renderOrderTemplate = useCallback((
        format: PrintFormat = 'a4',
        effectiveId?: string,
        printLangOverride?: string,
        useAtlasStandard = true
    ) => {
        if (!printTarget) return null
        return format === 'receipt' ? (
            <OrderReceiptPrintTemplate
                workspaceName={workspaceName}
                printLang={printLangOverride || printLang}
                order={printTarget.order}
                installments={printInstallments}
                kind={printTarget.kind}
                iqdPreference={features.iqd_display_preference}
                logoUrl={features.logo_url}
                qrValue={effectiveId ? buildQrValue(effectiveId, 'receipt') : undefined}
                productUnits={productUnits}
                counterpartyPhone={counterpartyPhone}
            />
        ) : useAtlasStandard ? (
            <AtlasStandardOrderInvoiceTemplate
                workspaceName={workspaceName}
                printLang={printLangOverride || printLang}
                order={printTarget.order}
                installments={printInstallments}
                kind={printTarget.kind}
                iqdPreference={features.iqd_display_preference}
                logoUrl={features.logo_url}
                businessPartner={printPartner}
                partnerAccountStatementBalances={partnerAccountStatementBalances}
                partnerBalanceFallbackSnapshot={legacyOrderBalanceSnapshot}
                printedBy={user?.name}
                productImageUrls={productImageUrls}
            />
        ) : (
            <OrderDetailsPrintTemplate
                workspaceName={workspaceName}
                printLang={printLangOverride || printLang}
                order={printTarget.order}
                installments={printInstallments}
                kind={printTarget.kind}
                iqdPreference={features.iqd_display_preference}
                logoUrl={features.logo_url}
                qrValue={effectiveId ? buildQrValue(effectiveId, 'a4') : undefined}
                counterpartyPhone={counterpartyPhone}
                counterpartyAddress={counterpartyAddress}
                productUnits={productUnits}
            />
        )
    }, [
        buildQrValue,
        features.iqd_display_preference,
        features.logo_url,
        printInstallments,
        printLang,
        printTarget,
        productImageUrls,
        productUnits,
        counterpartyAddress,
        counterpartyPhone,
        legacyOrderBalanceSnapshot,
        partnerAccountStatementBalances,
        printPartner,
        user?.name,
        workspaceName
    ])
    const orderInstallmentPreview = useMemo<TemplatePreview | undefined>(() => {
        if (!printTarget) return undefined

        const { order, kind } = printTarget
        const counterpartyLabel = kind === 'sales'
            ? (t('orders.details.customer') || 'Customer')
            : (t('orders.details.supplier') || 'Supplier')
        const counterpartyName = kind === 'sales' ? order.customerName : order.supplierName

        return {
            fields: [
                { key: 'counterpartyName', label: counterpartyLabel, value: counterpartyName || '', type: 'text' },
                { key: 'counterpartyPhone', label: t('common.phone', { defaultValue: 'Phone' }), value: counterpartyPhone, type: 'text' },
                { key: 'counterpartyAddress', label: t('common.address', { defaultValue: 'Address' }), value: counterpartyAddress, type: 'text' },
                { key: 'notes', label: t('common.notes') || 'Notes', value: order.notes || '', type: 'text' },
                { key: 'boldAllText', label: t('orders.print.boldAllText', { defaultValue: 'Bold all text' }), value: 'false', type: 'boolean' },
                { key: 'labelOpacity', label: t('orders.print.labelOpacity', { defaultValue: 'Labels opacity' }), value: '50', type: 'number' }
            ],
            createElement: (data: Record<string, string>, effectiveId?: string, printLangOverride?: string) => {
                const updatedOrder = {
                    ...order,
                    ...(kind === 'sales'
                        ? { customerName: data.counterpartyName }
                        : { supplierName: data.counterpartyName }),
                    notes: data.notes
                }
                const effectivePrintLang = printLangOverride || printLang

                return (
                    <OrderDetailsPrintTemplate
                        workspaceName={workspaceName}
                        printLang={effectivePrintLang}
                        order={updatedOrder}
                        installments={printInstallments}
                        kind={kind}
                        iqdPreference={features.iqd_display_preference}
                        logoUrl={features.logo_url}
                        qrValue={effectiveId ? buildQrValue(effectiveId) : undefined}
                        productUnits={productUnits}
                        templateFields={data}
                        counterpartyPhone={data.counterpartyPhone || counterpartyPhone}
                        counterpartyAddress={data.counterpartyAddress || counterpartyAddress}
                    />
                )
            },
            buildPdf: async (element: ReactElement, printLangOverride?: string) => {
                const effectivePrintLang = printLangOverride || printLang
                return generateTemplatePdf({
                    element,
                    format: 'a4',
                    printLang: effectivePrintLang
                })
            }
        }
    }, [
        buildQrValue,
        features.iqd_display_preference,
        features.logo_url,
        printInstallments,
        printLang,
        printTarget,
        productUnits,
        counterpartyAddress,
        counterpartyPhone,
        t,
        workspaceName
    ])
    const orderInstallmentReceiptPreview = useMemo<TemplatePreview | undefined>(() => {
        if (!printTarget) return undefined

        const { order, kind } = printTarget
        const counterpartyLabel = kind === 'sales'
            ? (t('orders.details.customer') || 'Customer')
            : (t('orders.details.supplier') || 'Supplier')
        const counterpartyName = kind === 'sales' ? order.customerName : order.supplierName

        return {
            // Keep this thermal layout out of the preview's A4 fallback.
            page: { widthMm: 80, heightMm: 200 },
            fields: [
                { key: 'counterpartyName', label: counterpartyLabel, value: counterpartyName || '', type: 'text' },
                { key: 'notes', label: t('common.notes') || 'Notes', value: order.notes || '', type: 'text' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showExchangeRateSnapshots, label: t('sales.marketRatesSnapshot', { defaultValue: 'Show exchange rate snapshots' }), value: 'true', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showOriginalCurrencyPrice, label: t('orders.print.showOriginalCurrencyPrice', { defaultValue: 'Show original currency price' }), value: 'true', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.hideUnit, label: t('orders.form.hideUnit', { defaultValue: 'Hide Unit' }), value: 'false', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.hideDiscount, label: t('orders.form.hideDiscount', { defaultValue: 'Hide Discount' }), value: 'false', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showNotes, label: t('orders.print.showNotes', { defaultValue: 'Show notes' }), value: 'true', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showContacts, label: t('orders.print.showContacts', { defaultValue: 'Show contacts' }), value: 'true', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.thankYou, label: t('sales.print.thankYou', { defaultValue: 'Thank-you text' }), value: '', type: 'text' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.keepRecord, label: t('sales.print.keepRecord', { defaultValue: 'Keep-record text' }), value: '', type: 'text' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.labelOpacity, label: t('orders.print.labelOpacity', { defaultValue: 'Labels opacity' }), value: '100', type: 'number' }
            ],
            createElement: (data, effectiveId, printLangOverride, renderOptions) => {
                const updatedOrder = {
                    ...order,
                    ...(kind === 'sales'
                        ? { customerName: data.counterpartyName }
                        : { supplierName: data.counterpartyName }),
                    notes: data.notes
                }
                const effectivePrintLang = printLangOverride || printLang

                return (
                    <OrderReceiptPrintTemplate
                        workspaceName={workspaceName}
                        printLang={effectivePrintLang}
                        order={updatedOrder}
                        installments={printInstallments}
                        kind={kind}
                        iqdPreference={features.iqd_display_preference}
                        logoUrl={features.logo_url}
                        qrValue={effectiveId ? buildQrValue(effectiveId, 'receipt') : undefined}
                        counterpartyPhone={counterpartyPhone}
                        productUnits={productUnits}
                        templateFields={data}
                        editableFields={renderOptions?.editableFields}
                        onTemplateFieldChange={renderOptions?.onFieldChange}
                        componentPositions={renderOptions?.componentPositions}
                        editableComponents={renderOptions?.editableComponents}
                        onComponentPositionChange={renderOptions?.onComponentPositionChange}
                    />
                )
            },
            buildPdf: async (element: ReactElement, printLangOverride?: string) => generateTemplatePdf({
                element,
                format: 'receipt',
                printLang: printLangOverride || printLang
            })
        }
    }, [
        buildQrValue,
        features.iqd_display_preference,
        features.logo_url,
        printInstallments,
        printLang,
        printTarget,
        productUnits,
        counterpartyPhone,
        t,
        workspaceName
    ])

    const orderInstallmentAtlasStandardPreview = useMemo<TemplatePreview | undefined>(() => {
        if (!printTarget) return undefined
        return {
            fields: [],
            createElement: (_data, _effectiveId, printLangOverride, renderOptions) => (
                <AtlasStandardOrderInvoiceTemplate
                    workspaceName={workspaceName}
                    printLang={printLangOverride || printLang}
                    order={printTarget.order}
                    installments={printInstallments}
                    kind={printTarget.kind}
                    iqdPreference={features.iqd_display_preference}
                    logoUrl={features.logo_url}
                    businessPartner={printPartner}
                    partnerAccountStatementBalances={partnerAccountStatementBalances}
                    partnerBalanceFallbackSnapshot={legacyOrderBalanceSnapshot}
                    printedBy={user?.name}
                    productImageUrls={productImageUrls}
                    hiddenFields={renderOptions?.hiddenFields}
                    onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
                    fieldLabelOverrides={renderOptions?.fieldLabelOverrides}
                    onFieldLabelChange={renderOptions?.onFieldLabelChange}
                    fieldDisplayModes={renderOptions?.fieldDisplayModes}
                    onFieldDisplayModeChange={renderOptions?.onFieldDisplayModeChange}
                />
            ),
            buildPdf: async (element: ReactElement, printLangOverride?: string) => generateTemplatePdf({
                element,
                format: 'a4',
                printLang: printLangOverride || printLang
            })
        }
    }, [
        features.iqd_display_preference,
        features.logo_url,
        printInstallments,
        printLang,
        printPartner,
        partnerAccountStatementBalances,
        legacyOrderBalanceSnapshot,
        printTarget,
        productImageUrls,
        user?.name,
        workspaceName
    ])
    const customOrderPrint = useOrderCustomPrint({
        workspaceId,
        workspaceName,
        features,
        isLocalMode,
        isOpen: printTarget !== null,
        printLanguage: i18n.language,
        order: printTarget?.order,
        orderKind: printTarget?.kind,
        installments: printInstallments,
        partnerAccountStatementBalances,
        productUnits,
        productImageUrls,
        t
    })

    const handleSettlement = async (input: {
        paymentMethod: WorkspacePaymentMethod
        paidAt: string
        amount?: number
        note?: string
        accountId?: string | null
        accountNameSnapshot?: string | null
    }) => {
        if (!settlementTarget) return
        setIsSubmittingSettlement(true)
        try {
            await recordObligationSettlement(workspaceId, settlementTarget, {
                ...input,
                createdBy: user?.id || null
            })
            toast({
                title: settlementTarget.direction === 'incoming'
                    ? t('settlementModal.collectionRecorded', { defaultValue: 'Collection recorded' })
                    : t('settlementModal.paymentRecorded', { defaultValue: 'Payment recorded' })
            })
            setSettlementTarget(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to record installment payment',
                variant: 'destructive'
            })
        } finally {
            setIsSubmittingSettlement(false)
        }
    }

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <MetricCard title={t('orders.details.installmentSchedule', { defaultValue: 'Order Installments' })} value={String(rows.length)} />
                <MetricCard title={t('payments.kpis.open', { defaultValue: 'Open' })} value={String(openRows.length)} />
                <MetricCard title={t('payments.kpis.overdue', { defaultValue: 'Overdue' })} value={String(overdueRows.length)} />
            </div>

            <Card>
                <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <CardTitle className="flex items-center gap-2">
                        <ShoppingCart className="h-5 w-5" />
                        {t('orders.details.installmentSchedule', { defaultValue: 'Order Installments' })}
                    </CardTitle>
                    <div className="relative w-full sm:max-w-sm">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('orders.searchInstallments', { defaultValue: 'Search order installments...' })}
                            className="pl-9"
                        />
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="overflow-x-auto rounded-md border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('orders.table.orderNumber', { defaultValue: 'Order #' })}</TableHead>
                                    <TableHead>{t('payments.table.counterparty', { defaultValue: 'Counterparty' })}</TableHead>
                                    <TableHead>{t('orders.details.dueDate', { defaultValue: 'Due Date' })}</TableHead>
                                    <TableHead className="text-end">{t('orders.details.plannedAmount', { defaultValue: 'Planned' })}</TableHead>
                                    <TableHead className="text-end">{t('orders.details.paidAmount', { defaultValue: 'Paid' })}</TableHead>
                                    <TableHead className="text-end">{t('orders.details.outstanding', { defaultValue: 'Outstanding' })}</TableHead>
                                    <TableHead>{t('common.status', { defaultValue: 'Status' })}</TableHead>
                                    <TableHead className="text-end">{t('common.actions', { defaultValue: 'Actions' })}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                                            {t('orders.noInstallmentRows', { defaultValue: 'No order installment rows are available.' })}
                                        </TableCell>
                                    </TableRow>
                                ) : rows.map((row) => {
                                    const counterpartyName = row.kind === 'sales'
                                        ? row.order.customerName
                                        : row.order.supplierName
                                    return (
                                        <TableRow key={`${row.kind}:${row.order.id}`}>
                                            <TableCell>
                                                <Link href={`/orders/${row.order.id}`} className="font-semibold hover:underline">
                                                    {row.order.orderNumber}
                                                </Link>
                                                <div className="text-xs text-muted-foreground">
                                                    {row.kind === 'sales'
                                                        ? t('orders.tabs.sales', { defaultValue: 'Sales' })
                                                        : t('orders.tabs.purchase', { defaultValue: 'Purchase' })}
                                                    {' / '}
                                                    {t('orders.installmentCountSummary', {
                                                        count: row.installments.length,
                                                        defaultValue: '{{count}} installments'
                                                    })}
                                                </div>
                                            </TableCell>
                                            <TableCell>{counterpartyName}</TableCell>
                                            <TableCell>{formatDate(row.dueDate)}</TableCell>
                                            <TableCell className="text-end">
                                                {formatCurrency(row.plannedAmount, row.order.currency, features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell className="text-end text-emerald-600">
                                                {formatCurrency(row.paidAmount, row.order.currency, features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell className="text-end font-semibold">
                                                {formatCurrency(row.balanceAmount, row.order.currency, features.iqd_display_preference)}
                                            </TableCell>
                                            <TableCell>
                                                <span className={cn(
                                                    'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                                                    statusClass(row.status)
                                                )}>
                                                    {t(`orders.installmentStatus.${row.status}`, { defaultValue: row.status })}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-end">
                                                <div className="flex justify-end gap-1">
                                                    <Button asChild variant="ghost" size="icon">
                                                        <Link href={`/orders/${row.order.id}`}>
                                                            <Eye className="h-4 w-4" />
                                                        </Link>
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={() => {
                                                            customOrderPrint.resetSelection()
                                                            setPrintTarget(row)
                                                        }}
                                                    >
                                                        <Printer className="h-4 w-4" />
                                                    </Button>
                                                    {row.nextInstallment && user?.role !== 'viewer' && !row.order.isLocked ? (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            onClick={() => setSettlementTarget(buildPaymentObligation(row, row.nextInstallment!))}
                                                        >
                                                            <CreditCard className="h-4 w-4" />
                                                        </Button>
                                                    ) : null}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    </div>
                </CardContent>
            </Card>

            <SettlementDialog
                open={settlementTarget !== null}
                onOpenChange={(open) => {
                    if (!open) setSettlementTarget(null)
                }}
                obligation={settlementTarget}
                isSubmitting={isSubmittingSettlement}
                onSubmit={handleSettlement}
            />

            <PrintPreviewModal
                isOpen={printTarget !== null}
                onClose={() => {
                    setPrintTarget(null)
                    customOrderPrint.resetSelection()
                }}
                onConfirm={() => {
                    setPrintTarget(null)
                    customOrderPrint.resetSelection()
                }}
                title={customOrderPrint.selectedTemplateLabel
                    ? customOrderPrint.selectedTemplateLabel
                    : printTarget?.order.orderNumber || t('orders.details.installmentSchedule', { defaultValue: 'Order Installments' })}
                module="orders"
                features={features}
                workspaceName={workspaceName}
                originId={printTarget?.order.id}
                invoiceData={printTarget ? {
                    invoiceid: printTarget.order.orderNumber,
                    totalAmount: printTarget.order.total,
                    settlementCurrency: printTarget.order.currency,
                    origin: printTarget.kind === 'sales' ? 'sales_order' as const : 'purchase_order' as const,
                    createdByName: user?.name || 'Unknown',
                    cashierName: user?.name || 'Unknown',
                    printFormat: 'a4' as const
                } : undefined}
                pdfBuilder={customOrderPrint.isCustomSelected
                    ? customOrderPrint.buildPdf
                    : async ({ format, effectiveId, printLangOverride }: {
                        format: PrintFormat
                        effectiveId: string
                        printLangOverride?: string
                    }) => {
                        const template = renderOrderTemplate(format, effectiveId, printLangOverride, customOrderPrint.isAtlasStandardSelected)
                        if (!template) throw new Error('Order data not ready')
                        return generateTemplatePdf({
                            element: template,
                            format,
                            printLang: printLangOverride || printLang
                        })
                    }}
                printTemplate={({ effectiveId }) => renderOrderTemplate(
                    customOrderPrint.isReceiptSelected ? 'receipt' : 'a4',
                    effectiveId,
                    undefined,
                    customOrderPrint.isAtlasStandardSelected
                )}
                templatePreview={customOrderPrint.isCustomSelected
                    ? customOrderPrint.preview
                    : customOrderPrint.isReceiptSelected
                        ? orderInstallmentReceiptPreview
                        : customOrderPrint.isAtlasStandardSelected
                            ? orderInstallmentAtlasStandardPreview
                            : orderInstallmentPreview}
                customTemplate={customOrderPrint.customTemplate}
                initialTemplateLayout={customOrderPrint.initialLayout}
                enableTemplatePreviewSave={customOrderPrint.isCustomSelected}
                generateTemplateLayoutBlob={customOrderPrint.isCustomSelected ? customOrderPrint.buildEditablePdf : undefined}
                printSelectionOptions={customOrderPrint.nativeOptions}
                printSelectionTemplates={customOrderPrint.templateOptions}
                onPrintSelection={customOrderPrint.handleSelection}
            />
        </div>
    )
}

function MetricCard({ title, value }: { title: string; value: string }) {
    return (
        <Card>
            <CardContent className="pt-6">
                <div className="text-xs text-muted-foreground">{title}</div>
                <div className="mt-1 text-2xl font-bold">{value}</div>
            </CardContent>
        </Card>
    )
}
