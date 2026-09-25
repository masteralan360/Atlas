import { describe, expect, it } from 'vitest'
import {
    freshPosClient, livePosCurrency, livePosWorkspaceId, recordPosFixture, requirePosLiveData,
    setupHostedPos, withLivePosFixture
} from '../fixtures/posLive'

describe('POS · hosted related units', () => {
    setupHostedPos()

    it('persists the selling-unit snapshot and deducts canonical base stock and batches', async () => {
        const hooks = await import('@/local-db/hooks')
        const units = await import('@/local-db/unitRelationships')
        const code = crypto.randomUUID().slice(0, 8)
        const parent = await hooks.createUnit(livePosWorkspaceId, { code: `posp${code}`, icon: 'Package', isDynamic: false })
        const child = await hooks.createUnit(livePosWorkspaceId, { code: `posc${code}`, icon: 'Package', isDynamic: false })
        const unitIds: Record<string, string | null> = { parentUnitId: parent.id, childUnitId: child.id }
        recordPosFixture(unitIds)
        const relationship = await units.saveUnitRelationship(livePosWorkspaceId, {
            name: `DEV TEST POS ${code} packs`, parentUnitRef: `custom:${parent.id}`,
            parentUnitCode: parent.code, childUnitRef: `custom:${child.id}`, childUnitCode: child.code
        })
        unitIds.relationshipId = relationship.id
        recordPosFixture(unitIds)
        await withLivePosFixture(async ({ ids, product, storage, batch, input }) => {
            Object.assign(ids, unitIds)
            const conversion = await units.replaceProductUnitConversion(livePosWorkspaceId, product.id, {
                relationshipId: relationship.id, factor: 20, parentPrice: 40, childIsDynamic: false
            })
            ids.conversionId = conversion?.id ?? null
            recordPosFixture(ids)
            const { commitPosCheckout } = await import('@/local-db/posCheckout')
            const checkout = input({ quantity: 2, unitPrice: 40 })
            Object.assign(checkout.payload.items[0], {
                selling_unit_ref: `custom:${parent.id}`, selling_unit_code: parent.code,
                base_unit_ref: `custom:${child.id}`, base_unit_code: child.code,
                unit_factor: 20, inventory_quantity: 40,
                original_unit_price: 40, cost_price: 20, converted_cost_price: 20,
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
                    .select('quantity,selling_unit_ref,base_unit_ref,unit_factor,inventory_quantity')
                    .eq('sale_id', checkout.payload.id).single(), 'related-unit POS line')
                const stock = requirePosLiveData(await fresh.from('inventory')
                    .select('quantity').eq('product_id', product.id).eq('storage_id', storage.id).single(), 'related-unit stock')
                const savedBatch = requirePosLiveData(await fresh.from('stock_batches')
                    .select('quantity').eq('id', batch!.id).single(), 'related-unit batch')
                expect(line).toMatchObject({ selling_unit_ref: `custom:${parent.id}`,
                    base_unit_ref: `custom:${child.id}` })
                expect(Number(line.quantity)).toBe(2)
                expect(Number(line.unit_factor)).toBe(20)
                expect(Number(line.inventory_quantity)).toBe(40)
                expect(Number(stock.quantity)).toBe(60)
                expect(Number(savedBatch.quantity)).toBe(60)
            } finally { await fresh.auth.signOut() }
        }, { stock: 100, price: 2, costPrice: 1, unit: child.code })
    }, 120_000)
})
