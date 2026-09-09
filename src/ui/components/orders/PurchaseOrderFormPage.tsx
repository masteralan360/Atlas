import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, CalendarDays, CreditCard, NotebookPen, PackagePlus, Plus, ShoppingCart, Star, Trash2, Users, Warehouse, X } from 'lucide-react'

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
    generateId,
    parseLocalDateTimeValue,
    parseLocalDateValue,
    sanitizeNumericInput
} from '@/lib/utils'
import { getOrderLineFreeBonusQuantity } from '@/lib/orderLineItems'
import { ORDER_DECIMAL_STEP, roundOrderValue } from '@/lib/orderPrecision'
import { canBePurchased } from '@/lib/catalogItem'
import {
    createPurchaseOrder,
    findPartnerProductPriceBookItem,
    getPrimaryStorageFromList,
    shouldCreatePurchaseCostBatch,
    updatePurchaseOrder,
    useBusinessPartners,
    usePriceBookCatalogState,
    useProducts,
    useWorkspaceProductBarcodes,
    usePurchaseOrder,
    useStorages,
    type BusinessPartner,
    type CurrencyCode,
    type InstallmentFrequency,
    type OrderAdjustment,
    type PurchaseOrder,
    type PurchaseOrderItem,
    type PurchaseOrderStatus
} from '@/local-db'
import { useWorkspace } from '@/workspace'
import { useWorkspacePermissions } from '@/permissions'
import {
    Button,
    Badge,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CurrencySelector,
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
    useToast
} from '@/ui/components'
import { PartnerAutocompleteInput } from '@/ui/components/crm/PartnerAutocompleteInput'
import { PartnerBalanceSummary } from '@/ui/components/crm/PartnerBalanceSummary'
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

interface PurchaseOrderFormPageProps {
    workspaceId: string
    onCancel: () => void
    onCreated?: (orderId: string) => void
    editingOrderId?: string
}

type FormItem = {
    id: string
    seq: number
    productId: string
    productSearch: string
    storageId: string
    quantity: string
    freeBonusQuantity: string
    freeBonusUnit: string
    unitPrice: string
    batchNumber: string
    batchSalePrice: string
    batchExpiryDate: string
    batchManufacturingDate: string
    priceBookId: string
    priceBookItemId: string
    priceSourceCurrency: CurrencyCode | ''
    note: string
}

function createEmptyItem(storageId = '', seq = 1): FormItem {
    return {
        id: generateId(),
        seq,
        productId: '',
        productSearch: '',
        storageId,
        quantity: '1',
        freeBonusQuantity: '0',
        freeBonusUnit: '',
        unitPrice: '',
        batchNumber: '',
        batchSalePrice: '',
        batchExpiryDate: '',
        batchManufacturingDate: '',
        priceBookId: '',
        priceBookItemId: '',
        priceSourceCurrency: '',
        note: ''
    }
}

