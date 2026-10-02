import { describe, expect, it } from 'vitest'
import { addInstantPosServiceItem } from '@/lib/instantPosServiceItems'
import {
    freshPosClient, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture,
} from '../fixtures/posLive'

describe('POS · hosted Instant POS service aggregation', () => {
    setupHostedPos()

    it('persists repeated service additions as one sale line with the combined quantity', async () => {
        await withLivePosFixture(async ({ ids, product, input }) => {
            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            const serviceItem = { productId: product.id, quantity: 1, unitPrice: 100 }
            const ticketItems = Array.from({ length: 5 }).reduce<typeof serviceItem[]>(
                (items) => addInstantPosServiceItem(items, serviceItem),
                [],
            )
            expect(ticketItems).toHaveLength(1)
            expect(ticketItems[0].quantity).toBe(5)

            const checkout = input({ quantity: ticketItems[0].quantity, unitPrice: serviceItem.unitPrice })
            ids.saleId = checkout.payload.id
            recordPosFixture(ids)
            await commitPosCheckout(checkout)

            const fresh = await freshPosClient()
            try {
                const lines = requirePosLiveData(await fresh.from('sale_items')
                    .select('product_id,quantity,total_price,storage_id')
                    .eq('sale_id', checkout.payload.id), 'aggregated Instant POS service sale line')
                const payments = requirePosLiveData(await fresh.from('payment_transactions')
                    .select('amount,source_record_id').eq('workspace_id', livePosWorkspaceId)
                    .eq('source_record_id', checkout.payload.id), 'aggregated Instant POS service payment')

                expect(lines).toHaveLength(1)
                expect(lines[0]).toMatchObject({ product_id: product.id, storage_id: null })
                expect(Number(lines[0].quantity)).toBe(5)
                expect(Number(lines[0].total_price)).toBe(500)
                expect(payments).toHaveLength(1)
                expect(Number(payments[0].amount)).toBe(500)
            } finally {
                await fresh.auth.signOut()
            }
        }, { service: true })
    }, 120_000)

    it('rejects a non-positive service quantity without persisting a sale or payment', async () => {
        await withLivePosFixture(async ({ ids, input }) => {
            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            const checkout = input({ quantity: 1, unitPrice: 100 })
            checkout.payload.items[0].quantity = 0
            checkout.payload.items[0].inventory_quantity = 0
            checkout.payload.items[0].total_price = 0
            checkout.payload.items[0].total = 0
            checkout.payload.total_amount = 0
            ids.saleId = checkout.payload.id
            recordPosFixture(ids)

            await expect(commitPosCheckout(checkout)).rejects.toThrow()

            const fresh = await freshPosClient()
            try {
                const sales = requirePosLiveData(await fresh.from('sales').select('id')
                    .eq('id', checkout.payload.id), 'rejected service sales')
                const payments = requirePosLiveData(await fresh.from('payment_transactions').select('id')
                    .eq('workspace_id', livePosWorkspaceId).eq('source_record_id', checkout.payload.id), 'rejected service payments')
                expect(sales).toHaveLength(0)
                expect(payments).toHaveLength(0)
            } finally {
                await fresh.auth.signOut()
            }
        }, { service: true })
    }, 120_000)
})
