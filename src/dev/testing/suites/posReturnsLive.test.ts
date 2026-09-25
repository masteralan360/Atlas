import { describe, expect, it } from 'vitest'
import type { Sale } from '@/types'
import {
    freshPosClient, livePosCurrency, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('POS · hosted returns and linked reversals', () => {
    setupHostedPos()

    it('posts partial and final returns with restored stock and exact linked cash counter-entries', async () => {
        await withLivePosFixture(async ({ ids, product, storage, batch, input }) => {
            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            const { persistSaleReturnLedger } = await import('@/local-db/posSaleReturns')
            const checkout = input({ quantity: 2 })
            ids.saleId = checkout.payload.id
            recordPosFixture(ids)
            await commitPosCheckout(checkout)
            const client = await freshPosClient()
            try {
                const [line] = requirePosLiveData(await client.from('sale_items')
                    .select('id,quantity,converted_unit_price,unit_price').eq('sale_id', checkout.payload.id), 'returnable line')
                expect(line).toBeTruthy()
                for (const [index, remaining] of [1, 0].entries()) {
                    const returnId = crypto.randomUUID()
                    ids[`returnId${index + 1}`] = returnId
                    recordPosFixture(ids)
                    const itemId = crypto.randomUUID()
                    const payload = [{ id: itemId, sale_item_id: line.id, quantity: 1 }]
                    const { data, error } = await client.rpc('process_sale_return', {
                        p_return_id: returnId, p_sale_id: checkout.payload.id,
                        p_items: payload, p_return_reason: 'DEV TEST POS return', p_refund_method: null
                    })
                    if (error || !data?.success) throw new Error(`POS return RPC: ${error?.message || 'unsuccessful'}`)
                    expect(Number(data.return_value)).toBe(100)
                    const sale = {
                        id: checkout.payload.id, workspace_id: livePosWorkspaceId, origin: 'pos',
                        payment_method: 'cash', settlement_currency: livePosCurrency,
                        items: [{ id: line.id, quantity: 2, returned_quantity: index,
                            converted_unit_price: 100, unit_price: 100 }]
                    } as unknown as Sale
                    await persistSaleReturnLedger({
                        returnId, sale, reason: 'DEV TEST POS return', timestamp: new Date().toISOString(),
                        refundAmount: 100, linePayloads: payload,
                        restoredPlans: [{ storageId: storage.id, restoredBatchAllocations: [] }], pendingSync: false
                    })
                    const audit = requirePosLiveData(await client.from('sale_returns')
                        .select('id,refund_amount').eq('id', returnId).single(), 'return audit')
                    const stock = requirePosLiveData(await client.from('inventory')
                        .select('quantity').eq('product_id', product.id).eq('storage_id', storage.id).single(), 'return stock')
                    const restoredBatch = requirePosLiveData(await client.from('stock_batches')
                        .select('id,quantity').eq('id', batch!.id).single(), 'restored original batch')
                    const activeBatches = requirePosLiveData(await client.from('stock_batches')
                        .select('id').eq('workspace_id', livePosWorkspaceId)
                        .eq('product_id', product.id).eq('storage_id', storage.id)
                        .eq('batch_number', batch!.batchNumber).eq('is_deleted', false), 'active return batches')
                    const payments = requirePosLiveData(await client.from('payment_transactions')
                        .select('id,amount,reversal_of_transaction_id').eq('workspace_id', livePosWorkspaceId)
                        .eq('source_type', 'pos_sale').eq('source_record_id', checkout.payload.id), 'return payments')
                    expect(audit.id).toBe(returnId)
                    expect(Number(audit.refund_amount)).toBe(100)
                    expect(Number(stock.quantity)).toBe(20 - remaining)
                    expect(Number(restoredBatch.quantity)).toBe(20 - remaining)
                    expect(activeBatches.map((row: { id: string }) => row.id)).toEqual([batch!.id])
                    expect(payments).toHaveLength(index + 2)
                    const original = payments.find((row: { amount: number }) => Number(row.amount) > 0)
                    expect(original).toBeTruthy()
                    for (const reversal of payments.filter((row: { amount: number }) => Number(row.amount) < 0)) {
                        expect(reversal.reversal_of_transaction_id).toBe(original!.id)
                        expect(Number(reversal.amount)).toBe(-100)
                    }
                    expect(payments.reduce((sum: number, row: { amount: number }) => sum + Number(row.amount), 0)).toBe(100 * remaining)
                }
            } finally { await client.auth.signOut() }
        })
    }, 120_000)
})
