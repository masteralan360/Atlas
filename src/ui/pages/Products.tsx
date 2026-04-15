import { useState, useRef, useEffect } from 'react'
import { useProducts, createProduct, updateProduct, deleteProduct, useCategories, createCategory, updateCategory, deleteCategory, getPrimaryStorageFromList, useStorages, type Product, type Category } from '@/local-db'
import type { CurrencyCode } from '@/local-db/models'
import { formatCurrency, cn } from '@/lib/utils'
import { assetManager } from '@/lib/assetManager'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Button,
    Input,
    Label,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
    Textarea,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    CurrencySelector,
    Switch,
    DeleteConfirmationModal
} from '@/ui/components'
import { Plus, Pencil, Trash2, Package, Search, ImagePlus, Info, Settings, LayoutGrid, List as ListIcon, Camera, Barcode, Type, Tag, Ruler, Boxes, DollarSign, Wallet, Warehouse, FileText, ChevronRight, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { isTauri, isMobile } from '@/lib/platform'
import { platformService } from '@/services/platformService'

const UNITS = ['pcs', 'kg', 'gram', 'liter', 'box', 'pack']

const getCurrencySymbol = (currency: string, iqdPreference: string) => {
    switch (currency.toLowerCase()) {
        case 'usd': return '$'
        case 'eur': return '€'
        case 'try': return '₺'
        case 'iqd': return iqdPreference
        default: return currency.toUpperCase()
    }
}

type ProductFormData = {
    sku: string
    name: string
    description: string
    categoryId: string | undefined
    price: number | ''
    costPrice: number | ''
    quantity: number | ''
    minStockLevel: number | ''
    unit: string
    currency: CurrencyCode
    imageUrl: string
    canBeReturned: boolean
    returnRules: string
    storageId: string
}

const initialFormData: ProductFormData = {
    sku: '',
    name: '',
    description: '',
    categoryId: undefined,
    price: '',
    costPrice: '',
    quantity: '',
    minStockLevel: 10,
    unit: 'pcs',
    currency: 'usd',
    imageUrl: '',
    canBeReturned: true,
    returnRules: '',
    storageId: ''
}

export function Products() {
    const { user } = useAuth()
    const products = useProducts(user?.workspaceId)
    const categories = useCategories(user?.workspaceId)
    const { features } = useWorkspace()
    const { t } = useTranslation()
    const storages = useStorages(user?.workspaceId)
    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'
    const workspaceId = user?.workspaceId || ''
    const [search, setSearch] = useState('')
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false)
    const [editingProduct, setEditingProduct] = useState<Product | null>(null)
    const [editingCategory, setEditingCategory] = useState<Category | null>(null)
    const [isCloning, setIsCloning] = useState(false)
    const [formData, setFormData] = useState<ProductFormData>(initialFormData)
    const [categoryFormData, setCategoryFormData] = useState({ name: '', description: '' })
    const [isLoading, setIsLoading] = useState(false)
    const [pulseProductSubmit, setPulseProductSubmit] = useState(false)
    const [pulseCategorySubmit, setPulseCategorySubmit] = useState(false)
    const [isElectron, setIsElectron] = useState(false)
    const [returnRulesModalOpen, setReturnRulesModalOpen] = useState(false)
    const cameraInputRef = useRef<HTMLInputElement>(null)
    const imageUploadInputRef = useRef<HTMLInputElement>(null)
    const [outsideClickCount, setOutsideClickCount] = useState(0)
    const [showUnsavedChangesModal, setShowUnsavedChangesModal] = useState(false)
    const [unsavedChangesType, setUnsavedChangesType] = useState<'product' | 'category' | null>(null)
    const [viewMode, setViewMode] = useState<'table' | 'grid'>(() => {
        return (localStorage.getItem('products_view_mode') as 'table' | 'grid') || 'table'
    })
    const [deleteModalOpen, setDeleteModalOpen] = useState(false)
    const [itemToDelete, setItemToDelete] = useState<{ id: string, name: string, type: 'product' | 'category' } | null>(null)
    const [imageError, setImageError] = useState(false)

    useEffect(() => {
        setIsElectron(isTauri());
    }, [])

    useEffect(() => {
        localStorage.setItem('products_view_mode', viewMode)
    }, [viewMode])

    const isProductDirty = () => {
        if (!isDialogOpen) return false

        let sourceData: ProductFormData;

        if (editingProduct && !isCloning) {
            sourceData = {
                sku: editingProduct.sku,
                name: editingProduct.name,
                description: editingProduct.description,
                categoryId: editingProduct.categoryId || undefined,
                price: editingProduct.price,
                costPrice: editingProduct.costPrice,
                quantity: editingProduct.quantity,
                minStockLevel: editingProduct.minStockLevel,
                unit: editingProduct.unit,
                currency: editingProduct.currency,
                imageUrl: editingProduct.imageUrl || '',
                canBeReturned: editingProduct.canBeReturned ?? true,
                returnRules: editingProduct.returnRules || '',
                storageId: editingProduct.storageId || ''
            };
        } else {
            const mainStorage = getPrimaryStorageFromList(storages);
            sourceData = {
                ...initialFormData,
                storageId: mainStorage?.id || '',
                currency: features.default_currency
            };
        }

        return JSON.stringify(formData) !== JSON.stringify(sourceData)
    }

    const isCategoryDirty = () => {
        if (!isCategoryDialogOpen) return false

        const sourceData = editingCategory ? {
            name: editingCategory.name,
            description: editingCategory.description || ''
        } : { name: '', description: '' }

        return JSON.stringify(categoryFormData) !== JSON.stringify(sourceData)
    }

    const handleProductOutsideClick = (e: Event) => {
        if (isProductDirty()) {
            e.preventDefault()
            const newCount = outsideClickCount + 1
            if (newCount >= 3) {
                setUnsavedChangesType('product')
                setShowUnsavedChangesModal(true)
                setOutsideClickCount(0)
            } else {
                setOutsideClickCount(newCount)
                setPulseProductSubmit(true)
                setTimeout(() => setPulseProductSubmit(false), 1000)
            }
        }
    }

    const handleCategoryOutsideClick = (e: Event) => {
        if (isCategoryDirty()) {
            e.preventDefault()
            const newCount = outsideClickCount + 1
            if (newCount >= 3) {
                setUnsavedChangesType('category')
                setShowUnsavedChangesModal(true)
                setOutsideClickCount(0)
            } else {
                setOutsideClickCount(newCount)
                setPulseCategorySubmit(true)
                setTimeout(() => setPulseCategorySubmit(false), 1000)
            }
        }
    }

    const handleDiscardChanges = () => {
        if (unsavedChangesType === 'product') {
            setIsDialogOpen(false)
            setEditingProduct(null)
            setIsCloning(false)
            setFormData(initialFormData)
        } else if (unsavedChangesType === 'category') {
            setIsCategoryDialogOpen(false)
            setEditingCategory(null)
            setCategoryFormData({ name: '', description: '' })
        }
        setShowUnsavedChangesModal(false)
        setUnsavedChangesType(null)
        setOutsideClickCount(0)
    }

    const handleSaveDirtyChanges = () => {
        setShowUnsavedChangesModal(false)
        if (unsavedChangesType === 'product') {
            handleSubmit({ preventDefault: () => { } } as React.FormEvent)
        } else if (unsavedChangesType === 'category') {
            handleCategorySubmit({ preventDefault: () => { } } as React.FormEvent)
        }
        setUnsavedChangesType(null)
        setOutsideClickCount(0)
    }

    const handleImageUpload = async () => {
        if (isElectron) {
            const targetPath = await platformService.pickAndSaveImage(workspaceId);
            if (targetPath) {
                setFormData(prev => ({ ...prev, imageUrl: targetPath }));
                setImageError(false);

                // Trigger asset sync for other workspace users
                assetManager.uploadFromPath(targetPath).then(success => {
                    if (success) {
                        console.log('[Products] Image synced via Cloudflare R2');
                    }
                }).catch(console.error);
            }
        } else {
            // On web, trigger the hidden file input
            imageUploadInputRef.current?.click();
        }
    }

    const handleFileSelected = async (file: File) => {
        if (isElectron) {
            const targetPath = await platformService.saveImageFile(file, workspaceId);
            if (targetPath) {
                setFormData(prev => ({ ...prev, imageUrl: targetPath }));
                setImageError(false);

                // Trigger asset sync
                assetManager.uploadFromPath(targetPath).then(success => {
                    if (success) {
                        console.log('[Products] Camera image synced via Cloudflare R2');
                    }
                }).catch(console.error);
            }
        } else {
            // Web/Mobile fallback
            const ext = file.name.split('.').pop() || 'jpg';
            const fileName = `${Date.now()}.${ext}`;
            const targetPath = `product-images/${workspaceId}/${fileName}`;
            const r2Path = `${workspaceId}/product-images/${fileName}`;

            import('@/services/r2Service').then(async ({ r2Service }) => {
                if (r2Service.isConfigured()) {
                    const success = await r2Service.upload(r2Path, file);
                    if (success) {
                        setFormData(prev => ({ ...prev, imageUrl: targetPath }));
                        setImageError(false);
                        console.log('[Products] Web image synced via Cloudflare R2');
                        return;
                    }
                }

                // Fallback to Base64 if R2 is not configured or upload fails
                const reader = new FileReader();
                reader.onloadend = () => {
                    setFormData(prev => ({ ...prev, imageUrl: reader.result as string }));
                    setImageError(false);
                };
                reader.readAsDataURL(file);
            });
        }
    }

    const handleCameraClick = () => {
        cameraInputRef.current?.click();
    };

    const handleCameraCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        await handleFileSelected(file);

        // Reset input value
        if (cameraInputRef.current) cameraInputRef.current.value = '';
    };

    const handleImageFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        await handleFileSelected(file);

        // Reset input value
        if (imageUploadInputRef.current) imageUploadInputRef.current.value = '';
    };

    const handleRemoveImage = async () => {
        if (!formData.imageUrl) return;

        try {
            // Delete from R2 and Local
            await assetManager.deleteAsset(formData.imageUrl);

            // Update Form Data
            setFormData(prev => ({ ...prev, imageUrl: '' }));
            setImageError(false);
            console.log('[Products] Image removed and cleaned up');
        } catch (e) {
            console.error('[Products] Error removing image:', e);
        }
    }

    const getDisplayImageUrl = (url?: string) => {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        // Local path - use platform-specific conversion
        return platformService.convertFileSrc(url);
    }

    const getCategoryName = (id?: string | null) => {
        if (!id) return t('categories.noCategory')
        const cat = categories.find(c => c.id === id)
        return cat?.name || t('categories.noCategory')
    }

    const filteredProducts = products.filter(
        (p) =>
            p.name.toLowerCase().includes(search.toLowerCase()) ||
            p.sku.toLowerCase().includes(search.toLowerCase()) ||
            getCategoryName(p.categoryId ? p.categoryId : undefined).toLowerCase().includes(search.toLowerCase()) ||
            getStorageName(p.storageId).toLowerCase().includes(search.toLowerCase())
    )

    const handleProductDialogChange = (open: boolean) => {
        if (!open) {
            if (isProductDirty()) {
                setShowUnsavedChangesModal(true)
                setUnsavedChangesType('product')
                return
            }
            setEditingProduct(null)
            setIsCloning(false)
            setFormData(initialFormData)
        }
        setIsDialogOpen(open)
    }

    const getStorageName = (id?: string | null) => {
        if (!id) return ''
        const s = storages.find(s => s.id === id)
        return s ? s.name : ''
    }

    const handleOpenDialog = (product?: Product) => {
        setOutsideClickCount(0)
        if (product) {
            setEditingProduct(product)
            setFormData({
                sku: product.sku,
                name: product.name,
                description: product.description,
                categoryId: product.categoryId || undefined,
                price: product.price,
                costPrice: product.costPrice,
                quantity: product.quantity,
                minStockLevel: product.minStockLevel,
                unit: product.unit,
                currency: product.currency,
                imageUrl: product.imageUrl || '',
                canBeReturned: product.canBeReturned ?? true,
                returnRules: product.returnRules || '',
                storageId: product.storageId || ''
            })
        } else {
            setEditingProduct(null)
            setFormData({
                ...initialFormData,
                storageId: getPrimaryStorageFromList(storages)?.id || '',
                currency: features.default_currency
            })
        }
        setImageError(false)
        setIsCloning(false)
        setIsDialogOpen(true)
    }

    const handleCloneProduct = (product: Product) => {
        setOutsideClickCount(0)
        setEditingProduct(null)
        setIsCloning(true)
        setFormData({
            sku: product.sku,
            name: product.name,
            description: product.description,
            categoryId: product.categoryId || undefined,
            price: product.price,
            costPrice: product.costPrice,
            quantity: product.quantity,
            minStockLevel: product.minStockLevel,
            unit: product.unit,
            currency: product.currency,
            imageUrl: product.imageUrl || '',
            canBeReturned: product.canBeReturned ?? true,
            returnRules: product.returnRules || '',
            storageId: product.storageId || ''
        })
        setImageError(false)
        setIsDialogOpen(true)
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setIsLoading(true)

        try {
            const categoryName = formData.categoryId
                ? categories.find(c => c.id === formData.categoryId)?.name
                : null
            const storageName = formData.storageId
                ? storages.find(s => s.id === formData.storageId)?.name
                : null

            const dataToSave = {
                ...formData,
                category: categoryName || undefined,
                storageName: storageName || undefined,
                categoryId: formData.categoryId || null,
                storageId: formData.storageId || null,
                price: Number(formData.price) || 0,
                costPrice: Number(formData.costPrice) || 0,
                quantity: Number(formData.quantity) || 0,
                minStockLevel: Number(formData.minStockLevel) || 0
            }

            if (editingProduct && !isCloning) {
                // Asset Cleanup: Check if the image has been removed or replaced
                if (editingProduct.imageUrl && editingProduct.imageUrl !== formData.imageUrl) {
                    console.log('[Products] Image changed/removed, cleaning up old asset:', editingProduct.imageUrl);
                    assetManager.deleteAsset(editingProduct.imageUrl).catch(e =>
                        console.error('[Products] Failed to delete old asset:', e)
                    );
                }
                await updateProduct(editingProduct.id, dataToSave)
            } else {
                await createProduct(workspaceId, dataToSave)
            }
            setIsDialogOpen(false)
            setIsCloning(false)
            setFormData(initialFormData)
        } catch (error) {
            console.error('Error saving product:', error)
        } finally {
            setIsLoading(false)
        }
    }

    const handleCategorySubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setIsLoading(true)
        try {
            if (editingCategory) {
                await updateCategory(editingCategory.id, categoryFormData)
            } else {
                await createCategory(workspaceId, categoryFormData)
            }
            setIsCategoryDialogOpen(false)
            setCategoryFormData({ name: '', description: '' })
        } catch (error) {
            console.error('Error saving category:', error)
        } finally {
            setIsLoading(false)
        }
    }

    const handleOpenCategoryDialog = (category?: Category) => {
        setOutsideClickCount(0)
        if (category) {
            setEditingCategory(category)
            setCategoryFormData({ name: category.name, description: category.description || '' })
        } else {
            setEditingCategory(null)
            setCategoryFormData({ name: '', description: '' })
        }
        setIsCategoryDialogOpen(true)
    }

    const handleDeleteCategory = (category: Category) => {
        setItemToDelete({ id: category.id, name: category.name, type: 'category' })
        setDeleteModalOpen(true)
    }

    const handleDelete = (product: Product) => {
        setItemToDelete({ id: product.id, name: product.name, type: 'product' })
        setDeleteModalOpen(true)
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
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Package className="w-6 h-6 text-primary" />
                        {t('products.title')}
                    </h1>
                    <p className="text-muted-foreground">{t('products.subtitle') || 'Manage your inventory'}</p>
                </div>
                <div className="flex items-center gap-2">
                    {!isMobile() && (
                        <div className="flex items-center bg-muted/50 p-1 rounded-xl border border-border/50 mr-2">
                            <Button
                                variant={viewMode === 'table' ? 'secondary' : 'ghost'}
                                size="sm"
                                allowViewer={true}
                                className={cn(
                                    "rounded-lg h-8 px-3 font-bold flex gap-2 transition-all",
                                    viewMode === 'table' && "shadow-sm bg-background"
                                )}
                                onClick={() => setViewMode('table')}
                            >
                                <ListIcon className="w-3.5 h-3.5" />
                                {t('products.view.table') || 'Table'}
                            </Button>
                            <Button
                                variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                                size="sm"
                                allowViewer={true}
                                className={cn(
                                    "rounded-lg h-8 px-3 font-bold flex gap-2 transition-all",
                                    viewMode === 'grid' && "shadow-sm bg-background"
                                )}
                                onClick={() => setViewMode('grid')}
                            >
                                <LayoutGrid className="w-3.5 h-3.5" />
                                {t('products.view.grid') || 'Grid'}
                            </Button>
                        </div>
                    )}
                    {canEdit && (
                        <div className="flex gap-2">
                            <Button variant="outline" onClick={() => setIsCategoryDialogOpen(true)}>
                                <Plus className="w-4 h-4" />
                                {t('products.addCategory')}
                            </Button>
                            <Button onClick={() => handleOpenDialog()}>
                                <Plus className="w-4 h-4" />
                                {t('products.addProduct')}
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            {/* Search */}
            <div className="relative max-w-md">
                <Search className="absolute left-3 top-1/3 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                    placeholder={t('products.searchPlaceholder') || "Search products..."}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    allowViewer={true}
                    className="pl-10"
                />
            </div>

            {/* Products Table */}
            <Card>
                <CardHeader>
                    <CardTitle>{t('products.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    {
                        filteredProducts.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground">
                                {products.length === 0 ? t('common.noData') : t('common.noData')}
                            </div>
                        ) : (
                            <>
                                {/* Mobile View */}
                                {isMobile() && (
                                    <div className="grid grid-cols-1 gap-4">
                                        {filteredProducts.map((product) => (
                                            <div
                                                key={product.id}
                                                className="p-4 rounded-[2rem] border border-border shadow-sm bg-card space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300"
                                            >
                                                <div className="flex gap-4">
                                                    <div className="w-16 h-16 rounded-[1.25rem] bg-muted/30 border border-border/50 overflow-hidden flex-shrink-0 flex items-center justify-center">
                                                        {product.imageUrl ? (
                                                            <img
                                                                src={getDisplayImageUrl(product.imageUrl)}
                                                                alt=""
                                                                className="w-full h-full object-cover"
                                                            />
                                                        ) : (
                                                            <Package className="w-8 h-8 opacity-20 text-muted-foreground" />
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                                                        <div className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-wider">
                                                            {product.sku}
                                                        </div>
                                                        <div className="font-black text-foreground truncate text-base leading-tight">
                                                            {product.name}
                                                        </div>
                                                        <div className="text-[11px] text-primary font-bold mt-0.5 opacity-80 uppercase tracking-wide">
                                                            {getCategoryName(product.categoryId)}
                                                        </div>
                                                        <div className="text-[10px] font-medium text-muted-foreground/60 flex items-center gap-1 mt-0.5 uppercase tracking-wider">
                                                            {getStorageName(product.storageId)}
                                                        </div>
                                                    </div>
                                                    <div className="text-right flex flex-col justify-center">
                                                        <div className="text-lg font-black text-primary leading-tight">
                                                            {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                        </div>
                                                        <div className={cn(
                                                            "text-[11px] font-black uppercase tracking-widest mt-0.5",
                                                            product.quantity <= product.minStockLevel ? "text-amber-500" : "text-muted-foreground/60"
                                                        )}>
                                                            {product.quantity} {t(`products.units.${product.unit}`, product.unit)}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex justify-end gap-2 pt-3 border-t border-border/50">
                                                    {canEdit ? (
                                                        <Button
                                                            variant="secondary"
                                                            size="sm"
                                                            className="rounded-xl h-10 px-6 font-bold flex gap-2"
                                                            onClick={() => handleOpenDialog(product)}
                                                        >
                                                            <Pencil className="w-4 h-4" />
                                                            {t('common.edit')}
                                                        </Button>
                                                    ) : (
                                                        <Button
                                                            variant="secondary"
                                                            size="sm"
                                                            allowViewer={true}
                                                            className="rounded-xl h-10 px-6 font-bold flex gap-2"
                                                            onClick={() => handleOpenDialog(product)}
                                                        >
                                                            <Info className="w-4 h-4" />
                                                            {t('common.view') || 'View'}
                                                        </Button>
                                                    )}
                                                    {canEdit && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="rounded-xl h-10 w-10 text-primary hover:bg-primary/5"
                                                            onClick={() => handleCloneProduct(product)}
                                                        >
                                                            <Copy className="w-4 h-4" />
                                                        </Button>
                                                    )}
                                                    {canDelete && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="rounded-xl h-10 w-10 text-destructive hover:bg-destructive/5"
                                                            onClick={() => handleDelete(product)}
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Desktop Views */}
                                {!isMobile() && (
                                    <>
                                        {viewMode === 'grid' ? (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                                {filteredProducts.map((product) => (
                                                    <div
                                                        key={product.id}
                                                        className="group relative bg-card hover:bg-accent/5 rounded-[1.5rem] border border-border/50 p-4 transition-all duration-300 hover:shadow-2xl hover:shadow-primary/5 hover:-translate-y-1 flex flex-col gap-4 overflow-hidden"
                                                    >
                                                        {/* Product Image Wrapper */}
                                                        <div className="relative aspect-square rounded-2xl bg-muted/30 border border-border/20 overflow-hidden flex items-center justify-center">
                                                            {product.imageUrl ? (
                                                                <img
                                                                    src={getDisplayImageUrl(product.imageUrl)}
                                                                    alt={product.name}
                                                                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                                                                />
                                                            ) : (
                                                                <Package className="w-12 h-12 opacity-10 text-muted-foreground" />
                                                            )}

                                                            {/* Status Badge */}
                                                            <div className={cn(
                                                                "absolute top-2 right-2 px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-tighter shadow-sm",
                                                                product.quantity <= product.minStockLevel ? "bg-amber-500 text-white" : "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20"
                                                            )}>
                                                                {product.quantity <= product.minStockLevel ? (t('products.lowStock') || 'Low Stock') : (t('products.inStock') || 'In Stock')}
                                                            </div>
                                                        </div>

                                                        {/* Product Info */}
                                                        <div className="flex-1 space-y-1">
                                                            <div className="text-[10px] font-mono font-bold text-muted-foreground uppercase tracking-widest opacity-60">
                                                                {product.sku}
                                                            </div>
                                                            <h3 className="font-bold text-foreground text-sm line-clamp-2 leading-snug group-hover:text-primary transition-colors">
                                                                {product.name}
                                                            </h3>
                                                            <div className="text-[11px] font-bold text-primary/70 uppercase tracking-wide">
                                                                {getCategoryName(product.categoryId ? product.categoryId : undefined)}
                                                            </div>
                                                            <div className="text-[10px] font-medium text-muted-foreground/80 flex items-center gap-1 mt-1">
                                                                {getStorageName(product.storageId)}
                                                            </div>
                                                        </div>

                                                        {/* Pricing and Actions */}
                                                        <div className="pt-3 border-t border-border/40 flex items-center justify-between">
                                                            <div>
                                                                <div className="text-lg font-black text-primary">
                                                                    {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                                </div>
                                                                <div className="text-[11px] text-muted-foreground font-medium">
                                                                    {product.quantity} {t(`products.units.${product.unit}`, product.unit)}
                                                                </div>
                                                            </div>

                                                            <div className="flex gap-1">
                                                                {canEdit ? (
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        className="w-8 h-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
                                                                        onClick={() => handleOpenDialog(product)}
                                                                    >
                                                                        <Pencil className="w-3.5 h-3.5" />
                                                                    </Button>
                                                                ) : (
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        allowViewer={true}
                                                                        className="w-8 h-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
                                                                        onClick={() => handleOpenDialog(product)}
                                                                    >
                                                                        <Info className="w-3.5 h-3.5" />
                                                                    </Button>
                                                                )}
                                                                {canEdit && (
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        className="w-8 h-8 rounded-lg hover:bg-primary/10 hover:text-primary transition-colors"
                                                                        onClick={() => handleCloneProduct(product)}
                                                                    >
                                                                        <Copy className="w-3.5 h-3.5" />
                                                                    </Button>
                                                                )}
                                                                {canDelete && (
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="icon"
                                                                        className="w-8 h-8 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-colors"
                                                                        onClick={() => handleDelete(product)}
                                                                    >
                                                                        <Trash2 className="w-3.5 h-3.5" />
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
                                                        <TableHead className="w-[80px]">{t('products.table.image') || 'Image'}</TableHead>
                                                        <TableHead>{t('products.table.sku')}</TableHead>
                                                        <TableHead>{t('products.table.name')}</TableHead>
                                                        <TableHead>{t('products.table.category')}</TableHead>
                                                        <TableHead>{t('storages.title') || 'Storage'}</TableHead>
                                                        <TableHead className="text-right">{t('products.table.price')}</TableHead>
                                                        <TableHead className="text-right">{t('products.table.stock')}</TableHead>
                                                        {(canEdit || canDelete) && <TableHead className="text-right">{t('common.actions')}</TableHead>}
                                                    </TableRow>
                                                </TableHeader>
                                                <TableBody>
                                                    {filteredProducts.map((product) => (
                                                        <TableRow key={product.id}>
                                                            <TableCell>
                                                                <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
                                                                    {product.imageUrl ? (
                                                                        <img
                                                                            src={getDisplayImageUrl(product.imageUrl)}
                                                                            alt={product.name}
                                                                            className="w-full h-full object-cover"
                                                                        />
                                                                    ) : (
                                                                        <Package className="w-5 h-5 text-muted-foreground/30" />
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
                                                                <span className={product.quantity <= product.minStockLevel ? 'text-amber-500 font-medium' : ''}>
                                                                    {product.quantity} {t(`products.units.${product.unit}`, product.unit)}
                                                                </span>
                                                            </TableCell>
                                                            {(canEdit || canDelete || user?.role === 'viewer') && (
                                                                <TableCell className="text-right">
                                                                    <div className="flex justify-end gap-2">
                                                                        {canEdit ? (
                                                                            <Button variant="ghost" size="icon" onClick={() => handleOpenDialog(product)}>
                                                                                <Pencil className="w-4 h-4" />
                                                                            </Button>
                                                                        ) : (
                                                                            <Button variant="ghost" size="icon" allowViewer={true} onClick={() => handleOpenDialog(product)}>
                                                                                <Info className="w-4 h-4 text-primary" />
                                                                            </Button>
                                                                        )}
                                                                        {canEdit && (
                                                                            <Button variant="ghost" size="icon" onClick={() => handleCloneProduct(product)}>
                                                                                <Copy className="w-4 h-4 text-primary" />
                                                                            </Button>
                                                                        )}
                                                                        {canDelete && (
                                                                            <Button variant="ghost" size="icon" onClick={() => handleDelete(product)}>
                                                                                <Trash2 className="w-4 h-4 text-destructive" />
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
                        )
                    }
                </CardContent >
            </Card>

            <Dialog open={isDialogOpen} onOpenChange={handleProductDialogChange}>
                <DialogContent
                    className="max-w-3xl w-[98vw] sm:w-full max-h-[88vh] overflow-hidden flex flex-col p-0 gap-0 border-primary/10 shadow-2xl rounded-xl mt-8 sm:mt-0 sm:top-[52%]"
                    onPointerDownOutside={handleProductOutsideClick}
                >
                    <DialogHeader className="pt-10 pb-4 px-4 sm:p-10 bg-muted/30 border-b relative">
                        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary/40 via-primary to-primary/40" />
                        <DialogTitle className="text-xl sm:text-2xl font-black flex items-center justify-center sm:justify-start gap-3 px-6 sm:px-0">
                            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg sm:rounded-xl bg-primary/10 flex items-center justify-center text-primary shadow-inner shrink-0">
                                {isCloning ? <Copy className="w-5 h-5" /> : editingProduct ? <Pencil className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span className="leading-tight truncate">
                                    {isCloning ? (t('common.clone') || 'Clone') : editingProduct ? (canEdit ? t('common.edit') : t('common.view') || 'View') : t('products.addProduct')}
                                </span>
                                <span className="text-xs font-bold text-muted-foreground/60 uppercase tracking-widest mt-0.5 hidden sm:block">
                                    {(editingProduct || isCloning) ? `${t('products.table.sku')}: ${formData.sku}` : t('products.subtitle')}
                                </span>
                            </div>
                        </DialogTitle>
                    </DialogHeader>

                    <div className="flex-1 overflow-y-auto p-6 sm:p-10 space-y-8 sm:space-y-10 custom-scrollbar">
                        <form id="product-form" onSubmit={handleSubmit} className="space-y-8 pb-4">
                            {/* Section: Basic Information */}
                            <div className="space-y-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="h-4 w-1 bg-primary rounded-full transition-all group-hover:h-6" />
                                    <h3 className="text-sm font-black uppercase tracking-widest text-primary/80">{t('products.form.basicInfo')}</h3>
                                </div>
                                <div className="grid gap-6 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label htmlFor="sku" className="flex items-center gap-2 font-bold">
                                            <Barcode className="w-4 h-4 text-primary/60" />
                                            {t('products.table.sku')}
                                        </Label>
                                        <Input
                                            id="sku"
                                            value={formData.sku}
                                            onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                                            placeholder="PRD-001"
                                            readOnly={!canEdit}
                                            className="h-12 rounded-lg border-border/40 focus:border-primary/40 focus:ring-primary/10 bg-muted/10 font-mono transition-all"
                                            required
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="name" className="flex items-center gap-2 font-bold">
                                            <Type className="w-4 h-4 text-primary/60" />
                                            {t('products.table.name')}
                                        </Label>
                                        <Input
                                            id="name"
                                            value={formData.name}
                                            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                            placeholder={t('products.form.name') || "Product name"}
                                            readOnly={!canEdit}
                                            className="h-12 rounded-lg border-border/40 focus:border-primary/40 focus:ring-primary/10 bg-muted/10 font-bold transition-all"
                                            required
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label htmlFor="description" className="flex items-center gap-2 font-bold">
                                        <FileText className="w-4 h-4 text-primary/60" />
                                        {t('products.form.description')}
                                    </Label>
                                    <Textarea
                                        id="description"
                                        value={formData.description}
                                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                        placeholder={t('products.form.description') || "Product description..."}
                                        rows={3}
                                        readOnly={!canEdit}
                                        className="rounded-lg border-border/40 focus:border-primary/40 focus:ring-primary/10 bg-muted/10 min-h-[100px] transition-all"
                                    />
                                </div>
                            </div>

                            {/* Section: Categorization & Storage */}
                            <div className="space-y-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="h-4 w-1 bg-primary rounded-full transition-all group-hover:h-6" />
                                    <h3 className="text-sm font-black uppercase tracking-widest text-primary/80">{t('products.form.categorization')}</h3>
                                </div>
                                <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                                    <div className="space-y-2">
                                        <Label htmlFor="category" className="flex items-center gap-2 font-bold">
                                            <Tag className="w-4 h-4 text-primary/60" />
                                            {t('products.table.category')}
                                        </Label>
                                        <Select value={formData.categoryId || 'none'} onValueChange={(value) => setFormData({ ...formData, categoryId: value === 'none' ? undefined : value })} disabled={!canEdit}>
                                            <SelectTrigger className="h-12 rounded-lg border-border/40 bg-muted/10 focus:ring-primary/10" allowViewer={true}>
                                                <SelectValue placeholder={t('categories.noCategory')} />
                                            </SelectTrigger>
                                            <SelectContent className="rounded-xl shadow-xl">
                                                <SelectItem value="none" className="rounded-xl">{t('categories.noCategory')}</SelectItem>
                                                {categories.map((cat) => (
                                                    <SelectItem key={cat.id} value={cat.id} className="rounded-xl">{cat.name}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="unit" className="flex items-center gap-2 font-bold">
                                            <Ruler className="w-4 h-4 text-primary/60" />
                                            {t('products.form.unit')}
                                        </Label>
                                        <Select value={formData.unit} onValueChange={(value) => setFormData({ ...formData, unit: value })} disabled={!canEdit}>
                                            <SelectTrigger className="h-12 rounded-lg border-border/40 bg-muted/10 focus:ring-primary/10" allowViewer={true}>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent className="rounded-xl shadow-xl">
                                                {UNITS.map((unit) => (
                                                    <SelectItem key={unit} value={unit} className="rounded-xl">
                                                        {t(`products.units.${unit}`, unit)}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-2 md:col-span-2 lg:col-span-1">
                                        <Label htmlFor="storage" className="flex items-center gap-2 font-bold">
                                            <Warehouse className="w-4 h-4 text-primary/60" />
                                            {t('storages.title') || 'Storage'}
                                        </Label>
                                        <Select
                                            value={formData.storageId}
                                            onValueChange={(value) => setFormData({ ...formData, storageId: value })}
                                            disabled={(!canEdit) || (!!editingProduct && !isDialogOpen)}
                                        >
                                            <SelectTrigger className="h-12 rounded-lg border-border/40 bg-muted/10 focus:ring-primary/10" allowViewer={true}>
                                                <SelectValue placeholder={t('storages.selectStorage') || 'Select Storage'} />
                                            </SelectTrigger>
                                            <SelectContent className="rounded-xl shadow-xl">
                                                {storages.map((storage) => (
                                                    <SelectItem key={storage.id} value={storage.id} className="rounded-xl">
                                                        <div className="flex items-center gap-2">
                                                            {storage.isSystem ? <div className="w-1.5 h-1.5 rounded-full bg-primary" /> : <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />}
                                                            {storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name}
                                                        </div>
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                            </div>

                            {/* Section: Pricing */}
                            <div className="space-y-4 p-5 rounded-xl bg-gradient-to-br from-primary/5 via-transparent to-transparent border border-primary/10 shadow-sm relative overflow-hidden group">
                                <div className="absolute top-0 right-0 p-4 opacity-[0.08] group-hover:opacity-[0.18] transition-opacity">
                                    <Wallet className="w-20 h-20 text-primary/60" />
                                </div>
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="h-4 w-1 bg-primary rounded-full transition-all group-hover:h-6" />
                                    <h3 className="text-sm font-black uppercase tracking-widest text-primary/80">{t('products.form.pricing')}</h3>
                                </div>
                                <div className="grid gap-6 md:grid-cols-3">
                                    <div className="space-y-2">
                                        <Label htmlFor="price" className="flex items-center gap-2 font-bold">
                                            <DollarSign className="w-4 h-4 text-primary/60" />
                                            {t('products.table.price')}
                                        </Label>
                                        <div className="relative">
                                            <Input
                                                id="price"
                                                type="number"
                                                min="0"
                                                step="0.01"
                                                value={formData.price}
                                                onChange={(e) => setFormData({ ...formData, price: e.target.value === '' ? '' : parseFloat(e.target.value) })}
                                                placeholder="0.00"
                                                readOnly={!canEdit}
                                                className="h-12 rounded-lg border-border/40 focus:border-primary/40 focus:ring-primary/10 bg-background/50 text-lg font-black text-primary transition-all pr-16"
                                                required
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground/60 uppercase tracking-wider pointer-events-none">
                                                {getCurrencySymbol(formData.currency, features.iqd_display_preference)}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <CurrencySelector
                                            label={t('products.form.currency') || "Currency"}
                                            value={formData.currency}
                                            onChange={(val) => setFormData({ ...formData, currency: val })}
                                            iqdDisplayPreference={features.iqd_display_preference}
                                            disabled={!canEdit}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="costPrice" className="flex items-center gap-2 font-bold">
                                            <Wallet className="w-4 h-4 text-primary/60" />
                                            {t('products.form.cost')}
                                        </Label>
                                        <div className="relative">
                                            <Input
                                                id="costPrice"
                                                type="number"
                                                min="0"
                                                step="0.01"
                                                value={formData.costPrice}
                                                onChange={(e) => setFormData({ ...formData, costPrice: e.target.value === '' ? '' : parseFloat(e.target.value) })}
                                                placeholder="0.00"
                                                readOnly={!canEdit}
                                                className="h-12 rounded-lg border-border/40 focus:border-primary/40 focus:ring-primary/10 bg-background/50 font-bold transition-all pr-16"
                                                required
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground/60 uppercase tracking-wider pointer-events-none">
                                                {getCurrencySymbol(formData.currency, features.iqd_display_preference)}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Section: Inventory */}
                            <div className="space-y-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="h-4 w-1 bg-primary rounded-full transition-all group-hover:h-6" />
                                    <h3 className="text-sm font-black uppercase tracking-widest text-primary/80">{t('products.form.inventory')}</h3>
                                </div>
                                <div className="grid gap-6 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label htmlFor="quantity" className="flex items-center gap-2 font-bold">
                                            <Boxes className="w-4 h-4 text-primary/60" />
                                            {t('products.form.stock')}
                                        </Label>
                                        <div className="relative">
                                            <Input
                                                id="quantity"
                                                type="number"
                                                min="0"
                                                value={formData.quantity}
                                                onChange={(e) => setFormData({ ...formData, quantity: e.target.value === '' ? '' : parseInt(e.target.value) })}
                                                placeholder="0"
                                                readOnly={!canEdit}
                                                className="h-12 rounded-lg border-border/40 focus:border-primary/40 focus:ring-primary/10 bg-muted/10 font-black transition-all pr-16"
                                                required
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground/60 uppercase tracking-wider pointer-events-none">
                                                {t(`products.units.${formData.unit}`, formData.unit)}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="minStockLevel" className="flex items-center gap-2 font-bold">
                                            <Info className="w-4 h-4 text-primary/60" />
                                            {t('products.form.minStock')}
                                        </Label>
                                        <div className="relative">
                                            <Input
                                                id="minStockLevel"
                                                type="number"
                                                min="0"
                                                value={formData.minStockLevel}
                                                onChange={(e) => setFormData({ ...formData, minStockLevel: e.target.value === '' ? '' : parseInt(e.target.value) })}
                                                readOnly={!canEdit}
                                                className="h-12 rounded-lg border-border/40 focus:border-primary/40 focus:ring-primary/10 bg-muted/10 font-bold transition-all pr-16"
                                                required
                                            />
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground/60 uppercase tracking-wider pointer-events-none">
                                                {t(`products.units.${formData.unit}`, formData.unit)}
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                <div className="pt-2 px-1">
                                    <div className="flex items-center justify-between p-5 rounded-xl border border-border/60 bg-muted/30 hover:bg-muted/40 transition-all duration-300">
                                        <div className="space-y-1 text-start">
                                            <Label htmlFor="canBeReturned" className="text-base font-black flex items-center gap-2 cursor-pointer text-foreground/90">
                                                <div className={cn(
                                                    "w-8 h-8 rounded-xl flex items-center justify-center transition-colors shadow-sm",
                                                    formData.canBeReturned ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"
                                                )}>
                                                    <ChevronRight className={cn("w-4 h-4 transition-transform", formData.canBeReturned && "rotate-90")} />
                                                </div>
                                                {t('products.form.canBeReturned') || 'Can be Returned'}
                                            </Label>
                                            <p className="text-sm text-muted-foreground/80 leading-relaxed font-medium pl-10">
                                                {formData.canBeReturned
                                                    ? (t('products.form.canBeReturnedDesc') || 'Customers can return this product.')
                                                    : (t('products.form.cannotBeReturnedDesc') || 'This product is non-returnable.')}
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-4 ml-4 rtl:ml-0 rtl:mr-4">
                                            {formData.canBeReturned && (
                                                <Button
                                                    type="button"
                                                    variant="secondary"
                                                    size="sm"
                                                    onClick={() => setReturnRulesModalOpen(true)}
                                                    className="h-10 px-5 gap-2 rounded-xl border border-primary/10 hover:border-primary/30 hover:bg-primary/5 transition-all animate-in fade-in zoom-in duration-200 font-bold"
                                                >
                                                    <Settings className="w-4 h-4" />
                                                    {t('products.form.addRules') || 'Add rules'}
                                                </Button>
                                            )}
                                            <Switch
                                                id="canBeReturned"
                                                checked={formData.canBeReturned}
                                                onCheckedChange={(checked) => setFormData({ ...formData, canBeReturned: checked })}
                                                disabled={!canEdit}
                                                className="data-[state=checked]:bg-emerald-500"
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Section: Visuals */}
                            <div className="space-y-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="h-4 w-1 bg-primary rounded-full transition-all group-hover:h-6" />
                                    <h3 className="text-sm font-black uppercase tracking-widest text-primary/80">{t('products.form.visuals')}</h3>
                                </div>

                                <div className="flex flex-col md:flex-row gap-6 items-start p-1">
                                    {/* Preview Thumbnail */}
                                    <div className="relative group w-full md:w-44 aspect-square rounded-xl border-2 border-dashed border-primary/20 bg-muted/30 hover:bg-muted/50 hover:border-primary/40 transition-all duration-300 flex items-center justify-center overflow-hidden shrink-0 shadow-inner">
                                        {!formData.imageUrl ? (
                                            <div className="flex flex-col items-center gap-3">
                                                <ImagePlus className="w-8 h-8 text-primary shadow-sm" />
                                                <span className="text-[10px] font-black uppercase tracking-tighter text-primary/60">{t('products.form.noImage') || 'No Preview'}</span>
                                            </div>
                                        ) : imageError ? (
                                            <div className="flex flex-col items-center gap-2 px-2 text-center animate-in fade-in zoom-in duration-300">
                                                <Package className="w-10 h-10 text-destructive/30" />
                                                <span className="text-[11px] font-bold text-destructive/60 uppercase">{t('products.form.imageError') || 'Image Error'}</span>
                                            </div>
                                        ) : (
                                            <>
                                                <img
                                                    src={getDisplayImageUrl(formData.imageUrl)}
                                                    alt="Preview"
                                                    className="w-full h-full object-cover animate-in fade-in duration-500 group-hover:scale-110"
                                                    onError={() => setImageError(true)}
                                                />
                                                {canEdit && (
                                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon"
                                                            onClick={handleRemoveImage}
                                                            className="h-12 w-12 rounded-full bg-destructive/90 text-white hover:bg-destructive hover:scale-110 transition-all"
                                                        >
                                                            <Trash2 className="w-6 h-6" />
                                                        </Button>
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>

                                    <div className="flex-1 space-y-4 w-full">
                                        <div className="flex flex-col gap-3">
                                            <Label htmlFor="imageUrl" className="flex items-center gap-2 font-bold">
                                                <Info className="w-4 h-4 text-primary/60" />
                                                {t('products.form.imageUrl') || 'Image Source'}
                                            </Label>
                                            <div className="flex flex-col sm:flex-row gap-3">
                                                <Input
                                                    id="imageUrl"
                                                    value={formData.imageUrl}
                                                    onChange={(e) => {
                                                        setFormData({ ...formData, imageUrl: e.target.value });
                                                        setImageError(false);
                                                    }}
                                                    placeholder={t('products.form.imageUrlPlaceholder') || "Image URL or local path"}
                                                    readOnly={!canEdit}
                                                    className="h-12 rounded-lg border-border/40 focus:border-primary/40 focus:ring-primary/10 bg-muted/10 transition-all flex-1"
                                                />
                                                {canEdit && (
                                                    <div className="flex gap-2">
                                                        <Button
                                                            type="button"
                                                            variant="outline"
                                                            onClick={handleImageUpload}
                                                            className="h-12 px-6 rounded-lg gap-2 font-bold border-primary/20 hover:border-primary/50 hover:bg-primary/5 transition-all"
                                                        >
                                                            <ImagePlus className="w-4 h-4" />
                                                            {t('products.form.upload') || 'Upload'}
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            variant="outline"
                                                            onClick={handleCameraClick}
                                                            className="h-12 w-12 sm:w-auto sm:px-6 rounded-lg gap-2 font-bold border-primary/20 hover:border-primary/50 hover:bg-primary/5 transition-all text-primary"
                                                        >
                                                            <Camera className="w-4 h-4" />
                                                            <span className="hidden sm:inline">{t('products.form.camera') || 'Camera'}</span>
                                                        </Button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        <div className="p-4 rounded-xl bg-muted/30 border border-border/40 flex items-start gap-3">
                                            <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                                            <p className="text-[11px] text-muted-foreground/80 leading-relaxed font-medium">
                                                {isElectron
                                                    ? (t('products.form.localPathDesc') || 'Image will be stored locally in your device and automatically synced to other devices in your workspace via Cloudflare R2.')
                                                    : (t('products.form.webUploadDesc') || 'Image will be securely uploaded and synced via cloud storage.')}
                                            </p>
                                        </div>

                                        <input
                                            type="file"
                                            ref={cameraInputRef}
                                            className="hidden"
                                            accept="image/*"
                                            capture="environment"
                                            onChange={handleCameraCapture}
                                        />
                                        <input
                                            type="file"
                                            ref={imageUploadInputRef}
                                            className="hidden"
                                            accept="image/*"
                                            onChange={handleImageFileInputChange}
                                        />
                                    </div>
                                </div>
                            </div>
                        </form>
                    </div>

                    <DialogFooter className="p-6 bg-muted/30 border-t flex-row justify-end gap-3 sm:gap-4">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setIsDialogOpen(false)}
                            className="h-12 px-8 rounded-lg font-bold text-muted-foreground hover:bg-muted/80 transition-all order-last sm:order-first"
                        >
                            {t('common.cancel')}
                        </Button>
                        {canEdit && (
                            <Button
                                form="product-form"
                                type="submit"
                                disabled={isLoading}
                                className={cn(
                                    "h-12 px-10 rounded-lg font-black shadow-lg transition-all",
                                    pulseProductSubmit ? "animate-save-pulse bg-emerald-500 scale-105" : "bg-primary shadow-primary/20 hover:shadow-primary/40",
                                    isLoading && "opacity-80"
                                )}
                            >
                                {isLoading ? (
                                    <div className="flex items-center gap-2">
                                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                        {t('common.loading')}
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        {isCloning ? <span className="uppercase tracking-widest">{t('common.clone') || 'Clone'}</span> : editingProduct ? <span className="uppercase tracking-widest">{t('common.save')}</span> : <span className="uppercase tracking-widest">{t('common.create')}</span>}
                                    </div>
                                )}
                            </Button>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {/* Category Dialog */}
            < Dialog open={isCategoryDialogOpen} onOpenChange={setIsCategoryDialogOpen} >
                {/* ... existing Category Dialog content ... */}
                < DialogContent
                    className="max-w-md"
                    onPointerDownOutside={handleCategoryOutsideClick}
                >
                    <DialogHeader>
                        <DialogTitle>{editingCategory ? t('categories.editCategory') : t('categories.addCategory')}</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleCategorySubmit} className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="cat-name">{t('categories.form.name')}</Label>
                            <Input
                                id="cat-name"
                                value={categoryFormData.name}
                                onChange={(e) => setCategoryFormData({ ...categoryFormData, name: e.target.value })}
                                placeholder={t('categories.form.name')}
                                required
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="cat-description">{t('categories.form.description')}</Label>
                            <Textarea
                                id="cat-description"
                                value={categoryFormData.description}
                                onChange={(e) => setCategoryFormData({ ...categoryFormData, description: e.target.value })}
                                placeholder={t('categories.form.description')}
                                rows={3}
                            />
                        </div>

                        {/* Category List (Management) */}
                        {!editingCategory && categories.length > 0 && (
                            <div className="pt-4 border-t">
                                <Label className="mb-2 block text-sm font-medium">Existing Categories</Label>
                                <div className="space-y-2 max-h-40 overflow-y-auto pr-2">
                                    {categories.map((cat) => (
                                        <div key={cat.id} className="flex items-center justify-between p-2 bg-muted/50 rounded-md group">
                                            <span className="text-sm">{cat.name}</span>
                                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleOpenCategoryDialog(cat)}>
                                                    <Pencil className="h-3 w-3" />
                                                </Button>
                                                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => handleDeleteCategory(cat)}>
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
                                <Button type="button" variant="ghost" onClick={() => setEditingCategory(null)}>
                                    Cancel Edit
                                </Button>
                            )}
                            <Button
                                type="submit"
                                disabled={isLoading}
                                className={cn(pulseCategorySubmit && "animate-save-pulse")}
                            >
                                {isLoading ? t('common.loading') : editingCategory ? t('common.save') : t('common.create')}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent >
            </Dialog >

            {/* Return Rules Modal */}
            < Dialog open={returnRulesModalOpen} onOpenChange={setReturnRulesModalOpen} >
                <DialogContent className="max-w-md animate-in fade-in zoom-in duration-300">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Settings className="w-5 h-5 text-primary" />
                            {t('products.form.returnRulesTitle') || 'Return Rules'}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <div className="flex justify-between items-center">
                                <Label htmlFor="returnRules">{t('products.form.rulesLabel') || 'Specify return conditions'}</Label>
                                <span className={cn(
                                    "text-[10px] font-mono",
                                    formData.returnRules.length >= 225 ? "text-destructive font-bold" : "text-muted-foreground"
                                )}>
                                    {formData.returnRules.length}/250
                                </span>
                            </div>
                            <Textarea
                                id="returnRules"
                                value={formData.returnRules}
                                onChange={(e) => setFormData({ ...formData, returnRules: e.target.value.slice(0, 250) })}
                                placeholder={t('products.form.rulesPlaceholder') || "e.g. Must be in original packaging, Only within 7 days..."}
                                rows={6}
                                maxLength={250}
                                className="resize-none"
                            />
                        </div>
                        <p className="text-xs text-muted-foreground italic">
                            {t('products.form.rulesHint') || 'These rules will be shown to staff during the return process.'}
                        </p>
                    </div>
                    <DialogFooter>
                        <Button type="button" onClick={() => setReturnRulesModalOpen(false)}>
                            {t('common.done') || 'Done'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog >
            {/* Unsaved Changes Confirmation Modal */}
            < Dialog open={showUnsavedChangesModal} onOpenChange={setShowUnsavedChangesModal} >
                <DialogContent className="max-w-lg animate-in fade-in zoom-in duration-300 border-primary/20 shadow-2xl p-0 overflow-hidden">
                    <div className="p-6 border-b bg-muted/30">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2 text-primary text-xl">
                                <Info className="w-6 h-6" />
                                {t('common.unsavedChanges.title') || 'Unsaved Changes'}
                            </DialogTitle>
                        </DialogHeader>
                    </div>

                    <div className="p-8">
                        <p className="text-lg text-foreground/90 font-medium leading-relaxed">
                            {t('common.unsavedChanges.message') || 'You have unsaved changes. Would you like to save them now or discard everything?'}
                        </p>
                    </div>

                    <DialogFooter className="flex flex-col sm:flex-row gap-3 w-full p-6 bg-muted/20 border-t">
                        <Button
                            variant="ghost"
                            onClick={() => setShowUnsavedChangesModal(false)}
                            className="w-full sm:w-auto h-11 text-muted-foreground order-last sm:order-first px-6"
                        >
                            {t('common.unsavedChanges.continue') || 'Continue Editing'}
                        </Button>

                        <div className="flex flex-col sm:flex-row gap-3 flex-1">
                            <Button
                                variant="destructive"
                                onClick={handleDiscardChanges}
                                className="flex-1 h-11 text-base font-bold shadow-sm"
                            >
                                {t('common.unsavedChanges.discard') || 'Discard Changes'}
                            </Button>
                            <Button
                                variant="default"
                                onClick={handleSaveDirtyChanges}
                                className="flex-1 h-11 text-base font-bold shadow-lg shadow-primary/20"
                            >
                                {t('common.unsavedChanges.save') || 'Save Changes'}
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog >

            <DeleteConfirmationModal
                isOpen={deleteModalOpen}
                onClose={() => setDeleteModalOpen(false)}
                onConfirm={confirmDelete}
                itemName={itemToDelete?.name}
                isLoading={isLoading}
                title={itemToDelete?.type === 'category' ? t('categories.confirmDelete') : t('products.confirmDelete')}
                description={itemToDelete?.type === 'category' ? t('categories.deleteWarning') : t('products.deleteWarning')}
            />
        </div >
    )
}
