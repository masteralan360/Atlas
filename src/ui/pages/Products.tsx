import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { Copy, GitBranch, Info, LayoutGrid, List as ListIcon, Loader2, Package, Pencil, Plus, Search, Trash2 } from 'lucide-react'

import { useAuth } from '@/auth'
import { supabase } from '@/auth/supabase'
import {
    createCategory,
    deleteCategory,
    deleteProduct,
    updateCategory,
    useCategories,
    useProducts,
    useStorages,
    type Category,
    type Product
} from '@/local-db'
import { isMobile } from '@/lib/platform'
import {
    getRetriableActionToast,
    isRetriableWebRequestError,
    normalizeSupabaseActionError,
    runSupabaseAction
} from '@/lib/supabaseRequest'
import { cn, formatCurrency } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useWorkspace } from '@/workspace'
import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
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
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea,
    useToast
} from '@/ui/components'

const emptyCategoryFormData = { name: '', description: '' }

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

export function Products() {
    const { user, session } = useAuth()
    const { features, branchInfo } = useWorkspace()
    const { t } = useTranslation()
    const { toast } = useToast()
    const [, navigate] = useLocation()
    const products = useProducts(user?.workspaceId)
    const categories = useCategories(user?.workspaceId)
    const storages = useStorages(user?.workspaceId)
    const workspaceId = user?.workspaceId || ''
    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'
    const canCloneProducts = user?.role === 'admin'
    const isBranchWorkspace = Boolean(branchInfo?.isBranch)

    const [search, setSearch] = useState('')
    const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false)
    const [editingCategory, setEditingCategory] = useState<Category | null>(null)
    const [categoryFormData, setCategoryFormData] = useState(emptyCategoryFormData)
    const [isLoading, setIsLoading] = useState(false)
    const [pulseCategorySubmit, setPulseCategorySubmit] = useState(false)
    const [outsideClickCount, setOutsideClickCount] = useState(0)
    const [showUnsavedChangesModal, setShowUnsavedChangesModal] = useState(false)
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('products_view_mode') as 'table' | 'grid') || 'table'
    })
    const [deleteModalOpen, setDeleteModalOpen] = useState(false)
    const [itemToDelete, setItemToDelete] = useState<{ id: string; name: string; type: 'product' | 'category' } | null>(null)
    const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set())
    const [isBranchCloneSelectionMode, setIsBranchCloneSelectionMode] = useState(false)
    const [branchCloneDialogOpen, setBranchCloneDialogOpen] = useState(false)
    const [cloneTargets, setCloneTargets] = useState<ProductCloneTarget[]>([])
    const [selectedCloneTargetWorkspaceId, setSelectedCloneTargetWorkspaceId] = useState('')
    const [selectedCloneTargetStorageId, setSelectedCloneTargetStorageId] = useState('')
    const [isBranchCloning, setIsBranchCloning] = useState(false)
    const canCloneToBranch = canCloneProducts && cloneTargets.length > 0

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
            setSelectedProductIds(new Set())
            setIsBranchCloneSelectionMode(false)
            setBranchCloneDialogOpen(false)
        }
    }, [canCloneToBranch])

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
                const accessToken = await getAccessToken()
                if (!accessToken) {
                    throw new Error('Authentication required')
                }

                const { data, error } = await runSupabaseAction(
                    'products.cloneTargets',
                    () => supabase.functions.invoke('workspace-access', {
                        headers: {
                            Authorization: `Bearer ${accessToken}`
                        },
                        body: {
                            action: 'list-product-clone-targets'
                        }
                    }),
                    { timeoutMs: 20000, platform: 'all' }
                ) as {
                    data: { targets?: ProductCloneTarget[] } | null
                    error?: unknown
                }

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

    const isCategoryDirty = () => {
        if (!isCategoryDialogOpen) return false

        const sourceData = editingCategory
            ? { name: editingCategory.name, description: editingCategory.description || '' }
            : emptyCategoryFormData

        return JSON.stringify(categoryFormData) !== JSON.stringify(sourceData)
    }

    const resetCategoryDialog = () => {
        setEditingCategory(null)
        setCategoryFormData(emptyCategoryFormData)
        setOutsideClickCount(0)
        setIsCategoryDialogOpen(false)
    }

    const handleCategoryOutsideClick = (event: Event) => {
        if (!isCategoryDirty()) return

        event.preventDefault()
        const nextCount = outsideClickCount + 1

        if (nextCount >= 3) {
            setShowUnsavedChangesModal(true)
            setOutsideClickCount(0)
            return
        }

        setOutsideClickCount(nextCount)
        setPulseCategorySubmit(true)
        setTimeout(() => setPulseCategorySubmit(false), 1000)
    }

    const handleCategoryDialogChange = (open: boolean) => {
        if (!open && isCategoryDirty()) {
            setShowUnsavedChangesModal(true)
            return
        }

        if (!open) {
            resetCategoryDialog()
            return
        }

        setIsCategoryDialogOpen(true)
    }

    const handleDiscardChanges = () => {
        setShowUnsavedChangesModal(false)
        resetCategoryDialog()
    }

    const handleSaveDirtyChanges = () => {
        setShowUnsavedChangesModal(false)
        void handleCategorySubmit({ preventDefault: () => { } } as React.FormEvent)
    }

    const getDisplayImageUrl = (url?: string) => {
        if (!url) return ''
        if (url.startsWith('http')) return url
        return platformService.convertFileSrc(url)
    }

    const getCategoryName = (id?: string | null) => {
        if (!id) return t('categories.noCategory')
        const category = categories.find((item) => item.id === id)
        return category?.name || t('categories.noCategory')
    }

    const getStorageName = (id?: string | null) => {
        if (!id) return ''
        const storage = storages.find((item) => item.id === id)
        return storage ? storage.name : ''
    }

    const filteredProducts = products.filter((product) =>
        product.name.toLowerCase().includes(search.toLowerCase()) ||
        product.sku.toLowerCase().includes(search.toLowerCase()) ||
        getCategoryName(product.categoryId).toLowerCase().includes(search.toLowerCase()) ||
        getStorageName(product.storageId).toLowerCase().includes(search.toLowerCase())
    )
    const selectedProductsCount = selectedProductIds.size
    const allWorkspaceProductsSelected = products.length > 0 && selectedProductsCount === products.length
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
        navigate(product ? `/products/${product.id}` : '/products/new')
    }

    const handleCloneProduct = (product: Product) => {
        navigate(`/products/${product.id}/clone`)
    }

    const handleOpenCategoryDialog = (category?: Category) => {
        setOutsideClickCount(0)

        if (category) {
            setEditingCategory(category)
            setCategoryFormData({ name: category.name, description: category.description || '' })
        } else {
            setEditingCategory(null)
            setCategoryFormData(emptyCategoryFormData)
        }

        setIsCategoryDialogOpen(true)
    }

    const handleCategorySubmit = async (event: React.FormEvent) => {
        event.preventDefault()
        setIsLoading(true)

        try {
            if (editingCategory) {
                await updateCategory(editingCategory.id, categoryFormData)
            } else {
                await createCategory(workspaceId, categoryFormData)
            }

            resetCategoryDialog()
        } catch (error) {
            console.error('Error saving category:', error)
        } finally {
            setIsLoading(false)
        }
    }

    const handleDeleteCategory = (category: Category) => {
        setItemToDelete({ id: category.id, name: category.name, type: 'category' })
        setDeleteModalOpen(true)
    }

    const handleDeleteProduct = (product: Product) => {
        setItemToDelete({ id: product.id, name: product.name, type: 'product' })
        setDeleteModalOpen(true)
    }

    const toggleProductSelection = (productId: string) => {
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

    const toggleSelectAllProducts = () => {
        if (allWorkspaceProductsSelected) {
            setSelectedProductIds(new Set())
            return
        }

        setSelectedProductIds(new Set(products.map((product) => product.id)))
    }

    const exitBranchCloneSelectionMode = () => {
        setIsBranchCloneSelectionMode(false)
        setSelectedProductIds(new Set())
        setBranchCloneDialogOpen(false)
    }

    const getAccessToken = async () => {
        const { data } = await supabase.auth.getSession()
        return data.session?.access_token ?? session?.access_token ?? ''
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
            const accessToken = await getAccessToken()
            if (!accessToken) {
                throw new Error('Authentication required')
            }

            const { data, error } = await runSupabaseAction(
                'products.cloneToBranch',
                () => supabase.functions.invoke('workspace-access', {
                    headers: {
                        Authorization: `Bearer ${accessToken}`
                    },
                    body: {
                        action: 'clone-products-to-branch',
                        targetWorkspaceId: selectedCloneTargetWorkspaceId,
                        targetStorageId: selectedCloneTargetStorageId,
                        productIds: Array.from(selectedProductIds)
                    }
                }),
                { timeoutMs: 40000, platform: 'all' }
            ) as {
                data: { cloned_products_count?: number } | null
                error?: unknown
            }

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

    const confirmDelete = async () => {
        if (!itemToDelete) return

        setIsLoading(true)

        try {
            if (itemToDelete.type === 'product') {
                await deleteProduct(itemToDelete.id)
            } else {
                await deleteCategory(itemToDelete.id)
            }

            setDeleteModalOpen(false)
            setItemToDelete(null)
        } catch (error) {
            console.error('Error deleting:', error)
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <Package className="h-6 w-6 text-primary" />
                        {t('products.title')}
                    </h1>
                    <p className="text-muted-foreground">{t('products.subtitle') || 'Manage your inventory'}</p>
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
                        <div className="flex gap-2">
                            {canCloneToBranch && !isBranchCloneSelectionMode && (
                                <Button
                                    variant="outline"
                                    onClick={() => setIsBranchCloneSelectionMode(true)}
                                    disabled={products.length === 0}
                                >
                                    <GitBranch className="h-4 w-4" />
                                    {branchCloneActionLabel}
                                </Button>
                            )}
                            <Button variant="outline" onClick={() => handleOpenCategoryDialog()}>
                                <Plus className="h-4 w-4" />
                                {t('products.addCategory')}
                            </Button>
                            <Button onClick={() => openProductForm()}>
                                <Plus className="h-4 w-4" />
                                {t('products.addProduct')}
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            <div className="relative max-w-md">
                <Search className="absolute left-3 top-1/3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    placeholder={t('products.searchPlaceholder') || 'Search products...'}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    allowViewer={true}
                    className="pl-10"
                />
            </div>

            {canCloneToBranch && products.length > 0 && isBranchCloneSelectionMode && (
                <Card className="border-primary/15 bg-primary/5">
                    <CardContent className="flex flex-col gap-4 p-4 md:flex-row md:items-center md:justify-between">
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id="select-all-workspace-products"
                                    checked={allWorkspaceProductsSelected}
                                    onCheckedChange={toggleSelectAllProducts}
                                />
                                <Label htmlFor="select-all-workspace-products" className="cursor-pointer font-medium">
                                    {t('products.branchClone.selectAllWorkspace', { defaultValue: 'Select all workspace products' })} ({products.length})
                                </Label>
                            </div>
                            <p className="text-sm text-muted-foreground">
                                {t('products.branchClone.selectedCount', {
                                    defaultValue: '{{count}} products selected',
                                    count: selectedProductsCount
                                })}
                            </p>
                            <p className="text-sm text-muted-foreground">
                                {t('products.branchClone.selectionHint', {
                                    defaultValue: 'Select the products you want to copy, then choose the destination workspace and storage.'
                                })}
                            </p>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={exitBranchCloneSelectionMode}
                            >
                                {t('products.branchClone.cancelSelection', { defaultValue: 'Cancel' })}
                            </Button>
                            <Button
                                type="button"
                                className="gap-2"
                                onClick={() => setBranchCloneDialogOpen(true)}
                                disabled={selectedProductsCount === 0}
                            >
                                <GitBranch className="h-4 w-4" />
                                {t('products.branchClone.chooseDestination', { defaultValue: 'Choose Destination' })}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>{t('products.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {filteredProducts.length === 0 ? (
                        <div className="py-8 text-center text-muted-foreground">{t('common.noData')}</div>
                    ) : (
                        <>
                            {isMobile() && (
                                <div className="grid grid-cols-1 gap-4">
                                    {filteredProducts.map((product) => (
                                        <div
                                            key={product.id}
                                            className={cn(
                                                'space-y-4 rounded-[2rem] border border-border bg-card p-4 shadow-sm',
                                                canCloneToBranch && isBranchCloneSelectionMode && selectedProductIds.has(product.id) && 'border-primary/50 bg-primary/5'
                                            )}
                                        >
                                            {canCloneToBranch && isBranchCloneSelectionMode && (
                                                <div className="flex items-center gap-2">
                                                    <Checkbox
                                                        id={`product-select-mobile-${product.id}`}
                                                        checked={selectedProductIds.has(product.id)}
                                                        onCheckedChange={() => toggleProductSelection(product.id)}
                                                    />
                                                    <Label htmlFor={`product-select-mobile-${product.id}`} className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                                        {t('products.branchClone.selectProduct', { defaultValue: 'Select Product' })}
                                                    </Label>
                                                </div>
                                            )}
                                            <div className="flex gap-4">
                                                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[1.25rem] border border-border/50 bg-muted/30">
                                                    {product.imageUrl ? (
                                                        <img src={getDisplayImageUrl(product.imageUrl)} alt="" className="h-full w-full object-cover" />
                                                    ) : (
                                                        <Package className="h-8 w-8 text-muted-foreground/20" />
                                                    )}
                                                </div>
                                                <div className="flex min-w-0 flex-1 flex-col justify-center">
                                                    <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground">{product.sku}</div>
                                                    <div className="truncate text-base font-black leading-tight text-foreground">{product.name}</div>
                                                    <div className="mt-0.5 text-[11px] font-bold uppercase tracking-wide text-primary/80">
                                                        {getCategoryName(product.categoryId)}
                                                    </div>
                                                    <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                                                        {getStorageName(product.storageId)}
                                                    </div>
                                                </div>
                                                <div className="flex flex-col justify-center text-right">
                                                    <div className="text-lg font-black leading-tight text-primary">
                                                        {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                    </div>
                                                    <div className={cn(
                                                        'mt-0.5 text-[11px] font-black uppercase tracking-widest',
                                                        product.quantity <= product.minStockLevel ? 'text-amber-500' : 'text-muted-foreground/60'
                                                    )}>
                                                        {product.quantity} {t(`products.units.${product.unit}`, product.unit)}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex justify-end gap-2 border-t border-border/50 pt-3">
                                                <Button
                                                    variant="secondary"
                                                    size="sm"
                                                    allowViewer={!canEdit}
                                                    className="h-10 gap-2 rounded-xl px-6 font-bold"
                                                    onClick={() => openProductForm(product)}
                                                >
                                                    {canEdit ? <Pencil className="h-4 w-4" /> : <Info className="h-4 w-4" />}
                                                    {canEdit ? t('common.edit') : (t('common.view') || 'View')}
                                                </Button>
                                                {canEdit && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={t('common.clone') || 'Clone'}
                                                        className="h-10 w-10 rounded-xl text-primary hover:bg-primary/5"
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
                                                        className="h-10 w-10 rounded-xl text-destructive hover:bg-destructive/5"
                                                        onClick={() => handleDeleteProduct(product)}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {!isMobile() && (
                                <>
                                    {viewMode === 'grid' ? (
                                        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                                            {filteredProducts.map((product) => (
                                                <div
                                                    key={product.id}
                                                    className={cn(
                                                        'group relative flex flex-col gap-4 overflow-hidden rounded-[1.5rem] border border-border/50 bg-card p-4 transition-all duration-300 hover:-translate-y-1 hover:bg-accent/5 hover:shadow-2xl hover:shadow-primary/5',
                                                        canCloneToBranch && isBranchCloneSelectionMode && selectedProductIds.has(product.id) && 'border-primary/50 bg-primary/5 shadow-lg shadow-primary/10'
                                                    )}
                                                >
                                                    {canCloneToBranch && isBranchCloneSelectionMode && (
                                                        <div className="flex items-center gap-2">
                                                            <Checkbox
                                                                id={`product-select-grid-${product.id}`}
                                                                checked={selectedProductIds.has(product.id)}
                                                                onCheckedChange={() => toggleProductSelection(product.id)}
                                                            />
                                                            <Label htmlFor={`product-select-grid-${product.id}`} className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                                                {t('products.branchClone.selectProduct', { defaultValue: 'Select Product' })}
                                                            </Label>
                                                        </div>
                                                    )}
                                                    <div className="relative aspect-square overflow-hidden rounded-2xl border border-border/20 bg-muted/30">
                                                        {product.imageUrl ? (
                                                            <img src={getDisplayImageUrl(product.imageUrl)} alt={product.name} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110" />
                                                        ) : (
                                                            <div className="flex h-full items-center justify-center">
                                                                <Package className="h-12 w-12 text-muted-foreground/10" />
                                                            </div>
                                                        )}
                                                        <div className={cn(
                                                            'absolute right-2 top-2 rounded-lg px-2 py-1 text-[10px] font-black uppercase tracking-tighter shadow-sm',
                                                            product.quantity <= product.minStockLevel ? 'bg-amber-500 text-white' : 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600'
                                                        )}>
                                                            {product.quantity <= product.minStockLevel ? (t('products.lowStock') || 'Low Stock') : (t('products.inStock') || 'In Stock')}
                                                        </div>
                                                    </div>

                                                    <div className="flex-1 space-y-1">
                                                        <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground/60">{product.sku}</div>
                                                        <h3 className="line-clamp-2 text-sm font-bold leading-snug text-foreground transition-colors group-hover:text-primary">{product.name}</h3>
                                                        <div className="text-[11px] font-bold uppercase tracking-wide text-primary/70">{getCategoryName(product.categoryId)}</div>
                                                        <div className="text-[10px] font-medium text-muted-foreground/80">{getStorageName(product.storageId)}</div>
                                                    </div>

                                                    <div className="flex items-center justify-between border-t border-border/40 pt-3">
                                                        <div>
                                                            <div className="text-lg font-black text-primary">
                                                                {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                            </div>
                                                            <div className="text-[11px] font-medium text-muted-foreground">
                                                                {product.quantity} {t(`products.units.${product.unit}`, product.unit)}
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
                                                            {canEdit && (
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
                                            ))}
                                        </div>
                                    ) : (
                                        <Table>
                                            <TableHeader>
                                                <TableRow>
                                                    {canCloneToBranch && isBranchCloneSelectionMode && <TableHead className="w-[52px]" />}
                                                    <TableHead className="w-[80px]">{t('products.table.image') || 'Image'}</TableHead>
                                                    <TableHead>{t('products.table.sku')}</TableHead>
                                                    <TableHead>{t('products.table.name')}</TableHead>
                                                    <TableHead>{t('products.table.category')}</TableHead>
                                                    <TableHead>{t('storages.title') || 'Storage'}</TableHead>
                                                    <TableHead className="text-right">{t('products.table.price')}</TableHead>
                                                    <TableHead className="text-right">{t('products.table.stock')}</TableHead>
                                                    {(canEdit || canDelete || user?.role === 'viewer') && <TableHead className="text-right">{t('common.actions')}</TableHead>}
                                                </TableRow>
                                            </TableHeader>
                                            <TableBody>
                                                {filteredProducts.map((product) => (
                                                    <TableRow key={product.id} className={cn(canCloneToBranch && isBranchCloneSelectionMode && selectedProductIds.has(product.id) && 'bg-primary/5')}>
                                                        {canCloneToBranch && isBranchCloneSelectionMode && (
                                                            <TableCell>
                                                                <Checkbox
                                                                    id={`product-select-table-${product.id}`}
                                                                    checked={selectedProductIds.has(product.id)}
                                                                    onCheckedChange={() => toggleProductSelection(product.id)}
                                                                />
                                                            </TableCell>
                                                        )}
                                                        <TableCell>
                                                            <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg bg-muted">
                                                                {product.imageUrl ? (
                                                                    <img src={getDisplayImageUrl(product.imageUrl)} alt={product.name} className="h-full w-full object-cover" />
                                                                ) : (
                                                                    <Package className="h-5 w-5 text-muted-foreground/30" />
                                                                )}
                                                            </div>
                                                        </TableCell>
                                                        <TableCell className="font-mono text-sm">{product.sku}</TableCell>
                                                        <TableCell className="font-medium">{product.name}</TableCell>
                                                        <TableCell>{getCategoryName(product.categoryId)}</TableCell>
                                                        <TableCell>{getStorageName(product.storageId)}</TableCell>
                                                        <TableCell className="text-right">
                                                            {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <span className={product.quantity <= product.minStockLevel ? 'font-medium text-amber-500' : ''}>
                                                                {product.quantity} {t(`products.units.${product.unit}`, product.unit)}
                                                            </span>
                                                        </TableCell>
                                                        {(canEdit || canDelete || user?.role === 'viewer') && (
                                                            <TableCell className="text-right">
                                                                <div className="flex justify-end gap-2">
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        allowViewer={!canEdit}
                                                                        aria-label={canEdit ? (t('common.edit') || 'Edit') : (t('common.view') || 'View')}
                                                                        onClick={() => openProductForm(product)}
                                                                    >
                                                                        {canEdit ? <Pencil className="h-4 w-4" /> : <Info className="h-4 w-4 text-primary" />}
                                                                    </Button>
                                                                    {canEdit && (
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

            <Dialog open={isCategoryDialogOpen} onOpenChange={handleCategoryDialogChange}>
                <DialogContent className="max-w-md" onPointerDownOutside={handleCategoryOutsideClick}>
                    <DialogHeader>
                        <DialogTitle>{editingCategory ? t('categories.editCategory') : t('categories.addCategory')}</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleCategorySubmit} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="cat-name">{t('categories.form.name')}</Label>
                            <Input
                                id="cat-name"
                                value={categoryFormData.name}
                                onChange={(event) => setCategoryFormData((current) => ({ ...current, name: event.target.value }))}
                                placeholder={t('categories.form.name')}
                                required
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="cat-description">{t('categories.form.description')}</Label>
                            <Textarea
                                id="cat-description"
                                value={categoryFormData.description}
                                onChange={(event) => setCategoryFormData((current) => ({ ...current, description: event.target.value }))}
                                placeholder={t('categories.form.description')}
                                rows={3}
                            />
                        </div>

                        {!editingCategory && categories.length > 0 && (
                            <div className="border-t pt-4">
                                <Label className="mb-2 block text-sm font-medium">Existing Categories</Label>
                                <div className="max-h-40 space-y-2 overflow-y-auto pr-2">
                                    {categories.map((category) => (
                                        <div key={category.id} className="group flex items-center justify-between rounded-md bg-muted/50 p-2">
                                            <span className="text-sm">{category.name}</span>
                                            <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                                                <Button type="button" size="icon" variant="ghost" aria-label={t('common.edit') || 'Edit'} className="h-7 w-7" onClick={() => handleOpenCategoryDialog(category)}>
                                                    <Pencil className="h-3 w-3" />
                                                </Button>
                                                <Button type="button" size="icon" variant="ghost" aria-label={t('common.delete') || 'Delete'} className="h-7 w-7 text-destructive" onClick={() => handleDeleteCategory(category)}>
                                                    <Trash2 className="h-3 w-3" />
                                                </Button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <DialogFooter>
                            {editingCategory && (
                                <Button type="button" variant="ghost" onClick={() => handleOpenCategoryDialog()}>
                                    Cancel Edit
                                </Button>
                            )}
                            <Button type="submit" disabled={isLoading} className={cn(pulseCategorySubmit && 'animate-save-pulse')}>
                                {isLoading ? (t('common.loading') || 'Loading...') : editingCategory ? t('common.save') : t('common.create')}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            <Dialog open={showUnsavedChangesModal} onOpenChange={setShowUnsavedChangesModal}>
                <DialogContent className="max-w-lg overflow-hidden border-primary/20 p-0 shadow-2xl">
                    <div className="border-b bg-muted/30 p-6">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-xl text-primary">
                                <Info className="h-6 w-6" />
                                {t('common.unsavedChanges.title') || 'Unsaved Changes'}
                            </DialogTitle>
                        </DialogHeader>
                    </div>
                    <div className="p-8">
                        <p className="text-lg font-medium leading-relaxed text-foreground/90">
                            {t('common.unsavedChanges.message') || 'You have unsaved changes. Would you like to save them now or discard everything?'}
                        </p>
                    </div>
                    <DialogFooter className="flex w-full flex-col gap-3 border-t bg-muted/20 p-6 sm:flex-row">
                        <Button variant="ghost" onClick={() => setShowUnsavedChangesModal(false)} className="order-last h-11 w-full text-muted-foreground sm:order-first sm:w-auto">
                            {t('common.unsavedChanges.continue') || 'Continue Editing'}
                        </Button>
                        <div className="flex flex-1 flex-col gap-3 sm:flex-row">
                            <Button variant="destructive" onClick={handleDiscardChanges} className="h-11 flex-1 text-base font-bold">
                                {t('common.unsavedChanges.discard') || 'Discard Changes'}
                            </Button>
                            <Button variant="default" onClick={handleSaveDirtyChanges} className="h-11 flex-1 text-base font-bold">
                                {t('common.unsavedChanges.save') || 'Save Changes'}
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

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
                title={itemToDelete?.type === 'category' ? t('categories.confirmDelete') : t('products.confirmDelete')}
                description={itemToDelete?.type === 'category' ? t('categories.deleteWarning') : t('products.deleteWarning')}
            />
        </div>
    )
}
