import { useStorages, createStorage, updateStorage, deleteStorage, setMarketplaceStorage, getPrimaryStorageId, getPrimaryStorageFromList, isPrimaryStorage, useInventory, useProducts, useCategories, type Storage, type CurrencyCode } from '@/local-db'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { Button } from '@/ui/components/button'
import { Plus, Search, Edit, Trash2, Warehouse, ShieldCheck, Package, Filter, LayoutGrid, Info, Store } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card'
import { Input } from '@/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components/table'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/ui/components/dialog'
import { Label } from '@/ui/components/label'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/ui/components/use-toast'
import { StorageSelector, Tabs, TabsList, TabsTrigger, TabsContent, Select, SelectContent, SelectTrigger, SelectValue, SelectItem } from '@/ui/components'
import { formatCurrency, cn } from '@/lib/utils'
import { platformService } from '@/services/platformService'

export default function Storages() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { activeWorkspace } = useWorkspace()
    const storages = useStorages(activeWorkspace?.id)
    const { toast } = useToast()
    const [searchQuery, setSearchQuery] = useState('')
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editingStorage, setEditingStorage] = useState<Storage | undefined>(undefined)
    const [deletingStorage, setDeletingStorage] = useState<Storage | undefined>(undefined)
    const [storageName, setStorageName] = useState('')

    const filteredStorages = storages.filter(s =>
        s.name.toLowerCase().includes(searchQuery.toLowerCase())
    )

    const products = useProducts(activeWorkspace?.id)
    const inventory = useInventory(activeWorkspace?.id)
    const categories = useCategories(activeWorkspace?.id)
    const { features } = useWorkspace()

    const [selectedStorageId, setSelectedStorageId] = useState<string>(() => {
        return localStorage.getItem('storages_inventory_selected_storage') || ''
    })
    const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all')
    const [inventorySearch, setInventorySearch] = useState('')
    const [marketplaceStoragePendingId, setMarketplaceStoragePendingId] = useState<string | null>(null)

    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const settlementCurrency = (features.default_currency || 'usd') as CurrencyCode
    const isMarketplacePublic = features.visibility === 'public'
    const canManageMarketplaceStorage = user?.role === 'admin' && isMarketplacePublic
    const showMarketplaceStorageState = isMarketplacePublic

    const getStorageDisplayName = useCallback((storage: Storage) => {
        return storage.isSystem
            ? (t(`storages.${storage.name.toLowerCase()}`, { defaultValue: storage.name }) || storage.name)
            : storage.name
    }, [t])

    const convertPrice = useCallback((amount: number, from: CurrencyCode, to: CurrencyCode) => {
        if (from === to) return amount

        const getRate = (pair: 'usd_iqd' | 'usd_eur' | 'eur_iqd') => {
            if (pair === 'usd_iqd') return exchangeData ? exchangeData.rate / 100 : null
            if (pair === 'usd_eur') return eurRates.usd_eur ? eurRates.usd_eur.rate / 100 : null
            if (pair === 'eur_iqd') return eurRates.eur_iqd ? eurRates.eur_iqd.rate / 100 : null
            return null
        }

        let converted = amount

        if (from === 'usd' && to === 'iqd') {
            const r = getRate('usd_iqd'); if (r) converted = amount * r
        } else if (from === 'iqd' && to === 'usd') {
            const r = getRate('usd_iqd'); if (r) converted = amount / r
        } else if (from === 'usd' && to === 'eur') {
            const r = getRate('usd_eur'); if (r) converted = amount * r
        } else if (from === 'eur' && to === 'usd') {
            const r = getRate('usd_eur'); if (r) converted = amount / r
        } else if (from === 'eur' && to === 'iqd') {
            const r = getRate('eur_iqd'); if (r) converted = amount * r
        } else if (from === 'iqd' && to === 'eur') {
            const r = getRate('eur_iqd'); if (r) converted = amount / r
        } else if (from === 'try' && to === 'iqd') {
            if (tryRates.try_iqd) converted = amount * (tryRates.try_iqd.rate / 100)
        } else if (from === 'iqd' && to === 'try') {
            if (tryRates.try_iqd) converted = amount / (tryRates.try_iqd.rate / 100)
        } else if (from === 'usd' && to === 'try') {
            if (tryRates.usd_try) converted = amount * (tryRates.usd_try.rate / 100)
        } else if (from === 'try' && to === 'usd') {
            if (tryRates.usd_try) converted = amount / (tryRates.usd_try.rate / 100)
        } else if (from === 'try' && to === 'eur') {
            const tryIqdRate = tryRates.try_iqd ? tryRates.try_iqd.rate / 100 : null
            const eurIqdRate = eurRates.eur_iqd ? eurRates.eur_iqd.rate / 100 : null
            if (tryIqdRate && eurIqdRate) converted = (amount * tryIqdRate) / eurIqdRate
        } else if (from === 'eur' && to === 'try') {
            const eurIqdRate = eurRates.eur_iqd ? eurRates.eur_iqd.rate / 100 : null
            const tryIqdRate = tryRates.try_iqd ? tryRates.try_iqd.rate / 100 : null
            if (eurIqdRate && tryIqdRate) converted = (amount * eurIqdRate) / tryIqdRate
        }

        if (to === 'iqd') return Math.round(converted)
        return Math.round(converted * 100) / 100
    }, [exchangeData, eurRates, tryRates])

    const totalStorageValue = useMemo(() => {
        if (!selectedStorageId) return 0
        return inventory.reduce((sum, row) => {
            if (row.storageId !== selectedStorageId) {
                return sum
            }

            const product = products.find((entry) => entry.id === row.productId)
            if (!product || product.isDeleted) {
                return sum
            }

            const converted = convertPrice(product.price, product.currency, settlementCurrency)
            return sum + (converted * row.quantity)
        }, 0)
    }, [inventory, products, selectedStorageId, convertPrice, settlementCurrency])

    useEffect(() => {
        if (selectedStorageId) {
            localStorage.setItem('storages_inventory_selected_storage', selectedStorageId)
        }
    }, [selectedStorageId])

    useEffect(() => {
        if (storages.length > 0 && (!selectedStorageId || !storages.find(s => s.id === selectedStorageId))) {
            const primaryStorage = getPrimaryStorageFromList(storages)
            if (primaryStorage) setSelectedStorageId(primaryStorage.id)
        }
    }, [storages, selectedStorageId])

    const inventoryProducts = useMemo(() => inventory
        .filter((row) => row.storageId === selectedStorageId)
        .map((row) => {
            const product = products.find((entry) => entry.id === row.productId)
            if (!product || product.isDeleted) {
                return null
            }

            const matchesCategory = selectedCategoryId === 'all' || product.categoryId === selectedCategoryId
            const matchesSearch = product.name.toLowerCase().includes(inventorySearch.toLowerCase())
                || product.sku.toLowerCase().includes(inventorySearch.toLowerCase())

            if (!matchesCategory || !matchesSearch) {
                return null
            }

            return { row, product }
        })
        .filter((entry): entry is { row: (typeof inventory)[number]; product: (typeof products)[number] } => !!entry),
        [inventory, inventorySearch, products, selectedCategoryId, selectedStorageId])

    const getDisplayImageUrl = (url?: string) => {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        return platformService.convertFileSrc(url);
    }

    const handleCreate = async () => {
        if (!activeWorkspace || !storageName.trim()) return
        await createStorage(activeWorkspace.id, { name: storageName.trim() })
        setStorageName('')
        setIsDialogOpen(false)
        toast({ title: t('storages.created', 'Storage created successfully') })
    }

    const handleUpdate = async () => {
        if (!editingStorage || !storageName.trim()) return
        await updateStorage(editingStorage.id, { name: storageName.trim() })
        setStorageName('')
        setEditingStorage(undefined)
        setIsDialogOpen(false)
        toast({ title: t('storages.updated', 'Storage updated successfully') })
    }

    const handleDelete = async () => {
        if (!deletingStorage || !activeWorkspace) return

        const fallbackStorageId = await getPrimaryStorageId(activeWorkspace.id, deletingStorage.id)
        if (!fallbackStorageId) {
            toast({ title: t('storages.noPrimary', 'Primary storage not found'), variant: 'destructive' })
            return
        }

        const fallbackStorage = storages.find((storage) => storage.id === fallbackStorageId)
        const result = await deleteStorage(deletingStorage.id, fallbackStorageId)
        if (result.success) {
            if (result.movedCount > 0) {
                toast({
                    title: t('storages.deleted', 'Storage deleted'),
                    description: t('storages.productsMovedToStorage', '{{count}} products moved to {{storage}}', {
                        count: result.movedCount,
                        storage: fallbackStorage
                            ? getStorageDisplayName(fallbackStorage)
                            : (t('storages.primary', { defaultValue: 'Primary Storage' }) || 'Primary Storage')
                    })
                })
            } else {
                toast({ title: t('storages.deleted', 'Storage deleted') })
            }
        }
        setDeletingStorage(undefined)
    }

    const handleMarketplaceStorageChange = async (storage: Storage, checked: boolean) => {
        if (!activeWorkspace || !canManageMarketplaceStorage || !checked || storage.isMarketplace) {
            return
        }

        setMarketplaceStoragePendingId(storage.id)
        try {
            await setMarketplaceStorage(activeWorkspace.id, storage.id)
            toast({
                title: t('storages.marketplaceUpdated', { defaultValue: 'Marketplace storage updated' }),
                description: t('storages.marketplaceUpdatedDesc', {
                    defaultValue: 'Marketplace products will now be served from {{storage}}.',
                    storage: getStorageDisplayName(storage)
                })
            })
        } catch (error) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error instanceof Error
                    ? error.message
                    : t('storages.marketplaceUpdateError', { defaultValue: 'Failed to update marketplace storage.' }),
                variant: 'destructive'
            })
        } finally {
            setMarketplaceStoragePendingId(null)
        }
    }

    const openCreateDialog = () => {
        setEditingStorage(undefined)
        setStorageName('')
        setIsDialogOpen(true)
    }

    const openEditDialog = (storage: Storage) => {
        setEditingStorage(storage)
        setStorageName(storage.name)
        setIsDialogOpen(true)
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Warehouse className="w-6 h-6 text-primary" />
                        {t('storages.title', 'Storages')}
                    </h1>
                    <p className="text-muted-foreground">{t('storages.subtitle', 'Manage your storage locations.')}</p>
                </div>
                {(user?.role === 'admin' || user?.role === 'staff') && (
                    <Button onClick={openCreateDialog} className="rounded-xl shadow-lg transition-all active:scale-95">
                        <Plus className="mr-2 h-4 w-4" /> {t('storages.addStorage', 'New Storage')}
                    </Button>
                )}
            </div>

            <Tabs defaultValue="locations" className="w-full">
                <TabsList className="bg-muted/50 p-1 rounded-xl mb-6">
                    <TabsTrigger value="locations" className="rounded-lg px-6 font-bold flex gap-2">
                        <Warehouse className="w-4 h-4" />
                        {t('storages.tabs.locations', 'Locations')}
                    </TabsTrigger>
                    <TabsTrigger value="inventory" className="rounded-lg px-6 font-bold flex gap-2">
                        <LayoutGrid className="w-4 h-4" />
                        {t('storages.tabs.inventory', 'Storage Inventory')}
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="locations" className="space-y-6">
                    <div className="flex items-center justify-between gap-4">
                        <div className="relative w-full max-w-sm">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder={t('storages.searchPlaceholder', 'Search storages...')}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                allowViewer={true}
                                className="pl-10 rounded-xl bg-card border-none shadow-sm focus-visible:ring-1 focus-visible:ring-primary/50 transition-all"
                            />
                        </div>
                    </div>

                    {canManageMarketplaceStorage && (
                        <Card className="border-emerald-500/20 bg-emerald-500/5">
                            <CardContent className="flex items-start gap-3 p-4 text-sm text-emerald-800 dark:text-emerald-200">
                                <Store className="mt-0.5 h-4 w-4 shrink-0" />
                                <p>{t('storages.marketplaceHint', { defaultValue: 'Click "Enable Marketplace Storage" on the storage you want to publish. Only one storage can power the marketplace at a time, and switching it disables the previous one automatically.' })}</p>
                            </CardContent>
                        </Card>
                    )}

                    <Card className="rounded-2xl overflow-hidden border-2 shadow-sm">
                        <CardHeader className="bg-muted/30 border-b">
                            <CardTitle className="text-lg font-bold flex items-center gap-2">
                                <Warehouse className="w-5 h-5 text-primary/70" />
                                {t('storages.listTitle', 'Storage Locations')}
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="p-0">
                            <Table>
                                <TableHeader className="bg-muted/20">
                                    <TableRow className="hover:bg-transparent border-b">
                                        <TableHead className="font-bold py-4 pl-6 text-primary/80">{t('storages.table.name', 'Name')}</TableHead>
                                        <TableHead className="font-bold">{t('storages.table.type', 'Type')}</TableHead>
                                        <TableHead className="text-right font-bold pr-6">{t('storages.table.actions', 'Actions')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filteredStorages.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={3} className="h-48 text-center bg-muted/5">
                                                <div className="flex flex-col items-center justify-center gap-2 opacity-30">
                                                    <Warehouse className="w-12 h-12" />
                                                    <p className="text-sm font-medium">{t('common.noData', 'No results found.')}</p>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ) : (
                                        filteredStorages.map((storage) => (
                                            <TableRow key={storage.id} className="group hover:bg-muted/30 transition-colors border-b last:border-0 text-foreground/80">
                                                <TableCell className="font-bold pl-6 text-foreground">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        {storage.isSystem && <ShieldCheck className="w-4 h-4 text-amber-500" />}
                                                        {getStorageDisplayName(storage)}
                                                        {isPrimaryStorage(storage) && (
                                                            <span className="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-primary/10 text-primary">
                                                                {t('storages.primary', 'Primary')}
                                                            </span>
                                                        )}
                                                        {showMarketplaceStorageState && storage.isMarketplace && (
                                                            <span className="px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                                                                {t('storages.marketplaceBadge', { defaultValue: 'Marketplace' })}
                                                            </span>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-widest ${storage.isSystem
                                                        ? 'bg-amber-500/20 text-amber-700 dark:text-amber-400'
                                                        : 'bg-secondary/50 text-secondary-foreground'
                                                        }`}>
                                                        {storage.isSystem ? t('storages.system', 'System') : t('storages.custom', 'Custom')}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right pr-6">
                                                    <div className="flex justify-end items-center gap-2 flex-wrap">
                                                        {canManageMarketplaceStorage && (
                                                            <Button
                                                                type="button"
                                                                size="sm"
                                                                variant={storage.isMarketplace ? 'default' : 'outline'}
                                                                disabled={marketplaceStoragePendingId !== null}
                                                                className={storage.isMarketplace
                                                                    ? 'rounded-full bg-emerald-600 hover:bg-emerald-600 text-white'
                                                                    : 'rounded-full border-emerald-500/30 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300'}
                                                                onClick={() => {
                                                                    void handleMarketplaceStorageChange(storage, true)
                                                                }}
                                                            >
                                                                <Store className="h-3.5 w-3.5" />

                                                            </Button>
                                                        )}
                                                        <div className="flex justify-end gap-1">
                                                            {!storage.isSystem && (
                                                                <>
                                                                    {(user?.role === 'admin' || user?.role === 'staff') && (
                                                                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl hover:bg-primary/10 hover:text-primary transition-all" onClick={() => openEditDialog(storage)}>
                                                                            <Edit className="h-4 w-4" />
                                                                        </Button>
                                                                    )}
                                                                    {user?.role === 'admin' && (
                                                                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl hover:bg-destructive/10 hover:text-destructive transition-all" onClick={() => setDeletingStorage(storage)}>
                                                                            <Trash2 className="h-4 w-4" />
                                                                        </Button>
                                                                    )}
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        ))
                                    )}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="inventory" className="space-y-6">
                    <Card className="rounded-2xl border-none shadow-none bg-transparent">
                        <CardHeader className="px-0 pt-0 pb-6">
                            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6">
                                <div className="flex flex-wrap items-center gap-4">
                                    {/* Storage Selector */}
                                    <div className="space-y-1.5 min-w-[200px]">
                                        <Label className="text-[10px] font-black uppercase tracking-widest opacity-50 ml-1">
                                            {t('storages.selectStorage', 'Active Storage')}
                                        </Label>
                                        <StorageSelector
                                            storages={storages}
                                            selectedStorageId={selectedStorageId}
                                            onSelect={setSelectedStorageId}
                                            className="w-full h-11 rounded-xl bg-card border-none shadow-sm"
                                        />
                                    </div>

                                    {/* Category Filter */}
                                    <div className="space-y-1.5 min-w-[200px]">
                                        <Label className="text-[10px] font-black uppercase tracking-widest opacity-50 ml-1">
                                            {t('products.table.category', 'Category')}
                                        </Label>
                                        <Select value={selectedCategoryId} onValueChange={setSelectedCategoryId}>
                                            <SelectTrigger allowViewer={true} className="w-full h-11 rounded-xl bg-card border-none shadow-sm">
                                                <div className="flex items-center gap-2">
                                                    <Filter className="w-3.5 h-3.5 text-muted-foreground" />
                                                    <SelectValue />
                                                </div>
                                            </SelectTrigger>
                                            <SelectContent className="rounded-xl border-border/50">
                                                <SelectItem value="all">{t('categories.allCategories', 'All Categories')}</SelectItem>
                                                {categories.map(category => (
                                                    <SelectItem key={category.id} value={category.id}>
                                                        {category.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {/* Search */}
                                    <div className="space-y-1.5 flex-1 min-w-[240px]">
                                        <Label className="text-[10px] font-black uppercase tracking-widest opacity-50 ml-1">
                                            {t('products.searchPlaceholder', 'Find Product')}
                                        </Label>
                                        <div className="relative">
                                            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                            <Input
                                                placeholder={t('products.searchPlaceholder', 'SKU or Name...')}
                                                value={inventorySearch}
                                                onChange={(e) => setInventorySearch(e.target.value)}
                                                allowViewer={true}
                                                className="pl-10 h-11 rounded-xl bg-card border-none shadow-sm focus-visible:ring-1 focus-visible:ring-primary/50"
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="flex items-center gap-4 text-right">
                                    <div className="px-5 py-2.5 rounded-2xl bg-primary/5 border border-primary/10 border-dashed">
                                        <div className="text-[10px] font-black uppercase tracking-widest text-primary/60 mb-0.5">
                                            {t('storages.totalItems', 'Matched Items')}
                                        </div>
                                        <div className="text-xl font-black text-primary leading-none">
                                            {inventoryProducts.length}
                                        </div>
                                    </div>

                                    <div className="px-5 py-2.5 rounded-2xl bg-primary/10 border border-primary/20 border-solid">
                                        <div className="text-[10px] font-black uppercase tracking-widest text-primary/70 mb-0.5">
                                            {t('storages.totalValue', 'Storage Value')}
                                        </div>
                                        <div className="text-xl font-black text-primary leading-none">
                                            {formatCurrency(totalStorageValue, settlementCurrency, features.iqd_display_preference)}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </CardHeader>

                        <CardContent className="px-0">
                            {inventoryProducts.length === 0 ? (
                                <div className="h-64 rounded-[2.5rem] bg-card/30 border-2 border-dashed border-border/50 flex flex-col items-center justify-center gap-4 text-muted-foreground/40 animate-in fade-in zoom-in-95 duration-500">
                                    <Package className="w-16 h-16 opacity-20" />
                                    <div className="text-center">
                                        <p className="font-bold text-lg">{t('common.noData', 'No products found')}</p>
                                        <p className="text-sm">{t('storages.tryDifferentFilter', 'Try adjusting your filters or search')}</p>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                    {inventoryProducts.map(({ row, product }) => (
                                        <div
                                            key={row.id}
                                            className="group relative bg-card rounded-[1.5rem] border border-border/50 p-4 transition-all duration-300 hover:shadow-2xl hover:shadow-primary/5 hover:-translate-y-1 flex flex-col gap-4 overflow-hidden"
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
                                                    row.quantity <= product.minStockLevel ? "bg-amber-500 text-white" : "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20"
                                                )}>
                                                    {row.quantity <= product.minStockLevel ? (t('products.lowStock') || 'Low Stock') : (t('products.inStock') || 'In Stock')}
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
                                                    {categories.find(c => c.id === product.categoryId)?.name || t('categories.noCategory')}
                                                </div>
                                            </div>

                                            {/* Pricing */}
                                            <div className="pt-3 border-t border-border/40 flex items-center justify-between">
                                                <div>
                                                    <div className="text-lg font-black text-primary">
                                                        {formatCurrency(product.price, product.currency, features.iqd_display_preference)}
                                                    </div>
                                                    <div className="text-[11px] text-muted-foreground font-medium">
                                                        {row.quantity} {product.unit}
                                                    </div>
                                                </div>
                                                <div className="w-8 h-8 rounded-lg bg-primary/5 flex items-center justify-center">
                                                    <Info className="w-3.5 h-3.5 text-primary/40" />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>

            {/* Create/Edit Dialog */}
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                <DialogContent className="rounded-2xl">
                    <DialogHeader>
                        <DialogTitle>
                            {editingStorage ? t('storages.editStorage', 'Edit Storage') : t('storages.addStorage', 'New Storage')}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label htmlFor="storage-name">{t('storages.form.name', 'Storage Name')}</Label>
                            <Input
                                id="storage-name"
                                value={storageName}
                                onChange={(e) => setStorageName(e.target.value)}
                                placeholder={t('storages.form.namePlaceholder', 'e.g. Warehouse A')}
                                className="rounded-xl"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsDialogOpen(false)} className="rounded-xl">
                            {t('common.cancel', 'Cancel')}
                        </Button>
                        <Button onClick={editingStorage ? handleUpdate : handleCreate} className="rounded-xl">
                            {editingStorage ? t('common.save', 'Save') : t('common.create', 'Create')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <DeleteConfirmationModal
                isOpen={!!deletingStorage}
                onClose={() => setDeletingStorage(undefined)}
                onConfirm={handleDelete}
                title={t('storages.confirmDelete', 'Delete Storage')}
                description={t('storages.messages.deleteConfirmPrimary', 'Products in this storage will be moved to the primary storage or next available storage. Continue?')}
            />
        </div>
    )
}
