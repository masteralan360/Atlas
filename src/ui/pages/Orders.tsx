import { useMemo, useState, type FormEvent } from 'react'
import { PackagePlus, Pencil, Plus, Search, ShoppingCart, Trash2, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/auth'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { buildOrderExchangeRatesSnapshot, convertCurrencyAmountWithLiveRates, getPrimaryExchangeDetails } from '@/lib/orderCurrency'
import { formatCurrency } from '@/lib/utils'
import {
    createPurchaseOrder,
    createSalesOrder,
    deletePurchaseOrder,
    deleteSalesOrder,
    setPurchaseOrderPaymentStatus,
    setSalesOrderPaymentStatus,
    updatePurchaseOrder,
    updatePurchaseOrderStatus,
    updateSalesOrder,
    updateSalesOrderStatus,
    useCustomers,
    useProducts,
    usePurchaseOrders,
    useSalesOrders,
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
import { OrderStatusBadge } from '@/ui/components/orders/OrderStatusBadge'

type OrderTab = 'sales' | 'purchase'

type FormItem = {
    productId: string
    quantity: string
    unitPrice: string
}

type SalesFormState = {
    customerId: string
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

const emptyItem: FormItem = {
    productId: '',
    quantity: '1',
    unitPrice: ''
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

export function Orders() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const { toast } = useToast()
    const products = useProducts(user?.workspaceId)
    const customers = useCustomers(user?.workspaceId)
    const suppliers = useSuppliers(user?.workspaceId)
    const salesOrders = useSalesOrders(user?.workspaceId)
    const purchaseOrders = usePurchaseOrders(user?.workspaceId)

    const [activeTab, setActiveTab] = useState<OrderTab>('sales')
    const [search, setSearch] = useState('')
    const [dialogOpen, setDialogOpen] = useState(false)
    const [editingSalesOrder, setEditingSalesOrder] = useState<SalesOrder | null>(null)
    const [editingPurchaseOrder, setEditingPurchaseOrder] = useState<PurchaseOrder | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
    const [isSaving, setIsSaving] = useState(false)

    const [salesForm, setSalesForm] = useState<SalesFormState>({
        customerId: '',
        currency: features.default_currency,
        shippingAddress: '',
        expectedDeliveryDate: '',
        discount: '',
        tax: '',
        notes: '',
        isPaid: false,
        paymentMethod: 'credit',
        items: [{ ...emptyItem }]
    })

    const [purchaseForm, setPurchaseForm] = useState<PurchaseFormState>({
        supplierId: '',
        currency: features.default_currency,
        expectedDeliveryDate: '',
        discount: '',
        notes: '',
        isPaid: false,
        paymentMethod: 'credit',
        items: [{ ...emptyItem }]
    })

    const liveRates = useMemo(() => ({
        exchangeData,
        eurRates,
        tryRates
    }), [exchangeData, eurRates, tryRates])

    const canManageOrders = user?.role === 'admin' || user?.role === 'staff'
    const canDeleteOrders = user?.role === 'admin'

    const filteredSalesOrders = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) return salesOrders
        return salesOrders.filter((order) =>
            order.orderNumber.toLowerCase().includes(query)
            || order.customerName.toLowerCase().includes(query)
            || order.items.some((item) => item.productName.toLowerCase().includes(query))
        )
    }, [salesOrders, search])

    const filteredPurchaseOrders = useMemo(() => {
        const query = search.trim().toLowerCase()
        if (!query) return purchaseOrders
        return purchaseOrders.filter((order) =>
            order.orderNumber.toLowerCase().includes(query)
            || order.supplierName.toLowerCase().includes(query)
            || order.items.some((item) => item.productName.toLowerCase().includes(query))
        )
    }, [purchaseOrders, search])

    const salesPreview = useMemo(() => {
        const subtotal = salesForm.items.reduce((sum, item) => sum + ((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0)), 0)
        const total = subtotal - Number(salesForm.discount || 0) + Number(salesForm.tax || 0)
        return roundFormAmount(total, salesForm.currency)
    }, [salesForm.currency, salesForm.discount, salesForm.items, salesForm.tax])

    const purchasePreview = useMemo(() => {
        const subtotal = purchaseForm.items.reduce((sum, item) => sum + ((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0)), 0)
        const total = subtotal - Number(purchaseForm.discount || 0)
        return roundFormAmount(total, purchaseForm.currency)
    }, [purchaseForm.currency, purchaseForm.discount, purchaseForm.items])

    function resetSalesForm(customerId?: string) {
        const customer = customerId ? customers.find((entry) => entry.id === customerId) : undefined
        setEditingSalesOrder(null)
        setSalesForm({
            customerId: customerId || '',
            currency: customer?.defaultCurrency || features.default_currency,
            shippingAddress: '',
            expectedDeliveryDate: '',
            discount: '',
            tax: '',
            notes: '',
            isPaid: false,
            paymentMethod: 'credit',
            items: [{ ...emptyItem }]
        })
    }

    function resetPurchaseForm(supplierId?: string) {
        const supplier = supplierId ? suppliers.find((entry) => entry.id === supplierId) : undefined
        setEditingPurchaseOrder(null)
        setPurchaseForm({
            supplierId: supplierId || '',
            currency: supplier?.defaultCurrency || features.default_currency,
            expectedDeliveryDate: '',
            discount: '',
            notes: '',
            isPaid: false,
            paymentMethod: 'credit',
            items: [{ ...emptyItem }]
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
            currency: order.currency,
            expectedDeliveryDate: order.expectedDeliveryDate ? order.expectedDeliveryDate.slice(0, 10) : '',
            discount: order.discount ? String(order.discount) : '',
            notes: order.notes || '',
            isPaid: order.isPaid,
            paymentMethod: order.paymentMethod || 'credit',
            items: order.items.map((item) => ({
                productId: item.productId,
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

                const quantity = Number(item.quantity)
                const unitPrice = Number(item.unitPrice || 0)
                return {
                    id: `${product.id}-${quantity}-${unitPrice}`,
                    productId: product.id,
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

                const quantity = Number(item.quantity)
                const unitPrice = Number(item.unitPrice || 0)
                return {
                    id: `${product.id}-${quantity}-${unitPrice}`,
                    productId: product.id,
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

            const subtotal = roundFormAmount(items.reduce((sum, item) => sum + item.lineTotal, 0), salesForm.currency)
            const discount = roundFormAmount(Number(salesForm.discount || 0), salesForm.currency)
            const tax = roundFormAmount(Number(salesForm.tax || 0), salesForm.currency)
            const total = roundFormAmount(subtotal - discount + tax, salesForm.currency)
            const primaryRate = getPrimaryExchangeDetails(salesForm.currency, features.default_currency, snapshot)

            const payload = {
                customerId: customer.id,
                customerName: customer.name,
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

            const subtotal = roundFormAmount(items.reduce((sum, item) => sum + item.lineTotal, 0), purchaseForm.currency)
            const discount = roundFormAmount(Number(purchaseForm.discount || 0), purchaseForm.currency)
            const total = roundFormAmount(subtotal - discount, purchaseForm.currency)
            const primaryRate = getPrimaryExchangeDetails(purchaseForm.currency, features.default_currency, snapshot)

            const payload = {
                supplierId: supplier.id,
                supplierName: supplier.name,
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
                                        <span className={row.isPaid ? 'font-semibold text-emerald-600' : 'text-amber-600'}>
                                            {row.isPaid ? (t('budget.status.paid') || 'Paid') : (t('budget.status.pending') || 'Pending')}
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex flex-wrap justify-end gap-2">
                                            {activeTab === 'sales' ? (
                                                <>
                                                    {canEdit && <Button variant="outline" size="sm" onClick={() => openSalesEdit(row as SalesOrder)}><Pencil className="mr-1 h-3.5 w-3.5" />{t('common.edit') || 'Edit'}</Button>}
                                                    {canManageOrders && row.status === 'draft' && <Button size="sm" onClick={() => runAction(() => updateSalesOrderStatus(row.id, 'pending'), 'Sales order reserved')}>Reserve</Button>}
                                                    {canManageOrders && row.status === 'pending' && <Button size="sm" onClick={() => runAction(() => updateSalesOrderStatus(row.id, 'completed'), 'Sales order completed')}>Complete</Button>}
                                                    {canManageOrders && row.status === 'pending' && <Button variant="outline" size="sm" onClick={() => runAction(() => updateSalesOrderStatus(row.id, 'cancelled'), 'Sales order cancelled')}>Cancel</Button>}
                                                    {canManageOrders && <Button variant="outline" size="sm" onClick={() => runAction(() => setSalesOrderPaymentStatus(row.id, { isPaid: !row.isPaid, paymentMethod: (row.paymentMethod || 'cash') as SalesOrder['paymentMethod'] }), row.isPaid ? 'Marked unpaid' : 'Marked paid')}>{row.isPaid ? 'Unpay' : 'Pay'}</Button>}
                                                    {canDelete && <Button variant="ghost" size="icon" className="text-destructive" onClick={() => setDeleteTarget({ type: 'sales', order: row as SalesOrder })}><Trash2 className="h-4 w-4" /></Button>}
                                                </>
                                            ) : (
                                                <>
                                                    {canEdit && <Button variant="outline" size="sm" onClick={() => openPurchaseEdit(row as PurchaseOrder)}><Pencil className="mr-1 h-3.5 w-3.5" />{t('common.edit') || 'Edit'}</Button>}
                                                    {canManageOrders && row.status === 'draft' && <Button size="sm" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'ordered'), 'Purchase order sent')}>Order</Button>}
                                                    {canManageOrders && row.status === 'ordered' && <Button size="sm" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'received'), 'Purchase order received')}>Receive</Button>}
                                                    {canManageOrders && row.status === 'received' && <Button size="sm" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'completed'), 'Purchase order completed')}>Complete</Button>}
                                                    {canManageOrders && (row.status === 'draft' || row.status === 'ordered') && <Button variant="outline" size="sm" onClick={() => runAction(() => updatePurchaseOrderStatus(row.id, 'cancelled'), 'Purchase order cancelled')}>Cancel</Button>}
                                                    {canManageOrders && <Button variant="outline" size="sm" onClick={() => runAction(() => setPurchaseOrderPaymentStatus(row.id, { isPaid: !row.isPaid, paymentMethod: (row.paymentMethod || 'cash') as PurchaseOrder['paymentMethod'] }), row.isPaid ? 'Marked unpaid' : 'Marked paid')}>{row.isPaid ? 'Unpay' : 'Pay'}</Button>}
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
                            <TabsList>
                                <TabsTrigger value="sales">{t('orders.tabs.sales') || 'Sales Orders'}</TabsTrigger>
                                <TabsTrigger value="purchase">{t('orders.tabs.purchase') || 'Purchase Orders'}</TabsTrigger>
                            </TabsList>
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
                        </div>
                        <TabsContent value="sales" className="mt-6">
                            {salesDisabled && (
                                <div className="mb-4 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                                    {customers.length === 0 ? (t('orders.noCustomers') || 'Add customers before creating orders.') : 'Add products before creating orders.'}
                                </div>
                            )}
                            {renderOrderTable()}
                        </TabsContent>
                        <TabsContent value="purchase" className="mt-6">
                            {purchaseDisabled && (
                                <div className="mb-4 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                                    {suppliers.length === 0 ? 'Add suppliers before creating purchase orders.' : 'Add products before creating purchase orders.'}
                                </div>
                            )}
                            {renderOrderTable()}
                        </TabsContent>
                    </Tabs>
                </CardHeader>
            </Card>

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="max-w-4xl">
                    <DialogHeader>
                        <DialogTitle>
                            {activeTab === 'sales'
                                ? (editingSalesOrder ? (t('orders.form.editSalesOrder') || 'Edit Sales Order') : (t('orders.form.newSalesOrder') || 'New Sales Order'))
                                : (editingPurchaseOrder ? (t('orders.form.editPurchaseOrder') || 'Edit Purchase Order') : (t('orders.form.newPurchaseOrder') || 'New Purchase Order'))}
                        </DialogTitle>
                    </DialogHeader>

                    {activeTab === 'sales' ? (
                        <form onSubmit={handleSalesSubmit} className="space-y-6">
                            <div className="grid gap-4 md:grid-cols-2">
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
                                <div className="space-y-2">
                                    <Label>{t('orders.form.currency') || 'Currency'}</Label>
                                    <Input value={salesForm.currency.toUpperCase()} disabled />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="sales-delivery">{t('orders.form.date') || 'Date'}</Label>
                                    <Input id="sales-delivery" type="date" value={salesForm.expectedDeliveryDate} onChange={(event) => setSalesForm((current) => ({ ...current, expectedDeliveryDate: event.target.value }))} />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="sales-payment">{t('pos.paymentMethod') || 'Payment Method'}</Label>
                                    <Select value={salesForm.paymentMethod} onValueChange={(value) => setSalesForm((current) => ({ ...current, paymentMethod: value }))}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="credit">Credit</SelectItem>
                                            <SelectItem value="cash">Cash</SelectItem>
                                            <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="flex items-center justify-between rounded-xl border px-3 py-2">
                                    <div>
                                        <div className="text-sm font-medium">Paid on save</div>
                                        <div className="text-xs text-muted-foreground">Mark the draft as already paid.</div>
                                    </div>
                                    <Switch checked={salesForm.isPaid} onCheckedChange={(checked) => setSalesForm((current) => ({ ...current, isPaid: checked }))} />
                                </div>
                            </div>

                            <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="font-semibold">{t('orders.form.addProducts') || 'Add Products'}</h3>
                                    <Button type="button" variant="outline" size="sm" onClick={() => setSalesForm((current) => ({ ...current, items: [...current.items, { ...emptyItem }] }))}>
                                        <Plus className="mr-1 h-3.5 w-3.5" />
                                        {t('orders.form.addItem') || 'Add Item'}
                                    </Button>
                                </div>
                                <div className="space-y-3">
                                    {salesForm.items.map((item, index) => (
                                        <div key={`sales-item-${index}`} className="grid gap-3 rounded-xl border p-3 md:grid-cols-[1.7fr,0.7fr,0.8fr,auto]">
                                            <Select value={item.productId} onValueChange={(value) => updateSalesItem(index, { productId: value })}>
                                                <SelectTrigger><SelectValue placeholder={t('orders.form.selectProduct') || 'Select Product'} /></SelectTrigger>
                                                <SelectContent>
                                                    {products.map((product) => (
                                                        <SelectItem key={product.id} value={product.id}>{product.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Input type="number" min="1" value={item.quantity} onChange={(event) => updateSalesItem(index, { quantity: event.target.value })} placeholder={t('common.quantity') || 'Quantity'} />
                                            <Input type="number" min="0" step="0.01" value={item.unitPrice} onChange={(event) => updateSalesItem(index, { unitPrice: event.target.value })} placeholder={t('common.price') || 'Price'} />
                                            <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => setSalesForm((current) => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="sales-discount">{t('orders.form.discount') || 'Discount'}</Label>
                                    <Input id="sales-discount" type="number" min="0" step="0.01" value={salesForm.discount} onChange={(event) => setSalesForm((current) => ({ ...current, discount: event.target.value }))} />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="sales-tax">{t('orders.form.tax') || 'Tax'}</Label>
                                    <Input id="sales-tax" type="number" min="0" step="0.01" value={salesForm.tax} onChange={(event) => setSalesForm((current) => ({ ...current, tax: event.target.value }))} />
                                </div>
                                <div className="space-y-2 md:col-span-2">
                                    <Label htmlFor="sales-shipping">{t('orders.form.shippingAddress') || 'Shipping Address'}</Label>
                                    <Input id="sales-shipping" value={salesForm.shippingAddress} onChange={(event) => setSalesForm((current) => ({ ...current, shippingAddress: event.target.value }))} />
                                </div>
                                <div className="space-y-2 md:col-span-2">
                                    <Label htmlFor="sales-notes">{t('orders.form.notes') || 'Notes'}</Label>
                                    <Textarea id="sales-notes" rows={4} value={salesForm.notes} onChange={(event) => setSalesForm((current) => ({ ...current, notes: event.target.value }))} />
                                </div>
                            </div>

                            <div className="rounded-xl border bg-muted/40 p-4">
                                <div className="flex items-center justify-between text-sm">
                                    <span>{t('common.total') || 'Total'}</span>
                                    <span className="text-xl font-black">{formatCurrency(salesPreview, salesForm.currency, features.iqd_display_preference)}</span>
                                </div>
                                <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                                    <Wallet className="h-4 w-4" />
                                    {salesForm.isPaid ? 'This order starts as paid.' : 'This order starts as unpaid and will count against customer credit when reserved.'}
                                </div>
                            </div>

                            <DialogFooter>
                                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel') || 'Cancel'}</Button>
                                <Button type="submit" disabled={isSaving}>
                                    {isSaving ? (t('common.loading') || 'Loading...') : (editingSalesOrder ? (t('common.save') || 'Save') : (t('orders.form.saveOrder') || 'Save Order'))}
                                </Button>
                            </DialogFooter>
                        </form>
                    ) : (
                        <form onSubmit={handlePurchaseSubmit} className="space-y-6">
                            <div className="grid gap-4 md:grid-cols-2">
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
                                <div className="space-y-2">
                                    <Label>{t('orders.form.currency') || 'Currency'}</Label>
                                    <Input value={purchaseForm.currency.toUpperCase()} disabled />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="purchase-delivery">{t('orders.form.date') || 'Date'}</Label>
                                    <Input id="purchase-delivery" type="date" value={purchaseForm.expectedDeliveryDate} onChange={(event) => setPurchaseForm((current) => ({ ...current, expectedDeliveryDate: event.target.value }))} />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="purchase-payment">{t('pos.paymentMethod') || 'Payment Method'}</Label>
                                    <Select value={purchaseForm.paymentMethod} onValueChange={(value) => setPurchaseForm((current) => ({ ...current, paymentMethod: value }))}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="credit">Credit</SelectItem>
                                            <SelectItem value="cash">Cash</SelectItem>
                                            <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="flex items-center justify-between rounded-xl border px-3 py-2">
                                    <div>
                                        <div className="text-sm font-medium">Paid on save</div>
                                        <div className="text-xs text-muted-foreground">Record the draft as already settled.</div>
                                    </div>
                                    <Switch checked={purchaseForm.isPaid} onCheckedChange={(checked) => setPurchaseForm((current) => ({ ...current, isPaid: checked }))} />
                                </div>
                            </div>

                            <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <h3 className="font-semibold">{t('orders.form.addProducts') || 'Add Products'}</h3>
                                    <Button type="button" variant="outline" size="sm" onClick={() => setPurchaseForm((current) => ({ ...current, items: [...current.items, { ...emptyItem }] }))}>
                                        <Plus className="mr-1 h-3.5 w-3.5" />
                                        {t('orders.form.addItem') || 'Add Item'}
                                    </Button>
                                </div>
                                <div className="space-y-3">
                                    {purchaseForm.items.map((item, index) => (
                                        <div key={`purchase-item-${index}`} className="grid gap-3 rounded-xl border p-3 md:grid-cols-[1.7fr,0.7fr,0.8fr,auto]">
                                            <Select value={item.productId} onValueChange={(value) => updatePurchaseItem(index, { productId: value })}>
                                                <SelectTrigger><SelectValue placeholder={t('orders.form.selectProduct') || 'Select Product'} /></SelectTrigger>
                                                <SelectContent>
                                                    {products.map((product) => (
                                                        <SelectItem key={product.id} value={product.id}>{product.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Input type="number" min="1" value={item.quantity} onChange={(event) => updatePurchaseItem(index, { quantity: event.target.value })} placeholder={t('common.quantity') || 'Quantity'} />
                                            <Input type="number" min="0" step="0.01" value={item.unitPrice} onChange={(event) => updatePurchaseItem(index, { unitPrice: event.target.value })} placeholder={t('common.price') || 'Price'} />
                                            <Button type="button" variant="ghost" size="icon" className="text-destructive" onClick={() => setPurchaseForm((current) => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="purchase-discount">{t('orders.form.discount') || 'Discount'}</Label>
                                    <Input id="purchase-discount" type="number" min="0" step="0.01" value={purchaseForm.discount} onChange={(event) => setPurchaseForm((current) => ({ ...current, discount: event.target.value }))} />
                                </div>
                                <div className="space-y-2 md:col-span-2">
                                    <Label htmlFor="purchase-notes">{t('orders.form.notes') || 'Notes'}</Label>
                                    <Textarea id="purchase-notes" rows={4} value={purchaseForm.notes} onChange={(event) => setPurchaseForm((current) => ({ ...current, notes: event.target.value }))} />
                                </div>
                            </div>

                            <div className="rounded-xl border bg-muted/40 p-4">
                                <div className="flex items-center justify-between text-sm">
                                    <span>{t('common.total') || 'Total'}</span>
                                    <span className="text-xl font-black">{formatCurrency(purchasePreview, purchaseForm.currency, features.iqd_display_preference)}</span>
                                </div>
                                <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                                    <PackagePlus className="h-4 w-4" />
                                    Received purchase orders update stock and weighted average cost immediately.
                                </div>
                            </div>

                            <DialogFooter>
                                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel') || 'Cancel'}</Button>
                                <Button type="submit" disabled={isSaving}>
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
        </div>
    )
}
