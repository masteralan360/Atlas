import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowLeft, CalendarDays, Check, CreditCard, NotebookPen, Plus, ShoppingCart, Star, Trash2, Truck, Users, X } from 'lucide-react'

import { useAuth } from '@/auth'
import { useDemoTutorial } from '@/demo'
import { useUiAccess } from '@/context/UiAccessContext'
import { isMobile } from '@/lib/platform'
import { getPrioritizedPaymentMethod, setPrioritizedPaymentMethod } from '@/lib/prioritizedPaymentMethod'
import { ORDER_FINANCING_PAYMENT_METHODS, STANDARD_PAYMENT_METHODS, type PaymentMethodOption } from '@/lib/paymentMethods'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { buildOrderExchangeRatesSnapshot, convertCurrencyAmountWithLiveRates, getPrimaryExchangeDetails } from '@/lib/orderCurrency'
import { calculateOrderTotalWithAdjustments, normalizeOrderAdjustments, repriceOrderAdjustment } from '@/lib/orderAdjustments'
import {
    cn,
    formatCurrency,
    formatLocalDateTimeValue,
    formatLocalDateValue,
    formatNumericInput,
    parseLocalDateTimeValue,
    parseLocalDateValue,
    sanitizeNumericInput
} from '@/lib/utils'
import { getOrderLineFreeBonusQuantity, hasOrderLineInventoryQuantity } from '@/lib/orderLineItems'
import { ORDER_DECIMAL_STEP, roundOrderValue } from '@/lib/orderPrecision'
import { isService, SERVICES_VIRTUAL_STORAGE_ID } from '@/lib/catalogItem'
import {
    createSalesOrder,
    findPartnerProductPriceBookItem,
    getActiveSalesOrderAgentAssignments,
    getPrimaryStorageFromList,
    updateSalesOrder,
    useAgents,
    useBusinessPartners,
    useInventory,
    useDiscountPriceResolver,
    usePriceBookCatalogState,
    useProducts,
    useWorkspaceProductBarcodes,
    useSalesOrderAgentAssignments,
    useSalesOrder,
    useStockBatches,
    useStorages,
    type BusinessPartner,
    type CurrencyCode,
    type InstallmentFrequency,
    type OrderAdjustment,
    type SalesOrder,
    type SalesOrderItem,
    type SalesOrderStatus,
    type StockBatch
} from '@/local-db'
import { useWorkspace } from '@/workspace'
import { hasEffectiveSalesAgentCommissionPermission, useHideCosts, useWorkspacePermissions } from '@/permissions'
import { getMissingPriceBookCostMessage, getMissingProductCostMessage, hasValidProductCost } from '@/lib/productCost'
import {
    Button,
    Badge,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CurrencySelector,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DateTimePicker,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    Textarea,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    useToast
} from '@/ui/components'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { PartnerBalanceSummary } from '@/ui/components/crm/PartnerBalanceSummary'
import { QuickCustomerButton } from '@/ui/components/crm/QuickCustomerButton'
import { ProductsViewModal, ProductsViewModalTrigger } from '@/ui/components/ProductsViewModal'
import { PaymentMethodSelect } from '@/ui/components/payments/PaymentMethodSelect'
import { PaymentAccountSelector } from '@/ui/components/payments/PaymentAccountSelector'
import { ProductAutocompleteInput } from './ProductAutocompleteInput'
import { useOrderBarcodeScanner } from './useOrderBarcodeScanner'
import { LoanPartyPickerDialog } from '@/ui/components/loans/LoanPartyPickerDialog'
import { OrderAdjustmentsDialog } from './OrderAdjustmentsDialog'
import { OrderLineItemNoteDialog } from './OrderLineItemNoteDialog'
import { FreeBonusUnitSelect } from './FreeBonusUnitSelect'
import { useUnitRegistry } from '@/ui/components/unitRegistry'
import {
    SalesOrderCommissionAssignmentSection,
    type SalesOrderCommissionAssignmentHandle,
    type SalesOrderCommissionAssignmentSummary
} from '@/ui/components/commissions/SalesOrderCommissionAssignmentSection'
import {
    ProductCommissionPreview,
    type ProductCommissionPreviewAgent
} from '@/ui/components/commissions/ProductCommissionPreview'
import { findLinkedProductCommissionAgent } from '@/ui/components/commissions/productCommissionAgent'
import { OLD_SALES_AGENT_CONFIGURATION } from '@/ui/components/commissions/oldSalesAgentConfiguration'

interface SalesOrderFormPageProps {
    workspaceId: string
    onCancel: () => void
    onCreated?: (orderId: string) => void
    editingOrderId?: string
}
type FormItem = {
    seq: number
    productId: string
    productSearch: string
    storageId: string
    quantity: string
    freeBonusQuantity: string
    freeBonusUnit: string
    unitPrice: string
    batchId: string
    priceBookId: string
    priceBookItemId: string
    priceSourceCurrency: CurrencyCode | ''
    priceBookCostPrice: string
    note: string
}

function createEmptyItem(storageId = '', seq = 1): FormItem {
    return {
        seq,
        productId: '',
        productSearch: '',
        storageId,
        quantity: '1',
        freeBonusQuantity: '0',
        freeBonusUnit: '',
        unitPrice: '',
        batchId: '',
        priceBookId: '',
        priceBookItemId: '',
        priceSourceCurrency: '',
        priceBookCostPrice: '',
        note: ''
    }
}

function roundFormAmount(value: number) {
    return roundOrderValue(value)
}

const PRODUCT_STOCK_SELECTION = '__product_stock__'

function sortBatchesForSalesOrder(batches: StockBatch[]) {
    return [...batches].sort((left, right) =>
        (left.expiryDate ?? '9999-12-31').localeCompare(right.expiryDate ?? '9999-12-31')
        || (left.manufacturingDate ?? '9999-12-31').localeCompare(right.manufacturingDate ?? '9999-12-31')
        || left.createdAt.localeCompare(right.createdAt)
        || left.batchNumber.localeCompare(right.batchNumber)
    )
}

function getCommonStorageId(items: Array<{ storageId?: string | null }>, fallbackStorageId = '') {
    const storageIds = Array.from(new Set(items.map((item) => item.storageId || fallbackStorageId).filter(Boolean)))
    return storageIds.length === 1 ? storageIds[0] : null
}

type PartnerRequiredSectionProps = {
    locked: boolean
    unlockLabel: string
    onLockedInteraction: () => void
    children: ReactNode
}

function PartnerRequiredSection({ locked, unlockLabel, onLockedInteraction, children }: PartnerRequiredSectionProps) {
    const contentRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const content = contentRef.current
        if (!content) return

        if (locked) {
            content.setAttribute('inert', '')
        } else {
            content.removeAttribute('inert')
        }

        return () => content.removeAttribute('inert')
    }, [locked])

    return (
        <div className={cn('relative rounded-2xl', locked && 'cursor-not-allowed')} aria-disabled={locked || undefined}>
            <div ref={contentRef} className={cn(locked && 'select-none opacity-70')}>
                {children}
            </div>
            {locked ? (
                <button
                    type="button"
                    className="absolute inset-0 z-10 flex cursor-pointer items-center justify-center rounded-2xl p-4 text-center outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    onClick={onLockedInteraction}
                >
                    <span className="inline-flex items-center gap-2 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive shadow-sm">
                        <Users className="h-3.5 w-3.5" />
                        {unlockLabel}
                    </span>
                </button>
            ) : null}
        </div>
    )
}

