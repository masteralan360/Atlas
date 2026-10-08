import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, ArrowUpDown, Barcode, BookOpen, Boxes, Camera, ChevronDown, ChevronRight, CircleAlert, Copy, FileSpreadsheet, GitBranch, Info, LayoutGrid, List as ListIcon, Loader2, Package, Pencil, Plus, RotateCcw, Search, SlidersHorizontal, Tags, Trash2 } from 'lucide-react'

import { useAuth } from '@/auth'
import {
    createProduct,
    deleteProduct,
    useCategories,
    usePriceBookCatalogState,
    useInventory,
    useProducts,
    useWorkspaceProductBarcodes,
    useStorages,
    type CurrencyCode,
    type Product
} from '@/local-db'
import { isMobile, isTauri } from '@/lib/platform'
import {
    getRetriableActionToast,
    isRetriableWebRequestError,
    normalizeSupabaseActionError
} from '@/lib/supabaseRequest'
import { invokeWorkspaceAccess } from '@/lib/workspaceAccess'
import { cn, formatCurrency } from '@/lib/utils'
import {
    assignGeneratedProductImportSkus,
    createProductImportPreviewRows,
    parseProductImportWorkbook,
    type ProductImportProgress,
    type ProductImportPreviewRow,
    type ProductImportSubmissionResult,
    type ProductImportValidationContext
} from '@/lib/productImport'
import { useWorkspace } from '@/workspace'
import { useHideCosts } from '@/permissions'
import { hasValidProductCost } from '@/lib/productCost'
import { isService } from '@/lib/catalogItem'
import { findProductByOrderBarcode } from '@/lib/orderBarcodeScan'
import { UiAccessGate, useUiAccess } from '@/context/UiAccessContext'
import { getBarcodeLabelData, isProductSelectableForBarcodePrint } from '@/lib/barcodeLabel'
import {
    buildCustomTemplateLayoutPdf,
    createCustomTemplatePreview,
    getCustomTemplateTarget,
    getStoredCustomTemplateLabel,
    readCustomTemplateLayout,
    type StoredCustomTemplateRow
} from '@/lib/customTemplates'
import { type CustomTemplateLayout } from '@/lib/printPreviewEditorStore'
import { LABEL_PRINT_TEMPLATE_KEY, isValidLabelPrintPageSize } from '@/lib/labelPrint'
import { loadProductLabelPrintTemplates } from '@/lib/productLabelPrintTemplates'
import { printPdfBlob } from '@/services/pdfPrintService'
import { PriceBookManagementDialog } from '@/ui/components/PriceBookManagementDialog'
import { ProductImportPreviewModal } from '@/ui/components/ProductImportPreviewModal'
import { ProductCategoryManagerDialog } from '@/ui/components/products/ProductCategoryManagerDialog'
import { CameraBarcodeScannerModal, type CameraBarcodeScanMode, type CameraBarcodeScannerTabOption } from '@/ui/components/pos/CameraBarcodeScannerModal'
import { ProductAvatar } from '@/ui/components/ProductAvatars'
import { useProductQuantityPresentation } from '@/ui/hooks/useProductQuantityFormatter'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
    DeleteConfirmationModal,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Checkbox,
    ExportPreviewModal,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
    CurrencySelector,
    StockAdjustmentDialog,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
    AppPagination,
    PrintFlow,
    useToast
} from '@/ui/components'

const DeveloperTestButton = import.meta.env.DEV && __ATLAS_DEV_TESTING__
    ? lazy(() => import('@/dev/testing/DeveloperTestButton'))
    : null

type ProductCloneTargetStorage = {
    id: string
    name: string
    is_primary?: boolean
}

type ProductCloneTarget = {
    workspaceId: string
    workspaceName: string
    workspaceCode?: string
    relationType: 'source' | 'branch'
    storages: ProductCloneTargetStorage[]
}

type PreparedProductImport = {
    fileName: string
    rows: ProductImportPreviewRow[]
    fileErrors: { message: string }[]
}

export type ProductSortOption = 'name_asc' | 'name_desc' | 'sku_asc' | 'sku_desc' | 'price_asc' | 'price_desc' | 'stock_asc' | 'stock_desc' | 'date_asc' | 'date_desc'

export interface ProductFilterState {
    category: string[]
    storage: string[]
    currency: CurrencyCode[]
    minPrice: string
    maxPrice: string
    minStock: string
    maxStock: string
    sort: ProductSortOption
}

export const DEFAULT_PRODUCT_FILTERS: ProductFilterState = {
    category: [],
    storage: [],
    currency: [],
    minPrice: '',
    maxPrice: '',
    minStock: '',
    maxStock: '',
    sort: 'name_asc'
}

type ProductListGroup = {
    primary: Product
    variants: Product[]
}

type ProductTableRow = {
    product: Product
    isPrimary: boolean
    isVariant: boolean
    hasVisibleVariants: boolean
    isLastVariant: boolean
}

function countActiveProductFilters(filters: ProductFilterState) {
    return [
        filters.category.length > 0,
        filters.storage.length > 0,
        filters.currency.length > 0,
        !!filters.minPrice,
        !!filters.maxPrice,
        !!filters.minStock,
        !!filters.maxStock,
        filters.sort !== 'name_asc'
    ].filter(Boolean).length
}

interface ProductFilterMultiSelectOption {
    value: string
    label: string
}

