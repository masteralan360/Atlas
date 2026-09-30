import {
  allocatePurchaseCostToBaseInventory,
  getOrderLineFreeBonusInventoryQuantity,
  getOrderLineInventoryQuantity,
  getOrderLinePaidInventoryQuantity,
} from '@/lib/orderLineItems'
import { buildProductUomOrderOptions, getUomDescriptors } from '@/lib/productUoms'
import type { Product, ProductUom } from '@/local-db/models'
import { describe, expect, it } from 'vitest'

describe('order UoM business contract', () => {
  const product = { id: 'product', unit: 'sheet', price: 2250, costPrice: 1000, minimumSellingPrice: null, currency: 'iqd' } as Product
  const base = {
    workspaceId: 'workspace', productId: product.id, isActive: true, version: 1,
    isDeleted: false, syncStatus: 'synced' as const, lastSyncedAt: null,
    createdAt: '', updatedAt: '',
  }
  const productUoms = [
    {
      ...base, id: 'base-uom', unitRef: 'builtin:sheet', unitCode: 'sheet', coefficient: 1,
      isBase: true, isDefaultSelling: false, sellingPrice: 2250, costPrice: 1000, minimumSellingPrice: null,
    },
    {
      ...base, id: 'carton-uom', unitRef: 'builtin:carton', unitCode: 'carton', coefficient: 20,
      isBase: false, isDefaultSelling: true, sellingPrice: 40000, costPrice: 20000, minimumSellingPrice: 35000,
    },
  ] as ProductUom[]

  it('provides independently priced selling and purchase UoMs with base coefficients', () => {
    const options = buildProductUomOrderOptions(product, productUoms, getUomDescriptors([]))
    expect(options).toEqual([
      expect.objectContaining({ kind: 'base', isBase: true, unitCode: 'sheet', factor: 1, sellingPrice: 2250 }),
      expect.objectContaining({ kind: 'converted', isBase: false, unitCode: 'carton', factor: 20,
        sellingPrice: 40000, costPrice: 20000, minimumSellingPrice: 35000, isDefaultSelling: true }),
    ])
  })

  it('keeps service order lines on a single non-inventory unit without a product UoM row', () => {
    expect(buildProductUomOrderOptions({ ...product, isService: true }, [], getUomDescriptors([])))
      .toMatchObject([{ uomId: '', unitCode: 'service', factor: 1, isBase: true }])
  })

  it('keeps commercial quantities in the selected UoM while stock uses converted base quantities', () => {
    const line = {
      quantity: 2,
      freeBonusQuantity: 1,
      unitFactor: 20,
      inventoryQuantity: 40,
      freeBonusInventoryQuantity: 20,
    }
    expect(getOrderLinePaidInventoryQuantity(line)).toBe(40)
    expect(getOrderLineFreeBonusInventoryQuantity(line)).toBe(20)
    expect(getOrderLineInventoryQuantity(line)).toBe(60)
  })

  it('allocates purchase cost across paid and free base inventory', () => {
    expect(allocatePurchaseCostToBaseInventory(80000, 2, 60)).toBe(2666.666667)
  })
})
