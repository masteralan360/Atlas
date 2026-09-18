import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StockBatch } from './models'

const testState = vi.hoisted(() => ({
    batches: [] as StockBatch[],
    inventoryByPosition: new Map<string, number>()
}))

vi.mock('./database', () => ({
    db: {
        products: {},
        stock_batches: {
            where: vi.fn(() => ({
                equals: vi.fn(([productId, storageId]: [string, string]) => ({
                    and: vi.fn((predicate: (batch: StockBatch) => boolean) => ({
                        toArray: vi.fn(async () => testState.batches.filter((batch) =>
                            batch.productId === productId
                            && batch.storageId === storageId
                            && predicate(batch)
                        ))
                    }))
                }))
            }))
        }
    }
}))

vi.mock('./inventory', () => ({
    getInventoryQuantityForProductStorage: vi.fn(async (productId: string, storageId: string) =>
        testState.inventoryByPosition.get(`${productId}:${storageId}`) ?? 0
    ),
    useInventoryProducts: vi.fn(() => [])
}))

vi.mock('./storagePermissions', () => ({
    assertCurrentUserCanAccessStorage: vi.fn(async () => undefined),
    canAccessStorage: vi.fn(() => true),
    useStorageAccess: vi.fn(() => ({ isAdmin: true, excludedStorageIds: new Set() }))
}))

vi.mock('./offlineMutations', () => ({
    addToOfflineMutations: vi.fn()
}))

vi.mock('@/hooks/useNetworkStatus', () => ({
    useNetworkStatus: vi.fn(() => false)
}))

vi.mock('@/lib/network', () => ({
    isOnline: vi.fn(() => false)
}))

vi.mock('@/lib/supabaseSchema', () => ({
    getSupabaseClientForTable: vi.fn()
}))

vi.mock('@/lib/supabaseRequest', () => ({
    runSupabaseAction: vi.fn()
}))

vi.mock('@/lib/utils', () => ({
    generateId: vi.fn(() => 'generated-id'),
    toCamelCase: vi.fn((value: Record<string, unknown>) => value),
    toSnakeCase: vi.fn((value: Record<string, unknown>) => value)
}))

vi.mock('@/workspace/workspaceMode', () => ({
    isLocalWorkspaceMode: vi.fn(() => true)
}))

import {
    calculateStockBatchUnitCost,
    getStockBatchSalePlans,
    planStockBatchTransfer,
    splitStockBatchAllocationsForReturn,
    shouldCreatePurchaseCostBatch
} from './stockBatches'

function createBatch(overrides: Partial<StockBatch>): StockBatch {
    return {
        id: 'batch-1',
        workspaceId: 'workspace-1',
        productId: 'product-1',
        storageId: 'storage-1',
        batchNumber: 'B-1',
        quantity: 1,
        price: 20,
        costPrice: 10,
        currency: 'usd',
        expiryDate: null,
        manufacturingDate: null,
        notes: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        isDeleted: false,
        syncStatus: 'synced',
        lastSyncedAt: '2026-01-01T00:00:00.000Z',
        ...overrides
    }
}

