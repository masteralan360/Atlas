import 'fake-indexeddb/auto'

import { describe, expect, it } from 'vitest'
import type { PurchaseOrderItem } from '@/local-db/models'
import { db } from '@/local-db/database'
import { liveSupabase } from '../liveSupabase'
import { setupHostedSaleOrders, withLiveSaleOrderFixture, liveWorkspaceId, recordLiveFixture, requireLiveData } from '../fixtures/saleOrdersLive'

setupHostedSaleOrders()

describe('purchase receipt base-unit rounding on hosted Supabase', () => {
  it('accepts rounded paid and bonus base quantities, posts stock, and rejects a mismatched snapshot', async () => {
    await withLiveSaleOrderFixture(async (fixture) => {
      const partners = await import('@/local-db/businessPartners')
      const orders = await import('@/local-db/orders')
      const { replaceProductUoms } = await import('@/local-db/productUoms')
      const supplier = await partners.createBusinessPartner(liveWorkspaceId, {
        partnerName: `${fixture.tag} supplier`,
        phone: '',
        defaultCurrency: 'usd',
        creditLimit: 0,
        receivableCreditLimit: null,
        payableCreditLimit: null,
        role: 'supplier',
      })
      recordLiveFixture({ supplierId: supplier.id, productId: fixture.product.id, storageId: fixture.storage.id })
      const uoms = await replaceProductUoms(liveWorkspaceId, fixture.product.id, [
        { unitRef: 'builtin:pcs', unitCode: 'pcs', coefficient: 1, isBase: true, isActive: true,
          isDefaultSelling: false, sellingPrice: fixture.product.price, costPrice: fixture.product.costPrice ?? 0, minimumSellingPrice: null },
        { unitRef: 'builtin:meter', unitCode: 'Meter', coefficient: 0.333333, isBase: false, isActive: true,
          isDefaultSelling: true, sellingPrice: 10, costPrice: 1, minimumSellingPrice: null },
      ])
      const meter = uoms.find((row) => row.unitRef === 'builtin:meter')!
      const item: PurchaseOrderItem = {
        id: crypto.randomUUID(),
        productId: fixture.product.id,
        storageId: fixture.storage.id,
        productName: fixture.product.name,
        productSku: fixture.product.sku,
        unit: 'Meter',
        uomId: meter.id,
        uomNameSnapshot: 'Meter',
        unitRef: meter.unitRef,
        unitNameSnapshot: 'Meter',
        baseUnitRef: 'builtin:pcs',
        baseUnitCode: 'pcs',
        baseUnitNameSnapshot: 'pcs',
        unitFactor: 0.333333,
        quantity: 0.001,
        freeBonusQuantity: 0.001,
        inventoryQuantity: 0.000333,
        freeBonusInventoryQuantity: 0.000333,
        receivedQuantity: 0.000666,
        lineTotal: 0,
        originalCurrency: 'usd',
        originalUnitPrice: 0,
        convertedUnitPrice: 0,
        settlementCurrency: 'usd',
        batchNumber: null,
        batchSalePrice: fixture.product.price,
        batchExpiryDate: null,
        batchManufacturingDate: null,
      }
      const input = {
        businessPartnerId: supplier.id,
        supplierId: supplier.id,
        supplierName: supplier.partnerName,
        destinationStorageId: fixture.storage.id,
        items: [item],
        subtotal: 0,
        discount: 0,
        total: 0,
        currency: 'usd' as const,
        exchangeRate: null,
        exchangeRateSource: null,
        exchangeRateTimestamp: null,
        exchangeRates: null,
        status: 'received' as const,
        expectedDeliveryDate: null,
        actualDeliveryDate: null,
        isPaid: true,
        paymentStatus: 'paid' as const,
        paidAmount: 0,
        balanceAmount: 0,
        paymentMethod: 'cash' as const,
        initialPaymentAmount: 0,
        linkedLoanId: null,
        isInstallmentBased: false,
        installmentCount: 0,
        installmentFrequency: null,
        firstDueDate: null,
        nextDueDate: null,
        notes: fixture.tag,
        isLocked: false,
        createdBy: null,
      }

      let order: Awaited<ReturnType<typeof orders.createPurchaseOrder>>
      try {
        order = await orders.createPurchaseOrder(liveWorkspaceId, input)
      } catch (error) {
        const nestedCause = error instanceof Error
          ? (error as Error & { cause?: unknown }).cause
          : undefined
        const cause = nestedCause instanceof Error
          ? nestedCause.message
          : error instanceof Error ? error.message : String(error)
        throw new Error(`fractional_purchase_receipt_save_failed:${cause}`)
      }
      recordLiveFixture({ supplierId: supplier.id, productId: fixture.product.id, storageId: fixture.storage.id, purchaseOrderId: order.id })

      expect(order.items[0].receivedQuantity).toBe(0.000666)
      const persistedOrder = requireLiveData<any>(
        await liveSupabase.from('purchase_orders').select('status,items').eq('id', order.id).single(),
        'fractional purchase order',
      )
      expect(persistedOrder.status).toBe('received')
      expect(persistedOrder.items[0].receivedQuantity).toBe(0.000666)
      const inventory = requireLiveData<any>(
        await liveSupabase.from('inventory').select('quantity').eq('product_id', fixture.product.id).eq('storage_id', fixture.storage.id).single(),
        'fractional receipt inventory',
      )
      expect(inventory.quantity).toBe(0.000666)
      const transaction = requireLiveData<any>(
        await liveSupabase.from('inventory_transactions')
          .select('transaction_type,quantity_delta,previous_quantity,new_quantity')
          .eq('reference_id', order.id).eq('transaction_type', 'purchase').single(),
        'fractional receipt inventory transaction',
      )
      expect(transaction).toMatchObject({ transaction_type: 'purchase', quantity_delta: 0.000666, new_quantity: 0.000666 })

      const invalidOrderId = crypto.randomUUID()
      const invalidInput = {
        ...input,
        items: [{ ...item, id: crypto.randomUUID(), receivedQuantity: 0.000667 }],
      }
      await expect(orders.createPurchaseOrder(liveWorkspaceId, invalidInput, null, {
        orderId: invalidOrderId,
      })).rejects.toThrow()
      const rejectedOrder = await liveSupabase.from('purchase_orders').select('id').eq('id', invalidOrderId).maybeSingle()
      expect(rejectedOrder.error).toBeNull()
      expect(rejectedOrder.data).toBeNull()
      expect(await db.inventory.where('[productId+storageId]').equals([fixture.product.id, fixture.storage.id]).first())
        .toMatchObject({ quantity: 0.000666 })
    }, { stock: 0, currency: 'usd', price: 100, costPrice: 40, unit: 'pcs', retirePassedProduct: false })
  }, 300_000)
})
