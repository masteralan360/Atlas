import { describe, expect, it } from 'vitest'
import {
    freshPosClient, livePosCurrency, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('POS · hosted inventory and batches', () => {
    setupHostedPos()

    it('deducts a checkout across two persisted stock batches', async () => {
        await withLivePosFixture(async ({ ids, product, storage, batch, input }) => {
            const batches = await import('@/local-db/stockBatches')
            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            await batches.updateStockBatch(batch!.id, { quantity: 10 })
            const second = await batches.createStockBatch(livePosWorkspaceId, {
                productId: product.id, storageId: storage.id, batchNumber: `POS-${crypto.randomUUID().slice(0, 8)}`,
                quantity: 10, price: 100, costPrice: 40, currency: livePosCurrency,
                expiryDate: null, manufacturingDate: null, notes: null,
                sourcePurchaseOrderId: null, sourcePurchaseOrderItemId: null
            })
            ids.secondBatchId = second.id
            recordPosFixture(ids)
            const checkout = input({ quantity: 12 })
            checkout.payload.items[0].batch_allocations = [
                { batch_id: batch!.id, batch_number: batch!.batchNumber, quantity: 10,
                    price: 100, cost_price: 40, currency: livePosCurrency, expiry_date: null, manufacturing_date: null },
                { batch_id: second.id, batch_number: second.batchNumber, quantity: 2,
                    price: 100, cost_price: 40, currency: livePosCurrency, expiry_date: null, manufacturing_date: null }
            ]
            checkout.batchPlans = [{ productId: product.id, storageId: storage.id, allocations: [
                { batchId: batch!.id, batchNumber: batch!.batchNumber, quantity: 10,
                    price: 100, costPrice: 40, currency: livePosCurrency },
                { batchId: second.id, batchNumber: second.batchNumber, quantity: 2,
                    price: 100, costPrice: 40, currency: livePosCurrency }
            ] }]
            ids.saleId = checkout.payload.id
            recordPosFixture(ids)
            await commitPosCheckout(checkout)
            const fresh = await freshPosClient()
            try {
                const stock = requirePosLiveData(await fresh.from('inventory')
                    .select('quantity').eq('product_id', product.id).eq('storage_id', storage.id).single(), 'split stock')
                const savedBatches = requirePosLiveData(await fresh.from('stock_batches')
                    .select('id,quantity').in('id', [batch!.id, second.id]), 'split batches')
                const sale = requirePosLiveData(await fresh.from('sales')
                    .select('id,total_amount').eq('id', checkout.payload.id).single(), 'split sale')
                expect(Number(stock.quantity)).toBe(8)
                expect(savedBatches).toHaveLength(2)
                expect(Number(savedBatches.find((row: { id: string; quantity: number }) => row.id === batch!.id)?.quantity)).toBe(0)
                expect(Number(savedBatches.find((row: { id: string; quantity: number }) => row.id === second.id)?.quantity)).toBe(8)
                expect(Number(sale.total_amount)).toBe(1200)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
