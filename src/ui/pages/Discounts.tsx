import { useCallback, useMemo, useState } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useTranslation } from 'react-i18next'
import { Pencil, Percent, Plus, Shapes, Trash2 } from 'lucide-react'

import { useAuth } from '@/auth'
import {
    createCategoryDiscount,
    createProductDiscount,
    type Category,
    deleteCategoryDiscount,
    deleteProductDiscount,
    type CategoryDiscount,
    type CurrencyCode,
    type DiscountType,
    type Product,
    type ProductDiscount,
    type PriceBook,
    type PriceBookItem,
    updateCategoryDiscount,
    updateProductDiscount,
    useCategories,
    useCategoryDiscounts,
    useInventory,
    usePriceBookCatalogState,
    useProducts,
    useProductDiscounts,
    type ProductDiscountPriceScope
} from '@/local-db'
import { buildInventoryTotalsByProduct, computeDiscountPrice, getDiscountStatus, type DiscountLifecycleStatus } from '@/lib/discounts'
import { cn, formatCurrency, formatDateTime } from '@/lib/utils'
import { useWorkspace } from '@/workspace'
import { ProductAutocompleteInput } from '@/ui/components/orders/ProductAutocompleteInput'
import { ProductsViewModal, ProductsViewModalTrigger } from '@/ui/components/ProductsViewModal'
import {
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Checkbox,
    DeleteConfirmationModal,
    Dialog,
    DialogContent,
    DialogDescription,
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
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    NumericInput,
    DateTimePicker,
    useToast
} from '@/ui/components'

type DiscountTab = 'products' | 'categories'
type DiscountEntity = ProductDiscount | CategoryDiscount

type DiscountFormState = {
    targetId: string
    discountType: DiscountType
    discountValue: string
    priceScope: ProductDiscountPriceScope
    priceBookIds: string[]
    startsAt: Date | undefined
    endsAt: Date | undefined
    minStockThreshold: string
    isActive: boolean
}

type ProductDiscountRow = {
    discount: ProductDiscount
    product?: Product
    stockTotal: number
    status: DiscountLifecycleStatus
}

type CategoryDiscountRow = {
    discount: CategoryDiscount
    category?: Category
    categoryProducts: Product[]
    status: DiscountLifecycleStatus
}

type TargetOption = {
    id: string
    label: string
    meta: string
}

type ProductDiscountPricePreview = {
    priceBookId: string | null
    usesNativePrice: boolean
    basePrice: number
    discountPrice: number
    currency: CurrencyCode
}

type ProductDiscountPricePreviewInput = {
    priceScope?: ProductDiscountPriceScope
    priceBookIds?: string[]
    discountType: DiscountType
    discountValue: number
    discountCurrency?: CurrencyCode | null
}

type PriceTransitionProps = {
    from: number
    to: number
    currency: CurrencyCode
    iqdPreference: 'IQD' | 'د.ع'
    className?: string
    arrowClassName?: string
}

function PriceTransition({ from, to, currency, iqdPreference, className, arrowClassName }: PriceTransitionProps) {
    return (
        <span dir="ltr" className={cn('inline-flex items-center whitespace-nowrap', className)}>
            <bdi>{formatCurrency(from, currency, iqdPreference)}</bdi>
            <span aria-hidden="true" className={cn('px-1', arrowClassName)}>→</span>
            <bdi>{formatCurrency(to, currency, iqdPreference)}</bdi>
        </span>
    )
}

function getProductDiscountPricePreviews(
    product: Product,
    discount: ProductDiscountPricePreviewInput,
    priceBooks: PriceBook[],
    priceBookItems: PriceBookItem[]
): ProductDiscountPricePreview[] {
    const scope = discount.priceScope ?? 'all'
    const previews: ProductDiscountPricePreview[] = []
    const addPreview = (priceBookId: string | null, basePrice: number, currency: CurrencyCode, usesNativePrice: boolean) => {
        if (discount.discountType === 'fixed_amount' && discount.discountCurrency && discount.discountCurrency !== currency) {
            return
        }

        previews.push({
            priceBookId,
            usesNativePrice,
            basePrice,
            discountPrice: computeDiscountPrice(basePrice, discount.discountType, discount.discountValue),
            currency
        })
    }

    if (scope === 'all' || scope === 'native_only') {
        addPreview(null, product.price, product.currency, true)
    }

    const scopedPriceBooks = scope === 'specific_price_books'
        ? priceBooks.filter((priceBook) => discount.priceBookIds?.includes(priceBook.id))
        : scope === 'all'
            ? priceBooks
            : []

    for (const priceBook of scopedPriceBooks) {
        const priceBookItem = priceBookItems.find((item) => (
            !item.isDeleted
            && item.priceBookId === priceBook.id
            && item.productId === product.id
        ))

        // A Price Book without an item falls back to the native product price.
        // It is useful to show that fallback only when the rule explicitly targets it.
        if (!priceBookItem && scope !== 'specific_price_books') {
            continue
        }

        addPreview(
            priceBook.id,
            priceBookItem?.price ?? product.price,
            priceBookItem?.currency ?? product.currency,
            !priceBookItem
        )
    }

    return previews
}

function getDaysUntilDateTime(value?: string | Date | null) {
    if (!value) {
        return null
    }

    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
        return null
    }

    return Math.ceil((parsed.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
}

function buildDefaultForm(): DiscountFormState {
    const now = new Date()
    const endsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

    return {
        targetId: '',
        discountType: 'fixed_amount',
        discountValue: '',
        priceScope: 'all',
        priceBookIds: [],
        startsAt: now,
        endsAt: endsAt,
        minStockThreshold: '',
        isActive: true
    }
}

function formatDiscountLabel(
    discountType: DiscountType,
    discountValue: number,
    currency: CurrencyCode,
    iqdPreference: 'IQD' | 'د.ع'
) {
    if (discountType === 'percentage') {
        return `-${Number(discountValue)}%`
    }

    return `-${formatCurrency(discountValue, currency, iqdPreference as any)}`
}

function statusBadgeClass(status: DiscountLifecycleStatus) {
    switch (status) {
        case 'active':
            return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        case 'scheduled':
            return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300'
        case 'expired':
            return 'border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300'
        case 'stock_paused':
            return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
        default:
            return 'border-muted-foreground/20 bg-muted text-muted-foreground'
    }
}

function getStatusLabel(status: DiscountLifecycleStatus, t: (key: string, options?: Record<string, unknown>) => string) {
    switch (status) {
        case 'active':
            return t('discounts.status.active')
        case 'scheduled':
            return t('discounts.status.scheduled')
        case 'expired':
            return t('discounts.status.expired')
        case 'stock_paused':
            return t('discounts.status.stockPaused')
        default:
            return t('discounts.status.inactive')
    }
}

function pluralizeProducts(count: number, t: (key: string, options?: Record<string, unknown>) => string) {
    return t('discounts.productsCount', { count })
}

function getCategoryDiscountLifecycleStatus(
    discount: Pick<CategoryDiscount, 'startsAt' | 'endsAt' | 'isActive' | 'minStockThreshold'>,
    categoryProducts: Product[],
    inventoryTotals: Map<string, number>,
    now = new Date()
): DiscountLifecycleStatus {
    if (!discount.isActive) {
        return 'inactive'
    }

    const startsAt = new Date(discount.startsAt)
    const endsAt = new Date(discount.endsAt)
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
        return 'inactive'
    }

    if (startsAt.getTime() > now.getTime()) {
        return 'scheduled'
    }

    if (endsAt.getTime() < now.getTime()) {
        return 'expired'
    }

    if (typeof discount.minStockThreshold === 'number') {
        const hasEligibleStock = categoryProducts.some((product) => (inventoryTotals.get(product.id) ?? 0) >= discount.minStockThreshold!)
        if (!hasEligibleStock) {
            return 'stock_paused'
        }
    }

    return 'active'
}

