import 'fake-indexeddb/auto'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
    const values = new Map<string, string>()
    const storage = {
        get length() {
            return values.size
        },
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
        key: (index: number) => Array.from(values.keys())[index] ?? null
    }

    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
})

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
    InventorySnapshotConflictError,
    syncInventoryRowsBestEffort
} from './inventory'
import type { Inventory } from './models'

const WORKSPACE_ID = '20000000-0000-4000-8000-000000000001'
const PRODUCT_ID = '20000000-0000-4000-8000-000000000002'
const STORAGE_ID = '20000000-0000-4000-8000-000000000003'
const INVENTORY_ID = '20000000-0000-4000-8000-000000000004'
const INVENTORY_TRANSACTION_ID = '20000000-0000-4000-8000-000000000007'
const OPERATION_ID = '20000000-0000-5000-8000-000000000005'
const CONFLICT_OPERATION_ID = '20000000-0000-5000-8000-000000000006'
const COMPLETION_OPERATION_ID = '20000000-0000-5000-8000-000000000009'
const COMPLETION_CONFLICT_OPERATION_ID = '20000000-0000-5000-8000-000000000010'

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
        writeWorkspaceModeSnapshot({ workspaceId: WORKSPACE_ID, dataMode: 'cloud' })
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
        )).rejects.toBeInstanceOf(InventorySnapshotConflictError)

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

        const hydratedRows = await hydrateInventoryProductStoragesFromSupabase(
            WORKSPACE_ID,
            PRODUCT_ID,
            [STORAGE_ID]
        )

        expect(hydratedRows).toMatchObject([{
            id: INVENTORY_ID,
            version: 8,
            isDeleted: true
        }])
        expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({
            quantity: 0,
            version: 8,
            isDeleted: true,
            syncStatus: 'synced'
        })
        expect(await getInventoryVersionForProductStorage(PRODUCT_ID, STORAGE_ID)).toBe(8)
        expect(supabaseMock.filters).not.toContainEqual(['is_deleted', false])
    })

    it('completes an existing cloud order through the atomic order and inventory RPC', async () => {
        const orderId = '20000000-0000-4000-8000-000000000008'
        const actualDeliveryDate = '2026-09-18T09:00:00.000Z'
        const orderItems = [{ id: 'line-1', productId: PRODUCT_ID, storageId: STORAGE_ID, quantity: 1 }]
        supabaseMock.rpc.mockResolvedValue({
            data: {
                order: { id: orderId, workspace_id: WORKSPACE_ID, status: 'completed', version: 3, items: orderItems },
                inventory: [{
                    id: INVENTORY_ID, workspace_id: WORKSPACE_ID, product_id: PRODUCT_ID,
                    storage_id: STORAGE_ID, quantity: 3, version: 8, is_deleted: false
                }],
                inventory_transactions: [{
                    id: INVENTORY_TRANSACTION_ID, workspace_id: WORKSPACE_ID,
                    product_id: PRODUCT_ID, storage_id: STORAGE_ID, transaction_type: 'sale',
                    quantity_delta: -1, previous_quantity: 4, new_quantity: 3,
                    reference_id: orderId, reference_type: 'sales_order', version: 1, is_deleted: false
                }],
                already_applied: false
            },
            error: null
        })

        const result = await syncInventoryRowsBestEffort(
            [inventoryRow(8)],
            WORKSPACE_ID,
            {
                operationId: COMPLETION_OPERATION_ID,
                operationKind: 'sales_order_completion',
                expectedVersions: [{ productId: PRODUCT_ID, storageId: STORAGE_ID, version: 7 }],
                salesOrderCompletion: {
                    orderId,
                    expectedOrderVersion: 2,
                    items: orderItems,
                    actualDeliveryDate
                }
            }
        )

        expect(supabaseMock.rpc).toHaveBeenCalledWith('complete_sales_order_with_inventory', {
            p_order_id: orderId,
            p_workspace_id: WORKSPACE_ID,
            p_expected_order_version: 2,
            p_operation_id: COMPLETION_OPERATION_ID,
            p_items: orderItems,
            p_actual_delivery_date: actualDeliveryDate,
            p_changes: [{
                id: INVENTORY_ID,
                product_id: PRODUCT_ID,
                storage_id: STORAGE_ID,
                quantity: 3,
                expected_version: 7
            }]
        })
        expect(result?.order).toMatchObject({ id: orderId, status: 'completed' })
        expect(await db.inventory_transactions.get(INVENTORY_TRANSACTION_ID)).toMatchObject({
            transactionType: 'sale',
            quantityDelta: -1,
            previousQuantity: 4,
            newQuantity: 3,
            referenceId: orderId,
            syncStatus: 'synced'
        })
    })

    it('surfaces an order-version conflict from atomic completion for refresh and retry', async () => {
        const orderId = '20000000-0000-4000-8000-000000000011'
        supabaseMock.rpc.mockResolvedValue({
            data: null,
            error: { code: '40001', message: 'Sales order changed on another device; refresh and retry' }
        })

        await expect(syncInventoryRowsBestEffort(
            [inventoryRow(8)],
            WORKSPACE_ID,
            {
                operationId: COMPLETION_CONFLICT_OPERATION_ID,
                operationKind: 'sales_order_completion',
                expectedVersions: [{ productId: PRODUCT_ID, storageId: STORAGE_ID, version: 7 }],
                salesOrderCompletion: {
                    orderId,
                    expectedOrderVersion: 2,
                    items: [{ id: 'line-1', productId: PRODUCT_ID, storageId: STORAGE_ID, quantity: 1 }],
                    actualDeliveryDate: '2026-09-18T09:00:00.000Z'
                }
            }
        )).rejects.toBeInstanceOf(InventorySnapshotConflictError)

        expect(supabaseMock.rpc).toHaveBeenCalledWith('complete_sales_order_with_inventory', expect.objectContaining({
            p_order_id: orderId,
            p_expected_order_version: 2,
            p_operation_id: COMPLETION_CONFLICT_OPERATION_ID
        }))
    })

    it('fails closed for a required authoritative read and leaves the cached position untouched', async () => {
        await db.inventory.put(inventoryRow(4))
        supabaseMock.setQueryResult({
            data: null,
            error: { message: 'network request failed' }
        })

        await expect(hydrateInventoryProductStoragesFromSupabase(
            WORKSPACE_ID,
            PRODUCT_ID,
            [STORAGE_ID],
            { requireAuthoritative: true }
        )).rejects.toThrow("Couldn't verify the latest stock")

        expect(await db.inventory.get(INVENTORY_ID)).toMatchObject({
            quantity: 3,
            version: 4,
            syncStatus: 'pending'
        })
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

        await expect(run()).rejects.toBeInstanceOf(InventorySnapshotConflictError)
        await expect(run()).rejects.toThrow('Stock changed while this order was being completed')
        expect(supabaseMock.rpc).toHaveBeenCalledTimes(1)
    })
})
