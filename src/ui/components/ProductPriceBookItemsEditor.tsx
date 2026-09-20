import { BookOpen, DollarSign, Package, Plus, Trash2, Wallet } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { CurrencyCode, IQDDisplayPreference, PriceBook } from '@/local-db'
import { cn, formatNumericInput, sanitizeNumericInput } from '@/lib/utils'
import {
    Button,
    CurrencySelector,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch
} from '@/ui/components'

export interface ProductPriceBookDraft {
    priceBookId: string
    costPrice: string
    price: string
    parentPrice?: string
    currency: CurrencyCode
    useParentPriceBookCost?: boolean
}

interface ProductPriceBookItemsEditorProps {
    priceBooks: PriceBook[]
    rows: ProductPriceBookDraft[]
    onChange: (rows: ProductPriceBookDraft[]) => void
    defaultCostPrice: string
    defaultPrice: string
    defaultParentPrice?: string
    parentUnitLabel?: string
    defaultCurrency: CurrencyCode
    allowedCurrencies: CurrencyCode[]
    iqdDisplayPreference: IQDDisplayPreference
    disabled?: boolean
    hideCosts?: boolean
    showParentPriceBookCostToggle?: boolean
    highlightMissingCosts?: boolean
    attention?: boolean
    description?: string
}

