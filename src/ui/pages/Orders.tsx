import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { CalendarDays, CreditCard, Eye, LayoutGrid, List, Lock, PackagePlus, Pencil, Plus, Search, ShoppingCart, Trash2, Truck, UsersRound, Wallet, Warehouse } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation, useRoute } from 'wouter'

import { useAuth } from '@/auth'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { buildOrderExchangeRatesSnapshot, convertCurrencyAmountWithLiveRates, getPrimaryExchangeDetails } from '@/lib/orderCurrency'
import { formatCurrency } from '@/lib/utils'
import {
    createPurchaseOrder,
    createSalesOrder,
    deletePurchaseOrder,
    deleteSalesOrder,
    lockPurchaseOrder,
    lockSalesOrder,
    setPurchaseOrderPaymentStatus,
    setSalesOrderPaymentStatus,
    updatePurchaseOrder,
    updatePurchaseOrderStatus,
    updateSalesOrder,
    updateSalesOrderStatus,
    useCustomers,
    useInventory,
    useProducts,
    usePurchaseOrders,
    useSalesOrders,
    useStorages,
    useSuppliers,
    type CurrencyCode,
    type PurchaseOrder,
    type PurchaseOrderItem,
    type PurchaseOrderStatus,
    type SalesOrder,
    type SalesOrderItem,
    type SalesOrderStatus
} from '@/local-db'
import { useWorkspace } from '@/workspace'
import { isMobile } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    Textarea,
    useToast
} from '@/ui/components'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { OrderDetailsView } from '@/ui/components/orders/OrderDetailsView'
import { OrderStatusBadge } from '@/ui/components/orders/OrderStatusBadge'

type OrderTab = 'sales' | 'purchase'

type FormItem = {
    productId: string
    storageId: string
    quantity: string
    unitPrice: string
}

type SalesFormState = {
    customerId: string
    sourceStorageId: string
    currency: CurrencyCode
    shippingAddress: string
    expectedDeliveryDate: string
    discount: string
    tax: string
    notes: string
    isPaid: boolean
    paymentMethod: string
    items: FormItem[]
}

type PurchaseFormState = {
    supplierId: string
    destinationStorageId: string
    currency: CurrencyCode
    expectedDeliveryDate: string
    discount: string
    notes: string
    isPaid: boolean
    paymentMethod: string
    items: FormItem[]
}

type DeleteTarget =
    | { type: 'sales'; order: SalesOrder }
    | { type: 'purchase'; order: PurchaseOrder }

function createEmptyItem(storageId = ''): FormItem {
    return {
        productId: '',
        storageId,
        quantity: '1',
        unitPrice: ''
    }
}

function roundFormAmount(value: number, currency: CurrencyCode) {
    if (currency === 'iqd') {
        return Math.round(value)
    }

    return Math.round(value * 100) / 100
}

function formatStatusLabel(t: (key: string) => string, status: string) {
    const translated = t(`orders.status.${status}`)
    return translated && translated !== `orders.status.${status}` ? translated : status
}

function getOrderSummary(items: Array<{ productName: string }>) {
    const firstItems = items.slice(0, 2).map((item) => item.productName)
    if (items.length <= 2) return firstItems.join(', ')
    return `${firstItems.join(', ')} +${items.length - 2}`
}

function getCommonStorageId(items: Array<{ storageId?: string | null }>, fallbackStorageId = '') {
    const storageIds = Array.from(new Set(items.map((item) => item.storageId || fallbackStorageId).filter(Boolean)))
    return storageIds.length === 1 ? storageIds[0] : null
}

