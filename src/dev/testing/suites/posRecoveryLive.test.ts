import { describe, expect, it } from 'vitest'
import {
    freshPosClient, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('POS · hosted failure and recovery', () => {
    setupHostedPos()

    it('rejects overselling without a sale, payment, inventory, or batch change', async () => {
        await withLivePosFixture(async ({ ids, product, storage, batch, input }) => {
            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            const checkout = input({ quantity: 21 })
            ids.saleId = checkout.payload.id
            recordPosFixture(ids)
            await expect(commitPosCheckout(checkout)).rejects.toThrow()
            const fresh = await freshPosClient()
            try {
                const sales = requirePosLiveData(await fresh.from('sales')
                    .select('id').eq('id', checkout.payload.id), 'rejected sale')
                const payments = requirePosLiveData(await fresh.from('payment_transactions')
                    .select('id').eq('workspace_id', livePosWorkspaceId)
                    .eq('source_record_id', checkout.payload.id), 'rejected sale payments')
                const stock = requirePosLiveData(await fresh.from('inventory')
                    .select('quantity').eq('product_id', product.id).eq('storage_id', storage.id).single(), 'rejected stock')
                const savedBatch = requirePosLiveData(await fresh.from('stock_batches')
                    .select('quantity').eq('id', batch!.id).single(), 'rejected batch')
                expect(sales).toHaveLength(0)
                expect(payments).toHaveLength(0)
                expect(Number(stock.quantity)).toBe(20)
                expect(Number(savedBatch.quantity)).toBe(20)
            } finally { await fresh.auth.signOut() }
        })
    }, 120_000)
})
