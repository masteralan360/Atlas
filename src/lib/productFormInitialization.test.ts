import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/local-db/storageUtils', () => ({
    getPrimaryStorageFromList: (storages: Storage[]) => storages.find((storage) => storage.isPrimary) ?? storages[0],
}))

import type { Category, Storage } from '@/local-db/models'
import {
    applyProductFormInitializationRules,
    clearProductFormInitializationRules,
    createDefaultProductFormInitializationRules,
    readProductFormInitializationRules,
    saveProductFormInitializationRules,
    type ProductFormInitializationValues,
} from './productFormInitialization'

function storage(id: string, isPrimary = false): Storage {
    return { id, workspaceId: 'workspace-a', name: id, isPrimary, isDeleted: false } as Storage
}

function category(id: string): Category {
    return { id, workspaceId: 'workspace-a', name: id, isDeleted: false } as Category
}

function baseValues(): ProductFormInitializationValues {
    return {
        name: '',
        sku: '',
        description: '',
        categoryId: undefined,
        price: '',
        costPrice: '',
        quantity: '',
        minStockLevel: 0,
        unit: 'pcs',
        storageId: '',
    }
}

describe('product form initialization rules', () => {
    const originalLocalStorage = globalThis.localStorage

    afterEach(() => {
        vi.restoreAllMocks()
        if (originalLocalStorage === undefined) {
            Reflect.deleteProperty(globalThis, 'localStorage')
        } else {
            Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
        }
    })

    it('uses the specified defaults and chooses the storage rule from current availability', () => {
        const single = createDefaultProductFormInitializationRules('workspace-a', ['box', 'pcs'], [storage('only')])
        const multiple = createDefaultProductFormInitializationRules('workspace-a', ['pcs'], [storage('main', true), storage('other')])
        const none = createDefaultProductFormInitializationRules('workspace-a', ['pcs'], [])

        expect(single.rules.unit).toEqual({ type: 'static', value: 'pcs' })
        expect(single.rules.storage).toEqual({ type: 'static', value: 'only' })
        expect(multiple.rules.storage).toEqual({ type: 'dynamic', value: 'active' })
        expect(none.rules.storage).toEqual({ type: 'system' })
        expect(single.rules.name).toEqual({ type: 'empty' })
        expect(single.rules.sku).toEqual({ type: 'system' })
        expect(single.rules.minStockLevel).toEqual({ type: 'static', value: '0' })
    })

    it('applies valid values once and safely falls back for unavailable catalog identifiers', () => {
        const config = createDefaultProductFormInitializationRules('workspace-a', ['pcs', 'box'], [storage('main', true), storage('other')])
        config.rules.name = { type: 'static', value: 'Tea' }
        config.rules.category = { type: 'static', value: 'category-a' }
        config.rules.unit = { type: 'static', value: 'box' }
        config.rules.storage = { type: 'dynamic', value: 'active' }
        config.rules.description = { type: 'static', value: 'Loose leaf' }
        config.rules.price = { type: 'static', value: '0' }
        config.rules.quantity = { type: 'static', value: '12.5' }

        const applied = applyProductFormInitializationRules(baseValues(), config, {
            units: ['pcs', 'box'],
            categories: [category('category-a')],
            storages: [storage('main', true), storage('other')],
        })
        expect(applied).toMatchObject({
            name: 'Tea',
            sku: '',
            categoryId: 'category-a',
            unit: 'box',
            storageId: 'main',
            description: 'Loose leaf',
            price: '0',
            quantity: 12.5,
        })

        config.rules.category = { type: 'static', value: 'removed-category' }
        config.rules.unit = { type: 'static', value: 'removed-unit' }
        config.rules.storage = { type: 'static', value: 'removed-storage' }
        const fallback = applyProductFormInitializationRules(baseValues(), config, {
            units: ['pcs'],
            categories: [],
            storages: [storage('main', true), storage('other')],
        })
        expect(fallback.categoryId).toBeUndefined()
        expect(fallback.unit).toBe('pcs')
        expect(fallback.storageId).toBe('main')
    })

    it('persists configuration by workspace and ignores malformed or mismatched records', () => {
        const values = new Map<string, string>()
        const localStorage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        }
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage })

        const config = createDefaultProductFormInitializationRules('workspace-a', ['pcs'], [])
        expect(saveProductFormInitializationRules(config)).toBe(true)
        expect(readProductFormInitializationRules('workspace-a')).toEqual(config)
        expect(readProductFormInitializationRules('workspace-b')).toBeNull()

        values.set('product_form_initialization_v1:workspace-a', JSON.stringify({
            ...config,
            rules: { ...config.rules, price: { type: 'static', value: 'not-a-number' } },
        }))
        expect(readProductFormInitializationRules('workspace-a')).toBeNull()

        values.set('product_form_initialization_v1:workspace-a', '{broken')
        expect(readProductFormInitializationRules('workspace-a')).toBeNull()
        expect(clearProductFormInitializationRules('workspace-a')).toBe(true)
        expect(values.size).toBe(0)
    })
})
