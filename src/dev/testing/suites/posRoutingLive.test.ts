import { describe, expect, it } from 'vitest'
import {
    freshPosClient, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('POS · hosted entry routing', () => {
    setupHostedPos()

    it('honors the Services grant; if enabled, persists a stockless POS service sale', async () => {
        const fresh = await freshPosClient()
        let servicesAllowed: boolean
        try {
            const workspace = requirePosLiveData(await fresh.from('workspaces')
                .select('plan').eq('id', livePosWorkspaceId).single(), 'service workspace plan')
            servicesAllowed = requirePosLiveData(await fresh.rpc('workspace_module_allowed', {
                p_workspace_id: livePosWorkspaceId, p_plan: String(workspace.plan), p_module: 'services'
            }), 'Services module access')
        } finally { await fresh.auth.signOut() }

        if (!servicesAllowed) {
            const hooks = await import('@/local-db/hooks')
            const tag = `DEV TEST POS service blocked ${crypto.randomUUID()}`
            await expect(hooks.createProduct(livePosWorkspaceId, {
                sku: '', name: tag, description: '', categoryId: null, category: null,
                storageId: null, storageName: undefined, price: 100, costPrice: 0,
                quantity: 0, minStockLevel: 0, unit: '', currency: 'usd',
                barcode: '', barcodes: [], imageUrl: '', canBeReturned: true,
                returnRules: '', createdBy: null, isService: true
            })).rejects.toThrow('Services feature is not enabled for this workspace')
            const check = await freshPosClient()
            try {
                const products = requirePosLiveData(await check.from('products')
                    .select('id').eq('workspace_id', livePosWorkspaceId).eq('name', tag), 'blocked services')
                expect(products).toHaveLength(0)
            } finally { await check.auth.signOut() }
            return
        }

        await withLivePosFixture(async ({ ids, product, input }) => {
            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            const checkout = input({ method: 'fib' })
            ids.saleId = checkout.payload.id
            recordPosFixture(ids)
            await commitPosCheckout(checkout)
            const check = await freshPosClient()
            try {
                const sale = requirePosLiveData(await check.from('sales')
                    .select('origin,payment_method,total_amount').eq('id', checkout.payload.id).single(), 'service POS sale')
                const line = requirePosLiveData(await check.from('sale_items')
                    .select('storage_id,product_id').eq('sale_id', checkout.payload.id).single(), 'service POS line')
                const stock = requirePosLiveData(await check.from('inventory')
                    .select('id').eq('product_id', product.id), 'service inventory')
                const payment = requirePosLiveData(await check.from('payment_transactions')
                    .select('source_type,amount').eq('source_record_id', checkout.payload.id).single(), 'service POS payment')
                expect(sale).toMatchObject({ origin: 'pos', payment_method: 'fib' })
                expect(Number(sale.total_amount)).toBe(100)
                expect(line).toMatchObject({ product_id: product.id, storage_id: null })
                expect(stock).toHaveLength(0)
                expect(payment.source_type).toBe('pos_sale')
                expect(Number(payment.amount)).toBe(100)
            } finally { await check.auth.signOut() }
        }, { service: true })
    }, 120_000)
})
