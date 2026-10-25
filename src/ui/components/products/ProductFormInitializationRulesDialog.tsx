import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    Barcode,
    Boxes,
    DollarSign,
    FileText,
    Info,
    Package,
    Ruler,
    RotateCcw,
    Save,
    Tag,
    Type,
    Wallet,
    Warehouse,
    X,
} from 'lucide-react'

import type { Category, Storage } from '@/local-db/models'
import type { WorkspaceUnitOption } from '@/ui/components/unitRegistry'
import { createDefaultProductFormInitializationRules, readProductFormInitializationRules, type EmptyOrStaticRule, type ProductFormInitializationRules } from '@/lib/productFormInitialization'
import {
    AppDialog,
    AppDialogBody,
    AppDialogContent,
    AppDialogFooter,
    AppDialogHeader,
    AppDialogTitle,
    Button,
    Input,
    Label,
    NumericInput,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
} from '@/ui/components'

const ACTIVE_STORAGE_VALUE = '__active_storage__'

type RuleField = 'name' | 'description' | 'price' | 'costPrice' | 'quantity' | 'minStockLevel'

interface ProductFormInitializationRulesDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    workspaceId: string
    unitOptions: WorkspaceUnitOption[]
    categories: Category[]
    storages: Storage[]
    catalogsReady: boolean
    dynamicUnitCodes: string[]
    isAutoSkuGenerationEnabled: boolean
    onSave: (config: ProductFormInitializationRules) => boolean
    onReset: () => boolean
}

function readFieldRule(
    config: ProductFormInitializationRules,
    field: RuleField,
): EmptyOrStaticRule {
    return config.rules[field]
}

function updateFieldRule(
    config: ProductFormInitializationRules,
    field: RuleField,
    rule: EmptyOrStaticRule,
): ProductFormInitializationRules {
    return { ...config, rules: { ...config.rules, [field]: rule } }
}

function isValidNonNegativeNumber(value: string, maxFractionDigits: number) {
    if (!value.trim()) return false
    const number = Number(value)
    if (!Number.isFinite(number) || number < 0) return false
    const fraction = value.split('.')[1]
    return !fraction || fraction.length <= maxFractionDigits
}

