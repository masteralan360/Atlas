import { useStorages, createStorage, updateStorage, deleteStorage, setMarketplaceStorage, getPrimaryStorageId, getPrimaryStorageFromList, isPrimaryStorage, useInventory, useProducts, useCategories, type Storage, type CurrencyCode } from '@/local-db'
import { replaceStorageMemberExclusions, useStorageMemberExclusionsState } from '@/local-db/storagePermissions'
import { useWorkspaceUsers } from '@/local-db/hooks'
import { ModulePageFreshness } from '@/ui/components/ModulePageFreshness'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useLocation } from 'wouter'
import { useExchangeRate } from '@/context/ExchangeRateContext'
import { useAuth } from '@/auth'
import { useWorkspace } from '@/workspace'
import { Button } from '@/ui/components/button'
import { Plus, Search, Edit, Trash2, Warehouse, ShieldCheck, Package, Filter, LayoutGrid, Info, Store, ArrowRight, KeyRound, UsersRound } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/card'
import { Input } from '@/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/components/table'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/ui/components/dialog'
import { Label } from '@/ui/components/label'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/ui/components/use-toast'
import { AppDialog, AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader, AppDialogTitle, StorageSelector, Switch, Tabs, TabsList, TabsTrigger, TabsContent, Select, SelectContent, SelectTrigger, SelectValue, SelectItem, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/components'
import { formatCurrency, cn } from '@/lib/utils'
import { platformService } from '@/services/platformService'
import { useDemoTutorial } from '@/demo'

export default function Storages() {
    const { t } = useTranslation()
    const { user } = useAuth()
    const { activeWorkspace } = useWorkspace()
    const storages = useStorages(activeWorkspace?.id)
    const { toast } = useToast()
    const demoTutorial = useDemoTutorial()
    const [searchQuery, setSearchQuery] = useState('')
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [editingStorage, setEditingStorage] = useState<Storage | undefined>(undefined)
    const [deletingStorage, setDeletingStorage] = useState<Storage | undefined>(undefined)
    const [storageWithStock, setStorageWithStock] = useState<Storage | undefined>(undefined)
    const [storageName, setStorageName] = useState('')
    const [, navigate] = useLocation()

    const filteredStorages = storages.filter(s =>
        s.name.toLowerCase().includes(searchQuery.toLowerCase())
    )

    const products = useProducts(activeWorkspace?.id, { syncBarcodeCache: false })
    const inventory = useInventory(activeWorkspace?.id)
    const categories = useCategories(activeWorkspace?.id)
    const workspaceUsers = useWorkspaceUsers(activeWorkspace?.id)
    const storageExclusionsState = useStorageMemberExclusionsState(activeWorkspace?.id)
    const storageMemberExclusions = storageExclusionsState.rows
    const { features } = useWorkspace()
    const productById = useMemo(
        () => new Map(products.map((product) => [product.id, product] as const)),
        [products]
    )
    const categoryById = useMemo(
        () => new Map(categories.map((category) => [category.id, category] as const)),
        [categories]
    )

    const [selectedStorageId, setSelectedStorageId] = useState<string>(() => {
        return localStorage.getItem('storages_inventory_selected_storage') || ''
    })
    const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all')
    const [inventorySearch, setInventorySearch] = useState('')
    const [marketplaceStoragePendingId, setMarketplaceStoragePendingId] = useState<string | null>(null)
    const [permissionsStorage, setPermissionsStorage] = useState<Storage | null>(null)
    const [excludedMemberIds, setExcludedMemberIds] = useState<Set<string>>(new Set())
    const [savingStoragePermissions, setSavingStoragePermissions] = useState(false)

    const { exchangeData, eurRates, tryRates } = useExchangeRate()
    const settlementCurrency = (features.default_currency || 'usd') as CurrencyCode
    const isMarketplaceStoreActive = features.visibility === 'public' || features.visibility === 'link_only'
    const canManageMarketplaceStorage = user?.role === 'admin' && isMarketplaceStoreActive
    const showMarketplaceStorageState = isMarketplaceStoreActive
    const nonAdminWorkspaceMembers = useMemo(
        () => workspaceUsers.filter((member) => member.role !== 'admin'),
        [workspaceUsers]
    )

    const openStoragePermissions = useCallback((storage: Storage) => {
        setExcludedMemberIds(new Set(
            storageMemberExclusions
                .filter((exclusion) => exclusion.storageId === storage.id)
                .map((exclusion) => exclusion.userId)
        ))
        setPermissionsStorage(storage)
    }, [storageMemberExclusions])

    const toggleMemberStorageExclusion = useCallback((memberId: string, shouldExclude: boolean) => {
        setExcludedMemberIds((current) => {
            const next = new Set(current)
            if (shouldExclude) {
                next.add(memberId)
            } else {
                next.delete(memberId)
            }
            return next
        })
    }, [])

    const saveStoragePermissions = useCallback(async () => {
        if (!permissionsStorage || !activeWorkspace?.id || user?.role !== 'admin') return

        setSavingStoragePermissions(true)
        try {
            await replaceStorageMemberExclusions(
                activeWorkspace.id,
                permissionsStorage.id,
                Array.from(excludedMemberIds)
            )
            toast({ title: t('storages.permissions.savedTitle'), description: t('storages.permissions.savedDescription') })
            setPermissionsStorage(null)
        } catch (error) {
            console.error('[Storage permissions] Failed to save:', error)
            toast({
                title: t('storages.permissions.saveErrorTitle'),
                description: t('storages.permissions.saveErrorDescription'),
                variant: 'destructive'
            })
        } finally {
            setSavingStoragePermissions(false)
        }
    }, [activeWorkspace?.id, excludedMemberIds, permissionsStorage, t, toast, user?.role])

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
        if (!selectedStorageId) return {} as Record<string, number>
        const byCurrency: Record<string, number> = {}
        inventory.forEach((row) => {
            if (row.storageId !== selectedStorageId) return
            const product = productById.get(row.productId)
            if (!product || product.isDeleted) return
            if (selectedCategoryId !== 'all' && product.categoryId !== selectedCategoryId) return
            byCurrency[product.currency] = (byCurrency[product.currency] || 0) + (product.price * row.quantity)
        })
        return byCurrency
    }, [inventory, productById, selectedStorageId, selectedCategoryId])

    const totalCostValue = useMemo(() => {
        if (!selectedStorageId) return {} as Record<string, number>
        const byCurrency: Record<string, number> = {}
        inventory.forEach((row) => {
            if (row.storageId !== selectedStorageId) return
            const product = productById.get(row.productId)
            if (!product || product.isDeleted) return
            if (selectedCategoryId !== 'all' && product.categoryId !== selectedCategoryId) return
            byCurrency[product.currency] = (byCurrency[product.currency] || 0) + ((product.costPrice ?? 0) * row.quantity)
        })
        return byCurrency
    }, [inventory, productById, selectedStorageId, selectedCategoryId])

    const totalStorageValueConverted = useMemo(() => {
        if (!selectedStorageId) return 0
        return inventory.reduce((sum, row) => {
            if (row.storageId !== selectedStorageId) return sum
            const product = productById.get(row.productId)
            if (!product || product.isDeleted) return sum
            if (selectedCategoryId !== 'all' && product.categoryId !== selectedCategoryId) return sum
            return sum + (convertPrice(product.price, product.currency, settlementCurrency) * row.quantity)
        }, 0)
    }, [inventory, productById, selectedStorageId, selectedCategoryId, convertPrice, settlementCurrency])

    const totalCostValueConverted = useMemo(() => {
        if (!selectedStorageId) return 0
        return inventory.reduce((sum, row) => {
            if (row.storageId !== selectedStorageId) return sum
            const product = productById.get(row.productId)
            if (!product || product.isDeleted) return sum
            if (selectedCategoryId !== 'all' && product.categoryId !== selectedCategoryId) return sum
            return sum + (convertPrice(product.costPrice ?? 0, product.currency, settlementCurrency) * row.quantity)
        }, 0)
    }, [inventory, productById, selectedStorageId, selectedCategoryId, convertPrice, settlementCurrency])

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
            const product = productById.get(row.productId)
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
        [inventory, inventorySearch, productById, selectedCategoryId, selectedStorageId])

    const totalQuantityByUnit = useMemo(() => {
        const byUnit: Record<string, number> = {}
        inventoryProducts.forEach(({ row, product }) => {
            const unit = product.unit
            byUnit[unit] = (byUnit[unit] || 0) + row.quantity
        })
        return byUnit
    }, [inventoryProducts])

    const getDisplayImageUrl = (url?: string) => {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        return platformService.convertFileSrc(url);
    }

    const handleCreate = async () => {
        if (!activeWorkspace || !storageName.trim()) return
        const createdStorage = await createStorage(activeWorkspace.id, { name: storageName.trim() })
        setStorageName('')
        setIsDialogOpen(false)
        demoTutorial.completeStorageCreated(createdStorage)
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
                    <p className="text-muted-foreground">
                        {t('storages.subtitle', 'Manage your storage locations.')} <ModulePageFreshness className="ms-2" />
                    </p>
                </div>
                {(user?.role === 'admin' || user?.role === 'staff') && (
                    <Button onClick={openCreateDialog} className="rounded-xl shadow-lg transition-all active:scale-95" data-tour-id="tutorial-storage-new-button">
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
                            <Table data-tour-id="tutorial-storage-list">
                                <TableHeader className="bg-muted/20">
                                    <TableRow className="hover:bg-transparent border-b">
                                        <TableHead className="font-bold py-4 pl-6 text-primary/80">{t('storages.table.name', 'Name')}</TableHead>
                                        <TableHead className="font-bold">{t('storages.table.type', 'Type')}</TableHead>
                                        <TableHead className="font-bold">{t('storages.table.stock', 'Stock')}</TableHead>
                                        <TableHead className="text-right font-bold pr-6">{t('storages.table.actions', 'Actions')}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filteredStorages.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={4} className="h-48 text-center bg-muted/5">
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
                                                <TableCell>
                                                    {(() => {
                                                        const storageInventory = inventory
                                                            .filter((item) => item.storageId === storage.id)
                                                            .sort((a, b) => b.quantity - a.quantity)
                                                        const totalStock = storageInventory.reduce((sum, item) => sum + item.quantity, 0)
                                                        const MAX_VISIBLE = 10
                                                        const visible = storageInventory.slice(0, MAX_VISIBLE)
                                                        const remaining = storageInventory.length - MAX_VISIBLE
                                                        return totalStock > 0 ? (
                                                            <TooltipProvider delayDuration={300}>
                                                                <Tooltip>
                                                                    <TooltipTrigger asChild>
                                                                        <span className="font-semibold text-sm tabular-nums underline decoration-dotted underline-offset-4 cursor-help">
                                                                            {totalStock}
                                                                        </span>
                                                                    </TooltipTrigger>
                                                                    <TooltipContent side="bottom" align="start" className="max-h-60 overflow-y-auto p-2 space-y-1">
                                                                        {visible.map((item) => {
                                                                            const product = productById.get(item.productId)
                                                                            return (
                                                                                <div key={item.productId} className="flex items-center justify-between gap-4 text-xs">
                                                                                    <span className="font-medium truncate max-w-[180px]">
                                                                                        {product?.name || item.productId}
                                                                                    </span>
                                                                                    <span className="tabular-nums font-semibold text-muted-foreground">
                                                                                        {item.quantity}
                                                                                    </span>
                                                                                </div>
                                                                            )
                                                                        })}
                                                                        {remaining > 0 && (
                                                                            <div className="text-xs text-muted-foreground/60 pt-1 border-t border-border/40">
                                                                                *{remaining} {t('common.more', 'More')}
                                                                            </div>
                                                                        )}
                                                                    </TooltipContent>
                                                                </Tooltip>
                                                            </TooltipProvider>
                                                        ) : (
                                                            <span className="font-semibold text-sm tabular-nums text-muted-foreground">0</span>
                                                        )
                                                    })()}
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
                                                            {user?.role === 'admin' && (
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    disabled={!storageExclusionsState.isReady}
                                                                    className="h-8 w-8 rounded-xl hover:bg-primary/10 hover:text-primary transition-all"
                                                                    onClick={() => openStoragePermissions(storage)}
                                                                    aria-label={t('storages.permissions.manageAria', { storage: getStorageDisplayName(storage) })}
                                                                >
                                                                    <KeyRound className="h-4 w-4" />
                                                                </Button>
                                                            )}
                                                            {!storage.isSystem && (
                                                                <>
                                                                    {(user?.role === 'admin' || user?.role === 'staff') && (
                                                                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl hover:bg-primary/10 hover:text-primary transition-all" onClick={() => openEditDialog(storage)}>
                                                                            <Edit className="h-4 w-4" />
                                                                        </Button>
                                                                    )}
                                                                    {user?.role === 'admin' && (
                                                                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-xl hover:bg-destructive/10 hover:text-destructive transition-all" onClick={() => {
                                                                            const hasStock = inventory.some((item) => item.storageId === storage.id && item.quantity > 0)
                                                                            if (hasStock) {
                                                                                setStorageWithStock(storage)
                                                                            } else {
                                                                                setDeletingStorage(storage)
                                                                            }
                                                                        }}>
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

                                    <TooltipProvider delayDuration={300}>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <div className="px-5 py-2.5 rounded-2xl bg-sky-500/10 border border-sky-500/20 border-solid cursor-help">
                                                    <div className="text-[10px] font-black uppercase tracking-widest text-sky-600/70 mb-0.5">
                                                        {t('storages.totalQuantity', 'Total Quantity')}
                                                    </div>
                                                    {Object.keys(totalQuantityByUnit).length === 1 ? (
                                                        <div className="text-xl font-black text-sky-600 leading-none">
                                                            {Object.entries(totalQuantityByUnit).map(([unit, value]) => (
                                                                <span key={unit}>
                                                                    {value} {t(`products.units.${unit}`, unit)}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    ) : (
                                                        <div className="text-xl font-black text-sky-600 leading-none">
                                                            {t('storages.mixedQuantity', 'Mixed')}
                                                        </div>
                                                    )}
                                                </div>
                                            </TooltipTrigger>
                                            {Object.keys(totalQuantityByUnit).length > 1 && (
                                                <TooltipContent side="bottom" align="start" className="p-3 space-y-1">
                                                    {Object.entries(totalQuantityByUnit).map(([unit, value]) => (
                                                        <div key={unit} className="flex items-center justify-between gap-6 text-sm">
                                                            <span className="font-medium text-muted-foreground">
                                                                {t(`products.units.${unit}`, unit)}
                                                            </span>
                                                            <span className="font-black tabular-nums">
                                                                {value}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </TooltipContent>
                                            )}
                                        </Tooltip>
                                    </TooltipProvider>

                                    <TooltipProvider delayDuration={300}>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <div className="px-5 py-2.5 rounded-2xl bg-primary/10 border border-primary/20 border-solid cursor-help">
                                                    <div className="text-[10px] font-black uppercase tracking-widest text-primary/70 mb-0.5">
                                                        {t('storages.totalValue', 'Storage Value')}
                                                    </div>
                                                    <div className="space-y-1">
                                                        {Object.entries(totalStorageValue).map(([curr, value]) => (
                                                            <div key={curr} className="text-xl font-black text-primary leading-none">
                                                                {formatCurrency(value, curr as any, features.iqd_display_preference)}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            </TooltipTrigger>
                                            <TooltipContent side="bottom" align="start" className="p-3 space-y-1">
                                                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                                                    {t('common.totalIn', 'Total in')} {settlementCurrency.toUpperCase()}
                                                </div>
                                                <div className="text-base font-black">
                                                    {formatCurrency(totalStorageValueConverted, settlementCurrency, features.iqd_display_preference)}
                                                </div>
                                            </TooltipContent>
                                        </Tooltip>
                                    </TooltipProvider>

                                    <TooltipProvider delayDuration={300}>
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <div className="px-5 py-2.5 rounded-2xl bg-orange-500/10 border border-orange-500/20 border-solid cursor-help">
                                                    <div className="text-[10px] font-black uppercase tracking-widest text-orange-600/70 mb-0.5">
                                                        {t('storages.totalCostValue', 'Storage Cost Value')}
                                                    </div>
                                                    <div className="space-y-1">
                                                        {Object.entries(totalCostValue).map(([curr, value]) => (
                                                            <div key={curr} className="text-xl font-black text-orange-600 leading-none">
                                                                {formatCurrency(value, curr as any, features.iqd_display_preference)}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            </TooltipTrigger>
                                            <TooltipContent side="bottom" align="start" className="p-3 space-y-1">
                                                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                                                    {t('common.totalIn', 'Total in')} {settlementCurrency.toUpperCase()}
                                                </div>
                                                <div className="text-base font-black">
                                                    {formatCurrency(totalCostValueConverted, settlementCurrency, features.iqd_display_preference)}
                                                </div>
                                            </TooltipContent>
                                        </Tooltip>
                                    </TooltipProvider>
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
                                                    {categoryById.get(product.categoryId || '')?.name || t('categories.noCategory')}
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
                                data-tour-id="tutorial-storage-name-input"
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
                        <Button onClick={editingStorage ? handleUpdate : handleCreate} className="rounded-xl" data-tour-id="tutorial-storage-save-button">
                            {editingStorage ? t('common.save', 'Save') : t('common.create', 'Create')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!storageWithStock} onOpenChange={() => setStorageWithStock(undefined)}>
                <DialogContent
                    className="max-w-md rounded-2xl [&>button.absolute]:hidden"
                    onInteractOutside={(e) => e.preventDefault()}
                >
                    <DialogHeader>
                        <div className="mx-auto mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
                            <Warehouse className="h-7 w-7 text-amber-600 dark:text-amber-400" />
                        </div>
                        <DialogTitle className="text-center text-xl">
                            {t('storages.hasStock.title') || 'Storage Has Stock'}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                        {t('storages.hasStock.description') || 'This storage contains products with stock. Transfer the stock to another storage before deleting.'}
                    </div>
                    <DialogFooter className="gap-2">
                        <Button variant="outline" onClick={() => setStorageWithStock(undefined)}>
                            {t('common.goBack') || 'Go Back'}
                        </Button>
                        <Button onClick={() => navigate('/inventory-transfer')}>
                            <ArrowRight className="mr-2 h-4 w-4" />
                            {t('storages.hasStock.goToTransfer') || 'Inventory Transfer'}
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

            <AppDialog
                open={!!permissionsStorage}
                onOpenChange={(open) => {
                    if (!open && !savingStoragePermissions) {
                        setPermissionsStorage(null)
                    }
                }}
            >
                <AppDialogContent
                    className="max-w-xl"
                    showCloseButton={!savingStoragePermissions}
                    onEscapeKeyDown={(event) => {
                        if (savingStoragePermissions) event.preventDefault()
                    }}
                    onInteractOutside={(event) => {
                        if (savingStoragePermissions) event.preventDefault()
                    }}
                >
                    <AppDialogHeader>
                        <AppDialogTitle className="flex items-center gap-2">
                            <KeyRound className="h-5 w-5 text-primary" />
                            {t('storages.permissions.title')}
                        </AppDialogTitle>
                        <p className="text-sm text-muted-foreground">
                            {t('storages.permissions.description', { storage: permissionsStorage ? getStorageDisplayName(permissionsStorage) : '' })}
                        </p>
                    </AppDialogHeader>
                    <AppDialogBody className="space-y-4">
                        <div className="rounded-xl border border-primary/15 bg-primary/5 p-3 text-sm text-muted-foreground">
                            {t('storages.permissions.defaultAccessHint')}
                        </div>
                        {nonAdminWorkspaceMembers.length === 0 ? (
                            <div className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center text-muted-foreground">
                                <UsersRound className="h-8 w-8 opacity-40" />
                                <p className="text-sm">{t('storages.permissions.noEligibleMembers')}</p>
                            </div>
                        ) : (
                            <div className="overflow-hidden rounded-xl border divide-y">
                                {nonAdminWorkspaceMembers.map((member) => {
                                    const isExcluded = excludedMemberIds.has(member.id)
                                    return (
                                        <div key={member.id} className="flex items-center gap-3 px-4 py-3">
                                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                                <UsersRound className="h-4 w-4" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium">{member.name || member.email}</p>
                                                <p className="text-xs text-muted-foreground">{t(`auth.roles.${member.role}`)}</p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-muted-foreground">
                                                    {isExcluded ? t('storages.permissions.excluded') : t('storages.permissions.allowed')}
                                                </span>
                                                <Switch
                                                    checked={isExcluded}
                                                    disabled={savingStoragePermissions}
                                                    onCheckedChange={(checked) => toggleMemberStorageExclusion(member.id, checked)}
                                                    aria-label={t('storages.permissions.memberToggleAria', { member: member.name || member.email })}
                                                />
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </AppDialogBody>
                    <AppDialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={savingStoragePermissions}
                            onClick={() => setPermissionsStorage(null)}
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button
                            type="button"
                            disabled={savingStoragePermissions || !storageExclusionsState.isReady}
                            onClick={() => void saveStoragePermissions()}
                        >
                            {savingStoragePermissions ? t('common.saving') : t('common.save')}
                        </Button>
                    </AppDialogFooter>
                </AppDialogContent>
            </AppDialog>
        </div>
    )
}