export function ProductPriceBookItemsEditor({
    priceBooks,
    rows,
    onChange,
    defaultCostPrice,
    defaultPrice,
    defaultParentPrice = '',
    parentUnitLabel,
    defaultCurrency,
    allowedCurrencies,
    iqdDisplayPreference,
    disabled = false,
    hideCosts = false,
    showParentPriceBookCostToggle = false,
    highlightMissingCosts = false,
    attention = false,
    description
}: ProductPriceBookItemsEditorProps) {
    const { t } = useTranslation()
    const sortedPriceBooks = useMemo(
        () => [...priceBooks].sort((left, right) => left.name.localeCompare(right.name)),
        [priceBooks]
    )
    const selectedIds = useMemo(() => new Set(rows.map((row) => row.priceBookId)), [rows])
    const nextAvailableBook = sortedPriceBooks.find((priceBook) => !selectedIds.has(priceBook.id))

    const updateRow = (index: number, changes: Partial<ProductPriceBookDraft>) => {
        const nextRows = rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...changes } : row)
        onChange(nextRows)
    }

    const addRow = () => {
        if (!nextAvailableBook) {
            return
        }

        onChange([
            ...rows,
            {
                priceBookId: nextAvailableBook.id,
                costPrice: hideCosts ? '' : defaultCostPrice.trim(),
                price: defaultPrice.trim() || '0',
                ...(parentUnitLabel ? { parentPrice: defaultParentPrice.trim() } : {}),
                currency: defaultCurrency,
                ...(showParentPriceBookCostToggle ? { useParentPriceBookCost: true } : {})
            }
        ])
    }

    const removeRow = (index: number) => {
        onChange(rows.filter((_row, rowIndex) => rowIndex !== index))
    }

    return (
        <section className="space-y-4 border-t border-border/60 pt-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-primary/80">
                        <BookOpen className="h-4 w-4" />
                        {t('priceBooks.productOverridesTitle', { defaultValue: 'Price Book overrides' })}
                    </div>
                    <p className="max-w-2xl text-sm text-muted-foreground">
                        {description || t('priceBooks.productOverridesDescription', {
                            defaultValue: hideCosts
                                ? 'Set a custom selling price for each pricing tier that uses this product.'
                                : 'Set a custom unit cost and selling price for each pricing tier that uses this product.'
                        })}
                    </p>
                </div>
                {!disabled && (
                    <Button
                        type="button"
                        variant="outline"
                        className={cn(
                            'shrink-0 gap-2',
                            attention && 'border-yellow-400 bg-yellow-500/10 ring-2 ring-yellow-400 animate-pulse'
                        )}
                        onClick={addRow}
                        disabled={!nextAvailableBook}
                    >
                        <Plus className="h-4 w-4" />
                        {t('priceBooks.addOverride', { defaultValue: 'Add override' })}
                    </Button>
                )}
            </div>

            {attention ? (
                <p className="animate-pulse text-xs font-bold text-yellow-600 dark:text-yellow-400">
                    {t('priceBooks.overrideAttention', {
                        defaultValue: 'A Price Book is available. Add an override, or click Save again to confirm "No Price Book".'
                    })}
                </p>
            ) : null}

            {sortedPriceBooks.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('priceBooks.noBooksForProduct', {
                        defaultValue: 'Create a Price Book from the Products page before adding custom prices.'
                    })}
                </div>
            ) : rows.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('priceBooks.noOverrides', { defaultValue: 'This product does not have any Price Book overrides.' })}
                </div>
            ) : (
                <div className="space-y-3">
                    {rows.map((row, index) => {
                        const currentBook = sortedPriceBooks.find((priceBook) => priceBook.id === row.priceBookId)
                        const selectableBooks = sortedPriceBooks.filter((priceBook) => (
                            priceBook.id === row.priceBookId || !selectedIds.has(priceBook.id)
                        ))

                        return (
                            <div key={`${row.priceBookId}-${index}`} className="rounded-2xl border border-border/60 bg-muted/10 p-4">
                                <div className={parentUnitLabel
                                    ? 'grid gap-4 md:grid-cols-2 xl:grid-cols-3'
                                    : hideCosts
                                    ? showParentPriceBookCostToggle
                                        ? 'grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(180px,1.2fr)_minmax(150px,1fr)_minmax(160px,1fr)_minmax(140px,0.8fr)_40px] xl:items-end'
                                        : 'grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(180px,1.2fr)_minmax(150px,1fr)_minmax(140px,0.8fr)_40px] xl:items-end'
                                    : 'grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(180px,1.2fr)_minmax(150px,1fr)_minmax(150px,1fr)_minmax(140px,0.8fr)_40px] xl:items-end'}>
                                    <div className="space-y-2">
                                        <Label>{t('priceBooks.titleSingular', { defaultValue: 'Price Book' })} *</Label>
                                        <Select
                                            value={row.priceBookId}
                                            onValueChange={(value) => updateRow(index, { priceBookId: value })}
                                            disabled={disabled}
                                        >
                                            <SelectTrigger allowViewer={true}>
                                                <SelectValue placeholder={t('priceBooks.select', { defaultValue: 'Select a Price Book' })} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {!currentBook && row.priceBookId ? (
                                                    <SelectItem value={row.priceBookId} disabled>
                                                        {t('priceBooks.unavailable', { defaultValue: 'Unavailable Price Book' })}
                                                    </SelectItem>
                                                ) : null}
                                                {selectableBooks.map((priceBook) => (
                                                    <SelectItem key={priceBook.id} value={priceBook.id}>
                                                        {priceBook.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {parentUnitLabel ? (
                                        <div className="space-y-2">
                                            <Label className="flex items-center gap-2">
                                                <Package className="h-4 w-4 text-primary/60" />
                                                {t('priceBooks.sellingPriceForUnit', {
                                                    defaultValue: '{{unit}} selling price',
                                                    unit: parentUnitLabel
                                                })} *
                                            </Label>
                                            <Input
                                                type="text"
                                                inputMode="decimal"
                                                value={formatNumericInput(row.parentPrice ?? '')}
                                                onChange={(event) => updateRow(index, {
                                                    parentPrice: sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 })
                                                })}
                                                readOnly={disabled}
                                                placeholder="0"
                                                required
                                            />
                                        </div>
                                    ) : null}

                                    <div className="space-y-2">
                                        <Label className="flex items-center gap-2">
                                            <DollarSign className="h-4 w-4 text-primary/60" />
                                            {t('priceBooks.sellingPrice', { defaultValue: 'Selling price' })} *
                                        </Label>
                                        <Input
                                            type="text"
                                            inputMode="decimal"
                                            value={formatNumericInput(row.price)}
                                            onChange={(event) => updateRow(index, {
                                                price: sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 })
                                            })}
                                            readOnly={disabled}
                                            placeholder="0.000"
                                            required
                                        />
                                    </div>

                                    {!hideCosts && (
                                        <div className="space-y-2">
                                            <Label className="flex items-center gap-2">
                                                <Wallet className="h-4 w-4 text-primary/60" />
                                                {t('priceBooks.costPrice', { defaultValue: 'Unit cost' })} *
                                            </Label>
                                            <Input
                                                type="text"
                                                inputMode="decimal"
                                                value={formatNumericInput(row.costPrice)}
                                                onChange={(event) => updateRow(index, {
                                                    costPrice: sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 })
                                                })}
                                                readOnly={disabled}
                                                placeholder="0.000"
                                                required
                                                className={cn(
                                                    highlightMissingCosts && row.costPrice.trim() === ''
                                                        && 'border-destructive bg-destructive/5 ring-2 ring-destructive/20 hover:border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30'
                                                )}
                                            />
                                        </div>
                                    )}

                                    {hideCosts && showParentPriceBookCostToggle && (
                                        <div className="space-y-2">
                                            <Label htmlFor={`price-book-use-parent-cost-${index}`}>{t('products.variants.useParentPriceBookCost', { defaultValue: 'Use parent Price Book cost' })}</Label>
                                            <div className="flex h-10 items-center">
                                                <Switch
                                                    id={`price-book-use-parent-cost-${index}`}
                                                    checked={row.useParentPriceBookCost !== false}
                                                    onCheckedChange={(useParentPriceBookCost) => updateRow(index, { useParentPriceBookCost })}
                                                    disabled={disabled}
                                                />
                                            </div>
                                        </div>
                                    )}

                                    <CurrencySelector
                                        label={`${t('priceBooks.currency', { defaultValue: 'Currency' })} *`}
                                        value={row.currency}
                                        onChange={(currency) => updateRow(index, { currency })}
                                        iqdDisplayPreference={iqdDisplayPreference}
                                        allowedCurrencies={allowedCurrencies}
                                        disabled={disabled}
                                    />

                                    <div className="flex justify-end xl:justify-center">
                                        {!disabled && (
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="h-10 w-10 text-destructive hover:text-destructive"
                                                aria-label={t('priceBooks.removeOverride', { defaultValue: 'Remove Price Book override' })}
                                                onClick={() => removeRow(index)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}

            {!disabled && sortedPriceBooks.length > 0 && !nextAvailableBook && rows.length > 0 ? (
                <p className="text-xs font-medium text-muted-foreground">
                    {t('priceBooks.allAssigned', { defaultValue: 'Every available Price Book is already assigned to this product.' })}
                </p>
            ) : null}
        </section>
    )
}
