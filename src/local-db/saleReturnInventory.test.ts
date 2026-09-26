import 'fake-indexeddb/auto'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
    const values = new Map<string, string>()
    const storage = {
        get length() { return values.size },
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
        key: (index: number) => Array.from(values.keys())[index] ?? null
    }
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', storage)
    vi.stubGlobal('navigator', { onLine: false })
    vi.stubGlobal('document', {
        visibilityState: 'visible',
        dir: 'ltr',
        documentElement: { lang: 'en', dir: 'ltr' },
        addEventListener: () => undefined,
        removeEventListener: () => undefined
    })
    vi.stubGlobal('location', { hash: '', origin: 'http://localhost', pathname: '/' })
    vi.stubGlobal('addEventListener', () => undefined)
    vi.stubGlobal('removeEventListener', () => undefined)
    vi.stubGlobal('window', globalThis)
})

import { supabase } from '@/auth/supabase'
import i18n from '@/i18n/config'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import { adjustInventoryQuantity } from './inventory'
import { applyOfflinePosStockEffects } from './offlinePosStock'
import { resolveReturnStorageId } from './storageUtils'

const WORKSPACE_ID = 'local-sale-return-workspace'
const STAFF_ID = 'local-sale-return-staff'
const PRODUCT_ID = 'local-sale-return-product'
const STORAGE_ID = 'local-sale-return-storage'
const EXCLUDED_STORAGE_ID = 'local-sale-return-excluded-storage'
const INVENTORY_ID = 'local-sale-return-inventory'
const RETURN_ID = 'local-sale-return-header'
const SALE_ID = 'local-sale-return-sale'
const TIMESTAMP = '2026-09-16T10:00:00.000Z'
const base = {
    workspaceId: WORKSPACE_ID,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    version: 1,
    isDeleted: false,
    syncStatus: 'synced' as const,
    lastSyncedAt: TIMESTAMP
}

async function seedStaffInventory() {
    await db.users.put({ id: STAFF_ID, ...base, email: 'staff@example.com', name: 'Staff', role: 'staff' })
    await db.storages.bulkPut([STORAGE_ID, EXCLUDED_STORAGE_ID].map((id) => ({
        id, ...base, name: id, isSystem: false, isProtected: false,
        isPrimary: id === STORAGE_ID, isMarketplace: false
    })))
    await db.storage_member_exclusions.put({
        id: 'staff-exclusion', ...base, storageId: EXCLUDED_STORAGE_ID, userId: STAFF_ID
    })
    await db.products.put({
        id: PRODUCT_ID, ...base, sku: 'RETURN', name: 'Returned product', description: '',
        price: 10, costPrice: 4, quantity: 0, minStockLevel: 0, unit: 'pcs', currency: 'usd',
        canBeReturned: true
    })
    await db.inventory.put({
        id: INVENTORY_ID, ...base, productId: PRODUCT_ID, storageId: STORAGE_ID, quantity: 0,
        isDeleted: true
    })
}

async function restoreReturnInventory(quantityDelta: number) {
    const storageId = await resolveReturnStorageId({
        workspaceId: WORKSPACE_ID, productId: PRODUCT_ID, saleStorageId: STORAGE_ID
    })
    expect(storageId).toBe(STORAGE_ID)
    // The same inventory operation used by Sales.restoreInventoryForReturn.
    return adjustInventoryQuantity({
        workspaceId: WORKSPACE_ID, productId: PRODUCT_ID, storageId: storageId!,
        quantityDelta, timestamp: TIMESTAMP,
        movement: {
            productId: PRODUCT_ID,
            storageId: storageId!,
            transactionType: 'return',
            referenceId: RETURN_ID,
            referenceType: 'pos_return'
        }
    })
}

