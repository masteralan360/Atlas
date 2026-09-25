import { describe, expect, it } from 'vitest'
import {
    freshPosClient, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('POS · hosted remote contract', () => {
    setupHostedPos()

    it('refuses a checkout payload claiming another workspace before writing any sale or payment', async () => {
        await withLivePosFixture(async ({ ids, product, storage, input }) => {
            const client = await freshPosClient()
            try {
                const checkout = input()
                checkout.payload.workspace_id = crypto.randomUUID()
                ids.saleId = checkout.payload.id
                recordPosFixture(ids)
                const { error } = await client.rpc('complete_sale', { payload: checkout.payload })
                expect(error).toBeTruthy()
                const sales = requirePosLiveData(await client.from('sales')
                    .select('id').eq('id', checkout.payload.id), 'unauthorized POS sale')
                const payments = requirePosLiveData(await client.from('payment_transactions')
                    .select('id').eq('workspace_id', livePosWorkspaceId)
                    .eq('source_record_id', checkout.payload.id), 'unauthorized POS payment')
                const stock = requirePosLiveData(await client.from('inventory')
                    .select('quantity').eq('product_id', product.id).eq('storage_id', storage.id).single(), 'unchanged POS stock')
                expect(sales).toHaveLength(0)
                expect(payments).toHaveLength(0)
                expect(Number(stock.quantity)).toBe(20)
            } finally { await client.auth.signOut() }
        })
    }, 120_000)
})