export function SalesOrderFormPage({
    workspaceId,
    onCancel,
    onCreated,
    editingOrderId
}: SalesOrderFormPageProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const hideCosts = useHideCosts()
    const { features, hasCapability, hasFeature } = useWorkspace()
    const { permissionKeys } = useWorkspacePermissions()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const demoTutorial = useDemoTutorial()

    const products = useProducts(workspaceId)
    const productBarcodes = useWorkspaceProductBarcodes(workspaceId, { syncProductCache: false })
    const inventory = useInventory(workspaceId)
    const resolveDiscountForPrice = useDiscountPriceResolver(workspaceId, { inventoryRows: inventory })
    const stockBatches = useStockBatches(workspaceId)
    const storages = useStorages(workspaceId)
    const { isDynamicUnit, options: unitOptions } = useUnitRegistry(workspaceId)
    const customerPartners = useBusinessPartners(workspaceId, { roles: ['customer'] })
    const agentPartners = useBusinessPartners(workspaceId, { roles: ['agent'], includeAgentRoles: true })
    const agents = useAgents(workspaceId)
    const salesOrderAgentAssignments = useSalesOrderAgentAssignments(workspaceId)
    const editingOrder = useSalesOrder(editingOrderId)
    const salesAgentCommissionsEnabled = hasFeature('sales_agent_commissions')
    const agentSalesAccountsEnabled = hasFeature('agent_sales_accounts')
    const canAssignSalesAgents = OLD_SALES_AGENT_CONFIGURATION.showSalesAgentBeneficiaries
        && salesAgentCommissionsEnabled
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.assignOrders')
    const defaultStorageId = getPrimaryStorageFromList(storages)?.id || ''
    const storageOptionsForModal = useMemo(() => {
        if (!hasFeature('services')) return storages
        return [
            ...storages,
            {
                id: SERVICES_VIRTUAL_STORAGE_ID,
                workspaceId,
                name: t('services.title', { defaultValue: 'Services' }),
                isSystem: false,
                isProtected: true,
                isPrimary: false,
                isMarketplace: false,
                createdAt: '',
                updatedAt: '',
                syncStatus: 'synced' as const,
                lastSyncedAt: null,
                version: 1,
                isDeleted: false
            }
        ]
    }, [hasFeature, storages, t, workspaceId])
    const priceBooksEnabled = hasCapability('priceBooks')
    const {
        priceBooks,
        priceBookItems,
        isReady: isPriceBookCatalogReady,
        error: priceBookCatalogError
    } = usePriceBookCatalogState(priceBooksEnabled ? workspaceId : undefined, { enabled: priceBooksEnabled })
    const { isAccessKeyHeld } = useUiAccess()
    const formOpenedAtRef = useRef(new Date().toISOString())
    const commissionAssignmentRef = useRef<SalesOrderCommissionAssignmentHandle>(null)
    const [commissionAssignmentSummaries, setCommissionAssignmentSummaries] = useState<SalesOrderCommissionAssignmentSummary[]>([])
    const [isOrderCreationPickerOpen, setIsOrderCreationPickerOpen] = useState(false)
    const canEditOrderCreation = user?.role === 'admin' && (isAccessKeyHeld || isOrderCreationPickerOpen)
    const [prioritizedMethod, setPrioritizedMethod] = useState<string | null>(getPrioritizedPaymentMethod)

    const [isSaving, setIsSaving] = useState(false)
    const [isLossWarningOpen, setIsLossWarningOpen] = useState(false)
    const [productsViewItemIndex, setProductsViewItemIndex] = useState<number | null>(null)
    const [customerId, setCustomerId] = useState(editingOrder?.businessPartnerId || editingOrder?.customerId || '')
    const [customerSearch, setCustomerSearch] = useState(editingOrder?.customerName || '')
    const [salesAccountAgentId, setSalesAccountAgentId] = useState(editingOrder?.salesAccountAgentId || '')
    const [isCustomerPickerOpen, setIsCustomerPickerOpen] = useState(false)
    const [sourceStorageId, setSourceStorageId] = useState(editingOrder?.sourceStorageId || defaultStorageId)
    const [currency, setCurrency] = useState<CurrencyCode>(editingOrder?.currency || features.default_currency)
    const [orderAdjustments, setOrderAdjustments] = useState<OrderAdjustment[]>(() =>
        normalizeOrderAdjustments(editingOrder?.orderAdjustments, editingOrder?.currency || features.default_currency)
    )
    const [isOrderAdjustmentsOpen, setIsOrderAdjustmentsOpen] = useState(false)
    const [shippingAddress, setShippingAddress] = useState(editingOrder?.shippingAddress || '')
    const [expectedDeliveryDate, setExpectedDeliveryDate] = useState(editingOrder?.expectedDeliveryDate ? formatLocalDateTimeValue(editingOrder.expectedDeliveryDate) : '')
    const [orderCreationDate, setOrderCreationDate] = useState(editingOrder?.createdAt || formOpenedAtRef.current)
    const [discount, setDiscount] = useState(editingOrder?.discount ? String(editingOrder.discount) : '')
    const [tax, setTax] = useState(editingOrder?.tax ? String(editingOrder.tax) : '')
    const [notes, setNotes] = useState(editingOrder?.notes || '')
    const [isPaid, setIsPaid] = useState(editingOrder?.isPaid || false)
    const [paymentMethod, setPaymentMethod] = useState<string>(editingOrder?.paymentMethod || prioritizedMethod || 'cash')
    const [installmentCount, setInstallmentCount] = useState(String(editingOrder?.installmentCount || 3))
    const [installmentFrequency, setInstallmentFrequency] = useState<InstallmentFrequency>(editingOrder?.installmentFrequency || 'monthly')
    const [firstDueDate, setFirstDueDate] = useState(editingOrder?.firstDueDate?.slice(0, 10) || '')
    const [initialPaymentAmount, setInitialPaymentAmount] = useState(
        editingOrder?.initialPaymentAmount ? String(editingOrder.initialPaymentAmount) : ''
    )
    const [initialPaymentAccountId, setInitialPaymentAccountId] = useState<string | null>(editingOrder?.initialPaymentAccountId ?? null)
    const [initialPaymentAccountNameSnapshot, setInitialPaymentAccountNameSnapshot] = useState<string | null>(editingOrder?.initialPaymentAccountNameSnapshot ?? null)
    const changeOrderCurrency = useCallback((nextCurrency: CurrencyCode) => {
        const adjustmentRates = buildOrderExchangeRatesSnapshot({ exchangeData, eurRates, tryRates })
        const repricedAdjustments = orderAdjustments.map((adjustment) =>
            repriceOrderAdjustment(adjustment, nextCurrency, adjustmentRates)
        )
        if (repricedAdjustments.some((adjustment) => !adjustment)) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('orders.adjustments.exchangeRateUnavailable', { defaultValue: 'Exchange rate unavailable for the selected currency.' }),
                variant: 'destructive'
            })
            return
        }
        setCurrency(nextCurrency)
        setOrderAdjustments(repricedAdjustments as OrderAdjustment[])
    }, [eurRates, exchangeData, orderAdjustments, t, toast, tryRates])
    const [items, setItems] = useState<FormItem[]>(() => {
        if (editingOrder) {
            return editingOrder.items.map((item, idx) => {
                const product = products.find((p) => p.id === item.productId)
                return {
                    seq: idx + 1,
                    productId: item.productId,
                    productSearch: product?.name || '',
                    storageId: item.storageId || editingOrder.sourceStorageId || defaultStorageId,
                    quantity: String(item.quantity),
                    freeBonusQuantity: String(getOrderLineFreeBonusQuantity(item)),
                    freeBonusUnit: item.freeBonusUnit || '',
                    unitPrice: String(item.convertedUnitPrice),
                    batchId: item.batchAllocations?.[0]?.batchId || '',
                    priceBookId: item.priceBookId || '',
                    priceBookItemId: item.priceBookItemId || '',
                    priceSourceCurrency: item.priceBookId && item.priceBookItemId ? item.originalCurrency : '',
                    priceBookCostPrice: item.priceBookId && item.priceBookItemId ? String(item.costPrice) : '',
                    note: item.note || ''
                }
            })
        }
        return [createEmptyItem(defaultStorageId)]
    })
    const requiresApprovalRequest = user?.role === 'staff' && permissionKeys.includes('orders.requireSalesOrderRequest')
    const canUseFreeBonus = hasCapability('orderFreeBonus')
    const [highlightedStorageIndex, setHighlightedStorageIndex] = useState<number | null>(null)
    const [highlightedNewSeq, setHighlightedNewSeq] = useState<number | null>(null)
    const [isCustomerInformationHighlighted, setIsCustomerInformationHighlighted] = useState(false)
    const customerInformationRef = useRef<HTMLDivElement>(null)
    const customerHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        if (highlightedNewSeq == null) return
        const timeout = setTimeout(() => setHighlightedNewSeq(null), 1600)
        return () => clearTimeout(timeout)
    }, [highlightedNewSeq])

    useEffect(() => () => {
        if (customerHighlightTimeoutRef.current) clearTimeout(customerHighlightTimeoutRef.current)
    }, [])


    useEffect(() => {
        if (!editingOrder) return
        setCustomerId(editingOrder.businessPartnerId || editingOrder.customerId)
        setCustomerSearch(editingOrder.customerName)
        setSalesAccountAgentId(editingOrder.salesAccountAgentId || '')
        setSourceStorageId(editingOrder.sourceStorageId || defaultStorageId)
        setCurrency(editingOrder.currency)
        setOrderAdjustments(normalizeOrderAdjustments(editingOrder.orderAdjustments, editingOrder.currency))
        setShippingAddress(editingOrder.shippingAddress || '')
        setExpectedDeliveryDate(editingOrder.expectedDeliveryDate ? formatLocalDateTimeValue(editingOrder.expectedDeliveryDate) : '')
        setOrderCreationDate(editingOrder.createdAt || formOpenedAtRef.current)
        setDiscount(editingOrder.discount ? String(editingOrder.discount) : '')
        setTax(editingOrder.tax ? String(editingOrder.tax) : '')
        setNotes(editingOrder.notes || '')
        setIsPaid(editingOrder.isPaid)
        setPaymentMethod(editingOrder.paymentMethod || 'cash')
        setInstallmentCount(String(editingOrder.installmentCount || 3))
        setInstallmentFrequency(editingOrder.installmentFrequency || 'monthly')
        setFirstDueDate(editingOrder.firstDueDate?.slice(0, 10) || '')
        setInitialPaymentAmount(editingOrder.initialPaymentAmount ? String(editingOrder.initialPaymentAmount) : '')
        setInitialPaymentAccountId(editingOrder.initialPaymentAccountId ?? null)
        setInitialPaymentAccountNameSnapshot(editingOrder.initialPaymentAccountNameSnapshot ?? null)
        setItems(editingOrder.items.map((item, idx) => {
            const product = products.find((p) => p.id === item.productId)
            return {
                seq: idx + 1,
                productId: item.productId,
                productSearch: product?.name || '',
                storageId: item.storageId || editingOrder.sourceStorageId || defaultStorageId,
                quantity: String(item.quantity),
                freeBonusQuantity: String(getOrderLineFreeBonusQuantity(item)),
                freeBonusUnit: item.freeBonusUnit || '',
                unitPrice: String(item.convertedUnitPrice),
                batchId: item.batchAllocations?.[0]?.batchId || '',
                priceBookId: item.priceBookId || '',
                priceBookItemId: item.priceBookItemId || '',
                priceSourceCurrency: item.priceBookId && item.priceBookItemId ? item.originalCurrency : '',
                priceBookCostPrice: item.priceBookId && item.priceBookItemId ? String(item.costPrice) : '',
                note: item.note || ''
            }
        }))
    }, [defaultStorageId, editingOrder])

    useEffect(() => {
        if (!editingOrder || !products.length) return
        setItems((current) => {
            let changed = false
            const next = current.map((item) => {
                if (item.productId && !item.productSearch) {
                    const product = products.find((p) => p.id === item.productId)
                    if (product) {
                        changed = true
                        return { ...item, productSearch: product.name }
                    }
                }
                return item
            })
            return changed ? next : current
        })
    }, [products, editingOrder])

    const liveRates = useMemo(() => ({ exchangeData, eurRates, tryRates }), [exchangeData, eurRates, tryRates])
    const adjustmentExchangeRates = useMemo(() => buildOrderExchangeRatesSnapshot(liveRates), [liveRates])

    const availableSalesProductIdsByStorage = useMemo(() => {
        const rows = new Map<string, Set<string>>()
        for (const row of inventory) {
            if (row.quantity <= 0) continue
            const current = rows.get(row.storageId) ?? new Set<string>()
            current.add(row.productId)
            rows.set(row.storageId, current)
        }
        return rows
    }, [inventory])

    const selectedCustomerFromPicker = customerPartners.find((entry) => entry.id === customerId)
    const selectedSalesAccount = useMemo(() => {
        const agent = agents.find((candidate) => (
            candidate.id === salesAccountAgentId
            && !candidate.isDeleted
            && candidate.status === 'active'
            && candidate.salesAccountEnabled
        ))
        if (!agent) return null
        const partner = agentPartners.find((candidate) => candidate.id === agent.businessPartnerId)
        return partner ? { agent, partner } : null
    }, [agentPartners, agents, salesAccountAgentId])
    const selectedCustomer = selectedSalesAccount?.partner ?? selectedCustomerFromPicker
    const isCustomerSelectionRequired = !editingOrderId && !selectedCustomer
    const activeCommissionAssignments = useMemo(
        () => editingOrderId
            ? getActiveSalesOrderAgentAssignments(salesOrderAgentAssignments, editingOrderId)
            : [],
        [editingOrderId, salesOrderAgentAssignments]
    )
    const creatorCommissionAgent = useMemo(() => {
        const creatorUserId = editingOrder?.createdBy ?? user?.id
        return findLinkedProductCommissionAgent(agents, creatorUserId)
    }, [agents, editingOrder?.createdBy, user?.id])
    const productCommissionAgentIds = useMemo(() => {
        const agentIds = new Set(activeCommissionAssignments.map((assignment) => assignment.agentId))
        if (selectedSalesAccount) agentIds.add(selectedSalesAccount.agent.id)
        if (creatorCommissionAgent) agentIds.add(creatorCommissionAgent.id)
        for (const summary of commissionAssignmentSummaries) agentIds.add(summary.agentId)
        return [...agentIds]
    }, [activeCommissionAssignments, commissionAssignmentSummaries, creatorCommissionAgent, selectedSalesAccount])
    const productCommissionPreviewAgents = useMemo<ProductCommissionPreviewAgent[]>(() => {
        const agentNameById = new Map(commissionAssignmentSummaries.map((summary) => [summary.agentId, summary.agentName]))
        const partnerById = new Map(agentPartners.map((partner) => [partner.id, partner]))
        for (const agent of agents) {
            const name = partnerById.get(agent.businessPartnerId)?.partnerName
            if (name && !agentNameById.has(agent.id)) agentNameById.set(agent.id, name)
        }
        return productCommissionAgentIds.map((id) => ({
            id,
            name: agentNameById.get(id) || t('salesAgentCommissions.salesAgent')
        }))
    }, [agentPartners, agents, commissionAssignmentSummaries, productCommissionAgentIds, t])
    const productCommissionPreviewItems = useMemo(() => items.map((item) => ({
        id: String(item.seq),
        productId: item.productId,
        productName: item.productSearch,
        quantity: Number(item.quantity) || 0,
        convertedUnitPrice: Number(item.unitPrice) || 0
    })), [items])
    const inventoryByStorageProduct = useMemo(() => new Map(
        inventory.map((row) => [`${row.storageId}:${row.productId}`, row.quantity])
    ), [inventory])
    const stockBatchesById = useMemo(
        () => new Map(stockBatches.map((batch) => [batch.id, batch])),
        [stockBatches]
    )
    const stockBatchesByPosition = useMemo(() => {
        const rows = new Map<string, StockBatch[]>()
        for (const batch of stockBatches) {
            if (batch.quantity <= 0) continue
            const key = `${batch.storageId}:${batch.productId}`
            const current = rows.get(key) ?? []
            current.push(batch)
            rows.set(key, current)
        }
        for (const [key, batches] of rows) {
            rows.set(key, sortBatchesForSalesOrder(batches))
        }
        return rows
    }, [stockBatches])

    const getAvailableQuantity = useCallback((productId: string, storageId: string) => {
        if (!productId || !storageId) return 0
        return inventoryByStorageProduct.get(`${storageId}:${productId}`) ?? 0
    }, [inventoryByStorageProduct])

    const getBatchesForPosition = useCallback((productId: string, storageId: string) =>
        stockBatchesByPosition.get(`${storageId}:${productId}`) ?? [],
        [stockBatchesByPosition])

    const getRegularStockQuantity = useCallback((productId: string, storageId: string) =>
        Math.max(
            getAvailableQuantity(productId, storageId)
            - getBatchesForPosition(productId, storageId).reduce((sum, batch) => sum + batch.quantity, 0),
            0
        ),
        [getAvailableQuantity, getBatchesForPosition])

    const getPriceBookItemForPartner = useCallback((partner: Pick<BusinessPartner, 'priceBookId'> | null | undefined, productId: string) =>
        findPartnerProductPriceBookItem(
            priceBooksEnabled,
            partner,
            productId,
            priceBooks,
            priceBookItems
        ),
        [priceBookItems, priceBooks, priceBooksEnabled])

    const getPartnerPriceBookName = useCallback((partner: Pick<BusinessPartner, 'priceBookId'> | null | undefined) => {
        if (!priceBooksEnabled || !partner?.priceBookId) return undefined
        return priceBooks.find((priceBook) => priceBook.id === partner.priceBookId && !priceBook.isDeleted)?.name
    }, [priceBooks, priceBooksEnabled])

    const hasMissingPartnerPriceBookCost = useCallback((
        partner: Pick<BusinessPartner, 'priceBookId'> | null | undefined,
        productId: string
    ) => {
        if (!getPartnerPriceBookName(partner)) return false
        const priceBookItem = getPriceBookItemForPartner(partner, productId)
        return !!priceBookItem && !hasValidProductCost(priceBookItem.costPrice)
    }, [getPartnerPriceBookName, getPriceBookItemForPartner])

    const getSalesProductOptions = (storageId: string, selectedProductId: string) => {
        const availableIds = availableSalesProductIdsByStorage.get(storageId) ?? new Set<string>()
        const isServicesSource = storageId === SERVICES_VIRTUAL_STORAGE_ID
        return products.filter((product) => {
            const serviceInServicesSource = isServicesSource && hasFeature('services') && isService(product)
            return (product.id === selectedProductId
                || availableIds.has(product.id)
                || serviceInServicesSource)
                && (serviceInServicesSource || hasValidProductCost(product.costPrice))
                && (serviceInServicesSource || !hasMissingPartnerPriceBookCost(selectedCustomer, product.id))
        })
    }

    const resolveItemPricing = useCallback((
        productId: string,
        batchId: string,
        partnerCurrency: CurrencyCode,
        partner: Pick<BusinessPartner, 'priceBookId'> | null | undefined
    ): Pick<FormItem, 'unitPrice' | 'priceBookId' | 'priceBookItemId' | 'priceSourceCurrency' | 'priceBookCostPrice'> => {
        const product = products.find((entry) => entry.id === productId)
        if (!product) {
            return {
                unitPrice: '',
                priceBookId: '',
                priceBookItemId: '',
                priceSourceCurrency: '',
                priceBookCostPrice: ''
            }
        }

        const priceBookItem = getPriceBookItemForPartner(partner, productId)
        if (priceBookItem) {
            const discount = resolveDiscountForPrice(product, {
                priceBookId: partner?.priceBookId ?? null,
                basePrice: priceBookItem.price,
                currency: priceBookItem.currency
            })
            return {
                unitPrice: String(convertCurrencyAmountWithLiveRates(
                    discount?.discountPrice ?? priceBookItem.price,
                    priceBookItem.currency,
                    partnerCurrency,
                    liveRates
                )),
                priceBookId: priceBookItem.priceBookId,
                priceBookItemId: priceBookItem.id,
                priceSourceCurrency: priceBookItem.currency,
                priceBookCostPrice: priceBookItem.costPrice == null ? '' : String(priceBookItem.costPrice)
            }
        }

        const batch = batchId && batchId !== PRODUCT_STOCK_SELECTION
            ? stockBatchesById.get(batchId)
            : undefined
        const sourcePrice = batch && batch.productId === productId ? batch.price : product.price
        const sourceCurrency = batch && batch.productId === productId ? batch.currency : product.currency
        const discount = resolveDiscountForPrice(product, {
            priceBookId: partner?.priceBookId ?? null,
            basePrice: sourcePrice,
            currency: sourceCurrency
        })
        return {
            unitPrice: String(convertCurrencyAmountWithLiveRates(discount?.discountPrice ?? sourcePrice, sourceCurrency, partnerCurrency, liveRates)),
            priceBookId: '',
            priceBookItemId: '',
            priceSourceCurrency: '',
            priceBookCostPrice: ''
        }
    }, [getPriceBookItemForPartner, liveRates, products, resolveDiscountForPrice, stockBatchesById])

    const getItemCostDetails = useCallback((item: FormItem, product: typeof products[number]) => {
        const hasPriceBookProvenance = Boolean(item.priceBookId && item.priceBookItemId)
        const sourceCurrency = hasPriceBookProvenance && item.priceSourceCurrency
            ? item.priceSourceCurrency
            : product.currency
        const priceBookCostPrice = item.priceBookCostPrice === ''
            ? (product.costPrice ?? 0)
            : Number(item.priceBookCostPrice)
        const sourceCostPrice = hasPriceBookProvenance && Number.isFinite(priceBookCostPrice)
            ? priceBookCostPrice
            : (product.costPrice ?? 0)

        return {
            sourceCostPrice,
            convertedCostPrice: convertCurrencyAmountWithLiveRates(
                sourceCostPrice,
                sourceCurrency,
                currency,
                liveRates
            )
        }
    }, [currency, liveRates])

    const isItemSellingAtLoss = useCallback((item: FormItem, product: typeof products[number] | undefined) => {
        if (!product || item.unitPrice.trim() === '') return false

        const sellingPrice = Number(item.unitPrice)
        const { convertedCostPrice } = getItemCostDetails(item, product)
        return Number.isFinite(sellingPrice)
            && convertedCostPrice > 0
            && sellingPrice < convertedCostPrice
    }, [getItemCostDetails])

    const selectCustomerPartner = useCallback((partner: Pick<BusinessPartner, 'id' | 'partnerName' | 'defaultCurrency' | 'priceBookId'>) => {
        setSalesAccountAgentId('')
        const nextCurrency = partner.defaultCurrency || currency
        setCustomerSearch(partner.partnerName)
        setCustomerId(partner.id)
        changeOrderCurrency(nextCurrency)
        setItems((current) => current.map((item) => item.productId
            ? { ...item, ...resolveItemPricing(item.productId, item.batchId, nextCurrency, partner) }
            : item
        ))
    }, [changeOrderCurrency, currency, resolveItemPricing])

    const selectSalesAccountAgent = useCallback((agentId: string) => {
        if (!agentId) {
            setSalesAccountAgentId('')
            setCustomerId('')
            setCustomerSearch('')
            return
        }
        const agent = agents.find((candidate) => (
            candidate.id === agentId
            && !candidate.isDeleted
            && candidate.status === 'active'
            && candidate.salesAccountEnabled
        ))
        const partner = agent && agentPartners.find((candidate) => candidate.id === agent.businessPartnerId)
        if (!agent || !partner) return

        setSalesAccountAgentId(agent.id)
        const nextCurrency = partner.defaultCurrency || currency
        setCustomerSearch(partner.partnerName)
        setCustomerId(partner.id)
        changeOrderCurrency(nextCurrency)
        setItems((current) => current.map((item) => item.productId
            ? { ...item, ...resolveItemPricing(item.productId, item.batchId, nextCurrency, partner) }
            : item
        ))
    }, [agentPartners, agents, changeOrderCurrency, currency, resolveItemPricing])

    const handleStorageMissing = useCallback((index: number) => {
        setHighlightedStorageIndex(index)
        setTimeout(() => setHighlightedStorageIndex((prev) => prev === index ? null : prev), 3000)
        const el = document.getElementById(`sales-storage-${index}`)
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, [])

    const highlightCustomerInformation = useCallback(() => {
        if (!isCustomerSelectionRequired) return

        setIsCustomerInformationHighlighted(true)
        if (customerHighlightTimeoutRef.current) clearTimeout(customerHighlightTimeoutRef.current)
        customerHighlightTimeoutRef.current = setTimeout(() => {
            setIsCustomerInformationHighlighted(false)
            customerHighlightTimeoutRef.current = null
        }, 1800)

        const customerInformation = customerInformationRef.current
        customerInformation?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
        setTimeout(() => {
            customerInformation?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true })
        }, 250)
    }, [isCustomerSelectionRequired])

    const updateItem = (index: number, changes: Partial<FormItem>) => {
        setItems((current) =>
            current.map((item, itemIndex) => {
                if (itemIndex !== index) return item
                if (priceBooksEnabled && changes.productId && !selectedCustomer) return item
                const next = { ...item, ...changes }
                if (changes.productId !== undefined) {
                    if (!changes.productId) {
                        next.batchId = ''
                        next.priceBookId = ''
                        next.priceBookItemId = ''
                        next.priceSourceCurrency = ''
                        next.priceBookCostPrice = ''
                    } else {
                        const selectedProduct = products.find((product) => product.id === changes.productId)
                        if (isService(selectedProduct)) {
                            next.storageId = SERVICES_VIRTUAL_STORAGE_ID
                            next.batchId = ''
                            Object.assign(next, resolveItemPricing(changes.productId, '', currency, selectedCustomer))
                            return next
                        }
                        const preferredBatchId = changes.batchId === undefined
                            ? getBatchesForPosition(changes.productId, next.storageId)[0]?.id || ''
                            : changes.batchId
                        next.batchId = preferredBatchId
                        Object.assign(next, resolveItemPricing(changes.productId, next.batchId, currency, selectedCustomer))
                    }
                } else if (changes.storageId !== undefined && next.productId) {
                    const preferredBatch = getBatchesForPosition(next.productId, changes.storageId)[0]
                    next.batchId = preferredBatch?.id || ''
                    next.unitPrice = resolveItemPricing(next.productId, next.batchId, currency, selectedCustomer).unitPrice
                } else if (changes.batchId !== undefined) {
                    next.unitPrice = resolveItemPricing(next.productId, changes.batchId, currency, selectedCustomer).unitPrice
                }
                return next
            })
        )
    }

    const selectProductForItem = (index: number, product: typeof products[number]) => {
        if (!isService(product) && !hasValidProductCost(product.costPrice)) {
            toast({
                title: t('common.error') || 'Error',
                description: getMissingProductCostMessage(product.name),
                variant: 'destructive'
            })
            return
        }
        if (hasMissingPartnerPriceBookCost(selectedCustomer, product.id)) {
            toast({
                title: t('common.error') || 'Error',
                description: getMissingPriceBookCostMessage(product.name, getPartnerPriceBookName(selectedCustomer)),
                variant: 'destructive'
            })
            return
        }
        updateItem(index, {
            productId: product.id,
            productSearch: product.name,
            ...(isService(product) ? { storageId: SERVICES_VIRTUAL_STORAGE_ID, batchId: '' } : {})
        })
    }

    useOrderBarcodeScanner({
        enabled: !isCustomerSelectionRequired && !(priceBooksEnabled && (!isPriceBookCatalogReady || !selectedCustomer)),
        items,
        products,
        productBarcodes,
        onProductScanned: (product, index) => {
            const item = items[index]
            const isAvailableForLine = item && getSalesProductOptions(item.storageId, item.productId)
                .some((candidate) => candidate.id === product.id)
            if (!isAvailableForLine) {
                toast({
                    title: t('products.notFoundTitle', { defaultValue: 'Product not found' }),
                    description: t('products.notFoundDescription', { defaultValue: 'This product could not be found. It may have been deleted or is no longer available.' }),
                    variant: 'destructive'
                })
                return
            }
            selectProductForItem(index, product)
        },
        onProductNotFound: () => toast({
            title: t('products.notFoundTitle', { defaultValue: 'Product not found' }),
            description: t('products.notFoundDescription', { defaultValue: 'This product could not be found. It may have been deleted or is no longer available.' }),
            variant: 'destructive'
        })
    })

    useEffect(() => {
        if (stockBatches.length === 0) return
        if (priceBooksEnabled && !selectedCustomer) return
        setItems((current) => {
            let changed = false
            const next = current.map((item) => {
                if (!item.productId || !item.storageId || item.batchId || isService(products.find((product) => product.id === item.productId))) return item
                const preferredBatch = getBatchesForPosition(item.productId, item.storageId)[0]
                if (!preferredBatch) return item
                changed = true
                return {
                    ...item,
                    batchId: preferredBatch.id,
                    unitPrice: resolveItemPricing(item.productId, preferredBatch.id, currency, selectedCustomer).unitPrice
                }
            })
            return changed ? next : current
        })
    }, [currency, getBatchesForPosition, priceBooksEnabled, resolveItemPricing, selectedCustomer, stockBatches.length])

    const lossMakingItems = useMemo(() => {
        const rows: Array<{
            index: number
            productName: string
            sellingPrice: number
            costPrice: number
        }> = []

        items.forEach((item, index) => {
            const product = products.find((entry) => entry.id === item.productId)
            if (!product || Number(item.quantity) <= 0 || !isItemSellingAtLoss(item, product)) return

            rows.push({
                index,
                productName: product.name,
                sellingPrice: Number(item.unitPrice),
                costPrice: getItemCostDetails(item, product).convertedCostPrice
            })
        })

        return rows
    }, [getItemCostDetails, isItemSellingAtLoss, items, products])

    const preview = useMemo(() => {
        const subtotal = items.reduce((sum, item) => sum + ((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0)), 0)
        const existingCalculatedTotal = subtotal - Number(discount || 0) + Number(tax || 0)
        return calculateOrderTotalWithAdjustments(existingCalculatedTotal, orderAdjustments)
    }, [currency, discount, items, orderAdjustments, tax])

    const configuredItemsCount = useMemo(
        () => items.filter((item) => item.productId && hasOrderLineInventoryQuantity(item)).length,
        [items]
    )

    const initialPayment = roundFormAmount(Math.max(0, Number(initialPaymentAmount || 0)))
    const isFinanced = paymentMethod === 'loan' || paymentMethod === 'installments'
    const isInstallmentBased = paymentMethod === 'installments'
    const canSubmit = Boolean(selectedCustomer) &&
        items.some((item) => item.productId && hasOrderLineInventoryQuantity(item)) &&
        (!priceBooksEnabled || isPriceBookCatalogReady) &&
        (!isFinanced || initialPayment < preview) &&
        (!isInstallmentBased || (
            Number(installmentCount) >= 1
            && Boolean(firstDueDate)
        ))

    const submitOrder = async (skipLossWarning = false) => {
        if (priceBooksEnabled && !isPriceBookCatalogReady) return
        if (!user?.workspaceId || isSaving) return

        const customer = selectedCustomer
        if (!customer) {
            toast({ title: t('common.error') || 'Error', description: t('orders.noCustomers') || 'Add customers before creating orders.', variant: 'destructive' })
            return
        }
        if (isFinanced && initialPayment >= preview) {
            toast({
                title: t('common.error') || 'Error',
                description: t('orders.form.errors.installmentBalanceRequired', { defaultValue: 'The initial payment must be less than the order total.' }),
                variant: 'destructive'
            })
            return
        }

        setIsSaving(true)
        try {
            let usesPriceBookPricing = false
            const orderItems: SalesOrderItem[] = items
                .filter((item) => item.productId && hasOrderLineInventoryQuantity(item))
                .map((item) => {
                    const product = products.find((entry) => entry.id === item.productId)
                    if (!product) {
                        throw new Error(t('orders.form.errors.productNotFound', { defaultValue: 'Selected product was not found.' }))
                    }
                    if (hasMissingPartnerPriceBookCost(customer, product.id)) {
                        throw new Error(getMissingPriceBookCostMessage(product.name, getPartnerPriceBookName(customer)))
                    }
                    const service = isService(product)
                    if (!service && !item.storageId) {
                        throw new Error(t('orders.form.errors.sourceStorageRequired', {
                            productName: product.name,
                            defaultValue: `Select a source storage for ${product.name}.`
                        }))
                    }

                    const quantity = Number(item.quantity)
                    const freeBonusQuantityValue = Number(item.freeBonusQuantity || 0)
                    if (!Number.isFinite(quantity) || quantity < 0) {
                        throw new Error(t('orders.form.errors.invalidQuantity', {
                            productName: product.name,
                            defaultValue: `Enter a valid quantity for ${product.name}.`
                        }))
                    }
                    const hasPriceBookProvenance = Boolean(item.priceBookId && item.priceBookItemId)
                    if (hasPriceBookProvenance) usesPriceBookPricing = true
                    const sourceCurrency = hasPriceBookProvenance && item.priceSourceCurrency
                        ? item.priceSourceCurrency
                        : product.currency
                    const { sourceCostPrice, convertedCostPrice } = getItemCostDetails(item, product)
                    const unitPrice = Number(item.unitPrice || 0)
                    if (!Number.isFinite(freeBonusQuantityValue) || freeBonusQuantityValue < 0) {
                        throw new Error(t('orders.form.errors.invalidFreeBonus', {
                            productName: product.name,
                            defaultValue: `Enter a valid free bonus for ${product.name}.`
                        }))
                    }
                    const freeBonusQuantity = freeBonusQuantityValue
                    const inventoryQuantity = quantity + freeBonusQuantity
                    const selectedBatch = !service && item.batchId && item.batchId !== PRODUCT_STOCK_SELECTION
                        ? stockBatchesById.get(item.batchId)
                        : null
                    if (item.batchId && item.batchId !== PRODUCT_STOCK_SELECTION) {
                        if (!selectedBatch
                            || selectedBatch.productId !== product.id
                            || selectedBatch.storageId !== item.storageId) {
                            throw new Error(t('orders.form.errors.batchNotAvailable', {
                                productName: product.name,
                                defaultValue: `The selected batch for ${product.name} is no longer available.`
                            }))
                        }
                        if (inventoryQuantity > selectedBatch.quantity) {
                            throw new Error(t('orders.form.errors.batchQuantityExceeded', {
                                productName: product.name,
                                defaultValue: `The selected batch for ${product.name} does not have enough stock.`
                            }))
                        }
                    }
                    return {
                        id: `${product.id}-${item.storageId}-${item.batchId}-${quantity}-${freeBonusQuantity}-${unitPrice}`,
                        productId: product.id,
                        note: item.note.trim() || null,
                        priceBookId: hasPriceBookProvenance ? item.priceBookId : null,
                        priceBookItemId: hasPriceBookProvenance ? item.priceBookItemId : null,
                        storageId: service ? SERVICES_VIRTUAL_STORAGE_ID : item.storageId,
                        productName: product.name,
                        productSku: product.sku,
                        unit: product.unit,
                        quantity,
                        ...(freeBonusQuantity > 0 ? { freeBonusQuantity } : {}),
                        ...(item.freeBonusUnit && item.freeBonusUnit !== product.unit ? { freeBonusUnit: item.freeBonusUnit } : {}),
                        lineTotal: roundFormAmount(quantity * unitPrice),
                        originalCurrency: sourceCurrency,
                        originalUnitPrice: convertCurrencyAmountWithLiveRates(
                            unitPrice,
                            currency,
                            sourceCurrency,
                            liveRates
                        ),
                        convertedUnitPrice: roundFormAmount(unitPrice),
                        settlementCurrency: currency,
                        costPrice: sourceCostPrice,
                        convertedCostPrice,
                        ...(service || item.batchId === ''
                            ? { batchAllocations: null }
                            : item.batchId === PRODUCT_STOCK_SELECTION
                                ? { batchAllocations: [] }
                                : {
                                    batchAllocations: [{
                                        batchId: selectedBatch!.id,
                                        batchNumber: selectedBatch!.batchNumber,
                                        quantity: inventoryQuantity,
                                        price: selectedBatch!.price,
                                        costPrice: selectedBatch!.costPrice,
                                        currency: selectedBatch!.currency,
                                        expiryDate: selectedBatch!.expiryDate ?? null,
                                        manufacturingDate: selectedBatch!.manufacturingDate ?? null
                                    }]
                                })
                    }
                })

            if (orderItems.length === 0) {
                throw new Error(t('orders.form.errors.atLeastOneItem', { defaultValue: 'Add at least one item.' }))
            }
            if (!hideCosts && !skipLossWarning && orderItems.some((item) =>
                item.convertedCostPrice > 0 && item.convertedUnitPrice < item.convertedCostPrice
            )) {
                setIsLossWarningOpen(true)
                return
            }
            const hasMultiCurrency = orderItems.some(item => item.originalCurrency !== item.settlementCurrency)
            const hasAdjustmentCurrencyConversion = orderAdjustments.some((adjustment) => adjustment.currency !== currency)
            const manualCommissionValidation = commissionAssignmentRef.current?.validate()
            const hasManualCommissionCurrencyConversion = Boolean(manualCommissionValidation?.hasManualCommissionCurrencyConversion)
            const hasCommissionPlanCurrencyConversion = Boolean(manualCommissionValidation?.hasCommissionPlanCurrencyConversion)
            const hasOrderRateSnapshot = hasMultiCurrency
                || usesPriceBookPricing
                || hasAdjustmentCurrencyConversion
                || hasManualCommissionCurrencyConversion
                || hasCommissionPlanCurrencyConversion
            const snapshot = hasOrderRateSnapshot ? adjustmentExchangeRates : []
            const primaryRate = hasMultiCurrency ? getPrimaryExchangeDetails(currency, features.default_currency, snapshot) : null
            const commonStorageId = getCommonStorageId(orderItems)
            const subtotal = roundFormAmount(orderItems.reduce((sum, item) => sum + item.lineTotal, 0))
            const discountNum = roundFormAmount(Number(discount || 0))
            const taxNum = roundFormAmount(Number(tax || 0))
            const existingCalculatedTotal = roundFormAmount(subtotal - discountNum + taxNum)
            const total = calculateOrderTotalWithAdjustments(existingCalculatedTotal, orderAdjustments)
            const paidAmount = isFinanced ? initialPayment : isPaid ? total : 0
            const balanceAmount = roundFormAmount(Math.max(total - paidAmount, 0))
            const savedAt = new Date().toISOString()

            const payload = {
                businessPartnerId: customer.id,
                customerId: customer.id,
                customerName: customer.partnerName,
                ...(agentSalesAccountsEnabled
                    ? { salesAccountAgentId: selectedSalesAccount?.agent.id ?? null }
                    : {}),
                sourceStorageId: commonStorageId === SERVICES_VIRTUAL_STORAGE_ID ? null : commonStorageId,
                items: orderItems,
                subtotal,
                discount: discountNum,
                tax: taxNum,
                total,
                currency,
                // Undefined is intentionally used for an empty collection. The
                // local order layer removes the property and clears JSONB remotely.
                orderAdjustments: orderAdjustments.length > 0 ? orderAdjustments : undefined,
                exchangeRate: primaryRate?.exchangeRate ?? null,
                exchangeRateSource: primaryRate?.exchangeRateSource ?? null,
                exchangeRateTimestamp: primaryRate?.exchangeRateTimestamp ?? null,
                exchangeRates: hasOrderRateSnapshot ? snapshot : null,
                status: 'draft' as SalesOrderStatus,
                expectedDeliveryDate: expectedDeliveryDate || null,
                createdAt: parseLocalDateTimeValue(orderCreationDate)?.toISOString() || formOpenedAtRef.current,
                actualDeliveryDate: null,
                isPaid: !isFinanced && balanceAmount <= 0,
                paymentStatus: balanceAmount <= 0 ? 'paid' as const : paidAmount > 0 ? 'partial' as const : 'unpaid' as const,
                paidAmount,
                balanceAmount,
                paidAt: !isFinanced && paidAmount > 0 ? savedAt : null,
                paymentMethod: paymentMethod as SalesOrder['paymentMethod'],
                initialPaymentAmount: isFinanced ? initialPayment : 0,
                initialPaymentAccountId,
                initialPaymentAccountNameSnapshot,
                linkedLoanId: editingOrder?.linkedLoanId || null,
                isInstallmentBased,
                installmentCount: isInstallmentBased ? Math.max(1, Math.trunc(Number(installmentCount) || 1)) : paymentMethod === 'loan' && firstDueDate ? 1 : 0,
                installmentFrequency: isFinanced ? installmentFrequency : null,
                firstDueDate: isFinanced ? firstDueDate || null : null,
                nextDueDate: isFinanced ? firstDueDate || null : null,
                reservedAt: null,
                shippingAddress: shippingAddress || undefined,
                notes: notes || undefined,
                ...(requiresApprovalRequest ? {
                    approvalStatus: 'requested' as const,
                    approvalRequestedBy: user.id,
                    approvalRequestedAt: savedAt,
                    approvalReviewedBy: null,
                    approvalReviewedAt: null
                } : {})
            }

            const savedOrder = editingOrderId
                ? await updateSalesOrder(editingOrderId, payload)
                : await createSalesOrder(workspaceId, payload, user?.id ?? null)

            let commissionAssignmentError: unknown = null
            try {
                await commissionAssignmentRef.current?.save(savedOrder)
            } catch (error) {
                commissionAssignmentError = error
            }

            if (commissionAssignmentError) {
                toast({
                    title: t('salesAgentCommissions.assignmentNeedsAttention'),
                    description: commissionAssignmentError instanceof Error
                        ? commissionAssignmentError.message
                        : t('salesAgentCommissions.assignmentNeedsAttentionDescription'),
                    variant: 'destructive'
                })
            } else {
                toast({
                    title: requiresApprovalRequest
                        ? t('orders.form.requestSent', { defaultValue: 'Request sent' })
                        : editingOrderId ? (t('common.save') || 'Saved') : (t('common.create') || 'Created')
                })
            }
            if (!editingOrderId) {
                demoTutorial.completeOrderCreated(savedOrder.id, 'sales')
            }
            onCreated?.(savedOrder.id)
        } catch (error: any) {
            const message = error?.message === 'agent_sales_accounts_not_enabled'
                ? t('agentSalesAccounts.notEnabled')
                : error?.message === 'agent_sales_account_unavailable'
                    ? t('agentSalesAccounts.unavailable')
                    : error?.message || t('orders.form.errors.saveSalesFailed', { defaultValue: 'Failed to save sales order.' })
            toast({
                title: t('common.error') || 'Error',
                description: message,
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        void submitOrder()
    }

    return (
        <div className="w-full">
            <form onSubmit={handleSubmit}>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-1">
                        <Button
                            type="button"
                            variant="ghost"
                            className="h-auto gap-2 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                            onClick={onCancel}
                        >
                            <ArrowLeft className="h-4 w-4" />
                            {t('orders.title', { defaultValue: 'Orders' })}
                        </Button>
                        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight" data-tour-id="tutorial-order-form-title">
                            <ShoppingCart className="h-7 w-7" />
                            {editingOrderId
                                ? t('orders.form.editSalesOrder', { defaultValue: 'Edit Sales Order' })
                                : t('orders.form.newSalesOrder', { defaultValue: 'New Sales Order' })}
                        </h1>
                        <p className="text-sm text-muted-foreground">
                            {t('orders.form.salesDescription', { defaultValue: 'Create a sales order, assign a customer and products, then reserve stock.' })}
                        </p>
                    </div>
                </div>

                <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,2.5fr)_minmax(400px,0.9fr)]">
                    <div className="space-y-5">
                        <Card
                            ref={customerInformationRef}
                            tabIndex={-1}
                            className={cn(
                                'transition-[border-color,box-shadow] duration-200',
                                isCustomerInformationHighlighted && 'border-destructive ring-2 ring-destructive/70 ring-offset-2 ring-offset-background motion-safe:animate-pulse'
                            )}
                        >
                            <CardHeader>
                                <CardTitle>{t('orders.form.customerInformation', { defaultValue: 'Customer Information' })}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="grid gap-4">
                                    {agentSalesAccountsEnabled ? (
                                        <div className="grid gap-2">
                                            <Label htmlFor="sales-order-sales-account" className="flex items-center gap-2">
                                                <Users className="h-4 w-4 text-muted-foreground" />
                                                {t('agentSalesAccounts.salesAccount')}
                                            </Label>
                                            <Select
                                                value={salesAccountAgentId || 'workspace'}
                                                onValueChange={(value) => selectSalesAccountAgent(value === 'workspace' ? '' : value)}
                                                disabled={isSaving}
                                            >
                                                <SelectTrigger id="sales-order-sales-account">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="workspace">
                                                        {t('agentSalesAccounts.workspaceAccount')}
                                                    </SelectItem>
                                                    {agents
                                                        .filter((agent) => !agent.isDeleted && agent.status === 'active' && agent.salesAccountEnabled)
                                                        .map((agent) => {
                                                            const partner = agentPartners.find((candidate) => candidate.id === agent.businessPartnerId)
                                                            if (!partner) return null
                                                            return (
                                                                <SelectItem key={agent.id} value={agent.id}>
                                                                    {partner.partnerName}
                                                                </SelectItem>
                                                            )
                                                        })}
                                                </SelectContent>
                                            </Select>
                                            <p className="text-xs leading-5 text-muted-foreground">
                                                {t('agentSalesAccounts.salesAccountOrderHint')}
                                            </p>
                                        </div>
                                    ) : null}
                                    <div className="grid gap-2">
                                        <Label>
                                            {selectedSalesAccount
                                                ? t('agentSalesAccounts.sellingAgent')
                                                : t('orders.form.customer', { defaultValue: 'Customer' })}{' '}
                                            <span className="text-destructive">*</span>
                                        </Label>
                                        {!selectedSalesAccount ? (
                                            <div className="flex flex-col gap-2 md:flex-row md:items-center" data-tour-id="tutorial-order-partner-picker">
                                                <PartnerAutocompleteInput
                                                    value={customerSearch}
                                                    onChange={(value) => {
                                                        setCustomerSearch(value)
                                                        setCustomerId('')
                                                    }}
                                                    onSelectPartner={(partner: BusinessPartner) => {
                                                        selectCustomerPartner(partner)
                                                    }}
                                                    workspaceId={workspaceId}
                                                    roles={['customer']}
                                                    placeholder={t('orders.form.selectCustomer', { defaultValue: 'Select Customer' })}
                                                />
                                                <QuickCustomerButton
                                                    workspaceId={workspaceId}
                                                    className="w-full shrink-0 md:w-auto"
                                                    onCreated={selectCustomerPartner}
                                                />
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    className="w-full shrink-0 gap-2 md:w-auto"
                                                    onClick={() => setIsCustomerPickerOpen(true)}
                                                >
                                                    <Users className="h-4 w-4" />
                                                    {t('orders.form.businessPartner')}
                                                </Button>
                                            </div>
                                        ) : null}
                                        {customerId && selectedCustomer ? (
                                            <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
                                                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                                    <div className="min-w-0">
                                                        <div className="text-[11px] font-bold uppercase tracking-wide text-primary">
                                                            {selectedSalesAccount
                                                                ? t('agentSalesAccounts.sellingAgent')
                                                                : t('customers.title', { defaultValue: 'Customer' })}
                                                        </div>
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <div className="text-sm font-semibold">{selectedCustomer.partnerName}</div>
                                                            <PartnerBalanceSummary
                                                                compact
                                                                partner={selectedCustomer}
                                                                iqdPreference={features.iqd_display_preference}
                                                            />
                                                        </div>
                                                    </div>
                                                    {!selectedSalesAccount ? (
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            className="h-8 shrink-0 px-2 text-muted-foreground"
                                                            onClick={() => {
                                                                setCustomerId('')
                                                                setCustomerSearch('')
                                                            }}
                                                        >
                                                            <X className="h-4 w-4" />
                                                            {t('loans.clearParty', { defaultValue: 'Clear Link' })}
                                                        </Button>
                                                    ) : null}
                                                </div>
                                            </div>
                                        ) : null}
                                    </div>
                                    <div className="grid gap-2">
                                        <Label className="flex items-center gap-2">
                                            <Truck className="h-4 w-4 text-muted-foreground" />
                                            {t('orders.form.shippingAddress', { defaultValue: 'Shipping Address' })}
                                        </Label>
                                        <Textarea
                                            rows={3}
                                            value={shippingAddress}
                                            onChange={(event) => setShippingAddress(event.target.value)}
                                            placeholder={t('orders.form.shippingPlaceholder', { defaultValue: 'Enter shipping address...' })}
                                        />
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                        {canAssignSalesAgents ? (
                            <PartnerRequiredSection
                                locked={isCustomerSelectionRequired}
                                unlockLabel={t('orders.form.selectBusinessPartnerToUnlock')}
                                onLockedInteraction={highlightCustomerInformation}
                            >
                                <SalesOrderCommissionAssignmentSection
                                    ref={commissionAssignmentRef}
                                    workspaceId={workspaceId}
                                    editingOrderId={editingOrderId}
                                    salesAccountAgentId={selectedSalesAccount?.agent.id ?? null}
                                    customerCity={selectedCustomer?.city || ''}
                                    assignedBy={user?.id}
                                    orderCurrency={currency}
                                    orderTotal={preview}
                                    exchangeRates={adjustmentExchangeRates}
                                    availableCurrencies={Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as CurrencyCode[]}
                                    iqdDisplayPreference={features.iqd_display_preference}
                                    allowPlanCommissionAmountOverride
                                    onCommissionSummaryChange={setCommissionAssignmentSummaries}
                                    disabled={isSaving}
                                />
                            </PartnerRequiredSection>
                        ) : null}
                        <LoanPartyPickerDialog
                            isOpen={isCustomerPickerOpen}
                            onOpenChange={setIsCustomerPickerOpen}
                            workspaceId={workspaceId}
                            roles={['customer']}
                            selectedPartyId={customerId}
                            copy={{
                                title: t('orders.form.businessPartner'),
                                description: t('orders.form.businessPartnerPickerDescription'),
                                searchPlaceholder: t('orders.form.searchBusinessPartners'),
                                noResultsMessage: t('orders.form.noBusinessPartnersFound')
                            }}
                            onSelect={(selection) => {
                                if (selection.linkedPartyId) {
                                    const partner = customerPartners.find((entry) => entry.id === selection.linkedPartyId)
                                    if (partner) {
                                        selectCustomerPartner(partner)
                                    } else {
                                        selectCustomerPartner({
                                            id: selection.linkedPartyId,
                                            partnerName: selection.linkedPartyName || '',
                                            defaultCurrency: selection.defaultCurrency,
                                            priceBookId: null
                                        })
                                    }
                                }
                                setIsCustomerPickerOpen(false)
                            }}
                        />

                        <PartnerRequiredSection
                            locked={isCustomerSelectionRequired}
                            unlockLabel={t('orders.form.selectBusinessPartnerToUnlock', { defaultValue: 'Select a business partner to unlock this section.' })}
                            onLockedInteraction={highlightCustomerInformation}
                        >
                            <Card className={cn(
                                'transition-[border-color,background-color] duration-200',
                                isCustomerSelectionRequired && 'border-destructive/70 bg-destructive/5'
                            )}>
                                <CardHeader className="flex flex-col items-start justify-between gap-4 space-y-0 sm:flex-row">
                                    <div className="space-y-1">
                                        <CardTitle>{t('orders.form.lineItems', { defaultValue: 'Line Items' })}</CardTitle>
                                        <p className="text-sm text-muted-foreground">
                                            {t('orders.form.lineItemsDescription', { defaultValue: 'Add products with quantities and prices.' })}
                                        </p>
                                    </div>
                                    <Button type="button" variant="outline" size="sm" onClick={() => setItems((current) => {
                                        const nextSeq = current.reduce((max, it) => Math.max(max, it.seq), 0) + 1
                                        setHighlightedNewSeq(nextSeq)
                                        return [createEmptyItem(current[current.length - 1]?.storageId || sourceStorageId || defaultStorageId, nextSeq), ...current]
                                    })}>
                                        <Plus className="mr-1 h-3.5 w-3.5" />
                                        {t('orders.form.addItem', { defaultValue: 'Add Item' })}
                                    </Button>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {items.map((item, index) => {
                                        const product = products.find((entry) => entry.id === item.productId)
                                        const freeBonusDisplayUnit = item.freeBonusUnit || product?.unit || ''
                                        const lineTotal = roundFormAmount((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0))
                                        const costPrice = product ? getItemCostDetails(item, product).convertedCostPrice : 0
                                        const isSellingAtLoss = isItemSellingAtLoss(item, product)
                                        const freeBonusQuantity = Math.max(0, Number(item.freeBonusQuantity || 0))
                                        const inventoryQuantity = (Number(item.quantity) || 0) + (canUseFreeBonus ? freeBonusQuantity : 0)
                                        const lineBatches = getBatchesForPosition(item.productId, item.storageId)
                                        const selectedBatch = item.batchId && item.batchId !== PRODUCT_STOCK_SELECTION
                                            ? stockBatchesById.get(item.batchId)
                                            : null
                                        const batchSelectionValue = item.batchId || PRODUCT_STOCK_SELECTION
                                        const regularStockQuantity = getRegularStockQuantity(item.productId, item.storageId)
                                        const selectedSourceQuantity = selectedBatch?.quantity ?? regularStockQuantity
                                        const selectedSourceExceeded = Boolean(item.productId && item.storageId && inventoryQuantity > selectedSourceQuantity)
                                        const canOpenProductsView = Boolean(item.storageId)
                                            && !(priceBooksEnabled && (!isPriceBookCatalogReady || !selectedCustomer))

                                        return (
                                            <div
                                                key={`sales-item-${index}`}
                                                className={cn(
                                                    'relative grid gap-3 rounded-2xl border bg-background p-4 transition-all duration-700',
                                                    canUseFreeBonus
                                                        ? 'md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(80px,0.55fr)_minmax(80px,0.55fr)_minmax(108px,0.8fr)_minmax(72px,0.18fr)]'
                                                        : 'md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(80px,0.55fr)_minmax(108px,0.8fr)_minmax(72px,0.18fr)]',
                                                    isSellingAtLoss && 'border-destructive bg-destructive/5',
                                                    item.seq === highlightedNewSeq && 'border-primary ring-2 ring-primary/60 bg-primary/5'
                                                )}
                                            >
                                                <span className="absolute -top-2 start-3 z-10 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                                                    {item.seq}
                                                </span>
                                                <div
                                                    className="space-y-2"
                                                    data-tour-id={index === 0 ? 'tutorial-order-product-picker' : undefined}
                                                    data-demo-product-linked={item.productId ? 'true' : 'false'}
                                                >
                                                    <Label className="flex min-w-0 items-center gap-2">
                                                        <span className="truncate">{t('orders.form.selectProduct', { defaultValue: 'Select Product' })}</span>
                                                        {item.productId ? (
                                                            selectedBatch ? (
                                                                <TooltipProvider delayDuration={150}>
                                                                    <Tooltip>
                                                                        <TooltipTrigger asChild>
                                                                            <span tabIndex={0} className="inline-flex max-w-40 cursor-help items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-green-400">
                                                                                <Check className="h-3 w-3 shrink-0" />
                                                                                <span className="truncate">{selectedBatch.batchNumber}</span>
                                                                            </span>
                                                                        </TooltipTrigger>
                                                                        <TooltipContent side="top" align="start" className="max-w-xs break-words text-xs">
                                                                            {t('orders.form.batch', { defaultValue: 'Batch' })}: {selectedBatch.batchNumber}
                                                                        </TooltipContent>
                                                                    </Tooltip>
                                                                </TooltipProvider>
                                                            ) : (
                                                                <span className="inline-flex max-w-28 items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
                                                                    <Check className="h-3 w-3 shrink-0" />
                                                                    <span className="truncate">{t('orders.form.productStock', { defaultValue: 'Product stock' })}</span>
                                                                </span>
                                                            )
                                                        ) : null}
                                                    </Label>
                                                    <div className="flex items-center">
                                                        {canOpenProductsView ? (
                                                            <ProductsViewModalTrigger
                                                                label={t('products.title', { defaultValue: 'Browse products' })}
                                                                onClick={() => setProductsViewItemIndex(index)}
                                                            />
                                                        ) : null}
                                                        <ProductAutocompleteInput
                                                            className="min-w-0 flex-1"
                                                            inputClassName={canOpenProductsView ? 'rounded-s-none' : undefined}
                                                            scannerTargetIndex={index}
                                                            value={item.productSearch}
                                                            onChange={(value) => updateItem(index, { productSearch: value, productId: '' })}
                                                            onSelectProduct={(product) => selectProductForItem(index, product)}
                                                            products={getSalesProductOptions(item.storageId, item.productId)}
                                                            disabled={priceBooksEnabled && (!isPriceBookCatalogReady || !selectedCustomer)}
                                                            placeholder={priceBooksEnabled && !selectedCustomer
                                                                ? t('priceBooks.selectPartnerFirst', { defaultValue: 'Select a business partner first' })
                                                                : priceBooksEnabled && priceBookCatalogError
                                                                    ? t('priceBooks.loadingErrorShort', { defaultValue: 'Price Books unavailable - retrying...' })
                                                                    : t('orders.form.selectProduct', { defaultValue: 'Select Product' })}
                                                            hasSelection={!!item.productId}
                                                            showLinkedIndicator={false}
                                                            storageMissing={!item.storageId}
                                                            storageMissingLabel={t('orders.form.selectStorage', { defaultValue: 'Select Storage' })}
                                                            onStorageMissingClick={() => handleStorageMissing(index)}
                                                        />
                                                    </div>
                                                    {item.productId && item.storageId && !isService(product) ? (
                                                        <div className="space-y-1.5 pt-1">
                                                            <Label className="text-xs">{t('orders.form.stockSource', { defaultValue: 'Stock source' })}</Label>
                                                            <Select value={batchSelectionValue} onValueChange={(value) => updateItem(index, { batchId: value })}>
                                                                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                                                                <SelectContent>
                                                                    <SelectItem value={PRODUCT_STOCK_SELECTION} disabled={regularStockQuantity <= 0 && lineBatches.length > 0}>
                                                                        {t('orders.form.productStock', { defaultValue: 'Product stock' })} · {regularStockQuantity} {t('orders.form.available', { defaultValue: 'available' })}
                                                                    </SelectItem>
                                                                    {lineBatches.map((batch) => (
                                                                        <SelectItem key={batch.id} value={batch.id}>
                                                                            {t('orders.form.batch', { defaultValue: 'Batch' })} {batch.batchNumber} · {batch.quantity} · {formatCurrency(
                                                                                convertCurrencyAmountWithLiveRates(batch.price, batch.currency, currency, liveRates),
                                                                                currency,
                                                                                features.iqd_display_preference
                                                                            )}
                                                                        </SelectItem>
                                                                    ))}
                                                                </SelectContent>
                                                            </Select>
                                                            <p className={cn('text-xs', selectedSourceExceeded ? 'text-destructive' : 'text-muted-foreground')}>
                                                                {selectedBatch
                                                                    ? `${t('orders.form.batch', { defaultValue: 'Batch' })} ${selectedBatch.batchNumber}: ${selectedBatch.quantity} ${t('orders.form.available', { defaultValue: 'available' })}`
                                                                    : `${t('orders.form.productStock', { defaultValue: 'Product stock' })}: ${regularStockQuantity} ${t('orders.form.available', { defaultValue: 'available' })}`}
                                                                {selectedSourceExceeded ? ` — ${t('orders.form.errors.batchQuantityExceeded', {
                                                                    productName: product?.name || '',
                                                                    defaultValue: 'Selected source does not have enough stock.'
                                                                })}` : ''}
                                                            </p>
                                                        </div>
                                                    ) : null}
                                                </div>
                                                {isService(product) ? (
                                                    <div className="space-y-2">
                                                        <Label>{t('services.title', { defaultValue: 'Services' })}</Label>
                                                        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                                                            {t('services.noInventory', { defaultValue: 'Service sale — no stock or storage movement.' })}
                                                        </p>
                                                    </div>
                                                ) : (
                                                    <div id={`sales-storage-${index}`} className={cn('space-y-2', highlightedStorageIndex === index && 'animate-pulse')} data-tour-id={index === 0 ? 'tutorial-order-storage' : undefined}>
                                                        <Label className={cn(highlightedStorageIndex === index && 'text-destructive font-bold')}>{t('orders.form.selectStorage', { defaultValue: 'Select Storage' })}</Label>
                                                        <Select value={item.storageId} onValueChange={(value) => { setHighlightedStorageIndex(null); updateItem(index, { storageId: value }) }}>
                                                            <SelectTrigger className={cn(highlightedStorageIndex === index && 'ring-2 ring-destructive')}><SelectValue placeholder={t('orders.form.selectStorage', { defaultValue: 'Select Storage' })} /></SelectTrigger>
                                                            <SelectContent>
                                                                {storages.map((storage) => (
                                                                    <SelectItem key={storage.id} value={storage.id}>
                                                                        {storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name}
                                                                    </SelectItem>
                                                                ))}
                                                                {hasFeature('services') && (
                                                                    <SelectItem value={SERVICES_VIRTUAL_STORAGE_ID}>
                                                                        {t('services.title', { defaultValue: 'Services' })}
                                                                    </SelectItem>
                                                                )}
                                                            </SelectContent>
                                                        </Select>
                                                        <p className="text-xs text-muted-foreground">
                                                            {item.storageId && item.productId
                                                                ? t('orders.form.availableQuantity', {
                                                                    quantity: getAvailableQuantity(item.productId, item.storageId),
                                                                    defaultValue: `Available: ${getAvailableQuantity(item.productId, item.storageId)}`
                                                                })
                                                                : t('orders.form.chooseSourceStorageForLine', { defaultValue: 'Choose a source storage for this line.' })}
                                                        </p>
                                                    </div>
                                                )}
                                                <div className="space-y-2" data-tour-id={index === 0 ? 'tutorial-order-quantity' : undefined}>
                                                    <Label>{t('common.quantity', { defaultValue: 'Quantity' })}</Label>
                                                    <div className="flex items-center gap-1">
                                                        <Input type="number" min={(isService(product) || isDynamicUnit(product?.unit)) ? ORDER_DECIMAL_STEP : "1"} step={(isService(product) || isDynamicUnit(product?.unit)) ? ORDER_DECIMAL_STEP : "1"} value={item.quantity} onChange={(event) => updateItem(index, { quantity: event.target.value })} placeholder={t('common.quantity', { defaultValue: 'Quantity' })} />
                                                        {product?.unit && <span className="text-xs text-muted-foreground shrink-0">{t(`products.units.${product.unit}`, product.unit)}</span>}
                                                    </div>
                                                </div>
                                                {canUseFreeBonus ? (
                                                    <div className="space-y-2">
                                                        <Label>{t('orders.form.freeBonus', { defaultValue: 'Free Bonus' })}</Label>
                                                        <div className="flex items-center gap-1">
                                                            <Input
                                                                type="number"
                                                                min="0"
                                                                step={isDynamicUnit(product?.unit) ? ORDER_DECIMAL_STEP : '1'}
                                                                value={item.freeBonusQuantity}
                                                                onChange={(event) => updateItem(index, { freeBonusQuantity: event.target.value })}
                                                                placeholder={t('orders.form.freeBonus', { defaultValue: 'Free Bonus' })}
                                                            />
                                                            {freeBonusDisplayUnit && <span className="text-xs text-muted-foreground shrink-0">{t(`products.units.${freeBonusDisplayUnit}`, freeBonusDisplayUnit)}</span>}
                                                        </div>
                                                        {isAccessKeyHeld ? (
                                                            <FreeBonusUnitSelect
                                                                value={item.freeBonusUnit}
                                                                productUnit={product?.unit}
                                                                units={unitOptions}
                                                                onValueChange={(value) => updateItem(index, { freeBonusUnit: value })}
                                                            />
                                                        ) : null}
                                                    </div>
                                                ) : null}
                                                <div className="space-y-2" data-tour-id={index === 0 ? 'tutorial-order-unit-price' : undefined}>
                                                    <Label>{t('common.sellingPrice', { defaultValue: 'Selling Price' })}</Label>
                                                    <Input value={formatNumericInput(item.unitPrice)} onChange={(event) => updateItem(index, { unitPrice: sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 }) })} placeholder={t('common.sellingPrice', { defaultValue: 'Selling Price' })} />
                                                    {!hideCosts && isSellingAtLoss ? (
                                                        <div role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
                                                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                                            <span>
                                                                {t('orders.form.sellingBelowCost', { defaultValue: 'Selling below cost' })}
                                                                <br />
                                                                {t('orders.form.costPrice', { defaultValue: 'Cost Price' })}: {formatCurrency(costPrice, currency, features.iqd_display_preference)}
                                                            </span>
                                                        </div>
                                                    ) : null}
                                                </div>
                                                <div className="flex items-start justify-end gap-1" data-tour-id={index === 0 ? 'tutorial-order-line-actions' : undefined}>
                                                    <OrderLineItemNoteDialog
                                                        note={item.note}
                                                        onSave={(note) => updateItem(index, { note })}
                                                        labels={{
                                                            trigger: t('orders.form.lineItemNote', { defaultValue: 'Line item note' }),
                                                            title: t('orders.form.lineItemNote', { defaultValue: 'Line item note' }),
                                                            description: t('orders.form.lineItemNoteDescription', { defaultValue: 'Add a note that will be saved with this line item.' }),
                                                            field: t('common.note', { defaultValue: 'Note' }),
                                                            save: t('common.save', { defaultValue: 'Save' }),
                                                            cancel: t('common.cancel', { defaultValue: 'Cancel' })
                                                        }}
                                                    />
                                                    <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index))}>
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                                <div className={cn('flex items-center justify-between text-xs text-muted-foreground', canUseFreeBonus ? 'md:col-span-6' : 'md:col-span-5')}>
                                                    <span>{product?.sku ? `SKU: ${product.sku}` : '\u00A0'}</span>
                                                    <span>
                                                        {canUseFreeBonus && freeBonusQuantity > 0
                                                            ? `${t('orders.form.inventoryQuantity', { defaultValue: 'Inventory Qty' })}: ${inventoryQuantity} - `
                                                            : ''}
                                                        {(t('orders.form.table.total', { defaultValue: 'Total' }))}: {formatCurrency(lineTotal, currency, features.iqd_display_preference)}
                                                    </span>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </CardContent>
                            </Card>
                        </PartnerRequiredSection>

                        <PartnerRequiredSection
                            locked={isCustomerSelectionRequired}
                            unlockLabel={t('orders.form.selectBusinessPartnerToUnlock', { defaultValue: 'Select a business partner to unlock this section.' })}
                            onLockedInteraction={highlightCustomerInformation}
                        >
                            <Card
                                data-tour-id="tutorial-order-notes"
                                className={cn(
                                    'transition-[border-color,background-color] duration-200',
                                    isCustomerSelectionRequired && 'border-destructive/70 bg-destructive/5'
                                )}
                            >
                                <CardHeader>
                                    <CardTitle>{t('orders.form.notes', { defaultValue: 'Notes' })}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <Textarea
                                        rows={4}
                                        value={notes}
                                        onChange={(event) => setNotes(event.target.value)}
                                        placeholder={t('orders.form.notesPlaceholder', { defaultValue: 'Order notes, special instructions...' })}
                                    />
                                </CardContent>
                            </Card>
                        </PartnerRequiredSection>
                    </div>

                    <div className="space-y-5">
                        <PartnerRequiredSection
                            locked={isCustomerSelectionRequired}
                            unlockLabel={t('orders.form.selectBusinessPartnerToUnlock', { defaultValue: 'Select a business partner to unlock this section.' })}
                            onLockedInteraction={highlightCustomerInformation}
                        >
                            <Card className={cn(
                                'transition-[border-color,background-color] duration-200',
                                isCustomerSelectionRequired && 'border-destructive/70 bg-destructive/5'
                            )}>
                                <CardHeader>
                                    <CardTitle>{t('orders.form.orderDetails', { defaultValue: 'Order Details' })}</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div className="space-y-2" data-tour-id="tutorial-order-date">
                                            <Label htmlFor="sales-delivery" className="flex items-center gap-2">
                                                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                                {t('orders.form.expectedDelivery', { defaultValue: 'Expected Delivery' })}
                                            </Label>
                                            <DateTimePicker
                                                id="sales-delivery"
                                                mode="date-time"
                                                date={parseLocalDateTimeValue(expectedDeliveryDate)}
                                                setDate={(value) => setExpectedDeliveryDate(value ? formatLocalDateTimeValue(value) : '')}
                                                placeholder={t('orders.form.expectedDelivery', { defaultValue: 'Expected Delivery' })}
                                            />
                                        </div>
                                        {canEditOrderCreation ? (
                                            <div className="space-y-2">
                                                <Label htmlFor="sales-order-creation" className="flex items-center gap-2">
                                                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                                    {t('orders.form.orderCreation', { defaultValue: 'Order Creation' })}
                                                </Label>
                                                <DateTimePicker
                                                    id="sales-order-creation"
                                                    mode="date-time"
                                                    date={parseLocalDateTimeValue(orderCreationDate)}
                                                    open={isOrderCreationPickerOpen}
                                                    onOpenChange={setIsOrderCreationPickerOpen}
                                                    setDate={(value) => {
                                                        if (value) setOrderCreationDate(value.toISOString())
                                                    }}
                                                    placeholder={t('orders.form.orderCreation', { defaultValue: 'Order Creation' })}
                                                />
                                            </div>
                                        ) : null}
                                        <div className="space-y-2" data-tour-id="tutorial-order-currency">
                                            <CurrencySelector
                                                value={currency}
                                                onChange={changeOrderCurrency}
                                                label={t('orders.form.currency', { defaultValue: 'Currency' })}
                                                iqdDisplayPreference={features.iqd_display_preference}
                                                allowedCurrencies={Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as CurrencyCode[]}
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-2" data-tour-id="tutorial-order-payment">
                                        <Label htmlFor="sales-payment" className="flex items-center gap-2">
                                            <CreditCard className="h-4 w-4 text-muted-foreground" />
                                            {t('pos.paymentMethod', { defaultValue: 'Payment Method' })}
                                        </Label>
                                        <PaymentMethodSelect
                                            id="sales-payment"
                                            value={paymentMethod as PaymentMethodOption}
                                            onValueChange={(value) => {
                                                setPaymentMethod(value)
                                                if (value === 'loan' || value === 'installments') setIsPaid(false)
                                            }}
                                            onLinkedPaymentAccountSelect={(account) => {
                                                setInitialPaymentAccountId(account.id)
                                                setInitialPaymentAccountNameSnapshot(account.name)
                                            }}
                                            workspaceId={workspaceId}
                                            methods={[
                                                ...STANDARD_PAYMENT_METHODS,
                                                ...(hasFeature('loans') ? [ORDER_FINANCING_PAYMENT_METHODS[0]] : []),
                                                ...(hasFeature('installments') ? [ORDER_FINANCING_PAYMENT_METHODS[1]] : [])
                                            ]}
                                            onOptionPointerDown={(event, method) => {
                                                if (!(event.shiftKey || isAccessKeyHeld) || isMobile()) return
                                                if (prioritizedMethod === method) {
                                                    setPrioritizedPaymentMethod(null)
                                                    setPrioritizedMethod(null)
                                                    setPaymentMethod('cash')
                                                    return
                                                }
                                                setPrioritizedPaymentMethod(method)
                                                setPrioritizedMethod(method)
                                            }}
                                            renderOptionEnd={(method) => prioritizedMethod === method
                                                ? <Star className="ml-2 inline h-3 w-3 fill-yellow-400" />
                                                : null}
                                        />
                                        {(isPaid || (isFinanced && initialPayment > 0)) ? (
                                            <PaymentAccountSelector
                                                workspaceId={workspaceId}
                                                value={initialPaymentAccountId}
                                                onValueChange={(account) => {
                                                    setInitialPaymentAccountId(account?.id ?? null)
                                                    setInitialPaymentAccountNameSnapshot(account?.name ?? null)
                                                }}
                                                cashDrawerOnly={paymentMethod === 'cash'}
                                            />
                                        ) : null}
                                    </div>
                                    {!isFinanced ? <div className="flex items-center justify-between rounded-2xl border bg-muted/20 px-4 py-3" data-tour-id="tutorial-order-paid">
                                        <div>
                                            <div className="text-sm font-medium">{t('orders.form.paidOnSave', { defaultValue: 'Paid on save' })}</div>
                                            <div className="text-xs text-muted-foreground">{t('orders.form.paidOnSaveDescription', { defaultValue: 'Mark the order as already settled.' })}</div>
                                        </div>
                                        <Switch
                                            checked={isPaid}
                                            onCheckedChange={setIsPaid}
                                        />
                                    </div> : null}
                                    {isFinanced ? (
                                        <div className="grid gap-4 rounded-2xl border p-4 sm:grid-cols-2">
                                            {isInstallmentBased ? <><div className="space-y-2">
                                                <Label htmlFor="sales-installment-count">{t('orders.form.installmentCount')}</Label>
                                                <Input
                                                    id="sales-installment-count"
                                                    type="number"
                                                    min="1"
                                                    max="120"
                                                    value={installmentCount}
                                                    onChange={(event) => setInstallmentCount(event.target.value)}
                                                />
                                            </div>
                                                <div className="space-y-2">
                                                    <Label>{t('orders.form.installmentFrequency')}</Label>
                                                    <Select value={installmentFrequency} onValueChange={(value) => setInstallmentFrequency(value as InstallmentFrequency)}>
                                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="weekly">{t('orders.form.weekly')}</SelectItem>
                                                            <SelectItem value="biweekly">{t('orders.form.biweekly')}</SelectItem>
                                                            <SelectItem value="monthly">{t('orders.form.monthly')}</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div></> : null}
                                            <div className="min-w-0 space-y-2">
                                                <Label className="block break-words" htmlFor="sales-initial-payment">{isInstallmentBased
                                                    ? t('orders.form.initialPayment')
                                                    : t('orders.form.initialLoanRepayment')}</Label>
                                                <Input
                                                    id="sales-initial-payment"
                                                    inputMode="decimal"
                                                    placeholder="0"
                                                    value={formatNumericInput(initialPaymentAmount)}
                                                    onChange={(event) => setInitialPaymentAmount(sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 }))}
                                                />
                                            </div>
                                            <div className="min-w-0 space-y-2">
                                                <Label className="block break-words" htmlFor="sales-first-due">{isInstallmentBased
                                                    ? t('orders.form.firstDueDate')
                                                    : t('orders.form.dueDate')}</Label>
                                                <DateTimePicker
                                                    id="sales-first-due"
                                                    mode="date"
                                                    date={parseLocalDateValue(firstDueDate)}
                                                    setDate={(value) => setFirstDueDate(formatLocalDateValue(value))}
                                                    placeholder={isInstallmentBased
                                                        ? t('orders.form.firstDueDate')
                                                        : t('orders.form.dueDatePlaceholder')}
                                                />
                                            </div>
                                            <div className="flex items-center justify-between text-sm sm:col-span-2">
                                                <span className="text-muted-foreground">{isInstallmentBased
                                                    ? t('orders.form.financedBalance')
                                                    : t('orders.form.remainingLoanBalance')}</span>
                                                <span className="font-semibold">
                                                    {formatCurrency(Math.max(preview - initialPayment, 0), currency, features.iqd_display_preference)}
                                                </span>
                                            </div>
                                        </div>
                                    ) : null}
                                </CardContent>
                            </Card>
                        </PartnerRequiredSection>

                        <PartnerRequiredSection
                            locked={isCustomerSelectionRequired}
                            unlockLabel={t('orders.form.selectBusinessPartnerToUnlock', { defaultValue: 'Select a business partner to unlock this section.' })}
                            onLockedInteraction={highlightCustomerInformation}
                        >
                            <Card
                                data-tour-id="tutorial-order-commercials"
                                className={cn(
                                    'transition-[border-color,background-color] duration-200',
                                    isCustomerSelectionRequired && 'border-destructive/70 bg-destructive/5'
                                )}
                            >
                                <CardHeader className="flex-row items-center justify-between space-y-0">
                                    <CardTitle>{t('orders.form.commercials', { defaultValue: 'Commercials' })}</CardTitle>
                                    <div className="relative">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="icon"
                                            className="h-10 w-10"
                                            onClick={() => setIsOrderAdjustmentsOpen(true)}
                                            aria-label={t('orders.adjustments.title', { defaultValue: 'Order Adjustments' })}
                                        >
                                            <NotebookPen className="h-4.5 w-4.5" />
                                        </Button>
                                        {orderAdjustments.length > 0 ? (
                                            <Badge className="absolute -right-2 -top-2 h-5 min-w-5 justify-center px-1 text-[10px]">
                                                {orderAdjustments.length}
                                            </Badge>
                                        ) : null}
                                    </div>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label htmlFor="sales-discount">- {t('orders.form.discount', { defaultValue: 'Discount' })}</Label>
                                            <Input id="sales-discount" value={formatNumericInput(discount)} onChange={(event) => setDiscount(sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 }))} />
                                        </div>
                                        <div className="space-y-2">
                                            <Label htmlFor="sales-tax">+ {t('orders.form.tax', { defaultValue: 'Tax' })}</Label>
                                            <Input id="sales-tax" value={formatNumericInput(tax)} onChange={(event) => setTax(sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 }))} />
                                        </div>
                                    </div>
                                    <div className="rounded-2xl border bg-muted/30 p-4">
                                        <div className="flex items-center justify-between text-sm">
                                            <span>{t('orders.form.itemsConfigured', { defaultValue: 'Items configured' })}</span>
                                            <span className="font-semibold">{configuredItemsCount}</span>
                                        </div>
                                        <div className="mt-2 flex items-center justify-between text-sm">
                                            <span>{t('pos.paymentMethod', { defaultValue: 'Payment Method' })}</span>
                                            <span className="font-medium capitalize">{paymentMethod}</span>
                                        </div>
                                        <div className="mt-2 flex items-center justify-between text-sm">
                                            <span>{t('common.total', { defaultValue: 'Total' })}</span>
                                            <span className="text-xl font-black">{formatCurrency(preview, currency, features.iqd_display_preference)}</span>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        </PartnerRequiredSection>
                        {salesAgentCommissionsEnabled && productCommissionAgentIds.length > 0 ? (
                            <ProductCommissionPreview
                                workspaceId={workspaceId}
                                items={productCommissionPreviewItems}
                                agentIds={productCommissionAgentIds}
                                agents={productCommissionPreviewAgents}
                                currency={currency}
                                exchangeRates={adjustmentExchangeRates}
                                iqdPreference={features.iqd_display_preference}
                            />
                        ) : null}
                        <Card className="border-border/60 shadow-sm">
                            <CardHeader className="space-y-1">
                                <CardTitle className="text-xl">{t('common.actions') || 'Actions'}</CardTitle>
                                <p className="text-sm text-muted-foreground">
                                    {t('orders.form.saveHint', { defaultValue: 'Review the order details, then save or cancel.' })}
                                </p>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                <Button type="submit" className="h-12 w-full rounded-xl font-black" disabled={!canSubmit || isSaving} data-tour-id="tutorial-order-save">
                                    {isSaving
                                        ? (t('common.loading') || 'Loading...')
                                        : requiresApprovalRequest
                                            ? (editingOrderId
                                                ? t('orders.form.sendUpdateRequest', { defaultValue: 'Send Update Request' })
                                                : t('orders.form.sendRequest', { defaultValue: 'Send Request' }))
                                            : (editingOrderId ? (t('common.save') || 'Save') : (t('orders.form.saveOrder', { defaultValue: 'Save Order' })))}
                                </Button>
                                <Button type="button" variant="outline" className="h-12 w-full rounded-xl" onClick={onCancel} disabled={isSaving}>
                                    {t('common.cancel') || 'Cancel'}
                                </Button>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </form>
            <OrderAdjustmentsDialog
                open={isOrderAdjustmentsOpen}
                onOpenChange={setIsOrderAdjustmentsOpen}
                adjustments={orderAdjustments}
                onAdjustmentsChange={setOrderAdjustments}
                orderCurrency={currency}
                exchangeRates={adjustmentExchangeRates}
                availableCurrencies={Array.from(new Set([features.default_currency, ...features.allowed_currencies])) as CurrencyCode[]}
                iqdDisplayPreference={features.iqd_display_preference}
            />
            <Dialog open={isLossWarningOpen} onOpenChange={setIsLossWarningOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-destructive">
                            <AlertTriangle className="h-5 w-5" />
                            {t('orders.form.lossWarningTitle', { defaultValue: 'Items selling below cost' })}
                        </DialogTitle>
                        <DialogDescription>
                            {t('orders.form.lossWarningDescription', {
                                count: lossMakingItems.length,
                                defaultValue: 'This order has {{count}} item(s) selling below cost. Do you want to continue?'
                            })}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border border-destructive/20 bg-destructive/5 p-3">
                        {lossMakingItems.map((item) => (
                            <div key={`${item.index}-${item.productName}`} className="flex items-center justify-between gap-3 text-sm">
                                <span className="min-w-0 truncate font-medium">{item.productName}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {t('common.sellingPrice', { defaultValue: 'Selling Price' })}: {formatCurrency(item.sellingPrice, currency, features.iqd_display_preference)}
                                    <br />
                                    {t('orders.form.costPrice', { defaultValue: 'Cost Price' })}: {formatCurrency(item.costPrice, currency, features.iqd_display_preference)}
                                </span>
                            </div>
                        ))}
                    </div>
                    <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <Button type="button" variant="outline" onClick={() => setIsLossWarningOpen(false)}>
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            onClick={() => {
                                setIsLossWarningOpen(false)
                                void submitOrder(true)
                            }}
                            disabled={isSaving}
                        >
                            {t('common.continue', { defaultValue: 'Continue' })}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <ProductsViewModal
                open={productsViewItemIndex !== null}
                onOpenChange={(open) => {
                    if (!open) setProductsViewItemIndex(null)
                }}
                products={products}
                storages={storageOptionsForModal}
                initialStorageId={productsViewItemIndex === null
                    ? ''
                    : (items[productsViewItemIndex]?.storageId || sourceStorageId)}
                filterProducts={(_, storageId) => getSalesProductOptions(
                    storageId,
                    productsViewItemIndex === null ? '' : (items[productsViewItemIndex]?.productId || '')
                )}
                getStorageLabel={(storage) => storage.isSystem
                    ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name)
                    : storage.name}
                getProductMeta={(product, storageId) => isService(product)
                    ? null
                    : t('orders.form.availableQuantity', {
                        quantity: getAvailableQuantity(product.id, storageId),
                        defaultValue: `Available: ${getAvailableQuantity(product.id, storageId)}`
                    })}
                getProductStockOption={(product, storageId) => {
                    const quantity = getRegularStockQuantity(product.id, storageId)
                    if (quantity <= 0) return null

                    return {
                        label: t('orders.form.productStock', { defaultValue: 'Product stock' }),
                        description: `${quantity} ${t('orders.form.available', { defaultValue: 'available' })}`
                    }
                }}
                getBatchOptions={(product, storageId) => getBatchesForPosition(product.id, storageId).map((batch) => ({
                    id: batch.id,
                    label: `${t('orders.form.batch', { defaultValue: 'Batch' })} ${batch.batchNumber}`,
                    description: `${batch.quantity} ${t('orders.form.available', { defaultValue: 'available' })}${batch.expiryDate ? ` · ${batch.expiryDate}` : ''}`
                }))}
                labels={{
                    title: t('products.title', { defaultValue: 'Products' }),
                    description: t('orders.form.selectProduct', { defaultValue: 'Select a product for this line item.' }),
                    searchLabel: t('common.search', { defaultValue: 'Search' }),
                    searchPlaceholder: t('products.searchPlaceholder', { defaultValue: 'Search products...' }),
                    storageLabel: t('orders.form.selectStorage', { defaultValue: 'Select Storage' }),
                    storagePlaceholder: t('orders.form.selectStorage', { defaultValue: 'Select Storage' }),
                    noProductsLabel: t('inventoryTransfer.noProducts', { defaultValue: 'No products in this storage.' }),
                    noResultsLabel: t('inventoryTransfer.noMatchingProducts', { defaultValue: 'No products match your search.' }),
                    selectSourceLabel: t('orders.form.stockSource', { defaultValue: 'Select stock source' })
                }}
                onSelectProduct={(product, storageId, batchId) => {
                    if (productsViewItemIndex === null) return
                    if (!isService(product) && !hasValidProductCost(product.costPrice)) {
                        toast({
                            title: t('common.error') || 'Error',
                            description: getMissingProductCostMessage(product.name),
                            variant: 'destructive'
                        })
                        return
                    }
                    if (hasMissingPartnerPriceBookCost(selectedCustomer, product.id)) {
                        toast({
                            title: t('common.error') || 'Error',
                            description: getMissingPriceBookCostMessage(product.name, getPartnerPriceBookName(selectedCustomer)),
                            variant: 'destructive'
                        })
                        return
                    }
                    setHighlightedStorageIndex(null)
                    updateItem(productsViewItemIndex, {
                        productId: product.id,
                        productSearch: product.name,
                        storageId: isService(product) ? SERVICES_VIRTUAL_STORAGE_ID : storageId,
                        batchId: isService(product) ? '' : batchId
                    })
                    setProductsViewItemIndex(null)
                }}
            />
        </div>
    )
}
