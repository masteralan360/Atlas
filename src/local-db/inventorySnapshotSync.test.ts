import 'fake-indexeddb/auto'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const supabaseMock = vi.hoisted(() => {
    let queryResult: { data: Record<string, unknown>[] | null; error: unknown } = {
        data: [],
        error: null
    }
    const filters: Array<[string, unknown]> = []
    const query = {
        select: vi.fn(() => query),
        eq: vi.fn((column: string, value: unknown) => {
            filters.push([column, value])
            return query
        }),
        in: vi.fn((column: string, value: unknown) => {
            filters.push([column, value])
            return query
        }),
        then: (resolve: (value: typeof queryResult) => unknown) => Promise.resolve(queryResult).then(resolve)
    }
    const rpc = vi.fn()
    const from = vi.fn(() => query)

    return {
        client: { from, rpc },
        filters,
        from,
        rpc,
        setQueryResult(result: typeof queryResult) {
            queryResult = result
        },
        reset() {
            filters.length = 0
            from.mockClear()
            rpc.mockReset()
            query.select.mockClear()
            query.eq.mockClear()
            query.in.mockClear()
            queryResult = { data: [], error: null }
        }
    }
})

vi.mock('@/lib/supabaseSchema', () => ({
    getSupabaseClientForTable: vi.fn(() => supabaseMock.client)
}))

vi.mock('@/hooks/useNetworkStatus', () => ({
    useNetworkStatus: vi.fn(() => true)
}))

vi.mock('@/lib/supabaseRequest', () => ({
    isRetriableWebRequestError: vi.fn(() => false),
    normalizeSupabaseActionError: vi.fn((error: { message?: string }) => new Error(error.message ?? 'Supabase error')),
    runSupabaseAction: vi.fn((_label: string, action: () => PromiseLike<unknown>) => action())
}))

import { setNetworkStatus } from '@/lib/network'
import { clearWorkspaceModeSnapshot, writeWorkspaceModeSnapshot } from '@/workspace/workspaceMode'

import { db } from './database'
import {
    getInventoryVersionForProductStorage,
    hydrateInventoryProductStoragesFromSupabase,
    syncInventoryRowsBestEffort
} from './inventory'
import type { Inventory } from './models'

const WORKSPACE_ID = '20000000-0000-4000-8000-000000000001'
const PRODUCT_ID = '20000000-0000-4000-8000-000000000002'
const STORAGE_ID = '20000000-0000-4000-8000-000000000003'
const INVENTORY_ID = '20000000-0000-4000-8000-000000000004'
const OPERATION_ID = '20000000-0000-5000-8000-000000000005'
const CONFLICT_OPERATION_ID = '20000000-0000-5000-8000-000000000006'

function inventoryRow(version: number): Inventory {
    return {
        id: INVENTORY_ID,
        workspaceId: WORKSPACE_ID,
        productId: PRODUCT_ID,
        storageId: STORAGE_ID,
        quantity: 3,
        createdAt: '2026-09-13T12:00:00.000Z',
        updatedAt: '2026-09-13T12:01:00.000Z',
        syncStatus: 'pending',
        lastSyncedAt: null,
        version,
        isDeleted: false
    }
}

describe('authoritative inventory snapshot sync', () => {
    beforeAll(async () => {
        await db.open()
    })

    beforeEach(async () => {
        await db.delete()
        await db.open()
        supabaseMock.reset()
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'hybrid' })
        setNetworkStatus(true)
    })

    afterAll(async () => {
        clearWorkspaceModeSnapshot(WORKSPACE_ID)
        await db.delete()
    })

    it('uses the original server version and stable order operation identity', async () => {
        supabaseMock.rpc.mockResolvedValue({
            data: null,
            error: { code: '40001', message: 'Inventory changed on another device; refresh and retry' }
        })

        await expect(syncInventoryRowsBestEffort(
            [inventoryRow(7), inventoryRow(8)],
            WORKSPACE_ID,
            {
                operationId: OPERATION_ID,
                operationKind: 'sales_order_completion',
                expectedVersions: [{
                    productId: PRODUCT_ID,
                    storageId: STORAGE_ID,
                    version: 5
                }]
            }
        )).rejects.toThrow('Inventory changed on another device; refresh and retry')

        expect(supabaseMock.rpc).toHaveBeenCalledTimes(1)
        expect(supabaseMock.rpc).toHaveBeenCalledWith('apply_inventory_snapshot_changes', {
            p_operation_id: OPERATION_ID,
            p_workspace_id: WORKSPACE_ID,
            p_operation_kind: 'sales_order_completion',
            p_changes: [{
                id: INVENTORY_ID,
                product_id: PRODUCT_ID,
                storage_id: STORAGE_ID,
                quantity: 3,
                expected_version: 5
            }]
        })
    })

    it('hydrates a soft-deleted server position so restoring stock uses its real version', async () => {
        supabaseMock.setQueryResult({
            data: [{
                id: INVENTORY_ID,
                workspace_id: WORKSPACE_ID,
                product_id: PRODUCT_ID,
                storage_id: STORAGE_ID,
                quantity: 0,
                created_at: '2026-09-13T12:00:00.000Z',
                updated_at: '2026-09-13T12:01:00.000Z',
                version: 8,
                is_deleted: true
            }],
            error: null
        })

        await hydrateInventoryProductStoragesFromSupabase(
            WORKSPACE_ID,
            PRODUCT_ID,
            [STORAGE_ID]
        )

        expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({
            quantity: 0,
            version: 8,
            isDeleted: true,
            syncStatus: 'synced'
        })
        expect(await getInventoryVersionForProductStorage(PRODUCT_ID, STORAGE_ID)).toBe(8)
        expect(supabaseMock.filters).not.toContainEqual(['is_deleted', false])
    })

    it('honors the server conflict envelope and suppresses an immediate replay', async () => {
        supabaseMock.rpc.mockResolvedValue({
            data: {
                operation_id: CONFLICT_OPERATION_ID,
                inventory: null,
                already_applied: false,
                conflict: true,
                retry_after_ms: 5000
            },
            error: null
        })
        const run = () => syncInventoryRowsBestEffort([inventoryRow(6)], WORKSPACE_ID, {
            operationId: CONFLICT_OPERATION_ID,
            operationKind: 'sales_order_completion',
            expectedVersions: [{
                productId: PRODUCT_ID,
                storageId: STORAGE_ID,
                version: 5
            }]
        })

        await expect(run()).rejects.toThrow('The server did not return the updated stock')
        await expect(run()).rejects.toThrow('The server did not return the updated stock')
        expect(supabaseMock.rpc).toHaveBeenCalledTimes(1)
    })
})
