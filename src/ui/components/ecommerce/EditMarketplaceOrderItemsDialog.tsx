import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Minus, PackageSearch, Plus, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useOptionalAuth } from '@/auth'
import { cn, formatCurrency, generateId } from '@/lib/utils'
import { getProductImageDisplayUrl } from '@/lib/productImageStorage'
import { getMarketplaceProductImageUrl, type MarketplaceProductImageUrls } from '@/lib/marketplaceProductImages'
import { useStoragesState } from '@/local-db'
import type { Product } from '@/local-db/models'
import { useWorkspace } from '@/workspace/WorkspaceContext'
import { Button } from '@/ui/components/button'
import { ProductAutocompleteInput } from '@/ui/components/orders/ProductAutocompleteInput'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components'

export interface EditableMarketplaceOrderItem {
    product_id: string
    name: string
    sku: string
    unit_price: number
    currency: string
    unit?: string | null
    quantity: number
    line_total: number
    original_unit_price?: number | null
    cost_price?: number | null
    image_url?: string | null
    storage_id?: string | null
    allocation_group_id?: string | null
}

export interface EditableMarketplaceOrder {
    id: string
    currency: string
    items: EditableMarketplaceOrderItem[]
}

interface EditMarketplaceOrderItemsDialogProps {
    isOpen: boolean
    order: EditableMarketplaceOrder
    productImageUrls: MarketplaceProductImageUrls
    isSaving?: boolean
    onOpenChange: (open: boolean) => void
    onSave: (items: EditableMarketplaceOrderItem[]) => Promise<void>
}

type DraftGroup = {
    key: string
    name: string
    sku: string
    productId: string
    currency: string
    lines: EditableMarketplaceOrderItem[]
    quantity: number
    lineTotal: number
}

type ProductPickerRow = {
    id: string
    query: string
    storageId: string
}

function lineKey(line: EditableMarketplaceOrderItem) {
    return `${line.product_id}::${line.storage_id || ''}::${line.allocation_group_id || ''}`
}

function buildDraftGroups(lines: EditableMarketplaceOrderItem[]): DraftGroup[] {
    const groups = new Map<string, DraftGroup>()

    for (const [index, line] of lines.entries()) {
        const key = line.allocation_group_id
            ? `allocation:${line.allocation_group_id}::storage:${line.storage_id || ''}`
            : `line:${index}`
        const existing = groups.get(key)

        if (!existing) {
            groups.set(key, {
                key,
                name: line.name,
                sku: line.sku,
                productId: line.product_id,
                currency: line.currency,
                lines: [{ ...line }],
                quantity: Math.trunc(Number(line.quantity ?? 0)),
                lineTotal: roundLineTotal(line.unit_price, line.quantity)
            })
            continue
        }

        existing.lines.push({ ...line })
        existing.quantity += Math.trunc(Number(line.quantity ?? 0))
        existing.lineTotal = roundAmount(existing.lineTotal + roundLineTotal(line.unit_price, line.quantity))
    }

    return Array.from(groups.values())
}

function roundAmount(value: number) {
    return Math.round(value * 100) / 100
}

function roundLineTotal(unitPrice: number | undefined, quantity: number | undefined) {
    return roundAmount(Number(unitPrice || 0) * Math.trunc(Number(quantity || 0)))
}

function distributeReduction(lines: EditableMarketplaceOrderItem[], targetQuantity: number) {
    const updated = lines.map((line) => ({ ...line }))
    let toRemove = updated.reduce((sum, line) => sum + Math.trunc(Number(line.quantity || 0)), 0) - targetQuantity

    while (toRemove > 0) {
        let maxIndex = -1
        for (let index = 0; index < updated.length; index++) {
            if (updated[index].quantity <= 0) continue
            if (maxIndex === -1 || updated[index].quantity > updated[maxIndex].quantity) {
                maxIndex = index
            }
        }
        if (maxIndex === -1) break
        updated[maxIndex].quantity = Math.max(0, updated[maxIndex].quantity - 1)
        toRemove -= 1
    }

    return updated
}