describe('stock batch costing', () => {
    it('creates a purchase batch only when the line cost differs from the product cost', () => {
        expect(shouldCreatePurchaseCostBatch(10, 10, 'usd')).toBe(false)
        expect(shouldCreatePurchaseCostBatch(10.004, 10, 'usd')).toBe(false)
        expect(shouldCreatePurchaseCostBatch(10.01, 10, 'usd')).toBe(true)
        expect(shouldCreatePurchaseCostBatch(10_000.4, 10_000, 'iqd')).toBe(false)
        expect(shouldCreatePurchaseCostBatch(10_001, 10_000, 'iqd')).toBe(true)
    })

    it('calculates weighted unit cost from all consumed batches', () => {
        const result = calculateStockBatchUnitCost([
            {
                batchId: 'batch-1',
                batchNumber: 'B-1',
                quantity: 3,
                costPrice: 10,
                currency: 'usd'
            },
            {
                batchId: 'batch-2',
                batchNumber: 'B-2',
                quantity: 2,
                costPrice: 14,
                currency: 'usd'
            }
        ], 8, 'usd')

        expect(result).toBeCloseTo(11.6)
    })

    it('converts each batch cost before weighting it', () => {
        const result = calculateStockBatchUnitCost([
            {
                batchId: 'batch-usd',
                batchNumber: 'USD',
                quantity: 2,
                costPrice: 10,
                currency: 'usd'
            },
            {
                batchId: 'batch-iqd',
                batchNumber: 'IQD',
                quantity: 1,
                costPrice: 18_000,
                currency: 'iqd'
            }
        ], 0, 'iqd', (amount, from, to) => {
            if (from === 'usd' && to === 'iqd') {
                return amount * 1_500
            }
            return amount
        })

        expect(result).toBe(16_000)
    })

    it('uses the product cost for the unbatched portion of a sale', () => {
        const result = calculateStockBatchUnitCost([
            {
                batchId: 'exception-batch',
                batchNumber: 'EXCEPTION',
                quantity: 2,
                costPrice: 14,
                currency: 'usd'
            }
        ], 10, 'usd', undefined, 5)

        expect(result).toBe(11.6)
    })
})

describe('multi-line stock batch allocation', () => {
    beforeEach(() => {
        testState.batches = [
            createBatch({
                id: 'batch-early',
                batchNumber: 'EARLY',
                quantity: 4,
                expiryDate: '2026-07-01',
                costPrice: 10
            }),
            createBatch({
                id: 'batch-late',
                batchNumber: 'LATE',
                quantity: 3,
                expiryDate: '2026-08-01',
                costPrice: 14
            })
        ]
        testState.inventoryByPosition = new Map([
            ['product-1:storage-1', 7]
        ])
    })

    it('reserves earlier allocations before planning duplicate lines', async () => {
        const plans = await getStockBatchSalePlans([
            { productId: 'product-1', storageId: 'storage-1', quantity: 3 },
            { productId: 'product-1', storageId: 'storage-1', quantity: 2 }
        ])

        expect(plans[0].allocations).toEqual([
            expect.objectContaining({ batchId: 'batch-early', quantity: 3 })
        ])
        expect(plans[1].allocations).toEqual([
            expect.objectContaining({ batchId: 'batch-early', quantity: 1 }),
            expect.objectContaining({ batchId: 'batch-late', quantity: 1 })
        ])
    })

    it('rejects requests whose combined quantity exceeds batch coverage', async () => {
        await expect(getStockBatchSalePlans([
            { productId: 'product-1', storageId: 'storage-1', quantity: 4 },
            { productId: 'product-1', storageId: 'storage-1', quantity: 4 }
        ])).rejects.toThrow('Insufficient inventory')
    })

    it('allows ordinary inventory to cover quantity beyond exceptional batches', async () => {
        testState.inventoryByPosition.set('product-1:storage-1', 10)

        const [plan] = await getStockBatchSalePlans([
            { productId: 'product-1', storageId: 'storage-1', quantity: 9 }
        ])

        expect(plan.requestedQuantity).toBe(9)
        expect(plan.allocations.reduce((sum, allocation) => sum + allocation.quantity, 0)).toBe(7)
    })

    it('allocates fractional sale quantities from batches', async () => {
        const [plan] = await getStockBatchSalePlans([
            { productId: 'product-1', storageId: 'storage-1', quantity: 2.5 }
        ])

        expect(plan.requestedQuantity).toBe(2.5)
        expect(plan.allocations).toEqual([
            expect.objectContaining({ batchId: 'batch-early', quantity: 2.5 })
        ])
    })

    it('uses the batch explicitly selected on a sales-order line', async () => {
        const [plan] = await getStockBatchSalePlans([
            {
                productId: 'product-1',
                storageId: 'storage-1',
                quantity: 2,
                selectedBatchAllocations: [{ batchId: 'batch-late', quantity: 2 }]
            }
        ])

        expect(plan.allocations).toEqual([
            expect.objectContaining({ batchId: 'batch-late', quantity: 2 })
        ])
    })

    it('keeps an explicitly selected regular-stock line out of batches', async () => {
        testState.inventoryByPosition.set('product-1:storage-1', 10)

        const [plan] = await getStockBatchSalePlans([
            {
                productId: 'product-1',
                storageId: 'storage-1',
                quantity: 3,
                selectedBatchAllocations: []
            }
        ])

        expect(plan.allocations).toEqual([])
    })
})