function OrdersListView({ workspaceId }: { workspaceId: string }) {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const { toast } = useToast()
    const [, navigate] = useLocation()
    const products = useProducts(workspaceId)
    const inventory = useInventory(workspaceId)
    const storages = useStorages(workspaceId)
    const customers = useCustomers(workspaceId)
    const suppliers = useSuppliers(workspaceId)
    const salesOrders = useSalesOrders(workspaceId)
    const purchaseOrders = usePurchaseOrders(workspaceId)
    const defaultStorageId = (storages.find((storage) => storage.name === 'Main' && storage.isSystem) || storages[0])?.id || ''

    const [activeTab, setActiveTab] = useState<OrderTab>('sales')
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => (localStorage.getItem('orders_view_mode') as 'table' | 'grid') || 'table')
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'ordered' | 'received' | 'completed'>('all')
    const [paymentFilter, setPaymentFilter] = useState<'all' | 'paid' | 'unpaid'>('all')

    useEffect(() => {
        localStorage.setItem('orders_view_mode', viewMode)
    }, [viewMode])
    const [dialogOpen, setDialogOpen] = useState(false)
    const [editingSalesOrder, setEditingSalesOrder] = useState<SalesOrder | null>(null)
    const [editingPurchaseOrder, setEditingPurchaseOrder] = useState<PurchaseOrder | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [lockConfirm, setLockConfirm] = useState<{ isOpen: boolean; orderId: string; type: 'sales' | 'purchase' | null }>({
        isOpen: false,
        orderId: '',
        type: null
    })

    const [salesForm, setSalesForm] = useState<SalesFormState>({
        customerId: '',
        sourceStorageId: defaultStorageId,
        currency: features.default_currency,
        shippingAddress: '',
        expectedDeliveryDate: '',
        discount: '',
        tax: '',
        notes: '',
        isPaid: false,
        paymentMethod: 'credit',
        items: [createEmptyItem(defaultStorageId)]
    })

    const [purchaseForm, setPurchaseForm] = useState<PurchaseFormState>({
        supplierId: '',
        destinationStorageId: defaultStorageId,
        currency: features.default_currency,
        expectedDeliveryDate: '',
        discount: '',
        notes: '',
        isPaid: false,
        paymentMethod: 'credit',
        items: [createEmptyItem(defaultStorageId)]
    })

    const liveRates = useMemo(() => ({
        exchangeData,
        eurRates,
        tryRates
    }), [exchangeData, eurRates, tryRates])

    const canManageOrders = user?.role === 'admin' || user?.role === 'staff'
    const canDeleteOrders = user?.role === 'admin'
    const availableSalesProductIdsByStorage = useMemo(() => {
        const rows = new Map<string, Set<string>>()
        for (const row of inventory) {
            if (row.quantity <= 0) {
                continue
            }

            const current = rows.get(row.storageId) ?? new Set<string>()
            current.add(row.productId)
            rows.set(row.storageId, current)
        }

        return rows
    }, [inventory])

    useEffect(() => {
        if (!defaultStorageId) {
            return
        }

        setSalesForm((current) => ({
            ...current,
            sourceStorageId: current.sourceStorageId || defaultStorageId,
            items: current.items.map((item) => !item.storageId ? { ...item, storageId: defaultStorageId } : item)
        }))
        setPurchaseForm((current) => ({
            ...current,
            destinationStorageId: current.destinationStorageId || defaultStorageId,
            items: current.items.map((item) => !item.storageId ? { ...item, storageId: defaultStorageId } : item)
        }))
    }, [defaultStorageId])

    const filteredSalesOrders = useMemo(() => {
        const query = search.trim().toLowerCase()
        let items = [...salesOrders].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

        // Status Filter
        if (statusFilter !== 'all') {
            const mappedStatus = statusFilter === 'ordered' ? 'pending' : statusFilter
            if (mappedStatus === 'received') {
                items = []
            } else {
                items = items.filter(order => order.status === mappedStatus)
            }
        }

        // Payment Filter
        if (paymentFilter !== 'all') {
            items = items.filter(order => paymentFilter === 'paid' ? order.isPaid : !order.isPaid)
        }

        if (!query) return items
        return items.filter((order) =>
            order.orderNumber.toLowerCase().includes(query)
            || order.customerName.toLowerCase().includes(query)
            || order.items.some((item) => item.productName.toLowerCase().includes(query))
        )
    }, [salesOrders, search, statusFilter, paymentFilter])

    const filteredPurchaseOrders = useMemo(() => {
        const query = search.trim().toLowerCase()
        let items = [...purchaseOrders].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

        // Status Filter
        if (statusFilter !== 'all') {
            items = items.filter(order => order.status === statusFilter)
        }

        // Payment Filter
        if (paymentFilter !== 'all') {
            items = items.filter(order => paymentFilter === 'paid' ? order.isPaid : !order.isPaid)
        }

        if (!query) return items
        return items.filter((order) =>
            order.orderNumber.toLowerCase().includes(query)
            || order.supplierName.toLowerCase().includes(query)
            || order.items.some((item) => item.productName.toLowerCase().includes(query))
        )
    }, [purchaseOrders, search, statusFilter, paymentFilter])

    const salesPreview = useMemo(() => {
        const subtotal = salesForm.items.reduce((sum, item) => sum + ((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0)), 0)
        const total = subtotal - Number(salesForm.discount || 0) + Number(salesForm.tax || 0)
        return roundFormAmount(total, salesForm.currency)
    }, [salesForm.currency, salesForm.discount, salesForm.items, salesForm.tax])
    const salesConfiguredItemsCount = useMemo(
        () => salesForm.items.filter((item) => item.productId && Number(item.quantity) > 0).length,
        [salesForm.items]
    )

    const purchasePreview = useMemo(() => {
        const subtotal = purchaseForm.items.reduce((sum, item) => sum + ((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0)), 0)
        const total = subtotal - Number(purchaseForm.discount || 0)
        return roundFormAmount(total, purchaseForm.currency)
    }, [purchaseForm.currency, purchaseForm.discount, purchaseForm.items])
    const purchaseConfiguredItemsCount = useMemo(
        () => purchaseForm.items.filter((item) => item.productId && Number(item.quantity) > 0).length,
        [purchaseForm.items]
    )

    const getStorageDisplayName = (storageId: string) => {
        const storage = storages.find((entry) => entry.id === storageId)
        if (!storage) {
            return t('orders.form.selectStorage', { defaultValue: 'Select Storage' })
        }

        return storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name
    }
    const multipleStoragesLabel = t('orders.form.multipleStorages', { defaultValue: 'Multiple storages' })
    const getStorageSummaryName = (items: FormItem[], fallbackStorageId: string) => {
        const commonStorageId = getCommonStorageId(items, fallbackStorageId)
        if (commonStorageId) {
            return getStorageDisplayName(commonStorageId)
        }

        return items.some((item) => item.storageId) ? multipleStoragesLabel : t('orders.form.selectStorage', { defaultValue: 'Select Storage' })
    }
    const getSalesProductOptions = (storageId: string, selectedProductId: string) => {
        const availableIds = availableSalesProductIdsByStorage.get(storageId) ?? new Set<string>()
        return products.filter((product) => product.id === selectedProductId || availableIds.has(product.id))
    }

    const selectedCustomerName = customers.find((entry) => entry.id === salesForm.customerId)?.name
        || t('orders.form.selectCustomer', { defaultValue: 'Select Customer' })
    const selectedSupplierName = suppliers.find((entry) => entry.id === purchaseForm.supplierId)?.name
        || t('orders.form.selectSupplier', { defaultValue: 'Select Supplier' })
    const selectedSalesStorageName = getStorageSummaryName(salesForm.items, salesForm.sourceStorageId)
    const selectedPurchaseStorageName = getStorageSummaryName(purchaseForm.items, purchaseForm.destinationStorageId)
    const inventoryByStorageProduct = useMemo(() => new Map(
        inventory.map((row) => [`${row.storageId}:${row.productId}`, row.quantity] as const)
    ), [inventory])

    const getAvailableQuantity = (productId: string, storageId: string) => {
        if (!productId || !storageId) {
            return 0
        }

        return inventoryByStorageProduct.get(`${storageId}:${productId}`) ?? 0
    }

    const getPaymentMethodLabel = (paymentMethod: string) => {
        switch (paymentMethod) {
            case 'cash':
                return 'Cash'
            case 'bank_transfer':
                return 'Bank Transfer'
            default:
                return 'Credit'
        }
    }

    function resetSalesForm(customerId?: string) {
        const customer = customerId ? customers.find((entry) => entry.id === customerId) : undefined
        setEditingSalesOrder(null)
        setSalesForm({
            customerId: customerId || '',
            sourceStorageId: defaultStorageId,
            currency: customer?.defaultCurrency || features.default_currency,
            shippingAddress: '',
            expectedDeliveryDate: '',
            discount: '',
            tax: '',
            notes: '',
            isPaid: false,
            paymentMethod: 'credit',
            items: [createEmptyItem(defaultStorageId)]
        })
    }

    function resetPurchaseForm(supplierId?: string) {
        const supplier = supplierId ? suppliers.find((entry) => entry.id === supplierId) : undefined
        setEditingPurchaseOrder(null)
        setPurchaseForm({
            supplierId: supplierId || '',
            destinationStorageId: defaultStorageId,
            currency: supplier?.defaultCurrency || features.default_currency,
            expectedDeliveryDate: '',
            discount: '',
            notes: '',
            isPaid: false,
            paymentMethod: 'credit',
            items: [createEmptyItem(defaultStorageId)]
        })
    }

    function openCreateDialog(tab: OrderTab) {
        setActiveTab(tab)
        if (tab === 'sales') resetSalesForm()
        else resetPurchaseForm()
        setDialogOpen(true)
    }

    function openSalesEdit(order: SalesOrder) {
        setActiveTab('sales')
        setEditingSalesOrder(order)
        setSalesForm({
            customerId: order.customerId,
            sourceStorageId: order.sourceStorageId || defaultStorageId,
            currency: order.currency,
            shippingAddress: order.shippingAddress || '',
            expectedDeliveryDate: order.expectedDeliveryDate ? order.expectedDeliveryDate.slice(0, 10) : '',
            discount: order.discount ? String(order.discount) : '',
            tax: order.tax ? String(order.tax) : '',
            notes: order.notes || '',
            isPaid: order.isPaid,
            paymentMethod: order.paymentMethod || 'credit',
            items: order.items.map((item) => ({
                productId: item.productId,
                storageId: item.storageId || order.sourceStorageId || defaultStorageId,
                quantity: String(item.quantity),
                unitPrice: String(item.convertedUnitPrice)
            }))
        })
        setDialogOpen(true)
    }

    function openPurchaseEdit(order: PurchaseOrder) {
        setActiveTab('purchase')
        setEditingPurchaseOrder(order)
        setPurchaseForm({
            supplierId: order.supplierId,
            destinationStorageId: order.destinationStorageId || defaultStorageId,
            currency: order.currency,
            expectedDeliveryDate: order.expectedDeliveryDate ? order.expectedDeliveryDate.slice(0, 10) : '',
            discount: order.discount ? String(order.discount) : '',
            notes: order.notes || '',
            isPaid: order.isPaid,
            paymentMethod: order.paymentMethod || 'credit',
            items: order.items.map((item) => ({
                productId: item.productId,
                storageId: item.storageId || order.destinationStorageId || defaultStorageId,
                quantity: String(item.quantity),
                unitPrice: String(item.convertedUnitPrice)
            }))
        })
        setDialogOpen(true)
    }

    function applyDefaultItemPrice(tab: OrderTab, productId: string, partnerCurrency: CurrencyCode) {
        const product = products.find((entry) => entry.id === productId)
        if (!product) return ''

        const sourcePrice = tab === 'sales' ? product.price : product.costPrice
        return String(convertCurrencyAmountWithLiveRates(sourcePrice, product.currency, partnerCurrency, liveRates))
    }

    function updateSalesItem(index: number, changes: Partial<FormItem>) {
        setSalesForm((current) => ({
            ...current,
            sourceStorageId: changes.storageId || current.sourceStorageId,
            items: current.items.map((item, itemIndex) => {
                if (itemIndex !== index) return item
                const next = { ...item, ...changes }
                if (changes.productId && (!item.unitPrice || changes.productId !== item.productId)) {
                    next.unitPrice = applyDefaultItemPrice('sales', changes.productId, current.currency)
                }
                return next
            })
        }))
    }

    function updatePurchaseItem(index: number, changes: Partial<FormItem>) {
        setPurchaseForm((current) => ({
            ...current,
            destinationStorageId: changes.storageId || current.destinationStorageId,
            items: current.items.map((item, itemIndex) => {
                if (itemIndex !== index) return item
                const next = { ...item, ...changes }
                if (changes.productId && (!item.unitPrice || changes.productId !== item.productId)) {
                    next.unitPrice = applyDefaultItemPrice('purchase', changes.productId, current.currency)
                }
                return next
            })
        }))
    }

    function buildSalesItems(orderCurrency: CurrencyCode) {
        const snapshot = buildOrderExchangeRatesSnapshot(liveRates)
        const items: SalesOrderItem[] = salesForm.items
            .filter((item) => item.productId && Number(item.quantity) > 0)
            .map((item) => {
                const product = products.find((entry) => entry.id === item.productId)
                if (!product) throw new Error('Selected product was not found')
                if (!item.storageId) throw new Error(`Select a source storage for ${product.name}`)

                const quantity = Number(item.quantity)
                const unitPrice = Number(item.unitPrice || 0)
                return {
                    id: `${product.id}-${item.storageId}-${quantity}-${unitPrice}`,
                    productId: product.id,
                    storageId: item.storageId,
                    productName: product.name,
                    productSku: product.sku,
                    quantity,
                    lineTotal: roundFormAmount(quantity * unitPrice, orderCurrency),
                    originalCurrency: product.currency,
                    originalUnitPrice: convertCurrencyAmountWithLiveRates(unitPrice, orderCurrency, product.currency, liveRates),
                    convertedUnitPrice: roundFormAmount(unitPrice, orderCurrency),
                    settlementCurrency: orderCurrency,
                    costPrice: product.costPrice,
                    convertedCostPrice: convertCurrencyAmountWithLiveRates(product.costPrice, product.currency, orderCurrency, liveRates)
                }
            })

        return { items, snapshot }
    }

    function buildPurchaseItems(orderCurrency: CurrencyCode) {
        const snapshot = buildOrderExchangeRatesSnapshot(liveRates)
        const items: PurchaseOrderItem[] = purchaseForm.items
            .filter((item) => item.productId && Number(item.quantity) > 0)
            .map((item) => {
                const product = products.find((entry) => entry.id === item.productId)
                if (!product) throw new Error('Selected product was not found')
                if (!item.storageId) throw new Error(`Select a target storage for ${product.name}`)

                const quantity = Number(item.quantity)
                const unitPrice = Number(item.unitPrice || 0)
                return {
                    id: `${product.id}-${item.storageId}-${quantity}-${unitPrice}`,
                    productId: product.id,
                    storageId: item.storageId,
                    productName: product.name,
                    productSku: product.sku,
                    quantity,
                    lineTotal: roundFormAmount(quantity * unitPrice, orderCurrency),
                    originalCurrency: product.currency,
                    originalUnitPrice: convertCurrencyAmountWithLiveRates(unitPrice, orderCurrency, product.currency, liveRates),
                    convertedUnitPrice: roundFormAmount(unitPrice, orderCurrency),
                    settlementCurrency: orderCurrency
                }
            })

        return { items, snapshot }
    }

    async function handleSalesSubmit(event: FormEvent) {
        event.preventDefault()
        if (!user?.workspaceId) return

        const customer = customers.find((entry) => entry.id === salesForm.customerId)
        if (!customer) {
            toast({ title: t('common.error') || 'Error', description: t('orders.noCustomers') || 'Add customers before creating orders.', variant: 'destructive' })
            return
        }

        setIsSaving(true)
        try {
            const { items, snapshot } = buildSalesItems(salesForm.currency)
            if (items.length === 0) throw new Error('Add at least one item')
            const sourceStorageId = getCommonStorageId(items)

            const subtotal = roundFormAmount(items.reduce((sum, item) => sum + item.lineTotal, 0), salesForm.currency)
            const discount = roundFormAmount(Number(salesForm.discount || 0), salesForm.currency)
            const tax = roundFormAmount(Number(salesForm.tax || 0), salesForm.currency)
            const total = roundFormAmount(subtotal - discount + tax, salesForm.currency)
            const primaryRate = getPrimaryExchangeDetails(salesForm.currency, features.default_currency, snapshot)

            const payload = {
                customerId: customer.id,
                customerName: customer.name,
                sourceStorageId,
                items,
                subtotal,
                discount,
                tax,
                total,
                currency: salesForm.currency,
                exchangeRate: primaryRate.exchangeRate,
                exchangeRateSource: primaryRate.exchangeRateSource,
                exchangeRateTimestamp: primaryRate.exchangeRateTimestamp,
                exchangeRates: snapshot,
                status: 'draft' as SalesOrderStatus,
                expectedDeliveryDate: salesForm.expectedDeliveryDate || null,
                actualDeliveryDate: null,
                isPaid: salesForm.isPaid,
                paidAt: salesForm.isPaid ? new Date().toISOString() : null,
                paymentMethod: salesForm.isPaid ? (salesForm.paymentMethod as SalesOrder['paymentMethod']) : 'credit',
                reservedAt: null,
                shippingAddress: salesForm.shippingAddress || undefined,
                notes: salesForm.notes || undefined
            }

            if (editingSalesOrder) await updateSalesOrder(editingSalesOrder.id, payload)
            else await createSalesOrder(user.workspaceId, payload)

            toast({ title: editingSalesOrder ? (t('common.save') || 'Saved') : (t('common.create') || 'Created') })
            setDialogOpen(false)
            resetSalesForm()
        } catch (error: any) {
            toast({ title: t('common.error') || 'Error', description: error?.message || 'Failed to save sales order', variant: 'destructive' })
        } finally {
            setIsSaving(false)
        }
    }

    async function handlePurchaseSubmit(event: FormEvent) {
        event.preventDefault()
        if (!user?.workspaceId) return

        const supplier = suppliers.find((entry) => entry.id === purchaseForm.supplierId)
        if (!supplier) {
            toast({ title: t('common.error') || 'Error', description: 'Add suppliers before creating purchase orders.', variant: 'destructive' })
            return
        }

        setIsSaving(true)
        try {
            const { items, snapshot } = buildPurchaseItems(purchaseForm.currency)
            if (items.length === 0) throw new Error('Add at least one item')
            const destinationStorageId = getCommonStorageId(items)

            const subtotal = roundFormAmount(items.reduce((sum, item) => sum + item.lineTotal, 0), purchaseForm.currency)
            const discount = roundFormAmount(Number(purchaseForm.discount || 0), purchaseForm.currency)
            const total = roundFormAmount(subtotal - discount, purchaseForm.currency)
            const primaryRate = getPrimaryExchangeDetails(purchaseForm.currency, features.default_currency, snapshot)

            const payload = {
                supplierId: supplier.id,
                supplierName: supplier.name,
                destinationStorageId,
                items,
                subtotal,
                discount,
                total,
                currency: purchaseForm.currency,
                exchangeRate: primaryRate.exchangeRate,
                exchangeRateSource: primaryRate.exchangeRateSource,
                exchangeRateTimestamp: primaryRate.exchangeRateTimestamp,
                exchangeRates: snapshot,
                status: 'draft' as PurchaseOrderStatus,
                expectedDeliveryDate: purchaseForm.expectedDeliveryDate || null,
                actualDeliveryDate: null,
                isPaid: purchaseForm.isPaid,
                paidAt: purchaseForm.isPaid ? new Date().toISOString() : null,
                paymentMethod: purchaseForm.isPaid ? (purchaseForm.paymentMethod as PurchaseOrder['paymentMethod']) : 'credit',
                notes: purchaseForm.notes || undefined
            }

            if (editingPurchaseOrder) await updatePurchaseOrder(editingPurchaseOrder.id, payload)
            else await createPurchaseOrder(user.workspaceId, payload)

            toast({ title: editingPurchaseOrder ? (t('common.save') || 'Saved') : (t('common.create') || 'Created') })
            setDialogOpen(false)
            resetPurchaseForm()
        } catch (error: any) {
            toast({ title: t('common.error') || 'Error', description: error?.message || 'Failed to save purchase order', variant: 'destructive' })
        } finally {
            setIsSaving(false)
        }
    }

    async function runAction(action: () => Promise<unknown>, successMessage: string) {
        try {
            await action()
            toast({ title: successMessage })
        } catch (error: any) {
            toast({ title: t('common.error') || 'Error', description: error?.message || 'Action failed', variant: 'destructive' })
        }
    }

    async function handleDeleteConfirm() {
        if (!deleteTarget) return
        if (deleteTarget.type === 'sales') {
            await runAction(() => deleteSalesOrder(deleteTarget.order.id), 'Sales order deleted')
        } else {
            await runAction(() => deletePurchaseOrder(deleteTarget.order.id), 'Purchase order deleted')
        }
        setDeleteTarget(null)
    }

    async function handleLockConfirm() {
        if (!lockConfirm.orderId || !lockConfirm.type) return
        
        const action = lockConfirm.type === 'sales' ? () => lockSalesOrder(lockConfirm.orderId) : () => lockPurchaseOrder(lockConfirm.orderId)
        await runAction(action, t('orders.lockedSuccess') || 'Order locked successfully')
        setLockConfirm({ isOpen: false, orderId: '', type: null })
    }

    function renderOrderTable() {
        const rows = activeTab === 'sales' ? filteredSalesOrders : filteredPurchaseOrders

        return (
            <div className="overflow-x-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t('orders.table.orderNumber') || 'Order #'}</TableHead>
                            <TableHead>{activeTab === 'sales' ? (t('orders.table.customer') || 'Customer') : (t('suppliers.title') || 'Supplier')}</TableHead>
                            <TableHead>{t('orders.table.items') || 'Items'}</TableHead>
                            <TableHead>{t('common.status') || 'Status'}</TableHead>
                            <TableHead>{t('common.total') || 'Total'}</TableHead>
                            <TableHead>{t('orders.form.date') || 'Date'}</TableHead>
                            <TableHead>{t('pos.paymentMethod') || 'Payment'}</TableHead>
                            <TableHead className="text-right">{t('common.actions') || 'Actions'}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                                    {t('common.noData') || 'No data available'}
                                </TableCell>
                            </TableRow>
                        ) : rows.map((row) => {
                            const summary = getOrderSummary(row.items)
                            const isDraft = row.status === 'draft'
                            const canEdit = canManageOrders && isDraft
                            const canDelete = canDeleteOrders && isDraft

                            return (
                                <TableRow key={row.id}>
                                    <TableCell className="font-semibold">
                                        <div>{row.orderNumber}</div>
                                        <div className="text-xs text-muted-foreground">{summary}</div>
                                    </TableCell>
                                    <TableCell>{activeTab === 'sales' ? (row as SalesOrder).customerName : (row as PurchaseOrder).supplierName}</TableCell>
                                    <TableCell>{row.items.length}</TableCell>
                                    <TableCell>
                                        <OrderStatusBadge status={row.status} label={formatStatusLabel(t, row.status)} />
                                    </TableCell>
                                    <TableCell>{formatCurrency(row.total, row.currency, features.iqd_display_preference)}</TableCell>
                                    <TableCell>{new Date(row.updatedAt).toLocaleDateString()}</TableCell>
                                    <TableCell>
                                        <div className="flex items-center gap-1.5">
                                            <span className={row.isPaid ? 'font-semibold text-emerald-600' : 'text-amber-600'}>
                                                {row.isPaid ? (t('budget.status.paid') || 'Paid') : (t('budget.status.pending') || 'Pending')}
                                            </span>
                                            {row.isLocked && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex flex-wrap justify-end gap-2">
                                            {activeTab === 'sales' ? (
                                                <>
                                                    <Button variant="outline" size="sm" onClick={() => navigate(`/orders/${row.id}`)}><Eye className="mr-1 h-3.5 w-3.5" />{t('common.view') || 'View'}</Button>
                                                    {canEdit && <Button variant="outline" size="sm" onClick={() => openSalesEdit(row as SalesOrder)}><Pencil className="mr-1 h-3.5 w-3.5" />{t('common.edit') || 'Edit'}</Button>}
                                                    {canManageOrders && row.status === 'draft' && <Button size="sm" onClick={() => runAction(() => updateSalesOrderStatus(row.id, 'pending'), 'Sales order reserved')}>{t('orders.actions.reserve') || 'Reserve'}</Button>}
                                                    {canManageOrders && row.status === 'pending' && <Button size="sm" onClick={() => runAction(() => updateSalesOrderStatus(row.id, 'completed'), 'Sales order completed')}>{t('orders.actions.complete') || 'Complete'}</Button>}
                                                    {canManageOrders && (row.status === 'draft' || row.status === 'pending') && <Button variant="outline" size="sm" onClick={() => runAction(() => updateSalesOrderStatus(row.id, 'cancelled'), 'Sales order cancelled')}>{t('orders.actions.cancel') || 'Cancel'}</Button>}
                                                    {canManageOrders && !row.isLocked && <Button variant="outline" size="sm" onClick={() => runAction(() => setSalesOrderPaymentStatus(row.id, { isPaid: !row.isPaid, paymentMethod: (row.paymentMethod || 'cash') as SalesOrder['paymentMethod'] }), row.isPaid ? 'Marked unpaid' : 'Marked paid')}>{row.isPaid ? 'Unpay' : 'Pay'}</Button>}
                                                    {canManageOrders && row.isPaid && !row.isLocked && <Button variant="outline" size="sm" onClick={() => setLockConfirm({ isOpen: true, orderId: row.id, type: 'sales' })}><Lock className="h-3.5 w-3.5" /></Button>}
                                                    {canDelete && <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteTarget({ type: 'sales', order: row as SalesOrder })}><Trash2 className="h-4 w-4" /></Button>}
                                                </>
                                            ) : (
                                                <>
                                                    <Button variant="outline" size="sm" onClick={() => navigate(`/orders/${row.id}`)}><Eye className="mr-1 h-3.5 w-3.5" />{t('common.view') || 'View'}</Button>
                                                    {canEdit && <Button variant="outline" size="sm" onClick={() => openPurchaseEdit(row as PurchaseOrder)}><Pencil className="mr-1 h-3.5 w-3.5" />{t('common.edit') || 'Edit'}</Button>}
                                                    {canManageOrders && row.status === 'draft' && <Button size="sm" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'ordered'), 'Purchase order sent')}>{t('orders.actions.order') || 'Order'}</Button>}
                                                    {canManageOrders && row.status === 'ordered' && <Button size="sm" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'received'), 'Purchase order received')}>{t('orders.actions.receive') || 'Receive'}</Button>}
                                                    {canManageOrders && row.status === 'received' && <Button size="sm" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'completed'), 'Purchase order completed')}>{t('orders.actions.complete') || 'Complete'}</Button>}
                                                    {canManageOrders && (row.status === 'draft' || row.status === 'ordered') && <Button variant="outline" size="sm" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'cancelled'), 'Purchase order cancelled')}>{t('orders.actions.cancel') || 'Cancel'}</Button>}
                                                    {canManageOrders && !row.isLocked && <Button variant="outline" size="sm" onClick={() => runAction(() => setPurchaseOrderPaymentStatus(row.id, { isPaid: !row.isPaid, paymentMethod: (row.paymentMethod || 'cash') as PurchaseOrder['paymentMethod'] }), row.isPaid ? 'Marked unpaid' : 'Marked paid')}>{row.isPaid ? 'Unpay' : 'Pay'}</Button>}
                                                    {canManageOrders && row.isPaid && !row.isLocked && <Button variant="outline" size="sm" onClick={() => setLockConfirm({ isOpen: true, orderId: row.id, type: 'purchase' })}><Lock className="h-3.5 w-3.5" /></Button>}
                                                    {canDelete && <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteTarget({ type: 'purchase', order: row as PurchaseOrder })}><Trash2 className="h-4 w-4" /></Button>}
                                                </>
                                            )}
                                        </div>
                                    </TableCell>
                                </TableRow>
                            )
                        })}
                    </TableBody>
                </Table>
            </div>
        )
    }

    function renderOrderGrid() {
        const rows = activeTab === 'sales' ? filteredSalesOrders : filteredPurchaseOrders

        return (
            <div className={cn(
                "grid gap-4 p-4 bg-muted/5",
                viewMode === 'grid' && !isMobile() ? "md:grid-cols-2 xl:grid-cols-3" : "grid-cols-1"
            )}>
                {rows.length === 0 ? (
                    <div className="text-center text-muted-foreground py-12 bg-background rounded-lg border">
                        {t('common.noData') || 'No data available'}
                    </div>
                ) : rows.map((row) => {
                    const summary = getOrderSummary(row.items)
                    const isDraft = row.status === 'draft'
                    const canEdit = canManageOrders && isDraft
                    const canDelete = canDeleteOrders && isDraft

                    return (
                        <div
                            key={row.id}
                            className="p-4 border shadow-sm space-y-4 transition-all active:scale-[0.98] bg-background rounded-2xl"
                        >
                            <div className="flex justify-between items-start">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-bold text-primary">{row.orderNumber}</span>
                                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-primary/10 text-primary">
                                            {activeTab === 'sales' ? t('orders.tabs.sales') : t('orders.tabs.purchase')}
                                        </span>
                                    </div>
                                    <div className="text-base font-bold text-foreground">
                                        {activeTab === 'sales' ? (row as SalesOrder).customerName : (row as PurchaseOrder).supplierName}
                                    </div>
                                    <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                                        {summary}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <OrderStatusBadge status={row.status} label={formatStatusLabel(t, row.status)} />
                                    <div className="text-xs text-muted-foreground mt-2 font-medium">
                                        {new Date(row.updatedAt).toLocaleDateString()}
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-3 gap-2 py-3 border-y border-border/50">
                                <div className="text-center">
                                    <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('orders.table.items') || 'Items'}</div>
                                    <div className="text-[11px] font-bold">{row.items.length}</div>
                                </div>
                                <div className="text-center border-l border-border/50">
                                    <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('common.total') || 'Total'}</div>
                                    <div className="text-[11px] font-bold text-primary">{formatCurrency(row.total, row.currency, features.iqd_display_preference)}</div>
                                </div>
                                <div className="text-center border-l border-border/50">
                                    <div className="text-[10px] text-muted-foreground font-bold uppercase tracking-tight">{t('pos.paymentMethod') || 'Payment'}</div>
                                    <div className={cn(
                                        "text-[11px] font-bold flex items-center justify-center gap-1",
                                        row.isPaid ? "text-emerald-600" : "text-amber-600"
                                    )}>
                                        {row.isPaid ? (t('budget.status.paid') || 'Paid') : (t('budget.status.pending') || 'Pending')}
                                        {row.isLocked && <Lock className="h-2.5 w-2.5 text-muted-foreground" />}
                                    </div>
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                                <Button variant="outline" size="sm" className="flex-1 h-9 rounded-xl font-bold gap-2 text-xs" onClick={() => navigate(`/orders/${row.id}`)}>
                                    <Eye className="w-3.5 h-3.5" />
                                    {t('common.view') || 'View'}
                                </Button>
                                {activeTab === 'sales' ? (
                                    <>
                                        {canManageOrders && row.status === 'draft' && <Button size="sm" className="h-9 rounded-xl px-3 text-[10px] font-bold uppercase shadow-sm ring-1 ring-primary/20" onClick={() => runAction(() => updateSalesOrderStatus(row.id, 'pending'), 'Sales order reserved')}>{t('orders.actions.reserve') || 'Reserve'}</Button>}
                                        {canManageOrders && row.status === 'pending' && <Button size="sm" className="h-9 rounded-xl px-3 text-[10px] font-bold uppercase shadow-sm ring-1 ring-primary/20" onClick={() => runAction(() => updateSalesOrderStatus(row.id, 'completed'), 'Sales order completed')}>{t('orders.actions.complete') || 'Complete'}</Button>}
                                        {canManageOrders && (row.status === 'draft' || row.status === 'pending') && <Button variant="outline" size="sm" className="h-9 rounded-xl px-3 text-[10px] font-bold uppercase" onClick={() => runAction(() => updateSalesOrderStatus(row.id, 'cancelled'), 'Sales order cancelled')}>{t('orders.actions.cancel') || 'Cancel'}</Button>}
                                        {canEdit && <Button variant="outline" size="sm" className="h-9 rounded-xl px-3" onClick={() => openSalesEdit(row as SalesOrder)}><Pencil className="h-3.5 w-3.5" /></Button>}
                                        {canManageOrders && !row.isLocked && <Button variant="outline" size="sm" className="h-9 rounded-xl px-3 text-[10px] font-bold uppercase" onClick={() => runAction(() => setSalesOrderPaymentStatus(row.id, { isPaid: !row.isPaid, paymentMethod: (row.paymentMethod || 'cash') as SalesOrder['paymentMethod'] }), row.isPaid ? 'Marked unpaid' : 'Marked paid')}>{row.isPaid ? 'Unpay' : 'Pay'}</Button>}
                                        {canManageOrders && row.isPaid && !row.isLocked && <Button variant="outline" size="sm" className="h-9 rounded-xl px-3" onClick={() => setLockConfirm({ isOpen: true, orderId: row.id, type: 'sales' })}><Lock className="h-3.5 w-3.5" /></Button>}
                                        {canDelete && <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl text-destructive" onClick={() => setDeleteTarget({ type: 'sales', order: row as SalesOrder })}><Trash2 className="h-4 w-4" /></Button>}
                                    </>
                                ) : (
                                    <>
                                        {canManageOrders && row.status === 'draft' && <Button size="sm" className="h-9 rounded-xl px-3 text-[10px] font-bold uppercase shadow-sm ring-1 ring-primary/20" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'ordered'), 'Purchase order placed')}>{t('orders.actions.order') || 'Order'}</Button>}
                                        {canManageOrders && row.status === 'ordered' && <Button size="sm" className="h-9 rounded-xl px-3 text-[10px] font-bold uppercase shadow-sm ring-1 ring-primary/20" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'received'), 'Purchase order received')}>{t('orders.actions.receive') || 'Receive'}</Button>}
                                        {canManageOrders && row.status === 'received' && <Button size="sm" className="h-9 rounded-xl px-3 text-[10px] font-bold uppercase shadow-sm ring-1 ring-primary/20" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'completed'), 'Purchase order completed')}>{t('orders.actions.complete') || 'Complete'}</Button>}
                                        {canManageOrders && (row.status === 'draft' || row.status === 'ordered') && <Button variant="outline" size="sm" className="h-9 rounded-xl px-3 text-[10px] font-bold uppercase" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'cancelled'), 'Purchase order cancelled')}>{t('orders.actions.cancel') || 'Cancel'}</Button>}
                                        {canEdit && <Button variant="outline" size="sm" className="h-9 rounded-xl px-3" onClick={() => openPurchaseEdit(row as PurchaseOrder)}><Pencil className="h-3.5 w-3.5" /></Button>}
                                        {canManageOrders && !row.isLocked && <Button variant="outline" size="sm" className="h-9 rounded-xl px-3 text-[10px] font-bold uppercase" onClick={() => runAction(() => setPurchaseOrderPaymentStatus(row.id, { isPaid: !row.isPaid, paymentMethod: (row.paymentMethod || 'cash') as PurchaseOrder['paymentMethod'] }), row.isPaid ? 'Marked unpaid' : 'Marked paid')}>{row.isPaid ? 'Unpay' : 'Pay'}</Button>}
                                        {canManageOrders && row.isPaid && !row.isLocked && <Button variant="outline" size="sm" className="h-9 rounded-xl px-3" onClick={() => setLockConfirm({ isOpen: true, orderId: row.id, type: 'purchase' })}><Lock className="h-3.5 w-3.5" /></Button>}
                                        {canDelete && <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl text-destructive" onClick={() => setDeleteTarget({ type: 'purchase', order: row as PurchaseOrder })}><Trash2 className="h-4 w-4" /></Button>}
                                    </>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>
        )
    }

    const salesDisabled = customers.length === 0 || products.length === 0
    const purchaseDisabled = suppliers.length === 0 || products.length === 0

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <ShoppingCart className="h-6 w-6 text-primary" />
                        {t('orders.title') || 'Orders'}
                    </h1>
                    <p className="text-muted-foreground">{t('orders.subtitle') || 'Track sales and purchase orders'}</p>
                </div>
                {canManageOrders && (
                    <Button
                        className="gap-2 self-start rounded-xl"
                        onClick={() => openCreateDialog(activeTab)}
                        disabled={(activeTab === 'sales' && salesDisabled) || (activeTab === 'purchase' && purchaseDisabled)}
                    >
                        <Plus className="h-4 w-4" />
                        {activeTab === 'sales' ? (t('orders.form.newSalesOrder') || 'New Sales Order') : (t('orders.form.newPurchaseOrder') || 'New Purchase Order')}
                    </Button>
                )}
            </div>

            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('orders.tabs.sales') || 'Sales Orders'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{salesOrders.length}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('orders.tabs.purchase') || 'Purchase Orders'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">{purchaseOrders.length}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('budget.status.pending') || 'Pending'}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-black">
                            {salesOrders.filter((order) => order.status === 'pending').length + purchaseOrders.filter((order) => order.status === 'ordered').length}
                        </div>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader className="gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as OrderTab)} className="w-full">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                            <div className="flex flex-col sm:flex-row gap-4 w-full lg:w-auto">
                                <TabsList className="w-full sm:w-auto">
                                    <TabsTrigger value="sales" className="flex-1 sm:flex-none">{t('orders.tabs.sales') || 'Sales Orders'}</TabsTrigger>
                                    <TabsTrigger value="purchase" className="flex-1 sm:flex-none">{t('orders.tabs.purchase') || 'Purchase Orders'}</TabsTrigger>
                                </TabsList>

                                <div className="flex flex-wrap items-center gap-2">
                                    {/* Status Filter */}
                                    <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-lg border border-border/40">
                                        {(['all', 'draft', 'ordered', 'received', 'completed'] as const).map((value) => (
                                            <button
                                                key={value}
                                                onClick={() => setStatusFilter(value)}
                                                className={cn(
                                                    'px-2.5 py-1 text-[10px] sm:text-xs rounded-md font-bold uppercase transition-all whitespace-nowrap',
                                                    statusFilter === value
                                                        ? 'bg-primary text-primary-foreground shadow-sm'
                                                        : 'text-muted-foreground hover:bg-background/80'
                                                )}
                                            >
                                                {value === 'all' ? (t('common.all') || 'All') : t(`orders.status.${value}`) || value}
                                            </button>
                                        ))}
                                    </div>

                                    {/* Payment Filter */}
                                    <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-lg border border-border/40">
                                        {(['all', 'paid', 'unpaid'] as const).map((value) => (
                                            <button
                                                key={value}
                                                onClick={() => setPaymentFilter(value)}
                                                className={cn(
                                                    'px-2.5 py-1 text-[10px] sm:text-xs rounded-md font-bold uppercase transition-all whitespace-nowrap',
                                                    paymentFilter === value
                                                        ? 'bg-primary text-primary-foreground shadow-sm'
                                                        : 'text-muted-foreground hover:bg-background/80'
                                                )}
                                            >
                                                {value === 'all' ? (t('common.all') || 'All') : t(`budget.status.${value}`) || value}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="flex flex-col lg:flex-row gap-4 items-center w-full lg:w-auto">
                                <div className="relative w-full max-w-sm">
                                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                    <Input
                                        value={search}
                                        onChange={(event) => setSearch(event.target.value)}
                                        placeholder={activeTab === 'sales'
                                            ? (t('orders.placeholder.searchSales') || 'Search sales orders...')
                                            : (t('orders.placeholder.searchPurchase') || 'Search purchase orders...')}
                                        className="pl-9"
                                    />
                                </div>
                                {!isMobile() && (
                                    <div className="flex items-center bg-muted/30 p-1 rounded-lg border border-border/40 ml-auto">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setViewMode('table')}
                                            className={cn(
                                                "h-7 px-3 font-bold uppercase text-[9px] flex items-center gap-1.5 transition-all text-primary",
                                                viewMode === 'table'
                                                    ? "bg-primary text-primary-foreground shadow-sm"
                                                    : "text-muted-foreground hover:bg-background/50"
                                            )}
                                        >
                                            <List className="w-3" />
                                            {t('orders.view.table')}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setViewMode('grid')}
                                            className={cn(
                                                "h-7 px-3 font-bold uppercase text-[9px] flex items-center gap-1.5 transition-all text-primary",
                                                viewMode === 'grid'
                                                    ? "bg-primary text-primary-foreground shadow-sm"
                                                    : "text-muted-foreground hover:bg-background/50"
                                            )}
                                        >
                                            <LayoutGrid className="w-3" />
                                            {t('orders.view.grid')}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </div>
                        <TabsContent value="sales" className="mt-0">
                            {salesDisabled && (
                                <div className="mb-4 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                                    {customers.length === 0 ? (t('orders.noCustomers') || 'Add customers before creating orders.') : 'Add products before creating orders.'}
                                </div>
                            )}
                            {isMobile() || viewMode === 'grid' ? renderOrderGrid() : renderOrderTable()}
                        </TabsContent>
                        <TabsContent value="purchase" className="mt-0">
                            {purchaseDisabled && (
                                <div className="mb-4 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                                    {suppliers.length === 0 ? 'Add suppliers before creating purchase orders.' : 'Add products before creating purchase orders.'}
                                </div>
                            )}
                            {isMobile() || viewMode === 'grid' ? renderOrderGrid() : renderOrderTable()}
                        </TabsContent>
                    </Tabs>
                </CardHeader>
            </Card>

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-0.75rem)] w-[calc(100vw-0.75rem)] max-w-6xl flex-col overflow-hidden rounded-[1.25rem] border-border/60 p-0 sm:w-[calc(100vw-2rem)] sm:max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem)] sm:rounded-[1.75rem]">
                    <DialogHeader className="border-b bg-muted/30 px-4 py-4 pr-14 text-left sm:px-6 sm:py-5">
                        <DialogTitle className="text-xl">
                            {activeTab === 'sales'
                                ? (editingSalesOrder ? (t('orders.form.editSalesOrder') || 'Edit Sales Order') : (t('orders.form.newSalesOrder') || 'New Sales Order'))
                                : (editingPurchaseOrder ? (t('orders.form.editPurchaseOrder') || 'Edit Purchase Order') : (t('orders.form.newPurchaseOrder') || 'New Purchase Order'))}
                        </DialogTitle>
                        <p className="text-sm text-muted-foreground">
                            {activeTab === 'sales'
                                ? 'Choose the customer and assign a source storage to each line before reserving stock.'
                                : 'Choose the supplier and assign a target storage to each line before posting stock.'}
                        </p>
                    </DialogHeader>

                    {activeTab === 'sales' ? (
                        <form onSubmit={handleSalesSubmit} className="flex min-h-0 flex-1 flex-col">
                            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
                                <div className="mb-6 grid gap-3 sm:grid-cols-3">
                                    <div className="rounded-2xl border bg-background/90 p-3 shadow-sm sm:p-4">
                                        <div className="flex items-start gap-3">
                                            <div className="rounded-xl bg-primary/10 p-2 text-primary">
                                                <UsersRound className="h-4 w-4" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                                                    {t('orders.form.customer') || 'Customer'}
                                                </p>
                                                <p className="truncate text-sm font-semibold">{selectedCustomerName}</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="rounded-2xl border bg-background/90 p-3 shadow-sm sm:p-4">
                                        <div className="flex items-start gap-3">
                                            <div className="rounded-xl bg-primary/10 p-2 text-primary">
                                                <Warehouse className="h-4 w-4" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                                                    {t('orders.form.sourceStorage', { defaultValue: 'Source Storage' })}
                                                </p>
                                                <p className="truncate text-sm font-semibold">{selectedSalesStorageName}</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="rounded-2xl border bg-background/90 p-3 shadow-sm sm:p-4">
                                        <div className="flex items-start gap-3">
                                            <div className="rounded-xl bg-primary/10 p-2 text-primary">
                                                <Wallet className="h-4 w-4" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                                                    {t('common.total') || 'Total'}
                                                </p>
                                                <p className="truncate text-sm font-semibold">
                                                    {formatCurrency(salesPreview, salesForm.currency, features.iqd_display_preference)}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.95fr)]">
                                    <Card className="border-border/60 shadow-sm">
                                        <CardHeader className="flex flex-col items-start justify-between gap-4 space-y-0 sm:flex-row">
                                            <div className="space-y-1">
                                                <CardTitle>{t('orders.form.addProducts') || 'Add Products'}</CardTitle>
                                                <p className="text-sm text-muted-foreground">
                                                    Pick the source storage inside each line so availability is checked against the right stock position.
                                                </p>
                                            </div>
                                            <Button type="button" variant="outline" size="sm" onClick={() => setSalesForm((current) => ({ ...current, items: [...current.items, createEmptyItem(current.items[current.items.length - 1]?.storageId || current.sourceStorageId || defaultStorageId)] }))}>
                                                <Plus className="mr-1 h-3.5 w-3.5" />
                                                {t('orders.form.addItem') || 'Add Item'}
                                            </Button>
                                        </CardHeader>
                                        <CardContent className="space-y-3">
                                            {salesForm.items.map((item, index) => {
                                                const product = products.find((entry) => entry.id === item.productId)
                                                const lineTotal = roundFormAmount((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0), salesForm.currency)

                                                return (
                                                    <div key={`sales-item-${index}`} className="grid gap-3 rounded-2xl border bg-background p-4 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_110px_140px_40px]">
                                                        <div className="space-y-2">
                                                            <Label className="md:hidden">{t('orders.form.table.product') || 'Product'}</Label>
                                                            <Select value={item.productId} onValueChange={(value) => updateSalesItem(index, { productId: value })}>
                                                                <SelectTrigger><SelectValue placeholder={t('orders.form.selectProduct') || 'Select Product'} /></SelectTrigger>
                                                                <SelectContent>
                                                                    {getSalesProductOptions(item.storageId, item.productId).map((productOption) => (
                                                                        <SelectItem key={productOption.id} value={productOption.id}>{productOption.name}</SelectItem>
                                                                    ))}
                                                                </SelectContent>
                                                            </Select>
                                                        </div>
                                                        <div className="space-y-2">
                                                            <Label className="md:hidden">{t('orders.form.sourceStorage', { defaultValue: 'Source Storage' })}</Label>
                                                            <Select value={item.storageId} onValueChange={(value) => updateSalesItem(index, { storageId: value })}>
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
                                                                {item.storageId && item.productId
                                                                    ? `Available in ${getStorageDisplayName(item.storageId)}: ${getAvailableQuantity(item.productId, item.storageId)}`
                                                                    : 'Choose a storage for this line before checking stock.'}
                                                            </p>
                                                        </div>
                                                        <div className="space-y-2">
                                                            <Label className="md:hidden">{t('orders.form.table.qty') || 'Qty'}</Label>
                                                            <Input type="number" min="1" value={item.quantity} onChange={(event) => updateSalesItem(index, { quantity: event.target.value })} placeholder={t('common.quantity') || 'Quantity'} />
                                                        </div>
                                                        <div className="space-y-2">
                                                            <Label className="md:hidden">{t('orders.form.table.price') || 'Unit Price'}</Label>
                                                            <Input type="number" min="0" step="0.01" value={item.unitPrice} onChange={(event) => updateSalesItem(index, { unitPrice: event.target.value })} placeholder={t('common.price') || 'Price'} />
                                                        </div>
                                                        <div className="flex items-start justify-end">
                                                            <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => setSalesForm((current) => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))}>
                                                                <Trash2 className="h-4 w-4" />
                                                            </Button>
                                                        </div>
                                                        <div className="flex items-center justify-between text-xs text-muted-foreground md:col-span-5">
                                                            <span>{product?.sku ? `SKU: ${product.sku}` : '\u00A0'}</span>
                                                            <span>{(t('orders.form.table.total') || 'Total')}: {formatCurrency(lineTotal, salesForm.currency, features.iqd_display_preference)}</span>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </CardContent>
                                    </Card>

                                    <div className="space-y-6">
                                        <Card className="border-border/60 shadow-sm">
                                            <CardHeader className="space-y-1">
                                                <CardTitle>Order Setup</CardTitle>
                                                <p className="text-sm text-muted-foreground">
                                                    Customer, payment, and fulfillment details in one place.
                                                </p>
                                            </CardHeader>
                                            <CardContent className="space-y-4">
                                                <div className="space-y-2">
                                                    <Label>{t('orders.form.customer') || 'Customer'}</Label>
                                                    <Select value={salesForm.customerId} onValueChange={(value) => {
                                                        const customer = customers.find((entry) => entry.id === value)
                                                        setSalesForm((current) => ({ ...current, customerId: value, currency: customer?.defaultCurrency || current.currency }))
                                                    }}>
                                                        <SelectTrigger><SelectValue placeholder={t('orders.form.selectCustomer') || 'Select Customer'} /></SelectTrigger>
                                                        <SelectContent>
                                                            {customers.map((customer) => (
                                                                <SelectItem key={customer.id} value={customer.id}>{customer.name}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                <div className="grid gap-4 sm:grid-cols-2">
                                                    <div className="space-y-2">
                                                        <Label htmlFor="sales-delivery" className="flex items-center gap-2">
                                                            <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                                            {t('orders.form.date') || 'Date'}
                                                        </Label>
                                                        <Input id="sales-delivery" type="date" value={salesForm.expectedDeliveryDate} onChange={(event) => setSalesForm((current) => ({ ...current, expectedDeliveryDate: event.target.value }))} />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <Label>{t('orders.form.currency') || 'Currency'}</Label>
                                                        <Input value={salesForm.currency.toUpperCase()} disabled />
                                                    </div>
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="sales-payment" className="flex items-center gap-2">
                                                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                                                        {t('pos.paymentMethod') || 'Payment Method'}
                                                    </Label>
                                                    <Select value={salesForm.paymentMethod} onValueChange={(value) => setSalesForm((current) => ({ ...current, paymentMethod: value }))}>
                                                        <SelectTrigger id="sales-payment"><SelectValue /></SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="credit">Credit</SelectItem>
                                                            <SelectItem value="cash">Cash</SelectItem>
                                                            <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                <div className="flex items-center justify-between rounded-2xl border bg-muted/20 px-4 py-3">
                                                    <div>
                                                        <div className="text-sm font-medium">Paid on save</div>
                                                        <div className="text-xs text-muted-foreground">Mark the order as already settled.</div>
                                                    </div>
                                                    <Switch checked={salesForm.isPaid} onCheckedChange={(checked) => setSalesForm((current) => ({ ...current, isPaid: checked }))} />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="sales-shipping" className="flex items-center gap-2">
                                                        <Truck className="h-4 w-4 text-muted-foreground" />
                                                        {t('orders.form.shippingAddress') || 'Shipping Address'}
                                                    </Label>
                                                    <Textarea id="sales-shipping" rows={3} value={salesForm.shippingAddress} onChange={(event) => setSalesForm((current) => ({ ...current, shippingAddress: event.target.value }))} placeholder={t('orders.form.shippingPlaceholder') || 'Enter shipping address...'} />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="sales-notes">{t('orders.form.notes') || 'Notes'}</Label>
                                                    <Textarea id="sales-notes" rows={3} value={salesForm.notes} onChange={(event) => setSalesForm((current) => ({ ...current, notes: event.target.value }))} />
                                                </div>
                                            </CardContent>
                                        </Card>

                                        <Card className="border-border/60 shadow-sm">
                                            <CardHeader className="space-y-1">
                                                <CardTitle>Commercials</CardTitle>
                                                <p className="text-sm text-muted-foreground">
                                                    Review pricing and settlement before saving the draft.
                                                </p>
                                            </CardHeader>
                                            <CardContent className="space-y-4">
                                                <div className="grid gap-4 sm:grid-cols-2">
                                                    <div className="space-y-2">
                                                        <Label htmlFor="sales-discount">{t('orders.form.discount') || 'Discount'}</Label>
                                                        <Input id="sales-discount" type="number" min="0" step="0.01" value={salesForm.discount} onChange={(event) => setSalesForm((current) => ({ ...current, discount: event.target.value }))} />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <Label htmlFor="sales-tax">{t('orders.form.tax') || 'Tax'}</Label>
                                                        <Input id="sales-tax" type="number" min="0" step="0.01" value={salesForm.tax} onChange={(event) => setSalesForm((current) => ({ ...current, tax: event.target.value }))} />
                                                    </div>
                                                </div>
                                                <div className="rounded-2xl border bg-muted/30 p-4">
                                                    <div className="flex items-center justify-between text-sm">
                                                        <span>Items configured</span>
                                                        <span className="font-semibold">{salesConfiguredItemsCount}</span>
                                                    </div>
                                                    <div className="mt-2 flex items-center justify-between text-sm">
                                                        <span>{t('pos.paymentMethod') || 'Payment Method'}</span>
                                                        <span className="font-medium">{getPaymentMethodLabel(salesForm.paymentMethod)}</span>
                                                    </div>
                                                    <div className="mt-2 flex items-center justify-between text-sm">
                                                        <span>{t('common.total') || 'Total'}</span>
                                                        <span className="text-xl font-black">{formatCurrency(salesPreview, salesForm.currency, features.iqd_display_preference)}</span>
                                                    </div>
                                                    <div className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
                                                        <Wallet className="mt-0.5 h-4 w-4" />
                                                        <span>{salesForm.isPaid ? 'This order will start as paid.' : 'This order will start as unpaid until payment is posted.'}</span>
                                                    </div>
                                                </div>
                                            </CardContent>
                                        </Card>
                                    </div>
                                </div>
                            </div>

                            <DialogFooter className="border-t bg-muted/20 px-4 py-4 pb-[calc(1rem+var(--safe-area-bottom))] sm:justify-between sm:px-6">
                                <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setDialogOpen(false)}>{t('common.cancel') || 'Cancel'}</Button>
                                <Button type="submit" className="w-full sm:w-auto" disabled={isSaving}>
                                    {isSaving ? (t('common.loading') || 'Loading...') : (editingSalesOrder ? (t('common.save') || 'Save') : (t('orders.form.saveOrder') || 'Save Order'))}
                                </Button>
                            </DialogFooter>
                        </form>
                    ) : (
                        <form onSubmit={handlePurchaseSubmit} className="flex min-h-0 flex-1 flex-col">
                            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
                                <div className="mb-6 grid gap-3 sm:grid-cols-3">
                                    <div className="rounded-2xl border bg-background/90 p-3 shadow-sm sm:p-4">
                                        <div className="flex items-start gap-3">
                                            <div className="rounded-xl bg-primary/10 p-2 text-primary">
                                                <Truck className="h-4 w-4" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                                                    {t('orders.form.supplier') || 'Supplier'}
                                                </p>
                                                <p className="truncate text-sm font-semibold">{selectedSupplierName}</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="rounded-2xl border bg-background/90 p-3 shadow-sm sm:p-4">
                                        <div className="flex items-start gap-3">
                                            <div className="rounded-xl bg-primary/10 p-2 text-primary">
                                                <Warehouse className="h-4 w-4" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                                                    {t('orders.form.destinationStorage', { defaultValue: 'Target Storage' })}
                                                </p>
                                                <p className="truncate text-sm font-semibold">{selectedPurchaseStorageName}</p>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="rounded-2xl border bg-background/90 p-3 shadow-sm sm:p-4">
                                        <div className="flex items-start gap-3">
                                            <div className="rounded-xl bg-primary/10 p-2 text-primary">
                                                <Wallet className="h-4 w-4" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
                                                    {t('common.total') || 'Total'}
                                                </p>
                                                <p className="truncate text-sm font-semibold">
                                                    {formatCurrency(purchasePreview, purchaseForm.currency, features.iqd_display_preference)}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.95fr)]">
                                    <Card className="border-border/60 shadow-sm">
                                        <CardHeader className="flex flex-col items-start justify-between gap-4 space-y-0 sm:flex-row">
                                            <div className="space-y-1">
                                                <CardTitle>{t('orders.form.addProducts') || 'Add Products'}</CardTitle>
                                                <p className="text-sm text-muted-foreground">
                                                    Pick the target storage inside each line so every received product lands in the right place.
                                                </p>
                                            </div>
                                            <Button type="button" variant="outline" size="sm" onClick={() => setPurchaseForm((current) => ({ ...current, items: [...current.items, createEmptyItem(current.items[current.items.length - 1]?.storageId || current.destinationStorageId || defaultStorageId)] }))}>
                                                <Plus className="mr-1 h-3.5 w-3.5" />
                                                {t('orders.form.addItem') || 'Add Item'}
                                            </Button>
                                        </CardHeader>
                                        <CardContent className="space-y-3">
                                            {purchaseForm.items.map((item, index) => {
                                                const product = products.find((entry) => entry.id === item.productId)
                                                const lineTotal = roundFormAmount((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0), purchaseForm.currency)

                                                return (
                                                    <div key={`purchase-item-${index}`} className="grid gap-3 rounded-2xl border bg-background p-4 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_110px_140px_40px]">
                                                        <div className="space-y-2">
                                                            <Label className="md:hidden">{t('orders.form.table.product') || 'Product'}</Label>
                                                            <Select value={item.productId} onValueChange={(value) => updatePurchaseItem(index, { productId: value })}>
                                                                <SelectTrigger><SelectValue placeholder={t('orders.form.selectProduct') || 'Select Product'} /></SelectTrigger>
                                                                <SelectContent>
                                                                    {products.map((productOption) => (
                                                                        <SelectItem key={productOption.id} value={productOption.id}>{productOption.name}</SelectItem>
                                                                    ))}
                                                                </SelectContent>
                                                            </Select>
                                                        </div>
                                                        <div className="space-y-2">
                                                            <Label className="md:hidden">{t('orders.form.destinationStorage', { defaultValue: 'Target Storage' })}</Label>
                                                            <Select value={item.storageId} onValueChange={(value) => updatePurchaseItem(index, { storageId: value })}>
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
                                                                {item.storageId
                                                                    ? `Will be received into ${getStorageDisplayName(item.storageId)} when the order is completed.`
                                                                    : 'Choose a target storage for this line.'}
                                                            </p>
                                                        </div>
                                                        <div className="space-y-2">
                                                            <Label className="md:hidden">{t('orders.form.table.qty') || 'Qty'}</Label>
                                                            <Input type="number" min="1" value={item.quantity} onChange={(event) => updatePurchaseItem(index, { quantity: event.target.value })} placeholder={t('common.quantity') || 'Quantity'} />
                                                        </div>
                                                        <div className="space-y-2">
                                                            <Label className="md:hidden">{t('orders.form.table.price') || 'Unit Price'}</Label>
                                                            <Input type="number" min="0" step="0.01" value={item.unitPrice} onChange={(event) => updatePurchaseItem(index, { unitPrice: event.target.value })} placeholder={t('common.price') || 'Price'} />
                                                        </div>
                                                        <div className="flex items-start justify-end">
                                                            <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => setPurchaseForm((current) => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))}>
                                                                <Trash2 className="h-4 w-4" />
                                                            </Button>
                                                        </div>
                                                        <div className="flex items-center justify-between text-xs text-muted-foreground md:col-span-5">
                                                            <span>{product?.sku ? `SKU: ${product.sku}` : '\u00A0'}</span>
                                                            <span>{(t('orders.form.table.total') || 'Total')}: {formatCurrency(lineTotal, purchaseForm.currency, features.iqd_display_preference)}</span>
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </CardContent>
                                    </Card>

                                    <div className="space-y-6">
                                        <Card className="border-border/60 shadow-sm">
                                            <CardHeader className="space-y-1">
                                                <CardTitle>Order Setup</CardTitle>
                                                <p className="text-sm text-muted-foreground">
                                                    Supplier, payment, and receiving notes in one place.
                                                </p>
                                            </CardHeader>
                                            <CardContent className="space-y-4">
                                                <div className="space-y-2">
                                                    <Label>{t('orders.form.supplier') || 'Supplier'}</Label>
                                                    <Select value={purchaseForm.supplierId} onValueChange={(value) => {
                                                        const supplier = suppliers.find((entry) => entry.id === value)
                                                        setPurchaseForm((current) => ({ ...current, supplierId: value, currency: supplier?.defaultCurrency || current.currency }))
                                                    }}>
                                                        <SelectTrigger><SelectValue placeholder={t('orders.form.selectSupplier') || 'Select Supplier'} /></SelectTrigger>
                                                        <SelectContent>
                                                            {suppliers.map((supplier) => (
                                                                <SelectItem key={supplier.id} value={supplier.id}>{supplier.name}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                <div className="grid gap-4 sm:grid-cols-2">
                                                    <div className="space-y-2">
                                                        <Label htmlFor="purchase-delivery" className="flex items-center gap-2">
                                                            <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                                            {t('orders.form.date') || 'Date'}
                                                        </Label>
                                                        <Input id="purchase-delivery" type="date" value={purchaseForm.expectedDeliveryDate} onChange={(event) => setPurchaseForm((current) => ({ ...current, expectedDeliveryDate: event.target.value }))} />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <Label>{t('orders.form.currency') || 'Currency'}</Label>
                                                        <Input value={purchaseForm.currency.toUpperCase()} disabled />
                                                    </div>
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="purchase-payment" className="flex items-center gap-2">
                                                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                                                        {t('pos.paymentMethod') || 'Payment Method'}
                                                    </Label>
                                                    <Select value={purchaseForm.paymentMethod} onValueChange={(value) => setPurchaseForm((current) => ({ ...current, paymentMethod: value }))}>
                                                        <SelectTrigger id="purchase-payment"><SelectValue /></SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="credit">Credit</SelectItem>
                                                            <SelectItem value="cash">Cash</SelectItem>
                                                            <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                <div className="flex items-center justify-between rounded-2xl border bg-muted/20 px-4 py-3">
                                                    <div>
                                                        <div className="text-sm font-medium">Paid on save</div>
                                                        <div className="text-xs text-muted-foreground">Record the order as already settled.</div>
                                                    </div>
                                                    <Switch checked={purchaseForm.isPaid} onCheckedChange={(checked) => setPurchaseForm((current) => ({ ...current, isPaid: checked }))} />
                                                </div>
                                                <div className="space-y-2">
                                                    <Label htmlFor="purchase-notes">{t('orders.form.notes') || 'Notes'}</Label>
                                                    <Textarea id="purchase-notes" rows={4} value={purchaseForm.notes} onChange={(event) => setPurchaseForm((current) => ({ ...current, notes: event.target.value }))} />
                                                </div>
                                            </CardContent>
                                        </Card>

                                        <Card className="border-border/60 shadow-sm">
                                            <CardHeader className="space-y-1">
                                                <CardTitle>Commercials</CardTitle>
                                                <p className="text-sm text-muted-foreground">
                                                    Review purchase totals and where incoming stock will land.
                                                </p>
                                            </CardHeader>
                                            <CardContent className="space-y-4">
                                                <div className="space-y-2">
                                                    <Label htmlFor="purchase-discount">{t('orders.form.discount') || 'Discount'}</Label>
                                                    <Input id="purchase-discount" type="number" min="0" step="0.01" value={purchaseForm.discount} onChange={(event) => setPurchaseForm((current) => ({ ...current, discount: event.target.value }))} />
                                                </div>
                                                <div className="rounded-2xl border bg-muted/30 p-4">
                                                    <div className="flex items-center justify-between text-sm">
                                                        <span>Items configured</span>
                                                        <span className="font-semibold">{purchaseConfiguredItemsCount}</span>
                                                    </div>
                                                    <div className="mt-2 flex items-center justify-between text-sm">
                                                        <span>{t('pos.paymentMethod') || 'Payment Method'}</span>
                                                        <span className="font-medium">{getPaymentMethodLabel(purchaseForm.paymentMethod)}</span>
                                                    </div>
                                                    <div className="mt-2 flex items-center justify-between text-sm">
                                                        <span>{t('common.total') || 'Total'}</span>
                                                        <span className="text-xl font-black">{formatCurrency(purchasePreview, purchaseForm.currency, features.iqd_display_preference)}</span>
                                                    </div>
                                                    <div className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
                                                        <PackagePlus className="mt-0.5 h-4 w-4" />
                                                        <span>{`Completing this order will add stock to ${selectedPurchaseStorageName}.`}</span>
                                                    </div>
                                                </div>
                                            </CardContent>
                                        </Card>
                                    </div>
                                </div>
                            </div>

                            <DialogFooter className="border-t bg-muted/20 px-4 py-4 pb-[calc(1rem+var(--safe-area-bottom))] sm:justify-between sm:px-6">
                                <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setDialogOpen(false)}>{t('common.cancel') || 'Cancel'}</Button>
                                <Button type="submit" className="w-full sm:w-auto" disabled={isSaving}>
                                    {isSaving ? (t('common.loading') || 'Loading...') : (editingPurchaseOrder ? (t('common.save') || 'Save') : (t('orders.form.saveOrder') || 'Save Order'))}
                                </Button>
                            </DialogFooter>
                        </form>
                    )}
                </DialogContent>
            </Dialog>

            <DeleteConfirmationModal
                isOpen={!!deleteTarget}
                onClose={() => setDeleteTarget(null)}
                onConfirm={handleDeleteConfirm}
                itemName={deleteTarget?.order.orderNumber}
                title={t('orders.confirmDelete') || 'Delete Order'}
                description={t('orders.deleteWarning') || 'This will permanently remove the order record. Associated invoices should be checked.'}
            />

            <Dialog open={lockConfirm.isOpen} onOpenChange={(open) => !open && setLockConfirm({ isOpen: false, orderId: '', type: null })}>
                <DialogContent className="max-w-[400px] rounded-3xl p-0 overflow-hidden border-none shadow-2xl">
                    <div className="bg-gradient-to-b from-amber-500/10 to-transparent p-8 text-center space-y-4">
                        <div className="mx-auto w-16 h-16 bg-amber-500/20 rounded-2xl flex items-center justify-center mb-2">
                            <Lock className="w-8 h-8 text-amber-600" />
                        </div>
                        <DialogHeader>
                            <DialogTitle className="text-2xl font-black text-center">{t('orders.lockTitle') || 'Lock Order?'}</DialogTitle>
                        </DialogHeader>
                        <p className="text-muted-foreground text-sm font-medium leading-relaxed">
                            {t('orders.lockDescription') || 'Locking this order will prevent any changes to its payment status. This action cannot be undone.'}
                        </p>
                    </div>
                    <DialogFooter className="p-6 pt-2 grid grid-cols-2 gap-3 sm:justify-start">
                        <Button
                            variant="outline"
                            className="rounded-xl h-12 font-bold border-2"
                            onClick={() => setLockConfirm({ isOpen: false, orderId: '', type: null })}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button
                            className="rounded-xl h-12 font-bold bg-amber-600 hover:bg-amber-700 shadow-lg shadow-amber-600/20"
                            onClick={handleLockConfirm}
                        >
                            {t('orders.actions.lock') || 'Lock Now'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

export function Orders() {
    const { user } = useAuth()
    const [detailMatch, params] = useRoute('/orders/:orderId')
    const workspaceId = user?.workspaceId

    if (!workspaceId) {
        return null
    }

    if (detailMatch && params?.orderId) {
        return <OrderDetailsView workspaceId={workspaceId} orderId={params.orderId} />
    }

    return <OrdersListView workspaceId={workspaceId} />
}