function ProductFilterMultiSelect({
    value,
    options,
    allLabel,
    multipleLabel,
    onChange,
}: {
    value: string[]
    options: ProductFilterMultiSelectOption[]
    allLabel: string
    multipleLabel: string
    onChange: (value: string[]) => void
}) {
    const selectionLabel = value.length === 0
        ? allLabel
        : value.length === 1
            ? options.find((option) => option.value === value[0])?.label || value[0]
            : multipleLabel

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" className="w-full justify-between font-normal" title={selectionLabel}>
                    <span className="truncate">{selectionLabel}</span>
                    <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto">
                <DropdownMenuCheckboxItem
                    checked={value.length === 0}
                    onCheckedChange={() => onChange([])}
                    onSelect={(event) => event.preventDefault()}
                >
                    {allLabel}
                </DropdownMenuCheckboxItem>
                {options.map((option) => (
                    <DropdownMenuCheckboxItem
                        key={option.value}
                        checked={value.includes(option.value)}
                        onCheckedChange={(checked) => onChange(
                            checked
                                ? value.includes(option.value) ? value : [...value, option.value]
                                : value.filter((selectedValue) => selectedValue !== option.value),
                        )}
                        onSelect={(event) => event.preventDefault()}
                    >
                        <span className="truncate">{option.label}</span>
                    </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

export function Products() {
    const { user, session } = useAuth()
    const hideCosts = useHideCosts()
    const { features, branchInfo, hasCapability, hasFeature, workspaceName } = useWorkspace()
    const { t, i18n } = useTranslation()
    const productImagePreviewSide = i18n.dir() === 'rtl' ? 'left' : 'right'
    const { toast } = useToast()
    const { isAccessKeyHeld } = useUiAccess()
    const [, navigate] = useLocation()
    const products = useProducts(user?.workspaceId, { syncBarcodeCache: false })
    const categories = useCategories(user?.workspaceId)
    const storages = useStorages(user?.workspaceId)
    const workspaceId = user?.workspaceId || ''
    const productBarcodes = useWorkspaceProductBarcodes(workspaceId || undefined)
    const getProductQuantityPresentation = useProductQuantityPresentation(workspaceId || undefined)
    const formatProductQuantity = useCallback(
        (productId: string, quantity: number, unit: string) =>
            getProductQuantityPresentation(productId, quantity, unit).label,
        [getProductQuantityPresentation]
    )
    const priceBooksEnabled = hasCapability('priceBooks')
    const { priceBooks, priceBookItems } = usePriceBookCatalogState(
        priceBooksEnabled ? workspaceId || undefined : undefined,
        { enabled: priceBooksEnabled }
    )
    const categoryById = useMemo(
        () => new Map(categories.map((category) => [category.id, category] as const)),
        [categories]
    )
    const storageById = useMemo(
        () => new Map(storages.map((storage) => [storage.id, storage] as const)),
        [storages]
    )
    const productImportValidationContext = useMemo<ProductImportValidationContext>(() => ({
        categories: categories.map((category) => ({ id: category.id, name: category.name })),
        storages: storages.map((storage) => ({ id: storage.id, name: storage.name })),
        allowedCurrencies: features.allowed_currencies
    }), [categories, features.allowed_currencies, storages])

    // Besides observing local changes, this hook refreshes inventory from the
    // cloud when this page is opened. The direct query that used to live here
    // could leave Add Stock with an empty or stale local snapshot on a fresh load.
    const inventoryRows = useInventory(workspaceId)

    const productStorageMap = useMemo(() => {
        const map = new Map<string, { name: string; quantity: number }[]>()
        const rows = inventoryRows
        const temp = new Map<string, Map<string, number>>()
        for (const row of rows) {
            const storage = storageById.get(row.storageId)
            if (!storage) continue
            const productEntry = temp.get(row.productId) ?? new Map()
            const currentQty = productEntry.get(storage.name) ?? 0
            productEntry.set(storage.name, currentQty + row.quantity)
            temp.set(row.productId, productEntry)
        }
        for (const [productId, storageMap] of temp) {
            const entries: { name: string; quantity: number }[] = []
            for (const [name, quantity] of storageMap) {
                entries.push({ name, quantity })
            }
            map.set(productId, entries)
        }
        for (const product of products) {
            if (map.has(product.id) || !product.storageId) continue
            const storage = storageById.get(product.storageId)
            if (!storage) continue
            map.set(product.id, [{
                name: product.storageName || storage.name,
                quantity: Number(product.quantity) || 0
            }])
        }
        return map
    }, [inventoryRows, products, storageById])

    const productPriceBookMap = useMemo(() => {
        const priceBookNameById = new Map(priceBooks.map((priceBook) => [priceBook.id, priceBook.name] as const))
        const productPriceBooks = new Map<string, string[]>()

        for (const item of priceBookItems) {
            const priceBookName = priceBookNameById.get(item.priceBookId)
            if (!priceBookName) continue
            const names = productPriceBooks.get(item.productId) ?? []
            names.push(priceBookName)
            productPriceBooks.set(item.productId, names)
        }

        for (const names of productPriceBooks.values()) {
            names.sort((left, right) => left.localeCompare(right))
        }

        return productPriceBooks
    }, [priceBookItems, priceBooks])

    const missingPriceBookCostsByProduct = useMemo(() => {
        if (!priceBooksEnabled) return new Map<string, string[]>()

        const activePriceBookNames = new Map(
            priceBooks
                .filter((priceBook) => !priceBook.isDeleted)
                .map((priceBook) => [priceBook.id, priceBook.name] as const)
        )
        const warnings = new Map<string, string[]>()

        for (const item of priceBookItems) {
            const priceBookName = activePriceBookNames.get(item.priceBookId)
            if (item.isDeleted || !priceBookName || hasValidProductCost(item.costPrice)) continue

            const priceBookNames = warnings.get(item.productId) ?? []
            priceBookNames.push(priceBookName)
            warnings.set(item.productId, priceBookNames)
        }

        for (const priceBookNames of warnings.values()) {
            priceBookNames.sort((left, right) => left.localeCompare(right))
        }

        return warnings
    }, [priceBookItems, priceBooks, priceBooksEnabled])

    const hasProductCostWarning = (product: Product) =>
        !hasValidProductCost(product.costPrice) || missingPriceBookCostsByProduct.has(product.id)

    const getProductCostWarningMessage = (product: Product) => {
        if (!hasValidProductCost(product.costPrice)) {
            return 'This product has no cost and cannot be sold.'
        }

        const priceBookNames = missingPriceBookCostsByProduct.get(product.id) ?? []
        return `This product has no cost in ${priceBookNames.join(', ')} and cannot be sold to partners linked to that Price Book.`
    }

    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'
    const canCloneProducts = user?.role === 'admin'
    const isBranchWorkspace = Boolean(branchInfo?.isBranch)

    const [search, setSearch] = useState('')
    const [isCameraSearchScannerOpen, setIsCameraSearchScannerOpen] = useState(false)
    const [selectedScannerCameraId, setSelectedScannerCameraId] = useState(() => localStorage.getItem('scanner_camera_id') || '')
    const [scannerCameras, setScannerCameras] = useState<MediaDeviceInfo[]>([])
    const [catalogType, setCatalogType] = useState<'all' | 'products' | 'services'>('all')
    const [filters, setFilters] = useState<ProductFilterState>(DEFAULT_PRODUCT_FILTERS)
    const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false)
    const [draftFilters, setDraftFilters] = useState<ProductFilterState>(filters)
    const [currentPage, setCurrentPage] = useState(1)
    const [collapsedPrimaryProductIds, setCollapsedPrimaryProductIds] = useState<Set<string>>(() => new Set())
    const [pageSize, setPageSize] = useState(() => {
        return Number(localStorage.getItem('products_page_size')) || 20
    })

    useEffect(() => {
        localStorage.setItem('products_page_size', String(pageSize))
    }, [pageSize])
    const [isProductCategoryManagerOpen, setIsProductCategoryManagerOpen] = useState(false)
    const [isPriceBookDialogOpen, setIsPriceBookDialogOpen] = useState(false)
    const [adjustmentDialogOpen, setAdjustmentDialogOpen] = useState(false)
    const [selectedProductForStock, setSelectedProductForStock] = useState<string | undefined>()
    const [heldStockActionProductId, setHeldStockActionProductId] = useState<string | null>(null)
    const stockRowHoldTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const stockRowHoldOriginRef = useRef<{ productId: string; x: number; y: number } | null>(null)
    const stockRowPointerTypeRef = useRef<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [isProductsExportOpen, setIsProductsExportOpen] = useState(false)
    const [isProductImportOpen, setIsProductImportOpen] = useState(false)
    const [isPreparingProductImport, setIsPreparingProductImport] = useState(false)
    const [productImport, setProductImport] = useState<PreparedProductImport | null>(null)
    const productImportInputRef = useRef<HTMLInputElement>(null)
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('products_view_mode') as 'table' | 'grid') || 'table'
    })
    const [deleteModalOpen, setDeleteModalOpen] = useState(false)
    const [itemToDelete, setItemToDelete] = useState<{ id: string; name: string } | null>(null)
    const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set())
    const [isBranchCloneSelectionMode, setIsBranchCloneSelectionMode] = useState(false)
    const [isBarcodeSelectionMode, setIsBarcodeSelectionMode] = useState(false)
    const [isBarcodePrintOpen, setIsBarcodePrintOpen] = useState(false)
    const [barcodePrintProducts, setBarcodePrintProducts] = useState<Product[]>([])
    const [barcodeLabelTemplates, setBarcodeLabelTemplates] = useState<StoredCustomTemplateRow[]>([])
    const [selectedBarcodeLabelTemplate, setSelectedBarcodeLabelTemplate] = useState<StoredCustomTemplateRow | null>(null)
    const [barcodeLabelTemplateLoadFailed, setBarcodeLabelTemplateLoadFailed] = useState(false)
    const [branchCloneDialogOpen, setBranchCloneDialogOpen] = useState(false)
    const [cloneTargets, setCloneTargets] = useState<ProductCloneTarget[]>([])
    const [selectedCloneTargetWorkspaceId, setSelectedCloneTargetWorkspaceId] = useState('')
    const [selectedCloneTargetStorageId, setSelectedCloneTargetStorageId] = useState('')
    const [isBranchCloning, setIsBranchCloning] = useState(false)
    const canCloneToBranch = canCloneProducts && cloneTargets.length > 0

    const productsScannerTabOptions = useMemo<CameraBarcodeScannerTabOption[]>(() => ([
        { id: 'barcode', label: t('products.barcodePrint.barcode', { defaultValue: 'Barcode' }), mode: 'single' },
        { id: 'productName', label: t('invoice.productName', { defaultValue: 'Product Name' }), mode: 'single' }
    ]), [t])

    const handleProductsCameraScan = useCallback((barcode: string, mode: CameraBarcodeScanMode, tabOptionId?: string) => {
        if (mode !== 'single') return false

        const searchValue = tabOptionId === 'productName'
            ? findProductByOrderBarcode(products, productBarcodes, barcode)?.name
            : barcode
        if (searchValue === undefined) return false

        setSearch(searchValue)
        return true
    }, [productBarcodes, products])

    useEffect(() => {
        if (!isCameraSearchScannerOpen) return
        const mediaDevices = navigator.mediaDevices
        if (!mediaDevices?.enumerateDevices) {
            setScannerCameras([])
            return
        }

        let isActive = true
        void mediaDevices.enumerateDevices()
            .then((devices) => {
                if (isActive) setScannerCameras(devices.filter((device) => device.kind === 'videoinput'))
            })
            .catch(() => {
                if (isActive) setScannerCameras([])
            })

        return () => {
            isActive = false
        }
    }, [isCameraSearchScannerOpen])

    const cancelStockRowHold = useCallback(() => {
        if (stockRowHoldTimeoutRef.current) {
            clearTimeout(stockRowHoldTimeoutRef.current)
            stockRowHoldTimeoutRef.current = null
        }
        stockRowHoldOriginRef.current = null
    }, [])

    const startStockRowHold = useCallback((event: ReactPointerEvent<HTMLTableRowElement>, product: Product) => {
        stockRowPointerTypeRef.current = event.pointerType
        if (event.pointerType === 'mouse' || !canEdit || isService(product) || event.button !== 0) return

        const target = event.target
        if (target instanceof Element && target.closest('button, a, input, [role="checkbox"], [role="menuitem"]')) return

        cancelStockRowHold()
        if (heldStockActionProductId !== product.id) setHeldStockActionProductId(null)
        stockRowHoldOriginRef.current = { productId: product.id, x: event.clientX, y: event.clientY }
        stockRowHoldTimeoutRef.current = setTimeout(() => {
            setHeldStockActionProductId(product.id)
            stockRowHoldTimeoutRef.current = null
            stockRowHoldOriginRef.current = null
        }, 550)
    }, [cancelStockRowHold, canEdit, heldStockActionProductId])

    const moveStockRowHold = useCallback((event: ReactPointerEvent<HTMLTableRowElement>) => {
        const origin = stockRowHoldOriginRef.current
        if (!origin) return
        if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancelStockRowHold()
    }, [cancelStockRowHold])

    useEffect(() => () => {
        if (stockRowHoldTimeoutRef.current) clearTimeout(stockRowHoldTimeoutRef.current)
    }, [])

    useEffect(() => {
        let cancelled = false
        if (!workspaceId) {
            setBarcodeLabelTemplates([])
            setBarcodeLabelTemplateLoadFailed(false)
            return () => { cancelled = true }
        }

        void loadProductLabelPrintTemplates(workspaceId).then((result) => {
            if (cancelled) return
            setBarcodeLabelTemplates(result.templates)
            setBarcodeLabelTemplateLoadFailed(result.failed)
            if (result.failed) {
                console.error('[Products] Failed to load label print templates:', result.error)
            }
        })

        return () => { cancelled = true }
    }, [workspaceId])

    useEffect(() => {
        if (!priceBooksEnabled) {
            setIsPriceBookDialogOpen(false)
        }
    }, [priceBooksEnabled])

    const deleteConfirmationDescription = t('products.deleteWarning')

    useEffect(() => {
        localStorage.setItem('products_view_mode', viewMode)
    }, [viewMode])

    useEffect(() => {
        const currentProductIds = new Set(products.map((product) => product.id))
        setSelectedProductIds((previous) => {
            const next = new Set(Array.from(previous).filter((productId) => currentProductIds.has(productId)))
            return next.size === previous.size ? previous : next
        })
    }, [products])

    useEffect(() => {
        if (!canCloneToBranch) {
            if (!isBarcodeSelectionMode) {
                setSelectedProductIds(new Set())
            }
            setIsBranchCloneSelectionMode(false)
            setBranchCloneDialogOpen(false)
        }
    }, [canCloneToBranch, isBarcodeSelectionMode])

    useEffect(() => {
        if (!workspaceId || !canCloneProducts) {
            setCloneTargets([])
            setSelectedCloneTargetWorkspaceId('')
            setSelectedCloneTargetStorageId('')
            return
        }

        let isCancelled = false

        const loadCloneTargets = async () => {
            try {
                const { data, error } = await invokeWorkspaceAccess<{ targets?: ProductCloneTarget[] }>({
                    label: 'products.cloneTargets',
                    fallbackAccessToken: session?.access_token,
                    timeoutMs: 20000,
                    body: {
                        action: 'list-product-clone-targets'
                    }
                })

                if (error) {
                    throw error
                }

                if (!isCancelled) {
                    setCloneTargets(data?.targets ?? [])
                }
            } catch (error) {
                console.error('[Products] Failed to load clone targets:', error)
                if (!isCancelled) {
                    setCloneTargets([])
                }
            }
        }

        void loadCloneTargets()

        return () => {
            isCancelled = true
        }
    }, [workspaceId, canCloneProducts, branchInfo?.isBranch, branchInfo?.sourceWorkspaceId])

    useEffect(() => {
        if (cloneTargets.length === 0) {
            setSelectedCloneTargetWorkspaceId('')
            return
        }

        setSelectedCloneTargetWorkspaceId((current) => {
            if (cloneTargets.some((target) => target.workspaceId === current)) {
                return current
            }

            return cloneTargets.find((target) => target.storages.length > 0)?.workspaceId ?? cloneTargets[0].workspaceId
        })
    }, [cloneTargets])

    useEffect(() => {
        const selectedCloneTarget = cloneTargets.find((target) => target.workspaceId === selectedCloneTargetWorkspaceId)
        if (!selectedCloneTarget) {
            setSelectedCloneTargetStorageId('')
            return
        }

        setSelectedCloneTargetStorageId((current) => {
            if (selectedCloneTarget.storages.some((storage) => storage.id === current)) {
                return current
            }

            return selectedCloneTarget.storages.find((storage) => storage.is_primary)?.id
                ?? selectedCloneTarget.storages[0]?.id
                ?? ''
        })
    }, [cloneTargets, selectedCloneTargetWorkspaceId])

    const getCategoryName = useCallback((id?: string | null) => {
        if (!id) return t('categories.noCategory')
        const category = categoryById.get(id)
        return category?.name || t('categories.noCategory')
    }, [categoryById, t])

    const getStorageName = useCallback((id?: string | null) => {
        if (!id) return ''
        const storage = storageById.get(id)
        return storage ? storage.name : ''
    }, [storageById])

    const renderStockQuantity = (product: Product, serviceLabel: string) => {
        if (isService(product)) return serviceLabel

        const { label, smallerUnitTotal } = getProductQuantityPresentation(product.id, product.quantity, product.unit)
        if (!smallerUnitTotal) return label

        return (
            <TooltipProvider>
                <Tooltip delayDuration={150}>
                    <TooltipTrigger asChild>
                        <span tabIndex={0} className="cursor-help border-b border-dotted border-current">
                            {label}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>
                        {t('products.stockTotalInSmallerUnits', { quantity: smallerUnitTotal })}
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        )
    }

    const renderStorage = (productId: string) => {
        const entries = productStorageMap.get(productId)
        if (!entries || entries.length === 0) return null
        if (entries.length === 1) return <>{entries[0].name}</>
        const sorted = [...entries].sort((a, b) => b.quantity - a.quantity)
        return (
            <TooltipProvider>
                <Tooltip delayDuration={200}>
                    <TooltipTrigger asChild>
                        <span className="cursor-help border-b-2 border-dotted border-foreground/30 text-foreground/80">
                            {t('products.form.mixedStorages') || 'Mixed'}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="start" className="max-w-[240px] space-y-1.5 p-3">
                        {sorted.map((entry) => (
                            <div key={entry.name} className="flex items-center justify-between gap-4 text-sm">
                                <span>{entry.name}</span>
                                <span className="font-mono tabular-nums text-muted-foreground">
                                    {formatProductQuantity(productId, entry.quantity, productById.get(productId)?.unit || 'pcs')}
                                </span>
                            </div>
                        ))}
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        )
    }

    const renderPriceBooks = (productId: string) => {
        const names = productPriceBookMap.get(productId) ?? []
        if (names.length === 0) {
            return <span className="text-muted-foreground">{t('priceBooks.none', { defaultValue: 'No Price Book' })}</span>
        }
        if (names.length === 1) return <>{names[0]}</>

        return (
            <TooltipProvider>
                <Tooltip delayDuration={200}>
                    <TooltipTrigger asChild>
                        <span className="cursor-help border-b-2 border-dotted border-foreground/30 text-foreground/80">
                            {t('priceBooks.mixed', { defaultValue: 'Mixed Price Books' })}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="start" className="max-w-[240px] space-y-1.5 p-3">
                        {names.map((name) => (
                            <div key={name} className="text-sm">{name}</div>
                        ))}
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        )
    }

    const getProductStorageSummary = (product: Product) => {
        const entries = productStorageMap.get(product.id)
        if (!entries || entries.length === 0) {
            return getStorageName(product.storageId) || t('products.export.noStorage', { defaultValue: 'No Storage' })
        }
        if (entries.length === 1) {
            return entries[0].name
        }
        return [...entries]
            .sort((a, b) => b.quantity - a.quantity)
            .map((entry) => `${entry.name} (${entry.quantity})`)
            .join(', ')
    }

    const productBarcodeValuesByProductId = useMemo(() => {
        const barcodeValuesByProductId = new Map<string, string[]>()
        const addBarcode = (productId: string, barcode: string | undefined) => {
            if (!barcode) return
            const values = barcodeValuesByProductId.get(productId) ?? []
            values.push(barcode)
            barcodeValuesByProductId.set(productId, values)
        }

        for (const product of products) {
            addBarcode(product.id, product.barcode)
            product.barcodes?.forEach((barcode) => addBarcode(product.id, barcode))
        }
        for (const productBarcode of productBarcodes) {
            addBarcode(productBarcode.productId, productBarcode.barcode)
        }

        return barcodeValuesByProductId
    }, [productBarcodes, products])

    const filteredProducts = useMemo(() => {
        const searchTerm = search.toLowerCase()
        let result = products.filter((product) =>
            (hasFeature('services') || !isService(product))
            && (catalogType === 'all' || (catalogType === 'services' ? isService(product) : !isService(product)))
            && (
                (product.name ?? '').toLowerCase().includes(searchTerm) ||
                (product.sku ?? '').toLowerCase().includes(searchTerm) ||
                getCategoryName(product.categoryId).toLowerCase().includes(searchTerm) ||
                getStorageName(product.storageId).toLowerCase().includes(searchTerm) ||
                productBarcodeValuesByProductId.get(product.id)?.some((barcode) => barcode.toLowerCase().includes(searchTerm))
            )
        )

        if (filters.category.length > 0) {
            result = result.filter((product) => !!product.categoryId && filters.category.includes(product.categoryId))
        }
        if (filters.storage.length > 0) {
            result = result.filter((product) => !!product.storageId && filters.storage.includes(product.storageId))
        }
        if (filters.currency.length > 0) {
            result = result.filter((product) => filters.currency.includes(product.currency))
        }
        const minPrice = filters.minPrice ? Number(filters.minPrice) : null
        const maxPrice = filters.maxPrice ? Number(filters.maxPrice) : null
        if (minPrice !== null) {
            result = result.filter((product) => product.price >= minPrice)
        }
        if (maxPrice !== null) {
            result = result.filter((product) => product.price <= maxPrice)
        }
        const minStock = filters.minStock ? Number(filters.minStock) : null
        const maxStock = filters.maxStock ? Number(filters.maxStock) : null
        if (minStock !== null) {
            result = result.filter((product) => product.quantity >= minStock)
        }
        if (maxStock !== null) {
            result = result.filter((product) => product.quantity <= maxStock)
        }

        result.sort((a, b) => {
            switch (filters.sort) {
                case 'name_asc': return a.name.localeCompare(b.name)
                case 'name_desc': return b.name.localeCompare(a.name)
                case 'sku_asc': return a.sku.localeCompare(b.sku)
                case 'sku_desc': return b.sku.localeCompare(a.sku)
                case 'price_asc': return a.price - b.price
                case 'price_desc': return b.price - a.price
                case 'stock_asc': return a.quantity - b.quantity
                case 'stock_desc': return b.quantity - a.quantity
                case 'date_asc': return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                case 'date_desc': return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                default: return 0
            }
        })

        return result
    }, [products, productBarcodeValuesByProductId, search, getCategoryName, getStorageName, filters, catalogType, hasFeature])

    const productById = useMemo(
        () => new Map(products.map((product) => [product.id, product] as const)),
        [products]
    )

    const variantsByParentId = useMemo(() => {
        const map = new Map<string, Product[]>()
        for (const product of products) {
            if (!product.parentProductId) continue
            const variants = map.get(product.parentProductId) ?? []
            variants.push(product)
            map.set(product.parentProductId, variants)
        }
        return map
    }, [products])

    const productListGroups = useMemo(() => {
        const groups = new Map<string, ProductListGroup>()

        for (const product of filteredProducts) {
            const primary = product.parentProductId ? productById.get(product.parentProductId) : product
            const groupPrimary = primary ?? product
            const group = groups.get(groupPrimary.id) ?? { primary: groupPrimary, variants: [] }

            if (product.parentProductId && primary) {
                group.variants.push(product)
            }

            groups.set(groupPrimary.id, group)
        }

        return Array.from(groups.values())
    }, [filteredProducts, productById])

    const totalCount = filteredProducts.length
    const paginationCount = productListGroups.length

    const paginatedProductGroups = useMemo(() => {
        const from = (currentPage - 1) * pageSize
        return productListGroups.slice(from, from + pageSize)
    }, [currentPage, pageSize, productListGroups])

    const paginatedProducts = useMemo(
        () => paginatedProductGroups.flatMap((group) => [group.primary, ...group.variants]),
        [paginatedProductGroups]
    )

    const tableProductRows = useMemo<ProductTableRow[]>(() => {
        return paginatedProductGroups.flatMap((group) => {
            const hasVisibleVariants = group.variants.length > 0
            const isPrimary = (variantsByParentId.get(group.primary.id)?.length ?? 0) > 0
            const primaryRow: ProductTableRow = {
                product: group.primary,
                isPrimary,
                isVariant: Boolean(group.primary.parentProductId),
                hasVisibleVariants,
                isLastVariant: false
            }

            if (!hasVisibleVariants || collapsedPrimaryProductIds.has(group.primary.id)) {
                return [primaryRow]
            }

            return [
                primaryRow,
                ...group.variants.map((product, index) => ({
                    product,
                    isPrimary: false,
                    isVariant: true,
                    hasVisibleVariants: false,
                    isLastVariant: index === group.variants.length - 1
                }))
            ]
        })
    }, [collapsedPrimaryProductIds, paginatedProductGroups, variantsByParentId])

    const isPrimaryProduct = (product: Product) => (variantsByParentId.get(product.id)?.length ?? 0) > 0

    useEffect(() => {
        setCurrentPage(1)
    }, [search, pageSize, filters])

    useEffect(() => {
        if (!isFilterDialogOpen) return
        setDraftFilters(filters)
    }, [filters, isFilterDialogOpen])

    const activeFilterCount = countActiveProductFilters(filters)

    const handleApplyFilters = () => {
        setFilters(draftFilters)
        setIsFilterDialogOpen(false)
        setCurrentPage(1)
    }

    const selectionEligibleProducts = useMemo(
        () => products.filter((product) => !isService(product)),
        [products]
    )
    const barcodeSelectionEligibleProducts = useMemo(
        () => products.filter((product) =>
            (hasFeature('services') || !isService(product))
            && isProductSelectableForBarcodePrint(product)
        ),
        [hasFeature, products]
    )
    const selectedProductsCount = (isBarcodeSelectionMode ? barcodeSelectionEligibleProducts : selectionEligibleProducts)
        .filter((product) => selectedProductIds.has(product.id)).length
    const allWorkspaceProductsSelected = selectionEligibleProducts.length > 0 && selectedProductsCount === selectionEligibleProducts.length
    const selectableFilteredProducts = filteredProducts.filter(isProductSelectableForBarcodePrint)
    const allFilteredProductsSelected = selectableFilteredProducts.length > 0
        && selectableFilteredProducts.every((product) => selectedProductIds.has(product.id))
    const isProductSelectionMode = isBranchCloneSelectionMode || isBarcodeSelectionMode
    const selectedBarcodeProducts = useMemo(() => {
        const selectedIds = selectedProductIds
        const visibleProducts = selectableFilteredProducts.filter((product) => selectedIds.has(product.id))
        const visibleProductIds = new Set(visibleProducts.map((product) => product.id))

        return [
            ...visibleProducts,
            ...barcodeSelectionEligibleProducts.filter((product) => selectedIds.has(product.id) && !visibleProductIds.has(product.id))
        ]
    }, [barcodeSelectionEligibleProducts, selectableFilteredProducts, selectedProductIds])
    const barcodeLabels = useMemo(
        () => getBarcodeLabelData(barcodePrintProducts, features.iqd_display_preference),
        [barcodePrintProducts, features.iqd_display_preference]
    )
    const defaultBarcodePrintLanguage = features.print_lang && features.print_lang !== 'auto'
        ? features.print_lang
        : i18n.language
    const selectedBarcodeLabelLayout = useMemo(
        () => readCustomTemplateLayout(selectedBarcodeLabelTemplate),
        [selectedBarcodeLabelTemplate]
    )
    const labelPrintTarget = useMemo(
        () => getCustomTemplateTarget(LABEL_PRINT_TEMPLATE_KEY),
        []
    )
    const selectedBarcodeLabelTemplatePreview = useMemo(() => {
        if (!selectedBarcodeLabelTemplate || !selectedBarcodeLabelLayout || !labelPrintTarget) return null
        return createCustomTemplatePreview(labelPrintTarget, {
            workspaceId,
            workspaceName,
            features,
            printLang: defaultBarcodePrintLanguage,
            barcodeLabel: barcodeLabels[0],
            labelPageSizeMm: selectedBarcodeLabelLayout.page
        })
    }, [barcodeLabels, defaultBarcodePrintLanguage, features, labelPrintTarget, selectedBarcodeLabelLayout, selectedBarcodeLabelTemplate, workspaceId, workspaceName])
    const barcodeLabelTemplateOptions = useMemo(() => barcodeLabelTemplates.flatMap((template) => {
        const layout = readCustomTemplateLayout(template)
        if (!layout || !isValidLabelPrintPageSize(layout.page)) return []
        return [{
            format: 'label' as const,
            template,
            label: getStoredCustomTemplateLabel(template),
            description: t('products.barcodePrint.labelTemplateDescription', {
                defaultValue: 'Custom label · {{width}} × {{height}} mm',
                width: layout.page.widthMm,
                height: layout.page.heightMm
            }),
            primary: template.primary
        }]
    }), [barcodeLabelTemplates, t])
    const buildSelectedBarcodeLabelPdf = useCallback((
        layout: CustomTemplateLayout,
        printLangOverride?: string,
        effectiveId?: string
    ) => {
        if (!labelPrintTarget || !isValidLabelPrintPageSize(layout.page)) {
            return Promise.reject(new Error('Label dimensions are unavailable.'))
        }
        return buildCustomTemplateLayoutPdf({
            target: labelPrintTarget,
            layout,
            values: layout.fields || {},
            options: {
                workspaceId,
                workspaceName,
                features,
                printLang: printLangOverride || defaultBarcodePrintLanguage,
                barcodeLabel: barcodeLabels[0],
                labelPageSizeMm: layout.page
            },
            effectiveId,
            barcodeLabels,
            fieldMode: 'layoutOverrides'
        })
    }, [barcodeLabels, defaultBarcodePrintLanguage, features, labelPrintTarget, workspaceId, workspaceName])
    const selectedCloneTarget = cloneTargets.find((target) => target.workspaceId === selectedCloneTargetWorkspaceId)
    const branchCloneActionLabel = isBranchWorkspace
        ? t('products.branchClone.actionWorkspace', { defaultValue: 'Clone to Workspace' })
        : t('products.branchClone.action', { defaultValue: 'Clone to Branch' })
    const branchCloneDialogTitle = isBranchWorkspace
        ? t('products.branchClone.dialogTitleWorkspace', { defaultValue: 'Clone Products to Workspace' })
        : t('products.branchClone.dialogTitle', { defaultValue: 'Clone Products to Branch' })
    const branchCloneDialogDescription = isBranchWorkspace
        ? t('products.branchClone.dialogDescriptionWorkspace', {
            defaultValue: 'Copy the selected products into the source workspace or another branch.'
        })
        : t('products.branchClone.dialogDescription', {
            defaultValue: "Copy the selected products into one of this workspace's active branches."
        })
    const branchCloneTargetLabel = isBranchWorkspace
        ? t('products.branchClone.targetWorkspaceLabel', { defaultValue: 'Target Workspace' })
        : t('products.branchClone.branchLabel', { defaultValue: 'Target Branch' })
    const branchCloneTargetPlaceholder = isBranchWorkspace
        ? t('products.branchClone.targetWorkspacePlaceholder', { defaultValue: 'Select a workspace' })
        : t('products.branchClone.branchPlaceholder', { defaultValue: 'Select a branch' })
    const branchCloneCountLabel = isBranchWorkspace
        ? t('products.branchClone.targetCount', {
            defaultValue: '{{count}} destinations available',
            count: cloneTargets.length
        })
        : t('products.branchClone.branchCount', {
            defaultValue: '{{count}} branches available',
            count: cloneTargets.length
        })

    const openProductForm = (product?: Product) => {
        navigate(product ? (isService(product) ? `/services/${product.id}` : `/products/${product.id}`) : '/products/new')
    }

    const handleCloneProduct = (product: Product) => {
        navigate(`/products/${product.id}/clone`)
    }

    const handleDeleteProduct = (product: Product) => {
        setItemToDelete({ id: product.id, name: product.name })
        setDeleteModalOpen(true)
    }

    const toggleProductSelection = (productId: string) => {
        const product = products.find((row) => row.id === productId)
        if (!product || (isBarcodeSelectionMode
            ? !isProductSelectableForBarcodePrint(product)
            : isService(product))) return
        setSelectedProductIds((previous) => {
            const next = new Set(previous)
            if (next.has(productId)) {
                next.delete(productId)
            } else {
                next.add(productId)
            }
            return next
        })
    }

    const toggleSelectAllWorkspaceProducts = () => {
        if (allWorkspaceProductsSelected) {
            setSelectedProductIds(new Set())
            return
        }

        setSelectedProductIds(new Set(selectionEligibleProducts.map((product) => product.id)))
    }

    const toggleSelectAllFilteredProducts = () => {
        setSelectedProductIds((previous) => {
            const next = new Set(previous)

            if (allFilteredProductsSelected) {
                selectableFilteredProducts.forEach((product) => next.delete(product.id))
            } else {
                selectableFilteredProducts.forEach((product) => next.add(product.id))
            }

            return next
        })
    }

    const exitBranchCloneSelectionMode = () => {
        setIsBranchCloneSelectionMode(false)
        setSelectedProductIds(new Set())
        setBranchCloneDialogOpen(false)
    }

    const openBranchCloneSelectionMode = () => {
        setSelectedProductIds(new Set())
        setIsBarcodeSelectionMode(false)
        setIsBranchCloneSelectionMode(true)
    }

    const openBarcodeSelectionMode = () => {
        setSelectedProductIds(new Set())
        setIsBranchCloneSelectionMode(false)
        setIsBarcodeSelectionMode(true)
    }

    const exitBarcodeSelectionMode = () => {
        setIsBarcodeSelectionMode(false)
        setSelectedProductIds(new Set())
    }

    const handleOpenBarcodePrint = () => {
        if (selectedBarcodeProducts.length === 0) return

        if (barcodeLabelTemplateLoadFailed) {
            toast({
                title: t('products.barcodePrint.templateLoadErrorTitle', { defaultValue: 'Saved label templates unavailable' }),
                description: t('products.barcodePrint.templateLoadErrorDescription', {
                    defaultValue: 'Your saved label layouts could not be loaded. Try again before printing.'
                }),
                variant: 'destructive'
            })
        }
        setBarcodePrintProducts(selectedBarcodeProducts)
        setIsBarcodePrintOpen(true)
        exitBarcodeSelectionMode()
    }

    const getCloneTargetLabel = (target: ProductCloneTarget) => {
        const relationLabel = target.relationType === 'source'
            ? t('products.branchClone.sourceWorkspaceTag', { defaultValue: 'Source Workspace' })
            : t('products.branchClone.branchTag', { defaultValue: 'Branch' })

        return `${target.workspaceName}${target.workspaceCode ? ` (${target.workspaceCode})` : ''} - ${relationLabel}`
    }

    const showBranchCloneError = (error: unknown, fallbackDescription: string) => {
        const normalized = normalizeSupabaseActionError(error)
        if (isRetriableWebRequestError(normalized)) {
            const message = getRetriableActionToast(normalized)
            toast({
                title: message.title,
                description: message.description,
                variant: 'destructive'
            })
            return
        }

        toast({
            title: t('common.error', { defaultValue: 'Error' }),
            description: fallbackDescription || normalized.message,
            variant: 'destructive'
        })
    }

    const handleCloneProductsToBranch = async () => {
        if (!workspaceId || selectedProductsCount === 0 || !selectedCloneTargetWorkspaceId || !selectedCloneTargetStorageId) {
            return
        }

        setIsBranchCloning(true)

        try {
            const { data, error } = await invokeWorkspaceAccess<{ cloned_products_count?: number }>({
                label: 'products.cloneToBranch',
                fallbackAccessToken: session?.access_token,
                timeoutMs: 40000,
                body: {
                    action: 'clone-products-to-branch',
                    targetWorkspaceId: selectedCloneTargetWorkspaceId,
                    targetStorageId: selectedCloneTargetStorageId,
                    productIds: Array.from(selectedProductIds)
                }
            })

            if (error) {
                throw error
            }

            toast({
                title: isBranchWorkspace
                    ? t('products.branchClone.successTitleWorkspace', { defaultValue: 'Products cloned to workspace' })
                    : t('products.branchClone.successTitle', { defaultValue: 'Products cloned to branch' }),
                description: (isBranchWorkspace
                    ? t('products.branchClone.successDescriptionWorkspace', {
                        defaultValue: '{{count}} products were cloned to {{workspace}}.',
                        count: Number(data?.cloned_products_count ?? selectedProductsCount),
                        workspace: selectedCloneTarget?.workspaceName || t('workspace.title', { defaultValue: 'Workspace' })
                    })
                    : t('products.branchClone.successDescription', {
                        defaultValue: '{{count}} products were cloned to {{branch}}.',
                        count: Number(data?.cloned_products_count ?? selectedProductsCount),
                        branch: selectedCloneTarget?.workspaceName || t('branches.title', { defaultValue: 'Branch' })
                    })),
            })
            exitBranchCloneSelectionMode()
        } catch (error) {
            console.error('[Products] Failed to clone products to branch:', error)
            showBranchCloneError(
                error,
                t('products.branchClone.error', { defaultValue: 'Failed to clone products to the selected destination.' })
            )
        } finally {
            setIsBranchCloning(false)
        }
    }

    const handleExportProducts = () => {
        if (filteredProducts.length === 0) return
        setIsProductsExportOpen(true)
    }

    const closeProductImportPreview = () => {
        if (isPreparingProductImport) {
            return
        }
        setIsProductImportOpen(false)
        setProductImport(null)
    }

    const prepareProductImport = async (fileName: string, fileData: ArrayBuffer) => {
        setIsPreparingProductImport(true)
        try {
            const parsed = await parseProductImportWorkbook(fileData)
            const rows = createProductImportPreviewRows(
                assignGeneratedProductImportSkus(parsed.rows, products.map((product) => product.sku)),
                productImportValidationContext
            )
            setProductImport({
                fileName,
                rows,
                fileErrors: parsed.fileErrors
            })
            setIsProductImportOpen(true)
        } catch (error) {
            console.error('[Products] Could not read product import file:', error)
            toast({
                title: 'Could not read the Excel file',
                description: 'Make sure the selected file is a readable, unprotected .xlsx workbook and try again.',
                variant: 'destructive'
            })
        } finally {
            setIsPreparingProductImport(false)
        }
    }

    const handleProductImportFileInput = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) {
            return
        }

        if (!file.name.toLowerCase().endsWith('.xlsx')) {
            toast({
                title: 'Unsupported file type',
                description: 'Select an .xlsx Excel file to import products.',
                variant: 'destructive'
            })
            return
        }

        await prepareProductImport(file.name, await file.arrayBuffer())
    }

    const openProductImportFilePicker = async () => {
        if (isPreparingProductImport) {
            return
        }

        if (!isTauri()) {
            productImportInputRef.current?.click()
            return
        }

        try {
            const { open } = await import('@tauri-apps/plugin-dialog')
            const selected = await open({
                multiple: false,
                filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }]
            })

            if (!selected || typeof selected !== 'string') {
                return
            }

            const { readFile } = await import('@tauri-apps/plugin-fs')
            const bytes = await readFile(selected)
            const fileData = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
            const fileName = selected.replace(/\\/g, '/').split('/').pop() || 'products.xlsx'
            await prepareProductImport(fileName, fileData)
        } catch (error) {
            console.error('[Products] Could not select product import file:', error)
            toast({
                title: 'Could not open the file picker',
                description: 'Please try selecting the .xlsx file again.',
                variant: 'destructive'
            })
        }
    }

    const submitProductImport = async (
        rows: ProductImportPreviewRow[],
        onProgress: (progress: ProductImportProgress) => void
    ): Promise<ProductImportSubmissionResult> => {
        if (!workspaceId) {
            throw new Error('No workspace is selected for this import.')
        }

        const importedRowNumbers: number[] = []
        const failures: ProductImportSubmissionResult['failures'] = []
        const reportProgress = (currentExcelRowNumber: number | null) => {
            onProgress({
                totalRows: rows.length,
                completedRows: importedRowNumbers.length + failures.length,
                importedRows: importedRowNumbers.length,
                failedRows: failures.length,
                currentExcelRowNumber
            })
        }

        for (const row of rows) {
            reportProgress(row.excelRowNumber)
            if (!row.isValid) {
                failures.push({
                    excelRowNumber: row.excelRowNumber,
                    message: 'This row still has validation errors.'
                })
            } else {
                const storage = storageById.get(row.values.storage_id)
                const category = row.values.category_id ? categoryById.get(row.values.category_id) : undefined
                if (!storage) {
                    failures.push({
                        excelRowNumber: row.excelRowNumber,
                        message: 'The selected storage no longer exists. Revalidate the row and try again.'
                    })
                } else if (row.values.category_id && !category) {
                    failures.push({
                        excelRowNumber: row.excelRowNumber,
                        message: 'The selected category no longer exists. Revalidate the row and try again.'
                    })
                } else {
                    try {
                        await createProduct(workspaceId, {
                            sku: row.values.sku,
                            name: row.values.name,
                            description: '',
                            categoryId: category?.id ?? null,
                            category: category?.name ?? null,
                            storageId: storage.id,
                            storageName: storage.name,
                            price: Number(row.values.price),
                            costPrice: row.values.cost_price.trim() === '' ? null : Number(row.values.cost_price),
                            quantity: Number(row.values.quantity),
                            minStockLevel: row.values.min_stock_level === '' ? 0 : Number(row.values.min_stock_level),
                            unit: row.values.unit,
                            currency: row.values.Currency.toLowerCase() as CurrencyCode,
                            canBeReturned: true,
                            returnRules: '',
                            createdBy: user?.id ?? null
                        })
                        importedRowNumbers.push(row.excelRowNumber)
                    } catch (error) {
                        console.error(`[Products] Failed to import Excel row ${row.excelRowNumber}:`, error)
                        failures.push({
                            excelRowNumber: row.excelRowNumber,
                            message: error instanceof Error ? error.message : 'The product could not be saved.'
                        })
                    }
                }
            }
            reportProgress(null)
        }

        if (importedRowNumbers.length > 0) {
            toast({
                title: `${importedRowNumbers.length} product${importedRowNumbers.length === 1 ? '' : 's'} imported`,
                description: failures.length > 0
                    ? `${failures.length} row${failures.length === 1 ? '' : 's'} still need attention.`
                    : 'Products and their initial inventory have been added successfully.'
            })
        }

        return { importedRowNumbers, failures }
    }

    const confirmDelete = async () => {
        if (!itemToDelete) return

        setIsLoading(true)

        try {
            await deleteProduct(itemToDelete.id)

            setDeleteModalOpen(false)
            setItemToDelete(null)
        } catch (error) {
            console.error('Error deleting:', error)
        } finally {
            setIsLoading(false)
        }
    }

    const productsExportRows = [...filteredProducts]
        .sort((left, right) => right.quantity - left.quantity || left.name.localeCompare(right.name))
        .map((product) => ({
            [t('products.table.sku', { defaultValue: 'SKU' })]: product.sku,
            [t('products.table.name', { defaultValue: 'Name' })]: product.name,
            [t('products.table.category', { defaultValue: 'Category' })]: getCategoryName(product.categoryId),
            [t('storages.title', { defaultValue: 'Storage' })]: getProductStorageSummary(product),
            [t('products.table.price', { defaultValue: 'Price' })]: product.price,
            ...(!hideCosts ? { [t('products.form.cost', { defaultValue: 'Cost Price' })]: product.costPrice } : {}),
            [t('products.form.currency', { defaultValue: 'Currency' })]: product.currency.toUpperCase(),
            [t('products.table.stock', { defaultValue: 'Stock' })]: product.quantity,
            [t('products.form.minStock', { defaultValue: 'Min Stock Level' })]: product.minStockLevel,
            [t('products.form.unit', { defaultValue: 'Unit' })]: t(`products.units.${product.unit}`, product.unit),
            [t('products.form.description', { defaultValue: 'Description' })]: product.description || '',
            [t('common.createdAt', { defaultValue: 'Created At' })]: product.createdAt ? new Date(product.createdAt).toLocaleString() : ''
        }))

    if (isProductImportOpen && productImport) {
        return (
            <ProductImportPreviewModal
                isOpen={isProductImportOpen}
                fileName={productImport.fileName}
                initialRows={productImport.rows}
                fileErrors={productImport.fileErrors}
                validationContext={productImportValidationContext}
                onClose={closeProductImportPreview}
                onImport={submitProductImport}
            />
        )
    }

    if (isProductsExportOpen) {
        return (
            <TooltipProvider>
                <ExportPreviewModal
                    isOpen={isProductsExportOpen}
                    onClose={() => setIsProductsExportOpen(false)}
                    type="products"
                    records={productsExportRows}
                />
            </TooltipProvider>
        )
    }

    return (
        <div className="space-y-6">
            <input
                ref={productImportInputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={handleProductImportFileInput}
            />
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <Package className="h-6 w-6 text-primary" />
                        {t('products.title')}
                    </h1>
                    <p className="text-muted-foreground">
                        {t('products.subtitle') || 'Manage your inventory'} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {!isMobile() && (
                        <div className="mr-2 flex items-center rounded-xl border border-border/50 bg-muted/50 p-1">
                            <Button
                                variant={viewMode === 'table' ? 'secondary' : 'ghost'}
                                size="sm"
                                allowViewer={true}
                                className={cn('h-8 gap-2 rounded-lg px-3 font-bold transition-all', viewMode === 'table' && 'bg-background shadow-sm')}
                                onClick={() => setViewMode('table')}
                            >
                                <ListIcon className="h-3.5 w-3.5" />
                                {t('products.view.table') || 'Table'}
                            </Button>
                            <Button
                                variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                                size="sm"
                                allowViewer={true}
                                className={cn('h-8 gap-2 rounded-lg px-3 font-bold transition-all', viewMode === 'grid' && 'bg-background shadow-sm')}
                                onClick={() => setViewMode('grid')}
                            >
                                <LayoutGrid className="h-3.5 w-3.5" />
                                {t('products.view.grid') || 'Grid'}
                            </Button>
                        </div>
                    )}
                    {canEdit && (
                        <div className="flex flex-wrap justify-end gap-2">
                            <UiAccessGate>
                                {canCloneToBranch && !isProductSelectionMode && (
                                    <Button
                                        variant="outline"
                                        onClick={openBranchCloneSelectionMode}
                                        disabled={products.length === 0}
                                    >
                                        <GitBranch className="h-4 w-4" />
                                        {branchCloneActionLabel}
                                    </Button>
                                )}
                            </UiAccessGate>
                            {(isMobile() || isAccessKeyHeld) && !isProductSelectionMode && (
                                <Button
                                    variant="outline"
                                    onClick={openBarcodeSelectionMode}
                                    disabled={products.length === 0}
                                >
                                    <Barcode className="h-4 w-4" />
                                    {t('products.barcodePrint.action', { defaultValue: 'Print barcodes' })}
                                </Button>
                            )}
                            <Button variant="outline" onClick={() => setIsProductCategoryManagerOpen(true)}>
                                <Tags className="h-4 w-4" />
                                {t('categories.manager.title')}
                            </Button>
                            {priceBooksEnabled && (
                                <Button variant="outline" onClick={() => setIsPriceBookDialogOpen(true)}>
                                    <BookOpen className="h-4 w-4" />
                                    {t('priceBooks.title', { defaultValue: 'Price Books' })}
                                </Button>
                            )}
                            <Button onClick={() => openProductForm()}>
                                <Plus className="h-4 w-4" />
                                {t('products.addProduct')}
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <div className="relative max-w-md flex-1">
                    <Search className="absolute left-3 top-1/3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        placeholder={t('products.searchPlaceholder') || 'Search products...'}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        allowViewer={true}
                        className="pl-10"
                    />
                </div>
                <Button
                    type="button"
                    variant="outline"
                    className="h-11 shrink-0 rounded-2xl border-border/60 md:hidden"
                    onClick={() => setIsCameraSearchScannerOpen(true)}
                >
                    <Camera className="me-2 h-4 w-4" />
                    {t('products.cameraScanner.open', { defaultValue: 'Scan with camera' })}
                </Button>
                <div className="inline-flex h-11 rounded-2xl border border-border/60 bg-muted/30 p-1 text-sm">
                    {(['all', 'products', ...(hasFeature('services') ? ['services'] as const : [])] as const).map((type) => (
                        <Button
                            key={type}
                            type="button"
                            size="sm"
                            variant={catalogType === type ? 'secondary' : 'ghost'}
                            className="h-9 rounded-xl px-3 capitalize"
                            onClick={() => { setCatalogType(type); setCurrentPage(1) }}
                        >
                            {type === 'all' ? t('common.all', { defaultValue: 'All' }) : type === 'services' ? t('services.title', { defaultValue: 'Services' }) : t('products.title', { defaultValue: 'Products' })}
                        </Button>
                    ))}
                </div>
                <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsFilterDialogOpen(true)}
                    className="h-11 rounded-2xl border-border/60 px-4"
                >
                    <SlidersHorizontal className="me-2 h-4 w-4" />
                    {t('products.filters.title', { defaultValue: 'Filters' })}
                    {activeFilterCount > 0 ? (
                        <span className="ms-2 inline-flex min-w-6 items-center justify-center rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground">
                            {activeFilterCount}
                        </span>
                    ) : null}
                </Button>
                {activeFilterCount > 0 ? (
                    <Button type="button" variant="ghost" onClick={() => setFilters(DEFAULT_PRODUCT_FILTERS)} className="h-11 rounded-2xl px-4 text-muted-foreground">
                        <RotateCcw className="me-2 h-4 w-4" />
                        {t('products.filters.clear', { defaultValue: 'Clear Filters' })}
                    </Button>
                ) : null}
            </div>

            {isProductSelectionMode && (isBarcodeSelectionMode ? barcodeSelectionEligibleProducts : selectionEligibleProducts).length > 0 && (
                <Card className="border-primary/15 bg-primary/5">
                    <CardContent className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id={isBarcodeSelectionMode ? 'select-all-products-for-barcode-printing' : 'select-all-workspace-products'}
                                    checked={isBarcodeSelectionMode ? allFilteredProductsSelected : allWorkspaceProductsSelected}
                                    onCheckedChange={isBarcodeSelectionMode ? toggleSelectAllFilteredProducts : toggleSelectAllWorkspaceProducts}
                                />
                                <Label
                                    htmlFor={isBarcodeSelectionMode ? 'select-all-products-for-barcode-printing' : 'select-all-workspace-products'}
                                    className="cursor-pointer font-medium"
                                >
                                    {isBarcodeSelectionMode
                                        ? t('products.barcodePrint.selectAll', {
                                            defaultValue: 'Select all eligible items ({{count}})',
                                            count: selectableFilteredProducts.length
                                        })
                                        : `${t('products.branchClone.selectAllWorkspace', { defaultValue: 'Select all workspace products' })} (${selectionEligibleProducts.length})`}
                                </Label>
                            </div>
                                    <p className="text-sm text-muted-foreground">
                                        {isBarcodeSelectionMode
                                            ? t('products.barcodePrint.selectedCount', {
                                                defaultValue: '{{count}} items selected',
                                                count: selectedProductsCount
                                            })
                                    : t('products.branchClone.selectedCount', {
                                        defaultValue: '{{count}} products selected',
                                        count: selectedProductsCount
                                    })}
                            </p>
                                    <p className="text-sm text-muted-foreground">
                                        {isBarcodeSelectionMode
                                            ? t('products.barcodePrint.selectHint', {
                                                defaultValue: 'Select products, plus services that have an SKU, then choose a label size to print.'
                                            })
                                    : t('products.branchClone.selectionHint', {
                                        defaultValue: 'Select the products you want to copy, then choose the destination workspace and storage.'
                                    })}
                            </p>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={isBarcodeSelectionMode ? exitBarcodeSelectionMode : exitBranchCloneSelectionMode}
                            >
                                {t('products.branchClone.cancelSelection', { defaultValue: 'Cancel' })}
                            </Button>
                            <Button
                                type="button"
                                className="gap-2"
                                onClick={isBarcodeSelectionMode ? handleOpenBarcodePrint : () => setBranchCloneDialogOpen(true)}
                                disabled={selectedProductsCount === 0}
                            >
                                {isBarcodeSelectionMode ? <Barcode className="h-4 w-4" /> : <GitBranch className="h-4 w-4" />}
                                {isBarcodeSelectionMode
                                    ? t('products.barcodePrint.printSelected', { defaultValue: 'Print selected barcodes' })
                                    : t('products.branchClone.chooseDestination', { defaultValue: 'Choose Destination' })}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between space-y-0 gap-4 pb-4">
                    <div className="flex flex-col gap-1">
                        <CardTitle>{t('products.title')}</CardTitle>
                        {totalCount > 0 && (
                            <p className="text-[10px] text-muted-foreground font-black uppercase tracking-[0.2em] opacity-70">
                                {t('products.pagination.total', { count: totalCount, defaultValue: '{{count}} Products Found' })}
                            </p>
                        )}
                    </div>
                    <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
                        {DeveloperTestButton && <Suspense fallback={null}>
                            <DeveloperTestButton suiteId="products" />
                        </Suspense>}
                        <AppPagination
                            currentPage={currentPage}
                            totalCount={paginationCount}
                            pageSize={pageSize}
                            onPageChange={setCurrentPage}
                            onPageSizeChange={(newSize) => {
                                setPageSize(newSize)
                                setCurrentPage(1)
                            }}
                            className="w-auto"
                        />
                        <Button
                            type="button"
                            variant="outline"
                            allowViewer={true}
                            onClick={handleExportProducts}
                            disabled={filteredProducts.length === 0}
                            className={cn(
                                "h-10 gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-5 text-[10px] font-black uppercase tracking-widest text-emerald-700 transition-all",
                                "hover:bg-emerald-100 hover:shadow-[0_0_20px_-5px_rgba(16,185,129,0.3)] active:scale-95",
                                "dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/20"
                            )}
                        >
                            <FileSpreadsheet className="h-4 w-4" />
                            {t('sales.export.button', { defaultValue: 'Excel Export' })}
                        </Button>
                        {canEdit && !isMobile() && (
                            <UiAccessGate>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => void openProductImportFilePicker()}
                                    disabled={isPreparingProductImport}
                                    className={cn(
                                        'h-10 gap-2 rounded-full border border-primary/20 bg-primary/5 px-5 text-[10px] font-black uppercase tracking-widest text-primary transition-all',
                                        'hover:bg-primary/10 hover:shadow-[0_0_20px_-5px_rgba(59,130,246,0.3)] active:scale-95'
                                    )}
                                >
                                    {isPreparingProductImport ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                                    {isPreparingProductImport ? 'Reading Excel…' : 'Import Products'}
                                </Button>
                            </UiAccessGate>
                        )}
                    </div>
                </CardHeader>
                <CardContent>
                    {filteredProducts.length === 0 ? (
                        <div className="py-8 text-center text-muted-foreground">{t('common.noData')}</div>
                    ) : (
                        <>
                            {isMobile() && (
                                <div className="grid grid-cols-1 gap-4">
                                    {paginatedProductGroups.map((group) => {
                                        const groupedProducts = [group.primary, ...group.variants]

                                        return (
                                            <div key={group.primary.id} className="space-y-4">
                                                {groupedProducts.map((product, index) => {
                                                    const isLinkedVariant = index > 0
                                                    const isAttachedVariant = index === 1

                                                    return (
                                                        <div
                                                            key={product.id}
                                                            className={cn(
                                                                isAttachedVariant && 'relative !-mt-px mx-6 pt-0',
                                                                isLinkedVariant && !isAttachedVariant && 'mx-6 pt-3'
                                                            )}
                                                        >
                                                            <ContextMenu>
                                                                <ContextMenuTrigger asChild>
                                                                    <div
                                                                        className={cn(
                                                                            'space-y-4 rounded-[2rem] border border-border bg-card p-4 shadow-sm',
                                                                            isLinkedVariant && 'rounded-[1.5rem] p-3',
                                                                            isAttachedVariant && 'relative z-10 rounded-t-none border-t-0 shadow-none',
                                                                            isProductSelectionMode && selectedProductIds.has(product.id) && 'border-primary/50 bg-primary/5',
                                                                            hasProductCostWarning(product) && 'border-destructive/40 bg-destructive/10'
                                                                        )}
                                                                    >
                                                                        {isProductSelectionMode && (isBarcodeSelectionMode
                                                                            ? isProductSelectableForBarcodePrint(product)
                                                                            : !isService(product)) && (
                                                                            <div className="flex items-center gap-2">
                                                                                <Checkbox
                                                                                    id={`product-select-mobile-${product.id}`}
                                                                                    checked={selectedProductIds.has(product.id)}
                                                                                    onCheckedChange={() => toggleProductSelection(product.id)}
                                                                                />
                                                                                <Label htmlFor={`product-select-mobile-${product.id}`} className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                                                                    {isBarcodeSelectionMode
                                                                                        ? t('products.barcodePrint.selectRow', { defaultValue: 'Select item' })
                                                                                        : t('products.branchClone.selectProduct', { defaultValue: 'Select Product' })}
                                                                                </Label>
                                                                            </div>
                                                                        )}
                                                                        <div className={cn('flex gap-4', isLinkedVariant && 'gap-3')}>
                                                                            {hasProductCostWarning(product) && (
                                                                                <TooltipProvider>
                                                                                    <Tooltip delayDuration={150}>
                                                                                        <TooltipTrigger asChild>
                                                                                            <span className="shrink-0 cursor-help text-destructive" aria-label="Product cannot be sold without a cost"><CircleAlert className="h-5 w-5" /></span>
                                                                                        </TooltipTrigger>
                                                                                        <TooltipContent>{getProductCostWarningMessage(product)}</TooltipContent>
                                                                                    </Tooltip>
                                                                                </TooltipProvider>
                                                                            )}
                                                                            <ProductAvatar
                                                                                productName={product.name}
                                                                                imageUrl={product.imageUrl}
                                                                                showImagePreviewOnHover
                                                                                previewSide={productImagePreviewSide}
                                                                                className={cn('h-16 w-16 rounded-[1.25rem] border border-border/50 bg-muted/30', isLinkedVariant && 'h-14 w-14 rounded-2xl')}
                                                                                fallbackIconClassName="h-8 w-8 text-muted-foreground/20"
                                                                            />
                                                                            <div className="flex min-w-0 flex-1 flex-col justify-center">
                                                                                <div className={cn('text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground', isLinkedVariant && 'text-[9px]')}>{product.sku}</div>
                                                                                <div className={cn('truncate text-base font-black leading-tight text-foreground', isLinkedVariant && 'text-sm')}>{product.name}</div>
                                                                                {isService(product) && <span className="mt-1 inline-flex w-fit rounded-md border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-violet-700 dark:text-violet-300">{t('services.badge')}</span>}
                                                                                <div className={cn('mt-0.5 text-[11px] font-bold uppercase tracking-wide text-primary/80', isLinkedVariant && 'text-[10px]')}>
                                                                                    {getCategoryName(product.categoryId)}
                                                                                </div>
                                                                                <div className={cn('mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60', isLinkedVariant && 'text-[9px]')}>
                                                                                    {renderStorage(product.id) ?? getStorageName(product.storageId)}
                                                                                </div>
                                                                            </div>
                                                                            <div className="flex flex-col justify-center text-right">
                                                                                {product.parentProductId ? (
                                                                                    <span className="mb-1 inline-flex self-end items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-muted-foreground">
                                                                                        <GitBranch className="h-3 w-3" />
                                                                                        {t('products.variants.variant', { defaultValue: 'Variant' })}
                                                                                    </span>
                                                                                ) : isPrimaryProduct(product) ? (
                                                                                    <span className="mb-1 self-end rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-primary">
                                                                                        {t('products.variants.primary', { defaultValue: 'Primary' })}
                                                                                    </span>
                                                                                ) : null}
                                                                                <div className={cn('text-lg font-black leading-tight text-primary', isLinkedVariant && 'text-base')}>
                                                                                    {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                                                </div>
                                                                                <div className={cn(
                                                                                    'mt-0.5 text-[11px] font-black uppercase tracking-widest',
                                                                                    isLinkedVariant && 'text-[10px]',
                                                                                    product.quantity <= product.minStockLevel ? 'text-amber-500' : 'text-muted-foreground/60'
                                                                                )}>
                                                                                    {renderStockQuantity(product, t('services.noInventory', { defaultValue: 'No inventory' }))}
                                                                                </div>
                                                                            </div>
                                                                        </div>
                                                                        <div className={cn('flex justify-end gap-2 border-t border-border/50 pt-3', isLinkedVariant && 'gap-1.5 pt-2')}>
                                                                            <Button
                                                                                variant="secondary"
                                                                                size="sm"
                                                                                allowViewer={!canEdit}
                                                                                className={cn('h-10 gap-2 rounded-xl px-6 font-bold', isLinkedVariant && 'h-9 gap-1.5 rounded-lg px-4 text-xs')}
                                                                                onClick={() => openProductForm(product)}
                                                                            >
                                                                                {canEdit ? <Pencil className="h-4 w-4" /> : <Info className="h-4 w-4" />}
                                                                                {canEdit ? t('common.edit') : (t('common.view') || 'View')}
                                                                            </Button>
                                                                            {canEdit && !isService(product) && (
                                                                                <Button
                                                                                    variant="secondary"
                                                                                    size="sm"
                                                                                    className={cn('h-10 gap-2 rounded-xl px-4 font-bold text-primary', isLinkedVariant && 'h-9 gap-1.5 rounded-lg px-3 text-xs')}
                                                                                    onClick={() => {
                                                                                        setSelectedProductForStock(product.id)
                                                                                        setAdjustmentDialogOpen(true)
                                                                                    }}
                                                                                >
                                                                                    <Boxes className="h-4 w-4" />
                                                                                    {t('products.addStock', { defaultValue: 'Add Stock' })}
                                                                                </Button>
                                                                            )}
                                                                            {canEdit && !isService(product) && (
                                                                                <Button
                                                                                    variant="ghost"
                                                                                    size="icon"
                                                                                    aria-label={t('common.clone') || 'Clone'}
                                                                                    className={cn('h-10 w-10 rounded-xl text-primary hover:bg-primary/5', isLinkedVariant && 'h-9 w-9 rounded-lg')}
                                                                                    onClick={() => handleCloneProduct(product)}
                                                                                >
                                                                                    <Copy className="h-4 w-4" />
                                                                                </Button>
                                                                            )}
                                                                            {canDelete && (
                                                                                <Button
                                                                                    variant="ghost"
                                                                                    size="icon"
                                                                                    aria-label={t('common.delete') || 'Delete'}
                                                                                    className={cn('h-10 w-10 rounded-xl text-destructive hover:bg-destructive/5', isLinkedVariant && 'h-9 w-9 rounded-lg')}
                                                                                    onClick={() => handleDeleteProduct(product)}
                                                                                >
                                                                                    <Trash2 className="h-4 w-4" />
                                                                                </Button>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </ContextMenuTrigger>
                                                                <ContextMenuContent>
                                                                    {canEdit && !isService(product) && (
                                                                        <ContextMenuItem className="gap-2" onSelect={() => { setSelectedProductForStock(product.id); setAdjustmentDialogOpen(true); }}>
                                                                            <Boxes className="h-4 w-4" />
                                                                            {t('products.addStock', { defaultValue: 'Add Stock' })}
                                                                        </ContextMenuItem>
                                                                    )}
                                                                </ContextMenuContent>
                                                            </ContextMenu>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )
                                    })}
                                </div>
                            )}

                            {!isMobile() && (
                                <>
                                    {viewMode === 'grid' ? (
                                        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                                            {paginatedProducts.map((product) => (
                                                <ContextMenu key={product.id}>
                                                    <ContextMenuTrigger asChild>
                                                        <div
                                                            className={cn(
                                                                'group relative flex flex-col gap-4 overflow-hidden rounded-[1.5rem] border border-border/50 bg-card p-4 transition-all duration-300 hover:-translate-y-1 hover:bg-accent/5 hover:shadow-2xl hover:shadow-primary/5',
                                                                isProductSelectionMode && selectedProductIds.has(product.id) && 'border-primary/50 bg-primary/5 shadow-lg shadow-primary/10',
                                                                hasProductCostWarning(product) && 'border-destructive/40 bg-destructive/10 hover:bg-destructive/15'
                                                            )}
                                                        >
                                                            {isProductSelectionMode && (isBarcodeSelectionMode
                                                                ? isProductSelectableForBarcodePrint(product)
                                                                : !isService(product)) && (
                                                                <div className="flex items-center gap-2">
                                                                    <Checkbox
                                                                        id={`product-select-grid-${product.id}`}
                                                                        checked={selectedProductIds.has(product.id)}
                                                                        onCheckedChange={() => toggleProductSelection(product.id)}
                                                                    />
                                                                    <Label htmlFor={`product-select-grid-${product.id}`} className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                                                        {isBarcodeSelectionMode
                                                                            ? t('products.barcodePrint.selectRow', { defaultValue: 'Select item' })
                                                                            : t('products.branchClone.selectProduct', { defaultValue: 'Select Product' })}
                                                                    </Label>
                                                                </div>
                                                            )}
                                                            <div className="relative aspect-square overflow-hidden rounded-2xl border border-border/20 bg-muted/30">
                                                                <ProductAvatar
                                                                    productName={product.name}
                                                                    imageUrl={product.imageUrl}
                                                                    showImagePreviewOnHover
                                                                    previewSide={productImagePreviewSide}
                                                                    className="h-full w-full rounded-none border-0 bg-transparent"
                                                                    imageClassName="transition-transform duration-500 group-hover:scale-110"
                                                                    fallbackIconClassName="h-12 w-12 text-muted-foreground/10"
                                                                />
                                                                {!isService(product) && <div className={cn(
                                                                    'absolute right-2 top-2 rounded-lg px-2 py-1 text-[10px] font-black uppercase tracking-tighter shadow-sm',
                                                                    product.quantity <= product.minStockLevel ? 'bg-amber-500 text-white' : 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600'
                                                                )}>
                                                                    {product.quantity <= product.minStockLevel ? (t('products.lowStock') || 'Low Stock') : (t('products.inStock') || 'In Stock')}
                                                                </div>}
                                                                {hasProductCostWarning(product) && (
                                                                    <TooltipProvider>
                                                                        <Tooltip delayDuration={150}>
                                                                            <TooltipTrigger asChild>
                                                                                <span className="absolute left-2 top-2 cursor-help text-destructive"><CircleAlert className="h-5 w-5 fill-background" /></span>
                                                                            </TooltipTrigger>
                                                                            <TooltipContent>{getProductCostWarningMessage(product)}</TooltipContent>
                                                                        </Tooltip>
                                                                    </TooltipProvider>
                                                                )}
                                                            </div>

                                                            <div className="flex-1 space-y-1">
                                                                <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground/60">{product.sku}</div>
                                                                <div className="flex items-start gap-2"><h3 className="line-clamp-2 text-sm font-bold leading-snug text-foreground transition-colors group-hover:text-primary">{product.name}</h3>{isService(product) && <span className="shrink-0 rounded-md border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-violet-700 dark:text-violet-300">{t('services.badge')}</span>}{isPrimaryProduct(product) && <span className="shrink-0 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-primary">{t('products.variants.primary', { defaultValue: 'Primary' })}</span>}</div>
                                                                <div className="text-[11px] font-bold uppercase tracking-wide text-primary/70">{getCategoryName(product.categoryId)}</div>
                                                                <div className="text-[10px] font-medium text-muted-foreground/80">{isService(product) ? t('services.noInventory', { defaultValue: 'No inventory' }) : (renderStorage(product.id) ?? getStorageName(product.storageId))}</div>
                                                            </div>

                                                            <div className="flex items-center justify-between border-t border-border/40 pt-3">
                                                                <div>
                                                                    <div className="text-lg font-black text-primary">
                                                                        {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                                    </div>
                                                                    <div className="text-[11px] font-medium text-muted-foreground">
                                                                        {renderStockQuantity(product, t('services.noInventory', { defaultValue: 'No inventory' }))}
                                                                    </div>
                                                                </div>

                                                                <div className="flex gap-1">
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        allowViewer={!canEdit}
                                                                        aria-label={canEdit ? (t('common.edit') || 'Edit') : (t('common.view') || 'View')}
                                                                        className="h-8 w-8 rounded-lg transition-colors hover:bg-primary/10 hover:text-primary"
                                                                        onClick={() => openProductForm(product)}
                                                                    >
                                                                        {canEdit ? <Pencil className="h-3.5 w-3.5" /> : <Info className="h-3.5 w-3.5" />}
                                                                    </Button>
                                                                    {canEdit && !isService(product) && (
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="icon"
                                                                            aria-label={t('common.clone') || 'Clone'}
                                                                            className="h-8 w-8 rounded-lg transition-colors hover:bg-primary/10 hover:text-primary"
                                                                            onClick={() => handleCloneProduct(product)}
                                                                        >
                                                                            <Copy className="h-3.5 w-3.5" />
                                                                        </Button>
                                                                    )}
                                                                    {canDelete && (
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="icon"
                                                                            aria-label={t('common.delete') || 'Delete'}
                                                                            className="h-8 w-8 rounded-lg transition-colors hover:bg-destructive/10 hover:text-destructive"
                                                                            onClick={() => handleDeleteProduct(product)}
                                                                        >
                                                                            <Trash2 className="h-3.5 w-3.5" />
                                                                        </Button>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </ContextMenuTrigger>
                                                    <ContextMenuContent>
                                                        {canEdit && !isService(product) && (
                                                            <ContextMenuItem className="gap-2" onSelect={() => { setSelectedProductForStock(product.id); setAdjustmentDialogOpen(true); }}>
                                                                <Boxes className="h-4 w-4" />
                                                                {t('products.addStock', { defaultValue: 'Add Stock' })}
                                                            </ContextMenuItem>
                                                        )}
                                                    </ContextMenuContent>
                                                </ContextMenu>
                                            ))}
                                        </div>
                                    ) : (
                                        <Table>
                                            <TableHeader>
                                                <TableRow>
                                                    {isProductSelectionMode && <TableHead className="w-[52px]" />}
                                                    <TableHead className="w-[44px]" aria-label="Product status" />
                                                    <TableHead className="w-[80px]">{t('products.table.image') || 'Image'}</TableHead>
                                                    <TableHead
                                                        className="cursor-pointer select-none group/sort"
                                                        onClick={() => {
                                                            setFilters(prev => ({
                                                                ...prev,
                                                                sort: prev.sort === 'sku_asc' ? 'sku_desc' : 'sku_asc'
                                                            }))
                                                        }}
                                                    >
                                                        <span className="inline-flex items-center gap-1.5">
                                                            {t('products.table.sku')}
                                                            {filters.sort === 'sku_asc' ? (
                                                                <ArrowUp className="w-3.5 h-3.5 text-primary" />
                                                            ) : filters.sort === 'sku_desc' ? (
                                                                <ArrowDown className="w-3.5 h-3.5 text-primary" />
                                                            ) : (
                                                                <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground/40 opacity-0 group-hover/sort:opacity-100 transition-opacity" />
                                                            )}
                                                        </span>
                                                    </TableHead>
                                                    <TableHead>{t('products.table.name')}</TableHead>
                                                    <TableHead>{t('products.table.category')}</TableHead>
                                                    <TableHead>{t('storages.title') || 'Storage'}</TableHead>
                                                    {priceBooksEnabled && <TableHead>{t('priceBooks.title', { defaultValue: 'Price Books' })}</TableHead>}
                                                    <TableHead
                                                        className="text-right cursor-pointer select-none group/sort"
                                                        onClick={() => {
                                                            setFilters(prev => ({
                                                                ...prev,
                                                                sort: prev.sort === 'price_asc' ? 'price_desc' : 'price_asc'
                                                            }))
                                                        }}
                                                    >
                                                        <span className="inline-flex items-center gap-1.5 justify-end">
                                                            {t('products.table.price')}
                                                            {filters.sort === 'price_asc' ? (
                                                                <ArrowUp className="w-3.5 h-3.5 text-primary" />
                                                            ) : filters.sort === 'price_desc' ? (
                                                                <ArrowDown className="w-3.5 h-3.5 text-primary" />
                                                            ) : (
                                                                <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground/40 opacity-0 group-hover/sort:opacity-100 transition-opacity" />
                                                            )}
                                                        </span>
                                                    </TableHead>
                                                    <TableHead
                                                        className="text-right cursor-pointer select-none group/sort"
                                                        onClick={() => {
                                                            setFilters(prev => ({
                                                                ...prev,
                                                                sort: prev.sort === 'stock_asc' ? 'stock_desc' : 'stock_asc'
                                                            }))
                                                        }}
                                                    >
                                                        <span className="inline-flex items-center gap-1.5 justify-end">
                                                            {t('products.table.stock')}
                                                            {filters.sort === 'stock_asc' ? (
                                                                <ArrowUp className="w-3.5 h-3.5 text-primary" />
                                                            ) : filters.sort === 'stock_desc' ? (
                                                                <ArrowDown className="w-3.5 h-3.5 text-primary" />
                                                            ) : (
                                                                <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground/40 opacity-0 group-hover/sort:opacity-100 transition-opacity" />
                                                            )}
                                                        </span>
                                                    </TableHead>
                                                    {(canEdit || canDelete || user?.role === 'viewer') && <TableHead className="text-right">{t('common.actions')}</TableHead>}
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                {tableProductRows.map(({ product, isPrimary, isVariant, hasVisibleVariants, isLastVariant }) => (
                                                    <ContextMenu key={product.id}>
                                                        <ContextMenuTrigger asChild>
                                                            <TableRow
                                                                onPointerDown={(event) => startStockRowHold(event, product)}
                                                                onPointerMove={moveStockRowHold}
                                                                onPointerUp={cancelStockRowHold}
                                                                onPointerCancel={cancelStockRowHold}
                                                                onContextMenu={(event) => {
                                                                    if (stockRowPointerTypeRef.current !== 'mouse') {
                                                                        event.preventDefault()
                                                                        event.stopPropagation()
                                                                    }
                                                                }}
                                                                className={cn(
                                                                isProductSelectionMode && selectedProductIds.has(product.id) && 'bg-primary/5',
                                                                isVariant && 'bg-primary/[0.02] hover:bg-primary/[0.05]',
                                                                hasProductCostWarning(product) && 'bg-destructive/10 hover:bg-destructive/15'
                                                            )}>
                                                                {isProductSelectionMode && (
                                                                    <TableCell>{(isBarcodeSelectionMode
                                                                        ? isProductSelectableForBarcodePrint(product)
                                                                        : !isService(product)) && <Checkbox
                                                                        id={`product-select-table-${product.id}`}
                                                                        checked={selectedProductIds.has(product.id)}
                                                                        onCheckedChange={() => toggleProductSelection(product.id)}
                                                                    />}</TableCell>
                                                                )}
                                                                <TableCell>
                                                                    <div className="flex items-center gap-1">
                                                                        {isPrimary && hasVisibleVariants && (
                                                                            <Button
                                                                                type="button"
                                                                                variant="ghost"
                                                                                size="icon"
                                                                                className="h-7 w-7 rounded-lg"
                                                                                aria-label={collapsedPrimaryProductIds.has(product.id)
                                                                                    ? t('products.variants.expand', { defaultValue: 'Show variants' })
                                                                                    : t('products.variants.collapse', { defaultValue: 'Hide variants' })}
                                                                                aria-expanded={!collapsedPrimaryProductIds.has(product.id)}
                                                                                onClick={() => setCollapsedPrimaryProductIds((current) => {
                                                                                    const next = new Set(current)
                                                                                    if (next.has(product.id)) {
                                                                                        next.delete(product.id)
                                                                                    } else {
                                                                                        next.add(product.id)
                                                                                    }
                                                                                    return next
                                                                                })}
                                                                            >
                                                                                {collapsedPrimaryProductIds.has(product.id) ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                                                            </Button>
                                                                        )}
                                                                        {hasProductCostWarning(product) && (
                                                                            <TooltipProvider>
                                                                                <Tooltip delayDuration={150}>
                                                                                    <TooltipTrigger asChild>
                                                                                        <span className="inline-flex cursor-help text-destructive" aria-label="Product cannot be sold without a cost">
                                                                                            <CircleAlert className="h-5 w-5" />
                                                                                        </span>
                                                                                    </TooltipTrigger>
                                                                                    <TooltipContent>{getProductCostWarningMessage(product)}</TooltipContent>
                                                                                </Tooltip>
                                                                            </TooltipProvider>
                                                                        )}
                                                                    </div>
                                                                </TableCell>
                                                                <TableCell className={cn('relative', isVariant && 'pl-9')}>
                                                                    {isVariant && <span aria-hidden="true" className={cn('pointer-events-none absolute start-3 top-0 w-4 border-b border-s border-border/60', isLastVariant ? 'h-1/2' : 'bottom-0')} />}
                                                                    <ProductAvatar
                                                                        productName={product.name}
                                                                        imageUrl={product.imageUrl}
                                                                        showImagePreviewOnHover
                                                                        previewSide={productImagePreviewSide}
                                                                        className="h-10 w-10 rounded-lg border-0 bg-muted"
                                                                        fallbackIconClassName="h-5 w-5 text-muted-foreground/30"
                                                                    />
                                                                </TableCell>
                                                                <TableCell className="font-mono text-sm">{product.sku}</TableCell>
                                                                <TableCell className="font-medium"><div className="flex items-center gap-2"><span>{product.name}</span>{isService(product) && <span className="inline-flex rounded-md border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-violet-700 dark:text-violet-300">{t('services.badge')}</span>}{isPrimary && <span className="inline-flex rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-primary">{t('products.variants.primary', { defaultValue: 'Primary' })}</span>}{isVariant && <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground"><GitBranch className="h-3 w-3" />{t('products.variants.variant', { defaultValue: 'Variant' })}</span>}</div></TableCell>
                                                                <TableCell>{getCategoryName(product.categoryId)}</TableCell>
                                                                <TableCell>{isService(product) ? '—' : (renderStorage(product.id) ?? getStorageName(product.storageId))}</TableCell>
                                                                {priceBooksEnabled && <TableCell>{renderPriceBooks(product.id)}</TableCell>}
                                                                <TableCell className="text-right">
                                                                    {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                                </TableCell>
                                                                <TableCell className="text-right">
                                                                    <span className={product.quantity <= product.minStockLevel ? 'font-medium text-amber-500' : ''}>
                                                                        {renderStockQuantity(product, '—')}
                                                                    </span>
                                                                </TableCell>
                                                                {(canEdit || canDelete || user?.role === 'viewer') && (
                                                                    <TableCell className="text-right">
                                                                        <div className="flex justify-end gap-2">
                                                                            {heldStockActionProductId === product.id && canEdit && !isService(product) && (
                                                                                <Button
                                                                                    type="button"
                                                                                    variant="secondary"
                                                                                    size="sm"
                                                                                    className="h-9 gap-2 rounded-xl px-3 font-bold text-primary"
                                                                                    onClick={() => {
                                                                                        setSelectedProductForStock(product.id)
                                                                                        setAdjustmentDialogOpen(true)
                                                                                        setHeldStockActionProductId(null)
                                                                                    }}
                                                                                >
                                                                                    <Boxes className="h-4 w-4" />
                                                                                    {t('products.addStock', { defaultValue: 'Add Stock' })}
                                                                                </Button>
                                                                            )}
                                                                            <Button
                                                                                variant="ghost"
                                                                                size="icon"
                                                                                allowViewer={!canEdit}
                                                                                aria-label={canEdit ? (t('common.edit') || 'Edit') : (t('common.view') || 'View')}
                                                                                onClick={() => openProductForm(product)}
                                                                            >
                                                                                {canEdit ? <Pencil className="h-4 w-4" /> : <Info className="h-4 w-4 text-primary" />}
                                                                            </Button>
                                                                            {canEdit && !isService(product) && (
                                                                                <Button variant="ghost" size="icon" aria-label={t('common.clone') || 'Clone'} onClick={() => handleCloneProduct(product)}>
                                                                                    <Copy className="h-4 w-4 text-primary" />
                                                                                </Button>
                                                                            )}
                                                                            {canDelete && (
                                                                                <Button variant="ghost" size="icon" aria-label={t('common.delete') || 'Delete'} onClick={() => handleDeleteProduct(product)}>
                                                                                    <Trash2 className="h-4 w-4 text-destructive" />
                                                                                </Button>
                                                                            )}
                                                                        </div>
                                                                    </TableCell>
                                                                )}
                                                            </TableRow>
                                                        </ContextMenuTrigger>
                                                        <ContextMenuContent>
                                                            {canEdit && !isService(product) && (
                                                                <ContextMenuItem className="gap-2" onSelect={() => { setSelectedProductForStock(product.id); setAdjustmentDialogOpen(true); }}>
                                                                    <Boxes className="h-4 w-4" />
                                                                    {t('products.addStock', { defaultValue: 'Add Stock' })}
                                                                </ContextMenuItem>
                                                            )}
                                                        </ContextMenuContent>
                                                    </ContextMenu>
                                                ))}
                                            </TableBody>
                                        </Table>
                                    )}
                                </>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>

            <CameraBarcodeScannerModal
                open={isCameraSearchScannerOpen}
                onOpenChange={setIsCameraSearchScannerOpen}
                modes={['single']}
                defaultMode="single"
                tabOptions={productsScannerTabOptions}
                defaultTabOptionId="barcode"
                tabOptionsLabel={t('products.cameraScanner.output', { defaultValue: 'Search value' })}
                onScan={handleProductsCameraScan}
                title={t('pos.cameraScanner.title', { defaultValue: 'Camera Barcode Scanner' })}
                selectedCameraId={selectedScannerCameraId}
                cameras={scannerCameras}
                onCameraChange={(cameraId) => {
                    setSelectedScannerCameraId(cameraId)
                    localStorage.setItem('scanner_camera_id', cameraId)
                }}
            />

            <PrintFlow
                isOpen={isBarcodePrintOpen}
                module="products"
                onClose={() => {
                    setIsBarcodePrintOpen(false)
                    setBarcodePrintProducts([])
                    setSelectedBarcodeLabelTemplate(null)
                }}
                title={t('products.barcodePrint.title', { defaultValue: 'Product barcode labels' })}
                showSaveButton={false}
                pdfBuilder={async ({ format, printLangOverride, effectiveId }) => {
                    if (format !== 'label' || !selectedBarcodeLabelLayout) {
                        throw new Error('Unsupported product barcode label format')
                    }
                    return buildSelectedBarcodeLabelPdf(selectedBarcodeLabelLayout, printLangOverride, effectiveId)
                }}
                printSelectionTemplates={barcodeLabelTemplateOptions}
                printSelectionOptions={[]}
                templatePreview={selectedBarcodeLabelTemplatePreview || undefined}
                customTemplate={selectedBarcodeLabelTemplate && selectedBarcodeLabelLayout ? {
                    moduleTypeKey: LABEL_PRINT_TEMPLATE_KEY,
                    nativeTemplateKey: LABEL_PRINT_TEMPLATE_KEY,
                    templateId: selectedBarcodeLabelTemplate.id,
                    label: getStoredCustomTemplateLabel(selectedBarcodeLabelTemplate)
                } : undefined}
                initialTemplateLayout={selectedBarcodeLabelLayout}
                generateTemplateLayoutBlob={selectedBarcodeLabelTemplate
                    ? (layout, printLangOverride, effectiveId) => buildSelectedBarcodeLabelPdf(layout, printLangOverride, effectiveId)
                    : undefined}
                allowTemplateFieldEditing={true}
                onPrintSelection={(format, template) => {
                    if (format === 'label' && template) {
                        setSelectedBarcodeLabelTemplate(template)
                    }
                }}
                onPreviewPrint={(blob) => printPdfBlob(blob, {
                    title: t('products.barcodePrint.title', { defaultValue: 'Product barcode labels' })
                })}
                previewPrintActionLabel={t('common.print', { defaultValue: 'Print' })}
            />

            <ProductCategoryManagerDialog
                open={isProductCategoryManagerOpen}
                onOpenChange={setIsProductCategoryManagerOpen}
                workspaceId={workspaceId}
            />

            <PriceBookManagementDialog
                open={isPriceBookDialogOpen}
                onOpenChange={setIsPriceBookDialogOpen}
                workspaceId={user?.workspaceId}
                createdBy={user?.id}
                enabled={priceBooksEnabled}
            />

            <Dialog open={branchCloneDialogOpen} onOpenChange={(open) => !isBranchCloning && setBranchCloneDialogOpen(open)}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{branchCloneDialogTitle}</DialogTitle>
                        <DialogDescription>{branchCloneDialogDescription}</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                        <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                            <div className="text-sm font-semibold">
                                {t('products.branchClone.selectedCount', {
                                    defaultValue: '{{count}} products selected',
                                    count: selectedProductsCount
                                })}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {branchCloneCountLabel}
                            </div>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="branch-clone-target">
                                {branchCloneTargetLabel}
                            </Label>
                            <Select value={selectedCloneTargetWorkspaceId} onValueChange={setSelectedCloneTargetWorkspaceId}>
                                <SelectTrigger id="branch-clone-target">
                                    <SelectValue placeholder={branchCloneTargetPlaceholder} />
                                </SelectTrigger>
                                <SelectContent>
                                    {cloneTargets.map((target) => (
                                        <SelectItem key={target.workspaceId} value={target.workspaceId}>
                                            {getCloneTargetLabel(target)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="branch-clone-storage">
                                {t('products.branchClone.storageLabel', { defaultValue: 'Target Storage' })}
                            </Label>
                            <Select
                                value={selectedCloneTargetStorageId}
                                onValueChange={setSelectedCloneTargetStorageId}
                                disabled={!selectedCloneTarget}
                            >
                                <SelectTrigger id="branch-clone-storage">
                                    <SelectValue placeholder={t('products.branchClone.storagePlaceholder', { defaultValue: 'Select a storage' })} />
                                </SelectTrigger>
                                <SelectContent>
                                    {(selectedCloneTarget?.storages ?? []).map((storage) => (
                                        <SelectItem key={storage.id} value={storage.id}>
                                            {storage.name}
                                            {storage.is_primary
                                                ? ` (${t('products.branchClone.primaryStorageTag', { defaultValue: 'Primary' })})`
                                                : ''}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {selectedCloneTarget && selectedCloneTarget.storages.length === 0 && (
                                <p className="text-xs text-destructive">
                                    {t('products.branchClone.noStorages', {
                                        defaultValue: 'No active storages are available in the selected destination.'
                                    })}
                                </p>
                            )}
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => setBranchCloneDialogOpen(false)} disabled={isBranchCloning}>
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button
                            type="button"
                            className="gap-2"
                            onClick={handleCloneProductsToBranch}
                            disabled={!selectedCloneTargetWorkspaceId || !selectedCloneTargetStorageId || selectedProductsCount === 0 || isBranchCloning}
                        >
                            {isBranchCloning ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <GitBranch className="h-4 w-4" />
                            )}
                            {t('products.branchClone.confirm', { defaultValue: 'Clone Products' })}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DeleteConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                onConfirm={confirmDelete}
                itemName={itemToDelete?.name}
                isLoading={isLoading}
                title={t('products.confirmDelete')}
                description={deleteConfirmationDescription}
            />

            <Dialog open={isFilterDialogOpen} onOpenChange={setIsFilterDialogOpen}>
                <DialogContent className="top-[calc(50%+var(--titlebar-height)/2+var(--safe-area-top)/2)] w-[calc(100vw-0.75rem)] max-w-4xl overflow-hidden p-0 sm:w-[calc(100vw-2rem)] rounded-[2rem] border-border/60">
                    <div className="flex max-h-[calc(100dvh-var(--titlebar-height)-var(--safe-area-top)-var(--safe-area-bottom)-1rem)] flex-col">
                        <DialogHeader className="border-b border-border/60 px-6 py-5 text-start bg-gradient-to-r from-primary/8 via-background to-emerald-500/5">
                            <DialogTitle className="flex items-center gap-3 text-xl font-black tracking-tight">
                                <div className="p-2.5 rounded-2xl bg-primary/10 text-primary">
                                    <SlidersHorizontal className="h-5 w-5" />
                                </div>
                                {t('products.filters.dialogTitle', { defaultValue: 'Product Filters' })}
                            </DialogTitle>
                            <DialogDescription className="max-w-3xl">
                                {t('products.filters.dialogDescription', { defaultValue: 'Refine the product catalog with a richer filter set.' })}
                            </DialogDescription>
                        </DialogHeader>

                        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
                            <section className="grid gap-4 lg:grid-cols-2">
                                <div className="space-y-4 p-5 rounded-[1.5rem] border border-border/60 bg-background/80">
                                    <div className="space-y-1">
                                        <h3 className="text-base font-black tracking-tight">{t('products.filters.sortTitle', { defaultValue: 'Sort & Category' })}</h3>
                                    </div>

                                    <div className="space-y-2">
                                        <Label>{t('products.filters.sortBy', { defaultValue: 'Sort By' })}</Label>
                                        <Select value={draftFilters.sort} onValueChange={(value: ProductSortOption) => setDraftFilters((current) => ({ ...current, sort: value }))}>
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="name_asc">{t('products.filters.sortNameAsc', { defaultValue: 'Name: A → Z' })}</SelectItem>
                                                <SelectItem value="name_desc">{t('products.filters.sortNameDesc', { defaultValue: 'Name: Z → A' })}</SelectItem>
                                                <SelectItem value="sku_asc">{t('products.filters.sortSkuAsc', { defaultValue: 'SKU: A → Z' })}</SelectItem>
                                                <SelectItem value="sku_desc">{t('products.filters.sortSkuDesc', { defaultValue: 'SKU: Z → A' })}</SelectItem>
                                                <SelectItem value="price_asc">{t('products.filters.sortPriceAsc', { defaultValue: 'Price: Low to High' })}</SelectItem>
                                                <SelectItem value="price_desc">{t('products.filters.sortPriceDesc', { defaultValue: 'Price: High to Low' })}</SelectItem>
                                                <SelectItem value="stock_asc">{t('products.filters.sortStockAsc', { defaultValue: 'Stock: Low to High' })}</SelectItem>
                                                <SelectItem value="stock_desc">{t('products.filters.sortStockDesc', { defaultValue: 'Stock: High to Low' })}</SelectItem>
                                                <SelectItem value="date_asc">{t('products.filters.sortDateAsc', { defaultValue: 'Date: Oldest First' })}</SelectItem>
                                                <SelectItem value="date_desc">{t('products.filters.sortDateDesc', { defaultValue: 'Date: Newest First' })}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div className="space-y-2">
                                        <Label>{t('products.filters.category', { defaultValue: 'Category' })}</Label>
                                        <ProductFilterMultiSelect
                                            value={draftFilters.category}
                                            options={[
                                                ...categories.map((category) => ({ value: category.id, label: category.name })),
                                                ...draftFilters.category
                                                    .filter((categoryId) => !categories.some((category) => category.id === categoryId))
                                                    .map((categoryId) => ({ value: categoryId, label: categoryId })),
                                            ]}
                                            allLabel={t('products.filters.allCategories', { defaultValue: 'All Categories' })}
                                            multipleLabel={t('products.filters.selectedCount', { count: draftFilters.category.length, defaultValue: '{{count}} selected' })}
                                            onChange={(category) => setDraftFilters((current) => ({ ...current, category }))}
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <Label>{t('products.filters.storage', { defaultValue: 'Storage' })}</Label>
                                        <ProductFilterMultiSelect
                                            value={draftFilters.storage}
                                            options={[
                                                ...storages.map((storage) => ({ value: storage.id, label: storage.name })),
                                                ...draftFilters.storage
                                                    .filter((storageId) => !storages.some((storage) => storage.id === storageId))
                                                    .map((storageId) => ({ value: storageId, label: storageId })),
                                            ]}
                                            allLabel={t('products.filters.allStorages', { defaultValue: 'All Storages' })}
                                            multipleLabel={t('products.filters.selectedCount', { count: draftFilters.storage.length, defaultValue: '{{count}} selected' })}
                                            onChange={(storage) => setDraftFilters((current) => ({ ...current, storage }))}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-4 p-5 rounded-[1.5rem] border border-border/60 bg-background/80">
                                    <div className="space-y-1">
                                        <h3 className="text-base font-black tracking-tight">{t('products.filters.pricingTitle', { defaultValue: 'Price, Currency & Stock' })}</h3>
                                    </div>

                                    <div className="space-y-2">
                                        <CurrencySelector
                                            multiple
                                            label={t('products.filters.currency', { defaultValue: 'Currency' })}
                                            value={draftFilters.currency}
                                            allowedCurrencies={Array.from(new Set([
                                                ...products.map((product) => product.currency),
                                                ...draftFilters.currency,
                                            ]))}
                                            allLabel={t('products.filters.allCurrencies', { defaultValue: 'All Currencies' })}
                                            multipleLabel={t('products.filters.selectedCount', { count: draftFilters.currency.length, defaultValue: '{{count}} selected' })}
                                            onChange={(currency) => setDraftFilters((current) => ({ ...current, currency }))}
                                        />
                                    </div>

                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label>{t('products.filters.minPrice', { defaultValue: 'Min Price' })}</Label>
                                            <Input
                                                type="number"
                                                min="0"
                                                value={draftFilters.minPrice}
                                                onChange={(event) => setDraftFilters((current) => ({ ...current, minPrice: event.target.value }))}
                                                placeholder="0"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label>{t('products.filters.maxPrice', { defaultValue: 'Max Price' })}</Label>
                                            <Input
                                                type="number"
                                                min="0"
                                                value={draftFilters.maxPrice}
                                                onChange={(event) => setDraftFilters((current) => ({ ...current, maxPrice: event.target.value }))}
                                                placeholder={t('products.filters.noCap', { defaultValue: 'No cap' })}
                                            />
                                        </div>
                                    </div>

                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label>{t('products.filters.minStock', { defaultValue: 'Min Stock' })}</Label>
                                            <Input
                                                type="number"
                                                min="0"
                                                value={draftFilters.minStock}
                                                onChange={(event) => setDraftFilters((current) => ({ ...current, minStock: event.target.value }))}
                                                placeholder="0"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label>{t('products.filters.maxStock', { defaultValue: 'Max Stock' })}</Label>
                                            <Input
                                                type="number"
                                                min="0"
                                                value={draftFilters.maxStock}
                                                onChange={(event) => setDraftFilters((current) => ({ ...current, maxStock: event.target.value }))}
                                                placeholder={t('products.filters.noCap', { defaultValue: 'No cap' })}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </section>
                        </div>

                        <DialogFooter className="border-t border-border/60 bg-background/95 px-6 py-4 sm:justify-between">
                            <Button type="button" variant="ghost" onClick={() => setDraftFilters(DEFAULT_PRODUCT_FILTERS)} className="rounded-2xl">
                                <RotateCcw className="me-2 h-4 w-4" />
                                {t('products.filters.reset', { defaultValue: 'Reset Draft' })}
                            </Button>
                            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
                                <Button type="button" variant="outline" onClick={() => setIsFilterDialogOpen(false)} className="rounded-2xl">
                                    {t('common.cancel', { defaultValue: 'Cancel' })}
                                </Button>
                                <Button type="button" onClick={handleApplyFilters} className="rounded-2xl">
                                    {t('products.filters.apply', { defaultValue: 'Apply Filters' })}
                                </Button>
                            </div>
                        </DialogFooter>
                    </div>
                </DialogContent>
            </Dialog>

            <StockAdjustmentDialog
                open={adjustmentDialogOpen}
                onOpenChange={(open) => {
                    setAdjustmentDialogOpen(open)
                    if (!open) setSelectedProductForStock(undefined)
                }}
                preselectedProductId={selectedProductForStock}
                allowAnyStorage
                products={products.filter((product) => !isService(product))}
                storages={storages}
                inventory={inventoryRows}
                workspaceId={workspaceId}
                userId={user?.id ?? null}
            />
        </div>
    )
}
