import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useRoute } from 'wouter'
import {
    ArrowLeft,
    Barcode,
    Boxes,
    Camera,
    ChevronRight,
    Shuffle,
    DollarSign,
    FileText,
    Images,
    ImagePlus,
    Info,
    Link,
    LoaderCircle,
    Package,
    Plus,
    Ruler,
    Save,
    Settings,
    Tag,
    Trash2,
    Type,
    Wallet,
    Warehouse
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'

import { useAuth } from '@/auth'
import {
    addProductBarcode,
    createProduct,
    db,
    deleteProduct,
    deleteProductBarcode,
    DuplicateProductBarcodeError,
    DuplicateProductSkuError,
    fetchTableFromSupabase,
    findActiveProductBySku,
    getPrimaryStorageFromList,
    replaceProductCommissionRule,
    replaceProductPriceBookItems,
    replaceProductPriceBookUnitPrices,
    replaceProductUnitConversion,
    syncProductBarcodeCachesForWorkspace,
    updateProductBarcode,
    updateProduct,
    useCategories,
    usePriceBookCatalogState,
    usePriceBookUnitPrices,
    useProductCommissionCatalogState,
    useProduct,
    useProductBarcodes,
    useProducts,
    useProductVariants,
    useStorages,
    useUnits,
    useUnitRelationships,
    useProductUnitConversions,
    type Product,
    type ProductBarcode,
    type PriceBookItem
} from '@/local-db'
import { hasEffectiveSalesAgentCommissionPermission, useWorkspacePermissions } from '@/permissions'
import type { CurrencyCode } from '@/local-db/models'
import { assetManager } from '@/lib/assetManager'
import { normalizeBarcodeDigits, normalizeBarcodeScannerText } from '@/lib/barcodeScanner'
import { getClipboardImageFile } from '@/lib/clipboardImage'
import {
    getProductImageDisplayUrl,
    importProductImageFromUrl,
    isProductImagePath,
    ProductImageStorageError,
    storeProductImageFile
} from '@/lib/productImageStorage'
import { generateRandomUpc } from '@/lib/upc'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { useNetworkStatus } from '@/hooks/useNetworkStatus'
import { isMobile, isTauri } from '@/lib/platform'
import { roundQuantity } from '@/lib/quantity'
import { cn, formatCurrency } from '@/lib/utils'
import { getInventoryRowsForProduct } from '@/local-db/inventory'
import { platformService } from '@/services/platformService'
import { useWorkspace } from '@/workspace'
import { useHideCosts } from '@/permissions'
import { isLocalWorkspaceMode } from '@/workspace/workspaceMode'
import { normalizeUnitCode } from '@/local-db/models'
import { buildProductUnitSelectionOptions } from '@/lib/unitRelationships'
import { BarcodeScannerToggleButton } from '@/ui/components/BarcodeScannerToggleButton'
import { ProductUnitIcon } from '@/ui/components/ProductUnitIcon'
import { ProductUnitPackagingSection } from '@/ui/components/products/ProductUnitPackagingSection'
import {
    EMPTY_PRODUCT_UNIT_PACKAGING,
    type ProductUnitPackagingDraft
} from '@/ui/components/products/productUnitPackaging'
import { ProductAdditionalImagesModal } from '@/ui/components/ProductAdditionalImagesModal'
import { ProductVariantParentNotice, ProductVariantsSection } from '@/ui/components/ProductVariantsSection'
import { useUnitRegistry } from '@/ui/components/unitRegistry'
import { useDemoTutorial } from '@/demo'
import {
    ProductPriceBookItemsEditor,
    type ProductPriceBookDraft
} from '@/ui/components/ProductPriceBookItemsEditor'
import {
    ProductCommissionRuleEditor,
    emptyProductCommissionRuleDraft,
    type ProductCommissionRuleDraft
} from '@/ui/components/commissions/ProductCommissionRuleEditor'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CurrencySelector,
    DeleteConfirmationModal,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    HoverHintVideo,
    Input,
    Label,
    NumericInput,
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

type ProductScannerTarget = 'none' | 'sku' | 'barcode' | 'variantSku'

const PRODUCT_SCANNER_TARGET_KEY = 'products_scanner_target'
const PRODUCT_SKU_SCANNER_ENABLED_KEY = 'products_sku_scanner_enabled'
const PRODUCT_BARCODE_SCANNER_ENABLED_KEY = 'products_barcode_scanner_enabled'
const PRODUCT_VARIANT_SKU_SCANNER_ENABLED_KEY = 'products_variant_sku_scanner_enabled'
const PRODUCT_SKU_HID_DEVICE_KEY = 'products_sku_hid_device_id'
const PRODUCT_BARCODE_HID_DEVICE_KEY = 'products_barcode_hid_device_id'
const PRODUCT_FORM_SCANNER_IDLE_COMMIT_DELAY_MS = 1200

type ProductFormMode = 'create' | 'edit' | 'clone'

type ProductFormData = {
    sku: string
    name: string
    description: string
    categoryId: string | undefined
    price: string
    costPrice: string
    quantity: number | ''
    minStockLevel: number | ''
    unit: string
    perQuantity: string
    currency: CurrencyCode
    imageUrl: string
    canBeReturned: boolean
    returnRules: string
    storageId: string
}

function mapPriceBookItemsToDrafts(
    items: PriceBookItem[],
    unitPrices: Array<{ priceBookId: string; price: number }> = []
): ProductPriceBookDraft[] {
    const parentPriceByBook = new Map(unitPrices.map((row) => [row.priceBookId, row.price]))
    return [...items]
        .sort((left, right) => left.priceBookId.localeCompare(right.priceBookId))
        .map((item) => ({
            priceBookId: item.priceBookId,
            costPrice: item.costPrice == null ? '' : String(item.costPrice),
            price: String(item.price),
            parentPrice: parentPriceByBook.has(item.priceBookId)
                ? String(parentPriceByBook.get(item.priceBookId))
                : '',
            currency: item.currency
        }))
}

function serializePriceBookDrafts(rows: ProductPriceBookDraft[]) {
    return JSON.stringify(
        rows
            .map((row) => ({
                priceBookId: row.priceBookId,
                costPrice: row.costPrice.trim() === '' ? null : Number(row.costPrice),
                price: row.price.trim() === '' ? null : Number(row.price),
                parentPrice: row.parentPrice?.trim() === '' ? null : Number(row.parentPrice),
                currency: row.currency
            }))
            .sort((left, right) => left.priceBookId.localeCompare(right.priceBookId))
    )
}

const emptyProductFormData: ProductFormData = {
    sku: '',
    name: '',
    description: '',
    categoryId: undefined,
    price: '',
    costPrice: '',
    quantity: '',
    minStockLevel: 0,
    unit: 'pcs',
    perQuantity: '1',
    currency: 'usd',
    imageUrl: '',
    canBeReturned: true,
    returnRules: '',
    storageId: ''
}

function readStoredBoolean(key: string) {
    if (typeof localStorage === 'undefined') {
        return false
    }

    return localStorage.getItem(key) === 'true'
}

function writeStoredBoolean(key: string, value: boolean) {
    if (typeof localStorage === 'undefined') {
        return
    }

    localStorage.setItem(key, String(value))
}

function readStoredScannerTarget(): ProductScannerTarget {
    if (typeof localStorage === 'undefined') {
        return 'none'
    }

    const storedTarget = localStorage.getItem(PRODUCT_SCANNER_TARGET_KEY)
    if (storedTarget === 'sku' || storedTarget === 'barcode') {
        return storedTarget
    }

    if (readStoredBoolean(PRODUCT_SKU_SCANNER_ENABLED_KEY)) {
        return 'sku'
    }

    if (readStoredBoolean(PRODUCT_BARCODE_SCANNER_ENABLED_KEY)) {
        return 'barcode'
    }

    return 'none'
}

function writeStoredScannerTarget(target: ProductScannerTarget) {
    if (typeof localStorage === 'undefined') {
        return
    }

    localStorage.setItem(PRODUCT_SCANNER_TARGET_KEY, target)
    localStorage.setItem(PRODUCT_SKU_SCANNER_ENABLED_KEY, String(target === 'sku'))
    localStorage.setItem(PRODUCT_BARCODE_SCANNER_ENABLED_KEY, String(target === 'barcode'))
}

function getCurrencySymbol(currency: string, iqdPreference: string) {
    switch (currency.toLowerCase()) {
        case 'usd':
            return '$'
        case 'eur':
            return 'EUR'
        case 'try':
            return 'TRY'
        case 'iqd':
            return iqdPreference
        default:
            return currency.toUpperCase()
    }
}

function createInitialFormData(defaultCurrency: CurrencyCode, defaultStorageId: string): ProductFormData {
    return {
        ...emptyProductFormData,
        currency: defaultCurrency,
        storageId: defaultStorageId
    }
}

function mapProductToFormData(product: Product, hideCosts = false): ProductFormData {
    return {
        sku: product.sku,
        name: product.name,
        description: product.description,
        categoryId: product.categoryId || undefined,
        price: String(product.price),
        // A restricted user must never receive an existing product cost in
        // form state; edit saves intentionally omit the field below.
        costPrice: hideCosts || product.costPrice == null ? '' : String(product.costPrice),
        quantity: product.quantity,
        minStockLevel: product.minStockLevel,
        // A product row that reached the local cache without a unit (possible
        // for edits loaded offline where the fresh Supabase pull never runs)
        // must never map to the placeholder. Fall back to the built-in default
        // so the Radix SelectValue never shows a bare "Select unit" trigger.
        unit: normalizeUnitCode(product.unit) || 'pcs',
        perQuantity: '1',
        currency: product.currency,
        imageUrl: isProductImagePath(product.imageUrl) ? product.imageUrl : '',
        canBeReturned: product.canBeReturned ?? true,
        returnRules: product.returnRules || '',
        storageId: product.storageId || ''
    }
}

function ProductEditor({ mode, productId }: { mode: ProductFormMode; productId?: string }) {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { features, hasCapability, hasFeature } = useWorkspace()
    const { permissionKeys } = useWorkspacePermissions()
    const hideCosts = useHideCosts()
    const [, navigate] = useLocation()
    const { toast } = useToast()
    const demoTutorial = useDemoTutorial()
    const categories = useCategories(user?.workspaceId)
    const storages = useStorages(user?.workspaceId)
    const product = useProduct(productId)
    const parentProduct = useProduct(product?.parentProductId || undefined)
    const isOnline = useNetworkStatus()
    const workspaceId = user?.workspaceId || ''
    const { isDynamicUnit, options: unitOptions } = useUnitRegistry(workspaceId)
    const customUnits = useUnits(workspaceId)
    const unitRelationships = useUnitRelationships(workspaceId || undefined)
    const productUnitConversions = useProductUnitConversions(workspaceId || undefined)
    const priceBookUnitPrices = usePriceBookUnitPrices(workspaceId || undefined)
    const priceBooksEnabled = hasCapability('priceBooks')
    const productCommissionsEnabled = hasFeature('sales_agent_commissions')
        && hasEffectiveSalesAgentCommissionPermission(user?.role, permissionKeys, 'salesAgentCommissions.managePlans')
    const {
        rules: productCommissionRules,
        recipients: productCommissionRuleAgents,
        isReady: isProductCommissionCatalogReady,
        error: productCommissionCatalogError
    } = useProductCommissionCatalogState(workspaceId || undefined, productCommissionsEnabled)
    const sourcePriceBookProductId = mode === 'create' ? undefined : product?.id
    const {
        priceBooks,
        priceBookItems,
        isReady: isPriceBookCatalogReady,
        error: priceBookCatalogError
    } = usePriceBookCatalogState(
        priceBooksEnabled ? workspaceId || undefined : undefined,
        { enabled: priceBooksEnabled }
    )
    const sourcePriceBookItems = useMemo(
        () => sourcePriceBookProductId
            ? priceBookItems.filter((item) => item.productId === sourcePriceBookProductId)
            : [],
        [priceBookItems, sourcePriceBookProductId]
    )
    const sourcePriceBookUnitPrices = useMemo(
        () => sourcePriceBookProductId
            ? priceBookUnitPrices.filter((item) => item.productId === sourcePriceBookProductId)
            : [],
        [priceBookUnitPrices, sourcePriceBookProductId]
    )
    const sourceProductCommissionRule = useMemo(() => (product?.id
        ? productCommissionRules
            .filter((rule) => rule.productId === product.id && rule.isActive && !rule.effectiveTo)
            .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0]
        : undefined), [product?.id, productCommissionRules])
    const sourceProductCommissionAgentIds = useMemo(() => sourceProductCommissionRule
        ? productCommissionRuleAgents.filter((row) => row.ruleId === sourceProductCommissionRule.id).map((row) => row.agentId)
        : [], [productCommissionRuleAgents, sourceProductCommissionRule])
    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const isClone = mode === 'clone'
    const isEditing = mode === 'edit'
    const isReadOnly = isEditing && !canEdit
    const highlightMissingCosts = isEditing && !isReadOnly && !hideCosts
    const catalogProducts = useProducts(workspaceId, { syncBarcodeCache: false })
    const productVariants = useProductVariants(isEditing && !product?.parentProductId ? product?.id : undefined)
    const canEditStockAllocation = mode !== 'edit'
    const isDesktopShell = isTauri()
    const persistedProductId = isEditing ? product?.id : undefined
    const productBarcodes = useProductBarcodes(persistedProductId)

    const productInventoryRows = useLiveQuery(
        async () => {
            if (!persistedProductId) return []
            return getInventoryRowsForProduct(persistedProductId)
        },
        [persistedProductId]
    )

    const productStorages = useMemo(() => {
        if (!productInventoryRows || productInventoryRows.length === 0) return []
        const map = new Map<string, number>()
        for (const row of productInventoryRows) {
            const storage = storages.find((s) => s.id === row.storageId)
            if (!storage) continue
            const current = map.get(storage.name) ?? 0
            map.set(storage.name, current + row.quantity)
        }
        return Array.from(map.entries()).map(([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity)
    }, [productInventoryRows, storages])

    const [formData, setFormData] = useState<ProductFormData>(() =>
        createInitialFormData(
            features.default_currency,
            mode === 'create' ? '' : (getPrimaryStorageFromList(storages)?.id || '')
        )
    )
    const [priceBookRows, setPriceBookRows] = useState<ProductPriceBookDraft[]>([])
    const [unitPackaging, setUnitPackaging] = useState<ProductUnitPackagingDraft>(EMPTY_PRODUCT_UNIT_PACKAGING)
    const [productCommissionDraft, setProductCommissionDraft] = useState<ProductCommissionRuleDraft>(() => emptyProductCommissionRuleDraft(features.default_currency))
    const [isSaving, setIsSaving] = useState(false)
    const [overrideAttention, setOverrideAttention] = useState(false)
    const [imageError, setImageError] = useState(false)
    const [externalImageUrl, setExternalImageUrl] = useState('')
    const [isImageProcessing, setIsImageProcessing] = useState(false)
    const [storageError, setStorageError] = useState(false)
    const [returnRulesModalOpen, setReturnRulesModalOpen] = useState(false)
    const [visualsModalOpen, setVisualsModalOpen] = useState(false)
    const [additionalImagesModalOpen, setAdditionalImagesModalOpen] = useState(false)
    const [missingProductStateVisible, setMissingProductStateVisible] = useState(false)
    const [productHydrationResolved, setProductHydrationResolved] = useState(false)
    const [newBarcodeValue, setNewBarcodeValue] = useState('')
    const [newBarcodeLabel, setNewBarcodeLabel] = useState('')
    const [isSubmittingBarcode, setIsSubmittingBarcode] = useState(false)
    const [barcodeToDelete, setBarcodeToDelete] = useState<ProductBarcode | null>(null)
    const [isDeletingBarcode, setIsDeletingBarcode] = useState(false)
    const [deleteProductOpen, setDeleteProductOpen] = useState(false)
    const [isDeletingProduct, setIsDeletingProduct] = useState(false)
    const [isGeneratingSku, setIsGeneratingSku] = useState(false)
    const [activeScannerTarget, setActiveScannerTarget] = useState<ProductScannerTarget>(() => readStoredScannerTarget())
    const [variantSkuScannerPreference, setVariantSkuScannerPreference] = useState(() => readStoredBoolean(PRODUCT_VARIANT_SKU_SCANNER_ENABLED_KEY))
    const skuInputRef = useRef<HTMLInputElement>(null)
    const isGeneratingSkuRef = useRef(false)
    const storageTriggerRef = useRef<HTMLButtonElement>(null)
    const overrideSectionRef = useRef<HTMLDivElement>(null)
    const newBarcodeInputRef = useRef<HTMLInputElement>(null)
    const cameraInputRef = useRef<HTMLInputElement>(null)
    const imageUploadInputRef = useRef<HTMLInputElement>(null)
    const pendingImportedImagePathRef = useRef<string | null>(null)
    const initializedKeyRef = useRef<string | null>(null)
    const initialFormSnapshotRef = useRef<string | null>(null)
    const initializedPriceBookRowsKeyRef = useRef<string | null>(null)
    const initialPriceBookRowsSnapshotRef = useRef<string | null>(null)
    const initializedUnitPackagingKeyRef = useRef<string | null>(null)
    const initialUnitPackagingSnapshotRef = useRef<string | null>(null)
    const initializedProductCommissionRuleKeyRef = useRef<string | null>(null)
    const initialProductCommissionSnapshotRef = useRef<string | null>(null)
    const createdProductIdRef = useRef<string | null>(null)

    const isProductDirty = useMemo(() => {
        if (!initialFormSnapshotRef.current || isReadOnly) {
            return false
        }

        const currentStr = JSON.stringify(formData)
        if (currentStr === initialFormSnapshotRef.current) {
            return false
        }

        try {
            const snapshot = JSON.parse(initialFormSnapshotRef.current)
            const keys = Object.keys(formData) as (keyof ProductFormData)[]

            for (const key of keys) {
                let v1: any = formData[key]
                let v2: any = snapshot[key]

                // normalize empty representations
                if (v1 === '' || v1 === undefined) v1 = null
                if (v2 === '' || v2 === undefined) v2 = null

                // string-based comparison for values that might be coerced
                if (v1 !== null && v2 !== null) {
                    if (String(v1) !== String(v2)) {
                        return true
                    }
                } else if (v1 !== v2) {
                    return true
                }
            }
            return false
        } catch {
            return currentStr !== initialFormSnapshotRef.current
        }
    }, [formData, isReadOnly])

    const arePriceBookRowsDirty = useMemo(() => {
        if (!priceBooksEnabled || isReadOnly || initialPriceBookRowsSnapshotRef.current === null) {
            return false
        }

        return serializePriceBookDrafts(priceBookRows) !== initialPriceBookRowsSnapshotRef.current
    }, [isReadOnly, priceBookRows, priceBooksEnabled])

    const isProductCommissionDirty = useMemo(() => (
        productCommissionsEnabled
        && !isReadOnly
        && initialProductCommissionSnapshotRef.current !== null
        && JSON.stringify(productCommissionDraft) !== initialProductCommissionSnapshotRef.current
    ), [isReadOnly, productCommissionDraft, productCommissionsEnabled])

    const isUnitPackagingDirty = !isReadOnly
        && initialUnitPackagingSnapshotRef.current !== null
        && JSON.stringify(unitPackaging) !== initialUnitPackagingSnapshotRef.current

    const productCommissionValidationMessage = useMemo(() => {
        if (!productCommissionsEnabled || !productCommissionDraft.enabled) return null
        const amount = Number(productCommissionDraft.amount)
        if (!Number.isFinite(amount) || amount <= 0 || (productCommissionDraft.commissionType === 'percentage' && amount > 100)) {
            return t('salesAgentCommissions.productCommission.invalidAmount')
        }
        if (productCommissionDraft.recipientScope === 'selected_assigned' && productCommissionDraft.agentIds.length === 0) {
            return t('salesAgentCommissions.productCommission.invalidRecipients')
        }
        return null
    }, [productCommissionDraft, productCommissionsEnabled, t])

    const isDirty = isProductDirty || arePriceBookRowsDirty || isProductCommissionDirty || isUnitPackagingDirty

    const { showGuard, confirmNavigation, cancelNavigation, requestNavigation } = useUnsavedChangesGuard(isDirty)

    useEffect(() => {
        createdProductIdRef.current = null
    }, [mode, productId])

    useEffect(() => () => {
        const pendingPath = pendingImportedImagePathRef.current
        if (!pendingPath) return
        assetManager.deleteAsset(pendingPath).catch((error) =>
            console.error('[Products] Failed to clean up abandoned imported image:', error)
        )
    }, [])

    useEffect(() => {
        setProductHydrationResolved(false)
    }, [mode, productId])

    useEffect(() => {
        if (!canEdit && mode !== 'edit') {
            navigate('/products')
        }
    }, [canEdit, mode, navigate])

    useEffect(() => {
        if (mode === 'create' || product) {
            setMissingProductStateVisible(false)
            setProductHydrationResolved(true)
            return
        }

        if (!productHydrationResolved) {
            setMissingProductStateVisible(false)
            return
        }

        const timer = window.setTimeout(() => setMissingProductStateVisible(true), 500)
        return () => window.clearTimeout(timer)
    }, [mode, product, productHydrationResolved])

    // Self-hydrate the target product from Supabase when the local cache does
    // not have it yet. The edit page must not depend on another page having
    // already pulled the products table, otherwise a direct or repeated open
    // can leave the page in a permanent "loading"/not-found state.
    useEffect(() => {
        let cancelled = false

        const hydrateProduct = async () => {
            if (mode === 'create' || product) {
                setProductHydrationResolved(true)
                return
            }

            if (!workspaceId || isLocalWorkspaceMode(workspaceId) || !isOnline) {
                setProductHydrationResolved(true)
                return
            }

            try {
                await fetchTableFromSupabase('products', db.products, workspaceId)
                if (cancelled) return
                await syncProductBarcodeCachesForWorkspace(workspaceId)
            } catch (error) {
                if (!cancelled) {
                    console.error('[ProductForm] Failed to hydrate product:', error)
                }
            } finally {
                if (!cancelled) {
                    setProductHydrationResolved(true)
                }
            }
        }

        void hydrateProduct()

        return () => {
            cancelled = true
        }
    }, [isOnline, mode, product, productId, workspaceId])

    useEffect(() => {
        const nextKey = mode === 'create'
            ? `create:${hideCosts ? 'hidden' : 'visible'}`
            : product
                ? `${mode}:${product.id}:${product.updatedAt}:${hideCosts ? 'hidden' : 'visible'}`
                : null

        if (!nextKey || initializedKeyRef.current === nextKey) {
            return
        }

        let nextFormData: ProductFormData

        if (mode === 'create') {
            nextFormData = createInitialFormData(features.default_currency, '')
        } else {
            if (!product) {
                return
            }

            nextFormData = mapProductToFormData(product, hideCosts)
        }

        setFormData(nextFormData)
        setImageError(false)
        initialFormSnapshotRef.current = JSON.stringify(nextFormData)
        initializedKeyRef.current = nextKey
    }, [features.default_currency, hideCosts, mode, product, storages])

    useEffect(() => {
        const sourceKey = mode === 'create' ? 'create' : product ? `${mode}:${product.id}` : null
        if (!sourceKey) return
        const source = mode === 'create'
            ? undefined
            : productUnitConversions.find((row) => row.productId === product?.id && !row.isDeleted)
        const next = source ? {
            relationshipId: source.relationshipId,
            factor: String(source.factor),
            parentPrice: String(source.parentPrice)
        } : EMPTY_PRODUCT_UNIT_PACKAGING
        if (initializedUnitPackagingKeyRef.current === sourceKey) {
            const emptySnapshot = JSON.stringify(EMPTY_PRODUCT_UNIT_PACKAGING)
            if (
                source
                && initialUnitPackagingSnapshotRef.current === emptySnapshot
                && JSON.stringify(unitPackaging) === emptySnapshot
            ) {
                setUnitPackaging(next)
                initialUnitPackagingSnapshotRef.current = JSON.stringify(next)
            }
            return
        }
        setUnitPackaging(next)
        initialUnitPackagingSnapshotRef.current = JSON.stringify(next)
        initializedUnitPackagingKeyRef.current = sourceKey
    }, [mode, product, productUnitConversions, unitPackaging])

    useEffect(() => {
        if (!priceBooksEnabled || !isPriceBookCatalogReady) {
            return
        }

        const sourceKey = mode === 'create'
            ? 'create'
            : product
                ? `${mode}:${product.id}`
                : null

        if (!sourceKey) {
            return
        }

        const nextRows = mode === 'create'
            ? []
            : mapPriceBookItemsToDrafts(sourcePriceBookItems, sourcePriceBookUnitPrices)
        const nextSnapshot = serializePriceBookDrafts(nextRows)

        if (initializedPriceBookRowsKeyRef.current !== sourceKey) {
            setPriceBookRows(nextRows)
            initialPriceBookRowsSnapshotRef.current = nextSnapshot
            initializedPriceBookRowsKeyRef.current = sourceKey
            return
        }

        const currentSnapshot = serializePriceBookDrafts(priceBookRows)
        const rowsWereEdited = initialPriceBookRowsSnapshotRef.current !== null
            && currentSnapshot !== initialPriceBookRowsSnapshotRef.current
        if (!rowsWereEdited && nextSnapshot !== initialPriceBookRowsSnapshotRef.current) {
            setPriceBookRows(nextRows)
            initialPriceBookRowsSnapshotRef.current = nextSnapshot
        }
    }, [
        isPriceBookCatalogReady,
        mode,
        priceBookRows,
        priceBooksEnabled,
        product,
        sourcePriceBookItems,
        sourcePriceBookUnitPrices
    ])

    useEffect(() => {
        if (!productCommissionsEnabled) return
        const sourceKey = mode === 'create'
            ? `create:${features.default_currency}`
            : product ? `${mode}:${product.id}:${sourceProductCommissionRule?.id || 'none'}` : null
        if (!sourceKey || initializedProductCommissionRuleKeyRef.current === sourceKey) return
        const next = sourceProductCommissionRule ? {
            enabled: true,
            commissionType: sourceProductCommissionRule.commissionType,
            amount: String(sourceProductCommissionRule.commissionType === 'fixed_amount'
                ? sourceProductCommissionRule.fixedAmount || ''
                : sourceProductCommissionRule.ratePercent || ''),
            currency: sourceProductCommissionRule.fixedCurrency || formData.currency,
            recipientScope: sourceProductCommissionRule.recipientScope,
            agentIds: sourceProductCommissionAgentIds
        } satisfies ProductCommissionRuleDraft : emptyProductCommissionRuleDraft(formData.currency)
        setProductCommissionDraft(next)
        initialProductCommissionSnapshotRef.current = JSON.stringify(next)
        initializedProductCommissionRuleKeyRef.current = sourceKey
    }, [features.default_currency, formData.currency, mode, product, productCommissionsEnabled, sourceProductCommissionAgentIds, sourceProductCommissionRule])

    useEffect(() => {
        if (overrideAttention && priceBookRows.length > 0) {
            setOverrideAttention(false)
        }
    }, [overrideAttention, priceBookRows.length])

    useEffect(() => {
        if (mode !== 'create' || unitPackaging.relationshipId) return
        const pcsIsReserved = unitRelationships.some((relationship) => (
            !relationship.isDeleted
            && !relationship.isArchived
            && [relationship.parentUnitCode, relationship.childUnitCode]
                .some((code) => normalizeUnitCode(code).toLowerCase() === 'pcs')
        ))
        if (!pcsIsReserved) return
        setFormData((current) => normalizeUnitCode(current.unit).toLowerCase() === 'pcs'
            ? { ...current, unit: '' }
            : current)
    }, [mode, unitPackaging.relationshipId, unitRelationships])

    if (!canEdit && mode !== 'edit') {
        return null
    }

    const goToProducts = () => {
        if (isReadOnly) {
            navigate('/products')
            return
        }

        if (!requestNavigation('/products')) {
            navigate('/products')
        }
    }

    const getDisplayImageUrl = (url?: string) => getProductImageDisplayUrl(url)

    const releasePendingImportedImage = (path = pendingImportedImagePathRef.current) => {
        if (!path) return
        if (pendingImportedImagePathRef.current === path) {
            pendingImportedImagePathRef.current = null
        }
        assetManager.deleteAsset(path).catch((error) =>
            console.error('[Products] Failed to clean up imported image:', error)
        )
    }

    const setProductImagePath = (path: string, imported = false) => {
        const previousImportedPath = pendingImportedImagePathRef.current
        if (previousImportedPath && previousImportedPath !== path) {
            releasePendingImportedImage(previousImportedPath)
        }
        pendingImportedImagePathRef.current = imported ? path : null
        setFormData((current) => ({ ...current, imageUrl: path }))
        setImageError(false)
    }

    const showProductImageErrorToast = (error: unknown) => {
        const code = error instanceof ProductImageStorageError ? error.code : 'import_failed'
        const defaultMessages: Record<string, string> = {
            invalid_url: 'Enter a valid public image URL.',
            cloud_required: 'Product images need cloud storage in this workspace.',
            unsupported_image: 'Choose a JPEG, PNG, WebP, GIF, or AVIF image.',
            animated_image: 'Animated images are not supported.',
            empty_image: 'The selected image is empty.',
            image_too_large: 'The image is too large to process.',
            image_decode_failed: 'This file could not be decoded as an image.',
            image_processing_failed: 'The image could not be optimized.',
            upload_failed: 'The image could not be uploaded to cloud storage.',
            import_failed: 'The image could not be downloaded from that URL.'
        }
        toast({
            title: t('products.form.imageImportErrorTitle', { defaultValue: 'Image import failed' }),
            description: t(`products.form.imageErrors.${code}`, { defaultValue: defaultMessages[code] }),
            variant: 'destructive'
        })
    }

    const handleImageUpload = async () => {
        if (!canEdit || isImageProcessing) return

        if (isDesktopShell) {
            const selectedFile = await platformService.pickImageFile()
            if (selectedFile) await handleFileSelected(selectedFile)
            return
        }

        imageUploadInputRef.current?.click()
    }

    const handleFileSelected = async (file: File) => {
        if (isImageProcessing) return
        setIsImageProcessing(true)
        try {
            const targetPath = await storeProductImageFile(file, workspaceId, 'product-primary')
            if (targetPath) setProductImagePath(targetPath)
        } catch (error) {
            showProductImageErrorToast(error)
        } finally {
            setIsImageProcessing(false)
        }
    }

    const handleImportProductImage = async () => {
        if (!canEdit || isImageProcessing || !externalImageUrl.trim()) return
        setIsImageProcessing(true)
        try {
            const targetPath = await importProductImageFromUrl(externalImageUrl, workspaceId, 'product-primary')
            setProductImagePath(targetPath, true)
            setExternalImageUrl('')
            toast({
                title: t('products.form.imageImportSuccessTitle', { defaultValue: 'Image imported' }),
                description: isDesktopShell
                    ? t('products.form.imageImportSuccessLocal', { defaultValue: 'The image was saved locally on this device.' })
                    : t('products.form.imageImportSuccess', { defaultValue: 'The image was optimized and saved to cloud storage.' })
            })
        } catch (error) {
            showProductImageErrorToast(error)
        } finally {
            setIsImageProcessing(false)
        }
    }

    const handleCameraCapture = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file) return

        await handleFileSelected(file)

        if (cameraInputRef.current) {
            cameraInputRef.current.value = ''
        }
    }

    const handleImageFileInputChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        if (!file) return

        await handleFileSelected(file)

        if (imageUploadInputRef.current) {
            imageUploadInputRef.current.value = ''
        }
    }

    const handleVisualsPaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
        if (!canEdit || isImageProcessing) return

        const file = getClipboardImageFile(event.clipboardData)
        if (!file) return

        event.preventDefault()
        await handleFileSelected(file)
    }

    const handleRemoveImage = async () => {
        if (!formData.imageUrl || !canEdit) {
            return
        }

        try {
            await assetManager.deleteAsset(formData.imageUrl)
            if (pendingImportedImagePathRef.current === formData.imageUrl) {
                pendingImportedImagePathRef.current = null
            }
            setFormData((current) => ({ ...current, imageUrl: '' }))
            setImageError(false)
        } catch (error) {
            console.error('[Products] Error removing image:', error)
        }
    }

    const handleConfirmDeleteProduct = async () => {
        if (!isEditing || !product || isReadOnly) {
            return
        }

        setIsDeletingProduct(true)
        try {
            await deleteProduct(product.id)
            navigate('/products')
        } catch (error) {
            console.error('[ProductForm] Error deleting product:', error)
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error
                    ? error.message
                    : (t('products.messages.deleteError', { defaultValue: 'Failed to delete the product' })),
                variant: 'destructive'
            })
        } finally {
            setIsDeletingProduct(false)
        }
    }

    const showBarcodeErrorToast = (error: unknown) => {
        if (error instanceof DuplicateProductBarcodeError) {
            toast({
                variant: 'destructive',
                title: t('messages.error'),
                description: t('products.barcodes.duplicate') || 'This barcode is already assigned to another product.'
            })
            return
        }

        toast({
            variant: 'destructive',
            title: t('messages.error'),
            description: error instanceof Error ? error.message : (t('common.error') || 'Something went wrong')
        })
    }

    const showProductSaveErrorToast = (error: unknown) => {
        if (error instanceof DuplicateProductSkuError) {
            toast({
                variant: 'destructive',
                title: t('common.error', { defaultValue: 'Error' }),
                description: error.message
            })
            return
        }

        const normalizedErrorMessage = error instanceof Error ? error.message.toLowerCase() : ''
        if (
            normalizedErrorMessage.includes('product commission')
            || normalizedErrorMessage.includes('eligible field agents')
            || normalizedErrorMessage.includes('at least one agent')
        ) {
            toast({
                variant: 'destructive',
                title: t('common.error', { defaultValue: 'Error' }),
                description: normalizedErrorMessage.includes('currency')
                    ? t('salesAgentCommissions.errors.commissionExchangeRateUnavailable')
                    : normalizedErrorMessage.includes('agent')
                        ? t('salesAgentCommissions.productCommission.invalidRecipients')
                        : t('salesAgentCommissions.productCommission.invalidAmount')
            })
            return
        }

        toast({
            title: t('common.error', { defaultValue: 'Error' }),
            description: error instanceof Error ? error.message : t('products.messages.saveError', {
                defaultValue: 'Failed to save the product'
            }),
            variant: 'destructive'
        })
    }

    const handleAddBarcode = async () => {
        if (!workspaceId || !persistedProductId || isReadOnly) {
            return
        }

        const barcodeValue = normalizeBarcodeScannerText(newBarcodeValue)
        if (!barcodeValue) {
            return
        }

        const alreadyExists = productBarcodes.some((barcodeRow) => (
            normalizeBarcodeScannerText(barcodeRow.barcode) === barcodeValue
        ))
        if (alreadyExists) {
            showBarcodeErrorToast(new DuplicateProductBarcodeError())
            return
        }

        setIsSubmittingBarcode(true)
        try {
            await addProductBarcode(workspaceId, persistedProductId, barcodeValue, newBarcodeLabel)
            setNewBarcodeValue('')
            setNewBarcodeLabel('')
        } catch (error) {
            showBarcodeErrorToast(error)
        } finally {
            setIsSubmittingBarcode(false)
        }
    }

    const handleBarcodeLabelBlur = async (barcodeRow: ProductBarcode, nextValue: string) => {
        if (isReadOnly) {
            return
        }

        const normalizedCurrent = barcodeRow.label?.trim() || ''
        const normalizedNext = nextValue.trim()
        if (normalizedCurrent === normalizedNext) {
            return
        }

        try {
            await updateProductBarcode(barcodeRow.id, { label: normalizedNext || undefined })
        } catch (error) {
            showBarcodeErrorToast(error)
        }
    }

    const handleBarcodeLabelKeyDown = async (
        event: React.KeyboardEvent<HTMLInputElement>,
        barcodeRow: ProductBarcode
    ) => {
        if (event.key !== 'Enter') {
            return
        }

        event.preventDefault()
        await handleBarcodeLabelBlur(barcodeRow, event.currentTarget.value)
        event.currentTarget.blur()
    }

    const handleSetPrimaryBarcode = async (barcodeRow: ProductBarcode) => {
        if (isReadOnly || barcodeRow.isPrimary) {
            return
        }

        try {
            await updateProductBarcode(barcodeRow.id, { isPrimary: true })
        } catch (error) {
            showBarcodeErrorToast(error)
        }
    }

    const handleConfirmDeleteBarcode = async () => {
        if (!barcodeToDelete) {
            return
        }

        setIsDeletingBarcode(true)
        try {
            await deleteProductBarcode(barcodeToDelete.id)
            setBarcodeToDelete(null)
        } catch (error) {
            showBarcodeErrorToast(error)
        } finally {
            setIsDeletingBarcode(false)
        }
    }

    const handleScannerTargetChange = (target: ProductScannerTarget) => {
        setActiveScannerTarget(target)
        writeStoredScannerTarget(target)
    }

    const handleSkuScannerEnabledChange = (enabled: boolean) => {
        handleScannerTargetChange(enabled ? 'sku' : 'none')
    }

    const handleBarcodeScannerEnabledChange = (enabled: boolean) => {
        handleScannerTargetChange(enabled ? 'barcode' : 'none')
    }

    const handleVariantSkuScannerEnabledChange = (enabled: boolean) => {
        setVariantSkuScannerPreference(enabled)
        writeStoredBoolean(PRODUCT_VARIANT_SKU_SCANNER_ENABLED_KEY, enabled)
        setActiveScannerTarget(enabled ? 'variantSku' : 'none')
    }

    const handleVariantSkuScannerDialogOpen = () => {
        setActiveScannerTarget(variantSkuScannerPreference ? 'variantSku' : 'none')
    }

    const handleVariantSkuScannerDialogClose = () => {
        setActiveScannerTarget((current) => current === 'variantSku' ? 'none' : current)
    }

    const handleSkuBarcodeScan = (value: string) => {
        if (isReadOnly || activeScannerTarget !== 'sku') {
            return
        }

        setFormData((current) => ({ ...current, sku: normalizeBarcodeScannerText(value) }))
    }

    const handleGenerateSku = async () => {
        if (isReadOnly || !workspaceId || isGeneratingSkuRef.current) {
            return
        }

        isGeneratingSkuRef.current = true
        setIsGeneratingSku(true)
        try {
            for (let attempt = 0; attempt < 20; attempt += 1) {
                const sku = generateRandomUpc()
                if (sku === formData.sku) {
                    continue
                }

                const existingProduct = await findActiveProductBySku(workspaceId, sku)

                if (!existingProduct) {
                    setFormData((current) => ({ ...current, sku }))
                    skuInputRef.current?.focus()
                    return
                }
            }

            toast({
                variant: 'destructive',
                title: t('common.error', { defaultValue: 'Error' }),
                description: t('products.form.generateUpcError', {
                    defaultValue: 'Could not generate a unique UPC. Please try again.'
                })
            })
        } finally {
            isGeneratingSkuRef.current = false
            setIsGeneratingSku(false)
        }
    }

    const handleAdditionalBarcodeScan = (value: string) => {
        if (isReadOnly || !persistedProductId || activeScannerTarget !== 'barcode') {
            return
        }

        setNewBarcodeValue(normalizeBarcodeScannerText(value))
    }

    const persistProduct = async ({ navigateAfterSave = true }: { navigateAfterSave?: boolean } = {}) => {
        if (!workspaceId || !canEdit || isImageProcessing) {
            return false
        }

        if (priceBooksEnabled && !isPriceBookCatalogReady) {
            toast({
                title: priceBookCatalogError
                    ? t('common.error', { defaultValue: 'Error' })
                    : t('priceBooks.loading', { defaultValue: 'Loading Price Book prices' }),
                description: priceBookCatalogError
                    ? t('priceBooks.loadingError', {
                        defaultValue: 'Price Book prices could not be loaded. Retrying automatically...'
                    })
                    : t('priceBooks.loadingDescription', {
                        defaultValue: 'Wait for the existing custom prices to finish loading, then save again.'
                    }),
                ...(priceBookCatalogError ? { variant: 'destructive' as const } : {})
            })
            return false
        }

        if (productCommissionsEnabled && isProductCommissionDirty && !isProductCommissionCatalogReady) {
            toast({
                title: productCommissionCatalogError
                    ? t('common.error', { defaultValue: 'Error' })
                    : t('salesAgentCommissions.productCommission.loading'),
                description: productCommissionCatalogError
                    ? t('salesAgentCommissions.productCommission.loadingError')
                    : t('salesAgentCommissions.productCommission.loadingDescription'),
                ...(productCommissionCatalogError ? { variant: 'destructive' as const } : {})
            })
            return false
        }

        if (productCommissionValidationMessage) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: productCommissionValidationMessage,
                variant: 'destructive'
            })
            return false
        }

        if (!normalizeUnitCode(formData.unit)) {
            toast({
                variant: 'destructive',
                title: t('common.error'),
                description: t('products.packaging.unitRequired')
            })
            return false
        }

        const selectedUnitRelationship = unitRelationships.find((row) => row.id === unitPackaging.relationshipId && !row.isDeleted)
        const unitFactor = Number(unitPackaging.factor)
        const parentUnitPrice = Number(unitPackaging.parentPrice)
        const childUnitOption = selectedUnitRelationship
            ? unitOptions.find((option) => option.value === selectedUnitRelationship.childUnitCode)
            : undefined
        if (selectedUnitRelationship && (
            !Number.isFinite(unitFactor)
            || unitFactor <= 0
            || (!childUnitOption?.isDynamic && !Number.isInteger(unitFactor))
            || unitPackaging.parentPrice.trim() === ''
            || !Number.isFinite(parentUnitPrice)
            || parentUnitPrice < 0
        )) {
            toast({
                variant: 'destructive',
                title: t('common.error'),
                description: t('products.packaging.validation')
            })
            return false
        }

        if (selectedUnitRelationship && priceBookRows.some((row) => (
            row.parentPrice == null
            || row.parentPrice.trim() === ''
            || !Number.isFinite(Number(row.parentPrice))
            || Number(row.parentPrice) < 0
        ))) {
            toast({
                variant: 'destructive',
                title: t('common.error'),
                description: t('products.packaging.priceBookValidation')
            })
            return false
        }

        setIsSaving(true)

        try {
            const categoryName = formData.categoryId
                ? categories.find((category) => category.id === formData.categoryId)?.name
                : null
            const storageName = formData.storageId
                ? storages.find((storage) => storage.id === formData.storageId)?.name
                : null

            const { perQuantity: _perQuantity, costPrice: costPriceInput, ...formDataToSave } = formData
            const enteredCost = costPriceInput.trim() === ''
                ? null
                : Number(costPriceInput)
            const normalizedCost = enteredCost == null
                ? null
                : isDynamicUnit(formData.unit)
                    ? enteredCost / (Number(formData.perQuantity) || 1)
                    : enteredCost
            const shouldPersistCost = !isEditing || !hideCosts
            const dataToSave = {
                ...formDataToSave,
                sku: formData.sku.trim(),
                unit: normalizeUnitCode(formData.unit),
                category: categoryName || null,
                storageName: storageName || undefined,
                categoryId: formData.categoryId || null,
                storageId: formData.storageId || null,
                imageUrl: isProductImagePath(formData.imageUrl) ? formData.imageUrl : '',
                price: isDynamicUnit(formData.unit)
                    ? (Number(formData.price) || 0) / (Number(formData.perQuantity) || 1)
                    : Number(formData.price) || 0,
                ...(shouldPersistCost ? { costPrice: normalizedCost } : {}),
                quantity: roundQuantity(Number(formData.quantity) || 0),
                minStockLevel: roundQuantity(Number(formData.minStockLevel) || 0),
                createdBy: user?.id || null
            }

            let savedProductId: string

            if (isEditing && product && !isClone) {
                if (product.imageUrl && product.imageUrl !== formData.imageUrl) {
                    assetManager.deleteAsset(product.imageUrl).catch((error) =>
                        console.error('[Products] Failed to delete old asset:', error)
                    )
                }

                await updateProduct(product.id, dataToSave)
                savedProductId = product.id
            } else if (createdProductIdRef.current) {
                await updateProduct(createdProductIdRef.current, dataToSave)
                savedProductId = createdProductIdRef.current
            } else {
                // Creation always persists the (possibly null) submitted cost;
                // only a restricted edit is allowed to omit the property.
                const createdProduct = await createProduct(workspaceId, {
                    ...dataToSave,
                    costPrice: normalizedCost
                })
                createdProductIdRef.current = createdProduct.id
                savedProductId = createdProduct.id
                demoTutorial.completeProductCreated(createdProduct)
            }

            // The database now owns this imported object even if a later
            // optional price-book/commission save needs to be retried.
            pendingImportedImagePathRef.current = null

            await replaceProductUnitConversion(
                workspaceId,
                savedProductId,
                selectedUnitRelationship ? {
                    relationshipId: selectedUnitRelationship.id,
                    factor: unitFactor,
                    parentPrice: parentUnitPrice,
                    childIsDynamic: childUnitOption?.isDynamic === true
                } : null
            )
            initialUnitPackagingSnapshotRef.current = JSON.stringify(unitPackaging)

            if (priceBooksEnabled) {
                const savedItems = await replaceProductPriceBookItems(
                    workspaceId,
                    savedProductId,
                    priceBookRows.map((row) => ({
                        priceBookId: row.priceBookId,
                        costPrice: row.costPrice.trim() === '' ? null : Number(row.costPrice),
                        price: Number(row.price),
                        currency: row.currency
                    })),
                    user?.id || null
                )
                const savedUnitPrices = await replaceProductPriceBookUnitPrices(
                    workspaceId,
                    savedProductId,
                    selectedUnitRelationship
                        ? priceBookRows.map((row) => ({
                            priceBookId: row.priceBookId,
                            unitRef: selectedUnitRelationship.parentUnitRef,
                            price: Number(row.parentPrice),
                            currency: row.currency
                        }))
                        : []
                )
                const completeSavedRows = mapPriceBookItemsToDrafts(savedItems, savedUnitPrices)
                setPriceBookRows(completeSavedRows)
                initialPriceBookRowsSnapshotRef.current = serializePriceBookDrafts(completeSavedRows)
            }

            if (productCommissionsEnabled && isProductCommissionDirty) {
                await replaceProductCommissionRule(
                    workspaceId,
                    savedProductId,
                    productCommissionDraft.enabled ? {
                        commissionType: productCommissionDraft.commissionType,
                        ratePercent: productCommissionDraft.commissionType === 'percentage'
                            ? Number(productCommissionDraft.amount) : 0,
                        fixedAmount: productCommissionDraft.commissionType === 'fixed_amount'
                            ? Number(productCommissionDraft.amount) : null,
                        fixedCurrency: productCommissionDraft.commissionType === 'fixed_amount'
                            ? productCommissionDraft.currency : null,
                        recipientScope: productCommissionDraft.recipientScope,
                        agentIds: productCommissionDraft.agentIds,
                        createdBy: user?.id || null
                    } : null
                )
                initialProductCommissionSnapshotRef.current = JSON.stringify(productCommissionDraft)
            }

            initialFormSnapshotRef.current = JSON.stringify(formData)

            if (navigateAfterSave) {
                navigate('/products')
            }

            return true
        } catch (error: any) {
            console.error('Error saving product:', error)
            showProductSaveErrorToast(error)
            return false
        } finally {
            setIsSaving(false)
        }
    }

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault()

        if (mode === 'create' && !formData.storageId) {
            setStorageError(true)
            storageTriggerRef.current?.focus()
            storageTriggerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            return
        }

        if (demoTutorial.isCurrentTask('product') && (Number(formData.quantity) || 0) <= 0) {
            const quantityInput = document.getElementById('product-quantity') as HTMLInputElement | null
            quantityInput?.focus()
            quantityInput?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            toast({
                title: t('products.form.stock') || 'Stock',
                description: 'Enter initial stock greater than 0 to continue the tutorial.',
                variant: 'destructive'
            })
            return
        }

        if (
            mode === 'create'
            && priceBooksEnabled
            && priceBooks.length > 0
            && priceBooks.some((priceBook) => priceBook.saveWarn !== false)
            && priceBookRows.length === 0
            && !overrideAttention
        ) {
            setOverrideAttention(true)
            overrideSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            return
        }

        await persistProduct()
    }

    const title = isClone
        ? t('common.clone') || 'Clone Product'
        : isEditing
            ? isReadOnly
                ? t('common.view') || 'View Product'
                : t('common.edit') || 'Edit Product'
            : t('products.addProduct') || 'Add Product'

    const subtitle = isReadOnly
        ? (t('products.readOnlyNotice') || 'Viewing this product in read-only mode.')
        : isClone
            ? (t('products.cloneSubtitle') || 'Review the copied values, then create a new product.')
            : isEditing
                ? (t('products.editSubtitle') || 'Update product details, pricing, and return rules. Use Stock Adjustments for stock changes.')
                : (t('products.subtitle') || 'Manage your inventory')

    // The Radix SelectValue renders its placeholder whenever the select value
    // is "" (even with children), so the unit display must never resolve to an
    // empty string while editing. Prefer the form's field once the product has
    // been patched into it; before that, trust the cached product's own unit;
    // anything else collapses to the built-in default.
    const formUnit = normalizeUnitCode(formData.unit)
    const productUnit = isEditing && product?.id ? normalizeUnitCode(product.unit) : ''
    const notYetPatched = mode !== 'create' && initialFormSnapshotRef.current === null
    const normalizedUnit = normalizeUnitCode(notYetPatched && product ? product.unit : formUnit)
        || productUnit
        || (mode === 'create' ? '' : 'pcs')
    const unitLabel = normalizedUnit
        ? t(`products.units.${normalizedUnit}`, { defaultValue: normalizedUnit })
        : t('units.selectPlaceholder', { defaultValue: 'Select unit' })
    const sourceUnitConversion = product?.id
        ? productUnitConversions.find((row) => row.productId === product.id && !row.isDeleted)
        : undefined
    const sourceUnitRelationship = sourceUnitConversion
        ? unitRelationships.find((row) => row.id === sourceUnitConversion.relationshipId)
        : undefined
    const selectedUnitRelationshipForDisplay = unitRelationships.find((row) => row.id === unitPackaging.relationshipId)
    const unitSelectionOptions = buildProductUnitSelectionOptions(
        unitOptions,
        unitRelationships,
        unitPackaging.relationshipId
    )
    const unitSelectionValue = unitPackaging.relationshipId
        ? `relationship:${unitPackaging.relationshipId}`
        : normalizedUnit ? `unit:${normalizedUnit}` : undefined
    const selectedUnitSelectionOption = unitSelectionOptions.find((option) => option.value === unitSelectionValue)
    const selectedChildUnitForDisplay = selectedUnitRelationshipForDisplay
        ? unitOptions.find((option) => option.value === selectedUnitRelationshipForDisplay.childUnitCode)
        : undefined
    const displayedUnitFactor = Number(unitPackaging.factor)
    const displayedParentPrice = Number(unitPackaging.parentPrice)
    const isUnitPackagingInvalid = !normalizedUnit
        || Boolean(unitPackaging.relationshipId && !selectedUnitRelationshipForDisplay)
        || Boolean(selectedUnitRelationshipForDisplay && (
            unitPackaging.factor.trim() === ''
            || !Number.isFinite(displayedUnitFactor)
            || displayedUnitFactor <= 0
            || (!selectedChildUnitForDisplay?.isDynamic && !Number.isInteger(displayedUnitFactor))
            || unitPackaging.parentPrice.trim() === ''
            || !Number.isFinite(displayedParentPrice)
            || displayedParentPrice < 0
            || priceBookRows.some((row) => row.parentPrice == null || row.parentPrice.trim() === '' || Number(row.parentPrice) < 0)
        ))

    const handleUnitRelationshipChange = (relationshipId: string) => {
        if (!relationshipId) {
            setUnitPackaging(EMPTY_PRODUCT_UNIT_PACKAGING)
            return
        }
        const relationship = unitRelationships.find((row) => row.id === relationshipId && !row.isDeleted)
        if (!relationship) return
        if (isEditing && sourceUnitRelationship && sourceUnitRelationship.childUnitRef !== relationship.childUnitRef) {
            toast({ variant: 'destructive', title: t('common.error'), description: t('products.packaging.switchChildBlocked') })
            return
        }
        const currentUnit = normalizeUnitCode(product?.unit || formData.unit)
        if (isEditing && product && !sourceUnitConversion
            && currentUnit !== normalizeUnitCode(relationship.childUnitCode)) {
            toast({ variant: 'destructive', title: t('common.error'), description: t('products.packaging.incompatibleUnit') })
            return
        }
        setUnitPackaging({
            relationshipId,
            factor: unitPackaging.relationshipId === relationshipId ? unitPackaging.factor : '',
            parentPrice: unitPackaging.relationshipId === relationshipId
                ? unitPackaging.parentPrice
                : ''
        })
        setFormData((current) => ({
            ...current,
            unit: relationship.childUnitCode
        }))
    }

    const handleUnitSelectionChange = (value: string) => {
        if (value.startsWith('relationship:')) {
            handleUnitRelationshipChange(value.slice('relationship:'.length))
            return
        }
        if (!value.startsWith('unit:')) return
        const unit = normalizeUnitCode(value.slice('unit:'.length))
        const reserved = unitRelationships.some((relationship) => (
            !relationship.isDeleted
            && !relationship.isArchived
            && [relationship.parentUnitCode, relationship.childUnitCode]
                .some((code) => normalizeUnitCode(code).toLowerCase() === unit.toLowerCase())
        ))
        if (reserved) {
            toast({ variant: 'destructive', title: t('common.error'), description: t('products.packaging.standaloneReserved') })
            return
        }
        if (isEditing && product && normalizeUnitCode(product.unit).toLowerCase() !== unit.toLowerCase()) {
            toast({ variant: 'destructive', title: t('common.error'), description: t('products.packaging.unitChangeBlocked') })
            return
        }
        setUnitPackaging(EMPTY_PRODUCT_UNIT_PACKAGING)
        setFormData((current) => ({ ...current, unit }))
    }
    const quantityValue = Number(formData.quantity) || 0
    const minStockValue = Number(formData.minStockLevel) || 0
    const lowStock = quantityValue <= minStockValue
    const perQty = Number(formData.perQuantity) || 1
    const effectivePrice = isDynamicUnit(formData.unit)
        ? (Number(formData.price) || 0) / perQty
        : Number(formData.price) || 0
    const effectiveCost = formData.costPrice.trim() === ''
        ? null
        : isDynamicUnit(formData.unit)
            ? Number(formData.costPrice) / perQty
            : Number(formData.costPrice)
    const pricePreview = formatCurrency(effectivePrice, formData.currency, features.iqd_display_preference)
    const costPreview = effectiveCost == null ? null : formatCurrency(effectiveCost, formData.currency, features.iqd_display_preference)
    const marginValue = effectiveCost == null ? null : effectivePrice - effectiveCost
    const marginPreview = marginValue == null ? null : formatCurrency(marginValue, formData.currency, features.iqd_display_preference)
    const selectedCategoryLabel = formData.categoryId
        ? categories.find((category) => category.id === formData.categoryId)?.name || (t('categories.noCategory') || 'No category')
        : (t('categories.noCategory') || 'No category')
    const labelMixed = t('products.form.mixedStorages') || 'Mixed'
    const selectedStorageLabel = isEditing
        ? productStorages.length === 0
            ? '—'
            : productStorages.length === 1
                ? productStorages[0].name
                : (
                    <TooltipProvider>
                        <Tooltip delayDuration={200}>
                            <TooltipTrigger asChild>
                                <span className="cursor-help border-b-2 border-dotted border-foreground/30">{labelMixed}</span>
                            </TooltipTrigger>
                            <TooltipContent side="top" align="start" className="max-w-[240px] space-y-1.5 p-3">
                                {productStorages.map((entry) => (
                                    <div key={entry.name} className="flex items-center justify-between gap-4 text-sm">
                                        <span>{entry.name}</span>
                                        <span className="font-mono tabular-nums text-muted-foreground">{entry.quantity}</span>
                                    </div>
                                ))}
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                )
        : formData.storageId
            ? storages.find((storage) => storage.id === formData.storageId)?.name || (t('storages.selectStorage') || 'Select Storage')
            : (t('storages.selectStorage') || 'Select Storage')
    const returnRulesPreview = formData.returnRules.trim() || (t('products.form.noReturnRules') || 'No custom return guidance yet.')
    const statusLabel = isClone
        ? (t('common.clone') || 'Clone')
        : isEditing
            ? isReadOnly
                ? (t('common.view') || 'View')
                : (t('common.edit') || 'Edit')
            : (t('common.create') || 'Create')
    const scannerEnabledLabel = t('pos.scannerEnabled', { defaultValue: 'Scanner Enabled' })
    const scannerDisabledLabel = t('pos.scannerDisabled', { defaultValue: 'Scanner Disabled' })

    if (mode !== 'create' && !product) {
        return (
            <div className="mx-auto max-w-5xl space-y-6">
                <Button variant="ghost" className="w-fit gap-2 px-0" allowViewer={true} onClick={() => navigate('/products')}>
                    <ArrowLeft className="h-4 w-4" />
                    {t('products.backToList') || 'Back to Products'}
                </Button>
                <Card className="border-border/60 shadow-sm">
                    <CardContent className="flex min-h-[280px] flex-col items-center justify-center gap-3 text-center">
                        <Package className="h-10 w-10 text-muted-foreground/50" />
                        <h1 className="text-xl font-bold">
                            {missingProductStateVisible
                                ? (t('products.notFoundTitle') || 'Product not found')
                                : (t('common.loading') || 'Loading...')}
                        </h1>
                        <p className="max-w-md text-sm text-muted-foreground">
                            {missingProductStateVisible
                                ? (t('products.notFoundDescription') || 'This product could not be found. It may have been deleted or is no longer available.')
                                : (t('products.loadingDescription') || 'Fetching the product details for this page.')}
                        </p>
                    </CardContent>
                </Card>
            </div>
        )
    }

    return (
        <div className="mx-auto w-full max-w-[1600px] space-y-3 pb-8">
            <header className="flex flex-col gap-3 border-b border-border/60 px-1 pb-3 pt-1 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-2 sm:gap-4">
                    <Button variant="ghost" className="h-10 shrink-0 gap-2 px-2 sm:px-3" allowViewer={true} onClick={goToProducts}>
                        <ArrowLeft className="h-4 w-4" />
                        <span className="hidden sm:inline">{t('common.back') || 'Back'}</span>
                    </Button>
                    <div className="hidden h-6 w-px bg-border sm:block" />
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="truncate text-xl font-black tracking-tight text-foreground sm:text-2xl">{title}</h1>
                            <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-[0.14em] text-primary">
                                {statusLabel}
                            </span>
                        </div>
                        <p className="hidden text-sm text-muted-foreground lg:block">{subtitle}</p>
                    </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                    {isEditing && !isReadOnly && (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setDeleteProductOpen(true)}
                            className="h-10 gap-2 border-destructive/30 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive sm:px-4"
                        >
                            <Trash2 className="h-4 w-4" />
                            <span className="hidden sm:inline">{t('products.confirmDelete', { defaultValue: 'Delete Product' })}</span>
                        </Button>
                    )}
                    {!isReadOnly && (
                        <Button
                            type="submit"
                            form="product-form-page"
                            disabled={isSaving || isImageProcessing || isUnitPackagingInvalid || (priceBooksEnabled && !isPriceBookCatalogReady) || Boolean(productCommissionValidationMessage)}
                            className="h-10 gap-2 px-4 font-bold"
                            data-tour-id="tutorial-product-save"
                        >
                            <Save className="h-4 w-4" />
                            {isSaving
                                ? (t('common.loading') || 'Loading...')
                                : isClone
                                    ? (t('common.clone') || 'Clone')
                                    : isEditing
                                        ? (t('common.save') || 'Save')
                                        : (t('common.create') || 'Create')}
                        </Button>
                    )}
                </div>
            </header>

            <section className="grid gap-5 rounded-2xl border border-border/60 bg-card p-4 shadow-sm sm:p-5 md:grid-cols-[190px_minmax(0,1fr)]">
                <button
                    type="button"
                    onClick={() => setVisualsModalOpen(true)}
                    className="group relative mx-auto aspect-square w-full max-w-[190px] overflow-hidden rounded-xl border border-border/60 bg-muted/30 text-start focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-label={t('products.form.visuals') || 'Visuals'}
                >
                    {!formData.imageUrl ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-primary">
                            <ImagePlus className="h-8 w-8" />
                            <span className="text-[10px] font-black uppercase tracking-[0.12em]">{t('products.form.noImage') || 'Add image'}</span>
                        </div>
                    ) : imageError ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-destructive">
                            <Package className="h-8 w-8" />
                            <span className="text-[10px] font-black uppercase tracking-[0.12em]">{t('products.form.imageError') || 'Image Error'}</span>
                        </div>
                    ) : (
                        <img
                            src={getDisplayImageUrl(formData.imageUrl)}
                            alt={formData.name || 'Product preview'}
                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                            onError={() => setImageError(true)}
                        />
                    )}
                    <span className="absolute inset-x-2 bottom-2 rounded-lg bg-background/90 px-2 py-1.5 text-center text-xs font-bold text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                        {t('products.form.visuals') || 'Change image'}
                    </span>
                </button>

                <div className="min-w-0 self-center">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="truncate text-2xl font-black tracking-tight text-foreground">{formData.name || (t('products.form.name') || 'Product name')}</h2>
                                <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[11px] font-bold text-primary">{selectedCategoryLabel}</span>
                            </div>
                            <p className="mt-2 max-w-4xl text-sm leading-6 text-muted-foreground">
                                {formData.description || (t('products.form.productDetailsDesc') || 'Add the product details, price, stock, and image.')}
                            </p>
                        </div>
                        {isDirty && !isReadOnly && (
                            <span className="w-fit shrink-0 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-amber-700">
                                {t('common.unsavedChanges.title') || 'Unsaved Changes'}
                            </span>
                        )}
                    </div>
                    <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                        <div><dt className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{t('products.table.sku')}</dt><dd className="mt-0.5 font-semibold text-foreground">{formData.sku || '—'}</dd></div>
                        <div><dt className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{t('products.table.category')}</dt><dd className="mt-0.5 font-semibold text-foreground">{selectedCategoryLabel}</dd></div>
                        <div><dt className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{t('products.form.unit')}</dt><dd className="mt-0.5 font-semibold text-foreground">{unitLabel}</dd></div>
                    </dl>
                </div>
            </section>

            {isReadOnly && (
                <div className="flex items-center gap-2 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-800">
                    <Info className="h-5 w-5" />
                    {t('products.readOnlyNotice') || 'Viewing this product in read-only mode.'}
                </div>
            )}

            <form id="product-form-page" onSubmit={handleSubmit} className="space-y-4">
                {isEditing && product?.parentProductId && (
                    <ProductVariantParentNotice
                        variant={product}
                        parent={parentProduct}
                        canManage={!isReadOnly}
                        onOpenParent={() => {
                            if (parentProduct) {
                                navigate(`/products/${parentProduct.id}`)
                            }
                        }}
                    />
                )}
                <div className="min-w-0 space-y-4">
                    <Card className="overflow-hidden rounded-2xl border-border/60 shadow-sm">
                        <CardHeader className="border-b border-border/60 bg-gradient-to-r from-primary/5 via-transparent to-transparent px-5 py-3 sm:px-6">
                            <CardTitle className="text-lg font-black tracking-tight">
                                {t('products.form.productDetailsTitle') || 'Product Details'}
                            </CardTitle>
                            <p className="sr-only">
                                {t('products.form.productDetailsDesc') || 'Capture the core identity, description, unit, category, and storage location for this product.'}
                            </p>
                        </CardHeader>
                        <CardContent className="grid gap-x-8 gap-y-4 p-5 sm:p-6 md:grid-cols-2">
                            <div className="contents">
                                <div className="hidden">
                                    <div className="h-4 w-1 rounded-full bg-primary" />
                                    <h2 className="text-sm font-black uppercase tracking-widest text-primary/80">
                                        {t('products.form.basicInfo')}
                                    </h2>
                                </div>
                                <div className="contents">
                                    <div className="order-2 space-y-2 md:order-none md:col-start-2 md:row-start-1">
                                        <div className="flex items-center gap-1">
                                            <Label htmlFor="product-sku" className="flex items-center gap-2 font-bold">
                                                <Barcode className="h-4 w-4 text-primary/60" />
                                                {t('products.table.sku')}
                                            </Label>
                                            {!isReadOnly && (
                                                <TooltipProvider>
                                                    <Tooltip>
                                                        <TooltipTrigger asChild>
                                                            <Button
                                                                type="button"
                                                                variant="ghost"
                                                                size="icon"
                                                                onClick={(event) => {
                                                                    if (!isEditing || event.detail === 0) {
                                                                        void handleGenerateSku()
                                                                    }
                                                                }}
                                                                onDoubleClick={() => {
                                                                    if (isEditing) {
                                                                        void handleGenerateSku()
                                                                    }
                                                                }}
                                                                disabled={isGeneratingSku}
                                                                aria-label={isEditing
                                                                    ? t('products.form.generateUpcOnDoubleClick', { defaultValue: 'Double-click to generate a unique UPC' })
                                                                    : t('products.form.generateUpc', { defaultValue: 'Generate a unique UPC' })}
                                                                className="h-6 w-6 rounded-md text-muted-foreground hover:text-primary"
                                                            >
                                                                <Shuffle className="h-3.5 w-3.5" />
                                                            </Button>
                                                        </TooltipTrigger>
                                                        <TooltipContent>
                                                            {isEditing
                                                                ? t('products.form.generateUpcOnDoubleClick', { defaultValue: 'Double-click to generate a unique UPC' })
                                                                : t('products.form.generateUpc', { defaultValue: 'Generate a unique UPC' })}
                                                        </TooltipContent>
                                                    </Tooltip>
                                                </TooltipProvider>
                                            )}
                                        </div>
                                        <div className="flex gap-2">
                                            <Input
                                                ref={skuInputRef}
                                                id="product-sku"
                                                data-tour-id="tutorial-product-sku"
                                                value={formData.sku}
                                                onChange={(event) => setFormData((current) => ({
                                                    ...current,
                                                    sku: normalizeBarcodeDigits(event.target.value)
                                                }))}
                                                placeholder="PRD-001"
                                                readOnly={isReadOnly}
                                                required
                                                className="h-12 min-w-0 flex-1 rounded-xl border-border/80 bg-background/80 font-mono shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                            />
                                            {!isReadOnly && (
                                                <BarcodeScannerToggleButton
                                                    enabled={activeScannerTarget === 'sku'}
                                                    onEnabledChange={handleSkuScannerEnabledChange}
                                                    onScan={handleSkuBarcodeScan}
                                                    label={t('products.table.sku')}
                                                    activeLabel={scannerEnabledLabel}
                                                    inactiveLabel={scannerDisabledLabel}
                                                    deviceStorageKey={PRODUCT_SKU_HID_DEVICE_KEY}
                                                    targetInputRef={skuInputRef}
                                                    idleCommitDelayMs={PRODUCT_FORM_SCANNER_IDLE_COMMIT_DELAY_MS}
                                                />
                                            )}
                                        </div>
                                    </div>
                                    <div className="order-1 space-y-2 md:order-none md:col-start-1 md:row-start-1">
                                        <Label htmlFor="product-name" className="flex items-center gap-2 font-bold">
                                            <Type className="h-4 w-4 text-primary/60" />
                                            {t('products.table.name')}
                                        </Label>
                                        <Input
                                            id="product-name"
                                            data-tour-id="tutorial-product-name"
                                            value={formData.name}
                                            onChange={(event) => setFormData((current) => ({ ...current, name: event.target.value }))}
                                            placeholder={t('products.form.name') || 'Product name'}
                                            readOnly={isReadOnly}
                                            required
                                            className="h-12 rounded-xl border-border/80 bg-background/80 font-bold shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                        />
                                    </div>
                                </div>

                                <div className="order-6 space-y-2 md:order-none md:col-start-1 md:row-start-4">
                                    <Label htmlFor="product-description" className="flex items-center gap-2 font-bold">
                                        <FileText className="h-4 w-4 text-primary/60" />
                                        {t('products.form.description')}
                                    </Label>
                                    <Textarea
                                        id="product-description"
                                        value={formData.description}
                                        onChange={(event) => setFormData((current) => ({ ...current, description: event.target.value }))}
                                        placeholder={t('products.form.description') || 'Product description...'}
                                        rows={3}
                                        readOnly={isReadOnly}
                                        className="min-h-[76px] rounded-xl border-border/80 bg-background/80 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                    />
                                </div>
                            </div>

                            <div className="contents">
                                <div className="hidden">
                                    <div className="h-4 w-1 rounded-full bg-primary" />
                                    <h2 className="text-sm font-black uppercase tracking-widest text-primary/80">
                                        {t('products.form.categorization')}
                                    </h2>
                                </div>
                                <div className="contents">
                                    <div className="order-4 space-y-2 md:order-none md:col-start-2 md:row-start-2">
                                        <Label htmlFor="product-category" className="flex items-center gap-2 font-bold">
                                            <Tag className="h-4 w-4 text-primary/60" />
                                            {t('products.table.category')}
                                        </Label>
                                        <Select
                                            value={formData.categoryId || 'none'}
                                            onValueChange={(value) => setFormData((current) => ({ ...current, categoryId: value === 'none' ? undefined : value }))}
                                            disabled={isReadOnly}
                                        >
                                            <SelectTrigger id="product-category" className="h-12 rounded-xl border-border/80 bg-background/80 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50" allowViewer={true}>
                                                <SelectValue placeholder={t('categories.noCategory')} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">{t('categories.noCategory')}</SelectItem>
                                                {categories.map((category) => (
                                                    <SelectItem key={category.id} value={category.id}>
                                                        {category.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="order-3 space-y-2 md:order-none md:col-start-1 md:row-start-2">
                                        <Label htmlFor="product-unit" className="flex items-center gap-2 font-bold">
                                            <Ruler className="h-4 w-4 text-primary/60" />
                                            {t('products.form.unit')} *
                                        </Label>
                                        <Select
                                            value={unitSelectionValue}
                                            onValueChange={handleUnitSelectionChange}
                                            disabled={isReadOnly}
                                        >
                                            <SelectTrigger id="product-unit" data-tour-id="tutorial-product-unit" className="h-12 rounded-xl border-border/80 bg-background/80 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50" allowViewer={true}>
                                                <SelectValue placeholder={t('units.selectPlaceholder', { defaultValue: 'Select unit' })}>
                                                    {selectedUnitSelectionOption ? (
                                                        <span className="flex items-center gap-2">
                                                            {selectedUnitSelectionOption.kind === 'relationship' ? (
                                                                <>
                                                                    <Boxes className="h-4 w-4 text-primary" />
                                                                    {t('products.packaging.combinedUnitLabel', {
                                                                        parent: t(`products.units.${selectedUnitSelectionOption.parentUnitCode}`, { defaultValue: selectedUnitSelectionOption.parentUnitCode }),
                                                                        child: t(`products.units.${selectedUnitSelectionOption.childUnitCode}`, { defaultValue: selectedUnitSelectionOption.childUnitCode })
                                                                    })}
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <ProductUnitIcon unit={selectedUnitSelectionOption.unitCode} iconName={selectedUnitSelectionOption.icon} />
                                                                    {t(`products.units.${selectedUnitSelectionOption.unitCode}`, { defaultValue: selectedUnitSelectionOption.unitCode })}
                                                                </>
                                                            )}
                                                        </span>
                                                    ) : null}
                                                </SelectValue>
                                            </SelectTrigger>
                                            <SelectContent>
                                                {unitSelectionOptions.map((option) => (
                                                    <SelectItem key={option.value} value={option.value}>
                                                        <span className="flex items-center gap-2">
                                                            {option.kind === 'relationship' ? (
                                                                <>
                                                                    <Boxes className="h-4 w-4 text-primary" />
                                                                    {t('products.packaging.combinedUnitLabel', {
                                                                        parent: t(`products.units.${option.parentUnitCode}`, { defaultValue: option.parentUnitCode }),
                                                                        child: t(`products.units.${option.childUnitCode}`, { defaultValue: option.childUnitCode })
                                                                    })}
                                                                </>
                                                            ) : (
                                                                <>
                                                                    <ProductUnitIcon unit={option.unitCode} iconName={option.icon} />
                                                                    {t(`products.units.${option.unitCode}`, { defaultValue: option.unitCode })}
                                                                </>
                                                            )}
                                                        </span>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    {mode !== 'create' ? (
                                        <div className="order-5 space-y-2 md:order-none md:col-start-1 md:row-start-3">
                                            <Label htmlFor="product-storage-edit" className="flex items-center gap-2 font-bold">
                                                <Warehouse className="h-4 w-4 text-primary/60" />
                                                {t('storages.title') || 'Storage'}
                                            </Label>
                                            <Select
                                                value={formData.storageId}
                                                onValueChange={(value) => {
                                                    setFormData((current) => ({ ...current, storageId: value }))
                                                    setStorageError(false)
                                                }}
                                                disabled={isReadOnly || !canEditStockAllocation}
                                            >
                                                <SelectTrigger
                                                    ref={storageTriggerRef}
                                                    id="product-storage-edit"
                                                    className={cn('h-12 rounded-xl bg-background/80 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50', storageError ? 'border-destructive ring-2 ring-destructive/50' : 'border-border/80')}
                                                    allowViewer={true}
                                                >
                                                    <SelectValue placeholder={t('storages.selectStorage') || 'Select Storage'} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {storages.map((storage) => (
                                                        <SelectItem key={storage.id} value={storage.id}>
                                                            <div className="flex items-center gap-2">
                                                                <div className={cn('h-1.5 w-1.5 rounded-full', storage.isSystem ? 'bg-primary' : 'bg-muted-foreground/30')} />
                                                                {storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name}
                                                            </div>
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    ) : (
                                        <div className="order-5 space-y-2 md:order-none md:col-start-1 md:row-start-3">
                                            <Label htmlFor="product-storage" className="flex items-center gap-2 font-bold">
                                                <Warehouse className="h-4 w-4 text-primary/60" />
                                                {t('storages.title') || 'Storage'}
                                            </Label>
                                            <Select
                                                value={formData.storageId}
                                                onValueChange={(value) => {
                                                    setFormData((current) => ({ ...current, storageId: value }))
                                                    setStorageError(false)
                                                }}
                                                disabled={isReadOnly || !canEditStockAllocation}
                                            >
                                                <SelectTrigger
                                                    ref={storageTriggerRef}
                                                    id="product-storage"
                                                    data-tour-id="tutorial-product-storage"
                                                    className={cn('h-12 rounded-xl bg-background/80 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50', storageError ? 'border-destructive ring-2 ring-destructive/50' : 'border-border/80')}
                                                    allowViewer={true}
                                                >
                                                    <SelectValue placeholder={t('storages.selectStorage') || 'Select Storage'} />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {storages.map((storage) => (
                                                        <SelectItem key={storage.id} value={storage.id}>
                                                            <div className="flex items-center gap-2">
                                                                <div className={cn('h-1.5 w-1.5 rounded-full', storage.isSystem ? 'bg-primary' : 'bg-muted-foreground/30')} />
                                                                {storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name}
                                                            </div>
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                </div>
                                <div className="hidden">
                                    <div className="rounded-2xl border border-border/50 bg-background/80 p-4">
                                        <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.table.category')}</div>
                                        <div className="mt-1 text-sm font-semibold text-foreground">{selectedCategoryLabel}</div>
                                    </div>
                                    <div className="rounded-2xl border border-border/50 bg-background/80 p-4">
                                        <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.form.unit')}</div>
                                        <div className="mt-1 text-sm font-semibold text-foreground">{unitLabel}</div>
                                    </div>
                                    <div className="rounded-2xl border border-border/50 bg-background/80 p-4">
                                        <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                                            <Warehouse className="h-4 w-4 text-primary/60" />
                                            {t('storages.title') || 'Storage'}
                                        </div>
                                        <div className="mt-1 text-sm font-semibold text-foreground">{selectedStorageLabel}</div>
                                    </div>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {(isEditing || isClone) && (
                        <Card className="overflow-hidden rounded-2xl border-border/60 shadow-sm">
                            <CardHeader className="border-b border-border/50 bg-muted/10">
                                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="space-y-1">
                                        <CardTitle className="text-2xl font-black">
                                            {t('products.barcodes.title') || 'Barcodes'}
                                        </CardTitle>
                                        <p className="text-sm text-muted-foreground">
                                            {persistedProductId
                                                ? t('products.barcodes.manageDescription', {
                                                    defaultValue: 'Attach every scannable code that should resolve to this product in POS.'
                                                })
                                                : (t('products.barcodes.saveFirstDescription') || 'Save this product first, then manage its barcodes here.')}
                                        </p>
                                    </div>
                                    {persistedProductId && !isReadOnly && (
                                        <BarcodeScannerToggleButton
                                            enabled={activeScannerTarget === 'barcode'}
                                            onEnabledChange={handleBarcodeScannerEnabledChange}
                                            onScan={handleAdditionalBarcodeScan}
                                            label={t('products.barcodes.title') || 'Barcodes'}
                                            activeLabel={scannerEnabledLabel}
                                            inactiveLabel={scannerDisabledLabel}
                                            deviceStorageKey={PRODUCT_BARCODE_HID_DEVICE_KEY}
                                            targetInputRef={newBarcodeInputRef}
                                            idleCommitDelayMs={PRODUCT_FORM_SCANNER_IDLE_COMMIT_DELAY_MS}
                                        />
                                    )}
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-4 p-6 sm:p-8">
                                {persistedProductId ? (
                                    <>
                                        {productBarcodes.length > 0 ? (
                                            <div className="space-y-3">
                                                {productBarcodes.map((barcodeRow) => (
                                                    <div key={barcodeRow.id} className="rounded-2xl border border-border/60 bg-background/80 p-4">
                                                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                                            <div className="min-w-0 flex-1 space-y-3">
                                                                <div className="flex flex-wrap items-center gap-2">
                                                                    <span className="rounded-full border border-primary/15 bg-primary/10 px-3 py-1 font-mono text-sm font-bold text-primary">
                                                                        {barcodeRow.barcode}
                                                                    </span>
                                                                    {barcodeRow.isPrimary && (
                                                                        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] text-emerald-600">
                                                                            {t('products.barcodes.primary') || 'Primary'}
                                                                        </span>
                                                                    )}
                                                                </div>

                                                                {isReadOnly ? (
                                                                    <p className="text-sm text-muted-foreground">
                                                                        {barcodeRow.label || '—'}
                                                                    </p>
                                                                ) : (
                                                                    <div className="max-w-md space-y-2">
                                                                        <Label
                                                                            htmlFor={`product-barcode-label-${barcodeRow.id}`}
                                                                            className="text-[11px] font-black uppercase tracking-[0.16em] text-muted-foreground"
                                                                        >
                                                                            {t('products.barcodes.label') || 'Label'}
                                                                        </Label>
                                                                        <Input
                                                                            id={`product-barcode-label-${barcodeRow.id}`}
                                                                            defaultValue={barcodeRow.label || ''}
                                                                            placeholder={t('products.barcodes.label') || 'Label'}
                                                                            className="h-10 rounded-xl border-border/70 bg-background/75 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                                                            onBlur={(event) => {
                                                                                void handleBarcodeLabelBlur(barcodeRow, event.currentTarget.value)
                                                                            }}
                                                                            onKeyDown={(event) => {
                                                                                void handleBarcodeLabelKeyDown(event, barcodeRow)
                                                                            }}
                                                                        />
                                                                    </div>
                                                                )}
                                                            </div>

                                                            <div className="flex flex-wrap items-center gap-4 lg:justify-end">
                                                                <div className="flex items-center gap-3 rounded-full border border-border/50 bg-muted/20 px-3 py-2">
                                                                    <Label
                                                                        htmlFor={`product-barcode-primary-${barcodeRow.id}`}
                                                                        className="text-[11px] font-black uppercase tracking-[0.16em] text-muted-foreground"
                                                                    >
                                                                        {t('products.barcodes.primary') || 'Primary'}
                                                                    </Label>
                                                                    <Switch
                                                                        id={`product-barcode-primary-${barcodeRow.id}`}
                                                                        checked={barcodeRow.isPrimary}
                                                                        onCheckedChange={(checked) => {
                                                                            if (checked) {
                                                                                void handleSetPrimaryBarcode(barcodeRow)
                                                                            }
                                                                        }}
                                                                        disabled={isReadOnly || barcodeRow.isPrimary}
                                                                        className="data-[state=checked]:bg-emerald-500"
                                                                    />
                                                                </div>

                                                                {!isReadOnly && (
                                                                    <Button
                                                                        type="button"
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        aria-label={t('common.delete') || 'Delete'}
                                                                        onClick={() => setBarcodeToDelete(barcodeRow)}
                                                                        className="h-10 w-10 rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                                    >
                                                                        <Trash2 className="h-4 w-4" />
                                                                    </Button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="rounded-2xl border border-dashed border-border/70 bg-muted/10 p-6 text-sm text-muted-foreground">
                                                {t('products.barcodes.empty') || 'No barcodes added yet.'}
                                            </div>
                                        )}

                                        {!isReadOnly && (
                                            <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                                                <div className="grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_auto]">
                                                    <Input
                                                        ref={newBarcodeInputRef}
                                                        value={newBarcodeValue}
                                                        onChange={(event) => setNewBarcodeValue(normalizeBarcodeScannerText(event.target.value))}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter') {
                                                                event.preventDefault()
                                                                void handleAddBarcode()
                                                            }
                                                        }}
                                                        placeholder="0123456789012"
                                                        className="h-11 rounded-xl border-border/80 bg-background/80 font-mono shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                                    />
                                                    <Input
                                                        value={newBarcodeLabel}
                                                        onChange={(event) => setNewBarcodeLabel(event.target.value)}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter') {
                                                                event.preventDefault()
                                                                void handleAddBarcode()
                                                            }
                                                        }}
                                                        placeholder={t('products.barcodes.label') || 'Label'}
                                                        className="h-11 rounded-xl border-border/80 bg-background/80 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                                    />
                                                    <Button
                                                        type="button"
                                                        onClick={() => void handleAddBarcode()}
                                                        disabled={!newBarcodeValue.trim() || isSubmittingBarcode}
                                                        className="h-11 gap-2 rounded-xl px-5 font-black"
                                                    >
                                                        <Plus className="h-4 w-4" />
                                                        {t('products.barcodes.addBarcode') || 'Add Barcode'}
                                                    </Button>
                                                </div>
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <div className="rounded-2xl border border-dashed border-border/70 bg-muted/10 p-6">
                                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                            <div className="space-y-1">
                                                <div className="text-sm font-bold text-foreground">
                                                    {t('products.barcodes.saveFirst') || 'Save the product first'}
                                                </div>
                                                <p className="text-sm text-muted-foreground">
                                                    {t('products.barcodes.saveFirstDescription') || 'Create this product before attaching barcode records to it.'}
                                                </p>
                                            </div>
                                            <span className="rounded-full border border-border/60 bg-background/70 px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] text-muted-foreground">
                                                {mode === 'clone' ? (t('common.clone') || 'Clone') : (t('common.create') || 'Create')}
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    )}

                    <Card className="overflow-hidden rounded-2xl border-border/60 shadow-sm">
                        <CardHeader className="border-b border-border/50 bg-gradient-to-r from-primary/5 via-transparent to-transparent">
                            <CardTitle className="text-2xl font-black">
                                {t('products.form.pricing') || 'Pricing'}
                            </CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t('products.form.pricingDesc') || 'Set the selling price, cost basis, and active currency for this product.'}
                            </p>

                        </CardHeader>
                        <CardContent className="space-y-6 p-6 sm:p-8">
                            <div className="space-y-4">
                                <div className="grid gap-6 md:grid-cols-3">
                                    <div className="space-y-2">
                                        <Label htmlFor="product-price" className="flex items-center gap-2 font-bold">
                                            <DollarSign className="h-4 w-4 text-primary/60" />
                                            {selectedUnitRelationshipForDisplay
                                                ? t('products.packaging.childPrice', {
                                                    unit: t(
                                                        `products.units.${selectedUnitRelationshipForDisplay.childUnitCode}`,
                                                        { defaultValue: selectedUnitRelationshipForDisplay.childUnitCode }
                                                    )
                                                })
                                                : t('products.form.price')} *
                                        </Label>
                                        {isDynamicUnit(formData.unit) ? (
                                            <div className="flex items-start gap-1.5">
                                                <div className="relative flex-[2] min-w-0">
                                                    <NumericInput
                                                        id="product-price"
                                                        data-tour-id="tutorial-product-price"
                                                        value={formData.price}
                                                        onValueChange={(price) => setFormData((current) => ({ ...current, price }))}
                                                        maxFractionDigits={4}
                                                        placeholder="0"
                                                        readOnly={isReadOnly}
                                                        required
                                                        className="h-12 rounded-xl border-border/80 bg-background/80 pr-3 text-lg font-black text-primary shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                                    />
                                                </div>
                                                <div className="flex items-center gap-1.5 pt-3 shrink-0">
                                                    <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap">{t('products.form.per') || 'per'}</span>
                                                    <Input
                                                        id="product-per-quantity"
                                                        type="text"
                                                        inputMode="decimal"
                                                        value={formData.perQuantity}
                                                        onChange={(event) => {
                                                            const val = event.target.value
                                                            if (/^\d*\.?\d*$/.test(val) || val === '') {
                                                                setFormData((current) => ({ ...current, perQuantity: val }))
                                                            }
                                                        }}
                                                        className="h-9 w-24 rounded-lg border-border/80 bg-background/80 text-center text-sm font-medium tabular-nums shadow-sm transition-all hover:border-primary/45 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                                        placeholder="1"
                                                        readOnly={isReadOnly}
                                                    />
                                                    <span className="text-xs font-bold text-muted-foreground">{unitLabel}</span>
                                                    <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/40 ml-0.5">
                                                        {getCurrencySymbol(formData.currency, features.iqd_display_preference)}
                                                    </span>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="relative">
                                                <NumericInput
                                                    id="product-price"
                                                    data-tour-id="tutorial-product-price"
                                                    value={formData.price}
                                                    onValueChange={(price) => setFormData((current) => ({ ...current, price }))}
                                                    maxFractionDigits={4}
                                                    placeholder="0.000"
                                                    readOnly={isReadOnly}
                                                    required
                                                    className="h-12 rounded-xl border-border/80 bg-background/80 pr-16 text-lg font-black text-primary shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                                />
                                                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">
                                                    {getCurrencySymbol(formData.currency, features.iqd_display_preference)}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="space-y-2" data-tour-id="tutorial-product-currency">
                                        <CurrencySelector
                                            label={t('products.form.currency') || 'Currency'}
                                            value={formData.currency}
                                            onChange={(value) => setFormData((current) => ({ ...current, currency: value }))}
                                            iqdDisplayPreference={features.iqd_display_preference}
                                            disabled={isReadOnly}
                                        />
                                    </div>
                                    {!hideCosts && (
                                        <div className="space-y-2">
                                            <Label htmlFor="product-cost-price" className="flex items-center gap-2 font-bold">
                                                <Wallet className="h-4 w-4 text-primary/60" />
                                                {t('products.form.cost')}
                                            </Label>
                                            <div className="relative">
                                                <NumericInput
                                                    id="product-cost-price"
                                                    data-tour-id="tutorial-product-cost-price"
                                                    value={formData.costPrice}
                                                    onValueChange={(costPrice) => setFormData((current) => ({ ...current, costPrice }))}
                                                    maxFractionDigits={4}
                                                    placeholder="0.000"
                                                    readOnly={isReadOnly}
                                                    required={!hideCosts}
                                                    className={cn(
                                                        "h-12 rounded-xl border-border/80 bg-background/80 font-bold shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50",
                                                        isDynamicUnit(formData.unit) ? "pr-8" : "pr-16",
                                                        highlightMissingCosts && formData.costPrice.trim() === ''
                                                            && 'border-destructive bg-destructive/5 ring-2 ring-destructive/20 hover:border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30'
                                                    )}
                                                />
                                                <span className={cn(
                                                    "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-bold uppercase tracking-wider text-muted-foreground/60",
                                                    isDynamicUnit(formData.unit) ? "text-[10px]" : "text-xs"
                                                )}>
                                                    {getCurrencySymbol(formData.currency, features.iqd_display_preference)}
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className={cn('grid gap-3', hideCosts ? 'sm:grid-cols-1' : 'sm:grid-cols-3')}>
                                    <div className="rounded-2xl border border-border/50 bg-background/80 p-4">
                                        <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.table.price')}</div>
                                        <div className="mt-1 text-base font-black text-primary">{pricePreview}</div>
                                    </div>
                                    {!hideCosts && (
                                        <>
                                            <div className="rounded-2xl border border-border/50 bg-background/80 p-4">
                                                <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.form.cost')}</div>
                                                <div className="mt-1 text-base font-black text-foreground">{costPreview ?? '—'}</div>
                                            </div>
                                            <div className="rounded-2xl border border-border/50 bg-background/80 p-4">
                                                <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.form.margin') || 'Margin'}</div>
                                                <div className={cn('mt-1 text-base font-black', marginValue != null && marginValue < 0 ? 'text-destructive' : 'text-emerald-600')}>
                                                    {marginPreview ?? '—'}
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                            {selectedUnitRelationshipForDisplay ? (
                                <ProductUnitPackagingSection
                                    relationship={selectedUnitRelationshipForDisplay}
                                    units={customUnits}
                                    draft={unitPackaging}
                                    childPrice={formData.price}
                                    currency={formData.currency}
                                    iqdDisplayPreference={features.iqd_display_preference}
                                    disabled={isReadOnly || isSaving}
                                    onChange={setUnitPackaging}
                                />
                            ) : null}

                            {priceBooksEnabled ? (
                                isPriceBookCatalogReady ? (
                                    <div ref={overrideSectionRef}>
                                        <ProductPriceBookItemsEditor
                                            priceBooks={priceBooks}
                                            rows={priceBookRows}
                                            onChange={setPriceBookRows}
                                            defaultCostPrice={effectiveCost == null ? '' : String(effectiveCost)}
                                            defaultPrice={String(effectivePrice)}
                                            defaultParentPrice={unitPackaging.parentPrice}
                                            parentUnitLabel={unitPackaging.relationshipId
                                                ? t(
                                                    `products.units.${selectedUnitRelationshipForDisplay?.parentUnitCode}`,
                                                    { defaultValue: selectedUnitRelationshipForDisplay?.parentUnitCode || '' }
                                                )
                                                : undefined}
                                            defaultCurrency={formData.currency}
                                            allowedCurrencies={features.allowed_currencies}
                                            iqdDisplayPreference={features.iqd_display_preference}
                                            disabled={isReadOnly}
                                            hideCosts={hideCosts}
                                            highlightMissingCosts={highlightMissingCosts}
                                            attention={overrideAttention}
                                        />
                                    </div>
                                ) : (
                                    <div className="border-t border-border/60 pt-6">
                                        <div className={cn(
                                            'rounded-2xl border px-4 py-6 text-center text-sm',
                                            priceBookCatalogError
                                                ? 'border-destructive/40 bg-destructive/5 text-destructive'
                                                : 'border-dashed border-border/70 bg-muted/20 text-muted-foreground'
                                        )}>
                                            {priceBookCatalogError
                                                ? t('priceBooks.loadingError', {
                                                    defaultValue: 'Price Book prices could not be loaded. Retrying automatically...'
                                                })
                                                : t('priceBooks.loading', { defaultValue: 'Loading Price Book prices...' })}
                                        </div>
                                    </div>
                                )
                            ) : null}
                            {productCommissionsEnabled ? (
                                isProductCommissionCatalogReady ? (
                                    <ProductCommissionRuleEditor
                                        workspaceId={workspaceId}
                                        draft={productCommissionDraft}
                                        onChange={setProductCommissionDraft}
                                        iqdDisplayPreference={features.iqd_display_preference}
                                        validationMessage={productCommissionValidationMessage}
                                        disabled={isReadOnly || isSaving}
                                    />
                                ) : (
                                    <div className="border-t border-border/60 pt-6">
                                        <div className={cn(
                                            'rounded-2xl border px-4 py-6 text-center text-sm',
                                            productCommissionCatalogError
                                                ? 'border-destructive/40 bg-destructive/5 text-destructive'
                                                : 'border-dashed border-border/70 bg-muted/20 text-muted-foreground'
                                        )}>
                                            {productCommissionCatalogError
                                                ? t('salesAgentCommissions.productCommission.loadingError')
                                                : t('salesAgentCommissions.productCommission.loading')}
                                        </div>
                                    </div>
                                )
                            ) : null}
                        </CardContent>
                    </Card>

                    <Card className="overflow-hidden rounded-2xl border-border/60 shadow-sm">
                        <CardHeader className="border-b border-border/50 bg-muted/10">
                            <CardTitle className="text-2xl font-black">
                                {t('products.form.inventoryAndReturnsTitle') || 'Inventory & Returns'}
                            </CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t('products.form.inventoryAndReturnsDesc') || 'Track stock levels and define whether this product can be returned.'}
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-6 p-6 sm:p-8">
                            <div className="space-y-4">
                                <div className="grid gap-6 md:grid-cols-2">
                                    {(() => {
                                        const addStockLabel = t('products.addStock', { defaultValue: 'Add Stock' })
                                        const hint = isMobile()
                                            ? t('products.form.stockAdjustmentHint.mobile', {
                                                addStock: addStockLabel,
                                                defaultValue: `To adjust stock, tap the "${addStockLabel}" button on the product's card in the Products list.`
                                            })
                                            : t('products.form.stockAdjustmentHint.desktop', {
                                                addStock: addStockLabel,
                                                defaultValue: `To adjust stock, right-click the product's row in the Products list and choose "${addStockLabel}" from the menu.`
                                            })
                                        const stockField = (
                                            <>
                                                <Label htmlFor="product-quantity" className="flex items-center gap-2 font-bold">
                                                    <Boxes className="h-4 w-4 text-primary/60" />
                                                    {t('products.form.stock')}
                                                </Label>
                                                <div className="relative">
                                                    <Input
                                                        id="product-quantity"
                                                        data-tour-id="tutorial-product-initial-stock"
                                                        type="number"
                                                        inputMode="decimal"
                                                        min="0"
                                                        step={isDynamicUnit(formData.unit) ? '0.01' : '1'}
                                                        value={formData.quantity}
                                                        onChange={(event) => setFormData((current) => ({
                                                            ...current,
                                                            quantity: event.target.value === '' ? '' : Number(event.target.value)
                                                        }))}
                                                        placeholder="0"
                                                        readOnly={isReadOnly || isEditing}
                                                        required
                                                        className="h-12 rounded-xl border-border/80 bg-background/80 pr-16 font-black shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                                    />
                                                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">
                                                        {unitLabel}
                                                    </span>
                                                </div>
                                            </>
                                        )
                                        return isEditing ? (
                                            <HoverHintVideo
                                                src="export-1785734352530.mp4"
                                                title={t('products.form.stockAdjustmentHint.videoTitle', { defaultValue: 'Watch how to adjust stock' })}
                                                triggerClassName="block"
                                            >
                                                <div className="space-y-2">
                                                    {stockField}
                                                    <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-700">
                                                        {hint}
                                                    </div>
                                                </div>
                                            </HoverHintVideo>
                                        ) : (
                                            <div className="space-y-2">
                                                {stockField}
                                            </div>
                                        )
                                    })()}
                                    <div className="space-y-2">
                                        <Label htmlFor="product-min-stock" className="flex items-center gap-2 font-bold">
                                            <Info className="h-4 w-4 text-primary/60" />
                                            {t('products.form.minStock')}
                                        </Label>
                                        <div className="relative">
                                            <Input
                                                id="product-min-stock"
                                                type="number"
                                                inputMode="decimal"
                                                min="0"
                                                step={isDynamicUnit(formData.unit) ? '0.01' : '1'}
                                                value={formData.minStockLevel}
                                                onChange={(event) => setFormData((current) => ({
                                                    ...current,
                                                    minStockLevel: event.target.value === '' ? '' : Number(event.target.value)
                                                }))}
                                                readOnly={isReadOnly}
                                                required
                                                className="h-12 rounded-xl border-border/80 bg-background/80 pr-16 font-bold shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                            />
                                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold uppercase tracking-wider text-muted-foreground/60">
                                                {unitLabel}
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <div className={cn(
                                    'rounded-2xl border p-4 text-sm font-medium',
                                    lowStock
                                        ? 'border-amber-500/20 bg-amber-500/10 text-amber-700'
                                        : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700'
                                )}>
                                    {lowStock
                                        ? t('products.form.lowStockWarning', { defaultValue: 'Stock is at or below the minimum threshold of {{min}} {{unit}}.', min: minStockValue, unit: unitLabel })
                                        : (t('products.form.goodStockNotice') || 'Current stock is above the minimum threshold.')}
                                </div>

                                <div className="rounded-2xl border border-border/60 bg-muted/30 p-5" data-tour-id="tutorial-product-returnable">
                                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                        <div className="space-y-1 text-start">
                                            <Label htmlFor="product-can-be-returned" className="flex cursor-pointer items-center gap-2 text-base font-black text-foreground/90">
                                                <div className={cn(
                                                    'flex h-8 w-8 items-center justify-center rounded-xl shadow-sm transition-colors',
                                                    formData.canBeReturned ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'
                                                )}>
                                                    <ChevronRight className={cn('h-4 w-4 transition-transform', formData.canBeReturned && 'rotate-90')} />
                                                </div>
                                                {t('products.form.canBeReturned') || 'Can be Returned'}
                                            </Label>
                                            <p className="pl-10 text-sm font-medium leading-relaxed text-muted-foreground/80">
                                                {formData.canBeReturned
                                                    ? (t('products.form.canBeReturnedDesc') || 'Customers can return this product.')
                                                    : (t('products.form.cannotBeReturnedDesc') || 'This product is non-returnable.')}
                                            </p>
                                        </div>
                                        <div className="flex items-center">
                                            <Switch
                                                id="product-can-be-returned"
                                                checked={formData.canBeReturned}
                                                onCheckedChange={(checked) => setFormData((current) => ({ ...current, canBeReturned: checked }))}
                                                disabled={isReadOnly}
                                                className="data-[state=checked]:bg-emerald-500"
                                            />
                                        </div>
                                    </div>

                                    {formData.canBeReturned && (
                                        <div className="mt-5 rounded-2xl border border-border/50 bg-background/80 p-4">
                                            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                                                <div className="space-y-1">
                                                    <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">
                                                        {t('products.form.returnRulesTitle') || 'Return Rules'}
                                                    </div>
                                                    <p className="text-sm leading-6 text-muted-foreground">
                                                        {returnRulesPreview}
                                                    </p>
                                                </div>
                                                {!isReadOnly && (
                                                    <Button
                                                        type="button"
                                                        variant="secondary"
                                                        size="sm"
                                                        onClick={() => setReturnRulesModalOpen(true)}
                                                        className="h-10 gap-2 rounded-xl border border-primary/10 px-5 font-bold"
                                                    >
                                                        <Settings className="h-4 w-4" />
                                                        {formData.returnRules.trim()
                                                            ? (t('products.form.editRules') || 'Edit rules')
                                                            : (t('products.form.addRules') || 'Add rules')}
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {isEditing && product && !product.parentProductId && (
                        <ProductVariantsSection
                            parent={product}
                            variants={productVariants}
                            products={catalogProducts}
                            workspaceId={workspaceId}
                            userId={user?.id}
                            categories={categories}
                            storages={storages}
                            unitOptions={unitOptions}
                            allowedCurrencies={features.allowed_currencies}
                            iqdDisplayPreference={features.iqd_display_preference}
                            priceBooksEnabled={priceBooksEnabled}
                            priceBooks={priceBooks}
                            priceBookItems={priceBookItems}
                            isPriceBookCatalogReady={isPriceBookCatalogReady}
                            priceBookCatalogError={priceBookCatalogError}
                            variantSkuScannerEnabled={activeScannerTarget === 'variantSku'}
                            onVariantSkuScannerEnabledChange={handleVariantSkuScannerEnabledChange}
                            onVariantSkuScannerDialogOpen={handleVariantSkuScannerDialogOpen}
                            onVariantSkuScannerDialogClose={handleVariantSkuScannerDialogClose}
                            canManage={!isReadOnly}
                            hideCosts={hideCosts}
                            onOpenProduct={(variantId) => navigate(`/products/${variantId}`)}
                        />
                    )}

                    <Dialog
                        open={visualsModalOpen}
                        onOpenChange={(nextOpen) => {
                            if (!isImageProcessing) setVisualsModalOpen(nextOpen)
                        }}
                    >
                        <DialogContent
                            className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto rounded-2xl border-border/60 p-0 sm:w-[calc(100vw-2rem)]"
                            onPaste={handleVisualsPaste}
                        >
                            <DialogHeader className="border-b border-border/50 bg-muted/10 px-5 py-4 sm:px-6">
                                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                                    <div>
                                    <DialogTitle className="text-2xl font-black">
                                        {t('products.form.visuals') || 'Visuals'}
                                    </DialogTitle>
                                    <p className="mt-1 text-sm text-muted-foreground">
                                        {t('products.form.visualsDesc') || 'Upload or link a product image and keep the preview synced with the current record.'}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setAdditionalImagesModalOpen(true)}
                                    disabled={!persistedProductId}
                                    title={!persistedProductId ? 'Save this product before managing additional images.' : undefined}
                                    className="h-10 shrink-0 gap-2 rounded-xl border-primary/20 font-bold"
                                >
                                    <Images className="h-4 w-4" />
                                    Additional Images
                                </Button>
                            </div>
                            </DialogHeader>
                        <div className="space-y-6 p-5 sm:p-6">
                            <div className="space-y-4">

                                <div className="flex flex-col items-start gap-6 md:flex-row">
                                    <div className="relative aspect-square w-full shrink-0 overflow-hidden rounded-xl border-2 border-dashed border-primary/20 bg-muted/30 shadow-inner md:w-44">
                                        {!formData.imageUrl ? (
                                            <div className="flex h-full flex-col items-center justify-center gap-3">
                                                <ImagePlus className="h-8 w-8 text-primary" />
                                                <span className="text-[10px] font-black uppercase tracking-tighter text-primary/60">
                                                    {t('products.form.noImage') || 'No Preview'}
                                                </span>
                                            </div>
                                        ) : imageError ? (
                                            <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center">
                                                <Package className="h-10 w-10 text-destructive/30" />
                                                <span className="text-[11px] font-bold uppercase text-destructive/60">
                                                    {t('products.form.imageError') || 'Image Error'}
                                                </span>
                                            </div>
                                        ) : (
                                            <>
                                                <img
                                                    src={getDisplayImageUrl(formData.imageUrl)}
                                                    alt={formData.name || 'Product preview'}
                                                    className="h-full w-full object-cover"
                                                    onError={() => setImageError(true)}
                                                />
                                                {!isReadOnly && (
                                                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity hover:opacity-100">
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            aria-label={t('common.delete') || 'Delete'}
                                                            onClick={handleRemoveImage}
                                                            className="h-12 w-12 rounded-full bg-destructive/90 text-white hover:bg-destructive"
                                                        >
                                                            <Trash2 className="h-6 w-6" />
                                                        </Button>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>

                                        <div className="w-full flex-1 space-y-4">
                                        {(isDesktopShell || !isLocalWorkspaceMode(workspaceId)) && (
                                            <div className="space-y-2">
                                                <Label htmlFor="product-image-url" className="flex items-center gap-2 font-bold">
                                                    <Link className="h-4 w-4 text-primary/60" />
                                                    {t('products.form.importImageUrl', { defaultValue: 'Import image from URL' })}
                                                </Label>
                                                <div className="flex flex-col gap-3 sm:flex-row">
                                                    <Input
                                                        id="product-image-url"
                                                        value={externalImageUrl}
                                                        onChange={(event) => setExternalImageUrl(event.target.value)}
                                                        placeholder={t('products.form.imageUrlPlaceholder', { defaultValue: 'Paste a public image URL...' })}
                                                        readOnly={isReadOnly || isImageProcessing}
                                                        className="h-12 flex-1 rounded-xl border-border/80 bg-background/80 shadow-sm shadow-black/[0.03] transition-all hover:border-primary/45 hover:bg-background focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 dark:bg-background/50"
                                                    />
                                                    {!isReadOnly && (
                                                        <Button
                                                            type="button"
                                                            variant="outline"
                                                            onClick={handleImportProductImage}
                                                            disabled={isImageProcessing || !externalImageUrl.trim()}
                                                            className="h-12 gap-2 rounded-lg border-primary/20 px-6 font-bold"
                                                        >
                                                            {isImageProcessing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Link className="h-4 w-4" />}
                                                            {isImageProcessing
                                                                ? t('products.form.importingImage', { defaultValue: 'Importing...' })
                                                                : t('products.form.importImage', { defaultValue: 'Import' })}
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {!isReadOnly && (
                                            <div className="flex flex-wrap gap-2">
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    onClick={handleImageUpload}
                                                    disabled={isImageProcessing || (!isDesktopShell && isLocalWorkspaceMode(workspaceId))}
                                                    className="h-12 gap-2 rounded-lg border-primary/20 px-6 font-bold"
                                                >
                                                    {isImageProcessing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                                                    {isImageProcessing
                                                        ? t('products.form.processingImage', { defaultValue: 'Processing...' })
                                                        : t('products.form.upload', { defaultValue: 'Upload' })}
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    aria-label={t('products.form.camera') || 'Camera'}
                                                    onClick={() => cameraInputRef.current?.click()}
                                                    disabled={isImageProcessing || (!isDesktopShell && isLocalWorkspaceMode(workspaceId))}
                                                    className="h-12 gap-2 rounded-lg border-primary/20 px-4 font-bold text-primary sm:px-6"
                                                >
                                                    <Camera className="h-4 w-4" />
                                                    <span className="hidden sm:inline">{t('products.form.camera') || 'Camera'}</span>
                                                </Button>
                                            </div>
                                        )}

                                        <div className="flex items-start gap-3 rounded-xl border border-border/40 bg-muted/30 p-4">
                                            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                            <div className="space-y-1 text-[11px] font-medium leading-relaxed text-muted-foreground/80">
                                                <p>
                                                    {isDesktopShell
                                                        ? (t('products.form.localPathDesc') || 'Image will be stored locally on this device and synced to other devices in your workspace.')
                                                        : isLocalWorkspaceMode(workspaceId)
                                                            ? t('products.form.imageErrors.cloud_required', { defaultValue: 'Product images need cloud storage in this workspace.' })
                                                        : (t('products.form.webUploadDesc') || 'Image will be securely uploaded and synced via cloud storage.')}
                                                </p>
                                                {!isReadOnly && <p>{t('products.form.pasteImageHint')}</p>}
                                            </div>
                                        </div>

                                        <input
                                            ref={cameraInputRef}
                                            type="file"
                                            className="hidden"
                                            accept="image/*"
                                            capture="environment"
                                            onChange={handleCameraCapture}
                                        />
                                        <input
                                            ref={imageUploadInputRef}
                                            type="file"
                                            className="hidden"
                                            accept="image/*"
                                            onChange={handleImageFileInputChange}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                        </DialogContent>
                    </Dialog>
                </div>

                <div className="hidden space-y-6">
                    <Card className="border-border/60 shadow-sm">
                        <CardHeader className="space-y-1">
                            <CardTitle className="text-xl">{t('products.summaryTitle') || 'Live Summary'}</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {t('products.summaryDescription') || 'A compact snapshot of price, stock, storage, and return behavior while you edit.'}
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div className="rounded-2xl border border-border/50 bg-muted/20 p-4">
                                <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.table.name')}</div>
                                <div className="mt-1 text-xl font-black text-foreground">{formData.name || (t('products.form.name') || 'Product name')}</div>
                                <div className="mt-1 text-sm font-medium text-muted-foreground">{formData.sku || '--'}</div>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                                <div className="rounded-2xl border border-border/50 bg-background/70 p-4">
                                    <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.table.price')}</div>
                                    <div className="mt-1 text-base font-black text-primary">{pricePreview}</div>
                                </div>
                                <div className="rounded-2xl border border-border/50 bg-background/70 p-4">
                                    <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.form.cost')}</div>
                                    <div className="mt-1 text-base font-black text-foreground">{costPreview}</div>
                                </div>
                                <div className="rounded-2xl border border-border/50 bg-background/70 p-4">
                                    <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.form.stock')}</div>
                                    <div className={cn('mt-1 text-base font-black', lowStock ? 'text-amber-600' : 'text-foreground')}>
                                        {quantityValue} {unitLabel}
                                    </div>
                                </div>
                                <div className="rounded-2xl border border-border/50 bg-background/70 p-4">
                                    <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('storages.title') || 'Storage'}</div>
                                    <div className="mt-1 text-sm font-semibold text-foreground">{selectedStorageLabel}</div>
                                </div>
                            </div>
                            <div className="rounded-2xl border border-border/50 bg-background/70 p-4">
                                <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.form.canBeReturned') || 'Can be Returned'}</div>
                                <div className="mt-1 text-sm font-semibold text-foreground">
                                    {formData.canBeReturned ? (t('common.yes') || 'Yes') : (t('common.no') || 'No')}
                                </div>
                                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                                    {formData.canBeReturned
                                        ? returnRulesPreview
                                        : (t('products.form.cannotBeReturnedDesc') || 'This product is non-returnable.')}
                                </p>
                            </div>
                            <div className="rounded-2xl border border-border/50 bg-background/70 p-4">
                                <div className="text-[11px] font-black uppercase tracking-[0.18em] text-muted-foreground">{t('products.table.category')}</div>
                                <div className="mt-1 text-sm font-semibold text-foreground">{selectedCategoryLabel}</div>
                            </div>
                        </CardContent>
                    </Card>
                    <Card className="border-border/60 shadow-sm xl:sticky xl:top-24">
                        <CardHeader className="space-y-1">
                            <CardTitle className="text-xl">{isReadOnly ? (t('common.view') || 'View') : (t('common.actions') || 'Actions')}</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {isReadOnly
                                    ? (t('products.readOnlyActionsHint') || 'This product is open in read-only mode.')
                                    : (t('products.actionsHint') || 'Review your changes, then save or leave this page from here.')}
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {!isReadOnly && (
                                <Button
                                    type="submit"
                                    form="product-form-page"
                                    disabled={isSaving || isImageProcessing || (priceBooksEnabled && !isPriceBookCatalogReady) || Boolean(productCommissionValidationMessage)}
                                    className="h-12 w-full rounded-xl font-black"
                                    data-tour-id="tutorial-product-save"
                                >
                                    {isSaving
                                        ? (t('common.loading') || 'Loading...')
                                        : isClone
                                            ? (t('common.clone') || 'Clone')
                                            : isEditing
                                                ? (t('common.save') || 'Save')
                                                : (t('common.create') || 'Create')}
                                </Button>
                            )}
                            <Button type="button" variant="outline" allowViewer={true} onClick={goToProducts} className="h-12 w-full rounded-xl">
                                {isReadOnly ? (t('common.back') || 'Back') : (t('common.cancel') || 'Cancel')}
                            </Button>
                            {!isReadOnly && (
                                <div className="rounded-2xl border border-border/50 bg-muted/20 p-4 text-xs leading-5 text-muted-foreground">
                                    {isEditing
                                        ? (t('products.saveHintEdit') || 'Saving updates product details, image, pricing, and return settings. Stock changes happen in Stock Adjustments.')
                                        : (t('products.saveHint') || 'Saving applies the current details, image, stock, and return settings together.')}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </form>

            <ProductAdditionalImagesModal
                open={additionalImagesModalOpen}
                onOpenChange={setAdditionalImagesModalOpen}
                workspaceId={workspaceId}
                productId={persistedProductId}
                productName={formData.name}
                primaryImageUrl={formData.imageUrl}
                canManage={!isReadOnly && canEdit}
            />

            <Dialog open={returnRulesModalOpen} onOpenChange={setReturnRulesModalOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Settings className="h-5 w-5 text-primary" />
                            {t('products.form.returnRulesTitle') || 'Return Rules'}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <Label htmlFor="product-return-rules">
                                    {t('products.form.rulesLabel') || 'Specify return conditions'}
                                </Label>
                                <span className={cn(
                                    'text-[10px] font-mono',
                                    formData.returnRules.length >= 225 ? 'font-bold text-destructive' : 'text-muted-foreground'
                                )}>
                                    {formData.returnRules.length}/250
                                </span>
                            </div>
                            <Textarea
                                id="product-return-rules"
                                value={formData.returnRules}
                                onChange={(event) => setFormData((current) => ({
                                    ...current,
                                    returnRules: event.target.value.slice(0, 250)
                                }))}
                                placeholder={t('products.form.rulesPlaceholder') || 'e.g. Must be in original packaging, Only within 7 days...'}
                                rows={6}
                                maxLength={250}
                                readOnly={isReadOnly}
                                className="resize-none"
                            />
                        </div>
                        <p className="text-xs italic text-muted-foreground">
                            {t('products.form.rulesHint') || 'These rules will be shown to staff during the return process.'}
                        </p>
                    </div>
                    <DialogFooter>
                        <Button type="button" onClick={() => setReturnRulesModalOpen(false)}>
                            {t('common.done') || 'Done'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DeleteConfirmationModal
                isOpen={deleteProductOpen}
                onClose={() => {
                    if (!isDeletingProduct) {
                        setDeleteProductOpen(false)
                    }
                }}
                onConfirm={() => {
                    void handleConfirmDeleteProduct()
                }}
                isLoading={isDeletingProduct}
                title={t('products.confirmDelete', { defaultValue: 'Delete Product' })}
                description={productVariants.length > 0
                    ? t('products.variants.deleteParentDescription', {
                        defaultValue: 'This will remove the parent product. Its {{count}} variants will stay as independent products.',
                        count: productVariants.length
                    })
                    : t('products.deleteDescription', { defaultValue: 'This will remove the product from your catalog.' })}
                itemName={product?.name || formData.name}
            />

            <DeleteConfirmationModal
                isOpen={!!barcodeToDelete}
                onClose={() => {
                    if (!isDeletingBarcode) {
                        setBarcodeToDelete(null)
                    }
                }}
                onConfirm={() => {
                    void handleConfirmDeleteBarcode()
                }}
                isLoading={isDeletingBarcode}
                title={t('products.barcodes.deleteConfirm') || 'Remove this barcode?'}
                description={t('products.barcodes.deleteConfirm') || 'Remove this barcode?'}
                itemName={barcodeToDelete?.barcode || ''}
            />

            {!isReadOnly && (
                <Dialog open={showGuard} onOpenChange={(open) => { if (!open) cancelNavigation() }}>
                    <DialogContent className="max-w-md rounded-3xl">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <Info className="h-5 w-5 text-amber-500" />
                                {t('common.unsavedChanges.title') || 'Unsaved Changes'}
                            </DialogTitle>
                        </DialogHeader>
                        <p className="text-sm text-muted-foreground">
                            {t('common.unsavedChanges.message') || 'You have unsaved changes. Would you like to save your work before leaving?'}
                        </p>
                        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => confirmNavigation(navigate)}>
                                {t('common.unsavedChanges.discard') || 'Discard Changes'}
                            </Button>
                            <div className="flex gap-2">
                                <Button variant="secondary" onClick={() => cancelNavigation()}>
                                    {t('common.unsavedChanges.continue') || 'Continue Editing'}
                                </Button>
                                <Button
                                    disabled={isSaving || isImageProcessing || (priceBooksEnabled && !isPriceBookCatalogReady) || Boolean(productCommissionValidationMessage)}
                                    onClick={async () => {
                                        const didSave = await persistProduct({ navigateAfterSave: false })
                                        if (didSave) {
                                            confirmNavigation(navigate)
                                        }
                                    }}
                                >
                                    {isSaving ? (t('common.loading') || 'Loading...') : (t('common.unsavedChanges.save') || 'Save Changes')}
                                </Button>
                            </div>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            )}
        </div>
    )
}

export function ProductCreatePage() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const [, navigate] = useLocation()

    const storageCount = useLiveQuery(
        async () => {
            if (!user?.workspaceId) return 0
            return db.storages
                .where('workspaceId')
                .equals(user.workspaceId)
                .and((s) => !s.isDeleted)
                .count()
        },
        [user?.workspaceId]
    )

    if (storageCount === undefined) {
        return null
    }

    if (storageCount === 0) {
        return (
            <div className="flex h-full w-full items-center justify-center">
                <Dialog open={true} onOpenChange={() => navigate('/products')}>
                    <DialogContent
                        className="max-w-md rounded-2xl [&>button.absolute]:hidden"
                        onInteractOutside={(e) => e.preventDefault()}
                    >
                        <DialogHeader>
                            <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
                                <Warehouse className="h-7 w-7 text-amber-600 dark:text-amber-400" />
                            </div>
                            <DialogTitle className="text-center text-xl">
                                {t('products.noStorage.title') || 'No Storage Found'}
                            </DialogTitle>
                        </DialogHeader>
                        <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                            {t('products.noStorage.description') || 'You need to create a storage location before adding products.'}
                        </div>
                        <DialogFooter className="gap-2">
                            <Button variant="outline" onClick={() => navigate('/products')}>
                                {t('common.goBack') || 'Go Back'}
                            </Button>
                            <Button onClick={() => navigate('/storages')}>
                                <Warehouse className="mr-2 h-4 w-4" />
                                {t('products.noStorage.goToStorage') || 'Go to Storage Settings'}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        )
    }

    return <ProductEditor mode="create" />
}

export function ProductEditPage() {
    const [, params] = useRoute('/products/:productId')
    return <ProductEditor mode="edit" productId={params?.productId} />
}

export function ProductClonePage() {
    const [, params] = useRoute('/products/:productId/clone')
    return <ProductEditor mode="clone" productId={params?.productId} />
}
