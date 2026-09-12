import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000511'
const PRODUCT_ID = '00000000-0000-4000-8000-000000000512'
const STORAGE_ID = '00000000-0000-4000-8000-000000000513'

let createStockAdjustment: typeof import('./stockAdjustments').createStockAdjustment

function installBrowserGlobals() {
    const rows = new Map<string, string>()
    const storage = {
        get length() { return rows.size },
        getItem: (key: string) => rows.get(key) ?? null,
        setItem: (key: string, value: string) => rows.set(key, value),
        removeItem: (key: string) => rows.delete(key),
        clear: () => rows.clear(),
        key: (index: number) => Array.from(rows.keys())[index] ?? null,
    }

    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { localStorage: storage, sessionStorage: storage, location: { hash: '', origin: 'http://localhost', pathname: '/' }, addEventListener: () => undefined },
    })
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { visibilityState: 'visible', dir: 'ltr', documentElement: { lang: 'en', dir: 'ltr' }, addEventListener: () => undefined, removeEventListener: () => undefined },
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
}

async function seedInventory(quantity: number) {
    const timestamp = '2026-08-03T10:00:00.000Z'
    const base = {
        workspaceId: WORKSPACE_ID,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        isDeleted: false,
        syncStatus: 'synced' as const,
        lastSyncedAt: timestamp,
    }

    await db.storages.put({
        id: STORAGE_ID,
        ...base,
        name: 'Main Storage',
        isSystem: false,
        isProtected: false,
        isPrimary: true,
        isMarketplace: false,
    })
    await db.products.put({
        id: PRODUCT_ID,
        ...base,
        sku: 'STOCK-TEST',
        name: 'Stock Test Product',
        description: '',
        categoryId: null,
        price: 10,
        costPrice: 5,
        quantity,
        minStockLevel: 0,
        unit: 'pcs',
        currency: 'usd',
        canBeReturned: true,
    })
    await db.inventory.put({
        id: '00000000-0000-4000-8000-000000000514',
        ...base,
        productId: PRODUCT_ID,
        storageId: STORAGE_ID,
        quantity,
    })
}

describe('stock adjustments', () => {
    beforeAll(async () => {
        installBrowserGlobals()
        createStockAdjustment = (await import('./stockAdjustments')).createStockAdjustment
    })

    beforeEach(async () => {
        installBrowserGlobals()
        await db.delete()
        await db.open()
        setNetworkStatus(false)
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        await seedInventory(4)
    })

    afterEach(() => {
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        setNetworkStatus(true)
    })
    afterAll(async () => { await db.delete() })

    it('uses the requested final quantity when creating the adjustment', async () => {
        const adjustment = await createStockAdjustment(WORKSPACE_ID, {
            productId: PRODUCT_ID,
            storageId: STORAGE_ID,
            adjustmentType: 'increase',
            quantity: 1,
            targetQuantity: 11,
            reason: 'purchase',
        })

        expect(adjustment).toMatchObject({ previousQuantity: 4, newQuantity: 11, quantity: 7 })
        expect(await db.inventory.where('[productId+storageId]').equals([PRODUCT_ID, STORAGE_ID]).first())
            .toMatchObject({ quantity: 11 })
        expect(await db.inventory_transactions.where('referenceId').equals(adjustment.id).first())
            .toMatchObject({ quantityDelta: 7, previousQuantity: 4, newQuantity: 11 })
    })

    it('rejects an offline stock adjustment in cloud mode without changing stock', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })

        await expect(createStockAdjustment(WORKSPACE_ID, {
            productId: PRODUCT_ID,
            storageId: STORAGE_ID,
            adjustmentType: 'increase',
            quantity: 1,
            targetQuantity: 11,
            reason: 'correction',
        })).rejects.toThrow('Connect to the internet')

        expect(await db.inventory.where('[productId+storageId]').equals([PRODUCT_ID, STORAGE_ID]).first())
            .toMatchObject({ quantity: 4 })
        expect(await db.inventory_transactions.count()).toBe(0)
        expect(await db.offline_mutations.count()).toBe(0)
    })

    it('rounds fractional target quantities to the inventory precision', async () => {
        const adjustment = await createStockAdjustment(WORKSPACE_ID, {
            productId: PRODUCT_ID,
            storageId: STORAGE_ID,
            adjustmentType: 'increase',
            quantity: 1,
            targetQuantity: 5.2345678,
            reason: 'correction',
        })

        expect(adjustment).toMatchObject({
            quantity: 1.234568,
            previousQuantity: 4,
            newQuantity: 5.234568,
        })
    })

    it('rejects a decrease below zero without changing inventory or writing a ledger row', async () => {
        await expect(createStockAdjustment(WORKSPACE_ID, {
            productId: PRODUCT_ID,
            storageId: STORAGE_ID,
            adjustmentType: 'decrease',
            quantity: 5,
            reason: 'damage',
        })).rejects.toThrow('Insufficient inventory')

        expect(await db.inventory.where('[productId+storageId]').equals([PRODUCT_ID, STORAGE_ID]).first())
            .toMatchObject({ quantity: 4 })
        expect(await db.inventory_transactions.count()).toBe(0)
        expect(await db.offline_mutations.count()).toBe(0)
    })
})
