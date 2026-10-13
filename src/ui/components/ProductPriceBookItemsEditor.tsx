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
import { PriceBookName } from '@/ui/components/PriceBookName'

export interface ProductPriceBookDraft {
    priceBookId: string
    costPrice: string
    price: string
    minimumSellingPrice?: string
    parentPrice?: string
    unitPrices?: Record<string, ProductPriceBookUnitDraft>
    currency: CurrencyCode
    useParentPriceBookCost?: boolean
}

export interface ProductPriceBookUnitDraft {
    price: string
    costPrice: string
    minimumSellingPrice: string
    currency: CurrencyCode
}

export interface ProductPriceBookUnitOption {
    unitRef: string
    unitCode: string
    isBase: boolean
    isDefaultSelling?: boolean
    sellingPrice?: string
    costPrice?: string
    minimumSellingPrice?: string
}

interface ProductPriceBookItemsEditorProps {
    priceBooks: PriceBook[]
    rows: ProductPriceBookDraft[]
    onChange: (rows: ProductPriceBookDraft[]) => void
    defaultCostPrice: string
    defaultPrice: string
    defaultParentPrice?: string
    parentUnitLabel?: string
    unitOptions?: ProductPriceBookUnitOption[]
    defaultCurrency: CurrencyCode
    allowedCurrencies: CurrencyCode[]
    iqdDisplayPreference: IQDDisplayPreference
    disabled?: boolean
    hideCosts?: boolean
    hideMinimumSellingPrice?: boolean
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
    unitOptions,
    defaultCurrency,
    allowedCurrencies,
    iqdDisplayPreference,
    disabled = false,
    hideCosts = false,
    hideMinimumSellingPrice = false,
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
    const hasUnitOptions = Boolean(unitOptions?.length)

    const getUnitDraft = (row: ProductPriceBookDraft, unit: ProductPriceBookUnitOption): ProductPriceBookUnitDraft => {
        const saved = row.unitPrices?.[unit.unitRef]
        return {
            price: saved?.price ?? (unit.isBase ? row.price : unit.sellingPrice ?? ''),
            costPrice: saved?.costPrice ?? (unit.isBase ? row.costPrice : unit.costPrice ?? ''),
            minimumSellingPrice: saved?.minimumSellingPrice
                ?? (unit.isBase ? row.minimumSellingPrice ?? '' : unit.minimumSellingPrice ?? ''),
            currency: saved?.currency ?? (unit.isBase ? row.currency : defaultCurrency)
        }
    }

