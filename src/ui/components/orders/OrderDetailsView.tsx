import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, BadgeCheck, CalendarDays, CircleCheck, Clock3, CreditCard, Eye, LayoutGrid, List, Loader2, Lock, Package, PackageCheck, Pencil, Plus, Printer, Receipt, RotateCcw, ShoppingCart, Trash2, TrendingUp, Truck, UsersRound, Warehouse, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getLocalizedOrderError } from '@/lib/orderErrors'
import { ORDER_STATUS_ADVANCE_HOLD_DURATION_MS } from '@/lib/pressAndHold'
import { PressAndHoldButton } from '@/ui/components/PressAndHoldButton'
import { Link, useLocation } from 'wouter'

import { useAuth } from '@/auth'
import { useDemoTutorial } from '@/demo'
import { usePartnerAccountStatementPrintBalances } from '@/hooks/usePartnerAccountStatement'
import { useProfileData } from '@/hooks/useProfileData'
import { getOrderLineFreeBonusQuantity, getOrderLineFulfilledQuantity, getOrderLineInventoryQuantity, getOrderLinePaidQuantity, hasOrderLineFreeBonus, isFulfilledUnitsAvailableForOrder } from '@/lib/orderLineItems'
import {
    getOrderAdjustmentTotals,
    getOrderTotalWithPostReturnAdjustments,
    isPostReturnOrderAdjustment,
    normalizeOrderAdjustments
} from '@/lib/orderAdjustments'
import { getOrderPrintOriginalTotal, getOrderPrintReturnState } from '@/lib/orderPrintReturnState'
import { createSalesOrderReturnPrintData } from '@/lib/orderReturnPrintData'
import { isPositiveQuantity } from '@/lib/quantity'
import { cn, formatCurrency, formatDate, formatDateTime, formatSnapshotTime } from '@/lib/utils'
import { normalizeUnitCode } from '@/local-db/models'
import { buildWorkflowGradientFill } from '@/lib/workflowProgressGradient'
import { generateTemplatePdf, type PrintFormat } from '@/services/pdfGenerator'
import { setPrintPreviewEditorSource, type TemplatePreview, type TemplatePreviewRenderOptions } from '@/lib/printPreviewEditorStore'
import {
    db,
    approvePurchaseOrderRequest,
    approveSalesOrderRequest,
    createPostReturnSalesOrderAdjustment,
    deletePurchaseOrder,
    deleteSalesOrder,
    findLatestUnreversedPaymentTransaction,
    getActiveSalesOrderAgentAssignments,
    getOrderBalanceAmount,
    getOrderPaidAmount,
    getOrderPaymentStatus,
    isDraftOrderLoanRepaymentPending,
    isOrderApprovalRequested,
    lockPurchaseOrder,
    lockSalesOrder,
    recordObligationSettlement,
    returnSalesOrder,
    reversePaymentTransaction,
    updatePurchaseOrderStatus,
    updateSalesOrderStatus,
    useBusinessPartner,
    usePurchaseOrder,
    useLoan,
    useLoanInstallments,
    useOrderInstallments,
    useProductsByIds,
    useSalesOrderAgentAssignments,
    useSalesOrder,
    useSalesOrderReturnItems,
    useSalesOrderReturns,
    useStorages,
    useWorkspaceContacts,
    type PaymentObligation,
    type PaymentTransaction,
    type OrderInstallment,
    type PaymentAccount,
    type PurchaseOrder,
    type PurchaseOrderItem,
    type SalesOrder,
    type SalesOrderItem,
    type SalesOrderReturnLineInput,
    type WorkspacePaymentMethod
} from '@/local-db'
import { useWorkspace } from '@/workspace'
import { hasEffectiveSalesAgentCommissionPermission, useHideCosts, useViewOwnRecordScope, useWorkspacePermissions } from '@/permissions'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    DeleteConfirmationModal,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    PrintPreviewModal,
    ReturnConfirmationModal,
    SettlementDialog,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast
} from '@/ui/components'

import { useLiveQuery } from 'dexie-react-hooks'
import { PaymentReversalDialog, type PaymentReversalDialogInput } from '@/ui/components/payments/PaymentReversalDialog'
import { platformService } from '@/services/platformService'
import { getStoredLocalInvoicePdfPath } from '@/services/localInvoiceStorage'
import { r2Service } from '@/services/r2Service'
import { getWorkspaceUsageLimitMessage, isWorkspaceUsageLimitError } from '@/lib/workspaceUsage'
import {
    ORDER_PRINT_COMMON_FIELD_KEYS,
    ORDER_RECEIPT_TEMPLATE_FIELD_KEYS,
    OrderDetailsPrintTemplate,
    OrderReceiptPrintTemplate
} from './OrderPrintTemplates'
import {
    AtlasStandardOrderInvoiceTemplate,
    ATLAS_STANDARD_ORDER_TEMPLATE_FIELD_KEYS
} from './AtlasStandardOrderInvoiceTemplate'
import { OrderStatusBadge } from './OrderStatusBadge'
import { OrderProductAvatar } from './OrderProductAvatars'
import { useOrderCustomPrint } from './useOrderCustomPrint'
import { PostReturnAdjustmentDialog } from './PostReturnAdjustmentDialog'
import {
    ProductCommissionPreview,
    type ProductCommissionPreviewAgent
} from '@/ui/components/commissions/ProductCommissionPreview'
import { getProductCommissionPreviewAgentIds } from '@/ui/components/commissions/productCommissionAgent'
import { useCommissionAgentDirectory } from '@/ui/components/commissions/useCommissionAgentDirectory'

function statusLabel(t: (key: string) => string, status: string) {
    const translated = t(`orders.status.${status}`)
    return translated && translated !== `orders.status.${status}` ? translated : status
}

function paymentLabel(t: (key: string) => string, method?: string | null) {
    switch (method) {
        case 'cash': return t('pos.cash') || 'Cash'
        case 'fib': return t('pos.fib') || 'FIB'
        case 'qicard': return t('pos.qicard') || 'Qi Card'
        case 'zaincash': return t('pos.zaincash') || 'Zain Cash'
        case 'fastpay': return t('pos.fastpay') || 'FastPay'
        case 'loan': return t('pos.loan') || 'Loan'
        case 'bank_transfer': return 'Bank Transfer'
        case 'installments': return t('nav.installments') || 'Installments'
        case 'ecommerce': return 'E-Commerce'
        default: return method || '-'
    }
}

function readViewMode() {
    return (localStorage.getItem('order_details_view_mode') as 'table' | 'grid') || 'table'
}

function buildSalesOrderPaymentObligation(order: SalesOrder, installment?: OrderInstallment): PaymentObligation {
    return {
        id: installment ? `order-installment:${installment.id}` : `sales-order:${order.id}`,
        workspaceId: order.workspaceId,
        sourceModule: 'orders',
        sourceType: 'sales_order',
        sourceRecordId: order.id,
        sourceSubrecordId: installment?.id || null,
        direction: 'incoming',
        amount: installment?.balanceAmount || getOrderBalanceAmount(order),
        currency: order.currency,
        dueDate: installment?.dueDate || (order.expectedDeliveryDate || order.actualDeliveryDate || order.updatedAt).slice(0, 10),
        counterpartyName: order.customerName,
        referenceLabel: order.orderNumber,
        title: order.customerName,
        subtitle: installment ? `Installment ${installment.installmentNo}` : order.status,
        status: 'open',
        routePath: `/orders/${order.id}`,
        metadata: {
            orderStatus: order.status,
            sourceChannel: order.sourceChannel || 'manual',
            installmentId: installment?.id || null,
            installmentNo: installment?.installmentNo || null
        }
    }
}

function buildPurchaseOrderPaymentObligation(order: PurchaseOrder, installment?: OrderInstallment): PaymentObligation {
    return {
        id: installment ? `order-installment:${installment.id}` : `purchase-order:${order.id}`,
        workspaceId: order.workspaceId,
        sourceModule: 'orders',
        sourceType: 'purchase_order',
        sourceRecordId: order.id,
        sourceSubrecordId: installment?.id || null,
        direction: 'outgoing',
        amount: installment?.balanceAmount || getOrderBalanceAmount(order),
        currency: order.currency,
        dueDate: installment?.dueDate || (order.expectedDeliveryDate || order.actualDeliveryDate || order.updatedAt).slice(0, 10),
        counterpartyName: order.supplierName,
        referenceLabel: order.orderNumber,
        title: order.supplierName,
        subtitle: installment ? `Installment ${installment.installmentNo}` : order.status,
        status: 'open',
        routePath: `/orders/${order.id}`,
        metadata: {
            orderStatus: order.status,
            installmentId: installment?.id || null,
            installmentNo: installment?.installmentNo || null
        }
    }
}

function InstallmentAmount({
    label,
    value,
    valueClassName
}: {
    label: string
    value: string
    valueClassName?: string
}) {
    return (
        <div className="min-w-0 rounded-xl bg-muted/30 px-2 py-2 text-center">
            <div className="truncate text-[10px] font-bold uppercase tracking-wide text-muted-foreground" title={label}>
                {label}
            </div>
            <div className={cn('mt-1 whitespace-nowrap text-xs font-semibold sm:text-sm', valueClassName)}>
                {value}
            </div>
        </div>
    )
}

function ReturnedOrderValue({
    currentValue,
    originalValue,
    className,
    currentValueClassName
}: {
    currentValue: string
    originalValue: string
    className?: string
    currentValueClassName?: string
}) {
    return (
        <div className={cn('flex flex-col items-end leading-tight', className)}>
            <span className={cn('font-semibold', currentValueClassName)}>{currentValue}</span>
            <span className="mt-0.5 text-xs text-muted-foreground line-through decoration-muted-foreground/70">{originalValue}</span>
        </div>
    )
}