describe('stock batch transfer planning', () => {
    const batches = [
        createBatch({
            id: 'batch-early',
            batchNumber: 'EARLY',
            quantity: 3,
            expiryDate: '2026-07-01'
        }),
        createBatch({
            id: 'batch-late',
            batchNumber: 'LATE',
            quantity: 2,
            expiryDate: '2026-08-01'
        })
    ]

    it('uses FEFO batches before regular stock for callers without an explicit selection', () => {
        const plan = planStockBatchTransfer({
            inventoryQuantity: 8,
            batches,
            requestedQuantity: 6
        })

        expect(plan.batchAllocations).toEqual([
            expect.objectContaining({ batchId: 'batch-early', quantity: 3 }),
            expect.objectContaining({ batchId: 'batch-late', quantity: 2 })
        ])
        expect(plan.unbatchedQuantity).toBe(1)
    })

    it('moves only the explicitly selected batch and regular-stock remainder', () => {
        const plan = planStockBatchTransfer({
            inventoryQuantity: 8,
            batches,
            requestedQuantity: 4,
            selectedBatchAllocations: [
                { batchId: 'batch-late', quantity: 1 }
            ]
        })

        expect(plan.batchAllocations).toEqual([
            expect.objectContaining({ batchId: 'batch-late', quantity: 1 })
        ])
        expect(plan.unbatchedQuantity).toBe(3)
    })

    it('allows a regular-stock-only transfer when batches exist', () => {
        const plan = planStockBatchTransfer({
            inventoryQuantity: 8,
            batches,
            requestedQuantity: 3,
            selectedBatchAllocations: []
        })

        expect(plan.batchAllocations).toEqual([])
        expect(plan.unbatchedQuantity).toBe(3)
    })

    it('plans fractional transfer quantities', () => {
        const plan = planStockBatchTransfer({
            inventoryQuantity: 8,
            batches,
            requestedQuantity: 3.5
        })

        expect(plan.batchAllocations).toEqual([
            expect.objectContaining({ batchId: 'batch-early', quantity: 3 }),
            expect.objectContaining({ batchId: 'batch-late', quantity: 0.5 })
        ])
        expect(plan.unbatchedQuantity).toBe(0)
    })

    it('rejects regular-stock quantity beyond the unbatched balance', () => {
        expect(() => planStockBatchTransfer({
            inventoryQuantity: 8,
            batches,
            requestedQuantity: 4,
            selectedBatchAllocations: []
        })).toThrow('Insufficient regular stock')
    })
})

describe('stock batch return splitting', () => {
    it('splits fractional batch allocations for partial returns', () => {
        const result = splitStockBatchAllocationsForReturn([
            {
                batchId: 'batch-early',
                batchNumber: 'EARLY',
                quantity: 2.5
            }
        ], 1.25)

        expect(result.restoredAllocations).toEqual([
            expect.objectContaining({ batchId: 'batch-early', quantity: 1.25 })
        ])
        expect(result.remainingAllocations).toEqual([
            expect.objectContaining({ batchId: 'batch-early', quantity: 1.25 })
        ])
    })
})