export function EditMarketplaceOrderItemsDialog({
    isOpen,
    order,
    productImageUrls,
    isSaving = false,
    onOpenChange,
    onSave
}: EditMarketplaceOrderItemsDialogProps) {
    const { t } = useTranslation()
    const { features } = useWorkspace()
    const user = useOptionalAuth()?.user
    const { rows: storages, isReady: isStoragesReady } = useStoragesState(isOpen ? user?.workspaceId : undefined)
    const [draftLines, setDraftLines] = useState<EditableMarketplaceOrderItem[]>([])
    const [productPickerRows, setProductPickerRows] = useState<ProductPickerRow[]>([])
    const [selectedProductImages, setSelectedProductImages] = useState<Map<string, string | null>>(() => new Map())
    const [isSubmitting, setIsSubmitting] = useState(false)
    const saveInProgressRef = useRef(false)
    const isBusy = isSaving || isSubmitting
    const orderStorageId = order.items.find((line) => line.storage_id)?.storage_id || undefined

    useEffect(() => {
        if (!isOpen) return
        setDraftLines(order.items.map((line) => ({ ...line })))
        setProductPickerRows([])
        setSelectedProductImages(new Map())
    }, [isOpen, order])

    const displayProductImageUrls = useMemo(
        () => new Map([...productImageUrls, ...selectedProductImages]),
        [productImageUrls, selectedProductImages]
    )
    const isProductSelectable = useCallback((product: Product) => (
        !product.isService
        && product.currency.toLowerCase() === order.currency.toLowerCase()
    ), [order.currency])
    const isStorageAvailable = useCallback((storageId: string | null | undefined) => (
        Boolean(storageId && isStoragesReady && storages.some((storage) => storage.id === storageId))
    ), [isStoragesReady, storages])

    const groups = useMemo(() => buildDraftGroups(draftLines), [draftLines])
    const subtotal = useMemo(
        () => groups.reduce((sum, group) => sum + group.lineTotal, 0),
        [groups]
    )
    const isDirty = useMemo(() => {
        const expectedQuantities = new Map<string, number>()
        for (const line of order.items) {
            const key = lineKey(line)
            expectedQuantities.set(key, (expectedQuantities.get(key) || 0) + Math.trunc(Number(line.quantity || 0)))
        }
        for (const line of draftLines) {
            const key = lineKey(line)
            expectedQuantities.set(key, (expectedQuantities.get(key) || 0) - Math.trunc(Number(line.quantity || 0)))
        }
        return Array.from(expectedQuantities.values()).some((quantity) => quantity !== 0)
    }, [order.items, draftLines])
    const hasUnavailableAddedStorage = useMemo(() => {
        const originalLineKeys = new Set(order.items.map(lineKey))
        return isStoragesReady && draftLines.some((line) => (
            !originalLineKeys.has(lineKey(line)) && !isStorageAvailable(line.storage_id)
        ))
    }, [draftLines, isStorageAvailable, isStoragesReady, order.items])

    function removeGroup(groupKey: string) {
        setDraftLines((current) => {
            const group = buildDraftGroups(current).find((entry) => entry.key === groupKey)
            if (!group) return current
            const removedKeys = new Set(group.lines.map((line) => lineKey(line)))
            return current.filter((line) => !removedKeys.has(lineKey(line)))
        })
    }

    function decreaseGroup(groupKey: string) {
        setDraftLines((current) => {
            const group = buildDraftGroups(current).find((entry) => entry.key === groupKey)
            if (!group) return current
            const nextQuantity = group.quantity - 1

            if (nextQuantity <= 0) {
                const removedKeys = new Set(group.lines.map((line) => lineKey(line)))
                return current.filter((line) => !removedKeys.has(lineKey(line)))
            }

            const updated = distributeReduction(group.lines, nextQuantity)
            const updatedLines = new Map(updated.map((line) => [lineKey(line), line]))
            const groupKeys = new Set(group.lines.map((line) => lineKey(line)))
            return current
                .filter((line) => {
                    const key = lineKey(line)
                    return !groupKeys.has(key) || (updatedLines.get(key)?.quantity ?? 0) > 0
                })
                .map((line) => updatedLines.get(lineKey(line)) || line)
        })
    }

    function increaseGroup(groupKey: string) {
        setDraftLines((current) => {
            const group = buildDraftGroups(current).find((entry) => entry.key === groupKey)
            const lineToIncrease = group?.lines[0]
            if (!lineToIncrease) return current

            const targetIndex = group.key.startsWith('line:')
                ? Number(group.key.slice('line:'.length))
                : current.findIndex((line) => lineKey(line) === lineKey(lineToIncrease))
            return current.map((line, index) => index === targetIndex
                ? { ...line, quantity: Math.trunc(Number(line.quantity || 0)) + 1 }
                : line
            )
        })
    }

    function handleSelectProduct(pickerId: string, product: Product, storageId: string) {
        if (!isProductSelectable(product) || !isStorageAvailable(storageId)) return

        setSelectedProductImages((current) => new Map(current).set(product.id, product.imageUrl || null))
        setDraftLines((current) => {
            const existingGroup = buildDraftGroups(current).find((group) => (
                group.productId === product.id
                && group.lines.some((line) => line.storage_id === storageId)
            ))
            if (existingGroup) {
                const lineToIncrease = existingGroup.lines[0]
                const targetIndex = existingGroup.key.startsWith('line:')
                    ? Number(existingGroup.key.slice('line:'.length))
                    : current.findIndex((line) => lineKey(line) === lineKey(lineToIncrease))
                return current.map((line, index) => index === targetIndex
                    ? { ...line, quantity: Math.trunc(Number(line.quantity || 0)) + 1 }
                    : line
                )
            }

            const unitPrice = roundAmount(Number(product.price || 0))
            return [...current, {
                product_id: product.id,
                name: product.name,
                sku: product.sku || '',
                unit_price: unitPrice,
                original_unit_price: unitPrice,
                cost_price: product.costPrice,
                currency: product.currency.toLowerCase(),
                unit: product.unit || null,
                quantity: 1,
                line_total: unitPrice,
                image_url: product.imageUrl || null,
                storage_id: storageId,
                allocation_group_id: product.id
            }]
        })
        setProductPickerRows((current) => current.filter((row) => row.id !== pickerId))
    }

    async function handleSave() {
        if (isBusy || saveInProgressRef.current || productPickerRows.length > 0 || groups.length === 0 || !isDirty) return

        saveInProgressRef.current = true
        setIsSubmitting(true)
        const items = groups.flatMap((group) => group.lines).map((line) => ({
            ...line,
            line_total: roundLineTotal(line.unit_price, line.quantity)
        }))
        try {
            await onSave(items)
            onOpenChange(false)
        } catch {
            // The caller surfaces the error toast and keeps the dialog open.
        } finally {
            saveInProgressRef.current = false
            setIsSubmitting(false)
        }
    }

    function handleOpenChange(open: boolean) {
        if (!open && (isBusy || saveInProgressRef.current)) return
        onOpenChange(open)
    }

    return (
        <Dialog open={isOpen} onOpenChange={handleOpenChange}>
            <DialogContent layout="structured" className="sm:max-w-3xl">
                <DialogHeader layout="structured">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:pr-12">
                        <div className="min-w-0 flex-1">
                            <DialogTitle>{t('ecommerce.editItems', { defaultValue: 'Edit Order Items' })}</DialogTitle>
                            <DialogDescription>
                                {t('ecommerce.editItemsHint', {
                                    defaultValue: 'Quantities can be increased or reduced, items added, or items removed before the order is shipped.'
                                })}
                            </DialogDescription>
                        </div>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-9 shrink-0 self-start"
                            disabled={isBusy}
                            onClick={() => setProductPickerRows((current) => [...current, {
                                id: generateId(),
                                query: '',
                                storageId: orderStorageId || (storages.length === 1 ? storages[0].id : '')
                            }])}
                        >
                            <Plus className="h-4 w-4" />
                            {t('ecommerce.addItem', { defaultValue: 'Add item' })}
                        </Button>
                    </div>
                </DialogHeader>

                <DialogBody className="space-y-3">
                    {productPickerRows.map((row) => (
                        <div key={row.id} className="flex items-start gap-3 rounded-2xl border border-dashed border-primary/30 bg-primary/5 p-3">
                            <div className="mt-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/40">
                                <PackageSearch className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                            </div>
                            <div className="min-w-0 flex-1 space-y-3">
                                <div className="text-sm font-semibold">
                                    {t('ecommerce.selectProductToAdd', { defaultValue: 'Select a product to add' })}
                                </div>
                                <div className="grid gap-3 lg:grid-cols-[minmax(10.5rem,0.8fr)_minmax(18rem,1.2fr)]">
                                    <div className="min-w-0 space-y-1.5">
                                        <Label htmlFor={`ecommerce-add-item-storage-${row.id}`}>
                                            {t('orders.form.selectStorage', { defaultValue: 'Select Storage' })}{' '}
                                            <span className="text-destructive">*</span>
                                        </Label>
                                        <Select
                                            value={row.storageId}
                                            onValueChange={(storageId) => setProductPickerRows((current) => current.map((entry) => (
                                                entry.id === row.id ? { ...entry, storageId, query: '' } : entry
                                            )))}
                                            disabled={isBusy || !isStoragesReady || storages.length === 0}
                                        >
                                            <SelectTrigger id={`ecommerce-add-item-storage-${row.id}`} className="w-full">
                                                <SelectValue placeholder={!isStoragesReady
                                                    ? t('common.loading', { defaultValue: 'Loading...' })
                                                    : t('orders.form.selectStorage', { defaultValue: 'Select Storage' })} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {row.storageId && (!isStoragesReady || !storages.some((storage) => storage.id === row.storageId)) && (
                                                    <SelectItem value={row.storageId} disabled>
                                                        {!isStoragesReady
                                                            ? t('common.loading', { defaultValue: 'Loading...' })
                                                            : `${t('settings.marketplace.catalogRuleUnavailableStorage', { defaultValue: 'Unavailable storage' })} (${row.storageId})`}
                                                    </SelectItem>
                                                )}
                                                {storages.map((storage) => (
                                                    <SelectItem key={storage.id} value={storage.id}>
                                                        {storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="min-w-0 space-y-1.5">
                                        <Label htmlFor={`ecommerce-add-item-product-${row.id}`}>{t('ecommerce.addItemProduct', { defaultValue: 'Product' })}</Label>
                                        <ProductAutocompleteInput
                                            id={`ecommerce-add-item-product-${row.id}`}
                                            value={row.query}
                                            onChange={(query) => setProductPickerRows((current) => current.map((entry) => (
                                                entry.id === row.id ? { ...entry, query } : entry
                                            )))}
                                            onSelectProduct={(product) => handleSelectProduct(row.id, product, row.storageId)}
                                            placeholder={isStorageAvailable(row.storageId)
                                                ? t('ecommerce.addItemSearch', { defaultValue: 'Search products...' })
                                                : t('ecommerce.addItemSelectStorageFirst', { defaultValue: 'Select a storage before searching for products.' })}
                                            disabled={isBusy || !isStorageAvailable(row.storageId)}
                                            hasSelection={false}
                                            allowScrollInModal
                                            storageId={row.storageId || undefined}
                                            storageScopeId={row.storageId || undefined}
                                            isProductAvailable={isProductSelectable}
                                            className="w-full"
                                        />
                                    </div>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {t('ecommerce.addItemHint', {
                                        defaultValue: 'Choose a storage and a product priced in {{currency}}; one unit will be added.',
                                        currency: order.currency.toUpperCase()
                                    })}
                                </p>
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 shrink-0"
                                disabled={isBusy}
                                onClick={() => setProductPickerRows((current) => current.filter((entry) => entry.id !== row.id))}
                                aria-label={t('common.remove', { defaultValue: 'Remove' })}
                                title={t('common.remove', { defaultValue: 'Remove' })}
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                    ))}

                    {productPickerRows.length > 0 && storages.length === 0 && isStoragesReady && (
                        <p className="text-sm text-muted-foreground">
                            {t('settings.marketplace.catalogRuleNoStorages', { defaultValue: 'No available storages were found in this workspace.' })}
                        </p>
                    )}

                    {hasUnavailableAddedStorage && (
                        <p role="alert" className="text-sm text-destructive">
                            {t('ecommerce.addItemStorageUnavailable', {
                                defaultValue: 'An added item’s storage is no longer available. Remove it and add the product again.'
                            })}
                        </p>
                    )}

                    {groups.length === 0 && productPickerRows.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border/60 bg-card/50 p-8 text-center text-muted-foreground">
                            <PackageSearch className="h-8 w-8 opacity-50" />
                            <p className="text-sm">
                                {t('ecommerce.editItemsEmpty', {
                                    defaultValue: 'All items were removed. An order must keep at least one item.'
                                })}
                            </p>
                        </div>
                    ) : groups.map((group) => {
                        const imageUrl = getProductImageDisplayUrl(
                            getMarketplaceProductImageUrl(group.productId, displayProductImageUrls)
                        )

                        return <div key={group.key} className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/60 p-3">
                            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/40">
                                {imageUrl ? (
                                    <img
                                        src={imageUrl}
                                        alt=""
                                        className="h-full w-full object-contain p-1"
                                        loading="lazy"
                                    />
                                ) : (
                                    <PackageSearch className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                                )}
                            </div>

                            <div className="min-w-0 flex-1">
                                <div className="truncate font-semibold">{group.name}</div>
                                <div className="truncate text-sm text-muted-foreground">{group.sku}</div>
                                <div className="text-sm font-semibold">
                                    {formatCurrency(group.lineTotal, group.currency || order.currency, features.iqd_display_preference)}
                                </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-1.5">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    className={cn('h-9 w-9 rounded-xl', group.quantity <= 1 && 'pointer-events-none opacity-40')}
                                    disabled={isBusy || group.quantity <= 1}
                                    onClick={() => decreaseGroup(group.key)}
                                    aria-label={`${t('common.decrease', { defaultValue: 'Decrease' })} ${group.name}`}
                                >
                                    <Minus className="h-4 w-4" />
                                </Button>
                                <span className="min-w-10 text-center font-black">{group.quantity}</span>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    className="h-9 w-9 rounded-xl"
                                    disabled={isBusy}
                                    onClick={() => increaseGroup(group.key)}
                                    aria-label={`${t('common.increase', { defaultValue: 'Increase' })} ${group.name}`}
                                >
                                    <Plus className="h-4 w-4" />
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="icon"
                                    className="h-9 w-9 rounded-xl border-rose-500/30 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-300"
                                    disabled={isBusy}
                                    onClick={() => removeGroup(group.key)}
                                    aria-label={`${t('common.remove', { defaultValue: 'Remove' })} ${group.name}`}
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    })}
                </DialogBody>

                <DialogFooter layout="structured">
                    <span className="text-sm text-muted-foreground">
                        {t('common.total', { defaultValue: 'Total' })}:{' '}
                        <span className="font-black text-foreground">
                            {formatCurrency(subtotal, order.currency, features.iqd_display_preference)}
                        </span>
                    </span>
                    <div className="flex flex-col-reverse gap-2 sm:flex-row">
                        <Button type="button" variant="outline" disabled={isBusy} onClick={() => onOpenChange(false)}>
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button
                            type="button"
                            disabled={isBusy || productPickerRows.length > 0 || hasUnavailableAddedStorage || groups.length === 0 || !isDirty}
                            aria-busy={isBusy}
                            onClick={handleSave}
                        >
                            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                            {isSubmitting
                                ? t('common.saving', { defaultValue: 'Saving...' })
                                : t('common.save', { defaultValue: 'Save' })}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
