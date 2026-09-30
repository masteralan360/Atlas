import { describe, expect, it } from 'vitest'
import {
    freshPosClient, livePosCurrency, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('POS · hosted product UoM', () => {
    setupHostedPos()

    it('persists the selected UoM snapshot and deducts coefficient-converted base stock and batches', async () => {
        await withLivePosFixture(async ({ ids, product, storage, batch, input }) => {
            const { replaceProductUoms } = await import('@/local-db/productUoms')
            const uoms = await replaceProductUoms(livePosWorkspaceId, product.id, [
                { unitRef: 'builtin:pcs', unitCode: 'pcs', coefficient: 1, isBase: true, isActive: true,
                    isDefaultSelling: false, sellingPrice: product.price, costPrice: product.costPrice, minimumSellingPrice: null },
                { unitRef: 'builtin:carton', unitCode: 'carton', coefficient: 20, isBase: false, isActive: true,
                    isDefaultSelling: true, sellingPrice: 40, costPrice: 20, minimumSellingPrice: 35 },
            ])
            const carton = uoms.find((uom) => uom.unitCode === 'carton')
            if (!carton) throw new Error('carton UoM fixture was not saved')
            ids.productUomId = carton.id
            recordPosFixture(ids)

            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            const checkout = input({ quantity: 2, unitPrice: 40 })
            Object.assign(checkout.payload.items[0], {
                selling_uom_id: carton.id,
                selling_unit_ref: carton.unitRef,
                selling_unit_code: carton.unitCode,
                selling_unit_name_snapshot: 'Carton',
                base_unit_ref: 'builtin:pcs',
                base_unit_code: 'pcs',
                unit_factor: 20,
                inventory_quantity: 40,
                uom_cost_price: 20,
                minimum_selling_price_snapshot: 35,
                original_unit_price: 40,
                cost_price: 20,
                converted_cost_price: 20,
                batch_allocations: [{ batch_id: batch!.id, batch_number: batch!.batchNumber,
                    quantity: 40, price: 2, cost_price: 1, currency: livePosCurrency,
                    expiry_date: null, manufacturing_date: null }]
            })
            checkout.batchPlans = [{ productId: product.id, storageId: storage.id, allocations: [
                { batchId: batch!.id, batchNumber: batch!.batchNumber, quantity: 40,
                    price: 2, costPrice: 1, currency: livePosCurrency }
            ] }]
            ids.saleId = checkout.payload.id
            recordPosFixture(ids)
            await commitPosCheckout(checkout)

            const fresh = await freshPosClient()
            try {
                const line = requirePosLiveData(await fresh.from('sale_items')
                    .select('quantity,selling_uom_id,selling_unit_ref,selling_unit_name_snapshot,base_unit_ref,unit_factor,inventory_quantity,uom_cost_price')
                    .eq('sale_id', checkout.payload.id).single(), 'UoM POS line')
                const stock = requirePosLiveData(await fresh.from('inventory')
                    .select('quantity').eq('product_id', product.id).eq('storage_id', storage.id).single(), 'UoM stock')
                const savedBatch = requirePosLiveData(await fresh.from('stock_batches')
                    .select('quantity').eq('id', batch!.id).single(), 'UoM batch')
                expect(line).toMatchObject({ selling_uom_id: carton.id, selling_unit_ref: carton.unitRef,
                    selling_unit_name_snapshot: 'Carton', base_unit_ref: 'builtin:pcs' })
                expect(Number(line.quantity)).toBe(2)
                expect(Number(line.unit_factor)).toBe(20)
                expect(Number(line.inventory_quantity)).toBe(40)
                expect(Number(line.uom_cost_price)).toBe(20)
                expect(Number(stock.quantity)).toBe(60)
                expect(Number(savedBatch.quantity)).toBe(60)
            } finally { await fresh.auth.signOut() }
        }, { stock: 100, price: 2, costPrice: 1, unit: 'pcs' })
    }, 120_000)
})