describe('Local mode sale return inventory for staff', () => {
    beforeAll(async () => {
        await db.open()
        await i18n.changeLanguage('en')
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        localStorage.clear()
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'local' })
        setActiveBusinessWorkspace(WORKSPACE_ID)
        setActiveBusinessUser(STAFF_ID, 'staff', WORKSPACE_ID)
        setNetworkStatus(false)
        await seedStaffInventory()
    })

    afterEach(() => {
        vi.restoreAllMocks()
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        setActiveBusinessUser(null)
        setActiveBusinessWorkspace(null)
        setNetworkStatus(true)
    })

    afterAll(async () => { await db.delete() })

    it.each([
        { online: false, quantity: 1 },
        { online: false, quantity: 3 },
        { online: true, quantity: 1 },
        { online: true, quantity: 3 }
    ])('restores $quantity returned units when online=$online without remote requests', async ({ online, quantity }) => {
        setNetworkStatus(online)
        vi.stubGlobal('navigator', { onLine: online })
        const fromSpy = vi.spyOn(supabase, 'from')
        const rpcSpy = vi.spyOn(supabase, 'rpc')
        const exclusion = await db.storage_member_exclusions.get('staff-exclusion')

        await expect(restoreReturnInventory(quantity)).resolves.toMatchObject({
            quantity, storageId: STORAGE_ID
        })
        expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity, isDeleted: false })
        expect(await db.products.get(PRODUCT_ID)).toMatchObject({ quantity, storageId: STORAGE_ID })
        expect(await db.inventory_transactions.toArray()).toEqual([
            expect.objectContaining({
                productId: PRODUCT_ID,
                storageId: STORAGE_ID,
                transactionType: 'return',
                quantityDelta: quantity,
                previousQuantity: 0,
                newQuantity: quantity,
                referenceId: RETURN_ID,
                referenceType: 'pos_return'
            })
        ])
        expect(await db.storage_member_exclusions.get('staff-exclusion')).toEqual(exclusion)
        expect(fromSpy).not.toHaveBeenCalled()
        expect(rpcSpy).not.toHaveBeenCalled()
        expect(await db.offline_mutations.count()).toBe(0)
    })

    it('uses the profile mirror when the staff user is absent from the users mirror', async () => {
        await db.users.delete(STAFF_ID)
        await db.profiles.put({ id: STAFF_ID, workspaceId: WORKSPACE_ID, name: 'Staff', role: 'staff' })

        await expect(restoreReturnInventory(1)).resolves.toMatchObject({ quantity: 1 })
        expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 1, isDeleted: false })
    })

    it('still denies an excluded storage and leaves inventory unchanged', async () => {
        const product = await db.products.get(PRODUCT_ID)
        const inventory = await db.inventory.get(INVENTORY_ID)

        await expect(adjustInventoryQuantity({
            workspaceId: WORKSPACE_ID, productId: PRODUCT_ID, storageId: EXCLUDED_STORAGE_ID,
            quantityDelta: 1, skipReorderCheck: true, movement: null
        })).rejects.toThrow(i18n.t('storages.permissions.errors.accessDenied'))
        expect(await db.products.get(PRODUCT_ID)).toEqual(product)
        expect(await db.inventory.get(INVENTORY_ID)).toEqual(inventory)
        expect(await db.inventory.count()).toBe(1)
    })

    it('still denies a staff user whose membership cannot be resolved', async () => {
        await db.users.delete(STAFF_ID)
        await expect(adjustInventoryQuantity({
            workspaceId: WORKSPACE_ID, productId: PRODUCT_ID, storageId: STORAGE_ID,
            quantityDelta: 1, skipReorderCheck: true, movement: null
        })).rejects.toThrow(i18n.t('storages.permissions.errors.accessDenied'))
        expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 0, isDeleted: true })
        expect(await db.products.get(PRODUCT_ID)).toMatchObject({ quantity: 0 })
    })

    it('keeps the admin override for excluded storage', async () => {
        setActiveBusinessUser(STAFF_ID, 'admin', WORKSPACE_ID)

        await expect(adjustInventoryQuantity({
            workspaceId: WORKSPACE_ID, productId: PRODUCT_ID, storageId: EXCLUDED_STORAGE_ID,
            quantityDelta: 1, skipReorderCheck: true, movement: null
        })).resolves.toMatchObject({ quantity: 1, storageId: EXCLUDED_STORAGE_ID })
    })

    it('rounds fractional restored quantities consistently', async () => {
        await restoreReturnInventory(0.1)
        await restoreReturnInventory(0.2)

        expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 0.3 })
        expect(await db.products.get(PRODUCT_ID)).toMatchObject({ quantity: 0.3 })
    })

    it.each(['staff', 'admin'] as const)('keeps nested Local POS inventory transactions working for %s', async (role) => {
        setActiveBusinessUser(STAFF_ID, role, WORKSPACE_ID)
        await restoreReturnInventory(1)

        await applyOfflinePosStockEffects({
            workspaceId: WORKSPACE_ID,
            saleId: SALE_ID,
            items: [{ productId: PRODUCT_ID, storageId: STORAGE_ID, quantity: 1 }],
            batchPlans: [],
            timestamp: TIMESTAMP
        })

        expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 0, isDeleted: true })
        expect(await db.products.get(PRODUCT_ID)).toMatchObject({ quantity: 0 })
        expect(await db.offline_mutations.count()).toBe(0)
    })

    it('rolls inventory back if updating the product snapshot fails', async () => {
        const inventory = await db.inventory.get(INVENTORY_ID)
        const product = await db.products.get(PRODUCT_ID)
        vi.spyOn(db.products, 'put').mockRejectedValueOnce(new Error('Snapshot write failed'))

        await expect(restoreReturnInventory(1)).rejects.toThrow('Snapshot write failed')
        expect(await db.inventory.get(INVENTORY_ID)).toEqual(inventory)
        expect(await db.products.get(PRODUCT_ID)).toEqual(product)
    })

    it('rejects a negative resulting stock without writing inventory', async () => {
        await expect(restoreReturnInventory(-1)).rejects.toThrow('Insufficient inventory')
        expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({ quantity: 0, isDeleted: true })
        expect(await db.products.get(PRODUCT_ID)).toMatchObject({ quantity: 0 })
    })
})
