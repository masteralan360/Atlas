import { describe, expect, it } from 'vitest'
import {
    freshPosClient, livePosCurrency, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('POS · hosted pricing', () => {
    setupHostedPos()

    it('keeps a fractional negotiated sale total equal to its hosted payment and line total', async () => {
        await withLivePosFixture(async ({ ids, product, storage, input }) => {
            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            const checkout = input({ quantity: 2.5, unitPrice: 10.125 })
            checkout.payload.items[0].negotiated_price = 10.125
            ids.saleId = checkout.payload.id
            recordPosFixture(ids)
            await commitPosCheckout(checkout)
            const fresh = await freshPosClient()
            try {
                const sale = requirePosLiveData(await fresh.from('sales')
                    .select('total_amount,settlement_currency').eq('id', checkout.payload.id).single(), 'priced sale')
                const line = requirePosLiveData(await fresh.from('sale_items')
                    .select('quantity,unit_price,converted_unit_price,negotiated_price,total_price')
                    .eq('sale_id', checkout.payload.id).single(), 'priced line')
                const payment = requirePosLiveData(await fresh.from('payment_transactions')
                    .select('amount').eq('workspace_id', livePosWorkspaceId)
                    .eq('source_record_id', checkout.payload.id).single(), 'priced payment')
                const stock = requirePosLiveData(await fresh.from('inventory')
                    .select('quantity').eq('product_id', product.id).eq('storage_id', storage.id).single(), 'priced stock')
                expect(sale.settlement_currency).toBe(livePosCurrency)
                expect(Number(line.quantity)).toBe(2.5)
                expect(Number(line.unit_price)).toBe(10.125)
                expect(Number(line.converted_unit_price)).toBeCloseTo(10.125, 3)
                expect(Number(line.negotiated_price)).toBeCloseTo(10.125, 3)
                expect(Number(stock.quantity)).toBe(17.5)
                expect(Number(line.total_price)).toBe(25.3125)
                expect(Number(sale.total_amount)).toBe(25.3125)
                expect(Number(payment.amount)).toBe(25.3125)
            } finally { await fresh.auth.signOut() }
        }, { price: 20, costPrice: 4 })
    }, 120_000)
})
