import { useEffect, useState } from 'react'
import { useLocation } from 'wouter'
import { useTranslation } from 'react-i18next'
import { Copy, Info, LayoutGrid, List as ListIcon, Package, Pencil, Plus, Search, Trash2 } from 'lucide-react'

import { useAuth } from '@/auth'
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
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Textarea
} from '@/ui/components'

const emptyCategoryFormData = { name: '', description: '' }

export function Products() {
    const { user } = useAuth()
    const { features } = useWorkspace()
    const { t } = useTranslation()
    const [, navigate] = useLocation()
    const products = useProducts(user?.workspaceId)
    const categories = useCategories(user?.workspaceId)
    const storages = useStorages(user?.workspaceId)
    const workspaceId = user?.workspaceId || ''
    const canEdit = user?.role === 'admin' || user?.role === 'staff'
    const canDelete = user?.role === 'admin'

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

    useEffect(() => {
        localStorage.setItem('products_view_mode', viewMode)
    }, [viewMode])

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
                                        <div key={product.id} className="space-y-4 rounded-[2rem] border border-border bg-card p-4 shadow-sm">
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
                                                <div key={product.id} className="group relative flex flex-col gap-4 overflow-hidden rounded-[1.5rem] border border-border/50 bg-card p-4 transition-all duration-300 hover:-translate-y-1 hover:bg-accent/5 hover:shadow-2xl hover:shadow-primary/5">
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
                                                    <TableRow key={product.id}>
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