function roundFormAmount(value: number) {
    return roundOrderValue(value)
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

export function PurchaseOrderFormPage({
    workspaceId,
    onCancel,
    onCreated,
    editingOrderId
}: PurchaseOrderFormPageProps) {
    const { t } = useTranslation()
    const { toast } = useToast()
    const { user } = useAuth()
    const { features, hasCapability, hasFeature } = useWorkspace()
    const { permissionKeys } = useWorkspacePermissions()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const demoTutorial = useDemoTutorial()

    const products = useProducts(workspaceId)
    const purchasableProducts = useMemo(() => products.filter(canBePurchased), [products])
    const productBarcodes = useWorkspaceProductBarcodes(workspaceId, { syncProductCache: false })
    const storages = useStorages(workspaceId)
    const { isDynamicUnit, options: unitOptions } = useUnitRegistry(workspaceId)
    const supplierPartners = useBusinessPartners(workspaceId, { roles: ['supplier'] })
    const editingOrder = usePurchaseOrder(editingOrderId)
    const defaultStorageId = getPrimaryStorageFromList(storages)?.id || ''
    const priceBooksEnabled = hasCapability('priceBooks')
    const {
        priceBooks,
        priceBookItems,
        isReady: isPriceBookCatalogReady,
        error: priceBookCatalogError
    } = usePriceBookCatalogState(priceBooksEnabled ? workspaceId : undefined, { enabled: priceBooksEnabled })
    const { isAccessKeyHeld } = useUiAccess()
    const formOpenedAtRef = useRef(new Date().toISOString())
    const [isOrderCreationPickerOpen, setIsOrderCreationPickerOpen] = useState(false)
    const canEditOrderCreation = user?.role === 'admin' && (isAccessKeyHeld || isOrderCreationPickerOpen)
    const [prioritizedMethod, setPrioritizedMethod] = useState<string | null>(getPrioritizedPaymentMethod)

    const [isSaving, setIsSaving] = useState(false)
    const [productsViewItemIndex, setProductsViewItemIndex] = useState<number | null>(null)
    const [supplierId, setSupplierId] = useState(editingOrder?.businessPartnerId || editingOrder?.supplierId || '')
    const [supplierSearch, setSupplierSearch] = useState(editingOrder?.supplierName || '')
    const [isSupplierPickerOpen, setIsSupplierPickerOpen] = useState(false)
    const [destinationStorageId, setDestinationStorageId] = useState(editingOrder?.destinationStorageId || defaultStorageId)
    const [currency, setCurrency] = useState<CurrencyCode>(editingOrder?.currency || features.default_currency)
    const [orderAdjustments, setOrderAdjustments] = useState<OrderAdjustment[]>(() =>
        normalizeOrderAdjustments(editingOrder?.orderAdjustments, editingOrder?.currency || features.default_currency)
    )
    const [isOrderAdjustmentsOpen, setIsOrderAdjustmentsOpen] = useState(false)
    const [expectedDeliveryDate, setExpectedDeliveryDate] = useState(editingOrder?.expectedDeliveryDate ? formatLocalDateTimeValue(editingOrder.expectedDeliveryDate) : '')
    const [orderCreationDate, setOrderCreationDate] = useState(editingOrder?.createdAt || formOpenedAtRef.current)
    const [discount, setDiscount] = useState(editingOrder?.discount ? String(editingOrder.discount) : '')
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
                    id: item.id || generateId(),
                    seq: idx + 1,
                    productId: item.productId,
                    productSearch: product?.name || '',
                    storageId: item.storageId || editingOrder.destinationStorageId || defaultStorageId,
                    quantity: String(item.quantity),
                    freeBonusQuantity: String(getOrderLineFreeBonusQuantity(item)),
                    freeBonusUnit: item.freeBonusUnit || '',
                    unitPrice: String(item.convertedUnitPrice),
                    batchNumber: item.batchNumber || '',
                    batchSalePrice: item.batchSalePrice == null ? '' : String(item.batchSalePrice),
                    batchExpiryDate: item.batchExpiryDate || '',
                    batchManufacturingDate: item.batchManufacturingDate || '',
                    priceBookId: item.priceBookId || '',
                    priceBookItemId: item.priceBookItemId || '',
                    priceSourceCurrency: item.priceBookId && item.priceBookItemId ? item.originalCurrency : '',
                    note: item.note || ''
                }
            })
        }
        return [createEmptyItem(defaultStorageId)]
    })
    const requiresApprovalRequest = user?.role === 'staff' && permissionKeys.includes('orders.requirePurchaseOrderRequest')
    const canUseFreeBonus = hasCapability('orderFreeBonus')
    const [highlightedStorageIndex, setHighlightedStorageIndex] = useState<number | null>(null)
    const [highlightedNewSeq, setHighlightedNewSeq] = useState<number | null>(null)
    const [isSupplierInformationHighlighted, setIsSupplierInformationHighlighted] = useState(false)
    const supplierInformationRef = useRef<HTMLDivElement>(null)
    const supplierHighlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => {
        if (highlightedNewSeq == null) return
        const timeout = setTimeout(() => setHighlightedNewSeq(null), 1600)
        return () => clearTimeout(timeout)
    }, [highlightedNewSeq])

    useEffect(() => () => {
        if (supplierHighlightTimeoutRef.current) clearTimeout(supplierHighlightTimeoutRef.current)
    }, [])


    useEffect(() => {
        if (!editingOrder) return
        setSupplierId(editingOrder.businessPartnerId || editingOrder.supplierId)
        setSupplierSearch(editingOrder.supplierName)
        setDestinationStorageId(editingOrder.destinationStorageId || defaultStorageId)
        setCurrency(editingOrder.currency)
        setOrderAdjustments(normalizeOrderAdjustments(editingOrder.orderAdjustments, editingOrder.currency))
        setExpectedDeliveryDate(editingOrder.expectedDeliveryDate ? formatLocalDateTimeValue(editingOrder.expectedDeliveryDate) : '')
        setOrderCreationDate(editingOrder.createdAt || formOpenedAtRef.current)
        setDiscount(editingOrder.discount ? String(editingOrder.discount) : '')
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
                id: item.id || generateId(),
                seq: idx + 1,
                productId: item.productId,
                productSearch: product?.name || '',
                storageId: item.storageId || editingOrder.destinationStorageId || defaultStorageId,
                quantity: String(item.quantity),
                freeBonusQuantity: String(getOrderLineFreeBonusQuantity(item)),
                freeBonusUnit: item.freeBonusUnit || '',
                unitPrice: String(item.convertedUnitPrice),
                batchNumber: item.batchNumber || '',
                batchSalePrice: item.batchSalePrice == null ? '' : String(item.batchSalePrice),
                batchExpiryDate: item.batchExpiryDate || '',
                batchManufacturingDate: item.batchManufacturingDate || '',
                priceBookId: item.priceBookId || '',
                priceBookItemId: item.priceBookItemId || '',
                priceSourceCurrency: item.priceBookId && item.priceBookItemId ? item.originalCurrency : '',
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

    const selectedSupplier = supplierPartners.find((entry) => entry.id === supplierId)
    const isSupplierSelectionRequired = !editingOrderId && !selectedSupplier

    const getPriceBookItemForPartner = useCallback((partner: Pick<BusinessPartner, 'priceBookId'> | null | undefined, productId: string) =>
        findPartnerProductPriceBookItem(
            priceBooksEnabled,
            partner,
            productId,
            priceBooks,
            priceBookItems
        ),
    [priceBookItems, priceBooks, priceBooksEnabled])

    const getStorageDisplayName = (storageId: string) => {
        const storage = storages.find((entry) => entry.id === storageId)
        if (!storage) return t('orders.form.selectStorage', { defaultValue: 'Select Storage' })
        return storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name
    }

    const resolveItemPricing = useCallback((
        productId: string,
        partnerCurrency: CurrencyCode,
        partner: Pick<BusinessPartner, 'priceBookId'> | null | undefined
    ): Pick<FormItem, 'unitPrice' | 'batchSalePrice' | 'priceBookId' | 'priceBookItemId' | 'priceSourceCurrency'> => {
        const product = products.find((entry) => entry.id === productId)
        if (!product) {
            return {
                unitPrice: '',
                batchSalePrice: '',
                priceBookId: '',
                priceBookItemId: '',
                priceSourceCurrency: ''
            }
        }

        const priceBookItem = getPriceBookItemForPartner(partner, productId)
        if (priceBookItem) {
            return {
                unitPrice: String(convertCurrencyAmountWithLiveRates(
                    priceBookItem.costPrice ?? product.costPrice ?? 0,
                    priceBookItem.currency,
                    partnerCurrency,
                    liveRates
                )),
                batchSalePrice: String(convertCurrencyAmountWithLiveRates(
                    priceBookItem.price,
                    priceBookItem.currency,
                    product.currency,
                    liveRates
                )),
                priceBookId: priceBookItem.priceBookId,
                priceBookItemId: priceBookItem.id,
                priceSourceCurrency: priceBookItem.currency
            }
        }

        return {
            unitPrice: String(convertCurrencyAmountWithLiveRates(product.costPrice ?? 0, product.currency, partnerCurrency, liveRates)),
            batchSalePrice: String(product.price),
            priceBookId: '',
            priceBookItemId: '',
            priceSourceCurrency: ''
        }
    }, [getPriceBookItemForPartner, liveRates, products])

    const selectSupplierPartner = useCallback((partner: Pick<BusinessPartner, 'id' | 'partnerName' | 'defaultCurrency' | 'priceBookId'>) => {
        const nextCurrency = partner.defaultCurrency || currency
        setSupplierSearch(partner.partnerName)
        setSupplierId(partner.id)
        changeOrderCurrency(nextCurrency)
        if (priceBooksEnabled) {
            setItems((current) => current.map((item) => item.productId
                ? { ...item, ...resolveItemPricing(item.productId, nextCurrency, partner) }
                : item
            ))
        }
    }, [changeOrderCurrency, currency, priceBooksEnabled, resolveItemPricing])

    const handleStorageMissing = useCallback((index: number) => {
        setHighlightedStorageIndex(index)
        setTimeout(() => setHighlightedStorageIndex((prev) => prev === index ? null : prev), 3000)
        const el = document.getElementById(`purchase-storage-${index}`)
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, [])

    const highlightSupplierInformation = useCallback(() => {
        if (!isSupplierSelectionRequired) return

        setIsSupplierInformationHighlighted(true)
        if (supplierHighlightTimeoutRef.current) clearTimeout(supplierHighlightTimeoutRef.current)
        supplierHighlightTimeoutRef.current = setTimeout(() => {
            setIsSupplierInformationHighlighted(false)
            supplierHighlightTimeoutRef.current = null
        }, 1800)

        const supplierInformation = supplierInformationRef.current
        supplierInformation?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
        setTimeout(() => {
            supplierInformation?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true })
        }, 250)
    }, [isSupplierSelectionRequired])

    const updateItem = (index: number, changes: Partial<FormItem>) => {
        setItems((current) =>
            current.map((item, itemIndex) => {
                if (itemIndex !== index) return item
                if (priceBooksEnabled && changes.productId && !selectedSupplier) return item
                const next = { ...item, ...changes }
                if (changes.productId && (!item.unitPrice || changes.productId !== item.productId)) {
                    Object.assign(next, resolveItemPricing(changes.productId, currency, selectedSupplier))
                } else if (changes.productId !== undefined && !changes.productId) {
                    next.priceBookId = ''
                    next.priceBookItemId = ''
                    next.priceSourceCurrency = ''
                }
                return next
            })
        )
    }

    useOrderBarcodeScanner({
        enabled: !isSupplierSelectionRequired && !(priceBooksEnabled && (!isPriceBookCatalogReady || !selectedSupplier)),
        items,
        products,
        productBarcodes,
        onProductScanned: (product, index) => {
            if (!purchasableProducts.some((candidate) => candidate.id === product.id)) {
                toast({
                    title: t('products.notFoundTitle', { defaultValue: 'Product not found' }),
                    description: t('products.notFoundDescription', { defaultValue: 'This product could not be found. It may have been deleted or is no longer available.' }),
                    variant: 'destructive'
                })
                return
            }
            updateItem(index, { productId: product.id, productSearch: product.name })
        },
        onProductNotFound: () => toast({
            title: t('products.notFoundTitle', { defaultValue: 'Product not found' }),
            description: t('products.notFoundDescription', { defaultValue: 'This product could not be found. It may have been deleted or is no longer available.' }),
            variant: 'destructive'
        })
    })

    const preview = useMemo(() => {
        const subtotal = items.reduce((sum, item) => sum + ((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0)), 0)
        const existingCalculatedTotal = subtotal - Number(discount || 0)
        return calculateOrderTotalWithAdjustments(existingCalculatedTotal, orderAdjustments)
    }, [currency, discount, items, orderAdjustments])

    const configuredItemsCount = useMemo(
        () => items.filter((item) => item.productId && Number(item.quantity) > 0).length,
        [items]
    )

    const selectedStorageName = getStorageDisplayName(destinationStorageId)

    const initialPayment = roundFormAmount(Math.max(0, Number(initialPaymentAmount || 0)))
    const isFinanced = paymentMethod === 'loan' || paymentMethod === 'installments'
    const isInstallmentBased = paymentMethod === 'installments'
    const canSubmit = Boolean(selectedSupplier) &&
        items.some((item) => item.productId && Number(item.quantity) > 0) &&
        (!priceBooksEnabled || isPriceBookCatalogReady) &&
        (!isFinanced || initialPayment < preview) &&
        (!isInstallmentBased || (
            Number(installmentCount) >= 1
            && Boolean(firstDueDate)
        ))

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (priceBooksEnabled && !isPriceBookCatalogReady) return
        if (!user?.workspaceId || isSaving) return

        const supplier = supplierPartners.find((entry) => entry.id === supplierId)
        if (!supplier) {
            toast({
                title: t('common.error') || 'Error',
                description: t('orders.form.errors.noSuppliers', { defaultValue: 'Add suppliers before creating purchase orders.' }),
                variant: 'destructive'
            })
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
            const orderItems: PurchaseOrderItem[] = items
                .filter((item) => item.productId && Number(item.quantity) > 0)
                .map((item) => {
                    const product = products.find((entry) => entry.id === item.productId)
                    if (!product) {
                        throw new Error(t('orders.form.errors.productNotFound', { defaultValue: 'Selected product was not found.' }))
                    }
                    if (!item.storageId) {
                        throw new Error(t('orders.form.errors.targetStorageRequired', {
                            productName: product.name,
                            defaultValue: `Select a target storage for ${product.name}.`
                        }))
                    }

                    const quantity = Number(item.quantity)
                    const freeBonusQuantityValue = Number(item.freeBonusQuantity || 0)
                    const hasPriceBookProvenance = Boolean(item.priceBookId && item.priceBookItemId)
                    if (hasPriceBookProvenance) usesPriceBookPricing = true
                    const sourceCurrency = hasPriceBookProvenance && item.priceSourceCurrency
                        ? item.priceSourceCurrency
                        : product.currency
                    const unitPrice = Number(item.unitPrice || 0)
                    if (!Number.isFinite(freeBonusQuantityValue) || freeBonusQuantityValue < 0) {
                        throw new Error(t('orders.form.errors.invalidFreeBonus', {
                            productName: product.name,
                            defaultValue: `Enter a valid free bonus for ${product.name}.`
                        }))
                    }
                    const freeBonusQuantity = freeBonusQuantityValue
                    const batchSalePrice = item.batchSalePrice === '' ? null : Number(item.batchSalePrice)
                    if (batchSalePrice !== null && (!Number.isFinite(batchSalePrice) || batchSalePrice < 0)) {
                        throw new Error(t('orders.form.errors.invalidBatchSalePrice', {
                            productName: product.name,
                            defaultValue: `Enter a valid batch selling price for ${product.name}.`
                        }))
                    }
                    return {
                        id: item.id,
                        productId: product.id,
                        note: item.note.trim() || null,
                        priceBookId: hasPriceBookProvenance ? item.priceBookId : null,
                        priceBookItemId: hasPriceBookProvenance ? item.priceBookItemId : null,
                        storageId: item.storageId,
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
                        batchNumber: item.batchNumber.trim() || null,
                        batchSalePrice,
                        batchExpiryDate: item.batchExpiryDate || null,
                        batchManufacturingDate: item.batchManufacturingDate || null
                    }
                })

            if (orderItems.length === 0) {
                throw new Error(t('orders.form.errors.atLeastOneItem', { defaultValue: 'Add at least one item.' }))
            }
            const hasMultiCurrency = orderItems.some(item => item.originalCurrency !== item.settlementCurrency)
            const hasAdjustmentCurrencyConversion = orderAdjustments.some((adjustment) => adjustment.currency !== currency)
            const snapshot = hasMultiCurrency || usesPriceBookPricing || hasAdjustmentCurrencyConversion ? adjustmentExchangeRates : []
            const primaryRate = hasMultiCurrency ? getPrimaryExchangeDetails(currency, features.default_currency, snapshot) : null
            const commonStorageId = getCommonStorageId(orderItems)
            const subtotal = roundFormAmount(orderItems.reduce((sum, item) => sum + item.lineTotal, 0))
            const discountNum = roundFormAmount(Number(discount || 0))
            const existingCalculatedTotal = roundFormAmount(subtotal - discountNum)
            const total = calculateOrderTotalWithAdjustments(existingCalculatedTotal, orderAdjustments)
            const paidAmount = isFinanced ? initialPayment : isPaid ? total : 0
            const balanceAmount = roundFormAmount(Math.max(total - paidAmount, 0))
            const savedAt = new Date().toISOString()

            const payload = {
                businessPartnerId: supplier.id,
                supplierId: supplier.id,
                supplierName: supplier.partnerName,
                destinationStorageId: commonStorageId,
                items: orderItems,
                subtotal,
                discount: discountNum,
                total,
                currency,
                // Empty adjustment arrays are omitted; the data layer clears
                // persisted JSONB when an existing order loses its final row.
                orderAdjustments: orderAdjustments.length > 0 ? orderAdjustments : undefined,
                exchangeRate: primaryRate?.exchangeRate ?? null,
                exchangeRateSource: primaryRate?.exchangeRateSource ?? null,
                exchangeRateTimestamp: primaryRate?.exchangeRateTimestamp ?? null,
                exchangeRates: hasMultiCurrency ? snapshot : null,
                status: 'draft' as PurchaseOrderStatus,
                expectedDeliveryDate: expectedDeliveryDate || null,
                createdAt: parseLocalDateTimeValue(orderCreationDate)?.toISOString() || formOpenedAtRef.current,
                actualDeliveryDate: null,
                isPaid: !isFinanced && balanceAmount <= 0,
                paymentStatus: balanceAmount <= 0 ? 'paid' as const : paidAmount > 0 ? 'partial' as const : 'unpaid' as const,
                paidAmount,
                balanceAmount,
                paidAt: !isFinanced && paidAmount > 0 ? savedAt : null,
                paymentMethod: paymentMethod as PurchaseOrder['paymentMethod'],
                initialPaymentAmount: isFinanced ? initialPayment : 0,
                initialPaymentAccountId,
                initialPaymentAccountNameSnapshot,
                linkedLoanId: editingOrder?.linkedLoanId || null,
                isInstallmentBased,
                installmentCount: isInstallmentBased ? Math.max(1, Math.trunc(Number(installmentCount) || 1)) : paymentMethod === 'loan' && firstDueDate ? 1 : 0,
                installmentFrequency: isFinanced ? installmentFrequency : null,
                firstDueDate: isFinanced ? firstDueDate || null : null,
                nextDueDate: isFinanced ? firstDueDate || null : null,
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
                ? await updatePurchaseOrder(editingOrderId, payload)
                : await createPurchaseOrder(workspaceId, payload, user?.id ?? null)

            toast({
                title: requiresApprovalRequest
                    ? t('orders.form.requestSent', { defaultValue: 'Request sent' })
                    : editingOrderId ? (t('common.save') || 'Saved') : (t('common.create') || 'Created')
            })
            if (!editingOrderId) {
                demoTutorial.completeOrderCreated(savedOrder.id, 'purchase')
            }
            onCreated?.(savedOrder.id)
        } catch (error: any) {
            toast({
                title: t('common.error') || 'Error',
                description: error?.message || t('orders.form.errors.savePurchaseFailed', { defaultValue: 'Failed to save purchase order.' }),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
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
                                ? t('orders.form.editPurchaseOrder', { defaultValue: 'Edit Purchase Order' })
                                : t('orders.form.newPurchaseOrder', { defaultValue: 'New Purchase Order' })}
                        </h1>
                        <p className="text-sm text-muted-foreground">
                            {t('orders.form.purchaseDescription', { defaultValue: 'Create a purchase order, assign a supplier and products, then post stock on receipt.' })}
                        </p>
                    </div>
                </div>

                <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,2.5fr)_minmax(380px,0.8fr)]">
                            <div className="space-y-5">
                                <Card
                                    ref={supplierInformationRef}
                                    tabIndex={-1}
                                    className={cn(
                                        'transition-[border-color,box-shadow] duration-200',
                                        isSupplierInformationHighlighted && 'border-destructive ring-2 ring-destructive/70 ring-offset-2 ring-offset-background motion-safe:animate-pulse'
                                    )}
                                >
                                    <CardHeader>
                                        <CardTitle>{t('orders.form.supplierInformation', { defaultValue: 'Supplier Information' })}</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="grid gap-4">
                                            <div className="grid gap-2">
                                                <Label>{t('orders.form.supplier', { defaultValue: 'Supplier' })} <span className="text-destructive">*</span></Label>
                                                <div className="flex flex-col gap-2 md:flex-row md:items-center" data-tour-id="tutorial-order-partner-picker">
                                                    <PartnerAutocompleteInput
                                                        value={supplierSearch}
                                                        onChange={(value) => {
                                                            setSupplierSearch(value)
                                                            setSupplierId('')
                                                        }}
                                                        onSelectPartner={(partner: BusinessPartner) => {
                                                            selectSupplierPartner(partner)
                                                        }}
                                                        workspaceId={workspaceId}
                                                        roles={['supplier']}
                                                        placeholder={t('orders.form.selectSupplier', { defaultValue: 'Select Supplier' })}
                                                    />
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        className="w-full shrink-0 gap-2 md:w-auto"
                                                        onClick={() => setIsSupplierPickerOpen(true)}
                                                    >
                                                        <Users className="h-4 w-4" />
                                                        {t('orders.form.businessPartner')}
                                                    </Button>
                                                </div>
                                                {supplierId && selectedSupplier ? (
                                                    <div className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2">
                                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                                            <div className="min-w-0">
                                                                <div className="text-[11px] font-bold uppercase tracking-wide text-primary">
                                                                    {t('suppliers.title', { defaultValue: 'Supplier' })}
                                                                </div>
                                                                <div className="flex flex-wrap items-center gap-2">
                                                                    <div className="text-sm font-semibold">{selectedSupplier.partnerName}</div>
                                                                    <PartnerBalanceSummary
                                                                        compact
                                                                        partner={selectedSupplier}
                                                                        iqdPreference={features.iqd_display_preference}
                                                                    />
                                                                </div>
                                                            </div>
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-8 shrink-0 px-2 text-muted-foreground"
                                                                onClick={() => {
                                                                    setSupplierId('')
                                                                    setSupplierSearch('')
                                                                }}
                                                            >
                                                                <X className="h-4 w-4" />
                                                                {t('loans.clearParty', { defaultValue: 'Clear Link' })}
                                                            </Button>
                                                        </div>
                                                    </div>
                                                ) : null}
                                            </div>
                                            <div className="grid gap-2">
                                                <Label className="flex items-center gap-2">
                                                    <Warehouse className="h-4 w-4 text-muted-foreground" />
                                                    {t('orders.form.destinationStorage', { defaultValue: 'Target Storage' })} <span className="text-destructive">*</span>
                                                </Label>
                                                <Select value={destinationStorageId} onValueChange={setDestinationStorageId}>
                                                    <SelectTrigger><SelectValue placeholder={t('orders.form.selectStorage', { defaultValue: 'Select Storage' })} /></SelectTrigger>
                                                    <SelectContent>
                                                        {storages.map((storage) => (
                                                            <SelectItem key={storage.id} value={storage.id}>
                                                                {storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                                <p className="text-xs text-muted-foreground">
                                                    {t('orders.form.destinationStorageHint', { defaultValue: 'Stock will be added to this storage when the order is completed.' })}
                                                </p>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                                <LoanPartyPickerDialog
                                    isOpen={isSupplierPickerOpen}
                                    onOpenChange={setIsSupplierPickerOpen}
                                    workspaceId={workspaceId}
                                    roles={['supplier']}
                                    selectedPartyId={supplierId}
                                    copy={{
                                        title: t('orders.form.businessPartner'),
                                        description: t('orders.form.businessPartnerPickerDescription'),
                                        searchPlaceholder: t('orders.form.searchBusinessPartners'),
                                        noResultsMessage: t('orders.form.noBusinessPartnersFound')
                                    }}
                                    onSelect={(selection) => {
                                        if (selection.linkedPartyId) {
                                            const partner = supplierPartners.find((entry) => entry.id === selection.linkedPartyId)
                                            if (partner) {
                                                selectSupplierPartner(partner)
                                            } else {
                                                selectSupplierPartner({
                                                    id: selection.linkedPartyId,
                                                    partnerName: selection.linkedPartyName || '',
                                                    defaultCurrency: selection.defaultCurrency,
                                                    priceBookId: null
                                                })
                                            }
                                        }
                                        setIsSupplierPickerOpen(false)
                                    }}
                                />

                                <PartnerRequiredSection
                                    locked={isSupplierSelectionRequired}
                                    unlockLabel={t('orders.form.selectBusinessPartnerToUnlock', { defaultValue: 'Select a business partner to unlock this section.' })}
                                    onLockedInteraction={highlightSupplierInformation}
                                >
                                <Card className={cn(
                                    'transition-[border-color,background-color] duration-200',
                                    isSupplierSelectionRequired && 'border-destructive/70 bg-destructive/5'
                                )}>
                                    <CardHeader className="flex flex-col items-start justify-between gap-4 space-y-0 sm:flex-row">
                                        <div className="space-y-1">
                                            <CardTitle>{t('orders.form.lineItems', { defaultValue: 'Line Items' })}</CardTitle>
                                            <p className="text-sm text-muted-foreground">
                                                {t('orders.form.purchaseLineItemsDescription', { defaultValue: 'Add products with quantities and cost prices.' })}
                                            </p>
                                        </div>
                                        <Button type="button" variant="outline" size="sm" onClick={() => setItems((current) => {
                                            const nextSeq = current.reduce((max, it) => Math.max(max, it.seq), 0) + 1
                                            setHighlightedNewSeq(nextSeq)
                                            return [createEmptyItem(destinationStorageId || defaultStorageId, nextSeq), ...current]
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
                                            const freeBonusQuantity = Math.max(0, Number(item.freeBonusQuantity || 0))
                                            const inventoryQuantity = (Number(item.quantity) || 0) + (canUseFreeBonus ? freeBonusQuantity : 0)
                                            const createsBatch = product
                                                ? shouldCreatePurchaseCostBatch(
                                                    convertCurrencyAmountWithLiveRates(
                                                        Number(item.unitPrice) || 0,
                                                        currency,
                                                        product.currency,
                                                        liveRates
                                                    ),
                                                    product.costPrice ?? 0,
                                                    product.currency
                                                ) || (Boolean(item.priceBookId && item.priceBookItemId) && (
                                                    item.batchSalePrice !== ''
                                                    && shouldCreatePurchaseCostBatch(
                                                        Number(item.batchSalePrice),
                                                        product.price,
                                                        product.currency
                                                    )
                                                ))
                                                : false
                                            const canOpenProductsView = Boolean(item.storageId)
                                                && !(priceBooksEnabled && (!isPriceBookCatalogReady || !selectedSupplier))

                                            return (
                                                <div
                                                    key={item.id}
                                                    className={cn(
                                                        'relative grid gap-3 rounded-2xl border bg-background p-4 transition-all duration-700',
                                                        canUseFreeBonus
                                                            ? 'md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(80px,0.55fr)_minmax(80px,0.55fr)_minmax(108px,0.8fr)_minmax(72px,0.18fr)]'
                                                            : 'md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(80px,0.55fr)_minmax(108px,0.8fr)_minmax(72px,0.18fr)]',
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
                                                        <Label>{t('orders.form.selectProduct', { defaultValue: 'Select Product' })}</Label>
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
                                                                onSelectProduct={(product) => updateItem(index, { productId: product.id, productSearch: product.name })}
                                                                products={purchasableProducts}
                                                                disabled={priceBooksEnabled && (!isPriceBookCatalogReady || !selectedSupplier)}
                                                                placeholder={priceBooksEnabled && !selectedSupplier
                                                                    ? t('priceBooks.selectPartnerFirst', { defaultValue: 'Select a business partner first' })
                                                                    : priceBooksEnabled && priceBookCatalogError
                                                                        ? t('priceBooks.loadingErrorShort', { defaultValue: 'Price Books unavailable - retrying...' })
                                                                        : t('orders.form.selectProduct', { defaultValue: 'Select Product' })}
                                                                hasSelection={!!item.productId}
                                                                storageMissing={!item.storageId}
                                                                storageMissingLabel={t('orders.form.selectStorage', { defaultValue: 'Select Storage' })}
                                                                onStorageMissingClick={() => handleStorageMissing(index)}
                                                            />
                                                        </div>
                                                    </div>
                                                    <div id={`purchase-storage-${index}`} className={cn('space-y-2', highlightedStorageIndex === index && 'animate-pulse')} data-tour-id={index === 0 ? 'tutorial-order-storage' : undefined}>
                                                        <Label className={cn(highlightedStorageIndex === index && 'text-destructive font-bold')}>{t('orders.form.selectStorage', { defaultValue: 'Select Storage' })}</Label>
                                                        <Select value={item.storageId} onValueChange={(value) => { setHighlightedStorageIndex(null); updateItem(index, { storageId: value }) }}>
                                                            <SelectTrigger className={cn(highlightedStorageIndex === index && 'ring-2 ring-destructive')}><SelectValue placeholder={t('orders.form.selectStorage', { defaultValue: 'Select Storage' })} /></SelectTrigger>
                                                            <SelectContent>
                                                                {storages.map((storage) => (
                                                                    <SelectItem key={storage.id} value={storage.id}>
                                                                        {storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name}
                                                                    </SelectItem>
                                                                ))}
                                                            </SelectContent>
                                                        </Select>
                                                        <p className="text-xs text-muted-foreground">
                                                            {item.storageId
                                                                ? t('orders.form.receiveIntoStorageHint', {
                                                                    storageName: getStorageDisplayName(item.storageId),
                                                                    defaultValue: `Will be received into ${getStorageDisplayName(item.storageId)} when the order is completed.`
                                                                })
                                                                : t('orders.form.chooseTargetStorageForLine', { defaultValue: 'Choose a target storage for this line.' })}
                                                        </p>
                                                    </div>
                                                    <div className="space-y-2" data-tour-id={index === 0 ? 'tutorial-order-quantity' : undefined}>
                                                        <Label>{t('common.quantity', { defaultValue: 'Quantity' })}</Label>
                                                        <div className="flex items-center gap-1">
                                                            <Input type="number" min={isDynamicUnit(product?.unit) ? ORDER_DECIMAL_STEP : "1"} step={isDynamicUnit(product?.unit) ? ORDER_DECIMAL_STEP : "1"} value={item.quantity} onChange={(event) => updateItem(index, { quantity: event.target.value })} placeholder={t('common.quantity', { defaultValue: 'Quantity' })} />
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
                                                                {(item.freeBonusUnit || product?.unit) && <span className="text-xs text-muted-foreground shrink-0">{t(`products.units.${freeBonusDisplayUnit}`, freeBonusDisplayUnit)}</span>}
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
                                                        <Label>{t('common.buyingPrice', { defaultValue: 'Buying Price' })}</Label>
                                                        <Input value={formatNumericInput(item.unitPrice)} onChange={(event) => updateItem(index, { unitPrice: sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 }) })} placeholder={t('common.buyingPrice', { defaultValue: 'Buying Price' })} />
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
                                                    {createsBatch && <div className={cn('grid gap-3 border-t pt-3 md:grid-cols-4', canUseFreeBonus ? 'md:col-span-6' : 'md:col-span-5')}>
                                                        <div className="space-y-2">
                                                            <Label>{t('orders.form.batchNumber', { defaultValue: 'Batch / Lot Number' })}</Label>
                                                            <Input
                                                                value={item.batchNumber}
                                                                onChange={(event) => updateItem(index, { batchNumber: event.target.value })}
                                                                placeholder={t('orders.form.autoGenerated', { defaultValue: 'Auto-generated' })}
                                                            />
                                                        </div>
                                                        <div className="space-y-2">
                                                            <Label>
                                                                {t('orders.form.batchSalePrice', { defaultValue: 'Batch Selling Price' })}
                                                                {product ? ` (${product.currency.toUpperCase()})` : ''}
                                                            </Label>
                                                            <Input
                                                                value={formatNumericInput(item.batchSalePrice ?? '')}
                                                                onChange={(event) => updateItem(index, { batchSalePrice: sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 }) })}
                                                                placeholder={product ? String(product.price) : '0'}
                                                            />
                                                        </div>
                                                        <div className="space-y-2">
                                                            <Label>{t('orders.form.manufacturingDate', { defaultValue: 'Manufacturing Date' })}</Label>
                                                            <Input
                                                                type="date"
                                                                value={item.batchManufacturingDate}
                                                                onChange={(event) => updateItem(index, { batchManufacturingDate: event.target.value })}
                                                            />
                                                        </div>
                                                        <div className="space-y-2">
                                                            <Label>{t('orders.form.expiryDate', { defaultValue: 'Expiry Date' })}</Label>
                                                            <Input
                                                                type="date"
                                                                value={item.batchExpiryDate}
                                                                onChange={(event) => updateItem(index, { batchExpiryDate: event.target.value })}
                                                            />
                                                        </div>
                                                    </div>}
                                                </div>
                                            )
                                        })}
                                    </CardContent>
                                </Card>
                                </PartnerRequiredSection>

                                <PartnerRequiredSection
                                    locked={isSupplierSelectionRequired}
                                    unlockLabel={t('orders.form.selectBusinessPartnerToUnlock', { defaultValue: 'Select a business partner to unlock this section.' })}
                                    onLockedInteraction={highlightSupplierInformation}
                                >
                                <Card
                                    data-tour-id="tutorial-order-notes"
                                    className={cn(
                                        'transition-[border-color,background-color] duration-200',
                                        isSupplierSelectionRequired && 'border-destructive/70 bg-destructive/5'
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
                                    locked={isSupplierSelectionRequired}
                                    unlockLabel={t('orders.form.selectBusinessPartnerToUnlock', { defaultValue: 'Select a business partner to unlock this section.' })}
                                    onLockedInteraction={highlightSupplierInformation}
                                >
                                <Card className={cn(
                                    'transition-[border-color,background-color] duration-200',
                                    isSupplierSelectionRequired && 'border-destructive/70 bg-destructive/5'
                                )}>
                                    <CardHeader>
                                        <CardTitle>{t('orders.form.orderDetails', { defaultValue: 'Order Details' })}</CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-4">
                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <div className="space-y-2" data-tour-id="tutorial-order-date">
                                                <Label htmlFor="purchase-delivery" className="flex items-center gap-2">
                                                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                                    {t('orders.form.expectedDelivery', { defaultValue: 'Expected Delivery' })}
                                                </Label>
                                                <DateTimePicker
                                                    id="purchase-delivery"
                                                    mode="date-time"
                                                    date={parseLocalDateTimeValue(expectedDeliveryDate)}
                                                    setDate={(value) => setExpectedDeliveryDate(value ? formatLocalDateTimeValue(value) : '')}
                                                    placeholder={t('orders.form.expectedDelivery', { defaultValue: 'Expected Delivery' })}
                                                />
                                            </div>
                                            {canEditOrderCreation ? (
                                                <div className="space-y-2">
                                                    <Label htmlFor="purchase-order-creation" className="flex items-center gap-2">
                                                        <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                                        {t('orders.form.orderCreation', { defaultValue: 'Order Creation' })}
                                                    </Label>
                                                    <DateTimePicker
                                                        id="purchase-order-creation"
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
                                            <Label htmlFor="purchase-payment" className="flex items-center gap-2">
                                                <CreditCard className="h-4 w-4 text-muted-foreground" />
                                                {t('pos.paymentMethod', { defaultValue: 'Payment Method' })}
                                            </Label>
                                            <PaymentMethodSelect
                                                id="purchase-payment"
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
                                                <div className="text-xs text-muted-foreground">{t('orders.form.paidOnSaveDescription', { defaultValue: 'Record the order as already settled.' })}</div>
                                            </div>
                                            <Switch
                                                checked={isPaid}
                                                onCheckedChange={setIsPaid}
                                            />
                                        </div> : null}
                                        {isFinanced ? (
                                            <div className="grid gap-4 rounded-2xl border p-4 sm:grid-cols-2">
                                                {isInstallmentBased ? <><div className="space-y-2">
                                                    <Label htmlFor="purchase-installment-count">{t('orders.form.installmentCount')}</Label>
                                                    <Input
                                                        id="purchase-installment-count"
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
                                                    <Label className="block break-words" htmlFor="purchase-initial-payment">{isInstallmentBased
                                                        ? t('orders.form.initialPayment')
                                                        : t('orders.form.initialLoanRepayment')}</Label>
                                                    <Input
                                                        id="purchase-initial-payment"
                                                        inputMode="decimal"
                                                        placeholder="0"
                                                        value={formatNumericInput(initialPaymentAmount)}
                                                        onChange={(event) => setInitialPaymentAmount(sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 }))}
                                                    />
                                                </div>
                                                <div className="min-w-0 space-y-2">
                                                    <Label className="block break-words" htmlFor="purchase-first-due">{isInstallmentBased
                                                        ? t('orders.form.firstDueDate')
                                                        : t('orders.form.dueDate')}</Label>
                                                    <DateTimePicker
                                                        id="purchase-first-due"
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
                                    locked={isSupplierSelectionRequired}
                                    unlockLabel={t('orders.form.selectBusinessPartnerToUnlock', { defaultValue: 'Select a business partner to unlock this section.' })}
                                    onLockedInteraction={highlightSupplierInformation}
                                >
                                <Card
                                    data-tour-id="tutorial-order-commercials"
                                    className={cn(
                                        'transition-[border-color,background-color] duration-200',
                                        isSupplierSelectionRequired && 'border-destructive/70 bg-destructive/5'
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
                                        <div className="space-y-2">
                                            <Label htmlFor="purchase-discount">- {t('orders.form.discount', { defaultValue: 'Discount' })}</Label>
                                            <Input id="purchase-discount" value={formatNumericInput(discount)} onChange={(event) => setDiscount(sanitizeNumericInput(event.target.value, { allowDecimal: true, maxFractionDigits: 3 }))} />
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
                                            <div className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
                                                <PackagePlus className="mt-0.5 h-4 w-4" />
                                                <span>{t('orders.form.completionHint', {
                                                    storageName: selectedStorageName,
                                                    defaultValue: `Completing this order will add stock to ${selectedStorageName}.`
                                                })}</span>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                                </PartnerRequiredSection>
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
            <ProductsViewModal
                open={productsViewItemIndex !== null}
                onOpenChange={(open) => {
                    if (!open) setProductsViewItemIndex(null)
                }}
                products={purchasableProducts}
                storages={storages}
                initialStorageId={productsViewItemIndex === null
                    ? ''
                    : (items[productsViewItemIndex]?.storageId || destinationStorageId)}
                getStorageLabel={(storage) => storage.isSystem
                    ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name)
                    : storage.name}
                labels={{
                    title: t('products.title', { defaultValue: 'Products' }),
                    description: t('orders.form.selectProduct', { defaultValue: 'Select a product for this line item.' }),
                    searchLabel: t('common.search', { defaultValue: 'Search' }),
                    searchPlaceholder: t('products.searchPlaceholder', { defaultValue: 'Search products...' }),
                    storageLabel: t('orders.form.selectStorage', { defaultValue: 'Select Storage' }),
                    storagePlaceholder: t('orders.form.selectStorage', { defaultValue: 'Select Storage' }),
                    noProductsLabel: t('inventoryTransfer.noProducts', { defaultValue: 'No products in this storage.' }),
                    noResultsLabel: t('inventoryTransfer.noMatchingProducts', { defaultValue: 'No products match your search.' })
                }}
                onSelectProduct={(product, storageId) => {
                    if (productsViewItemIndex === null) return
                    setHighlightedStorageIndex(null)
                    updateItem(productsViewItemIndex, {
                        productId: product.id,
                        productSearch: product.name,
                        storageId
                    })
                    setProductsViewItemIndex(null)
                }}
            />
                </div>
            )
}
