import { describe, expect, it } from 'vitest'
import { appendInstantPosServiceLine } from '@/lib/instantPosServiceLines'
import {
    freshPosClient, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture,
} from '../fixtures/posLive'

describe('POS · hosted Instant POS service lines', () => {
    setupHostedPos()

    it('persists five service units as five quantity-one sale lines and one matching payment', async () => {
        await withLivePosFixture(async ({ ids, product, input }) => {
            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            const checkout = input({ quantity: 5, unitPrice: 100 })
            const template = checkout.payload.items[0]
            const serviceLines = Array.from({ length: 5 }).reduce<{ quantity: number; lineId?: string }[]>(
                (lines) => appendInstantPosServiceLine(lines, { quantity: 1 }, () => crypto.randomUUID()),
                [],
            )

            checkout.payload.items = serviceLines.map(({ quantity }) => ({
                ...template,
                quantity,
                inventory_quantity: quantity,
                total_price: template.unit_price * quantity,
                total: template.unit_price * quantity,
            }))
            ids.saleId = checkout.payload.id
            recordPosFixture(ids)

            const result = await commitPosCheckout(checkout)
            expect(result.sequenceId).toBeGreaterThan(0)

            const fresh = await freshPosClient()
            try {
                const sale = requirePosLiveData(await fresh.from('sales')
                    .select('id,workspace_id,total_amount,origin')
                    .eq('id', checkout.payload.id).single(), 'Instant POS service sale')
                const lines = requirePosLiveData(await fresh.from('sale_items')
                    .select('product_id,quantity,total_price,storage_id')
                    .eq('sale_id', checkout.payload.id), 'Instant POS service sale lines')
                const payments = requirePosLiveData(await fresh.from('payment_transactions')
                    .select('amount,source_record_id').eq('workspace_id', livePosWorkspaceId)
                    .eq('source_record_id', checkout.payload.id), 'Instant POS service payment')

                expect(sale).toMatchObject({ id: checkout.payload.id, workspace_id: livePosWorkspaceId, origin: 'pos' })
                expect(Number(sale.total_amount)).toBe(500)
                expect(lines).toHaveLength(5)
                expect(lines.map((line: { quantity: number }) => Number(line.quantity))).toEqual([1, 1, 1, 1, 1])
                expect(lines.every((line: { product_id: string; storage_id: string | null }) => (
                    line.product_id === product.id && line.storage_id === null
                ))).toBe(true)
                expect(lines.reduce((sum: number, line: { total_price: number }) => sum + Number(line.total_price), 0)).toBe(500)
                expect(payments).toHaveLength(1)
                expect(Number(payments[0].amount)).toBe(500)
            } finally {
                await fresh.auth.signOut()
            }
        }, { service: true })
    }, 120_000)

    it('rejects a non-positive service line without persisting a sale or payment', async () => {
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
