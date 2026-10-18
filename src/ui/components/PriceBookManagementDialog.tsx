import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { BookOpen, Check, ChevronDown, CircleOff, Package, Palette, Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
    createPriceBook,
    hardDeletePriceBook,
    updatePriceBook,
    usePriceBookCatalogState,
    useProducts,
    type PriceBook
} from '@/local-db'
import { formatCurrency } from '@/lib/utils'
import { isValidPriceBookColor } from '@/lib/priceBookColor'
import { useHideCosts } from '@/permissions'
import { DeleteConfirmationModal } from '@/ui/components/DeleteConfirmationModal'
import { Input } from '@/ui/components/input'
import {
  AppDialog,
  AppDialogBody,
  AppDialogContent,
  AppDialogDescription,
  AppDialogFooter,
  AppDialogHeader,
  AppDialogTitle,
  Button,
  Checkbox,
  Label,
  useToast,
} from '@/ui/components'
import { PriceBookName } from './PriceBookName'

const PRICE_BOOK_COLOR_SWATCHES = [
    '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#06b6d4',
    '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#64748b'
]

interface PriceBookManagementDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspaceId?: string
    createdBy?: string | null
    enabled: boolean
}

export function PriceBookManagementDialog({
    open,
    onOpenChange,
    workspaceId,
    createdBy,
    enabled
}: PriceBookManagementDialogProps) {
    const { t } = useTranslation()
    const hideCosts = useHideCosts()
    const { toast } = useToast()
    const {
        priceBooks,
        priceBookItems,
        isReady: isCatalogReady,
        error: catalogError
    } = usePriceBookCatalogState(workspaceId, { enabled })
    const products = useProducts(workspaceId, { syncBarcodeCache: false, syncRemote: false, enabled })
    const [name, setName] = useState('')
    const [color, setColor] = useState<string | null>(null)
    const [editingPriceBook, setEditingPriceBook] = useState<PriceBook | null>(null)
    const [priceBookToDelete, setPriceBookToDelete] = useState<PriceBook | null>(null)
    const [expandedPriceBookIds, setExpandedPriceBookIds] = useState<Set<string>>(new Set())
    const [isSaving, setIsSaving] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)

    const sortedPriceBooks = useMemo(
        () => [...priceBooks].sort((left, right) => left.name.localeCompare(right.name)),
        [priceBooks]
    )
    const productById = useMemo(
        () => new Map(products.map((product) => [product.id, product] as const)),
        [products]
    )
    const visiblePriceBookItems = useMemo(
        () => priceBookItems.filter((item) => productById.has(item.productId)),
        [priceBookItems, productById]
    )
    const priceBookItemsByBookId = useMemo(() => {
        const itemsByBookId = new Map<string, typeof visiblePriceBookItems>()
        for (const item of visiblePriceBookItems) {
            const items = itemsByBookId.get(item.priceBookId) ?? []
            items.push(item)
            itemsByBookId.set(item.priceBookId, items)
        }
        for (const items of itemsByBookId.values()) {
            items.sort((left, right) => {
                const leftName = productById.get(left.productId)?.name || left.productId
                const rightName = productById.get(right.productId)?.name || right.productId
                return leftName.localeCompare(rightName)
            })
        }
        return itemsByBookId
    }, [productById, visiblePriceBookItems])

    useEffect(() => {
        if (!open) {
            setName('')
            setColor(null)
            setEditingPriceBook(null)
            setPriceBookToDelete(null)
            setExpandedPriceBookIds(new Set())
            setIsSaving(false)
            setIsDeleting(false)
        }
    }, [open])

    const beginEdit = (priceBook: PriceBook) => {
        if (!isCatalogReady) {
            return
        }
        setEditingPriceBook(priceBook)
        setName(priceBook.name)
        setColor(priceBook.color ?? null)
    }

    const cancelEdit = () => {
        setEditingPriceBook(null)
        setName('')
        setColor(null)
    }

    const togglePriceBookProducts = (priceBookId: string) => {
        setExpandedPriceBookIds((current) => {
            const next = new Set(current)
            if (next.has(priceBookId)) {
                next.delete(priceBookId)
            } else {
                next.add(priceBookId)
            }
            return next
        })
    }

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!workspaceId || !enabled || !isCatalogReady || !name.trim()) {
            return
        }

        setIsSaving(true)
        try {
            if (editingPriceBook) {
                await updatePriceBook(editingPriceBook.id, { name, color })
                toast({
                    title: t('priceBooks.messages.updateSuccess', {
                        defaultValue: 'Price Book updated successfully'
                    })
                })
            } else {
                await createPriceBook(workspaceId, { name, color, createdBy })
                toast({
                    title: t('priceBooks.messages.createSuccess', {
                        defaultValue: 'Price Book created successfully'
                    })
                })
            }

            cancelEdit()
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('priceBooks.messages.saveError', {
                    defaultValue: 'Failed to save the Price Book'
                }),
                variant: 'destructive'
            })
        } finally {
            setIsSaving(false)
        }
    }

    const handleToggleSaveWarn = async (priceBook: PriceBook, saveWarn: boolean) => {
        if (!workspaceId || !enabled || !isCatalogReady || isSaving || isDeleting) {
            return
        }

        try {
            await updatePriceBook(priceBook.id, { name: priceBook.name, saveWarn })
            toast({
                title: t('priceBooks.messages.updateSuccess', {
                    defaultValue: 'Price Book updated successfully'
                })
            })
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('priceBooks.messages.saveError', {
                    defaultValue: 'Failed to save the Price Book'
                }),
                variant: 'destructive'
            })
        }
    }

    const handleConfirmDelete = async () => {
        const priceBook = priceBookToDelete
        if (!priceBook || !enabled || isDeleting) {
            return
        }

        setIsDeleting(true)
        try {
            await hardDeletePriceBook(priceBook.id)
            if (editingPriceBook?.id === priceBook.id) {
                cancelEdit()
            }
            setExpandedPriceBookIds((current) => {
                const next = new Set(current)
                next.delete(priceBook.id)
                return next
            })
            setPriceBookToDelete(null)
            toast({
                title: t('priceBooks.messages.deleteSuccess', {
                    defaultValue: 'Price Book deleted successfully'
                })
            })
        } catch (error: any) {
            toast({
                title: t('common.error', { defaultValue: 'Error' }),
                description: error?.message || t('priceBooks.messages.deleteError', {
                    defaultValue: 'Failed to delete the Price Book'
                }),
                variant: 'destructive'
            })
        } finally {
            setIsDeleting(false)
        }
    }

    return (
        <AppDialog open={open && enabled} onOpenChange={(nextOpen) => !isSaving && !isDeleting && onOpenChange(nextOpen)}>
            <AppDialogContent className="max-w-2xl" showCloseButton={!isSaving && !isDeleting}>
                <AppDialogHeader>
                    <AppDialogTitle className="flex items-center gap-2 text-xl">
                        <BookOpen className="h-5 w-5 text-primary" />
                        {t('priceBooks.title', { defaultValue: 'Price Books' })}
                    </AppDialogTitle>
                    <AppDialogDescription>
                        {t('priceBooks.managementDescription', {
                            defaultValue: 'Create and rename the pricing tiers available for products and business partners.'
                        })}
                    </AppDialogDescription>
                </AppDialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
                    <AppDialogBody className="space-y-5">
                    <div className="space-y-2">
                        <Label htmlFor="price-book-name">
                            {t('priceBooks.name', { defaultValue: 'Price Book name' })} <span className="text-destructive">*</span>
                        </Label>
                        <Input
                            id="price-book-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t('priceBooks.namePlaceholder', { defaultValue: 'e.g. Wholesale' })}
                            maxLength={120}
                            autoFocus
                            required
                            disabled={!workspaceId || !isCatalogReady || isSaving || isDeleting}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label id="price-book-color-label">{t('priceBooks.color', { defaultValue: 'Color' })}</Label>
                        <div className="flex min-w-0 flex-wrap items-center gap-2" role="group" aria-labelledby="price-book-color-label">
                            <button
                                type="button"
                                aria-label={t('priceBooks.noColor', { defaultValue: 'No color' })}
                                aria-pressed={!color}
                                title={t('priceBooks.noColor', { defaultValue: 'No color' })}
                                onClick={() => setColor(null)}
                                disabled={!workspaceId || !isCatalogReady || isSaving || isDeleting}
                                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/60 text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-offset-2"
                            >
                                <CircleOff className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                            {PRICE_BOOK_COLOR_SWATCHES.map((swatch) => (
                                <button
                                    key={swatch}
                                    type="button"
                                    aria-label={t('priceBooks.colorOption', { color: swatch, defaultValue: 'Use {{color}}' })}
                                    aria-pressed={color?.toLowerCase() === swatch}
                                    title={swatch}
                                    onClick={() => setColor(swatch)}
                                    disabled={!workspaceId || !isCatalogReady || isSaving || isDeleting}
                                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border ring-offset-background transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-offset-2"
                                    style={{ backgroundColor: swatch }}
                                >
                                    {color?.toLowerCase() === swatch ? <Check className="h-3.5 w-3.5 text-white drop-shadow" aria-hidden="true" /> : null}
                                </button>
                            ))}
                            <label
                                className="relative inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-background text-muted-foreground hover:bg-muted focus-within:ring-2 focus-within:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
                                title={t('priceBooks.customColor', { defaultValue: 'Custom color' })}
                            >
                                <Palette className="h-3.5 w-3.5" aria-hidden="true" />
                                <input
                                    type="color"
                                    value={isValidPriceBookColor(color) ? color : '#3b82f6'}
                                    onChange={(event) => setColor(event.target.value.toLowerCase())}
                                    aria-label={t('priceBooks.customColor', { defaultValue: 'Custom color' })}
                                    disabled={!workspaceId || !isCatalogReady || isSaving || isDeleting}
                                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                                />
                            </label>
                            <span className="min-w-16 font-mono text-xs text-muted-foreground">
                                {color ?? t('priceBooks.noColor', { defaultValue: 'No color' })}
                            </span>
                        </div>
                    </div>

                    <div className="border-t pt-4">
                        <div className="mb-2 text-sm font-bold">
                            {t('priceBooks.existing', { defaultValue: 'Existing Price Books' })}
                        </div>
                        {!isCatalogReady ? (
                            <div className={catalogError
                                ? 'rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-6 text-center text-sm text-destructive'
                                : 'rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground'}
                            >
                                {catalogError
                                    ? t('priceBooks.loadingError', {
                                        defaultValue: 'Price Books could not be loaded. Retrying automatically...'
                                    })
                                    : t('priceBooks.loading', { defaultValue: 'Loading Price Books...' })}
                            </div>
                        ) : sortedPriceBooks.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                                {t('priceBooks.empty', { defaultValue: 'No Price Books have been created yet.' })}
                            </div>
                        ) : (
                            <div className="max-h-[28rem] space-y-2 overflow-y-auto pe-1">
                                {sortedPriceBooks.map((priceBook) => {
                                    const items = priceBookItemsByBookId.get(priceBook.id) ?? []
                                    const isExpanded = expandedPriceBookIds.has(priceBook.id)

                                    return (
                                        <div
                                            key={priceBook.id}
                                            className="overflow-hidden rounded-xl border border-border/60 bg-background"
                                        >
                                            <div className="flex items-center gap-2 px-3 py-2.5">
                                                <button
                                                    type="button"
                                                    className="flex min-w-0 flex-1 items-center gap-3 text-start"
                                                    onClick={() => togglePriceBookProducts(priceBook.id)}
                                                    aria-expanded={isExpanded}
                                                >
                                                    <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                                    <div className="min-w-0 flex-1">
                                                        <PriceBookName name={priceBook.name} color={priceBook.color} nameClassName="truncate text-sm font-bold" />
                                                        <div className="text-xs text-muted-foreground">
                                                            {t('priceBooks.products', {
                                                                count: items.length,
                                                                defaultValue: '{{count}} products'
                                                            })}
                                                        </div>
                                                    </div>
                                                </button>
                                                <label
                                                    className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
                                                    title={t('priceBooks.saveWarnHint', {
                                                        defaultValue: 'Warn when saving a product or business partner without selecting a Price Book.'
                                                    })}
                                                >
                                                    <Checkbox
                                                        checked={priceBook.saveWarn !== false}
                                                        onCheckedChange={(checked) => void handleToggleSaveWarn(priceBook, Boolean(checked))}
                                                        disabled={!workspaceId || !isCatalogReady || isSaving || isDeleting}
                                                    />
                                                    {t('priceBooks.saveWarnLabel', { defaultValue: 'Warn on save' })}
                                                </label>
                                                <div className="flex shrink-0 gap-1">
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8"
                                                        aria-label={t('priceBooks.edit', { defaultValue: 'Edit Price Book' })}
                                                        onClick={() => beginEdit(priceBook)}
                                                        disabled={!workspaceId || !isCatalogReady || isSaving || isDeleting}
                                                    >
                                                        <Pencil className="h-4 w-4" />
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-8 w-8 text-destructive hover:text-destructive"
                                                        aria-label={t('common.delete', { defaultValue: 'Delete' })}
                                                        onClick={() => setPriceBookToDelete(priceBook)}
                                                        disabled={!workspaceId || !isCatalogReady || isSaving || isDeleting}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            </div>
                                            {isExpanded && (
                                                <div className="border-t border-border/60 bg-muted/20 px-3 py-3">
                                                    {items.length === 0 ? (
                                                        <div className="rounded-lg border border-dashed border-border/70 px-3 py-4 text-center text-sm text-muted-foreground">
                                                            {t('priceBooks.noProducts', { defaultValue: 'No products have custom prices in this Price Book.' })}
                                                        </div>
                                                    ) : (
                                                        <div className="space-y-2">
                                                            {items.map((item) => {
                                                                const product = productById.get(item.productId)
                                                                const productName = product?.name || t('priceBooks.unavailable', { defaultValue: 'Unavailable product' })
                                                                const productSku = product?.sku || item.productId

                                                                return (
                                                                    <div key={item.id} className="flex flex-col gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                                                                        <div className="flex min-w-0 items-center gap-2.5">
                                                                            <Package className="h-4 w-4 shrink-0 text-primary" />
                                                                            <div className="min-w-0">
                                                                                <div className="truncate text-sm font-semibold">{productName}</div>
                                                                                <div className="truncate font-mono text-[11px] text-muted-foreground">{productSku}</div>
                                                                            </div>
                                                                        </div>
                                                                        <div className={`grid shrink-0 ${hideCosts ? 'grid-cols-1' : 'grid-cols-2'} gap-x-5 text-end text-xs`}>
                                                                            {!hideCosts && (
                                                                                <div>
                                                                                    <div className="text-muted-foreground">{t('priceBooks.costPrice', { defaultValue: 'Unit cost' })}</div>
                                                                                    <div className="font-semibold">{item.costPrice == null ? '—' : formatCurrency(item.costPrice, item.currency)}</div>
                                                                                </div>
                                                                            )}
                                                                            <div>
                                                                                <div className="text-muted-foreground">{t('priceBooks.sellingPrice', { defaultValue: 'Selling price' })}</div>
                                                                                <div className="font-semibold text-primary">{formatCurrency(item.price, item.currency)}</div>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                )
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>

                    </AppDialogBody>

                    <AppDialogFooter className="sm:justify-between">
                        {editingPriceBook ? (
                            <Button type="button" variant="ghost" onClick={cancelEdit} disabled={isSaving || isDeleting}>
                                {t('priceBooks.cancelEdit', { defaultValue: 'Cancel edit' })}
                            </Button>
                        ) : <span />}
                        <div className="flex flex-col-reverse gap-2 sm:flex-row">
                            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving || isDeleting}>
                                {t('common.close', { defaultValue: 'Close' })}
                            </Button>
                            <Button
                                type="submit"
                                disabled={isSaving || isDeleting || !isCatalogReady || !workspaceId || !name.trim()}
                                className="gap-2"
                            >
                                {editingPriceBook ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                                {isSaving
                                    ? t('common.loading', { defaultValue: 'Loading...' })
                                    : editingPriceBook
                                        ? t('common.save', { defaultValue: 'Save' })
                                        : t('common.create', { defaultValue: 'Create' })}
                            </Button>
                        </div>
                    </AppDialogFooter>
                </form>
            </AppDialogContent>
            <DeleteConfirmationModal
                isOpen={Boolean(priceBookToDelete)}
                onClose={() => {
                    if (!isDeleting) {
                        setPriceBookToDelete(null)
                    }
                }}
                onConfirm={() => {
                    void handleConfirmDelete()
                }}
                isLoading={isDeleting}
                title={t('priceBooks.deleteConfirmTitle', { defaultValue: 'Delete Price Book?' })}
                description={t('priceBooks.deleteConfirmDescription', {
                    defaultValue: 'This permanently deletes its custom product prices and removes it from associated business partners.'
                })}
                itemName={priceBookToDelete?.name || ''}
            />
        </AppDialog>
    )
}
