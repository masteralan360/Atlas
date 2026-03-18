import { useState, useMemo } from 'react'
import { useStorages } from '@/local-db'
import { db } from '@/local-db'
import { supabase } from '@/auth/supabase'
import { useWorkspace } from '@/workspace'
import { Button } from '@/ui/components/button'
import { ArrowRightLeft, Check, Warehouse, Package, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/ui/components/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/components/select'
import { Label } from '@/ui/components/label'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/ui/components/use-toast'
import { useLiveQuery } from 'dexie-react-hooks'
import { isOnline } from '@/lib/network'
import { Checkbox } from '@/ui/components'

export default function InventoryTransfer() {
    const { t } = useTranslation()
    const { activeWorkspace, isLocalMode } = useWorkspace()
    const storages = useStorages(activeWorkspace?.id)
    const { toast } = useToast()

    const [sourceStorageId, setSourceStorageId] = useState<string>('')
    const [targetStorageId, setTargetStorageId] = useState<string>('')
    const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set())
    const [isTransferring, setIsTransferring] = useState(false)

    // Get products in source storage
    const sourceProducts = useLiveQuery(
        () => sourceStorageId
            ? db.products.where('storageId').equals(sourceStorageId).and(p => !p.isDeleted).toArray()
            : [],
        [sourceStorageId]
    ) ?? []

    const availableTargetStorages = useMemo(
        () => storages.filter(s => s.id !== sourceStorageId),
        [storages, sourceStorageId]
    )

    const toggleProduct = (productId: string) => {
        setSelectedProductIds(prev => {
            const next = new Set(prev)
            if (next.has(productId)) {
                next.delete(productId)
            } else {
                next.add(productId)
            }
            return next
        })
    }

    const selectAllProducts = () => {
        if (selectedProductIds.size === sourceProducts.length) {
            setSelectedProductIds(new Set())
        } else {
            setSelectedProductIds(new Set(sourceProducts.map(p => p.id)))
        }
    }

    const handleTransfer = async () => {
        if (!targetStorageId || selectedProductIds.size === 0) return

        setIsTransferring(true)
        const now = new Date().toISOString()
        let successCount = 0

        try {
            for (const productId of selectedProductIds) {
                await db.products.update(productId, {
                    storageId: targetStorageId,
                    updatedAt: now,
                    syncStatus: 'pending'
                })

                if (!isLocalMode && isOnline(activeWorkspace?.id)) {
                    const { error } = await supabase
                        .from('products')
                        .update({ storage_id: targetStorageId, updated_at: now })
                        .eq('id', productId)

                    if (!error) {
                        await db.products.update(productId, { syncStatus: 'synced', lastSyncedAt: now })
                    }
                }
                successCount++
            }

            const targetStorage = storages.find(s => s.id === targetStorageId)
            const storageDisplayName = targetStorage?.isSystem
                ? (t(`storages.${targetStorage.name.toLowerCase()}`) || targetStorage.name)
                : targetStorage?.name || '';

            toast({
                title: t('inventoryTransfer.success', 'Transfer Complete'),
                description: t('inventoryTransfer.successMessage', '{{count}} products moved to {{storage}}', {
                    count: successCount,
                    storage: storageDisplayName
                })
            })

            // Reset state
            setSelectedProductIds(new Set())
            setTargetStorageId('')
        } catch (error) {
            toast({
                title: t('common.error', 'Error'),
                description: t('inventoryTransfer.error', 'Failed to transfer products'),
                variant: 'destructive'
            })
        } finally {
            setIsTransferring(false)
        }
    }

    const sourceStorage = storages.find(s => s.id === sourceStorageId)
    const targetStorage = storages.find(s => s.id === targetStorageId)

    const sourceDisplayName = sourceStorage?.isSystem
        ? (t(`storages.${sourceStorage.name.toLowerCase()}`) || sourceStorage.name)
        : sourceStorage?.name;
    const targetDisplayName = targetStorage?.isSystem
        ? (t(`storages.${targetStorage.name.toLowerCase()}`) || targetStorage.name)
        : targetStorage?.name;

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-2">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <ArrowRightLeft className="w-6 h-6 text-primary" />
                    {t('inventoryTransfer.title', 'Inventory Transfer')}
                </h1>
                <p className="text-muted-foreground">
                    {t('inventoryTransfer.subtitle', 'Move products between storage locations.')}
                </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Step 1: Select Source */}
                <Card className="rounded-2xl border-2 shadow-sm">
                    <CardHeader className="bg-muted/30 border-b p-4">
                        <CardTitle className="text-base font-bold flex items-center gap-2">
                            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold">1</span>
                            {t('inventoryTransfer.selectSource', 'Select Source')}
                        </CardTitle>
                        <CardDescription>{t('inventoryTransfer.sourceDescription', 'Choose storage to transfer from')}</CardDescription>
                    </CardHeader>
                    <CardContent className="p-4 space-y-4">
                        <Select value={sourceStorageId} onValueChange={id => { setSourceStorageId(id); setSelectedProductIds(new Set()) }}>
                            <SelectTrigger className="rounded-xl">
                                <SelectValue placeholder={t('inventoryTransfer.selectStorage', 'Select storage...')} />
                            </SelectTrigger>
                            <SelectContent>
                                {storages.map(s => (
                                    <SelectItem key={s.id} value={s.id}>
                                        <div className="flex items-center gap-2">
                                            <Warehouse className="w-4 h-4" />
                                            {s.isSystem ? (t(`storages.${s.name.toLowerCase()}`) || s.name) : s.name}
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        {sourceStorageId && (
                            <div className="text-sm text-muted-foreground">
                                {sourceProducts.length} {t('inventoryTransfer.productsAvailable', 'products available')}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Step 2: Select Products */}
                <Card className="rounded-2xl border-2 shadow-sm">
                    <CardHeader className="bg-muted/30 border-b p-4">
                        <CardTitle className="text-base font-bold flex items-center gap-2">
                            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold">2</span>
                            {t('inventoryTransfer.selectProducts', 'Select Products')}
                        </CardTitle>
                        <CardDescription>{t('inventoryTransfer.productsDescription', 'Choose products to transfer')}</CardDescription>
                    </CardHeader>
                    <CardContent className="p-4">
                        {!sourceStorageId ? (
                            <div className="text-center text-muted-foreground py-8">
                                <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
                                <p className="text-sm">{t('inventoryTransfer.selectSourceFirst', 'Select a source storage first')}</p>
                            </div>
                        ) : sourceProducts.length === 0 ? (
                            <div className="text-center text-muted-foreground py-8">
                                <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
                                <p className="text-sm">{t('inventoryTransfer.noProducts', 'No products in this storage')}</p>
                            </div>
                        ) : (
                            <div className="space-y-2 max-h-64 overflow-y-auto">
                                <div className="flex items-center gap-2 pb-2 border-b">
                                    <Checkbox
                                        id="select-all"
                                        checked={selectedProductIds.size === sourceProducts.length}
                                        onCheckedChange={selectAllProducts}
                                    />
                                    <Label htmlFor="select-all" className="text-sm font-medium cursor-pointer">
                                        {t('common.selectAll', 'Select All')} ({sourceProducts.length})
                                    </Label>
                                </div>
                                {sourceProducts.map(product => (
                                    <div key={product.id} className="flex items-center gap-2 p-2 hover:bg-muted/30 rounded-lg transition-colors">
                                        <Checkbox
                                            id={product.id}
                                            checked={selectedProductIds.has(product.id)}
                                            onCheckedChange={() => toggleProduct(product.id)}
                                        />
                                        <Label htmlFor={product.id} className="flex-1 cursor-pointer">
                                            <div className="flex items-center justify-between">
                                                <span className="text-sm font-medium">{product.name}</span>
                                                <span className="text-xs text-muted-foreground">
                                                    {product.quantity} {product.unit}
                                                </span>
                                            </div>
                                            <div className="text-xs text-muted-foreground">{product.sku}</div>
                                        </Label>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Step 3: Select Destination */}
                <Card className="rounded-2xl border-2 shadow-sm">
                    <CardHeader className="bg-muted/30 border-b p-4">
                        <CardTitle className="text-base font-bold flex items-center gap-2">
                            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold">3</span>
                            {t('inventoryTransfer.selectDestination', 'Select Destination')}
                        </CardTitle>
                        <CardDescription>{t('inventoryTransfer.destinationDescription', 'Choose target storage')}</CardDescription>
                    </CardHeader>
                    <CardContent className="p-4 space-y-4">
                        <Select value={targetStorageId} onValueChange={setTargetStorageId} disabled={!sourceStorageId}>
                            <SelectTrigger className="rounded-xl">
                                <SelectValue placeholder={t('inventoryTransfer.selectStorage', 'Select storage...')} />
                            </SelectTrigger>
                            <SelectContent>
                                {availableTargetStorages.map(s => (
                                    <SelectItem key={s.id} value={s.id}>
                                        <div className="flex items-center gap-2">
                                            <Warehouse className="w-4 h-4" />
                                            {s.isSystem ? (t(`storages.${s.name.toLowerCase()}`) || s.name) : s.name}
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        {selectedProductIds.size > 0 && targetStorageId && (
                            <div className="p-3 bg-primary/5 rounded-xl border border-primary/20">
                                <div className="flex items-center gap-2 text-sm">
                                    <span className="font-medium">{sourceDisplayName}</span>
                                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                    <span className="font-medium">{targetDisplayName}</span>
                                </div>
                                <div className="text-xs text-muted-foreground mt-1">
                                    {selectedProductIds.size} {t('inventoryTransfer.productsSelected', 'products selected')}
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* Transfer Button */}
            <div className="flex justify-end">
                <Button
                    onClick={handleTransfer}
                    disabled={!sourceStorageId || !targetStorageId || selectedProductIds.size === 0 || isTransferring}
                    className="rounded-xl shadow-lg px-8 gap-2"
                    size="lg"
                >
                    {isTransferring ? (
                        <>
                            <ArrowRightLeft className="w-5 h-5 animate-spin" />
                            {t('inventoryTransfer.transferring', 'Transferring...')}
                        </>
                    ) : (
                        <>
                            <Check className="w-5 h-5" />
                            {t('inventoryTransfer.confirmTransfer', 'Confirm Transfer')}
                        </>
                    )}
                </Button>
            </div>
        </div>
    )
}
