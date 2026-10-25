import { getPrimaryStorageFromList } from '@/local-db/storageUtils'
import type { Category, Storage } from '@/local-db/models'

export const PRODUCT_FORM_INITIALIZATION_VERSION = 1 as const
export const PRODUCT_FORM_INITIALIZATION_STORAGE_KEY = 'product_form_initialization_v1'

export type EmptyOrStaticRule =
    | { type: 'empty' }
    | { type: 'static'; value: string }

export type ProductFormInitializationRules = {
    version: typeof PRODUCT_FORM_INITIALIZATION_VERSION
    workspaceId: string
    rules: {
        name: EmptyOrStaticRule
        sku: { type: 'system' }
        unit: { type: 'static'; value: string }
        category: EmptyOrStaticRule
        storage: { type: 'system' } | { type: 'dynamic'; value: 'active' } | { type: 'static'; value: string }
        description: EmptyOrStaticRule
        price: EmptyOrStaticRule
        costPrice: EmptyOrStaticRule
        quantity: EmptyOrStaticRule
        minStockLevel: EmptyOrStaticRule
    }
}

export interface ProductFormInitializationValues {
    name: string
    sku: string
    description: string
    categoryId: string | undefined
    price: string
    costPrice: string
    quantity: number | ''
    minStockLevel: number | ''
    unit: string
    storageId: string
}

function workspaceStorageKey(workspaceId: string) {
    return `${PRODUCT_FORM_INITIALIZATION_STORAGE_KEY}:${encodeURIComponent(workspaceId)}`
}

function isEmptyOrStaticRule(value: unknown): value is EmptyOrStaticRule {
    if (!value || typeof value !== 'object') return false
    const rule = value as Record<string, unknown>
    return rule.type === 'empty' || (rule.type === 'static' && typeof rule.value === 'string')
}

function isNonNegativeNumericRule(value: unknown) {
    if (!isEmptyOrStaticRule(value)) return false
    if (value.type === 'empty') return true
    if (!/^\d+(?:\.\d*)?$/.test(value.value)) return false
    const parsed = Number(value.value)
    return Number.isFinite(parsed) && parsed >= 0 && (value.value.split('.')[1]?.length ?? 0) <= 4
}

function isProductFormInitializationRules(value: unknown, workspaceId: string): value is ProductFormInitializationRules {
    if (!value || typeof value !== 'object') return false
    const config = value as Record<string, unknown>
    if (config.version !== PRODUCT_FORM_INITIALIZATION_VERSION || config.workspaceId !== workspaceId) return false
    if (!config.rules || typeof config.rules !== 'object') return false

    const rules = config.rules as Record<string, unknown>
    const storage = rules.storage as Record<string, unknown> | undefined
    return isEmptyOrStaticRule(rules.name)
        && (rules.name.type === 'empty' || rules.name.value.trim().length > 0)
        && !!rules.sku && typeof rules.sku === 'object' && (rules.sku as Record<string, unknown>).type === 'system'
        && !!rules.unit && typeof rules.unit === 'object'
        && (rules.unit as Record<string, unknown>).type === 'static'
        && typeof (rules.unit as Record<string, unknown>).value === 'string'
        && (rules.unit as Record<string, string>).value.trim().length > 0
        && isEmptyOrStaticRule(rules.category)
        && (rules.category.type === 'empty' || rules.category.value.trim().length > 0)
        && !!storage && (
            storage.type === 'system'
            || (storage.type === 'dynamic' && storage.value === 'active')
            || (storage.type === 'static' && typeof storage.value === 'string' && storage.value.trim().length > 0)
        )
        && isEmptyOrStaticRule(rules.description)
        && isNonNegativeNumericRule(rules.price)
        && isNonNegativeNumericRule(rules.costPrice)
        && isNonNegativeNumericRule(rules.quantity)
        && isNonNegativeNumericRule(rules.minStockLevel)
}