export function Discounts() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { toast } = useToast()
    const { features, hasCapability } = useWorkspace()
    const iqdPreference = features.iqd_display_preference as any
    const products = useProducts(user?.workspaceId)
    const categories = useCategories(user?.workspaceId)
    const inventory = useInventory(user?.workspaceId)
    const productDiscounts = useProductDiscounts(user?.workspaceId)
    const categoryDiscounts = useCategoryDiscounts(user?.workspaceId)

    const workspaceId = user?.workspaceId
    const priceBooksEnabled = hasCapability('priceBooks')
    const { priceBooks, priceBookItems } = usePriceBookCatalogState(
        priceBooksEnabled ? workspaceId : undefined,
        { enabled: priceBooksEnabled }
    )
    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'
    const [activeTab, setActiveTab] = useState<DiscountTab>('products')
    const [search, setSearch] = useState('')
    const [targetSearch, setTargetSearch] = useState('')
    const [productSearch, setProductSearch] = useState('')
    const [productsViewOpen, setProductsViewOpen] = useState(false)
    const [dialogOpen, setDialogOpen] = useState(false)
    const [editingDiscount, setEditingDiscount] = useState<DiscountEntity | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string; type: DiscountTab } | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
    const [form, setForm] = useState<DiscountFormState>(() => buildDefaultForm())

    const inventoryTotals = useMemo(() => buildInventoryTotalsByProduct(inventory), [inventory])
    const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products])
    const categoriesById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories])
    const productsByCategory = useMemo(() => {
        const map = new Map<string, typeof products>()
        for (const product of products) {
            if (!product.categoryId) {
                continue
            }

            const existing = map.get(product.categoryId) ?? []
            existing.push(product)
            map.set(product.categoryId, existing)
        }
        return map
    }, [products])

    const activeProductTargetIds = useMemo<Set<string>>(() => {
        return new Set(
            productDiscounts
                .filter((discount: ProductDiscount) => discount.isActive && !discount.isDeleted)
                .map((discount: ProductDiscount) => discount.productId)
        )
    }, [productDiscounts])

    const activeCategoryTargetIds = useMemo<Set<string>>(() => {
        return new Set(
            categoryDiscounts
                .filter((discount: CategoryDiscount) => discount.isActive && !discount.isDeleted)
                .map((discount: CategoryDiscount) => discount.categoryId)
        )
    }, [categoryDiscounts])

    const productRows = useMemo<ProductDiscountRow[]>(() => {
        const query = search.trim().toLowerCase()

        return productDiscounts
            .filter((discount: ProductDiscount) => !discount.isDeleted)
            .map((discount: ProductDiscount) => {
                const product = productsById.get(discount.productId)
                const stockTotal = inventoryTotals.get(discount.productId) ?? 0
                const status = getDiscountStatus(discount, stockTotal)

                return {
                    discount,
                    product,
                    stockTotal,
                    status
                }
            })
            .filter((row: ProductDiscountRow) => {
                if (!query) {
                    return true
                }

                const haystack = [
                    row.product?.name,
                    row.product?.sku,
                    row.product?.category,
                    row.discount.discountType
                ]
                    .filter((value): value is string => !!value)
                    .join(' ')
                    .toLowerCase()

                return haystack.includes(query)
            })
            .sort((left: ProductDiscountRow, right: ProductDiscountRow) => right.discount.updatedAt.localeCompare(left.discount.updatedAt))
    }, [inventoryTotals, productDiscounts, productsById, search])

    const categoryRows = useMemo<CategoryDiscountRow[]>(() => {
        const query = search.trim().toLowerCase()

        return categoryDiscounts
            .filter((discount: CategoryDiscount) => !discount.isDeleted)
            .map((discount: CategoryDiscount) => {
                const category = categoriesById.get(discount.categoryId)
                const categoryProducts = productsByCategory.get(discount.categoryId) ?? []
                const status = getCategoryDiscountLifecycleStatus(discount, categoryProducts, inventoryTotals)

                return {
                    discount,
                    category,
                    categoryProducts,
                    status
                }
            })
            .filter((row: CategoryDiscountRow) => {
                if (!query) {
                    return true
                }

                const haystack = [row.category?.name, row.discount.discountType]
                    .filter((value): value is string => !!value)
                    .join(' ')
                    .toLowerCase()

                return haystack.includes(query)
            })
            .sort((left: CategoryDiscountRow, right: CategoryDiscountRow) => right.discount.updatedAt.localeCompare(left.discount.updatedAt))
    }, [categoriesById, categoryDiscounts, inventoryTotals, productsByCategory, search])

    const summary = useMemo(() => {
        const allStatuses = [
            ...productRows.map((row: ProductDiscountRow) => row.status),
            ...categoryRows.map((row: CategoryDiscountRow) => row.status)
        ]

        return {
            total: productRows.length + categoryRows.length,
            active: allStatuses.filter((status) => status === 'active').length,
            scheduled: allStatuses.filter((status) => status === 'scheduled').length,
            stockPaused: allStatuses.filter((status) => status === 'stock_paused').length
        }
    }, [categoryRows, productRows])

    const productDiscountTargets = useMemo(() => {
        return products
            .filter((product: Product) => {
                const isTaken = activeProductTargetIds.has(product.id) && (editingDiscount as ProductDiscount | null)?.productId !== product.id
                return !isTaken
            })
            .sort((left: Product, right: Product) => left.name.localeCompare(right.name))
    }, [activeProductTargetIds, editingDiscount, products])

    const targetOptions = useMemo<TargetOption[]>(() => {
        const query = targetSearch.trim().toLowerCase()

        if (activeTab === 'products') {
            return []
        }

        return categories
            .filter((category: Category) => {
                const isTaken = activeCategoryTargetIds.has(category.id) && (editingDiscount as CategoryDiscount | null)?.categoryId !== category.id
                if (isTaken) {
                    return false
                }

                if (!query) {
                    return true
                }

                return [category.name, category.description]
                    .filter((value): value is string => !!value)
                    .some((value) => value.toLowerCase().includes(query))
            })
            .sort((left: Category, right: Category) => left.name.localeCompare(right.name))
            .map((category: Category) => ({
                id: category.id,
                label: category.name,
                meta: pluralizeProducts((productsByCategory.get(category.id) ?? []).length, t)
            }))
    }, [activeCategoryTargetIds, activeTab, categories, editingDiscount, productsByCategory, t, targetSearch])

    function resetDialog(tab: DiscountTab) {
        setActiveTab(tab)
        setEditingDiscount(null)
        setTargetSearch('')
        setProductSearch('')
        setForm(buildDefaultForm())
        setDialogOpen(true)
    }

    function openEditProductDiscount(discount: ProductDiscount) {
        setActiveTab('products')
        setEditingDiscount(discount)
        setTargetSearch('')
        setProductSearch(productsById.get(discount.productId)?.name ?? '')
        setForm({
            targetId: discount.productId,
            discountType: discount.discountType,
            discountValue: String(discount.discountValue),
            priceScope: discount.priceScope ?? 'all',
            priceBookIds: discount.priceBookIds ?? [],
            startsAt: new Date(discount.startsAt),
            endsAt: new Date(discount.endsAt),
            minStockThreshold: discount.minStockThreshold == null ? '' : String(discount.minStockThreshold),
            isActive: discount.isActive
        })
        setDialogOpen(true)
    }

    function openEditCategoryDiscount(discount: CategoryDiscount) {
        setActiveTab('categories')
        setEditingDiscount(discount)
        setTargetSearch('')
        setProductSearch('')
        setForm({
            targetId: discount.categoryId,
            discountType: discount.discountType,
            discountValue: String(discount.discountValue),
            priceScope: 'all',
            priceBookIds: [],
            startsAt: new Date(discount.startsAt),
            endsAt: new Date(discount.endsAt),
            minStockThreshold: discount.minStockThreshold == null ? '' : String(discount.minStockThreshold),
            isActive: discount.isActive
        })
        setDialogOpen(true)
    }

    async function handleSubmit() {
        if (!workspaceId) {
            return
        }

        if (!form.targetId) {
            toast({
                title: t('common.error'),
                description: t('discounts.validation.targetRequired'),
                variant: 'destructive'
            })
            return
        }

        const discountValue = Number(form.discountValue)
        if (!Number.isFinite(discountValue) || discountValue <= 0) {
            toast({
                title: t('common.error'),
                description: t('discounts.validation.discountValue'),
                variant: 'destructive'
            })
            return
        }

        const startsAt = form.startsAt
        const endsAt = form.endsAt
        if (!startsAt || !endsAt || startsAt >= endsAt) {
            toast({
                title: t('common.error'),
                description: t('discounts.validation.dateRange'),
                variant: 'destructive'
            })
            return
        }

        const minStockThreshold = form.minStockThreshold === '' ? null : Number(form.minStockThreshold)
        if (minStockThreshold !== null && (!Number.isFinite(minStockThreshold) || minStockThreshold < 0)) {
            toast({
                title: t('common.error'),
                description: t('discounts.validation.stockThreshold'),
                variant: 'destructive'
            })
            return
        }

        if (activeTab === 'products' && form.isActive) {
            const conflict = productDiscounts.some((discount: ProductDiscount) =>
                !discount.isDeleted &&
                discount.isActive &&
                discount.productId === form.targetId &&
                discount.id !== editingDiscount?.id
            )

            if (conflict) {
                toast({
                    title: t('common.error'),
                    description: t('discounts.validation.activeProductConflict'),
                    variant: 'destructive'
                })
                return
            }
        }

        if (activeTab === 'products' && form.priceScope === 'specific_price_books' && form.priceBookIds.length === 0) {
            toast({
                title: t('common.error'),
                description: t('discounts.validation.priceBookRequired'),
                variant: 'destructive'
            })
            return
        }

        if (activeTab === 'products' && form.discountType === 'fixed_amount' && !isFixedDiscountScopeCurrencyValid) {
            toast({
                title: t('common.error'),
                description: t('discounts.validation.fixedDiscountCurrency'),
                variant: 'destructive'
            })
            return
        }

        if (activeTab === 'categories' && form.isActive) {
            const conflict = categoryDiscounts.some((discount: CategoryDiscount) =>
                !discount.isDeleted &&
                discount.isActive &&
                discount.categoryId === form.targetId &&
                discount.id !== editingDiscount?.id
            )

            if (conflict) {
                toast({
                    title: t('common.error'),
                    description: t('discounts.validation.activeCategoryConflict'),
                    variant: 'destructive'
                })
                return
            }
        }

        setIsSaving(true)
        try {
            if (activeTab === 'products') {
                const payload = {
                    productId: form.targetId,
                    discountType: form.discountType,
                    discountValue,
                    priceScope: form.priceScope,
                    priceBookIds: form.priceScope === 'specific_price_books' ? form.priceBookIds : [],
                    discountCurrency: form.discountType === 'fixed_amount' ? fixedDiscountCurrency : null,
                    startsAt: startsAt.toISOString(),
                    endsAt: endsAt.toISOString(),
                    minStockThreshold,
                    isActive: form.isActive
                }

                if (editingDiscount) {
                    await updateProductDiscount(editingDiscount.id, payload)
                } else {
                    await createProductDiscount(workspaceId, payload)
                }
            } else {
                const payload = {
                    categoryId: form.targetId,
                    discountType: form.discountType,
                    discountValue,
                    startsAt: startsAt.toISOString(),
                    endsAt: endsAt.toISOString(),
                    minStockThreshold,
                    isActive: form.isActive
                }

                if (editingDiscount) {
                    await updateCategoryDiscount(editingDiscount.id, payload)
                } else {
                    await createCategoryDiscount(workspaceId, payload)
                }
            }

            toast({
                title: t('messages.success'),
                description: editingDiscount
                    ? t('discounts.messages.saved')
                    : t('discounts.messages.created')
            })

            setDialogOpen(false)
            setEditingDiscount(null)
            setForm(buildDefaultForm())
            setTargetSearch('')
            setProductSearch('')
        } catch (error: any) {
            toast({
                title: t('common.error'),
                description: error?.message || t('discounts.messages.saveError'),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    async function handleDelete() {
        if (!deleteTarget) {
            return
        }

        setIsDeleting(true)
        try {
            if (deleteTarget.type === 'products') {
                await deleteProductDiscount(deleteTarget.id)
            } else {
                await deleteCategoryDiscount(deleteTarget.id)
            }

            toast({
                title: t('messages.success'),
                description: t('discounts.messages.deleted')
            })
            setDeleteTarget(null)
        } catch (error: any) {
            toast({
                title: t('common.error'),
                description: error?.message || t('discounts.messages.deleteError'),
                variant: 'destructive'
            })
        } finally {
            setIsDeleting(false)
        }
    }

    const dialogTitle = editingDiscount
        ? t('discounts.editDiscount')
        : activeTab === 'products'
            ? t('discounts.addProductDiscount')
            : t('discounts.addCategoryDiscount')

    const productTabCountLabel = productRows.length > 99 ? '99+' : String(productRows.length)
    const categoryTabCountLabel = categoryRows.length > 99 ? '99+' : String(categoryRows.length)
    const selectedTarget = targetOptions.find((option) => option.id === form.targetId)
    const selectedProduct = activeTab === 'products' ? productsById.get(form.targetId) : undefined
    const selectedCategory = activeTab === 'categories' ? categoriesById.get(form.targetId) : undefined
    const selectedCategoryProducts = activeTab === 'categories' ? (productsByCategory.get(form.targetId) ?? []) : []
    const availablePriceBooks = useMemo(
        () => priceBooks.filter((priceBook) => !priceBook.isDeleted).sort((left, right) => left.name.localeCompare(right.name)),
        [priceBooks]
    )
    const availablePriceBookIds = useMemo(
        () => new Set(availablePriceBooks.map((priceBook) => priceBook.id)),
        [availablePriceBooks]
    )
    const priceBookNameById = useMemo(
        () => new Map(availablePriceBooks.map((priceBook) => [priceBook.id, priceBook.name] as const)),
        [availablePriceBooks]
    )
    const formPricePreviews = useMemo(() => {
        if (activeTab !== 'products' || !selectedProduct) {
            return [] as ProductDiscountPricePreview[]
        }

        return getProductDiscountPricePreviews(selectedProduct, {
            priceScope: form.priceScope,
            priceBookIds: form.priceBookIds,
            discountType: form.discountType,
            discountValue: Number.isFinite(Number(form.discountValue)) ? Number(form.discountValue) : 0
        }, availablePriceBooks, priceBookItems)
    }, [activeTab, availablePriceBooks, form.discountType, form.discountValue, form.priceBookIds, form.priceScope, priceBookItems, selectedProduct])
    const getPricePreviewSourceLabel = useCallback((preview: ProductDiscountPricePreview) => {
        if (!preview.priceBookId) {
            return t('discounts.priceScope.nativePrice')
        }

        const priceBookName = priceBookNameById.get(preview.priceBookId) ?? t('discounts.priceScope.specific')
        return preview.usesNativePrice
            ? t('discounts.priceScope.nativeFallback', { name: priceBookName })
            : priceBookName
    }, [priceBookNameById, t])
    const productHasActivePriceBookOverride = !!selectedProduct && priceBookItems.some((item) => (
        !item.isDeleted
        && item.productId === selectedProduct.id
        && availablePriceBookIds.has(item.priceBookId)
    ))
    const isEditingPriceBookScopedProductDiscount = activeTab === 'products'
        && !!editingDiscount
        && 'productId' in editingDiscount
        && form.priceScope !== 'native_only'
    const shouldShowPriceScope = activeTab === 'products'
        && priceBooksEnabled
        && (productHasActivePriceBookOverride || isEditingPriceBookScopedProductDiscount)
    const scopedPriceCurrencies = useMemo(() => {
        if (!selectedProduct) return [] as CurrencyCode[]

        const getPriceBookCurrency = (priceBookId: string) => (
            priceBookItems.find((item) => (
                !item.isDeleted
                && item.priceBookId === priceBookId
                && item.productId === selectedProduct.id
            ))?.currency
            ?? selectedProduct.currency
        )

        if (form.priceScope === 'native_only') {
            return [selectedProduct.currency]
        }

        if (form.priceScope === 'specific_price_books') {
            return form.priceBookIds.map(getPriceBookCurrency)
        }

        return [selectedProduct.currency, ...availablePriceBooks.map((priceBook) => getPriceBookCurrency(priceBook.id))]
    }, [availablePriceBooks, form.priceBookIds, form.priceScope, priceBookItems, selectedProduct])
    const fixedDiscountCurrencies = Array.from(new Set(scopedPriceCurrencies))
    const fixedDiscountCurrency = fixedDiscountCurrencies[0] ?? selectedProduct?.currency ?? features.default_currency
    const isFixedDiscountScopeCurrencyValid = form.discountType !== 'fixed_amount' || fixedDiscountCurrencies.length <= 1
    const isPriceScopeValid = activeTab !== 'products'
        || form.priceScope !== 'specific_price_books'
        || form.priceBookIds.length > 0
    const parsedStartsAt = form.startsAt
    const parsedEndsAt = form.endsAt
    const parsedDiscountValue = Number(form.discountValue)
    const parsedMinStockThreshold = form.minStockThreshold === '' ? null : Number(form.minStockThreshold)
    const isDiscountValueValid = Number.isFinite(parsedDiscountValue) && parsedDiscountValue > 0
    const isMinStockThresholdValid = parsedMinStockThreshold === null || (Number.isFinite(parsedMinStockThreshold) && parsedMinStockThreshold >= 0)
    const isDateRangeValid = !!parsedStartsAt && !!parsedEndsAt && parsedStartsAt < parsedEndsAt
    const isFormInvalid = !form.targetId || !isDiscountValueValid || !isMinStockThresholdValid || !isDateRangeValid || !isPriceScopeValid || !isFixedDiscountScopeCurrencyValid

    function selectProductDiscountTarget(product: Product) {
        const hasActivePriceBookOverride = priceBooksEnabled && priceBookItems.some((item) => (
            !item.isDeleted
            && item.productId === product.id
            && availablePriceBookIds.has(item.priceBookId)
        ))

        setProductSearch(product.name)
        setForm((current) => ({
            ...current,
            targetId: product.id,
            ...(editingDiscount
                ? {}
                : hasActivePriceBookOverride
                    ? { priceScope: 'all' as const }
                    : { priceScope: 'native_only' as const, priceBookIds: [] })
        }))
    }

    const productInsightStats = useMemo(() => ({
        active: productRows.filter((row) => row.status === 'active').length,
        scheduled: productRows.filter((row) => row.status === 'scheduled').length,
        stockPaused: productRows.filter((row) => row.status === 'stock_paused').length,
        expiringSoon: productRows.filter((row) => {
            const remainingDays = getDaysUntilDateTime(row.discount.endsAt)
            return remainingDays !== null && remainingDays >= 0 && remainingDays <= 7
        }).length
    }), [productRows])

    const categoryInsightStats = useMemo(() => ({
        active: categoryRows.filter((row) => row.status === 'active').length,
        scheduled: categoryRows.filter((row) => row.status === 'scheduled').length,
        stockPaused: categoryRows.filter((row) => row.status === 'stock_paused').length,
        coveredProducts: new Set(categoryRows.flatMap((row) => row.categoryProducts.map((product) => product.id))).size
    }), [categoryRows])

    const previewStatus = useMemo<DiscountLifecycleStatus | null>(() => {
        if (!form.targetId || !isDateRangeValid || !isMinStockThresholdValid) {
            return null
        }

        if (activeTab === 'products' && selectedProduct) {
            return getDiscountStatus({
                startsAt: parsedStartsAt!.toISOString(),
                endsAt: parsedEndsAt!.toISOString(),
                isActive: form.isActive,
                minStockThreshold: parsedMinStockThreshold
            }, inventoryTotals.get(selectedProduct.id) ?? 0)
        }

        if (activeTab === 'categories' && selectedCategory) {
            return getCategoryDiscountLifecycleStatus({
                startsAt: parsedStartsAt!.toISOString(),
                endsAt: parsedEndsAt!.toISOString(),
                isActive: form.isActive,
                minStockThreshold: parsedMinStockThreshold
            }, selectedCategoryProducts, inventoryTotals)
        }

        return null
    }, [
        activeTab,
        form.isActive,
        form.targetId,
        inventoryTotals,
        isDateRangeValid,
        isMinStockThresholdValid,
        parsedEndsAt,
        parsedMinStockThreshold,
        parsedStartsAt,
        selectedCategory,
        selectedCategoryProducts,
        selectedProduct
    ])

    const previewMessage = useMemo(() => {
        if (!form.targetId) {
            return t('discounts.modalPreviewFallback')
        }

        if (!isDiscountValueValid || !isDateRangeValid) {
            return t('discounts.modalPreviewDateFallback')
        }

        if (!isFixedDiscountScopeCurrencyValid) {
            return t('discounts.priceScope.fixedCurrencyConflict')
        }

        if (activeTab === 'products' && selectedProduct) {
            if (formPricePreviews.length === 0) {
                return t('discounts.modalPreviewFallback')
            }

            if (formPricePreviews.length > 1) {
                return t('discounts.preview.productMultiple', {
                    name: selectedProduct.name,
                    count: formPricePreviews.length,
                    start: formatDateTime(form.startsAt!),
                    end: formatDateTime(form.endsAt!)
                })
            }

            const preview = formPricePreviews[0]
            return t('discounts.preview.product', {
                name: selectedProduct.name,
                source: getPricePreviewSourceLabel(preview),
                price: formatCurrency(preview.discountPrice, preview.currency, iqdPreference),
                start: formatDateTime(form.startsAt!),
                end: formatDateTime(form.endsAt!)
            })
        }

        if (activeTab === 'categories' && selectedCategory) {
            return t('discounts.preview.category', {
                name: selectedCategory.name,
                count: selectedCategoryProducts.length
            })
        }

        return t('discounts.modalPreviewFallback')
    }, [
        activeTab,
        form.endsAt,
        form.startsAt,
        form.targetId,
        formPricePreviews,
        getPricePreviewSourceLabel,
        iqdPreference,
        isDateRangeValid,
        isDiscountValueValid,
        isFixedDiscountScopeCurrencyValid,
        selectedCategory,
        selectedCategoryProducts.length,
        selectedProduct,
        t
    ])

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <Percent className="h-6 w-6 text-primary" />
                        {t('discounts.title')}
                    </h1>
                    <p className="text-muted-foreground">
                        {t('discounts.subtitle')} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
                {canEdit ? (
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" className="gap-2 rounded-xl" onClick={() => resetDialog('categories')}>
                            <Shapes className="h-4 w-4" />
                            {t('discounts.addCategoryDiscount')}
                        </Button>
                        <Button className="gap-2 rounded-xl" onClick={() => resetDialog('products')}>
                            <Plus className="h-4 w-4" />
                            {t('discounts.addProductDiscount')}
                        </Button>
                    </div>
                ) : null}
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('discounts.summary.total')}</CardTitle>
                    </CardHeader>
                    <CardContent><div className="text-3xl font-black">{summary.total}</div></CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('discounts.status.active')}</CardTitle>
                    </CardHeader>
                    <CardContent><div className="text-3xl font-black text-emerald-600 dark:text-emerald-300">{summary.active}</div></CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('discounts.status.scheduled')}</CardTitle>
                    </CardHeader>
                    <CardContent><div className="text-3xl font-black text-sky-600 dark:text-sky-300">{summary.scheduled}</div></CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm text-muted-foreground">{t('discounts.status.stockPaused')}</CardTitle>
                    </CardHeader>
                    <CardContent><div className="text-3xl font-black text-amber-600 dark:text-amber-300">{summary.stockPaused}</div></CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader className="gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <CardTitle>{t('discounts.title')}</CardTitle>
                        <CardDescription>
                            {t('discounts.description')}
                        </CardDescription>
                    </div>
                    <div className="w-full max-w-sm">
                        <Label htmlFor="discount-search">{t('common.searchBox')}</Label>
                        <Input
                            id="discount-search"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('discounts.searchPlaceholder')}
                            className="mt-2"
                        />
                    </div>
                </CardHeader>
                <CardContent>
                    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as DiscountTab)} className="space-y-4">
                        <TabsList className="grid h-auto min-h-12 w-full max-w-xl grid-cols-2 rounded-2xl items-stretch">
                            <TabsTrigger value="products" className="group min-h-10 gap-2 px-2 sm:px-3">
                                <span className="truncate">{t('discounts.tabs.products')}</span>
                                {productRows.length > 0 ? (
                                    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary/10 px-2 text-xs font-semibold text-primary group-data-[state=active]:bg-primary group-data-[state=active]:text-primary-foreground">
                                        {productTabCountLabel}
                                    </span>
                                ) : null}
                            </TabsTrigger>
                            <TabsTrigger value="categories" className="group min-h-10 gap-2 px-2 sm:px-3">
                                <span className="truncate">{t('discounts.tabs.categories')}</span>
                                {categoryRows.length > 0 ? (
                                    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-primary/10 px-2 text-xs font-semibold text-primary group-data-[state=active]:bg-primary group-data-[state=active]:text-primary-foreground">
                                        {categoryTabCountLabel}
                                    </span>
                                ) : null}
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value="products" className="space-y-6">
                            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_320px]">
                                <div className="space-y-4">
                                    {productRows.length === 0 ? (
                                        <div className="rounded-3xl border border-dashed border-muted-foreground/30 bg-muted/10 px-6 py-12 text-center">
                                            <Percent className="mx-auto mb-4 h-10 w-10 text-primary/70" />
                                            <h3 className="text-lg font-semibold">{t('discounts.empty.products')}</h3>
                                            <p className="mt-2 text-sm text-muted-foreground">
                                                {t('discounts.emptyProductDescription')}
                                            </p>
                                            {canEdit ? (
                                                <Button className="mt-5 rounded-2xl" onClick={() => resetDialog('products')}>
                                                    {t('discounts.createFirstProductDiscount')}
                                                </Button>
                                            ) : null}
                                        </div>
                                    ) : (
                                        <div className="overflow-hidden rounded-3xl border">
                                            <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.95fr)_120px_84px] gap-4 border-b bg-muted/20 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground md:grid">
                                                <div>{t('discounts.columns.item')}</div>
                                                <div>{t('discounts.columns.discount')}</div>
                                                <div>{t('discounts.columns.pricing')}</div>
                                                <div>{t('discounts.columns.schedule')}</div>
                                                <div>{t('common.status')}</div>
                                                <div>{t('common.actions')}</div>
                                            </div>

                                            <div className="divide-y">
                                                {productRows.map((row) => {
                                                    const remainingDays = getDaysUntilDateTime(row.discount.endsAt)
                                                    const pricingPreviews = row.product
                                                        ? getProductDiscountPricePreviews(row.product, row.discount, availablePriceBooks, priceBookItems)
                                                        : []
                                                    const discountCurrency = row.discount.discountCurrency
                                                        ?? pricingPreviews[0]?.currency
                                                        ?? row.product?.currency
                                                        ?? features.default_currency
                                                    const priceScopeLabel = row.discount.priceScope === 'native_only'
                                                        ? t('discounts.priceScope.nativeOnly')
                                                        : row.discount.priceScope === 'specific_price_books'
                                                            ? (row.discount.priceBookIds ?? [])
                                                                .map((id) => priceBookNameById.get(id))
                                                                .filter((name): name is string => !!name)
                                                                .join(', ') || t('discounts.priceScope.specific')
                                                            : t('discounts.priceScope.all')

                                                    return (
                                                        <div key={row.discount.id} className="grid gap-4 px-5 py-5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.95fr)_120px_84px] md:items-center">
                                                            <div>
                                                                <div className="text-sm font-semibold">
                                                                    {row.product?.name || t('discounts.missingProduct')}
                                                                </div>
                                                                <div className="mt-1 text-xs text-muted-foreground">
                                                                    SKU: {row.product?.sku || row.discount.productId}
                                                                </div>
                                                            </div>

                                                            <div className="space-y-1 text-sm">
                                                                <div className="font-semibold">
                                                                    {row.product
                                                                        ? formatDiscountLabel(row.discount.discountType, row.discount.discountValue, discountCurrency, iqdPreference)
                                                                        : formatDiscountLabel(row.discount.discountType, row.discount.discountValue, features.default_currency, iqdPreference)}
                                                                </div>
                                                                <div className="text-xs text-muted-foreground">
                                                                    {t('discounts.thresholdShort')}: {row.discount.minStockThreshold ?? '-'}
                                                                </div>
                                                                <div className="text-xs text-muted-foreground">{priceScopeLabel}</div>
                                                            </div>

                                                            <div className="space-y-1 text-sm">
                                                                {pricingPreviews.length > 0 ? pricingPreviews.map((preview) => (
                                                                    <div key={preview.priceBookId ?? 'native'} className="space-y-0.5">
                                                                        <div className="text-xs text-muted-foreground">{getPricePreviewSourceLabel(preview)}</div>
                                                                        <div className="font-medium">
                                                                            <PriceTransition
                                                                                from={preview.basePrice}
                                                                                to={preview.discountPrice}
                                                                                currency={preview.currency}
                                                                                iqdPreference={iqdPreference}
                                                                                arrowClassName="text-muted-foreground"
                                                                            />
                                                                        </div>
                                                                    </div>
                                                                )) : <div className="font-medium">-</div>}
                                                                <div className="text-muted-foreground">
                                                                    {t('discounts.stock')}: <span className="font-semibold text-foreground">{row.stockTotal}</span>
                                                                </div>
                                                            </div>

                                                            <div className="space-y-1 text-sm">
                                                                <div className="font-medium">{formatDateTime(row.discount.startsAt)}</div>
                                                                <div className="text-muted-foreground">{formatDateTime(row.discount.endsAt)}</div>
                                                                {remainingDays !== null ? (
                                                                    <div className="text-xs text-muted-foreground">
                                                                        {remainingDays >= 0
                                                                            ? t('discounts.endsInDays', { count: remainingDays })
                                                                            : t('discounts.status.expired')}
                                                                    </div>
                                                                ) : null}
                                                            </div>

                                                            <div>
                                                                <span className={cn('inline-flex rounded-full px-3 py-1 text-xs font-semibold', statusBadgeClass(row.status))}>
                                                                    {getStatusLabel(row.status, t)}
                                                                </span>
                                                            </div>

                                                            <div className="flex items-center gap-1">
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="rounded-xl"
                                                                    onClick={() => openEditProductDiscount(row.discount)}
                                                                    disabled={!canEdit}
                                                                >
                                                                    <Pencil className="h-4 w-4" />
                                                                </Button>
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="rounded-xl text-destructive hover:text-destructive"
                                                                    disabled={!canDelete}
                                                                    onClick={() => setDeleteTarget({ id: row.discount.id, label: row.product?.name || row.discount.productId, type: 'products' })}
                                                                >
                                                                    <Trash2 className="h-4 w-4" />
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <Card className="rounded-3xl border-0 bg-[linear-gradient(180deg,#166534,#0f3f2d)] text-white shadow-xl">
                                    <CardHeader className="space-y-3 p-6">
                                        <CardTitle className="text-2xl">{t('discounts.insightTitle')}</CardTitle>
                                        <CardDescription className="text-emerald-100/85">
                                            {t('discounts.productInsightDescription')}
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent className="grid gap-4 p-6 pt-0">
                                        <div className="rounded-2xl bg-white/10 p-4">
                                            <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">{t('discounts.status.active')}</div>
                                            <div className="mt-2 text-4xl font-semibold">{productInsightStats.active}</div>
                                        </div>
                                        <div className="rounded-2xl bg-white/10 p-4">
                                            <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">{t('discounts.status.scheduled')}</div>
                                            <div className="mt-2 text-3xl font-semibold">{productInsightStats.scheduled}</div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="rounded-2xl bg-white/10 p-4">
                                                <div className="text-xs uppercase tracking-[0.18em] text-emerald-100/80">{t('discounts.status.stockPaused')}</div>
                                                <div className="mt-2 text-2xl font-semibold">{productInsightStats.stockPaused}</div>
                                            </div>
                                            <div className="rounded-2xl bg-white/10 p-4">
                                                <div className="text-xs uppercase tracking-[0.18em] text-emerald-100/80">{t('discounts.expiringSoon')}</div>
                                                <div className="mt-2 text-2xl font-semibold">{productInsightStats.expiringSoon}</div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            </div>
                        </TabsContent>

                        <TabsContent value="categories" className="space-y-6">
                            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,2fr)_320px]">
                                <div className="space-y-4">
                                    {categoryRows.length === 0 ? (
                                        <div className="rounded-3xl border border-dashed border-muted-foreground/30 bg-muted/10 px-6 py-12 text-center">
                                            <Shapes className="mx-auto mb-4 h-10 w-10 text-primary/70" />
                                            <h3 className="text-lg font-semibold">{t('discounts.empty.categories')}</h3>
                                            <p className="mt-2 text-sm text-muted-foreground">
                                                {t('discounts.emptyCategoryDescription')}
                                            </p>
                                            {canEdit ? (
                                                <Button className="mt-5 rounded-2xl" onClick={() => resetDialog('categories')}>
                                                    {t('discounts.createFirstCategoryDiscount')}
                                                </Button>
                                            ) : null}
                                        </div>
                                    ) : (
                                        <div className="overflow-hidden rounded-3xl border">
                                            <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.95fr)_120px_84px] gap-4 border-b bg-muted/20 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground md:grid">
                                                <div>{t('discounts.columns.item')}</div>
                                                <div>{t('discounts.columns.scope')}</div>
                                                <div>{t('discounts.columns.discount')}</div>
                                                <div>{t('discounts.columns.schedule')}</div>
                                                <div>{t('common.status')}</div>
                                                <div>{t('common.actions')}</div>
                                            </div>

                                            <div className="divide-y">
                                                {categoryRows.map((row) => {
                                                    const remainingDays = getDaysUntilDateTime(row.discount.endsAt)

                                                    return (
                                                        <div key={row.discount.id} className="grid gap-4 px-5 py-5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,0.95fr)_120px_84px] md:items-center">
                                                            <div>
                                                                <div className="text-sm font-semibold">
                                                                    {row.category?.name || t('discounts.missingCategory')}
                                                                </div>
                                                                <div className="mt-1 text-xs text-muted-foreground">
                                                                    {t('discounts.productsCount', { count: row.categoryProducts.length })}
                                                                </div>
                                                            </div>

                                                            <div className="space-y-1 text-sm">
                                                                <div className="font-semibold">{pluralizeProducts(row.categoryProducts.length, t)}</div>
                                                                <div className="text-xs text-muted-foreground">
                                                                    {t('discounts.thresholdShort')}: {row.discount.minStockThreshold ?? '-'}
                                                                </div>
                                                            </div>

                                                            <div className="space-y-1 text-sm">
                                                                <div className="font-semibold">
                                                                    {formatDiscountLabel(row.discount.discountType, row.discount.discountValue, features.default_currency, iqdPreference)}
                                                                </div>
                                                                <div className="text-muted-foreground">
                                                                    {t('discounts.overrideNotice')}
                                                                </div>
                                                            </div>

                                                            <div className="space-y-1 text-sm">
                                                                <div className="font-medium">{formatDateTime(row.discount.startsAt)}</div>
                                                                <div className="text-muted-foreground">{formatDateTime(row.discount.endsAt)}</div>
                                                                {remainingDays !== null ? (
                                                                    <div className="text-xs text-muted-foreground">
                                                                        {remainingDays >= 0
                                                                            ? t('discounts.endsInDays', { count: remainingDays })
                                                                            : t('discounts.status.expired')}
                                                                    </div>
                                                                ) : null}
                                                            </div>

                                                            <div>
                                                                <span className={cn('inline-flex rounded-full px-3 py-1 text-xs font-semibold', statusBadgeClass(row.status))}>
                                                                    {getStatusLabel(row.status, t)}
                                                                </span>
                                                            </div>

                                                            <div className="flex items-center gap-1">
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="rounded-xl"
                                                                    onClick={() => openEditCategoryDiscount(row.discount)}
                                                                    disabled={!canEdit}
                                                                >
                                                                    <Pencil className="h-4 w-4" />
                                                                </Button>
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="rounded-xl text-destructive hover:text-destructive"
                                                                    disabled={!canDelete}
                                                                    onClick={() => setDeleteTarget({ id: row.discount.id, label: row.category?.name || row.discount.categoryId, type: 'categories' })}
                                                                >
                                                                    <Trash2 className="h-4 w-4" />
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <Card className="rounded-3xl border-0 bg-[linear-gradient(180deg,#166534,#0f3f2d)] text-white shadow-xl">
                                    <CardHeader className="space-y-3 p-6">
                                        <CardTitle className="text-2xl">{t('discounts.insightTitle')}</CardTitle>
                                        <CardDescription className="text-emerald-100/85">
                                            {t('discounts.categoryInsightDescription')}
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent className="grid gap-4 p-6 pt-0">
                                        <div className="rounded-2xl bg-white/10 p-4">
                                            <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">{t('discounts.status.active')}</div>
                                            <div className="mt-2 text-4xl font-semibold">{categoryInsightStats.active}</div>
                                        </div>
                                        <div className="rounded-2xl bg-white/10 p-4">
                                            <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">{t('discounts.coveredProducts')}</div>
                                            <div className="mt-2 text-3xl font-semibold">{categoryInsightStats.coveredProducts}</div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="rounded-2xl bg-white/10 p-4">
                                                <div className="text-xs uppercase tracking-[0.18em] text-emerald-100/80">{t('discounts.status.scheduled')}</div>
                                                <div className="mt-2 text-2xl font-semibold">{categoryInsightStats.scheduled}</div>
                                            </div>
                                            <div className="rounded-2xl bg-white/10 p-4">
                                                <div className="text-xs uppercase tracking-[0.18em] text-emerald-100/80">{t('discounts.status.stockPaused')}</div>
                                                <div className="mt-2 text-2xl font-semibold">{categoryInsightStats.stockPaused}</div>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            </div>
                        </TabsContent>
                    </Tabs>
                </CardContent>
            </Card>

            <Dialog open={dialogOpen} onOpenChange={(open) => {
                setDialogOpen(open)
                if (!open) {
                    setEditingDiscount(null)
                    setTargetSearch('')
                    setProductSearch('')
                }
            }}>
                <DialogContent className="left-0 top-0 flex h-[100dvh] max-h-[100dvh] w-screen max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-0 p-0 sm:left-[50%] sm:top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] sm:h-auto sm:max-h-[min(calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-2rem),920px)] sm:w-[calc(100vw-2rem)] sm:max-w-5xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:border-border/60">
                    <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1.7fr)_320px]">
                        <div className="flex min-h-0 flex-1 flex-col">
                            <DialogHeader className="space-y-2 border-b bg-background px-4 py-4 pr-14 text-start sm:px-8 sm:py-6">
                                <div className="inline-flex w-fit items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                                    {activeTab === 'products' ? <Percent className="h-3.5 w-3.5" /> : <Shapes className="h-3.5 w-3.5" />}
                                    {t('discounts.configurationMode')}
                                </div>
                                <DialogTitle className="text-2xl">{dialogTitle}</DialogTitle>
                                <DialogDescription>
                                    {activeTab === 'products'
                                        ? t('discounts.dialog.productDescription')
                                        : t('discounts.dialog.categoryDescription')}
                                </DialogDescription>
                            </DialogHeader>

                            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-6 sm:px-8 sm:py-6 sm:pb-8">
                                <div className="space-y-5 sm:space-y-6">
                                    {activeTab === 'products' ? (
                                        <div className="space-y-3">
                                            <Label isLoading={products.isLoading}>{t('discounts.product')}</Label>
                                            <div className="flex items-center">
                                                <ProductsViewModalTrigger
                                                    label={t('products.title', { defaultValue: 'Browse products' })}
                                                    onClick={() => setProductsViewOpen(true)}
                                                />
                                                <ProductAutocompleteInput
                                                    className="min-w-0 flex-1"
                                                    inputClassName="h-12 rounded-s-none rounded-e-2xl"
                                                    value={productSearch}
                                                    onChange={(value) => {
                                                        setProductSearch(value)
                                                        setForm((current) => ({ ...current, targetId: '' }))
                                                    }}
                                                    onSelectProduct={(product) => {
                                                        selectProductDiscountTarget(product)
                                                    }}
                                                    products={productDiscountTargets}
                                                    isLoading={products.isLoading}
                                                    placeholder={t('discounts.searchProducts')}
                                                    hasSelection={!!form.targetId}
                                                />
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="space-y-3">
                                                <Label htmlFor="target-search">{t('discounts.targetSearch')}</Label>
                                                <Input
                                                    id="target-search"
                                                    value={targetSearch}
                                                    onChange={(event) => setTargetSearch(event.target.value)}
                                                    placeholder={t('discounts.searchCategories')}
                                                    className="h-12 rounded-2xl"
                                                />
                                            </div>

                                            <div className="space-y-3">
                                                <Label>{t('discounts.category')}</Label>
                                                {targetOptions.length === 0 ? (
                                                    <div className="rounded-2xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
                                                        {t('discounts.noTargets')}
                                                    </div>
                                                ) : (
                                                    <div className="max-h-56 space-y-2 overflow-y-auto rounded-2xl border p-2">
                                                        {targetOptions.map((option) => {
                                                            const isSelected = form.targetId === option.id
                                                            return (
                                                                <button
                                                                    key={option.id}
                                                                    type="button"
                                                                    onClick={() => setForm((current) => ({ ...current, targetId: option.id }))}
                                                                    className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left transition-colors ${isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                                                                >
                                                                    <div>
                                                                        <div className="text-sm font-semibold">{option.label}</div>
                                                                        <div className={`text-xs ${isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                                                                            {option.meta}
                                                                        </div>
                                                                    </div>
                                                                    {isSelected ? (
                                                                        <span className="text-xs font-semibold uppercase tracking-[0.18em]">
                                                                            {t('common.selected')}
                                                                        </span>
                                                                    ) : null}
                                                                </button>
                                                            )
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        </>
                                    )}

                                    {(selectedProduct || selectedCategory) ? (
                                        <div className="rounded-2xl border bg-muted/20 p-4 text-sm">
                                            <div className="font-semibold">{selectedProduct?.name || selectedCategory?.name}</div>
                                            <div className="mt-1 text-muted-foreground">{selectedProduct?.sku || selectedTarget?.meta}</div>
                                            {selectedProduct ? (
                                                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                                                    {formPricePreviews.length > 0 ? formPricePreviews.map((preview) => (
                                                        <div key={preview.priceBookId ?? 'native'}>
                                                            {t('discounts.originalPrice')} ({getPricePreviewSourceLabel(preview)}): {formatCurrency(preview.basePrice, preview.currency, iqdPreference)}
                                                        </div>
                                                    )) : (
                                                        <div>{t('discounts.originalPrice')}: {formatCurrency(selectedProduct.price, selectedProduct.currency, iqdPreference)}</div>
                                                    )}
                                                </div>
                                            ) : null}
                                        </div>
                                    ) : null}

                                    {shouldShowPriceScope ? (
                                        <div className="space-y-3 rounded-2xl border bg-muted/10 p-4">
                                            <div>
                                                <Label>{t('discounts.priceScope.label')}</Label>
                                                <p className="mt-1 text-xs text-muted-foreground">
                                                    {t('discounts.priceScope.hint')}
                                                </p>
                                            </div>
                                            <Select
                                                value={form.priceScope}
                                                onValueChange={(value) => setForm((current) => ({
                                                    ...current,
                                                    priceScope: value as ProductDiscountPriceScope,
                                                    priceBookIds: value === 'specific_price_books' ? current.priceBookIds : []
                                                }))}
                                            >
                                                <SelectTrigger className="h-12 rounded-2xl"><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">{t('discounts.priceScope.all')}</SelectItem>
                                                    <SelectItem value="native_only">{t('discounts.priceScope.nativeOnly')}</SelectItem>
                                                    <SelectItem value="specific_price_books">{t('discounts.priceScope.specific')}</SelectItem>
                                                </SelectContent>
                                            </Select>

                                            {form.priceScope === 'specific_price_books' ? (
                                                availablePriceBooks.length === 0 ? (
                                                    <p className="rounded-xl border border-dashed px-3 py-3 text-sm text-muted-foreground">
                                                        {t('discounts.priceScope.noPriceBooks')}
                                                    </p>
                                                ) : (
                                                    <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border p-2">
                                                        {availablePriceBooks.map((priceBook) => {
                                                            const checked = form.priceBookIds.includes(priceBook.id)
                                                            return (
                                                                <label key={priceBook.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted">
                                                                    <Checkbox
                                                                        checked={checked}
                                                                        onCheckedChange={(nextChecked) => setForm((current) => ({
                                                                            ...current,
                                                                            priceBookIds: nextChecked
                                                                                ? Array.from(new Set([...current.priceBookIds, priceBook.id]))
                                                                                : current.priceBookIds.filter((id) => id !== priceBook.id)
                                                                        }))}
                                                                    />
                                                                    <span className="text-sm font-medium">{priceBook.name}</span>
                                                                </label>
                                                            )
                                                        })}
                                                    </div>
                                                )
                                            ) : null}

                                            {form.discountType === 'fixed_amount' && selectedProduct ? (
                                                <p className={cn('text-xs', isFixedDiscountScopeCurrencyValid ? 'text-muted-foreground' : 'text-destructive')}>
                                                    {isFixedDiscountScopeCurrencyValid
                                                        ? t('discounts.priceScope.fixedCurrency', { currency: fixedDiscountCurrency.toUpperCase() })
                                                        : t('discounts.priceScope.fixedCurrencyConflict')}
                                                </p>
                                            ) : null}
                                        </div>
                                    ) : null}

                                    <div className="grid gap-4 md:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label>{t('discounts.discountType')}</Label>
                                            <Select value={form.discountType} onValueChange={(value) => setForm((current) => ({ ...current, discountType: value as DiscountType }))}>
                                                <SelectTrigger className="h-12 rounded-2xl"><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="fixed_amount">{t('discounts.types.fixedAmount')}</SelectItem>
                                                    <SelectItem value="percentage">{t('discounts.types.percentage')}</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label htmlFor="discount-value">
                                                {form.discountType === 'percentage'
                                                    ? t('discounts.discountPercent')
                                                    : t('discounts.discountAmount')}
                                            </Label>
                                            <NumericInput
                                                id="discount-value"
                                                maxFractionDigits={form.discountType === 'percentage' ? 0 : 2}
                                                value={form.discountValue}
                                                onValueChange={(val) => setForm((current) => ({ ...current, discountValue: val }))}
                                                placeholder={form.discountType === 'percentage' ? '10' : '0'}
                                            />
                                        </div>
                                    </div>

                                    <div className="grid gap-4 md:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label htmlFor="stock-threshold">{t('discounts.minStockThreshold')}</Label>
                                            <NumericInput
                                                id="stock-threshold"
                                                maxFractionDigits={0}
                                                value={form.minStockThreshold}
                                                onValueChange={(val) => setForm((current) => ({ ...current, minStockThreshold: val }))}
                                                placeholder={t('discounts.optional')}
                                            />
                                            <div className="text-xs text-muted-foreground">
                                                {t('discounts.stockHelp')}
                                            </div>
                                        </div>

                                        <div className="rounded-2xl border bg-muted/20 px-4 py-3">
                                            <div className="text-sm font-medium">{t('discounts.activeRecord')}</div>
                                            <div className="mt-1 text-xs text-muted-foreground">
                                                {t('discounts.activeHelp')}
                                            </div>
                                            <div className="mt-4 flex items-center justify-between">
                                                <span className="text-sm font-medium">{t('common.status')}</span>
                                                <Switch checked={form.isActive} onCheckedChange={(checked) => setForm((current) => ({ ...current, isActive: checked }))} />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="space-y-4">
                                        <Label>{t('discounts.scheduleWindow')}</Label>
                                        <div className="grid gap-6 md:grid-cols-2">
                                            <div className="space-y-2">
                                                <Label className="text-xs text-muted-foreground">{t('discounts.startsAt')}</Label>
                                                <DateTimePicker date={form.startsAt} setDate={(d) => setForm((prev) => ({ ...prev, startsAt: d }))} />
                                            </div>
                                            <div className="space-y-2">
                                                <Label className="text-xs text-muted-foreground">{t('discounts.endsAt')}</Label>
                                                <DateTimePicker date={form.endsAt} setDate={(d) => setForm((prev) => ({ ...prev, endsAt: d }))} />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="pt-4">
                                        <Button
                                            type="button"
                                            onClick={handleSubmit}
                                            disabled={isFormInvalid || isSaving}
                                            className="h-12 w-full rounded-2xl px-8"
                                        >
                                            {isSaving
                                                ? t('discounts.savingDiscount')
                                                : t('common.save')}
                                        </Button>
                                    </div>
                                </div>
                            </div>

                            <DialogFooter className="border-t bg-background/95 px-4 py-4 pb-[calc(1rem+var(--safe-area-bottom))] sm:justify-start sm:px-8">
                                <Button type="button" variant="ghost" className="w-full sm:w-auto" onClick={() => setDialogOpen(false)}>
                                    {t('common.cancel')}
                                </Button>
                            </DialogFooter>
                        </div>

                        <div className="hidden min-h-0 overflow-y-auto rounded-b-3xl bg-[linear-gradient(180deg,#166534,#0f3f2d)] p-6 text-white lg:block lg:rounded-b-none lg:rounded-r-3xl">
                            <div className="space-y-4">
                                <h3 className="text-2xl font-semibold">{t('discounts.insightTitle')}</h3>
                                <p className="text-sm text-emerald-100/85">
                                    {activeTab === 'products'
                                        ? t('discounts.modalProductInsight')
                                        : t('discounts.modalCategoryInsight')}
                                </p>

                                <div className="space-y-3 pt-4">
                                    <div className="rounded-2xl bg-white/10 p-4">
                                        <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">
                                            {activeTab === 'products'
                                                ? t('discounts.status.active')
                                                : t('discounts.coveredProducts')}
                                        </div>
                                        <div className="mt-2 text-4xl font-semibold">
                                            {activeTab === 'products' ? productInsightStats.active : categoryInsightStats.coveredProducts}
                                        </div>
                                    </div>

                                    <div className="rounded-2xl bg-white/10 p-4">
                                        <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">{t('discounts.previewTitle')}</div>
                                        <div className="mt-2 text-lg font-semibold">{previewMessage}</div>
                                        {activeTab === 'products' && isDiscountValueValid && isDateRangeValid && isFixedDiscountScopeCurrencyValid && formPricePreviews.length > 0 ? (
                                            <div className="mt-3 space-y-2 border-t border-white/15 pt-3 text-sm">
                                                {formPricePreviews.map((preview) => (
                                                    <div key={preview.priceBookId ?? 'native'} className="flex items-center justify-between gap-3">
                                                        <span className="text-emerald-100/85">{getPricePreviewSourceLabel(preview)}</span>
                                                        <PriceTransition
                                                            from={preview.basePrice}
                                                            to={preview.discountPrice}
                                                            currency={preview.currency}
                                                            iqdPreference={iqdPreference}
                                                            className="font-semibold"
                                                            arrowClassName="text-emerald-100/70"
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        ) : null}
                                    </div>

                                    <div className="rounded-2xl bg-white/10 p-4">
                                        <div className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">{t('common.status')}</div>
                                        <div className="mt-2 text-lg font-semibold">
                                            {previewStatus ? getStatusLabel(previewStatus, t) : t('discounts.previewStatusFallback')}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <ProductsViewModal
                open={productsViewOpen}
                onOpenChange={setProductsViewOpen}
                products={productDiscountTargets}
                storages={[]}
                showStorageSelector={false}
                labels={{
                    title: t('products.title', { defaultValue: 'Browse products' }),
                    searchLabel: t('discounts.product'),
                    searchPlaceholder: t('discounts.searchProducts'),
                    noProductsLabel: t('discounts.noTargets'),
                    noResultsLabel: t('discounts.noTargets')
                }}
                onSelectProduct={(product) => {
                    selectProductDiscountTarget(product)
                }}
            />

            <DeleteConfirmationModal
                isOpen={!!deleteTarget}
                onClose={() => setDeleteTarget(null)}
                onConfirm={handleDelete}
                isLoading={isDeleting}
                itemName={deleteTarget?.label}
                title={t('discounts.deleteTitle')}
                description={t('discounts.deleteDescription')}
            />
        </div>
    )
}
