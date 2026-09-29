import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTestBrowser } from '../fixtures/browser'
import { db } from '@/local-db/database'
import type { Product } from '@/local-db/models'
import { setActiveBusinessUser, setActiveBusinessWorkspace, setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000b21'
const USER_ID = '00000000-0000-4000-8000-000000000b22'

const remote = vi.hoisted(() => ({
    calls: [] as Array<{ table: string; operation: 'insert' | 'update'; payload: Record<string, unknown>; id?: string }>,
    insertError: null as null | { message: string; code?: string },
    updateError: null as null | { message: string; code?: string }
}))

vi.mock('@/auth/supabase', () => ({
    isSupabaseConfigured: true,
    isBackendConfigurationRequired: false,
    supabase: {
        schema: () => ({
            from: (table: string) => ({
                insert: async (payload: Record<string, unknown>) => {
                    remote.calls.push({ table, operation: 'insert', payload })
                    return { data: null, error: remote.insertError }
                },
                update: (payload: Record<string, unknown>) => ({
                    eq: async (_column: string, id: string) => {
                        remote.calls.push({ table, operation: 'update', payload, id })
                        return { data: null, error: remote.updateError }
                    }
                })
            })
        }),
        from: (table: string) => ({
            insert: async (payload: Record<string, unknown>) => {
                remote.calls.push({ table, operation: 'insert', payload })
                return { data: null, error: remote.insertError }
            },
            update: (payload: Record<string, unknown>) => ({
                eq: async (_column: string, id: string) => {
                    remote.calls.push({ table, operation: 'update', payload, id })
                    return { data: null, error: remote.updateError }
                }
            })
        }),
        rpc: async () => ({ data: null, error: null }),
        auth: {
            getSession: async () => ({
                data: { session: { user: { id: USER_ID } } }
            })
        }
    }
}))

let createProduct: typeof import('@/local-db/hooks').createProduct
let updateProduct: typeof import('@/local-db/hooks').updateProduct

function input(sku: string): Omit<Product,
    'id' | 'workspaceId' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'lastSyncedAt' | 'version' | 'isDeleted'> {
    return {
        sku, name: 'Remote product', description: 'Request contract', categoryId: null,
        category: null, storageId: null, price: 1250, minimumSellingPrice: 900, costPrice: 700, quantity: 0,
        minStockLevel: 2, unit: 'pcs', currency: 'iqd', imageUrl: '',
        canBeReturned: true, returnRules: ''
    }
}

describe('Products · Cloud / Hybrid request contracts', () => {
    beforeAll(async () => {
        installTestBrowser()
        const hooks = await import('@/local-db/hooks')
        createProduct = hooks.createProduct
        updateProduct = hooks.updateProduct
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        remote.calls = []
        remote.insertError = null
        remote.updateError = null
        setNetworkStatus(true)
        setActiveBusinessWorkspace(WORKSPACE_ID)
        setActiveBusinessUser(USER_ID, 'admin', WORKSPACE_ID)
    })

    afterAll(async () => {
        await db.delete()
        setActiveBusinessUser(null)
        setActiveBusinessWorkspace(null)
        setNetworkStatus(true)
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
    })

    for (const mode of ['cloud', 'hybrid'] as const) {
        it(`${mode}: sends scoped product fields and updates the local cache only after remote acknowledgement`, async () => {
            writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: mode })
            const product = await createProduct(WORKSPACE_ID, input(`REMOTE-${mode.toUpperCase()}`))
            expect(remote.calls[0]).toMatchObject({
                table: 'products', operation: 'insert',
                payload: expect.objectContaining({
                    workspace_id: WORKSPACE_ID,
                    sku: `REMOTE-${mode.toUpperCase()}`,
                    name: 'Remote product',
                    price: 1250,
                    minimum_selling_price: 900,
                    cost_price: 700,
                    currency: 'iqd'
                })
            })
            expect(await db.products.get(product.id)).toMatchObject({ id: product.id, syncStatus: 'synced' })

            await updateProduct(product.id, { name: 'Updated remote product', price: 1500, minimumSellingPrice: 1000 })
            expect(remote.calls).toHaveLength(2)
            expect(remote.calls[1]).toMatchObject({
                table: 'products', operation: 'update', id: product.id,
                payload: expect.objectContaining({ name: 'Updated remote product', price: 1500, minimum_selling_price: 1000 })
            })
            expect(await db.products.get(product.id)).toMatchObject({ name: 'Updated remote product', price: 1500, minimumSellingPrice: 1000, version: 2 })

            await updateProduct(product.id, { minimumSellingPrice: null })
            expect(remote.calls[2]).toMatchObject({
                table: 'products', operation: 'update', id: product.id,
                payload: expect.objectContaining({ minimum_selling_price: null })
            })
            expect(await db.products.get(product.id)).toMatchObject({ minimumSellingPrice: null, version: 3 })
        })
    }

    it('does not cache a product or queue a mutation when Supabase rejects its insert', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
        remote.insertError = { message: 'permission denied', code: '42501' }

        await expect(createProduct(WORKSPACE_ID, input('REMOTE-REJECTED'))).rejects.toThrow()
        expect(remote.calls).toHaveLength(1)
        expect(await db.products.count()).toBe(0)
        expect(await db.offline_mutations.count()).toBe(0)
    })

    it('keeps the prior cached product when an online edit is rejected', async () => {
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
        const product = await createProduct(WORKSPACE_ID, input('REMOTE-UNCHANGED'))
        remote.updateError = { message: 'permission denied', code: '42501' }

        await expect(updateProduct(product.id, { name: 'Rejected update', minimumSellingPrice: 900 })).rejects.toThrow()
        expect(await db.products.get(product.id)).toMatchObject({ name: 'Remote product', minimumSellingPrice: 900, version: 1 })
        expect(await db.offline_mutations.count()).toBe(0)
    })
})