export function OrderDetailsView({ workspaceId, orderId }: { workspaceId: string; orderId: string }) {
    const { t, i18n } = useTranslation()
    const { user } = useAuth()
    const hideCosts = useHideCosts()
    const invoiceViewOwnScope = useViewOwnRecordScope('invoice_history.view_own')
    const { features, workspaceName, isLocalMode, hasFeature } = useWorkspace()
    const [, navigate] = useLocation()
    const { toast } = useToast()
    const demoTutorial = useDemoTutorial()
    const storages = useStorages(workspaceId)
    const salesOrder = useSalesOrder(orderId)
    const purchaseOrder = usePurchaseOrder(orderId)
    const salesOrderAgentAssignments = useSalesOrderAgentAssignments(workspaceId)
    const commissionAgentDirectory = useCommissionAgentDirectory(workspaceId)
    const salesOrderReturns = useSalesOrderReturns(orderId, workspaceId)
    const salesOrderReturnItems = useSalesOrderReturnItems(orderId, workspaceId)
    const linkedLoanId = salesOrder?.linkedLoanId || purchaseOrder?.linkedLoanId || undefined
    const linkedLoan = useLoan(linkedLoanId)
    const loanInstallments = useLoanInstallments(linkedLoanId, workspaceId)
    const legacyInstallments = useOrderInstallments(orderId, workspaceId)
    const installments = linkedLoanId
        ? loanInstallments.map((item) => ({
            ...item,
            orderType: linkedLoan?.orderType || 'sales',
            orderId,
            dueDate: item.dueDate || ''
        } as OrderInstallment))
        : legacyInstallments
    const workspaceContacts = useWorkspaceContacts(workspaceId)
    const workspaceFooterContacts = useMemo(() => {
        const pickContactPair = (type: 'address' | 'email' | 'phone') => {
            const contactsOfType = workspaceContacts.filter((contact) =>
                contact.type === type
                && typeof contact.value === 'string'
                && contact.value.trim().length > 0
            )
            if (contactsOfType.length === 0) return {}
            const primaryContact = contactsOfType.find((contact) => contact.isPrimary) || contactsOfType[0]
            const primary = primaryContact.value.trim()
            const nonPrimaryContact = contactsOfType.find((contact) =>
                contact.id !== primaryContact.id
                && (!contact.isPrimary || contact.value.trim() !== primary)
            )
            const nonPrimary = nonPrimaryContact?.value.trim()
            return {
                ...(primary ? { primary } : {}),
                ...(nonPrimary ? { nonPrimary } : {})
            }
        }
        return {
            address: pickContactPair('address'),
            email: pickContactPair('email'),
            phone: pickContactPair('phone')
        }
    }, [workspaceContacts])
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(readViewMode)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
const [activeWorkflowAction, setActiveWorkflowAction] = useState<string | null>(null)
    const activeWorkflowActionRef = useRef<string | null>(null)
    const workflowMissCountRef = useRef(0)
    const [showAdvanceHoldTip, setShowAdvanceHoldTip] = useState(false)
    const advanceHoldTipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [showPrintPreview, setShowPrintPreview] = useState(false)
    const [lockConfirm, setLockConfirm] = useState<{ isOpen: boolean }>({ isOpen: false })
    const [isLocking, setIsLocking] = useState(false)
    const [cancelConfirm, setCancelConfirm] = useState<{ isOpen: boolean }>({ isOpen: false })
    const [isCancelling, setIsCancelling] = useState(false)
    const [settlementTarget, setSettlementTarget] = useState<PaymentObligation | null>(null)
    const [isSubmittingSettlement, setIsSubmittingSettlement] = useState(false)
    const [transactionToReverse, setTransactionToReverse] = useState<PaymentTransaction | null>(null)
    const [isReversingPayment, setIsReversingPayment] = useState(false)
    const [isLoadingOrderInvoice, setIsLoadingOrderInvoice] = useState(false)
    const [returnTarget, setReturnTarget] = useState<{ orderItemId: string | null; maxQuantity: number; itemName: string } | null>(null)
    const [isReturning, setIsReturning] = useState(false)
    const [returnPaymentAccount, setReturnPaymentAccount] = useState<PaymentAccount | null>(null)
    const [isPostReturnAdjustmentOpen, setIsPostReturnAdjustmentOpen] = useState(false)
    const [isSavingPostReturnAdjustment, setIsSavingPostReturnAdjustment] = useState(false)

    useEffect(() => {
        localStorage.setItem('order_details_view_mode', viewMode)
    }, [viewMode])

    const resolved = useMemo(() => salesOrder
        ? { kind: 'sales' as const, order: salesOrder }
        : purchaseOrder
            ? { kind: 'purchase' as const, order: purchaseOrder }
            : null,
        [purchaseOrder, salesOrder])

    const orderProductIds = useMemo(
        () => resolved?.order.items.map((item) => item.productId) || [],
        [resolved]
    )
    const orderProducts = useProductsByIds(workspaceId, orderProductIds)
    const productUnits = useMemo(() => orderProducts.reduce<Record<string, string>>((units, product) => {
        const unit = normalizeUnitCode(product.unit)
        if (unit) units[product.id] = unit
        return units
    }, {}), [orderProducts])
    const productImageUrls = useMemo(() => orderProducts.reduce<Record<string, string>>((imageUrls, product) => {
        const imageUrl = product.imageUrl?.trim()
        if (imageUrl) imageUrls[product.id] = imageUrl
        return imageUrls
    }, {}), [orderProducts])

    const partnerId = resolved?.order.businessPartnerId
        || (resolved?.kind === 'sales' ? (resolved?.order as SalesOrder)?.customerId : (resolved?.order as PurchaseOrder)?.supplierId)
    const bizPartner = useBusinessPartner(partnerId)
    const {
        currentBalances: partnerAccountStatementBalances,
        legacyOrderBalanceSnapshot
    } = usePartnerAccountStatementPrintBalances(
        showPrintPreview ? workspaceId : undefined,
        showPrintPreview ? partnerId : undefined,
        showPrintPreview ? resolved?.order : undefined
    )
    const counterpartyPhone = bizPartner?.phone || ''
    const counterpartyAddress = bizPartner?.address || ''

    const creatorId = (resolved?.order as any)?.createdBy ?? null
    const { profile: creatorProfile, isLoading: isCreatorProfileLoading } = useProfileData(creatorId)
    const creatorName = creatorProfile?.name?.trim()
        || (creatorId === user?.id ? user?.name?.trim() : '')
        || null

    const { permissionKeys } = useWorkspacePermissions()
    const salesAgentCommissionsEnabled = hasFeature('sales_agent_commissions')
    const canAssignSalesAgents = salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.assignOrders')
    const canViewAllAgentCommissions = salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.viewAll')
    const canViewOwnAgentCommissions = salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.viewOwn')
    const canPaySalesAgentCommissions = salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.pay')
    const productCommissionPreviewAgentIds = useMemo(() => {
        if (!salesOrder) return []
        return getProductCommissionPreviewAgentIds({
            activeAssignments: getActiveSalesOrderAgentAssignments(salesOrderAgentAssignments, salesOrder.id),
            agents: commissionAgentDirectory.agents.map((entry) => entry.agent),
            getAgent: (agentId) => commissionAgentDirectory.agentById.get(agentId)?.agent,
            userId: user?.id,
            orderCreatedBy: salesOrder.createdBy,
            canAssignSalesAgents,
            canViewAllAgentCommissions,
            canViewOwnAgentCommissions
        })
    }, [
        canAssignSalesAgents,
        canViewAllAgentCommissions,
        canViewOwnAgentCommissions,
        commissionAgentDirectory.agentById,
        commissionAgentDirectory.agents,
        salesOrder,
        salesOrderAgentAssignments,
        user?.id
    ])
    const productCommissionPreviewAgents = useMemo<ProductCommissionPreviewAgent[]>(() => (
        productCommissionPreviewAgentIds.map((id) => ({
            id,
            name: commissionAgentDirectory.agentById.get(id)?.name || t('salesAgentCommissions.salesAgent')
        }))
    ), [commissionAgentDirectory.agentById, productCommissionPreviewAgentIds, t])
    const productCommissionPreviewItems = useMemo(() => salesOrder?.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        convertedUnitPrice: item.convertedUnitPrice
    })) || [], [salesOrder])
    const canManage = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'
    const canApproveOrderRequests = user?.role === 'admin'
    const canViewProfit = !hideCosts
    const canReturnSalesOrder = resolved?.kind === 'sales'
        && resolved.order.status === 'completed'
        && resolved.order.returnStatus !== 'full'
        && user?.role === 'admin'

    const returnedQuantityByItemId = useMemo(() => {
        const quantities = new Map<string, number>()
        for (const item of salesOrderReturnItems) {
            quantities.set(item.orderItemId, (quantities.get(item.orderItemId) || 0) + item.quantity)
        }
        return quantities
    }, [salesOrderReturnItems])

    const returnedAmountByItemId = useMemo(() => {
        const amounts = new Map<string, number>()
        for (const item of salesOrderReturnItems) {
            amounts.set(
                item.orderItemId,
                (amounts.get(item.orderItemId) || 0) + Math.max(0, Number(item.refundAmount || 0))
            )
        }
        return amounts
    }, [salesOrderReturnItems])

    const returnPrintData = useMemo(() => salesOrder
        ? createSalesOrderReturnPrintData(salesOrder, salesOrderReturns, salesOrderReturnItems)
        : null, [salesOrder, salesOrderReturnItems, salesOrderReturns])

    const customOrderPrint = useOrderCustomPrint({
        workspaceId,
        workspaceName,
        features,
        isLocalMode,
        isOpen: showPrintPreview,
        printLanguage: i18n.language,
        order: resolved?.order,
        orderKind: resolved?.kind,
        returnPrintData,
        installments,
        partnerAccountStatementBalances,
        productUnits,
        productImageUrls,
        printedBy: creatorName,
        t
    })

    const getReturnableQuantity = useCallback((item: SalesOrderItem) => Math.max(
        0,
        getOrderLineInventoryQuantity(item) - (returnedQuantityByItemId.get(item.id) || 0)
    ), [returnedQuantityByItemId])

    const storageName = (storageId?: string | null) => {
        if (!storageId) return 'N/A'
        const match = storages.find((entry) => entry.id === storageId)
        if (!match) return 'N/A'
        return match.isSystem ? (t(`storages.${match.name.toLowerCase()}`) || match.name) : match.name
    }

    const runWorkflowAction = async (actionName: string, action: () => Promise<unknown>, successMessage: string) => {
        if (activeWorkflowActionRef.current) return

        activeWorkflowActionRef.current = actionName
        setActiveWorkflowAction(actionName)

        try {
            await action()
            toast({ title: successMessage })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: getLocalizedOrderError(error, t, 'Action failed'),
                variant: 'destructive'
            })
        } finally {
            activeWorkflowActionRef.current = null
            setActiveWorkflowAction(null)
        }
    }

    const handleWorkflowPressStart = () => {
        workflowMissCountRef.current += 1
        if (workflowMissCountRef.current < 3) return
        workflowMissCountRef.current = 0
        setShowAdvanceHoldTip(true)
        if (advanceHoldTipTimerRef.current) clearTimeout(advanceHoldTipTimerRef.current)
        advanceHoldTipTimerRef.current = setTimeout(() => setShowAdvanceHoldTip(false), 3500)
    }

    const handleWorkflowAdvanceComplete = () => {
        workflowMissCountRef.current = 0
        if (advanceHoldTipTimerRef.current) clearTimeout(advanceHoldTipTimerRef.current)
        advanceHoldTipTimerRef.current = null
        setShowAdvanceHoldTip(false)
    }

    useEffect(() => () => {
        if (advanceHoldTipTimerRef.current) clearTimeout(advanceHoldTipTimerRef.current)
    }, [])

    const orderInvoice = useLiveQuery(
        async () => {
            if (!orderId) return undefined

            const invoices = await db.invoices
                .where('orderId')
                .equals(orderId)
                .and((invoice) => invoice.workspaceId === workspaceId && !invoice.isDeleted && (
                    !invoiceViewOwnScope.isRestricted
                    || invoice.createdBy === invoiceViewOwnScope.userId
                    || invoice.userId === invoiceViewOwnScope.userId
                ))
                .toArray()

            return invoices.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
        },
        [
            orderId,
            workspaceId,
            invoiceViewOwnScope.isRestricted,
            invoiceViewOwnScope.userId,
        ]
    )

    const handleShowInvoice = useCallback(async () => {
        if (!orderInvoice) return
        setIsLoadingOrderInvoice(true)
        try {
            const format = (orderInvoice.printFormat === 'receipt' ? 'receipt' : 'a4') as 'a4' | 'receipt'
            const localPath = getStoredLocalInvoicePdfPath(orderInvoice, format)
            const pdfBlob = format === 'a4' ? orderInvoice.pdfBlobA4 : orderInvoice.pdfBlobReceipt
            const r2Path = format === 'a4' ? orderInvoice.r2PathA4 : orderInvoice.r2PathReceipt

            let url: string | null = null

            if (localPath) {
                const exists = await platformService.exists(localPath)
                if (exists) {
                    try {
                        const content = await platformService.readFile(localPath)
                        const base64 = platformService.uint8ArrayToBase64(content)
                        url = `data:application/pdf;base64,${base64}`
                    } catch (_err) {
                        url = platformService.convertFileSrc(localPath)
                    }
                }
            }

            if (!url && pdfBlob) {
                url = URL.createObjectURL(pdfBlob)
            }

            if (!url && r2Path) {
                const content = await r2Service.download(r2Path)
                if (content) {
                    const bytes = new Uint8Array(content)
                    const base64 = platformService.uint8ArrayToBase64(bytes)
                    url = `data:application/pdf;base64,${base64}`
                }
            }

            if (!url) return

            setPrintPreviewEditorSource({
                url,
                title: `Invoice ${orderInvoice.invoiceid}`
            })
            navigate('/print-preview-editor')
        } catch (error) {
            console.error('[OrderDetailsView] Failed to load invoice PDF:', error)
            toast({
                title: 'Unable to open invoice',
                description: isWorkspaceUsageLimitError(error)
                    ? getWorkspaceUsageLimitMessage(error)
                    : 'Failed to load invoice PDF.',
                variant: 'destructive'
            })
        } finally {
            setIsLoadingOrderInvoice(false)
        }
    }, [orderInvoice, navigate, toast])

    const orderDetailsPreview = useMemo<TemplatePreview | undefined>(() => {
        if (!resolved) return undefined
        const { order, kind } = resolved
        const counterpartyLabel = kind === 'sales'
            ? (t('orders.details.customer') || 'Customer')
            : (t('orders.details.supplier') || 'Supplier')
        const counterpartyName = kind === 'sales' ? (order as any).customerName : (order as any).supplierName
        return {
            fields: [
                { key: 'counterpartyName', label: counterpartyLabel, value: counterpartyName || '', type: 'text' },
                { key: 'counterpartyPhone', label: t('common.phone', { defaultValue: 'Phone' }), value: counterpartyPhone || '', type: 'text' },
                { key: 'counterpartyAddress', label: t('common.address', { defaultValue: 'Address' }), value: counterpartyAddress || '', type: 'text' },
                { key: 'notes', label: t('common.notes') || 'Notes', value: (order as any).notes || '', type: 'text' },
                { key: 'hideUnit', label: t('orders.form.hideUnit', { defaultValue: 'Hide Unit' }), value: localStorage.getItem('atlas_print_hide_unit') || 'false', type: 'boolean' },
                { key: 'hideDiscount', label: t('orders.form.hideDiscount', { defaultValue: 'Hide Discount' }), value: localStorage.getItem('atlas_print_hide_discount') || 'false', type: 'boolean' },
                { key: ORDER_PRINT_COMMON_FIELD_KEYS.showOrderAdjustments, label: t('orders.adjustments.showInPrint', { defaultValue: 'Show order adjustments' }), value: 'true', type: 'boolean' },
                { key: 'boldAllText', label: t('orders.print.boldAllText', { defaultValue: 'Bold all text' }), value: 'false', type: 'boolean' },
                { key: 'labelOpacity', label: t('orders.print.labelOpacity', { defaultValue: 'Labels opacity' }), value: '50', type: 'number' },
            ],
            createElement: (data: Record<string, string>, effectiveId?: string, printLangOverride?: string, renderOptions?: TemplatePreviewRenderOptions) => {
                const updatedOrder = {
                    ...order,
                    ...(kind === 'sales' ? { customerName: data.counterpartyName } : { supplierName: data.counterpartyName }),
                    notes: data.notes,
                }
                const baseLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
                const printLang = printLangOverride || baseLang
                return (
                    <OrderDetailsPrintTemplate
                        workspaceName={workspaceName}
                        printLang={printLang}
                        order={updatedOrder}
                        installments={installments}
                        kind={kind}
                        iqdPreference={features.iqd_display_preference}
                        logoUrl={features.logo_url}
                        qrValue={effectiveId ? `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/A4/${effectiveId}.pdf` : undefined}
                        hideUnit={data.hideUnit === 'true'}
                        productUnits={productUnits}
                        hideDiscount={data.hideDiscount === 'true'}
                        templateFields={data}
                        counterpartyPhone={data.counterpartyPhone}
                        counterpartyAddress={data.counterpartyAddress}
                        hiddenFields={renderOptions?.hiddenFields}
                        onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
                        workspaceFooterContacts={renderOptions?.workspaceFooterContacts || workspaceFooterContacts}
                        printVersion={customOrderPrint.selectedPrintVersion}
                    />
                )
            },
            buildPdf: async (element: ReactElement, printLangOverride?: string) => {
                const baseLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
                const printLang = printLangOverride || baseLang
                return generateTemplatePdf({
                    element,
                    format: 'a4',
                    printLang,
                })
            },
        }
    }, [resolved, features, installments, workspaceName, t, i18n, workspaceId, workspaceFooterContacts, counterpartyPhone, counterpartyAddress, productUnits, customOrderPrint.selectedPrintVersion])

    const orderReceiptPreview = useMemo<TemplatePreview | undefined>(() => {
        if (!resolved) return undefined
        const { order, kind } = resolved
        const counterpartyLabel = kind === 'sales'
            ? (t('orders.details.customer') || 'Customer')
            : (t('orders.details.supplier') || 'Supplier')
        const counterpartyName = kind === 'sales' ? (order as SalesOrder).customerName : (order as PurchaseOrder).supplierName

        return {
            // This is a thermal document, not an A4 layout. The preview needs
            // an explicit page size instead of its A4 fallback.
            page: { widthMm: 80, heightMm: 200 },
            fields: [
                { key: 'counterpartyName', label: counterpartyLabel, value: counterpartyName || '', type: 'text' },
                { key: 'counterpartyPhone', label: t('common.phone', { defaultValue: 'Phone' }), value: counterpartyPhone || '', type: 'text' },
                { key: 'notes', label: t('common.notes') || 'Notes', value: order.notes || '', type: 'text' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showExchangeRateSnapshots, label: t('sales.marketRatesSnapshot', { defaultValue: 'Show exchange rate snapshots' }), value: 'true', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showOriginalCurrencyPrice, label: t('orders.print.showOriginalCurrencyPrice', { defaultValue: 'Show original currency price' }), value: 'true', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showOrderAdjustments, label: t('orders.adjustments.showInPrint', { defaultValue: 'Show order adjustments' }), value: 'true', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.hideUnit, label: t('orders.form.hideUnit', { defaultValue: 'Hide Unit' }), value: localStorage.getItem('atlas_print_hide_unit') || 'false', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.hideDiscount, label: t('orders.form.hideDiscount', { defaultValue: 'Hide Discount' }), value: localStorage.getItem('atlas_print_hide_discount') || 'false', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showNotes, label: t('orders.print.showNotes', { defaultValue: 'Show notes' }), value: 'true', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.showContacts, label: t('orders.print.showContacts', { defaultValue: 'Show contacts' }), value: 'true', type: 'boolean' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.thankYou, label: t('sales.print.thankYou', { defaultValue: 'Thank-you text' }), value: '', type: 'text' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.keepRecord, label: t('sales.print.keepRecord', { defaultValue: 'Keep-record text' }), value: '', type: 'text' },
                { key: ORDER_RECEIPT_TEMPLATE_FIELD_KEYS.labelOpacity, label: t('orders.print.labelOpacity', { defaultValue: 'Labels opacity' }), value: '100', type: 'number' }
            ],
            createElement: (data: Record<string, string>, effectiveId?: string, printLangOverride?: string, renderOptions?: TemplatePreviewRenderOptions) => {
                const updatedOrder = {
                    ...order,
                    ...(kind === 'sales' ? { customerName: data.counterpartyName } : { supplierName: data.counterpartyName }),
                    notes: data.notes,
                }
                const baseLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
                const printLang = printLangOverride || baseLang

                return (
                    <OrderReceiptPrintTemplate
                        workspaceName={workspaceName}
                        printLang={printLang}
                        order={updatedOrder}
                        installments={installments}
                        kind={kind}
                        iqdPreference={features.iqd_display_preference}
                        logoUrl={features.logo_url}
                        qrValue={effectiveId ? `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/receipts/${effectiveId}.pdf` : undefined}
                        counterpartyPhone={data.counterpartyPhone}
                        workspaceFooterContacts={renderOptions?.workspaceFooterContacts || workspaceFooterContacts}
                        productUnits={productUnits}
                        templateFields={data}
                        editableFields={renderOptions?.editableFields}
                        onTemplateFieldChange={renderOptions?.onFieldChange}
                        componentPositions={renderOptions?.componentPositions}
                        editableComponents={renderOptions?.editableComponents}
                        onComponentPositionChange={renderOptions?.onComponentPositionChange}
                        printVersion={customOrderPrint.selectedPrintVersion}
                    />
                )
            },
            buildPdf: async (element: ReactElement, printLangOverride?: string) => {
                const baseLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
                return generateTemplatePdf({
                    element,
                    format: 'receipt',
                    printLang: printLangOverride || baseLang,
                })
            },
        }
    }, [resolved, features, installments, workspaceName, t, i18n, workspaceId, workspaceFooterContacts, counterpartyPhone, productUnits, customOrderPrint.selectedPrintVersion])

    const orderAtlasStandardPreview = useMemo<TemplatePreview | undefined>(() => {
        if (!resolved) return undefined
        const { order, kind } = resolved
        return {
            fields: [
                { key: ATLAS_STANDARD_ORDER_TEMPLATE_FIELD_KEYS.showOrderAdjustments, label: t('orders.adjustments.showInPrint', { defaultValue: 'Show order adjustments' }), value: 'true', type: 'boolean' }
            ],
            supportsBackgroundEdit: true,
            createElement: (data, _effectiveId, printLangOverride, renderOptions) => {
                const baseLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
                return (
                    <AtlasStandardOrderInvoiceTemplate
                        workspaceName={workspaceName}
                        printLang={printLangOverride || baseLang}
                        order={order}
                        installments={installments}
                        kind={kind}
                        iqdPreference={features.iqd_display_preference}
                        logoUrl={features.logo_url}
                        workspaceFooterContacts={renderOptions?.workspaceFooterContacts || workspaceFooterContacts}
                        businessPartner={bizPartner}
                        partnerAccountStatementBalances={partnerAccountStatementBalances}
                        partnerBalanceFallbackSnapshot={legacyOrderBalanceSnapshot}
                        printedBy={creatorName}
                        productImageUrls={productImageUrls}
                        hiddenFields={renderOptions?.hiddenFields}
                        onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
                        fieldLabelOverrides={renderOptions?.fieldLabelOverrides}
                        onFieldLabelChange={renderOptions?.onFieldLabelChange}
                        fieldDisplayModes={renderOptions?.fieldDisplayModes}
                        onFieldDisplayModeChange={renderOptions?.onFieldDisplayModeChange}
                        background={renderOptions?.background}
                        templateFields={data}
                        printVersion={customOrderPrint.selectedPrintVersion}
                    />
                )
            },
            buildPdf: async (element: ReactElement, printLangOverride?: string) => {
                const baseLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
                return generateTemplatePdf({ element, format: 'a4', printLang: printLangOverride || baseLang })
            }
        }
    }, [resolved, features, installments, workspaceName, t, i18n, bizPartner, partnerAccountStatementBalances, legacyOrderBalanceSnapshot, workspaceFooterContacts, creatorName, productImageUrls, customOrderPrint.selectedPrintVersion])

    const orderAtlasStandardReturnPreview = useMemo<TemplatePreview | undefined>(() => {
        if (!resolved || resolved.kind !== 'sales' || !returnPrintData) return undefined
        const { order } = resolved
        return {
            fields: [],
            supportsBackgroundEdit: true,
            createElement: (_data, _effectiveId, printLangOverride, renderOptions) => {
                const baseLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
                return (
                    <AtlasStandardOrderInvoiceTemplate
                        workspaceName={workspaceName}
                        printLang={printLangOverride || baseLang}
                        order={order}
                        installments={installments}
                        kind="sales"
                        iqdPreference={features.iqd_display_preference}
                        logoUrl={features.logo_url}
                        workspaceFooterContacts={renderOptions?.workspaceFooterContacts || workspaceFooterContacts}
                        businessPartner={bizPartner}
                        partnerAccountStatementBalances={partnerAccountStatementBalances}
                        partnerBalanceFallbackSnapshot={legacyOrderBalanceSnapshot}
                        printedBy={creatorName}
                        productImageUrls={productImageUrls}
                        hiddenFields={renderOptions?.hiddenFields}
                        onHiddenFieldChange={renderOptions?.onHiddenFieldChange}
                        fieldLabelOverrides={renderOptions?.fieldLabelOverrides}
                        onFieldLabelChange={renderOptions?.onFieldLabelChange}
                        fieldDisplayModes={renderOptions?.fieldDisplayModes}
                        onFieldDisplayModeChange={renderOptions?.onFieldDisplayModeChange}
                        background={renderOptions?.background}
                        returnPrintData={returnPrintData}
                        printVersion="returned"
                    />
                )
            },
            buildPdf: async (element: ReactElement, printLangOverride?: string) => {
                const baseLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
                return generateTemplatePdf({ element, format: 'a4', printLang: printLangOverride || baseLang })
            }
        }
    }, [resolved, features, installments, workspaceName, i18n, bizPartner, partnerAccountStatementBalances, legacyOrderBalanceSnapshot, workspaceFooterContacts, creatorName, productImageUrls, returnPrintData])

    if (!resolved) {
        return (
            <Card>
                <CardContent className="space-y-4 py-10 text-center">
                    <div className="text-lg font-semibold">{t('orders.details.notFound') || 'Order not found'}</div>
                    <div className="text-sm text-muted-foreground">{t('orders.details.notFoundDescription') || 'The order may have been deleted or moved out of this workspace.'}</div>
                    <div>
                        <Button variant="outline" onClick={() => navigate('/orders')}>
                            <ArrowLeft className="mr-2 h-4 w-4" />
                            {t('nav.orders') || 'Orders'}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        )
    }

    const isSales = resolved.kind === 'sales'
    const order = resolved.order
    const isApprovalRequested = isOrderApprovalRequested(order)
    const canEditOrder = canManage && order.status === 'draft' && (!isApprovalRequested || canApproveOrderRequests)
    const currency = order.currency
    const iqd = features.iqd_display_preference
    const orderAdjustments = normalizeOrderAdjustments(order.orderAdjustments, currency)
    const orderAdjustmentTotals = getOrderAdjustmentTotals(orderAdjustments)
    const adjustedOrderTotal = isSales
        ? getOrderTotalWithPostReturnAdjustments(order.total, orderAdjustments)
        : order.total
    const mainStorageId = isSales ? (order as SalesOrder).sourceStorageId : (order as PurchaseOrder).destinationStorageId
    const showFreeBonus = hasOrderLineFreeBonus(order.items)
    const totalUnits = order.items.reduce((sum, item) => sum + (isSales
        ? Math.max(0, getOrderLineInventoryQuantity(item) - (returnedQuantityByItemId.get(item.id) || 0))
        : getOrderLineInventoryQuantity(item)), 0)
    const totalFreeBonus = order.items.reduce((sum, item) => sum + getOrderLineFreeBonusQuantity(item), 0)
    const paidAmount = getOrderPaidAmount(order)
    const outstanding = getOrderBalanceAmount(order)
    const paymentStatus = getOrderPaymentStatus(order)
    const hasPendingDraftLoanRepayment = isDraftOrderLoanRepaymentPending(order)
    const isFullyReturnedSalesOrder = isSales && (order as SalesOrder).returnStatus === 'full'
    const canCreatePostReturnAdjustment = isSales
        && salesOrderReturns.length > 0
        && user?.role === 'admin'
        && !order.isLocked
    const isFinanced = order.paymentMethod === 'loan' || order.paymentMethod === 'installments' || !!order.linkedLoanId
    const linkedLoanRoute = linkedLoan
        ? linkedLoan.loanCategory === 'simple' ? `/loans/${linkedLoan.id}` : `/installments/${linkedLoan.id}`
        : null
    const nextInstallment = installments.find((installment) => installment.balanceAmount > 0)
    const profit = isSales
        ? order.total - (order as SalesOrder).items.reduce((sum, item) => sum + (
            item.convertedCostPrice * Math.max(0, getOrderLineInventoryQuantity(item) - (returnedQuantityByItemId.get(item.id) || 0))
        ), 0)
        : null
    const margin = profit !== null && order.total > 0 ? (profit / order.total) * 100 : null
    const receivedUnits = !isSales
        ? (order as PurchaseOrder).items.reduce((sum, item) => sum + (item.receivedQuantity ?? ((order.status === 'received' || order.status === 'completed') ? getOrderLineInventoryQuantity(item) : 0)), 0)
        : null
    const fulfilledUnitsAvailable = isSales && isFulfilledUnitsAvailableForOrder(order.createdAt, order.items)
    const fulfilledUnits = fulfilledUnitsAvailable
        ? (order as SalesOrder).items.reduce((sum, item) => sum + getOrderLineFulfilledQuantity(item, order.status === 'completed'), 0)
        : null
    const averageUnitCost = !isSales && totalUnits > 0 ? order.total / totalUnits : null

    const activity = [
        { id: 'created', date: order.createdAt, label: t('orders.details.activity.created') || 'Order created', amount: order.total },
        isApprovalRequested && order.approvalRequestedAt ? { id: 'approval-requested', date: order.approvalRequestedAt, label: t('orders.details.activity.approvalRequested', { defaultValue: 'Approval requested' }), amount: null } : null,
        order.approvalReviewedAt ? { id: 'approval-reviewed', date: order.approvalReviewedAt, label: t('orders.details.activity.approvalReviewed', { defaultValue: 'Request approved' }), amount: null } : null,
        order.expectedDeliveryDate ? { id: 'expected', date: order.expectedDeliveryDate, label: t('orders.details.activity.expected') || 'Expected delivery', amount: null } : null,
        isSales && (order as SalesOrder).reservedAt ? { id: 'reserved', date: (order as SalesOrder).reservedAt as string, label: t('orders.details.activity.reserved') || 'Inventory reserved', amount: null } : null,
        order.actualDeliveryDate ? { id: 'actual', date: order.actualDeliveryDate, label: isSales ? (t('orders.details.activity.completed') || 'Order completed') : (t('orders.details.activity.received') || 'Stock received'), amount: null } : null,
        order.paidAt ? { id: 'paid', date: order.paidAt, label: t('orders.details.activity.paid') || 'Payment recorded', amount: paidAmount } : null,
        isSales && salesOrderReturns[0] ? { id: 'returned', date: salesOrderReturns[0].returnedAt, label: t('sales.return.returnedStatus') || 'Returned', amount: null } : null
    ].filter(Boolean).sort((a, b) => new Date((b as any).date).getTime() - new Date((a as any).date).getTime()) as Array<{ id: string; date: string; label: string; amount: number | null }>

    const workflowSegments = [
        { id: 'created', color: '#3b82f6', reached: true },
        isApprovalRequested ? { id: 'approval-requested', color: '#94a3b8', reached: Boolean(order.approvalRequestedAt) } : null,
        isApprovalRequested ? { id: 'approval-reviewed', color: '#94a3b8', reached: Boolean(order.approvalReviewedAt) } : null,
        isSales ? { id: 'reserved', color: '#f59e0b', reached: Boolean((order as SalesOrder).reservedAt) } : null,
        { id: 'actual', color: 'hsl(var(--primary))', reached: Boolean(order.actualDeliveryDate) },
        { id: 'paid', color: '#10b981', reached: Boolean(order.paidAt) },
        isSales && salesOrderReturns[0] ? { id: 'returned', color: '#f59e0b', reached: true } : null
    ].filter(Boolean) as Array<{ id: string; color: string; reached: boolean }>

    const workflowFill = order.status === 'cancelled'
        ? { width: 100, background: 'linear-gradient(90deg, #f43f5e, #f43f5e)', backgroundSize: '100% 100%' }
        : buildWorkflowGradientFill(workflowSegments.map((segment) => ({ color: segment.color, reached: segment.reached })))
    const workflowPercent = order.status === 'cancelled'
        ? 100
        : Math.round((workflowSegments.filter((segment) => segment.reached).length / workflowSegments.length) * 100)

    const actions = isSales
        ? [
            isApprovalRequested && canApproveOrderRequests ? { key: 'approve', icon: BadgeCheck, label: t('orders.actions.approve', { defaultValue: 'Approve' }), onClick: () => runWorkflowAction('approve', () => approveSalesOrderRequest(order.id, user?.id ?? null), t('orders.actions.approveRequestSuccess', { defaultValue: 'Order request approved' })), variant: 'default' as const } : null,
            !isApprovalRequested && canManage && order.status === 'draft' ? { key: 'reserve', icon: PackageCheck, label: t('orders.actions.reserve') || 'Reserve', onClick: () => runWorkflowAction('reserve', () => updateSalesOrderStatus(order.id, 'pending'), t('orders.details.messages.reserveSuccess') || 'Sales order reserved'), variant: 'default' as const } : null,
            !isApprovalRequested && canManage && order.status === 'pending' ? { key: 'complete', icon: CircleCheck, label: t('orders.actions.complete') || 'Complete', onClick: () => runWorkflowAction('complete', () => updateSalesOrderStatus(order.id, 'completed'), t('orders.details.messages.completeSuccess') || 'Sales order completed'), variant: 'default' as const } : null,
            !isApprovalRequested && canManage && order.status === 'pending' ? { key: 'cancel', icon: XCircle, label: t('orders.actions.cancel') || 'Cancel', onClick: () => setCancelConfirm({ isOpen: true }), variant: 'outline' as const } : null
        ].filter(Boolean)
        : [
            isApprovalRequested && canApproveOrderRequests ? { key: 'approve', icon: BadgeCheck, label: t('orders.actions.approve', { defaultValue: 'Approve' }), onClick: () => runWorkflowAction('approve', () => approvePurchaseOrderRequest(order.id, user?.id ?? null), t('orders.actions.approveRequestSuccess', { defaultValue: 'Order request approved' })), variant: 'default' as const } : null,
            !isApprovalRequested && canManage && order.status === 'draft' ? { key: 'order', icon: ShoppingCart, label: t('orders.actions.order') || 'Order', onClick: () => runWorkflowAction('order', () => updatePurchaseOrderStatus(order.id, 'ordered'), t('orders.details.messages.orderSuccess') || 'Purchase order sent'), variant: 'default' as const } : null,
            !isApprovalRequested && canManage && order.status === 'ordered' ? { key: 'receive', icon: PackageCheck, label: t('orders.actions.receive') || 'Receive', onClick: () => runWorkflowAction('receive', () => updatePurchaseOrderStatus(order.id, 'received'), t('orders.details.messages.receiveSuccess') || 'Purchase order received'), variant: 'default' as const } : null,
            !isApprovalRequested && canManage && order.status === 'received' ? { key: 'complete', icon: CircleCheck, label: t('orders.actions.complete') || 'Complete', onClick: () => runWorkflowAction('complete', () => updatePurchaseOrderStatus(order.id, 'completed'), t('orders.details.messages.completeSuccess') || 'Purchase order completed'), variant: 'default' as const } : null,
            !isApprovalRequested && canManage && (order.status === 'draft' || order.status === 'ordered') ? { key: 'cancel', icon: XCircle, label: t('orders.actions.cancel') || 'Cancel', onClick: () => setCancelConfirm({ isOpen: true }), variant: 'outline' as const } : null
        ].filter(Boolean)

    const confirmDelete = async () => {
        setIsDeleting(true)
        try {
            if (isSales) await deleteSalesOrder(order.id)
            else await deletePurchaseOrder(order.id)
            toast({ title: t('orders.details.messages.deleteSuccess') || 'Order deleted successfully.' })
            setDeleteOpen(false)
            navigate('/orders')
        } catch (error: any) {
            toast({ title: t('orders.details.messages.deleteError') || 'Error', description: error?.message || 'Failed to delete order.', variant: 'destructive' })
        } finally {
            setIsDeleting(false)
        }
    }

    const handleLockConfirm = async () => {
        setIsLocking(true)
        try {
            if (isSales) await lockSalesOrder(order.id)
            else await lockPurchaseOrder(order.id)
            toast({ title: t('orders.details.messages.lockSuccess') || 'Order locked successfully' })
            setLockConfirm({ isOpen: false })
        } catch (error: any) {
            toast({
                title: t('orders.details.messages.lockError') || 'Error',
                description: error?.message || 'Locking failed',
                variant: 'destructive'
            })
        } finally {
            setIsLocking(false)
        }
    }

    const handleCancelConfirm = async () => {
        setIsCancelling(true)
        try {
            if (isSales) await updateSalesOrderStatus(order.id, 'cancelled')
            else await updatePurchaseOrderStatus(order.id, 'cancelled')
            toast({ title: t('orders.details.messages.cancelSuccess') || (isSales ? 'Sales order cancelled' : 'Purchase order cancelled') })
            setCancelConfirm({ isOpen: false })
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: getLocalizedOrderError(error, t, 'Cancellation failed'),
                variant: 'destructive'
            })
        } finally {
            setIsCancelling(false)
        }
    }

    const handleOrderSettlement = async (input: {
        paymentMethod: WorkspacePaymentMethod
        paidAt: string
        amount?: number
        note?: string
        accountId?: string | null
        accountNameSnapshot?: string | null
    }) => {
        if (!settlementTarget) {
            return
        }

        setIsSubmittingSettlement(true)
        try {
            await recordObligationSettlement(workspaceId, settlementTarget, {
                ...input,
                createdBy: user?.id || null
            })

            toast({
                title: settlementTarget.direction === 'incoming' ? 'Collection recorded' : 'Payment recorded'
            })
            setSettlementTarget(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to record settlement',
                variant: 'destructive'
            })
        } finally {
            setIsSubmittingSettlement(false)
        }
    }

    const handleOrderUnpay = async () => {
        const sourceType = isSales ? 'sales_order' : 'purchase_order'

        try {
            const transaction = await findLatestUnreversedPaymentTransaction(workspaceId, {
                sourceType,
                sourceRecordId: order.id
            })

            if (!transaction) {
                throw new Error('No posted payment was found for this order.')
            }

            setTransactionToReverse(transaction)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || 'Failed to reverse payment',
                variant: 'destructive'
            })
        }
    }

    const confirmOrderPaymentReversal = async (input: PaymentReversalDialogInput) => {
        if (!transactionToReverse || isReversingPayment) return

        setIsReversingPayment(true)
        try {
            await reversePaymentTransaction(workspaceId, transactionToReverse.id, {
                ...input,
                createdBy: user?.id || null
            })
            toast({ title: t('payments.reversed', { defaultValue: 'Transaction reversed' }) })
            setTransactionToReverse(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || t('payments.reverseFailed', { defaultValue: 'Failed to reverse payment.' }),
                variant: 'destructive'
            })
        } finally {
            setIsReversingPayment(false)
        }
    }

    const openWholeOrderReturn = () => {
        if (!resolved || resolved.kind !== 'sales') return
        const remainingItems = resolved.order.items.filter((item) => getReturnableQuantity(item) > 0)
        if (remainingItems.length === 0) {
            toast({
                title: t('common.error') || 'Error',
                description: t('orders.return.allItemsReturned', { defaultValue: 'All order items have already been returned.' }),
                variant: 'destructive'
            })
            return
        }
        setReturnTarget({ orderItemId: null, maxQuantity: 0, itemName: '' })
    }

    const openItemReturn = (item: SalesOrderItem) => {
        const maxQuantity = getReturnableQuantity(item)
        if (maxQuantity <= 0) return
        setReturnTarget({ orderItemId: item.id, maxQuantity, itemName: item.productName })
    }

    const handleOrderReturnConfirm = async (reason: string, quantity?: number) => {
        if (!resolved || resolved.kind !== 'sales' || !returnTarget) return

        let items: SalesOrderReturnLineInput[]
        if (returnTarget.orderItemId) {
            if (
                quantity === undefined
                || !isPositiveQuantity(quantity)
                || quantity > returnTarget.maxQuantity
            ) return

            items = [{ orderItemId: returnTarget.orderItemId, quantity }]
        } else {
            items = resolved.order.items
                .map((item) => ({ orderItemId: item.id, quantity: getReturnableQuantity(item) }))
                .filter((item) => item.quantity > 0)
        }
        if (items.length === 0) return

        setIsReturning(true)
        try {
            const result = await returnSalesOrder({
                orderId: resolved.order.id,
                items,
                reason,
                returnedBy: user?.id || null,
                actorRole: user?.role || null,
                ...(returnPaymentAccount
                    ? {
                        accountId: returnPaymentAccount.id,
                        accountNameSnapshot: returnPaymentAccount.name
                    }
                    : {})
            })
            toast({
                title: t('orders.return.title', { defaultValue: 'Return Order' }),
                description: result.order.returnStatus === 'full'
                    ? t('orders.return.successFull', { defaultValue: 'Order returned and payment reversed.' })
                    : t('orders.return.successPartial', { defaultValue: 'Order items returned and payment adjusted.' })
            })
            setReturnTarget(null)
            setReturnPaymentAccount(null)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: getLocalizedOrderError(error, t, 'Failed to return order'),
                variant: 'destructive'
            })
        } finally {
            setIsReturning(false)
        }
    }

    const handlePostReturnAdjustment = async (input: {
        returnId: string
        adjustment: Parameters<typeof createPostReturnSalesOrderAdjustment>[0]['adjustment']
        notes: string
    }) => {
        if (!salesOrder) return

        setIsSavingPostReturnAdjustment(true)
        try {
            await createPostReturnSalesOrderAdjustment({
                orderId: salesOrder.id,
                returnId: input.returnId,
                adjustment: input.adjustment,
                notes: input.notes,
                createdBy: user?.id || null,
                actorRole: user?.role || null
            })
            toast({
                title: t('orders.adjustments.postReturn.title', { defaultValue: 'Post-return adjustment' }),
                description: t('orders.adjustments.postReturn.saved', { defaultValue: 'The immutable correction was added to the selected return.' })
            })
            setIsPostReturnAdjustmentOpen(false)
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: getLocalizedOrderError(error, t, 'Failed to add post-return adjustment'),
                variant: 'destructive'
            })
        } finally {
            setIsSavingPostReturnAdjustment(false)
        }
    }

    return (
        <div
            className="space-y-4"
            data-tour-id={demoTutorial.state?.orderId === order.id ? 'tutorial-order-created' : undefined}
        >
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Link href="/orders" className="inline-flex items-center gap-1 hover:text-foreground">
                        <ArrowLeft className="h-4 w-4" />
                        {t('nav.orders') || 'Orders'}
                    </Link>
                    <span>/</span>
                    <span className="font-semibold text-foreground">{order.orderNumber}</span>
                    {isSales && (order as SalesOrder).sourceChannel === 'marketplace' ? (
                        <span className="inline-flex rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-sky-700 dark:text-sky-300">
                            {t('ecommerce.title', { defaultValue: 'E-Commerce' })}
                        </span>
                    ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {canEditOrder && (
                        <Button
                            variant="outline"
                            onClick={() => navigate(`/orders/edit/${isSales ? 'sales' : 'purchase'}/${order.id}`)}
                        >
                            <Pencil className="mr-2 h-4 w-4" />
                            {t('common.edit') || 'Edit'}
                        </Button>
                    )}
                    {actions.map((action) => {
                        if (!action) return null
                        const ActionIcon = action.icon
                        const isActionLoading = activeWorkflowAction === action.key
                        const isProgressAction = action.key !== 'cancel'

                        if (isProgressAction) {
                            return (
                                <div key={action.key} className="relative">
                                    <PressAndHoldButton
                                        variant={action.variant}
                                        icon={<ActionIcon className="mr-2 h-4 w-4" aria-hidden="true" />}
                                        disabled={activeWorkflowAction !== null}
                                        onPressStart={handleWorkflowPressStart}
                                        onComplete={() => {
                                            handleWorkflowAdvanceComplete()
                                            action.onClick()
                                        }}
                                        idleLabel={action.label}
                                        holdingLabel={t('orders.actions.keepHolding', { defaultValue: 'Keep holding…' })}
                                        loadingLabel={action.label}
                                        isLoading={isActionLoading}
                                        durationMs={ORDER_STATUS_ADVANCE_HOLD_DURATION_MS}
                                    />
                                    {showAdvanceHoldTip && (
                                        <div
                                            role="status"
                                            className="pointer-events-none absolute start-0 top-[calc(100%+0.5rem)] z-50 w-max max-w-72 rounded-lg border border-border bg-popover px-3 py-2 text-xs font-semibold text-popover-foreground shadow-lg"
                                        >
                                            {t('orders.actions.advanceHoldHint', {
                                                defaultValue: 'Press and hold the button to advance the order status.'
                                            })}
                                        </div>
                                    )}
                                </div>
                            )
                        }

                        return (
                            <Button
                                key={action.key}
                                variant={action.variant}
                                disabled={activeWorkflowAction !== null}
                                aria-busy={isActionLoading}
                                onClick={action.onClick}
                            >
                                {isActionLoading
                                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                                    : <ActionIcon className="mr-2 h-4 w-4" aria-hidden="true" />}
                                {action.label}
                            </Button>
                        )
                    })}
                    {!isApprovalRequested && canManage && isFinanced && linkedLoanRoute ? (
                        <Button variant="outline" onClick={() => navigate(linkedLoanRoute)}>
                            <CreditCard className="mr-2 h-4 w-4" />
                            {order.paymentMethod === 'installments'
                                ? t('orders.actions.openInstallments', { defaultValue: 'Open Installments' })
                                : t('orders.actions.openLoan', { defaultValue: 'Open Loan' })}
                        </Button>
                    ) : null}
                    {!isFullyReturnedSalesOrder && !isApprovalRequested && canManage && !isFinanced && outstanding > 0 && !order.isLocked && (
                        <Button
                            variant="outline"
                            onClick={() => setSettlementTarget(
                                isSales
                                    ? buildSalesOrderPaymentObligation(order as SalesOrder, nextInstallment)
                                    : buildPurchaseOrderPaymentObligation(order as PurchaseOrder, nextInstallment)
                            )}
                        >
                            <CreditCard className="mr-2 h-4 w-4" />
                            {t('orders.actions.recordPayment', { defaultValue: 'Record Payment' })}
                        </Button>
                    )}
                    {!isFullyReturnedSalesOrder && !isApprovalRequested && canManage && !isFinanced && paidAmount > 0 && !order.isLocked && (
                        <Button variant="outline" onClick={handleOrderUnpay}>
                            <RotateCcw className="mr-2 h-4 w-4" />
                            {t('orders.actions.reverseLastPayment', { defaultValue: 'Reverse Last Payment' })}
                        </Button>
                    )}
                    {!isFullyReturnedSalesOrder && !isApprovalRequested && canManage && paidAmount > 0 && !order.isLocked && (
                        <Button
                            variant="outline"
                            className="bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 hover:text-amber-700 border-amber-500/20"
                            onClick={() => setLockConfirm({ isOpen: true })}
                        >
                            <Lock className="mr-2 h-4 w-4" />
                            {t('orders.actions.lock') || 'Lock'}
                        </Button>
                    )}
                    {canReturnSalesOrder && (
                        <Button
                            variant="outline"
                            className="border-rose-500/30 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 hover:text-rose-800"
                            onClick={openWholeOrderReturn}
                            disabled={isReturning}
                        >
                            <RotateCcw className="mr-2 h-4 w-4" />
                            {t('orders.return.action', { defaultValue: 'Return Order' })}
                        </Button>
                    )}
                    {canCreatePostReturnAdjustment ? (
                        <Button
                            variant="outline"
                            className="border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 hover:text-amber-800"
                            onClick={() => setIsPostReturnAdjustmentOpen(true)}
                        >
                            <Plus className="mr-2 h-4 w-4" />
                            {t('orders.adjustments.postReturn.action', { defaultValue: 'Post-return adjustment' })}
                        </Button>
                    ) : null}
                    {canDelete && order.status === 'draft' && (
                        <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t('common.delete') || 'Delete'}
                        </Button>
                    )}
                    {orderInvoice && (
                        <Button
                            variant="outline"
                            onClick={handleShowInvoice}
                            disabled={isLoadingOrderInvoice}
                            className="gap-2 print:hidden bg-background"
                        >
                            <Eye className="h-4 w-4" />
                            {isLoadingOrderInvoice
                                ? (t('common.loading') || 'Loading...')
                                : (t('orders.actions.showPrintedInvoice') || 'Show Printed Invoice (PDF)')}
                        </Button>
                    )}
                    <Button
                        variant="outline"
                        onClick={() => {
                            customOrderPrint.resetSelection()
                            setShowPrintPreview(true)
                        }}
                        className="gap-2 print:hidden bg-background"
                    >
                        <Printer className="h-4 w-4" />
                        {t('common.print') || 'Print'}
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="space-y-4">
                    <Card>
                        <CardHeader><CardTitle>{isSales ? (t('orders.details.customer') || 'Customer') : (t('orders.details.supplier') || 'Supplier')}</CardTitle></CardHeader>
                        <CardContent className="space-y-3 text-sm">
                            <div className="flex items-start gap-3 rounded-2xl border bg-muted/20 p-4">
                                <div className="rounded-xl bg-primary/10 p-2 text-primary">
                                    {isSales ? <UsersRound className="h-4 w-4" /> : <Truck className="h-4 w-4" />}
                                </div>
                                <div className="min-w-0">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{isSales ? (t('orders.details.customer') || 'Customer') : (t('orders.details.supplier') || 'Supplier')}</div>
                                    <div className="truncate text-lg font-semibold">{isSales ? (order as SalesOrder).customerName : (order as PurchaseOrder).supplierName}</div>
                                </div>
                            </div>
                            <div className="rounded-2xl border bg-background/70 p-4">
                                <div className="flex items-start gap-3">
                                    <Warehouse className="mt-0.5 h-4 w-4 text-muted-foreground" />
                                    <div>
                                        <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{isSales ? (t('orders.details.sourceStorage') || 'Source Storage') : (t('orders.details.destinationStorage') || 'Destination Storage')}</div>
                                        <div className="font-medium">{storageName(mainStorageId)}</div>
                                    </div>
                                </div>
                            </div>
                            {isSales && (order as SalesOrder).shippingAddress && (
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('orders.details.shippingAddress') || 'Shipping Address'}</div>
                                    <div className="mt-1 whitespace-pre-wrap">{(order as SalesOrder).shippingAddress}</div>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {isSales && salesAgentCommissionsEnabled && productCommissionPreviewAgentIds.length > 0 ? (
                        <ProductCommissionPreview
                            workspaceId={workspaceId}
                            items={productCommissionPreviewItems}
                            agentIds={productCommissionPreviewAgentIds}
                            agents={productCommissionPreviewAgents}
                            currency={currency}
                            exchangeRates={(order as SalesOrder).exchangeRates ?? []}
                            iqdPreference={iqd}
                            showTotal
                            orderId={order.id}
                            orderReference={(order as SalesOrder).orderNumber}
                            canPayCommission={canPaySalesAgentCommissions}
                            onSettleCommission={setSettlementTarget}
                        />
                    ) : null}

                    {installments.length > 0 ? (
                        <Card>
                            <CardHeader>
                                <CardTitle>{t('orders.details.installmentSchedule', { defaultValue: 'Installment Schedule' })}</CardTitle>
                            </CardHeader>
                            <CardContent className="px-3 sm:px-6">
                                <div className="divide-y overflow-hidden rounded-2xl border">
                                    {installments.map((installment) => {
                                        const canPayInstallment = !isApprovalRequested && canManage && installment.balanceAmount > 0 && !order.isLocked
                                        return (
                                            <div key={installment.id} className="space-y-3 p-3">
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <div className="flex min-w-0 items-center gap-3">
                                                        <span className="font-bold">#{installment.installmentNo}</span>
                                                        <span className="text-sm text-muted-foreground">
                                                            {formatDate(installment.dueDate)}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className={cn(
                                                            'inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide',
                                                            installment.status === 'paid'
                                                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                                                : installment.status === 'overdue'
                                                                    ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                                                                    : installment.status === 'partial'
                                                                        ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
                                                                        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                                        )}>
                                                            {t(`orders.installmentStatus.${installment.status}`, { defaultValue: installment.status })}
                                                        </span>
                                                        {canPayInstallment ? (
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                className="h-8 px-3"
                                                                onClick={() => linkedLoanRoute
                                                                    ? navigate(linkedLoanRoute)
                                                                    : setSettlementTarget(
                                                                        isSales
                                                                            ? buildSalesOrderPaymentObligation(order as SalesOrder, installment)
                                                                            : buildPurchaseOrderPaymentObligation(order as PurchaseOrder, installment)
                                                                    )}
                                                            >
                                                                {t('orders.actions.payInstallment', { defaultValue: 'Pay' })}
                                                            </Button>
                                                        ) : null}
                                                    </div>
                                                </div>

                                                <div className="grid grid-cols-3 gap-2">
                                                    <InstallmentAmount
                                                        label={t('orders.details.plannedAmount', { defaultValue: 'Planned' })}
                                                        value={formatCurrency(installment.plannedAmount, currency, iqd)}
                                                    />
                                                    <InstallmentAmount
                                                        label={t('orders.details.paidAmount', { defaultValue: 'Paid' })}
                                                        value={formatCurrency(installment.paidAmount, currency, iqd)}
                                                        valueClassName="text-emerald-600"
                                                    />
                                                    <InstallmentAmount
                                                        label={t('orders.details.outstanding') || 'Outstanding'}
                                                        value={formatCurrency(installment.balanceAmount, currency, iqd)}
                                                        valueClassName="font-bold"
                                                    />
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            </CardContent>
                        </Card>
                    ) : null}

                    <Card>
                        <CardHeader><CardTitle>{t('orders.details.commercials') || 'Commercials'}</CardTitle></CardHeader>
                        <CardContent className="grid gap-3 text-sm">
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                                <div className="rounded-2xl border bg-muted/20 p-3">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('orders.details.created') || 'Created'}</div>
                                    <div className="mt-1 font-medium">{formatDateTime(order.createdAt)}</div>
                                </div>
                                {(order as any).createdBy && (
                                    <div className="rounded-2xl border bg-muted/20 p-3">
                                        <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('orders.details.createdBy') || 'Created By'}</div>
                                        <div className="mt-1 font-medium flex items-center gap-2">
                                            <UsersRound className="h-3.5 w-3.5 text-muted-foreground" />
                                            {creatorName || (isCreatorProfileLoading
                                                ? t('common.loading', { defaultValue: 'Loading…' })
                                                : t('common.unknown', { defaultValue: 'Unknown' }))}
                                        </div>
                                    </div>
                                )}
                                <div className="rounded-2xl border bg-muted/20 p-3">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('orders.details.expectedDelivery') || 'Expected Delivery'}</div>
                                    <div className="mt-1 font-medium">{order.expectedDeliveryDate ? formatDateTime(order.expectedDeliveryDate) : 'N/A'}</div>
                                </div>
                            </div>
                            <div className="rounded-2xl border bg-background/70 p-4">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('pos.paymentMethod') || 'Payment Method'}</div>
                                        <div className="mt-1 font-medium">{paymentLabel(t, order.paymentMethod)}</div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('pos.currency') || 'Currency'}</div>
                                        <div className="mt-1 font-medium">{currency.toUpperCase()}</div>
                                    </div>
                                </div>
                            </div>
                            {order.items.some(item => item.originalCurrency !== item.settlementCurrency) && order.exchangeRates && order.exchangeRates.length > 0 && (
                                <div className="rounded-2xl border border-primary/10 bg-primary/5 p-4 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <TrendingUp className="w-4 h-4 text-primary" />
                                            <span className="text-xs font-bold uppercase tracking-[0.14em] text-primary">
                                                {t('sales.marketRatesSnapshot') || 'Market Rates Snapshot'}
                                            </span>
                                        </div>
                                        <span className="text-[10px] text-muted-foreground italic">
                                            {t('sales.ratesLockedAt') || 'Rates locked at'}: {formatSnapshotTime(order.exchangeRates[0].timestamp)}
                                        </span>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                        {order.exchangeRates.map((rate, idx) => (
                                            <div key={idx} className="bg-card border border-primary/10 shadow-sm rounded-sm p-3 space-y-1 relative overflow-hidden">
                                                {rate.source && (
                                                    <div className="absolute top-0 right-0 px-1.5 py-0.5 bg-primary/10 text-primary text-[8px] font-bold uppercase tracking-wider rounded-bl-sm border-l border-b border-primary/5">
                                                        {rate.source}
                                                    </div>
                                                )}
                                                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                                                    {rate.pair}
                                                </div>
                                                <div className="flex items-baseline gap-2">
                                                    <span className="text-base font-black">100 {rate.pair.split('/')[0]}</span>
                                                    <span className="text-sm text-muted-foreground font-medium">
                                                        {formatCurrency(rate.rate, rate.pair.split('/')[1].toLowerCase() as any, iqd)}
                                                    </span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {order.notes && (
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">{t('orders.details.notes') || 'Notes'}</div>
                                    <div className="mt-2 whitespace-pre-wrap">{order.notes}</div>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader><CardTitle>{t('loans.recentActivity', { defaultValue: 'Recent Activity' })}</CardTitle></CardHeader>
                        <CardContent>
                            <div className="relative ps-4 space-y-6 before:absolute before:start-0 before:top-2 before:bottom-2 before:w-0.5 before:bg-border/60">
                                {activity.slice(0, 8).map(row => {
                                    const isCreated = row.id === 'created'
                                    return (
                                        <div key={row.id} className="relative group">
                                            <div className={cn(
                                                "absolute -start-[1.375rem] top-1.5 w-3 h-3 rounded-full border-2 border-background z-10 transition-transform group-hover:scale-125",
                                                row.id === 'paid'
                                                    ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]'
                                                    : row.id === 'returned'
                                                        ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                                                    : row.id === 'reserved'
                                                        ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.4)]'
                                                    : isCreated
                                                        ? "bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.4)]"
                                                        : row.id === 'actual'
                                                            ? "bg-primary"
                                                            : "bg-slate-400"
                                            )} />
                                            <div className="space-y-0.5">
                                                <div className="font-bold text-sm leading-none transition-colors group-hover:text-primary">
                                                    {row.label}
                                                </div>
                                                <div className="text-muted-foreground text-xs font-medium flex items-center gap-1.5 pt-1">
                                                    <span>{formatDateTime(row.date)}</span>
                                                    {row.amount !== null ? (
                                                        <>
                                                            <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                                                            <span className="font-bold text-foreground/80">
                                                                {formatCurrency(row.amount, currency, iqd)}
                                                            </span>
                                                        </>
                                                    ) : null}
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <div className="space-y-4 lg:col-span-2">
                    <Card className={cn(
                        'overflow-hidden border-border/60',
                        isApprovalRequested
                            ? 'bg-gradient-to-br from-violet-500/15 via-background to-amber-500/10'
                            : isSales ? 'bg-gradient-to-br from-primary/10 via-background to-emerald-500/10' : 'bg-gradient-to-br from-sky-500/10 via-background to-cyan-500/10'
                    )}>
                        <CardContent className="p-6">
                            <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
                                <div className="space-y-4">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className={cn('inline-flex items-center rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em]', isSales ? 'border-primary/20 bg-primary/10 text-primary' : 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300')}>
                                            {isSales ? (t('orders.details.salesOrder') || 'Sales Order') : (t('orders.details.purchaseOrder') || 'Purchase Order')}
                                        </span>
                                        <OrderStatusBadge
                                            status={isApprovalRequested ? 'approval_requested' : order.status}
                                            label={isApprovalRequested
                                                ? t('orders.status.requested', { defaultValue: 'Requested' })
                                                : statusLabel(t, order.status)}
                                        />
                                        {isSales && (order as SalesOrder).returnStatus === 'full' ? (
                                            <OrderStatusBadge status="returned" label={t('sales.return.returnedStatus') || 'Returned'} />
                                        ) : isSales && (order as SalesOrder).returnStatus === 'partial' ? (
                                            <OrderStatusBadge status="partially_returned" label={t('sales.return.partialReturn') || 'Partially Returned'} />
                                        ) : null}
                                        <span className={cn(
                                            'inline-flex items-center rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em]',
                                            isFullyReturnedSalesOrder
                                                ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                                                : hasPendingDraftLoanRepayment
                                                    ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
                                                : paymentStatus === 'paid'
                                                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                                : paymentStatus === 'partial'
                                                    ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
                                                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                                        )}>
                                            {isFullyReturnedSalesOrder
                                                ? (t('sales.return.returnedStatus') || 'Returned')
                                                : hasPendingDraftLoanRepayment
                                                    ? t('orders.draftFinancing.pendingActivation')
                                                : paymentStatus === 'paid'
                                                ? (t('orders.status.paid') || 'Paid')
                                                : paymentStatus === 'partial'
                                                    ? t('orders.status.partial', { defaultValue: 'Partially Paid' })
                                                    : t('orders.status.unpaid', { defaultValue: 'Unpaid' })}
                                        </span>
                                        {order.isLocked && (
                                            <span className="inline-flex items-center gap-1 rounded-full bg-slate-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-slate-700 dark:text-slate-300 shadow-sm border border-slate-500/20">
                                                <Lock className="h-2.5 w-2.5" />
                                                {t('orders.details.locked') || 'Locked'}
                                            </span>
                                        )}
                                    </div>
                                    <div>
                                        <div className="text-sm font-medium text-muted-foreground">{isSales ? (t('orders.details.salesOrderNumber') || 'Sales order number') : (t('orders.details.purchaseOrderNumber') || 'Purchase order number')}</div>
                                        <div className="mt-1 text-3xl font-black tracking-tight">{order.orderNumber}</div>
                                        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                            <span className="inline-flex items-center gap-1.5">{isSales ? <UsersRound className="h-4 w-4" /> : <Truck className="h-4 w-4" />}{isSales ? (order as SalesOrder).customerName : (order as PurchaseOrder).supplierName}</span>
                                            <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                                            <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4" />{formatDate(order.createdAt)}</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="rounded-3xl border border-border/50 bg-background/80 p-5 shadow-sm">
                                    <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">{t('common.total') || 'Total'}</div>
                                    <div className="mt-2 text-4xl font-black tracking-tight">{formatCurrency(order.total, currency, iqd)}</div>
                                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                                        <div>
                                            <div className="text-xs text-muted-foreground">{hasPendingDraftLoanRepayment
                                                ? t('orders.draftFinancing.plannedInitialRepayment')
                                                : t('orders.details.paidAmount', { defaultValue: 'Paid' })}</div>
                                            <div className={cn('font-semibold', hasPendingDraftLoanRepayment ? 'text-violet-600' : 'text-emerald-600')}>
                                                {formatCurrency(paidAmount, currency, iqd)}
                                            </div>
                                            {hasPendingDraftLoanRepayment ? (
                                                <div className="mt-0.5 text-xs text-muted-foreground">{t('orders.draftFinancing.notPostedYet')}</div>
                                            ) : null}
                                        </div>
                                        <div>
                                            <div className="text-xs text-muted-foreground">{t('orders.details.outstanding') || 'Outstanding'}</div>
                                            <div className="font-semibold">{formatCurrency(outstanding, currency, iqd)}</div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {hasPendingDraftLoanRepayment ? (
                                <div className="mt-4 flex items-start gap-2 rounded-2xl border border-violet-500/20 bg-violet-500/5 px-4 py-3 text-sm text-violet-900 dark:text-violet-100">
                                    <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
                                    <p>{t('orders.draftFinancing.activationNotice', {
                                        amount: formatCurrency(order.initialPaymentAmount, currency, iqd)
                                    })}</p>
                                </div>
                            ) : null}

                            <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.items') || 'Items'}</div>
                                    <div className="mt-2 text-2xl font-black">{order.items.length}</div>
                                </div>
                                <div className="rounded-2xl border bg-background/70 p-4">
                                    <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.units') || 'Units'}</div>
                                    <div className="mt-2 text-2xl font-black">{totalUnits}</div>
                                </div>
                                {isSales ? (
                                    <div className="rounded-2xl border bg-background/70 p-4">
                                        <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.fulfilledUnits') || 'Fulfilled Units'}</div>
                                        <div className="mt-2 text-2xl font-black">{fulfilledUnitsAvailable ? fulfilledUnits : (t('orders.details.notAvailable') || 'Not Available')}</div>
                                    </div>
                                ) : null}
                                {showFreeBonus ? (
                                    <div className="rounded-2xl border bg-background/70 p-4">
                                        <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.freeBonus', { defaultValue: 'Free Bonus' })}</div>
                                        <div className="mt-2 text-2xl font-black">{totalFreeBonus}</div>
                                    </div>
                                ) : null}
                                {isSales && canViewProfit && profit !== null ? (
                                    <>
                                        <div className="rounded-2xl border bg-background/70 p-4">
                                            <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.grossProfit') || 'Gross Profit'}</div>
                                            <div className={cn('mt-2 text-2xl font-black', profit >= 0 ? 'text-emerald-600' : 'text-rose-600')}>{formatCurrency(profit, currency, iqd)}</div>
                                        </div>
                                        <div className="rounded-2xl border bg-background/70 p-4">
                                            <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.margin') || 'Margin'}</div>
                                            <div className="mt-2 text-2xl font-black">{margin?.toFixed(1)}%</div>
                                        </div>
                                    </>
                                ) : null}
                                {!isSales && receivedUnits !== null ? (
                                    <>
                                        <div className="rounded-2xl border bg-background/70 p-4">
                                            <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.receivedUnits') || 'Received Units'}</div>
                                            <div className="mt-2 text-2xl font-black">{receivedUnits}</div>
                                        </div>
                                        <div className="rounded-2xl border bg-background/70 p-4">
                                            <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.averageUnitCost') || 'Average Unit Cost'}</div>
                                            <div className="mt-2 text-2xl font-black">{formatCurrency(averageUnitCost || 0, currency, iqd)}</div>
                                        </div>
                                    </>
                                ) : null}
                            </div>

                            <div className="mt-6 space-y-2">
                                <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                                    <span>{order.status === 'cancelled' ? (t('orders.details.workflowStopped') || 'Workflow Stopped') : (t('orders.details.workflowProgress') || 'Workflow Progress')}</span>
                                    <span>{workflowPercent}%</span>
                                </div>
                                <div className="h-2 overflow-hidden rounded-full bg-background/80">
                                    <div
                                        className="h-full rounded-full transition-all duration-500"
                                        style={{
                                            width: `${workflowFill.width}%`,
                                            background: workflowFill.background,
                                            backgroundSize: workflowFill.backgroundSize,
                                            backgroundRepeat: 'no-repeat'
                                        }}
                                    />
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <CardTitle>{t('orders.details.orderItems') || 'Order Items'}</CardTitle>
                            <div className="hidden items-center rounded-lg border bg-muted/30 p-1 md:flex">
                                <Button variant="ghost" size="sm" onClick={() => setViewMode('table')} className={cn('h-8 gap-1.5 px-3 text-[10px] font-black uppercase tracking-[0.16em]', viewMode === 'table' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground')}>
                                    <List className="h-3 w-3" />{t('common.table') || 'Table'}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setViewMode('grid')} className={cn('h-8 gap-1.5 px-3 text-[10px] font-black uppercase tracking-[0.16em]', viewMode === 'grid' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground')}>
                                    <LayoutGrid className="h-3 w-3" />{t('common.grid') || 'Grid'}
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {viewMode === 'grid' ? (
                                <div className="grid gap-4 md:grid-cols-2">
                                    {order.items.map((item) => {
                                        const salesItem = item as SalesOrderItem
                                        const purchaseItem = item as PurchaseOrderItem
                                         const paidQuantity = getOrderLinePaidQuantity(item)
                                         const freeBonusQuantity = getOrderLineFreeBonusQuantity(item)
                                         const inventoryQuantity = getOrderLineInventoryQuantity(item)
                                         const returnedQuantity = isSales ? (returnedQuantityByItemId.get(item.id) || 0) : 0
                                         const returnedAmount = isSales ? (returnedAmountByItemId.get(item.id) || 0) : 0
                                         const returnState = isSales
                                             ? getOrderPrintReturnState(item, { returnedQuantity, returnedAmount })
                                             : null
                                         const hasReturnAdjustment = Boolean(returnState && returnState.status !== 'active')
                                         const remainingQuantity = returnState?.remainingQuantity ?? paidQuantity
                                         const remainingInventoryQuantity = Math.max(0, inventoryQuantity - returnedQuantity)
                                         const isItemFullyReturned = returnState?.status === 'fully-returned'
                                         const hasItemPartialReturn = returnState?.status === 'partially-returned'
                                         const remainingLineTotal = returnState?.remainingLineTotal ?? item.lineTotal
                                         const originalItemProfit = isSales ? item.lineTotal - (salesItem.convertedCostPrice * inventoryQuantity) : 0
                                         const itemProfit = isSales ? remainingLineTotal - (salesItem.convertedCostPrice * remainingInventoryQuantity) : 0
                                         const itemReceived = !isSales ? purchaseItem.receivedQuantity ?? ((order.status === 'received' || order.status === 'completed') ? inventoryQuantity : 0) : 0
                                         const returnableQuantity = isSales ? getReturnableQuantity(salesItem) : 0
                                         const itemUnit = item.unit?.trim() || productUnits[item.productId]?.trim() || ''
                                         const itemUnitLabel = itemUnit ? t(`products.units.${itemUnit}`, itemUnit) : ''
                                         const freeBonusItemUnit = item.freeBonusUnit?.trim() || itemUnit
                                         const freeBonusItemUnitLabel = freeBonusItemUnit ? t(`products.units.${freeBonusItemUnit}`, freeBonusItemUnit) : ''

                                         return (
                                             <div key={item.id} className={cn(
                                                 'rounded-3xl border bg-background/80 p-4 shadow-sm',
                                                 isItemFullyReturned ? 'border-rose-500/30 bg-rose-500/5' : hasItemPartialReturn ? 'border-orange-500/30 bg-orange-500/5' : ''
                                             )}>
                                                <div className="flex items-start justify-between gap-3">
                                                    <div>
                                                        <div className="text-lg font-semibold">{item.productName}</div>
                                                        <div className="text-xs text-muted-foreground">{item.productSku || 'N/A'}</div>
                                                        {isSales && salesItem.batchAllocations?.length ? (
                                                            <div className="mt-1 text-xs font-medium text-primary">
                                                                {t('orders.form.batch', { defaultValue: 'Batch' })}: {salesItem.batchAllocations.map((allocation) => `${allocation.batchNumber} (${allocation.quantity})`).join(', ')}
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                    <div className={cn(
                                                        'rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em]',
                                                        isItemFullyReturned ? 'bg-rose-500/10 text-rose-700' : hasItemPartialReturn ? 'bg-orange-500/10 text-orange-700' : 'bg-primary/10 text-primary'
                                                    )}>
                                                        {isSales ? remainingInventoryQuantity : inventoryQuantity} {t('orders.details.units') || 'units'}
                                                    </div>
                                                </div>
                                                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                                    <div className="rounded-2xl border bg-muted/20 p-3">
                                                        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{isSales ? (t('orders.details.sourceStorage') || 'Source Storage') : (t('orders.details.destinationStorage') || 'Destination Storage')}</div>
                                                        <div className="mt-1 font-medium">{storageName(item.storageId || mainStorageId)}</div>
                                                    </div>
                                                    <div className="rounded-2xl border bg-muted/20 p-3">
                                                        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.form.table.qty') || 'Qty'}</div>
                                                        {hasReturnAdjustment ? (
                                                            <ReturnedOrderValue
                                                                className="mt-1 items-start"
                                                                currentValue={`${remainingQuantity}${itemUnitLabel ? ` ${itemUnitLabel}` : ''}`}
                                                                originalValue={`${paidQuantity}${itemUnitLabel ? ` ${itemUnitLabel}` : ''}`}
                                                            />
                                                        ) : <div className="mt-1 font-medium">{paidQuantity}{itemUnitLabel ? ` ${itemUnitLabel}` : ''}</div>}
                                                    </div>
                                                    {showFreeBonus ? (
                                                        <div className="rounded-2xl border bg-muted/20 p-3">
                                                            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.freeBonus', { defaultValue: 'Free Bonus' })}</div>
                                                            <div className="mt-1 font-medium">{freeBonusQuantity}{freeBonusItemUnitLabel ? ` ${freeBonusItemUnitLabel}` : ''}</div>
                                                        </div>
                                                    ) : null}
                                                    <div className="rounded-2xl border bg-muted/20 p-3">
                                                        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.lineTotal') || 'Line Total'}</div>
                                                        {hasReturnAdjustment ? (
                                                            <ReturnedOrderValue
                                                                className="mt-1 items-start"
                                                                currentValue={formatCurrency(remainingLineTotal, currency, iqd)}
                                                                originalValue={formatCurrency(item.lineTotal, currency, iqd)}
                                                            />
                                                        ) : <div className="mt-1 font-medium">{formatCurrency(item.lineTotal, currency, iqd)}</div>}
                                                    </div>
                                                    <div className="rounded-2xl border bg-muted/20 p-3">
                                                        <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{t('orders.details.unitPrice') || 'Unit Price'}</div>
                                                        <div className="mt-1 font-medium">{formatCurrency(item.convertedUnitPrice, currency, iqd)}</div>
                                                    </div>
                                                    {(!isSales || canViewProfit) && (
                                                        <div className="rounded-2xl border bg-muted/20 p-3">
                                                            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">{isSales ? (t('orders.details.itemProfit') || 'Item Profit') : (t('orders.details.receivedUnits') || 'Received Units')}</div>
                                                            {isSales && hasReturnAdjustment ? (
                                                                <ReturnedOrderValue
                                                                    className="mt-1 items-start"
                                                                    currentValue={formatCurrency(itemProfit, currency, iqd)}
                                                                    originalValue={formatCurrency(originalItemProfit, currency, iqd)}
                                                                    currentValueClassName={itemProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}
                                                                />
                                                            ) : (
                                                                <div className={cn('mt-1 font-medium', isSales && itemProfit >= 0 ? 'text-emerald-600' : isSales ? 'text-rose-600' : '')}>
                                                                    {isSales ? formatCurrency(itemProfit, currency, iqd) : itemReceived}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                                 {isSales && returnedQuantity > 0 ? (
                                                     <div className={cn('mt-3 text-xs font-semibold', isItemFullyReturned ? 'text-rose-700' : 'text-orange-700')}>
                                                         {t('orders.return.returnedQuantity', {
                                                             returned: returnedQuantity,
                                                             total: inventoryQuantity,
                                                             defaultValue: `Returned: ${returnedQuantity} / ${inventoryQuantity}`
                                                         })}
                                                     </div>
                                                ) : null}
                                                {canReturnSalesOrder && returnableQuantity > 0 ? (
                                                    <Button variant="outline" size="sm" className="mt-4 w-full border-rose-500/30 text-rose-700 hover:bg-rose-500/10" onClick={() => openItemReturn(salesItem)} disabled={isReturning}>
                                                        <RotateCcw className="mr-2 h-3.5 w-3.5" />
                                                        {t('orders.return.itemAction', { defaultValue: 'Return' })} ({returnableQuantity})
                                                    </Button>
                                                ) : null}
                                            </div>
                                        )
                                    })}
                                </div>
                            ) : (
                                <div className="overflow-x-auto rounded-2xl border">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>{t('products.title') || 'Product'}</TableHead>
                                                <TableHead>{isSales ? (t('orders.details.sourceStorage') || 'Source Storage') : (t('orders.details.destinationStorage') || 'Destination Storage')}</TableHead>
                                                <TableHead className="text-end">{t('orders.form.table.qty') || 'Qty'}</TableHead>
                                                {showFreeBonus && <TableHead className="text-end">{t('orders.details.freeBonus', { defaultValue: 'Free Bonus' })}</TableHead>}
                                                {!isSales && <TableHead className="text-end">{t('orders.details.received') || 'Received'}</TableHead>}
                                                <TableHead className="text-end">{t('orders.form.table.price') || 'Unit Price'}</TableHead>
                                                {isSales && canViewProfit && <TableHead className="text-end">{t('orders.details.costPerUnit') || 'Cost / Unit'}</TableHead>}
                                                <TableHead className="text-end">{t('common.total') || 'Total'}</TableHead>
                                                {isSales && canViewProfit && <TableHead className="text-end">{t('orders.details.itemProfit') || 'Item Profit'}</TableHead>}
                                                {canReturnSalesOrder && <TableHead className="text-end">{t('common.actions') || 'Actions'}</TableHead>}
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {order.items.map((item) => {
                                                const salesItem = item as SalesOrderItem
                                                const purchaseItem = item as PurchaseOrderItem
                                                 const paidQuantity = getOrderLinePaidQuantity(item)
                                                 const freeBonusQuantity = getOrderLineFreeBonusQuantity(item)
                                                 const inventoryQuantity = getOrderLineInventoryQuantity(item)
                                                 const returnedQuantity = isSales ? (returnedQuantityByItemId.get(item.id) || 0) : 0
                                                 const returnedAmount = isSales ? (returnedAmountByItemId.get(item.id) || 0) : 0
                                                 const returnState = isSales
                                                     ? getOrderPrintReturnState(item, { returnedQuantity, returnedAmount })
                                                     : null
                                                 const hasReturnAdjustment = Boolean(returnState && returnState.status !== 'active')
                                                 const remainingQuantity = returnState?.remainingQuantity ?? paidQuantity
                                                 const remainingInventoryQuantity = Math.max(0, inventoryQuantity - returnedQuantity)
                                                 const isItemFullyReturned = returnState?.status === 'fully-returned'
                                                 const hasItemPartialReturn = returnState?.status === 'partially-returned'
                                                 const remainingLineTotal = returnState?.remainingLineTotal ?? item.lineTotal
                                                 const itemReceived = purchaseItem.receivedQuantity ?? ((order.status === 'received' || order.status === 'completed') ? inventoryQuantity : 0)
                                                 const originalItemProfit = isSales ? item.lineTotal - (salesItem.convertedCostPrice * inventoryQuantity) : 0
                                                 const itemProfit = isSales ? remainingLineTotal - (salesItem.convertedCostPrice * remainingInventoryQuantity) : 0
                                                 const returnableQuantity = isSales ? getReturnableQuantity(salesItem) : 0
                                                 const itemUnit = item.unit?.trim() || productUnits[item.productId]?.trim() || ''
                                                 const itemUnitLabel = itemUnit ? t(`products.units.${itemUnit}`, itemUnit) : ''
                                                 const freeBonusItemUnit = item.freeBonusUnit?.trim() || itemUnit
                                                 const freeBonusItemUnitLabel = freeBonusItemUnit ? t(`products.units.${freeBonusItemUnit}`, freeBonusItemUnit) : ''

                                                 return (
                                                    <TableRow key={item.id} className={cn(
                                                        isItemFullyReturned ? 'bg-rose-500/5' : hasItemPartialReturn ? 'bg-orange-500/5' : ''
                                                    )}>
                                                        <TableCell>
                                                            <div className="flex min-w-[12rem] items-start gap-3">
                                                                <OrderProductAvatar
                                                                    productId={item.productId}
                                                                    productName={item.productName}
                                                                    productImageUrls={productImageUrls}
                                                                />
                                                                <div className="min-w-0">
                                                                    <div className={cn('font-semibold', isItemFullyReturned && 'line-through opacity-50')}>{item.productName}</div>
                                                                    <div className="text-xs text-muted-foreground">{item.productSku || 'N/A'}</div>
                                                                    {isSales && salesItem.batchAllocations?.length ? (
                                                                        <div className="mt-1 text-xs font-medium text-primary">
                                                                            {t('orders.form.batch', { defaultValue: 'Batch' })}: {salesItem.batchAllocations.map((allocation) => `${allocation.batchNumber} (${allocation.quantity})`).join(', ')}
                                                                        </div>
                                                                    ) : null}
                                                                </div>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell>{storageName(item.storageId || mainStorageId)}</TableCell>
                                                         <TableCell className="text-end">
                                                             {hasReturnAdjustment ? (
                                                                 <ReturnedOrderValue
                                                                     currentValue={`${remainingQuantity}${itemUnitLabel ? ` ${itemUnitLabel}` : ''}`}
                                                                     originalValue={`${paidQuantity}${itemUnitLabel ? ` ${itemUnitLabel}` : ''}`}
                                                                 />
                                                             ) : (
                                                                 <span>{paidQuantity}{itemUnitLabel ? ` ${itemUnitLabel}` : ''}</span>
                                                             )}
                                                         </TableCell>
                                                        {showFreeBonus && <TableCell className="text-end">{freeBonusQuantity}{freeBonusItemUnitLabel ? ` ${freeBonusItemUnitLabel}` : ''}</TableCell>}
                                                        {!isSales && <TableCell className="text-end">{itemReceived}</TableCell>}
                                                        <TableCell className="text-end">{formatCurrency(item.convertedUnitPrice, currency, iqd)}</TableCell>
                                                        {isSales && canViewProfit && <TableCell className="text-end">{formatCurrency(salesItem.convertedCostPrice, currency, iqd)}</TableCell>}
                                                        <TableCell className="text-end font-semibold">
                                                            {hasReturnAdjustment ? (
                                                                <ReturnedOrderValue
                                                                    currentValue={formatCurrency(remainingLineTotal, currency, iqd)}
                                                                    originalValue={formatCurrency(item.lineTotal, currency, iqd)}
                                                                />
                                                            ) : formatCurrency(item.lineTotal, currency, iqd)}
                                                        </TableCell>
                                                        {isSales && canViewProfit && (
                                                            <TableCell className="text-end">
                                                                {hasReturnAdjustment ? (
                                                                    <ReturnedOrderValue
                                                                        currentValue={formatCurrency(itemProfit, currency, iqd)}
                                                                        originalValue={formatCurrency(originalItemProfit, currency, iqd)}
                                                                        currentValueClassName={itemProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}
                                                                    />
                                                                ) : (
                                                                    <span className={cn('font-semibold', itemProfit >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
                                                                        {formatCurrency(itemProfit, currency, iqd)}
                                                                    </span>
                                                                )}
                                                            </TableCell>
                                                        )}
                                                        {canReturnSalesOrder && (
                                                            <TableCell className="text-end">
                                                                {returnableQuantity > 0 ? (
                                                                    <Button variant="ghost" size="sm" className="h-8 text-rose-700 hover:bg-rose-500/10 hover:text-rose-800" onClick={() => openItemReturn(salesItem)} disabled={isReturning}>
                                                                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                                                                        {t('orders.return.itemAction', { defaultValue: 'Return' })}
                                                                    </Button>
                                                                ) : <span className="text-xs font-semibold text-rose-700">Returned</span>}
                                                            </TableCell>
                                                        )}
                                                    </TableRow>
                                                )
                                            })}
                                        </TableBody>
                                    </Table>
                                </div>
                            )}

                            <div className="mt-4 grid gap-3 md:grid-cols-3">
                                <div className="rounded-2xl border bg-muted/20 p-4">
                                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground"><ShoppingCart className="h-4 w-4" />{t('orders.details.subtotal') || 'Subtotal'}</div>
                                    <div className="mt-2 text-xl font-black">{formatCurrency(order.subtotal, currency, iqd)}</div>
                                </div>
                                <div className="rounded-2xl border bg-muted/20 p-4">
                                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground"><Receipt className="h-4 w-4" />{t('orders.details.discount') || 'Discount'}</div>
                                    <div className="mt-2 text-xl font-black">{formatCurrency(order.discount, currency, iqd)}</div>
                                </div>
                                <div className="rounded-2xl border bg-muted/20 p-4">
                                    <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground"><Package className="h-4 w-4" />{isSales ? (t('orders.details.tax') || 'Tax') : (t('common.total') || 'Total')}</div>
                                    <div className="mt-2 text-xl font-black">{formatCurrency(isSales ? (order as SalesOrder).tax : order.total, currency, iqd)}</div>
                                </div>
                            </div>
                            {orderAdjustments.length > 0 ? (
                                <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/5 p-4">
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div className="text-sm font-black">{t('orders.adjustments.title', { defaultValue: 'Order Adjustments' })}</div>
                                        <div className="text-sm font-black">
                                            {t('orders.adjustments.finalTotal', { defaultValue: 'Final order total' })}: {formatCurrency(adjustedOrderTotal, currency, iqd)}
                                        </div>
                                    </div>
                                    <div className="mt-3 space-y-2">
                                        {orderAdjustments.map((adjustment) => (
                                            <div key={adjustment.id} className="flex items-center justify-between gap-3 rounded-xl border bg-background/80 px-3 py-2 text-sm">
                                                <div className="min-w-0">
                                                    <span className={cn('mr-2 font-black', adjustment.type === 'addition' ? 'text-emerald-600' : 'text-rose-600')}>
                                                        {adjustment.type === 'addition' ? '+' : '−'}
                                                    </span>
                                                    <span className="font-medium">{adjustment.name}</span>
                                                    {isPostReturnOrderAdjustment(adjustment) ? (
                                                        <span className="ml-2 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:text-amber-200">
                                                            {t('orders.adjustments.postReturn.badge', { defaultValue: 'Post-return' })}
                                                        </span>
                                                    ) : null}
                                                    <span className="ml-2 text-xs uppercase text-muted-foreground">{adjustment.currency}</span>
                                                    {isPostReturnOrderAdjustment(adjustment) && adjustment.returnId ? (
                                                        <span className="ml-2 text-xs text-muted-foreground">
                                                            {t('orders.adjustments.postReturn.linkedReturn', { defaultValue: 'Linked return' })}: {salesOrderReturns.find((orderReturn) => orderReturn.id === adjustment.returnId)?.reason || adjustment.returnId}
                                                        </span>
                                                    ) : null}
                                                    {isPostReturnOrderAdjustment(adjustment) && adjustment.notes ? (
                                                        <div className="mt-1 text-xs text-muted-foreground">{adjustment.notes}</div>
                                                    ) : null}
                                                </div>
                                                <span className={cn('shrink-0 font-bold', adjustment.type === 'addition' ? 'text-emerald-600' : 'text-rose-600')}>
                                                    {adjustment.type === 'addition' ? '+' : '−'}{formatCurrency(adjustment.amount, adjustment.currency, iqd)}
                                                </span>
                                                {adjustment.currency !== adjustment.orderCurrency ? (
                                                    <span className="shrink-0 text-xs font-semibold text-muted-foreground">
                                                        → {adjustment.type === 'addition' ? '+' : '−'}{formatCurrency(adjustment.convertedAmount, adjustment.orderCurrency, iqd)}
                                                    </span>
                                                ) : null}
                                            </div>
                                        ))}
                                    </div>
                                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                                        <AdjustmentSummary label={t('orders.adjustments.totalAdditions', { defaultValue: 'Total additions' })} value={`+${formatCurrency(orderAdjustmentTotals.additions, currency, iqd)}`} valueClassName="text-emerald-600" />
                                        <AdjustmentSummary label={t('orders.adjustments.totalDeductions', { defaultValue: 'Total deductions' })} value={`−${formatCurrency(orderAdjustmentTotals.deductions, currency, iqd)}`} valueClassName="text-rose-600" />
                                        <AdjustmentSummary label={t('orders.adjustments.finalTotal', { defaultValue: 'Final order total' })} value={formatCurrency(adjustedOrderTotal, currency, iqd)} />
                                    </div>
                                </div>
                            ) : null}
                            {isSales && salesOrderReturns.length > 0 ? (
                                <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2 text-sm font-black text-rose-800">
                                            <RotateCcw className="h-4 w-4" />
                                            {t('orders.return.history', { count: salesOrderReturns.length, defaultValue: `Returns (${salesOrderReturns.length})` })}
                                        </div>
                                        <div className="text-sm font-bold text-rose-800">
                                            {formatCurrency((order as SalesOrder).returnedAmount || 0, currency, iqd)}
                                        </div>
                                    </div>
                                    <div className="mt-3 space-y-2">
                                        {salesOrderReturns.slice(0, 3).map((orderReturn) => (
                                            <div key={orderReturn.id} className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                                                <span className="truncate">{orderReturn.reason}</span>
                                                <span className="shrink-0 font-semibold">{formatDateTime(orderReturn.returnedAt)}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ) : null}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <DeleteConfirmationModal
                isOpen={deleteOpen}
                onClose={() => {
                    if (!isDeleting) setDeleteOpen(false)
                }}
                onConfirm={confirmDelete}
                itemName={order.orderNumber}
                isLoading={isDeleting}
                title={t('orders.confirmDelete') || 'Delete Order'}
                description={t('orders.deleteWarning') || 'This will permanently remove the order record. Associated invoices should be checked.'}
            />

            <ReturnConfirmationModal
                isOpen={!!returnTarget}
                onClose={() => {
                    if (!isReturning) {
                        setReturnTarget(null)
                        setReturnPaymentAccount(null)
                    }
                }}
                onConfirm={(reason, quantity) => { void handleOrderReturnConfirm(reason, quantity) }}
                title={t('orders.return.title', { defaultValue: 'Return Order' })}
                message={returnTarget?.orderItemId
                    ? t('orders.return.itemConfirmation', { itemName: returnTarget.itemName, defaultValue: `Return ${returnTarget.itemName} from this completed order?` })
                    : t('orders.return.wholeConfirmation', { defaultValue: 'Return all remaining items from this completed order?' })}
                isItemReturn={!!returnTarget?.orderItemId}
                maxQuantity={returnTarget?.maxQuantity || 1}
                itemName={returnTarget?.itemName || ''}
                workspaceId={workspaceId}
                paymentAccount={returnPaymentAccount}
                onPaymentAccountChange={setReturnPaymentAccount}
                showPaymentAccount={paidAmount > 0}
                cashDrawerOnly={order.paymentMethod === 'cash'}
            />

            <PostReturnAdjustmentDialog
                open={isPostReturnAdjustmentOpen}
                onOpenChange={setIsPostReturnAdjustmentOpen}
                returns={salesOrderReturns}
                orderCurrency={currency}
                exchangeRates={order.exchangeRates || []}
                availableCurrencies={Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as import('@/local-db').CurrencyCode[]}
                iqdDisplayPreference={features.iqd_display_preference}
                isSaving={isSavingPostReturnAdjustment}
                onSubmit={handlePostReturnAdjustment}
            />

            <SettlementDialog
                open={!!settlementTarget}
                onOpenChange={(open) => {
                    if (!open) {
                        setSettlementTarget(null)
                    }
                }}
                obligation={settlementTarget}
                isSubmitting={isSubmittingSettlement}
                onSubmit={handleOrderSettlement}
            />

            <PaymentReversalDialog
                open={!!transactionToReverse}
                onOpenChange={(open) => {
                    if (!open) setTransactionToReverse(null)
                }}
                onSubmit={confirmOrderPaymentReversal}
                isProcessing={isReversingPayment}
                transaction={transactionToReverse}
                workspaceId={workspaceId}
                iqdPreference={features.iqd_display_preference}
            />

            <Dialog open={lockConfirm.isOpen} onOpenChange={(open) => !isLocking && setLockConfirm({ isOpen: open })}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
                            <Lock className="h-6 w-6 text-amber-600 dark:text-amber-500" />
                        </div>
                        <DialogTitle className="text-xl font-bold">{t('orders.lockTitle') || 'Lock Order?'}</DialogTitle>
                    </DialogHeader>
                    <div className="py-4 text-sm text-muted-foreground leading-relaxed">
                        {t('orders.lockDescription') || 'Locking this order will prevent any changes to its payment status. This action cannot be undone.'}
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button
                            variant="ghost"
                            onClick={() => setLockConfirm({ isOpen: false })}
                            disabled={isLocking}
                            className="font-semibold"
                        >
                            {t('common.cancel') || 'Cancel'}
                        </Button>
                        <Button
                            className="bg-amber-600 font-bold text-white hover:bg-amber-700 shadow-lg shadow-amber-600/20 transition-all active:scale-95"
                            onClick={handleLockConfirm}
                            disabled={isLocking}
                        >
                            {isLocking ? (
                                <div className="flex items-center gap-2">
                                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                                    <span>{t('orders.details.locking') || 'Locking...'}</span>
                                </div>
                            ) : (
                                <>
                                    <Lock className="mr-2 h-4 w-4" />
                                    {t('orders.details.lockNow') || 'Lock Now'}
                                </>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={cancelConfirm.isOpen} onOpenChange={(open) => !isCancelling && setCancelConfirm({ isOpen: open })}>
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
                            <XCircle className="h-6 w-6 text-red-600 dark:text-red-500" />
                        </div>
                        <DialogTitle className="text-xl font-bold">{t('orders.cancelTitle') || 'Cancel Order?'}</DialogTitle>
                    </DialogHeader>
                    <div className="py-4 text-sm text-muted-foreground leading-relaxed">
                        {t('orders.cancelDescription') || 'Are you sure you want to cancel this order? This action cannot be undone.'}
                    </div>
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button
                            variant="ghost"
                            onClick={() => setCancelConfirm({ isOpen: false })}
                            disabled={isCancelling}
                            className="font-semibold"
                        >
                            {t('common.back') || 'Back'}
                        </Button>
                        <Button
                            className="bg-red-600 font-bold text-white hover:bg-red-700 shadow-lg shadow-red-600/20 transition-all active:scale-95"
                            onClick={handleCancelConfirm}
                            disabled={isCancelling}
                        >
                            {isCancelling ? (
                                <div className="flex items-center gap-2">
                                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                                    <span>{t('orders.details.cancelling') || 'Cancelling...'}</span>
                                </div>
                            ) : (
                                <>
                                    <XCircle className="mr-2 h-4 w-4" />
                                    {t('orders.actions.cancel') || 'Cancel Order'}
                                </>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <PrintPreviewModal
                isOpen={showPrintPreview}
                onClose={() => {
                    setShowPrintPreview(false)
                    customOrderPrint.resetSelection()
                }}
                onConfirm={() => {
                    setShowPrintPreview(false)
                    customOrderPrint.resetSelection()
                }}
                title={customOrderPrint.selectedTemplateLabel
                    ? customOrderPrint.selectedTemplateLabel
                    : customOrderPrint.isAtlasStandardReturnSelected
                        ? t('orders.print.nativeAtlasStandardReturnTemplate')
                    : isSales
                        ? (t('orders.tabs.sales') || 'Sales Order')
                        : (t('orders.tabs.purchase') || 'Purchase Order')}
                module="orders"
                features={features}
                workspaceName={workspaceName}
                originId={order.id}
                invoiceData={{
                    invoiceid: order.orderNumber,
                    totalAmount: customOrderPrint.isReturnPrintSelected
                        ? returnPrintData?.totalRefundAmount || 0
                        : customOrderPrint.isOriginalPrintSelected
                            ? getOrderPrintOriginalTotal(order)
                            : order.total,
                    settlementCurrency: order.currency,
                    origin: isSales ? 'sales_order' as const : 'purchase_order' as const,
                    createdByName: creatorName || 'Unknown',
                    cashierName: creatorName || 'Unknown',
                    printFormat: 'a4' as const,
                    orderId: order.id
                }}
                pdfBuilder={customOrderPrint.isCustomSelected
                    ? customOrderPrint.buildPdf
                    : async ({ format, effectiveId, printLangOverride }: { format: PrintFormat; effectiveId: string; printLangOverride?: string }) => {
                        const baseLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
                        const printLang = printLangOverride || baseLang
                        return generateTemplatePdf({
                            element: (
                                format === 'receipt' ? (
                                    <OrderReceiptPrintTemplate
                                        workspaceName={workspaceName}
                                        printLang={printLang}
                                        order={order}
                                        installments={installments}
                                        kind={resolved.kind}
                                        iqdPreference={features.iqd_display_preference}
                                        logoUrl={features.logo_url}
                                        qrValue={effectiveId ? `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/receipts/${effectiveId}.pdf` : undefined}
                                        productUnits={productUnits}
                                        counterpartyPhone={counterpartyPhone}
                                        workspaceFooterContacts={workspaceFooterContacts}
                                        printVersion={customOrderPrint.selectedPrintVersion}
                                    />
                                ) : customOrderPrint.isAtlasStandardSelected || customOrderPrint.isAtlasStandardReturnSelected ? (
                                    <AtlasStandardOrderInvoiceTemplate
                                        workspaceName={workspaceName}
                                        printLang={printLang}
                                        order={order}
                                        installments={installments}
                                        kind={resolved.kind}
                                        iqdPreference={features.iqd_display_preference}
                                        logoUrl={features.logo_url}
                                        workspaceFooterContacts={workspaceFooterContacts}
                                        printVersion={customOrderPrint.selectedPrintVersion}
                                        businessPartner={bizPartner}
                                        partnerAccountStatementBalances={partnerAccountStatementBalances}
                                        partnerBalanceFallbackSnapshot={legacyOrderBalanceSnapshot}
                                        printedBy={creatorName}
                                        productImageUrls={productImageUrls}
                                        returnPrintData={customOrderPrint.isAtlasStandardReturnSelected ? returnPrintData : undefined}
                                    />
                                ) : (
                                    <OrderDetailsPrintTemplate
                                        workspaceName={workspaceName}
                                        printLang={printLang}
                                        order={order}
                                        installments={installments}
                                        kind={resolved.kind}
                                        iqdPreference={features.iqd_display_preference}
                                        logoUrl={features.logo_url}
                                        qrValue={effectiveId ? `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/A4/${effectiveId}.pdf` : undefined}
                                        counterpartyPhone={counterpartyPhone}
                                        counterpartyAddress={counterpartyAddress}
                                        productUnits={productUnits}
                                        workspaceFooterContacts={workspaceFooterContacts}
                                        printVersion={customOrderPrint.selectedPrintVersion}
                                    />
                                )
                            ),
                            format,
                            printLang,
                        })
                    }}
                printTemplate={({ effectiveId }) => {
                    const printLang = features?.print_lang && features.print_lang !== 'auto' ? features.print_lang : i18n.language
                    return customOrderPrint.isReceiptSelected ? (
                        <OrderReceiptPrintTemplate
                            workspaceName={workspaceName}
                            printLang={printLang}
                            order={order}
                            installments={installments}
                            kind={resolved.kind}
                            iqdPreference={features.iqd_display_preference}
                            logoUrl={features.logo_url}
                            qrValue={effectiveId ? `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/receipts/${effectiveId}.pdf` : undefined}
                            productUnits={productUnits}
                            counterpartyPhone={counterpartyPhone}
                            workspaceFooterContacts={workspaceFooterContacts}
                            printVersion={customOrderPrint.selectedPrintVersion}
                        />
                    ) : customOrderPrint.isAtlasStandardSelected || customOrderPrint.isAtlasStandardReturnSelected ? (
                        <AtlasStandardOrderInvoiceTemplate
                            workspaceName={workspaceName}
                            printLang={printLang}
                            order={order}
                            installments={installments}
                            kind={resolved.kind}
                            iqdPreference={features.iqd_display_preference}
                            logoUrl={features.logo_url}
                            workspaceFooterContacts={workspaceFooterContacts}
                            printVersion={customOrderPrint.selectedPrintVersion}
                            businessPartner={bizPartner}
                            partnerAccountStatementBalances={partnerAccountStatementBalances}
                            partnerBalanceFallbackSnapshot={legacyOrderBalanceSnapshot}
                            printedBy={creatorName}
                            productImageUrls={productImageUrls}
                            returnPrintData={customOrderPrint.isAtlasStandardReturnSelected ? returnPrintData : undefined}
                        />
                    ) : (
                        <OrderDetailsPrintTemplate
                            workspaceName={workspaceName}
                            printLang={printLang}
                            order={order}
                            installments={installments}
                            kind={resolved.kind}
                            iqdPreference={features.iqd_display_preference}
                            logoUrl={features.logo_url}
                            qrValue={effectiveId ? `https://asaas-r2-proxy.alanepic360.workers.dev/${workspaceId}/printed-invoices/A4/${effectiveId}.pdf` : undefined}
                            counterpartyPhone={counterpartyPhone}
                            counterpartyAddress={counterpartyAddress}
                            productUnits={productUnits}
                            workspaceFooterContacts={workspaceFooterContacts}
                            printVersion={customOrderPrint.selectedPrintVersion}
                        />
                    )
                }}
                templatePreview={customOrderPrint.isCustomSelected
                    ? customOrderPrint.preview
                    : customOrderPrint.isReceiptSelected
                        ? orderReceiptPreview
                        : customOrderPrint.isAtlasStandardReturnSelected
                            ? orderAtlasStandardReturnPreview
                            : customOrderPrint.isAtlasStandardSelected
                            ? orderAtlasStandardPreview
                            : orderDetailsPreview}
                customTemplate={customOrderPrint.customTemplate}
                initialTemplateLayout={customOrderPrint.initialLayout}
                enableTemplatePreviewSave={customOrderPrint.isCustomSelected}
                generateTemplateLayoutBlob={customOrderPrint.isCustomSelected ? customOrderPrint.buildEditablePdf : undefined}
                printSelectionOptions={customOrderPrint.nativeOptions}
                printSelectionTemplates={customOrderPrint.templateOptions}
                onPrintSelection={customOrderPrint.handleSelection}
                onCreateReturnTemplate={returnPrintData ? () => {
                    setShowPrintPreview(false)
                    customOrderPrint.resetSelection()
                    navigate('/custom-templates?new=return')
                } : undefined}
            />
        </div>
    )
}

function AdjustmentSummary({ label, value, valueClassName }: { label: string; value: string; valueClassName?: string }) {
    return (
        <div className="rounded-xl border bg-background/70 p-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
            <div className={cn('mt-1 font-black', valueClassName)}>{value}</div>
        </div>
    )
}