export function readProductFormInitializationRules(workspaceId: string): ProductFormInitializationRules | null {
    if (!workspaceId || typeof localStorage === 'undefined') return null

    try {
        const raw = localStorage.getItem(workspaceStorageKey(workspaceId))
        if (!raw) return null
        const parsed: unknown = JSON.parse(raw)
        return isProductFormInitializationRules(parsed, workspaceId) ? parsed : null
    } catch {
        return null
    }
}

export function saveProductFormInitializationRules(config: ProductFormInitializationRules): boolean {
    if (!config.workspaceId
        || typeof localStorage === 'undefined'
        || !isProductFormInitializationRules(config, config.workspaceId)) return false

    try {
        localStorage.setItem(workspaceStorageKey(config.workspaceId), JSON.stringify(config))
        return true
    } catch {
        return false
    }
}

export function clearProductFormInitializationRules(workspaceId: string): boolean {
    if (!workspaceId || typeof localStorage === 'undefined') return false

    try {
        localStorage.removeItem(workspaceStorageKey(workspaceId))
        return true
    } catch {
        return false
    }
}

export function createDefaultProductFormInitializationRules(
    workspaceId: string,
    units: readonly string[],
    storages: readonly Storage[],
): ProductFormInitializationRules {
    const availableStorages = storages.filter((storage) => !storage.isDeleted)
    const storageRule: ProductFormInitializationRules['rules']['storage'] = availableStorages.length === 1
        ? { type: 'static', value: availableStorages[0].id }
        : availableStorages.length > 1
            ? { type: 'dynamic', value: 'active' }
            : { type: 'system' }

    return {
        version: PRODUCT_FORM_INITIALIZATION_VERSION,
        workspaceId,
        rules: {
            name: { type: 'empty' },
            sku: { type: 'system' },
            unit: { type: 'static', value: units.includes('pcs') ? 'pcs' : (units[0] ?? 'pcs') },
            category: { type: 'empty' },
            storage: storageRule,
            description: { type: 'empty' },
            price: { type: 'empty' },
            costPrice: { type: 'empty' },
            quantity: { type: 'empty' },
            minStockLevel: { type: 'static', value: '0' },
        },
    }
}

function configuredString(rule: EmptyOrStaticRule) {
    return rule.type === 'static' ? rule.value : ''
}

function configuredNumber(rule: EmptyOrStaticRule): number | '' {
    if (rule.type === 'empty' || rule.value.trim() === '') return ''
    const value = Number(rule.value)
    return Number.isFinite(value) ? value : ''
}

export function applyProductFormInitializationRules(
    base: ProductFormInitializationValues,
    config: ProductFormInitializationRules,
    catalogs: { units: readonly string[]; categories: readonly Category[]; storages: readonly Storage[] },
): ProductFormInitializationValues {
    const activeStorages = catalogs.storages.filter((storage) => !storage.isDeleted)
    const primaryStorage = getPrimaryStorageFromList(activeStorages)?.id ?? ''
    const storageRule = config.rules.storage
    const categoryRule = config.rules.category
    const configuredStorage = storageRule.type === 'dynamic'
        ? primaryStorage
        : storageRule.type === 'static'
            ? activeStorages.some((storage) => storage.id === storageRule.value)
                ? storageRule.value
                : primaryStorage
            : base.storageId

    return {
        ...base,
        name: configuredString(config.rules.name),
        // SKU remains system-managed so the existing automation stays authoritative.
        description: configuredString(config.rules.description),
        categoryId: categoryRule.type === 'static'
            && catalogs.categories.some((category) => category.id === categoryRule.value && !category.isDeleted)
            ? categoryRule.value
            : undefined,
        unit: catalogs.units.includes(config.rules.unit.value) ? config.rules.unit.value : base.unit,
        storageId: configuredStorage,
        price: configuredString(config.rules.price),
        costPrice: configuredString(config.rules.costPrice),
        quantity: configuredNumber(config.rules.quantity),
        minStockLevel: configuredNumber(config.rules.minStockLevel),
    }
}