export function ProductFormInitializationRulesDialog({
    open,
    onOpenChange,
    workspaceId,
    unitOptions,
    categories,
    storages,
    catalogsReady,
    dynamicUnitCodes,
    isAutoSkuGenerationEnabled,
    onSave,
    onReset,
}: ProductFormInitializationRulesDialogProps) {
    const { t } = useTranslation()
    const wasOpenRef = useRef(false)
    const [draft, setDraft] = useState<ProductFormInitializationRules>(() => (
        readProductFormInitializationRules(workspaceId)
        ?? createDefaultProductFormInitializationRules(
            workspaceId,
            unitOptions.map((option) => option.value),
            storages,
        )
    ))
    const [storageError, setStorageError] = useState(false)

    useEffect(() => {
        if (open && !wasOpenRef.current) {
            setDraft(readProductFormInitializationRules(workspaceId)
                ?? createDefaultProductFormInitializationRules(
                    workspaceId,
                    unitOptions.map((option) => option.value),
                    storages,
                ))
            setStorageError(false)
        }
        wasOpenRef.current = open
    }, [open, workspaceId, unitOptions, storages])

    const activeStorages = useMemo(() => storages.filter((storage) => !storage.isDeleted), [storages])
    const unitValues = useMemo(() => unitOptions.map((option) => option.value), [unitOptions])
    const unitOptionsChanged = (value: string) => setDraft((current) => ({
        ...current,
        rules: { ...current.rules, unit: { type: 'static', value } },
    }))

    const selectedUnit = draft.rules.unit.value
    const isSelectedUnitDynamic = dynamicUnitCodes.includes(selectedUnit)
    const categoryRule = draft.rules.category
    const storageDraftRule = draft.rules.storage
    const unavailableCategoryId = categoryRule.type === 'static' ? categoryRule.value : ''
    const unavailableStorageId = storageDraftRule.type === 'static' ? storageDraftRule.value : ''
    const storageSelection = activeStorages.length === 1
        ? activeStorages[0].id
        : activeStorages.length > 1
            ? storageDraftRule.type === 'dynamic'
                ? ACTIVE_STORAGE_VALUE
                : storageDraftRule.type === 'static'
                    ? storageDraftRule.value
                    : ACTIVE_STORAGE_VALUE
            : storageDraftRule.type === 'dynamic'
                ? ACTIVE_STORAGE_VALUE
                : storageDraftRule.type === 'static'
                    ? storageDraftRule.value
                    : ''

    const validationErrors = useMemo(() => {
        const errors: string[] = []
        if (draft.rules.name.type === 'static' && !draft.rules.name.value.trim()) {
            errors.push(t('products.initializationRules.nameRequired'))
        }
        for (const field of ['price', 'costPrice', 'quantity', 'minStockLevel'] as const) {
            const rule = draft.rules[field]
            if (rule.type !== 'static') continue
            const fractionDigits = field === 'price' || field === 'costPrice'
                ? 4
                : isSelectedUnitDynamic ? 2 : 0
            if (!isValidNonNegativeNumber(rule.value, fractionDigits)) {
                const labelKey = field === 'quantity' ? 'stock' : field === 'minStockLevel' ? 'minStock' : field === 'costPrice' ? 'cost' : field
                errors.push(t('products.initializationRules.invalidNumber', { field: t(`products.form.${labelKey}`) }))
            }
        }
        return errors
    }, [draft, isSelectedUnitDynamic, t])

    const save = () => {
        if (!catalogsReady || validationErrors.length > 0) return

        const validUnit = unitValues.includes(draft.rules.unit.value)
            ? draft.rules.unit.value
            : unitValues.includes('pcs') ? 'pcs' : (unitValues[0] ?? 'pcs')
        const categoryRule = draft.rules.category
        const storageDraftRule = draft.rules.storage
        const validCategory = categoryRule.type !== 'static'
            || categories.some((category) => !category.isDeleted && category.id === categoryRule.value)
        const validStorage = storageDraftRule.type === 'static'
            && activeStorages.some((storage) => storage.id === storageDraftRule.value)
        const storageRule: ProductFormInitializationRules['rules']['storage'] = activeStorages.length === 1
            ? { type: 'static', value: activeStorages[0].id }
            : activeStorages.length === 0
                ? { type: 'system' }
                : validStorage
                    ? storageDraftRule
                    : { type: 'dynamic', value: 'active' }

        const config: ProductFormInitializationRules = {
            ...draft,
            workspaceId,
            rules: {
                ...draft.rules,
                unit: { type: 'static', value: validUnit },
                category: validCategory ? draft.rules.category : { type: 'empty' },
                storage: storageRule,
            },
        }
        if (onSave(config)) onOpenChange(false)
        else setStorageError(true)
    }

    const reset = () => {
        if (onReset()) onOpenChange(false)
        else setStorageError(true)
    }

    const renderTextRule = (field: 'name' | 'description') => {
        const rule = readFieldRule(draft, field)
        const isName = field === 'name'
        const label = t(`products.form.${isName ? 'name' : 'description'}`)
        const Icon = isName ? Type : FileText
        return (
            <div className="space-y-3 rounded-xl border border-border/60 p-4">
                <Label className="flex items-center gap-2 font-semibold">
                    <Icon className="h-4 w-4 text-primary/70" />
                    {label}
                </Label>
                <Select
                    value={rule.type}
                    onValueChange={(value) => setDraft((current) => updateFieldRule(current, field,
                        value === 'static'
                            ? { type: 'static', value: rule.type === 'static' ? rule.value : '' }
                            : { type: 'empty' }))}
                >
                    <SelectTrigger className="h-10" aria-label={label}><SelectValue /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="empty">{t('products.initializationRules.alwaysEmpty')}</SelectItem>
                        <SelectItem value="static">{t('products.initializationRules.edit')}</SelectItem>
                    </SelectContent>
                </Select>
                {rule.type === 'static' && (
                    <div className="space-y-2">
                        <Label htmlFor={`initialization-${field}`}>
                            {label}{isName ? ' *' : ''}
                        </Label>
                        {isName ? (
                            <Input
                                id={`initialization-${field}`}
                                value={rule.value}
                                onChange={(event) => setDraft((current) => updateFieldRule(current, field, { type: 'static', value: event.target.value }))}
                                placeholder={t('products.form.name')}
                                required
                            />
                        ) : (
                            <Textarea
                                id={`initialization-${field}`}
                                value={rule.value}
                                onChange={(event) => setDraft((current) => updateFieldRule(current, field, { type: 'static', value: event.target.value }))}
                                placeholder={t('products.form.description')}
                                rows={3}
                            />
                        )}
                    </div>
                )}
            </div>
        )
    }

    const renderNumericRule = (field: 'price' | 'costPrice' | 'quantity' | 'minStockLevel') => {
        const rule = draft.rules[field]
        const labelKey = field === 'quantity' ? 'stock' : field === 'minStockLevel' ? 'minStock' : field === 'costPrice' ? 'cost' : field
        const label = t(`products.form.${labelKey}`)
        const Icon = field === 'price' ? DollarSign : field === 'costPrice' ? Wallet : field === 'quantity' ? Boxes : Info
        const maxFractionDigits = field === 'price' || field === 'costPrice' ? 4 : isSelectedUnitDynamic ? 2 : 0
        return (
            <div className="space-y-3 rounded-xl border border-border/60 p-4">
                <Label className="flex items-center gap-2 font-semibold">
                    <Icon className="h-4 w-4 text-primary/70" />
                    {label}
                </Label>
                <Select
                    value={rule.type}
                    onValueChange={(value) => setDraft((current) => updateFieldRule(current, field,
                        value === 'static'
                            ? { type: 'static', value: rule.type === 'static' ? rule.value : '' }
                            : { type: 'empty' }))}
                >
                    <SelectTrigger className="h-10" aria-label={label}><SelectValue /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="empty">{t('products.initializationRules.alwaysEmpty')}</SelectItem>
                        <SelectItem value="static">{t('products.initializationRules.edit')}</SelectItem>
                    </SelectContent>
                </Select>
                {rule.type === 'static' && (
                    <div className="space-y-2">
                        <Label htmlFor={`initialization-${field}`}>{label} *</Label>
                        <NumericInput
                            id={`initialization-${field}`}
                            value={rule.value}
                            onValueChange={(value) => setDraft((current) => updateFieldRule(current, field, { type: 'static', value }))}
                            allowDecimal={maxFractionDigits > 0}
                            maxFractionDigits={maxFractionDigits}
                            min="0"
                            placeholder="0"
                        />
                    </div>
                )}
            </div>
        )
    }

    return (
        <AppDialog open={open} onOpenChange={onOpenChange}>
            <AppDialogContent className="max-w-3xl">
                <AppDialogHeader>
                    <AppDialogTitle className="flex items-center gap-2">
                        <Package className="h-5 w-5 text-primary" />
                        {t('products.initializationRules.title')}
                    </AppDialogTitle>
                </AppDialogHeader>
                <AppDialogBody className="space-y-4">
                    <p className="text-sm text-muted-foreground">{t('products.initializationRules.description')}</p>

                    {renderTextRule('name')}

                    <div className="space-y-3 rounded-xl border border-border/60 p-4">
                        <Label className="flex items-center gap-2 font-semibold">
                            <Barcode className="h-4 w-4 text-primary/70" />
                            {t('products.form.sku')}
                        </Label>
                        <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                            {isAutoSkuGenerationEnabled
                                ? t('products.initializationRules.skuAutomatic')
                                : t('products.initializationRules.skuEmpty')}
                        </div>
                    </div>

                    <div className="space-y-3 rounded-xl border border-border/60 p-4">
                        <Label className="flex items-center gap-2 font-semibold">
                            <Ruler className="h-4 w-4 text-primary/70" />
                            {t('products.form.unit')} *
                        </Label>
                        <div className="flex items-center gap-3">
                            <span className="shrink-0 text-sm font-medium">{t('products.initializationRules.always')}</span>
                            <Select value={selectedUnit} onValueChange={unitOptionsChanged}>
                                <SelectTrigger className="h-10 min-w-0 flex-1" aria-label={t('products.form.unit')}>
                                    <SelectValue placeholder={t('units.selectPlaceholder')} />
                                </SelectTrigger>
                                <SelectContent>
                                    {!unitValues.includes(selectedUnit) && selectedUnit && (
                                        <SelectItem value={selectedUnit}>
                                            {t('products.initializationRules.unavailableValue', { value: selectedUnit })}
                                        </SelectItem>
                                    )}
                                    {unitOptions.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {t(`products.units.${option.value}`, { defaultValue: option.value })}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="space-y-3 rounded-xl border border-border/60 p-4">
                        <Label className="flex items-center gap-2 font-semibold">
                            <Tag className="h-4 w-4 text-primary/70" />
                            {t('products.form.category')}
                        </Label>
                        <Select
                            value={draft.rules.category.type === 'static' ? draft.rules.category.value : 'none'}
                            onValueChange={(value) => setDraft((current) => ({
                                ...current,
                                rules: { ...current.rules, category: value === 'none' ? { type: 'empty' } : { type: 'static', value } },
                            }))}
                        >
                            <SelectTrigger className="h-10" aria-label={t('products.form.category')}><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">{t('categories.noCategory')}</SelectItem>
                                {unavailableCategoryId
                                    && !categories.some((category) => category.id === unavailableCategoryId && !category.isDeleted)
                                    && <SelectItem value={unavailableCategoryId}>{t('products.initializationRules.unavailableValue', { value: unavailableCategoryId })}</SelectItem>}
                                {categories.filter((category) => !category.isDeleted).map((category) => (
                                    <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-3 rounded-xl border border-border/60 p-4">
                        <Label className="flex items-center gap-2 font-semibold">
                            <Warehouse className="h-4 w-4 text-primary/70" />
                            {t('storages.title')}
                        </Label>
                        {activeStorages.length === 0 && catalogsReady ? (
                            <p className="text-sm text-muted-foreground">{t('products.initializationRules.noStorages')}</p>
                        ) : activeStorages.length === 0 && storageDraftRule.type === 'system' ? (
                            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
                        ) : (
                            <Select
                                value={storageSelection}
                                disabled={!catalogsReady || activeStorages.length === 0}
                                onValueChange={(value) => setDraft((current) => ({
                                    ...current,
                                    rules: { ...current.rules, storage: value === ACTIVE_STORAGE_VALUE ? { type: 'dynamic', value: 'active' } : { type: 'static', value } },
                                }))}
                            >
                                <SelectTrigger className="h-10" aria-label={t('storages.title')}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {(activeStorages.length > 1 || (activeStorages.length === 0 && storageDraftRule.type === 'dynamic')) && (
                                        <SelectItem value={ACTIVE_STORAGE_VALUE}>{t('storages.selectStorage')}</SelectItem>
                                    )}
                                    {unavailableStorageId
                                        && !activeStorages.some((storage) => storage.id === unavailableStorageId)
                                        && <SelectItem value={unavailableStorageId}>{t('products.initializationRules.unavailableValue', { value: unavailableStorageId })}</SelectItem>}
                                    {activeStorages.map((storage) => (
                                        <SelectItem key={storage.id} value={storage.id}>
                                            {storage.isSystem ? (t(`storages.${storage.name.toLowerCase()}`) || storage.name) : storage.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        {activeStorages.length === 1 && <p className="text-xs text-muted-foreground">{t('products.initializationRules.onlyStorage')}</p>}
                    </div>

                    {renderTextRule('description')}
                    {renderNumericRule('price')}
                    {renderNumericRule('costPrice')}
                    {renderNumericRule('quantity')}
                    {renderNumericRule('minStockLevel')}

                    {validationErrors.length > 0 && (
                        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                            {validationErrors[0]}
                        </div>
                    )}
                    {storageError && (
                        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                            {t('products.initializationRules.saveError')}
                        </div>
                    )}
                </AppDialogBody>
                <AppDialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                    <Button type="button" variant="ghost" onClick={reset}>
                        <RotateCcw className="mr-2 h-4 w-4" />
                        {t('products.initializationRules.reset')}
                    </Button>
                    <div className="flex flex-col-reverse gap-2 sm:flex-row">
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            <X className="mr-2 h-4 w-4" />
                            {t('common.cancel')}
                        </Button>
                        <Button type="button" onClick={save} disabled={!catalogsReady || validationErrors.length > 0}>
                            <Save className="mr-2 h-4 w-4" />
                            {t('common.save')}
                        </Button>
                    </div>
                </AppDialogFooter>
            </AppDialogContent>
        </AppDialog>
    )
}
