import { describe, expect, it } from 'vitest'
import {
    freshProductsClient, liveProductsWorkspaceId, priceBooksCapabilityAllowed, recordProductFixture,
    requireProductsLiveData, salesAgentCommissionsModuleAllowed, setupHostedProducts, withLiveProductFixture
} from '../fixtures/productsLive'

describe('Products · hosted pricing and rules', () => {
    setupHostedProducts()

    it('persists granted Price Book prices, product discounts, and commission rule revisions', async () => {
        const canUsePriceBooks = await priceBooksCapabilityAllowed()
        const canUseProductCommissions = await salesAgentCommissionsModuleAllowed()
        await withLiveProductFixture(async ({ product, ids, tag }) => {
            const priceBooks = await import('@/local-db/priceBooks')
            const hooks = await import('@/local-db/hooks')
            const commissions = await import('@/local-db/productCommissions')
            let priceBook: Awaited<ReturnType<typeof priceBooks.createPriceBook>> | null = null
            if (canUsePriceBooks) {
                priceBook = await priceBooks.createPriceBook(liveProductsWorkspaceId, { name: `${tag} Price Book` })
                ids.priceBookId = priceBook.id
                recordProductFixture(ids)
                const [priceBookItem] = await priceBooks.replaceProductPriceBookItems(liveProductsWorkspaceId, product.id, [{
                    priceBookId: priceBook.id, costPrice: 650, price: 1190, currency: 'iqd'
                }])
                expect(priceBookItem).toMatchObject({ productId: product.id, priceBookId: priceBook.id, costPrice: 650, price: 1190 })
            } else {
                await expect(priceBooks.createPriceBook(liveProductsWorkspaceId, { name: `${tag} Price Book` }))
                    .rejects.toThrow(/row-level security policy.*price_books/i)
            }

            const discount = await hooks.createProductDiscount(liveProductsWorkspaceId, {
                productId: product.id, discountType: 'percentage', discountValue: 10,
                priceScope: 'all', startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z',
                minStockThreshold: null, isActive: true
            })
            const commission = canUseProductCommissions
                ? await commissions.replaceProductCommissionRule(liveProductsWorkspaceId, product.id, {
                    commissionType: 'percentage', ratePercent: 5, recipientScope: 'all_assigned', notes: `${tag} commission`
                })
                : null
            if (canUseProductCommissions) {
                expect(commission).toMatchObject({ productId: product.id, commissionType: 'percentage', ratePercent: 5, isActive: true })
            }

            const client = await freshProductsClient()
            try {
                if (priceBook) {
                    const savedItem = requireProductsLiveData<any>(await client.from('price_book_items')
                        .select('workspace_id,product_id,price_book_id,cost_price,price,currency,is_deleted')
                        .eq('product_id', product.id).eq('price_book_id', priceBook.id).single(), 'Price Book item')
                    expect(savedItem).toMatchObject({
                        workspace_id: liveProductsWorkspaceId, product_id: product.id, price_book_id: priceBook.id,
                        cost_price: 650, price: 1190, currency: 'iqd', is_deleted: false
                    })
                }
                const savedDiscount = requireProductsLiveData<any>(await client.from('product_discounts')
                    .select('workspace_id,product_id,discount_type,discount_value,is_active,is_deleted')
                    .eq('id', discount.id).single(), 'product discount')
                expect(savedDiscount).toMatchObject({
                    workspace_id: liveProductsWorkspaceId, product_id: product.id,
                    discount_type: 'percentage', discount_value: 10, is_active: true, is_deleted: false
                })
                if (commission) {
                    const savedCommission = requireProductsLiveData<any>(await client.schema('crm').from('product_commission_rules')
                        .select('workspace_id,product_id,commission_type,rate_percent,is_active,is_deleted')
                        .eq('id', commission.id).single(), 'product commission rule')
                    expect(savedCommission).toMatchObject({
                        workspace_id: liveProductsWorkspaceId, product_id: product.id,
                        commission_type: 'percentage', rate_percent: 5, is_active: true, is_deleted: false
                    })
                }
            } finally { await client.auth.signOut() }

            await hooks.deleteProductDiscount(discount.id)
            if (commission) await commissions.replaceProductCommissionRule(liveProductsWorkspaceId, product.id, null)
            if (priceBook) {
                await priceBooks.replaceProductPriceBookItems(liveProductsWorkspaceId, product.id, [])
                await priceBooks.hardDeletePriceBook(priceBook.id)
            }
        })
    }, 120_000)
})