    const updateUnitDraft = (
        index: number,
        unit: ProductPriceBookUnitOption,
        changes: Partial<ProductPriceBookUnitDraft>
    ) => {
        const row = rows[index]
        if (!row) return
        const nextUnit = { ...getUnitDraft(row, unit), ...changes }
        updateRow(index, {
            unitPrices: { ...row.unitPrices, [unit.unitRef]: nextUnit },
            ...(unit.isBase ? {
                price: nextUnit.price,
                costPrice: nextUnit.costPrice,
                minimumSellingPrice: nextUnit.minimumSellingPrice,
                currency: nextUnit.currency
            } : {})
        })
    }

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
                ...(hasUnitOptions
                    ? { unitPrices: Object.fromEntries(unitOptions!.map((unit) => [unit.unitRef, {
                        price: unit.isBase ? (unit.sellingPrice ?? defaultPrice).trim() : (unit.sellingPrice ?? '').trim(),
                        costPrice: hideCosts ? '' : (unit.isBase ? (unit.costPrice ?? defaultCostPrice).trim() : (unit.costPrice ?? '').trim()),
                        minimumSellingPrice: hideMinimumSellingPrice ? '' : (unit.minimumSellingPrice ?? '').trim(),
                        currency: defaultCurrency
                    }])) }
                    : parentUnitLabel ? { parentPrice: defaultParentPrice.trim() } : {}),
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
                                <div className={hasUnitOptions
                                    ? 'grid gap-4 sm:grid-cols-[minmax(180px,1fr)_40px] sm:items-end'
                                    : parentUnitLabel
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
                                                        <PriceBookName name={priceBook.name} color={priceBook.color} />
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    {parentUnitLabel && !hasUnitOptions ? (
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

                                    {!hasUnitOptions ? <div className="space-y-2">
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
                                    </div> : null}

                                    {!hideCosts && !hasUnitOptions && (
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

                                    {!hasUnitOptions ? <CurrencySelector
                                        label={`${t('priceBooks.currency', { defaultValue: 'Currency' })} *`}
                                        value={row.currency}
                                        onChange={(currency) => updateRow(index, { currency })}
                                        iqdDisplayPreference={iqdDisplayPreference}
                                        allowedCurrencies={allowedCurrencies}
                                        disabled={disabled}
                                    /> : null}

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
                                {hasUnitOptions ? (
                                    <div className="mt-4 space-y-3 border-t border-border/60 pt-4">
                                        <div className="space-y-1">
                                            <p className="flex items-center gap-2 text-sm font-semibold">
                                                <Package className="h-4 w-4 text-primary/60" />
                                                {t('priceBooks.unitPricesTitle', { defaultValue: 'Price Book values by unit' })}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {t('priceBooks.unitPricesDescription', { defaultValue: 'Set the Price Book values used when this unit is sold.' })}
                                            </p>
                                        </div>
                                        <div className="space-y-3">
                                            {unitOptions?.map((unit) => {
                                                const values = getUnitDraft(row, unit)
                                                const unitLabel = t(`products.units.${unit.unitCode}`, { defaultValue: unit.unitCode })
                                                const fieldId = `price-book-unit-${row.priceBookId}-${unit.unitRef}`
                                                return (
                                                    <div key={unit.unitRef} className="rounded-xl border border-border/60 bg-background/70 p-3">
                                                        <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
                                                            <Package className="h-4 w-4 text-primary/60" />
                                                            {unitLabel}
                                                            {unit.isBase ? <span className="text-xs font-normal text-muted-foreground">({t('products.uom.baseUnit')})</span> : null}
                                                        </p>
                                                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                                            <div className="space-y-2">
                                                                <Label htmlFor={`${fieldId}-price`}>{t('priceBooks.sellingPrice', { defaultValue: 'Selling price' })} *</Label>
                                                                <Input
                                                                    id={`${fieldId}-price`}
                                                                    type="text"
                                                                    inputMode="decimal"
                                                                    value={formatNumericInput(values.price)}
                                                                    onChange={(event) => updateUnitDraft(index, unit, { price: sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 }) })}
                                                                    readOnly={disabled}
                                                                    placeholder="0"
                                                                    required
                                                                />
                                                            </div>
                                                            {!hideCosts ? <div className="space-y-2">
                                                                <Label htmlFor={`${fieldId}-cost`}>{t('priceBooks.costPrice', { defaultValue: 'Unit cost' })} *</Label>
                                                                <Input
                                                                    id={`${fieldId}-cost`}
                                                                    type="text"
                                                                    inputMode="decimal"
                                                                    value={formatNumericInput(values.costPrice)}
                                                                    onChange={(event) => updateUnitDraft(index, unit, { costPrice: sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 }) })}
                                                                    readOnly={disabled}
                                                                    placeholder="0"
                                                                    required
                                                                    className={cn(
                                                                        highlightMissingCosts && values.costPrice.trim() === ''
                                                                            && 'border-destructive bg-destructive/5 ring-2 ring-destructive/20 hover:border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30'
                                                                    )}
                                                                />
                                                            </div> : null}
                                                            {!hideMinimumSellingPrice ? <div className="space-y-2">
                                                                <Label htmlFor={`${fieldId}-minimum`}>{t('products.form.minimumSellingPrice', { defaultValue: 'Minimum selling price' })}</Label>
                                                                <Input
                                                                    id={`${fieldId}-minimum`}
                                                                    type="text"
                                                                    inputMode="decimal"
                                                                    value={formatNumericInput(values.minimumSellingPrice)}
                                                                    onChange={(event) => updateUnitDraft(index, unit, { minimumSellingPrice: sanitizeNumericInput(event.target.value, { maxFractionDigits: 4 }) })}
                                                                    readOnly={disabled}
                                                                    placeholder="0"
                                                                />
                                                            </div> : null}
                                                            <CurrencySelector
                                                                label={`${t('priceBooks.currency', { defaultValue: 'Currency' })} *`}
                                                                value={values.currency}
                                                                onChange={(currency) => updateUnitDraft(index, unit, { currency })}
                                                                iqdDisplayPreference={iqdDisplayPreference}
                                                                allowedCurrencies={allowedCurrencies}
                                                                disabled={disabled}
                                                            />
                                                        </div>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    </div>
                                ) : null}
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
