import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { ChevronDown, LayoutGrid, Package, Search, Warehouse } from 'lucide-react'

import { useProductSelectionAccess, type Product, type Storage } from '@/local-db'
import { useOptionalAuth } from '@/auth'
import { cn } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/ui/components'

export interface ProductsViewModalLabels {
    title?: string
    description?: string
    searchLabel?: string
    searchPlaceholder?: string
    storageLabel?: string
    storagePlaceholder?: string
    skuLabel?: string
    noProductsLabel?: string
    noResultsLabel?: string
    selectSourceLabel?: string
}

export interface ProductsViewModalBatchOption {
    id: string
    label: string
    description?: ReactNode
}

export interface ProductsViewModalProductStockOption {
    label: string
    description?: ReactNode
}

export interface ProductsViewModalTriggerProps {
    onClick: () => void
    label?: string
    className?: string
}

/**
 * The standard compact trigger for attaching ProductsViewModal to a product
 * field. It is intentionally styled as the input's inline-start companion.
 */
export function ProductsViewModalTrigger({
    onClick,
    label = 'Browse products',
    className
}: ProductsViewModalTriggerProps) {
    return (
        <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn('h-8 w-8 shrink-0 rounded-e-none rounded-s-lg border-e-0 bg-background p-0 hover:bg-muted/70', className)}
            aria-label={label}
            title={label}
            onClick={onClick}
        >
            <LayoutGrid className="h-4 w-4" />
        </Button>
    )
}

export interface ProductsViewModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    products: Product[]
    storages: Storage[]
    /** Hide the storage picker when a product selection is not storage-specific. */
    showStorageSelector?: boolean
    initialStorageId?: string
    onSelectProduct: (product: Product, storageId: string, batchId?: string) => void
    filterProducts?: (products: Product[], storageId: string) => Product[]
    getStorageLabel?: (storage: Storage) => string
    getProductMeta?: (product: Product, storageId: string) => ReactNode
    /**
     * Supplies optional batch choices for a product. When multiple stock sources
     * are available, the modal asks the user to choose one before selecting.
     */
    getBatchOptions?: (product: Product, storageId: string) => ProductsViewModalBatchOption[]
    /** Supplies a selectable non-batch stock source alongside any batches. */
    getProductStockOption?: (product: Product, storageId: string) => ProductsViewModalProductStockOption | null
    labels?: ProductsViewModalLabels
}

function getDisplayImageUrl(url?: string): string {
    if (!url) return ''
    if (url.startsWith('http') || url.startsWith('data:')) return url
    return platformService.convertFileSrc(url)
}

function ProductThumbnail({ product }: { product: Product }) {
    const [loadError, setLoadError] = useState(false)

    if (!product.imageUrl || loadError) {
        return (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Package className="h-5 w-5" />
            </div>
        )
    }

    return (
        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-muted">
            <img
                src={getDisplayImageUrl(product.imageUrl)}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
                onError={() => setLoadError(true)}
            />
        </div>
    )
}

