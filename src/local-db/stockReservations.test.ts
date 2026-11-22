import { beforeEach, describe, expect, it, vi } from 'vitest'

const stockAvailabilityMock = vi.hoisted(() => {
    let cachedRows: Array<Record<string, unknown>> = []
    const rpc = vi.fn()

    return {
        rpc,
        cacheOfflineStockAvailability: vi.fn(async (_workspaceId: string, rows: Array<Record<string, unknown>>) => {
            cachedRows = rows
        }),
        readOfflineStockAvailability: vi.fn(async () => cachedRows),
        setCachedRows(rows: Array<Record<string, unknown>>) {
            cachedRows = rows
        },
        reset() {
            cachedRows = []
            rpc.mockReset()
            this.cacheOfflineStockAvailability.mockClear()
            this.readOfflineStockAvailability.mockClear()
        }
    }
})

vi.mock('./database', () => ({ db: {} }))
vi.mock('./offlineStockContext', () => ({ currentStockOperation: () => null }))
vi.mock('./offlineStockAvailability', () => ({
    cacheOfflineStockAvailability: stockAvailabilityMock.cacheOfflineStockAvailability,
    readOfflineStockAvailability: stockAvailabilityMock.readOfflineStockAvailability
}))
vi.mock('@/auth/supabase', () => ({ supabase: { rpc: stockAvailabilityMock.rpc } }))
vi.mock('@/auth', () => ({ useOptionalAuth: () => ({ user: null }) }))
vi.mock('@/hooks/useNetworkStatus', () => ({ useNetworkStatus: () => true }))
vi.mock('@/lib/network', () => ({ isOnline: () => true }))
vi.mock('@/permissions/useViewOwnRecordScope', () => ({ useViewOwnRecordScope: () => ({ isRestricted: false }) }))
vi.mock('@/permissions/workspacePermissionsState', () => ({ useOptionalWorkspacePermissions: () => ({ permissionKeys: [] }) }))
vi.mock('./storagePermissions', () => ({ useStorageAccess: () => ({ signature: '' }) }))
vi.mock('@/workspace/workspaceMode', () => ({ isLocalWorkspaceMode: () => false }))

import { StockReservationConflictError } from '@/lib/stockReservationConflict'
import { assertStockDemands } from './stockReservationData'

const WORKSPACE_ID = '30000000-0000-4000-8000-000000000001'
const PRODUCT_ID = '30000000-0000-4000-8000-000000000002'
const STORAGE_ID = '30000000-0000-4000-8000-000000000003'
const ORDER_ID = '30000000-0000-4000-8000-000000000004'

describe('sales stock availability checks', () => {
    beforeEach(() => {
        stockAvailabilityMock.reset()
        stockAvailabilityMock.setCachedRows([{
            productId: PRODUCT_ID,
            storageId: STORAGE_ID,
            onHand: 9,
            reserved: 14,
            available: 0
        }])
    })

    it('refreshes a stale local snapshot before rejecting online Cloud or Hybrid demand', async () => {
        stockAvailabilityMock.rpc.mockResolvedValue({
            data: [{
                productId: PRODUCT_ID,
                storageId: STORAGE_ID,
                onHand: 15,
                reserved: 14,
                available: 1
            }],
            error: null
        })

        await expect(assertStockDemands(WORKSPACE_ID, [{
            productId: PRODUCT_ID,
            storageId: STORAGE_ID,
            quantity: 1
        }], ORDER_ID)).resolves.toBeUndefined()

        expect(stockAvailabilityMock.rpc).toHaveBeenCalledWith('get_stock_reservation_availability', {
            p_workspace_id: WORKSPACE_ID,
            p_positions: [{ productId: PRODUCT_ID, storageId: STORAGE_ID, quantity: 1 }],
            p_exclude_order_id: ORDER_ID
        })
        expect(stockAvailabilityMock.cacheOfflineStockAvailability).toHaveBeenCalledWith(WORKSPACE_ID, [{
            productId: PRODUCT_ID,
            storageId: STORAGE_ID,
            onHand: 15,
            reserved: 14,
            available: 1
        }], ORDER_ID)
    })

    it('blocks when the server confirms the demand exceeds free stock', async () => {
        stockAvailabilityMock.rpc.mockResolvedValue({
            data: [{
                productId: PRODUCT_ID,
                storageId: STORAGE_ID,
                onHand: 15,
                reserved: 15,
                available: 0
            }],
            error: null
        })

        await expect(assertStockDemands(WORKSPACE_ID, [{
            productId: PRODUCT_ID,
            storageId: STORAGE_ID,
            quantity: 1
        }], ORDER_ID)).rejects.toMatchObject({
            name: 'StockReservationConflictError',
            conflict: {
                workspaceId: WORKSPACE_ID,
                productId: PRODUCT_ID,
                storageId: STORAGE_ID,
                onHand: 15,
                reserved: 15,
                required: 1,
                available: 0
            }
        } satisfies Partial<StockReservationConflictError>)
    })
})