export function ProductsViewModal({
    open,
    onOpenChange,
    products,
    storages,
    showStorageSelector = true,
    initialStorageId,
    onSelectProduct,
    filterProducts,
    getStorageLabel = (storage) => storage.name,
    getProductMeta,
    getBatchOptions,
    getProductStockOption,
    labels
}: ProductsViewModalProps) {
    const user = useOptionalAuth()?.user
    const {
        canSelectProduct,
        filterProducts: filterSelectableProducts,
        storageAccess
    } = useProductSelectionAccess(user?.workspaceId, user?.id)
    const [search, setSearch] = useState('')
    const [storageId, setStorageId] = useState('')
    const [expandedProductId, setExpandedProductId] = useState<string | null>(null)
    const accessibleStorages = useMemo(
        () => storages.filter((storage) => storageAccess.canAccessStorage(storage.id)),
        [storageAccess, storages]
    )
    const selectedStorageId = storageId || initialStorageId || accessibleStorages[0]?.id || ''

    useEffect(() => {
        if (!open) return

        setSearch('')
        setStorageId(initialStorageId || accessibleStorages[0]?.id || '')
        setExpandedProductId(null)
    }, [accessibleStorages, initialStorageId, open])

    useEffect(() => {
        setExpandedProductId(null)
    }, [selectedStorageId])

    const selectableProducts = useMemo(
        () => filterSelectableProducts(products),
        [filterSelectableProducts, products]
    )

    const storageProducts = useMemo(
        () => filterProducts ? filterProducts(selectableProducts, selectedStorageId) : selectableProducts,
        [filterProducts, selectableProducts, selectedStorageId]
    )

    const visibleProducts = useMemo(() => {
        const query = search.trim().toLocaleLowerCase()

        if (!query) return storageProducts

        return storageProducts.filter((product) =>
            product.name.toLocaleLowerCase().includes(query)
            || product.sku?.toLocaleLowerCase().includes(query)
            || product.description?.toLocaleLowerCase().includes(query)
        )
    }, [search, storageProducts])

    const getStockSources = (product: Product) => {
        const productStock = getProductStockOption?.(product, selectedStorageId)
        const batches = getBatchOptions?.(product, selectedStorageId) ?? []

        return [
            ...(productStock ? [{ batchId: '', label: productStock.label, description: productStock.description }] : []),
            ...batches.map((batch) => ({
                batchId: batch.id,
                label: batch.label,
                description: batch.description
            }))
        ]
    }

    const selectProduct = (product: Product, batchId?: string) => {
        if (!canSelectProduct(product)) {
            return
        }
        onSelectProduct(product, selectedStorageId, batchId)
        onOpenChange(false)
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[min(48rem,calc(100vh-2rem))] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:rounded-2xl">
                <DialogHeader className="border-b px-6 py-5 text-start rtl:text-right">
                    <DialogTitle className="flex items-center gap-2 pe-8 text-xl">
                        <Package className="h-5 w-5 text-primary" />
                        {labels?.title || 'Browse products'}
                    </DialogTitle>
                    <DialogDescription>
                        {labels?.description || 'Search the catalog or browse products by storage.'}
                    </DialogDescription>
                </DialogHeader>

                <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 p-5 sm:p-6">
                    <div className={cn('grid gap-4', showStorageSelector && 'md:grid-cols-[minmax(0,1fr)_minmax(14rem,0.38fr)]')}>
                        <div className="space-y-2">
                            <Label htmlFor="products-view-modal-search">{labels?.searchLabel || 'Search products'}</Label>
                            <div className="relative">
                                <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    id="products-view-modal-search"
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                    placeholder={labels?.searchPlaceholder || 'Search by name, SKU, or description...'}
                                    className="h-10 ps-9"
                                    autoFocus
                                />
                            </div>
                        </div>
                        {showStorageSelector ? (
                            <div className="space-y-2">
                                <Label>{labels?.storageLabel || 'Storage'}</Label>
                                <Select value={selectedStorageId} onValueChange={setStorageId} disabled={accessibleStorages.length === 0}>
                                    <SelectTrigger className="h-10">
                                        <Warehouse className="me-2 h-4 w-4 shrink-0 text-muted-foreground" />
                                        <SelectValue placeholder={labels?.storagePlaceholder || 'Select a storage'} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {accessibleStorages.map((storage) => (
                                            <SelectItem key={storage.id} value={storage.id}>
                                                {getStorageLabel(storage)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        ) : null}
                    </div>

                    <div className="min-h-0 overflow-y-auto rounded-xl border bg-muted/20 p-2">
                        {visibleProducts.length > 0 ? (
                            <div className="grid gap-2 sm:grid-cols-2">
                                {visibleProducts.map((product) => {
                                    const sources = getStockSources(product)
                                    const isExpanded = expandedProductId === product.id

                                    return (
                                        <div key={product.id} className="overflow-hidden rounded-xl border border-transparent bg-background transition-colors hover:border-primary/30">
                                            <button
                                                type="button"
                                                className="flex w-full min-w-0 items-center gap-3 p-3 text-start hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                onClick={() => {
                                                    if (sources.length <= 1) {
                                                        selectProduct(product, sources[0]?.batchId)
                                                        return
                                                    }
                                                    setExpandedProductId((current) => current === product.id ? null : product.id)
                                                }}
                                            >
                                                <ProductThumbnail product={product} />
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate font-medium">{product.name}</div>
                                                    {product.sku ? (
                                                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                                            {labels?.skuLabel || 'SKU'}: {product.sku}
                                                        </div>
                                                    ) : null}
                                                    {getProductMeta ? (
                                                        <div className="mt-1 text-xs text-muted-foreground">
                                                            {getProductMeta(product, selectedStorageId)}
                                                        </div>
                                                    ) : null}
                                                </div>
                                                {sources.length > 1 ? (
                                                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">
                                                        {sources.length}
                                                        <ChevronDown className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                                    </span>
                                                ) : null}
                                            </button>
                                            {isExpanded ? (
                                                <div className="border-t bg-muted/30 p-2">
                                                    <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                                                        {labels?.selectSourceLabel || 'Select a stock source'}
                                                    </p>
                                                    <div className="space-y-1">
                                                        {sources.map((source) => (
                                                            <button
                                                                key={source.batchId || '__product_stock__'}
                                                                type="button"
                                                                className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-2 text-start text-sm transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                                onClick={() => selectProduct(product, source.batchId)}
                                                            >
                                                                <span className="min-w-0">
                                                                    <span className="block truncate font-medium">{source.label}</span>
                                                                    {source.description ? (
                                                                        <span className="mt-0.5 block text-xs text-muted-foreground">{source.description}</span>
                                                                    ) : null}
                                                                </span>
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            ) : null}
                                        </div>
                                    )
                                })}
                            </div>
                        ) : (
                            <div className="flex h-full min-h-48 flex-col items-center justify-center px-6 text-center text-sm text-muted-foreground">
                                <Package className="mb-3 h-8 w-8 opacity-40" />
                                {storageProducts.length > 0
                                    ? (labels?.noResultsLabel || 'No products match your search.')
                                    : (labels?.noProductsLabel || 'No products are available in this storage.')}
                            </div>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
